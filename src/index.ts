// SPDX-FileCopyrightText: 2026 Thomas Fazzari
// SPDX-License-Identifier: MIT

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { sdkDisabled } from "./config.ts";
import { createPiMetrics } from "./pi-metrics.ts";
import type { PiMetrics } from "./pi-metrics.ts";
import { createPiTraces } from "./pi-traces.ts";
import type { PiTraces } from "./pi-traces.ts";
import { detectSession, sessionAttributes } from "./session-kind.ts";
import { flushProcessTelemetry, processTelemetry } from "./telemetry.ts";

export default function piOtlp(pi: Pick<ExtensionAPI, "on">): void {
  if (sdkDisabled()) {
    return;
  }
  let metrics: PiMetrics | undefined;
  let traces: PiTraces | undefined;
  // Pi delivers session_start twice to a replacement runtime, and the second must keep the spans of the first.
  pi.on("session_start", (_event, ctx) => {
    const session = detectSession(ctx.getSystemPrompt());
    const telemetry = processTelemetry();
    metrics ??= createPiMetrics(telemetry, sessionAttributes(session));
    traces ??= createPiTraces(telemetry, {
      ...session,
      conversationId: ctx.sessionManager.getSessionId(),
    });
  });
  pi.on("agent_start", () => {
    traces?.agentStart();
  });
  pi.on("agent_settled", (event) => {
    traces?.agentSettled(event.aborted);
  });
  pi.on("turn_start", (event) => {
    traces?.turnStart(event.turnIndex, event.timestamp);
  });
  pi.on("turn_end", () => {
    traces?.turnEnd();
  });
  pi.on("message_end", (event) => {
    if (event.message.role === "assistant") {
      metrics?.recordAssistantMessage(event.message);
      traces?.assistantMessage(event.message);
    }
  });
  pi.on("tool_execution_start", (event) => {
    traces?.toolStart(event);
  });
  pi.on("tool_execution_end", (event) => {
    metrics?.recordToolExecution(event);
    traces?.toolEnd(event);
  });
  // Pi also sends quit to each pi-subagents child, and cannot tell it apart from the process quitting.
  pi.on("session_shutdown", async (event) => {
    traces?.interrupt();
    if (event.reason === "quit") {
      await flushProcessTelemetry();
    }
  });
}
