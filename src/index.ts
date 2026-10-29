// SPDX-FileCopyrightText: 2026 Thomas Fazzari
// SPDX-License-Identifier: MIT

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { logErrorMessages, sdkDisabled } from "./config.ts";
import { createPiLogs } from "./pi-logs.ts";
import type { PiLogs } from "./pi-logs.ts";
import { createPiMetrics } from "./pi-metrics.ts";
import type { PiMetrics } from "./pi-metrics.ts";
import { createPiTraces } from "./pi-traces.ts";
import type { PiTraces } from "./pi-traces.ts";
import { ATTR_GEN_AI_CONVERSATION_ID } from "./semconv.ts";
import { detectSession, sessionAttributes } from "./session-kind.ts";
import { flushProcessTelemetry, processTelemetry } from "./telemetry.ts";

export default function piOtlp(pi: Pick<ExtensionAPI, "on" | "getThinkingLevel">): void {
  if (sdkDisabled()) {
    return;
  }
  let metrics: PiMetrics | undefined;
  let traces: PiTraces | undefined;
  let logs: PiLogs | undefined;
  // Pi delivers session_start twice to a replacement runtime, and the second must keep the spans of the first.
  pi.on("session_start", (event, ctx) => {
    const session = detectSession(ctx.getSystemPrompt());
    const conversationId = ctx.sessionManager.getSessionId();
    const telemetry = processTelemetry();
    metrics ??= createPiMetrics(telemetry, sessionAttributes(session));
    traces ??= createPiTraces(telemetry, { ...session, conversationId });
    logs ??= createPiLogs(
      telemetry,
      { ...sessionAttributes(session), [ATTR_GEN_AI_CONVERSATION_ID]: conversationId },
      { errorMessages: logErrorMessages(), activeContext: () => traces?.activeContext() },
    );
    logs.sessionStart({
      reason: event.reason,
      model: ctx.model,
      thinkingLevel: pi.getThinkingLevel(),
    });
  });
  pi.on("model_select", (event) => {
    logs?.modelSelect(event);
  });
  pi.on("thinking_level_select", (event) => {
    logs?.thinkingLevelSelect(event);
  });
  pi.on("session_compact", (event) => {
    metrics?.recordSummaryUsage("compaction", event.compactionEntry.usage);
    logs?.compaction(event);
  });
  pi.on("session_tree", (event) => {
    metrics?.recordSummaryUsage("branch_summary", event.summaryEntry?.usage);
  });
  pi.on("session_compact_failed", (event) => {
    logs?.compactionFailed(event);
  });
  pi.on("agent_start", () => {
    traces?.agentStart();
  });
  pi.on("agent_settled", (event) => {
    traces?.agentSettled(event.aborted);
  });
  pi.on("turn_start", (event) => {
    traces?.turnStart(event.turnIndex, event.timestamp);
    logs?.turnStart();
  });
  pi.on("turn_end", () => {
    traces?.turnEnd();
  });
  pi.on("after_provider_response", (event) => {
    logs?.providerResponse(event.status);
  });
  pi.on("message_end", (event) => {
    if (event.message.role === "assistant") {
      metrics?.recordAssistantMessage(event.message);
      const chat = traces?.assistantMessage(event.message);
      logs?.assistantMessage(event.message, chat);
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
    logs?.sessionShutdown(event.reason);
    traces?.interrupt();
    if (event.reason === "quit") {
      await flushProcessTelemetry();
    }
  });
}
