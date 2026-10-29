// SPDX-FileCopyrightText: 2026 Thomas Fazzari
// SPDX-License-Identifier: MIT

import type {
  ExtensionAPI,
  ExtensionContext,
  ModelSelectEvent,
  SessionCompactEvent,
  SessionCompactFailedEvent,
  SessionShutdownEvent,
  SessionStartEvent,
  ThinkingLevelSelectEvent,
} from "@earendil-works/pi-coding-agent";
import type { Attributes, AttributeValue } from "./attributes.ts";
import type { LogRecord } from "./logs.ts";
import { usageAttributes } from "./pi-conventions.ts";
import type { AssistantMessage } from "./pi-conventions.ts";
import {
  ATTR_ERROR_TYPE,
  ATTR_GEN_AI_PROVIDER_NAME,
  ATTR_GEN_AI_REQUEST_MODEL,
  ATTR_HTTP_RESPONSE_STATUS_CODE,
} from "./semconv.ts";
import type { Telemetry } from "./telemetry.ts";
import type { SpanContext } from "./traces.ts";

const ATTR_PI_SESSION_START_REASON = "pi.session.start_reason";
const ATTR_PI_SESSION_SHUTDOWN_REASON = "pi.session.shutdown_reason";
const ATTR_PI_MODEL_SOURCE = "pi.model.source";
const ATTR_PI_MODEL_PREVIOUS_PROVIDER = "pi.model.previous_provider";
const ATTR_PI_MODEL_PREVIOUS_MODEL = "pi.model.previous_model";
const ATTR_PI_THINKING_LEVEL_SELECTED = "pi.thinking_level.selected";
const ATTR_PI_THINKING_LEVEL_PREVIOUS = "pi.thinking_level.previous";
const ATTR_PI_COMPACTION_REASON = "pi.compaction.reason";
const ATTR_PI_COMPACTION_TOKENS_BEFORE = "pi.compaction.tokens_before";
const ATTR_PI_COMPACTION_WILL_RETRY = "pi.compaction.will_retry";
const ATTR_PI_COMPACTION_FROM_EXTENSION = "pi.compaction.from_extension";
const ATTR_PI_COMPACTION_ABORTED = "pi.compaction.aborted";
// Semantic conventions 1.44 deprecate error.message in favor of domain-specific attributes.
const ATTR_PI_ERROR_MESSAGE = "pi.error.message";
const MAX_ERROR_MESSAGE_LENGTH = 1024;
const MIN_HTTP_ERROR_STATUS = 400;

interface SessionStart {
  reason: SessionStartEvent["reason"];
  model: ExtensionContext["model"];
  thinkingLevel: ReturnType<ExtensionAPI["getThinkingLevel"]>;
}

interface LogOptions {
  errorMessages: boolean;
  activeContext: () => SpanContext | undefined;
}

export interface PiLogs {
  sessionStart(start: SessionStart): void;
  sessionShutdown(reason: SessionShutdownEvent["reason"]): void;
  modelSelect(event: ModelSelectEvent): void;
  thinkingLevelSelect(event: ThinkingLevelSelectEvent): void;
  compaction(event: SessionCompactEvent): void;
  compactionFailed(event: SessionCompactFailedEvent): void;
  turnStart(): void;
  providerResponse(status: number): void;
  assistantMessage(message: AssistantMessage, chat: SpanContext | undefined): void;
}

