// SPDX-FileCopyrightText: 2026 Thomas Fazzari
// SPDX-License-Identifier: MIT

import type { MessageEndEvent, ToolExecutionEndEvent } from "@earendil-works/pi-coding-agent";
import type { Attributes } from "./attributes.ts";
import {
  ATTR_GEN_AI_USAGE_CACHE_CREATION_INPUT_TOKENS,
  ATTR_GEN_AI_USAGE_CACHE_READ_INPUT_TOKENS,
  ATTR_GEN_AI_USAGE_INPUT_TOKENS,
  ATTR_GEN_AI_USAGE_OUTPUT_TOKENS,
  ATTR_GEN_AI_USAGE_REASONING_OUTPUT_TOKENS,
} from "./semconv.ts";

export type AssistantMessage = Extract<MessageEndEvent["message"], { role: "assistant" }>;
export type Usage = AssistantMessage["usage"];
type StopReason = AssistantMessage["stopReason"];
type FailedStopReason = Extract<StopReason, "error" | "aborted">;

export const ATTR_PI_SESSION_KIND = "pi.session.kind";
export const ATTR_PI_PROJECT = "pi.project";

const TOOL_ERROR = "tool_error";
const TOOL_NOT_RUN = "not_run";

export type PiErrorType = typeof TOOL_ERROR | typeof TOOL_NOT_RUN | FailedStopReason;

// Pi leaves durationMs out when the tool never ran, for example when a tool_call handler blocked it.
export function toolErrorType(
  event: Pick<ToolExecutionEndEvent, "isError" | "durationMs">,
): PiErrorType | undefined {
  if (!event.isError) {
    return undefined;
  }
  if (event.durationMs === undefined) {
    return TOOL_NOT_RUN;
  }
  return TOOL_ERROR;
}

export function usageAttributes(usage: Usage): Attributes {
  return {
    // The convention counts cached input tokens in gen_ai.usage.input_tokens, and Pi reports them apart.
    [ATTR_GEN_AI_USAGE_INPUT_TOKENS]: usage.input + usage.cacheRead + usage.cacheWrite,
    [ATTR_GEN_AI_USAGE_OUTPUT_TOKENS]: usage.output,
    [ATTR_GEN_AI_USAGE_CACHE_READ_INPUT_TOKENS]: usage.cacheRead,
    [ATTR_GEN_AI_USAGE_CACHE_CREATION_INPUT_TOKENS]: usage.cacheWrite,
    [ATTR_GEN_AI_USAGE_REASONING_OUTPUT_TOKENS]: usage.reasoning,
  };
}

export function stopReasonErrorType(stopReason: StopReason): PiErrorType | undefined {
  if (stopReason === "error" || stopReason === "aborted") {
    return stopReason;
  }
  return undefined;
}
