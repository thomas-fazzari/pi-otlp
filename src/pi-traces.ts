// SPDX-FileCopyrightText: 2026 Thomas Fazzari
// SPDX-License-Identifier: MIT

import type {
  ToolExecutionEndEvent,
  ToolExecutionStartEvent,
} from "@earendil-works/pi-coding-agent";
import { asDouble } from "./attributes.ts";
import type { Attributes, AttributeValue } from "./attributes.ts";
import {
  ATTR_PI_SESSION_KIND,
  stopReasonErrorType,
  toolErrorType,
  usageAttributes,
} from "./pi-conventions.ts";
import type { AssistantMessage } from "./pi-conventions.ts";
import {
  ATTR_ERROR_TYPE,
  ATTR_GEN_AI_AGENT_NAME,
  ATTR_GEN_AI_CONVERSATION_ID,
  ATTR_GEN_AI_OPERATION_NAME,
  ATTR_GEN_AI_PROVIDER_NAME,
  ATTR_GEN_AI_REQUEST_MODEL,
  ATTR_GEN_AI_RESPONSE_FINISH_REASONS,
  ATTR_GEN_AI_RESPONSE_ID,
  ATTR_GEN_AI_RESPONSE_MODEL,
  ATTR_GEN_AI_TOOL_CALL_ID,
  ATTR_GEN_AI_TOOL_NAME,
  GEN_AI_OPERATION_NAME_VALUE_CHAT,
  GEN_AI_OPERATION_NAME_VALUE_EXECUTE_TOOL,
  GEN_AI_OPERATION_NAME_VALUE_INVOKE_AGENT,
} from "./semconv.ts";
import type { Session } from "./session-kind.ts";
import type { Telemetry } from "./telemetry.ts";
import type { Span, SpanContext, SpanOptions, SpanResult } from "./traces.ts";

const MAIN_AGENT_NAME = "pi";
const TURN_SPAN_NAME = "pi.turn";
const ATTR_PI_TURN_INDEX = "pi.turn.index";
const ATTR_PI_ABORTED = "pi.aborted";
const ATTR_PI_INTERRUPTED = "pi.interrupted";
const ATTR_PI_COST_USD = "pi.cost.usd";

interface TraceSession extends Session {
  conversationId: string;
}

export interface PiTraces {
  agentStart(): void;
  agentSettled(aborted: boolean): void;
  turnStart(turnIndex: number, timestamp: number): void;
  turnEnd(): void;
  assistantMessage(message: AssistantMessage): SpanContext | undefined;
  toolStart(event: ToolExecutionStartEvent): void;
  toolEnd(event: ToolExecutionEndEvent): void;
  interrupt(): void;
  activeContext(): SpanContext | undefined;
}