export function createPiLogs(
  telemetry: Telemetry,
  session: Attributes,
  options: LogOptions,
): PiLogs {
  // Pi can deliver session_start and session_shutdown twice to one runtime.
  let started = false;
  let shutDown = false;
  // Only the last provider response before a message_end counts, since a provider may retry within one request.
  let lastStatus: number | undefined;

  function emit(record: LogRecord): void {
    telemetry.emitLog({
      ...record,
      attributes: { ...session, ...record.attributes },
      context: record.context ?? options.activeContext(),
    });
  }

  function errorMessage(message: string | undefined): Attributes {
    if (!options.errorMessages || message === undefined) {
      return {};
    }
    const characters = Array.from(message).slice(0, MAX_ERROR_MESSAGE_LENGTH);
    return { [ATTR_PI_ERROR_MESSAGE]: characters.join("") };
  }

  return {
    sessionStart(start) {
      if (started) {
        return;
      }
      started = true;
      const attributes: Record<string, AttributeValue> = {
        [ATTR_PI_SESSION_START_REASON]: start.reason,
        [ATTR_PI_THINKING_LEVEL_SELECTED]: start.thinkingLevel,
      };
      if (start.model !== undefined) {
        attributes[ATTR_GEN_AI_PROVIDER_NAME] = start.model.provider;
        attributes[ATTR_GEN_AI_REQUEST_MODEL] = start.model.id;
      }
      emit({
        eventName: "pi.session.start",
        severity: "info",
        body: "Session started",
        attributes,
      });
    },

    sessionShutdown(reason) {
      if (shutDown) {
        return;
      }
      shutDown = true;
      emit({
        eventName: "pi.session.shutdown",
        severity: "info",
        body: "Session shut down",
        attributes: { [ATTR_PI_SESSION_SHUTDOWN_REASON]: reason },
      });
    },

    modelSelect(event) {
      const attributes: Record<string, AttributeValue> = {
        [ATTR_GEN_AI_PROVIDER_NAME]: event.model.provider,
        [ATTR_GEN_AI_REQUEST_MODEL]: event.model.id,
        [ATTR_PI_MODEL_SOURCE]: event.source,
      };
      if (event.previousModel !== undefined) {
        attributes[ATTR_PI_MODEL_PREVIOUS_PROVIDER] = event.previousModel.provider;
        attributes[ATTR_PI_MODEL_PREVIOUS_MODEL] = event.previousModel.id;
      }
      emit({ eventName: "pi.model.select", severity: "info", body: "Model selected", attributes });
    },

    thinkingLevelSelect(event) {
      emit({
        eventName: "pi.thinking_level.select",
        severity: "info",
        body: "Thinking level selected",
        attributes: {
          [ATTR_PI_THINKING_LEVEL_SELECTED]: event.level,
          [ATTR_PI_THINKING_LEVEL_PREVIOUS]: event.previousLevel,
        },
      });
    },

    compaction(event) {
      const { usage, tokensBefore } = event.compactionEntry;
      const attributes: Record<string, AttributeValue> = {
        [ATTR_PI_COMPACTION_REASON]: event.reason,
        [ATTR_PI_COMPACTION_TOKENS_BEFORE]: tokensBefore,
        [ATTR_PI_COMPACTION_WILL_RETRY]: event.willRetry,
        [ATTR_PI_COMPACTION_FROM_EXTENSION]: event.fromExtension,
      };
      if (usage !== undefined) {
        Object.assign(attributes, usageAttributes(usage));
      }
      emit({ eventName: "pi.compaction", severity: "info", body: "Context compacted", attributes });
    },

    compactionFailed(event) {
      emit({
        eventName: "pi.compaction.failed",
        severity: event.aborted ? "warn" : "error",
        body: "Context compaction failed",
        attributes: {
          [ATTR_PI_COMPACTION_REASON]: event.reason,
          [ATTR_PI_COMPACTION_ABORTED]: event.aborted,
          [ATTR_PI_COMPACTION_WILL_RETRY]: event.willRetry,
          [ATTR_PI_COMPACTION_FROM_EXTENSION]: event.fromExtension,
          ...errorMessage(event.errorMessage),
        },
      });
    },

    // Cache warming can get a provider response between turns.
    turnStart() {
      lastStatus = undefined;
    },

    providerResponse(status) {
      lastStatus = status;
    },

    assistantMessage(message, chat) {
      const status = lastStatus;
      lastStatus = undefined;
      if (message.stopReason !== "error") {
        return;
      }
      const attributes: Record<string, AttributeValue> = {
        [ATTR_GEN_AI_PROVIDER_NAME]: message.provider,
        [ATTR_GEN_AI_REQUEST_MODEL]: message.model,
        [ATTR_ERROR_TYPE]: message.stopReason,
        ...errorMessage(message.errorMessage),
      };
      if (status !== undefined && status >= MIN_HTTP_ERROR_STATUS) {
        attributes[ATTR_HTTP_RESPONSE_STATUS_CODE] = status;
      }
      emit({
        eventName: "pi.model.request.failed",
        severity: "error",
        body: "Model request failed",
        attributes,
        context: chat,
      });
    },
  };
}
