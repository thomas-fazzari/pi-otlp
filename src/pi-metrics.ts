// SPDX-FileCopyrightText: 2026 Thomas Fazzari
// SPDX-License-Identifier: MIT

import type { MessageEndEvent, ToolExecutionEndEvent } from "@earendil-works/pi-coding-agent";
import type { Attributes } from "./attributes.ts";
import type { Counter } from "./metrics.ts";
import {
  ATTR_ERROR_TYPE,
  ATTR_GEN_AI_OPERATION_NAME,
  ATTR_GEN_AI_PROVIDER_NAME,
  ATTR_GEN_AI_REQUEST_MODEL,
  ATTR_GEN_AI_RESPONSE_MODEL,
  ATTR_GEN_AI_TOKEN_TYPE,
  ATTR_GEN_AI_TOOL_NAME,
  GEN_AI_OPERATION_NAME_VALUE_CHAT,
  GEN_AI_TOKEN_TYPE_VALUE_INPUT,
  GEN_AI_TOKEN_TYPE_VALUE_OUTPUT,
  METRIC_GEN_AI_CLIENT_OPERATION_DURATION,
} from "./semconv.ts";
import type { Telemetry } from "./telemetry.ts";

type AssistantMessage = Extract<MessageEndEvent["message"], { role: "assistant" }>;

const METRIC_PI_TOKEN_USAGE = "pi.token.usage";
const METRIC_PI_COST = "pi.cost";
const METRIC_PI_TOOL_CALLS = "pi.tool.calls";
const METRIC_PI_TOOL_DURATION = "pi.tool.duration";
const ATTR_PI_STOP_REASON = "pi.stop_reason";
const TOKEN_TYPE_CACHE_READ = "cache_read";
const TOKEN_TYPE_CACHE_WRITE = "cache_write";
const TOKEN_TYPE_CACHE_WRITE_1H = "cache_write_1h";
const TOOL_ERROR = "tool_error";
const TOOL_NOT_RUN = "not_run";
const FAILED_STOP_REASONS: ReadonlySet<AssistantMessage["stopReason"]> = new Set([
  "error",
  "aborted",
]);
const MS_PER_SECOND = 1000;
// The bucket boundaries that the semantic conventions advise for gen_ai.client.operation.duration.
const MODEL_DURATION_BUCKETS = [
  0.01, 0.02, 0.04, 0.08, 0.16, 0.32, 0.64, 1.28, 2.56, 5.12, 10.24, 20.48, 40.96, 81.92,
];
const TOOL_DURATION_BUCKETS = [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60, 120, 300];

export interface PiMetrics {
  recordAssistantMessage(message: AssistantMessage): void;
  recordToolExecution(event: ToolExecutionEndEvent): void;
}

export function createPiMetrics(telemetry: Telemetry, session: Attributes): PiMetrics {
  const tokens = telemetry.counter(METRIC_PI_TOKEN_USAGE, { unit: "{token}" });
  const cost = telemetry.counter(METRIC_PI_COST, { unit: "USD" });
  const modelDuration = telemetry.histogram(METRIC_GEN_AI_CLIENT_OPERATION_DURATION, {
    unit: "s",
    boundaries: MODEL_DURATION_BUCKETS,
  });
  const toolCalls = telemetry.counter(METRIC_PI_TOOL_CALLS, { unit: "{call}" });
  const toolDuration = telemetry.histogram(METRIC_PI_TOOL_DURATION, {
    unit: "s",
    boundaries: TOOL_DURATION_BUCKETS,
  });

  return {
    recordAssistantMessage(message) {
      const model = {
        ...session,
        [ATTR_GEN_AI_PROVIDER_NAME]: message.provider,
        [ATTR_GEN_AI_REQUEST_MODEL]: message.model,
      };
      const { usage } = message;
      const cacheWrite1h = usage.cacheWrite1h ?? 0;
      addNonZero(tokens, usage.input, {
        ...model,
        [ATTR_GEN_AI_TOKEN_TYPE]: GEN_AI_TOKEN_TYPE_VALUE_INPUT,
      });
      addNonZero(tokens, usage.output, {
        ...model,
        [ATTR_GEN_AI_TOKEN_TYPE]: GEN_AI_TOKEN_TYPE_VALUE_OUTPUT,
      });
      addNonZero(tokens, usage.cacheRead, {
        ...model,
        [ATTR_GEN_AI_TOKEN_TYPE]: TOKEN_TYPE_CACHE_READ,
      });
      addNonZero(tokens, usage.cacheWrite - cacheWrite1h, {
        ...model,
        [ATTR_GEN_AI_TOKEN_TYPE]: TOKEN_TYPE_CACHE_WRITE,
      });
      addNonZero(tokens, cacheWrite1h, {
        ...model,
        [ATTR_GEN_AI_TOKEN_TYPE]: TOKEN_TYPE_CACHE_WRITE_1H,
      });
      addNonZero(cost, usage.cost.total, model);
      if (message.durationMs === undefined) {
        return;
      }
      modelDuration.record(message.durationMs / MS_PER_SECOND, {
        ...model,
        [ATTR_GEN_AI_OPERATION_NAME]: GEN_AI_OPERATION_NAME_VALUE_CHAT,
        [ATTR_GEN_AI_RESPONSE_MODEL]: message.responseModel ?? message.model,
        [ATTR_PI_STOP_REASON]: message.stopReason,
        ...stopReasonError(message.stopReason),
      });
    },

    recordToolExecution(event) {
      const tool = { ...session, [ATTR_GEN_AI_TOOL_NAME]: event.toolName, ...toolError(event) };
      toolCalls.add(1, tool);
      if (event.durationMs !== undefined) {
        toolDuration.record(event.durationMs / MS_PER_SECOND, tool);
      }
    },
  };
}

function addNonZero(counter: Counter, value: number, attributes: Attributes): void {
  if (value === 0) {
    return;
  }
  counter.add(value, attributes);
}

function toolError(event: ToolExecutionEndEvent): Attributes {
  if (!event.isError) {
    return {};
  }
  if (event.durationMs === undefined) {
    return { [ATTR_ERROR_TYPE]: TOOL_NOT_RUN };
  }
  return { [ATTR_ERROR_TYPE]: TOOL_ERROR };
}

function stopReasonError(stopReason: AssistantMessage["stopReason"]): Attributes {
  if (!FAILED_STOP_REASONS.has(stopReason)) {
    return {};
  }
  return { [ATTR_ERROR_TYPE]: stopReason };
}
