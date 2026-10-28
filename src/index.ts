// SPDX-FileCopyrightText: 2026 Thomas Fazzari
// SPDX-License-Identifier: MIT

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { sdkDisabled } from "./config.ts";
import { createPiMetrics } from "./pi-metrics.ts";
import type { PiMetrics } from "./pi-metrics.ts";
import { sessionAttributes } from "./session-kind.ts";
import { flushProcessTelemetry, processTelemetry } from "./telemetry.ts";

export default function piOtlp(pi: Pick<ExtensionAPI, "on">): void {
  if (sdkDisabled()) {
    return;
  }
  let metrics: PiMetrics | undefined;
  pi.on("session_start", (_event, ctx) => {
    metrics = createPiMetrics(processTelemetry(), sessionAttributes(ctx.getSystemPrompt()));
  });
  pi.on("message_end", (event) => {
    if (event.message.role === "assistant") {
      metrics?.recordAssistantMessage(event.message);
    }
  });
  pi.on("tool_execution_end", (event) => {
    metrics?.recordToolExecution(event);
  });
  // Pi also sends quit to each pi-subagents child, and cannot tell it apart from the process quitting.
  pi.on("session_shutdown", async (event) => {
    if (event.reason === "quit") {
      await flushProcessTelemetry();
    }
  });
}
