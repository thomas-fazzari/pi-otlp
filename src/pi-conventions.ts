// SPDX-FileCopyrightText: 2026 Thomas Fazzari
// SPDX-License-Identifier: MIT

import type { MessageEndEvent, ToolExecutionEndEvent } from "@earendil-works/pi-coding-agent";
import type { Attributes, AttributeValue } from "./attributes.ts";
import {
  ATTR_GEN_AI_USAGE_CACHE_CREATION_INPUT_TOKENS,
  ATTR_GEN_AI_USAGE_CACHE_READ_INPUT_TOKENS,
  ATTR_GEN_AI_USAGE_INPUT_TOKENS,
  ATTR_GEN_AI_USAGE_OUTPUT_TOKENS,
  ATTR_GEN_AI_USAGE_REASONING_OUTPUT_TOKENS,
} from "./semconv.ts";

export type AssistantMessage = Extract<MessageEndEvent["message"], { role: "assistant" }>;
export type Usage = AssistantMessage["usage"];

export const ATTR_PI_SESSION_KIND = "pi.session.kind";

const TOOL_ERROR = "tool_error";
const TOOL_NOT_RUN = "not_run";
const FAILED_STOP_REASONS: ReadonlySet<AssistantMessage["stopReason"]> = new Set([
  "error",
  "aborted",
]);

// Pi leaves durationMs out when the tool never ran, for example when a tool_call handler blocked it.
export function toolErrorType(
  event: Pick<ToolExecutionEndEvent, "isError" | "durationMs">,
): string | undefined {
  if (!event.isError) {
    return undefined;
  }
  if (event.durationMs === undefined) {
    return TOOL_NOT_RUN;
  }
  return TOOL_ERROR;
}

export function usageAttributes(usage: Usage): Attributes {
  const attributes: Record<string, AttributeValue> = {
    // The convention counts cached input tokens in gen_ai.usage.input_tokens, and Pi reports them apart.
    [ATTR_GEN_AI_USAGE_INPUT_TOKENS]: usage.input + usage.cacheRead + usage.cacheWrite,
    [ATTR_GEN_AI_USAGE_OUTPUT_TOKENS]: usage.output,
    [ATTR_GEN_AI_USAGE_CACHE_READ_INPUT_TOKENS]: usage.cacheRead,
    [ATTR_GEN_AI_USAGE_CACHE_CREATION_INPUT_TOKENS]: usage.cacheWrite,
  };
  if (usage.reasoning !== undefined) {
    attributes[ATTR_GEN_AI_USAGE_REASONING_OUTPUT_TOKENS] = usage.reasoning;
  }
  return attributes;
}

export function stopReasonErrorType(
  stopReason: AssistantMessage["stopReason"],
): string | undefined {
  if (!FAILED_STOP_REASONS.has(stopReason)) {
    return undefined;
  }
  return stopReason;
}