export function createPiTraces(telemetry: Telemetry, session: TraceSession): PiTraces {
  const common = {
    [ATTR_PI_SESSION_KIND]: session.kind,
    [ATTR_GEN_AI_CONVERSATION_ID]: session.conversationId,
  };
  const agentName = session.agentName ?? MAIN_AGENT_NAME;
  // In start order, so that ending them in reverse ends children before their parents.
  const open = new Set<Span>();
  const tools = new Map<string, Span>();
  let run: Span | undefined;
  let turn: Span | undefined;

  function start(name: string, options: SpanOptions): Span {
    const span = telemetry.startSpan(name, {
      ...options,
      attributes: { ...common, ...options.attributes },
    });
    open.add(span);
    return span;
  }

  function end(span: Span, result: SpanResult = {}): void {
    open.delete(span);
    span.end(result);
  }

  function innermost(): Span | undefined {
    return turn ?? run;
  }

  function toolParent(parentToolCallId: string | undefined): Span | undefined {
    if (parentToolCallId === undefined) {
      return innermost();
    }
    return tools.get(parentToolCallId) ?? innermost();
  }

  function endAllExcept(keep: Span | undefined, attributes: Attributes): void {
    for (const span of [...open].toReversed()) {
      if (span !== keep) {
        end(span, { attributes });
      }
    }
    tools.clear();
    turn = undefined;
  }

  return {
    agentStart() {
      // Retries and compaction send another agent_start inside the same run.
      run ??= start(`${GEN_AI_OPERATION_NAME_VALUE_INVOKE_AGENT} ${agentName}`, {
        attributes: {
          [ATTR_GEN_AI_OPERATION_NAME]: GEN_AI_OPERATION_NAME_VALUE_INVOKE_AGENT,
          [ATTR_GEN_AI_AGENT_NAME]: agentName,
        },
      });
    },

    agentSettled(aborted) {
      endAllExcept(run, {});
      if (run === undefined) {
        return;
      }
      const attributes: Record<string, AttributeValue> = {};
      if (aborted) {
        attributes[ATTR_PI_ABORTED] = true;
      }
      end(run, { attributes });
      run = undefined;
    },

    turnStart(turnIndex, timestamp) {
      if (turn !== undefined) {
        end(turn);
      }
      turn = start(TURN_SPAN_NAME, {
        parent: run?.context,
        startTimeMs: timestamp,
        attributes: { [ATTR_PI_TURN_INDEX]: turnIndex },
      });
    },

    turnEnd() {
      if (turn === undefined) {
        return;
      }
      end(turn);
      turn = undefined;
    },

    assistantMessage(message) {
      if (message.durationMs === undefined) {
        return undefined;
      }
      const errorType = stopReasonErrorType(message.stopReason);
      const span = telemetry.startSpan(`${GEN_AI_OPERATION_NAME_VALUE_CHAT} ${message.model}`, {
        kind: "client",
        parent: innermost()?.context,
        startTimeMs: message.timestamp,
        attributes: { ...common, ...chatAttributes(message) },
      });
      span.end({
        endTimeMs: message.timestamp + message.durationMs,
        ...errorResult(errorType),
      });
      return span.context;
    },

    toolStart(event) {
      const parent = toolParent(event.parentToolCallId);
      const span = start(`${GEN_AI_OPERATION_NAME_VALUE_EXECUTE_TOOL} ${event.toolName}`, {
        parent: parent?.context,
        attributes: {
          [ATTR_GEN_AI_OPERATION_NAME]: GEN_AI_OPERATION_NAME_VALUE_EXECUTE_TOOL,
          [ATTR_GEN_AI_TOOL_NAME]: event.toolName,
          [ATTR_GEN_AI_TOOL_CALL_ID]: event.toolCallId,
        },
      });
      tools.set(event.toolCallId, span);
    },

    toolEnd(event) {
      const span = tools.get(event.toolCallId);
      if (span === undefined) {
        return;
      }
      tools.delete(event.toolCallId);
      end(span, errorResult(toolErrorType(event)));
    },

    interrupt() {
      endAllExcept(undefined, { [ATTR_PI_INTERRUPTED]: true });
      run = undefined;
    },

    activeContext() {
      return [...open].at(-1)?.context;
    },
  };
}

function chatAttributes(message: AssistantMessage): Attributes {
  const attributes: Record<string, AttributeValue> = {
    [ATTR_GEN_AI_OPERATION_NAME]: GEN_AI_OPERATION_NAME_VALUE_CHAT,
    [ATTR_GEN_AI_PROVIDER_NAME]: message.provider,
    [ATTR_GEN_AI_REQUEST_MODEL]: message.model,
    [ATTR_GEN_AI_RESPONSE_MODEL]: message.responseModel ?? message.model,
    [ATTR_GEN_AI_RESPONSE_FINISH_REASONS]: [message.stopReason],
    ...usageAttributes(message.usage),
    [ATTR_PI_COST_USD]: asDouble(message.usage.cost.total),
  };
  if (message.responseId !== undefined) {
    attributes[ATTR_GEN_AI_RESPONSE_ID] = message.responseId;
  }
  return attributes;
}

function errorResult(errorType: string | undefined): SpanResult {
  if (errorType === undefined) {
    return {};
  }
  return { status: { code: "error" }, attributes: { [ATTR_ERROR_TYPE]: errorType } };
}
