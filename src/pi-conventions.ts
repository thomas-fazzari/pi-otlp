// SPDX-FileCopyrightText: 2026 Thomas Fazzari
// SPDX-License-Identifier: MIT

import type { MessageEndEvent, ToolExecutionEndEvent } from "@earendil-works/pi-coding-agent";

export type AssistantMessage = Extract<MessageEndEvent["message"], { role: "assistant" }>;

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

export function stopReasonErrorType(
  stopReason: AssistantMessage["stopReason"],
): string | undefined {
  if (!FAILED_STOP_REASONS.has(stopReason)) {
    return undefined;
  }
  return stopReason;
}
