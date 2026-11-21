// SPDX-FileCopyrightText: 2026 Thomas Fazzari
// SPDX-License-Identifier: MIT

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
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

interface Pipeline {
  metrics: PiMetrics;
  traces: PiTraces;
  logs: PiLogs;
}

export default function piOtlp(pi: Pick<ExtensionAPI, "on" | "getThinkingLevel">): void {
  if (sdkDisabled()) {
    return;
  }
  let pipeline: Pipeline | undefined;
  // Pi delivers session_start twice to a replacement runtime, so only the first one creates the pipeline and logs the start.
  pi.on("session_start", (event, ctx) => {
    if (pipeline !== undefined) {
      return;
    }
    pipeline = createPipeline(ctx);
    pipeline.logs.sessionStart({
      reason: event.reason,
      model: ctx.model,
      thinkingLevel: pi.getThinkingLevel(),
    });
  });
  pi.on("model_select", (event) => {
    pipeline?.logs.modelSelect(event);
  });
  pi.on("thinking_level_select", (event) => {
    pipeline?.logs.thinkingLevelSelect(event);
  });
  pi.on("session_compact", (event) => {
    pipeline?.metrics.recordSummaryUsage("compaction", event.compactionEntry.usage);
    pipeline?.logs.compaction(event);
  });
  pi.on("session_tree", (event) => {
    pipeline?.metrics.recordSummaryUsage("branch_summary", event.summaryEntry?.usage);
  });
  pi.on("session_compact_failed", (event) => {
    pipeline?.logs.compactionFailed(event);
  });
  pi.on("agent_start", () => {
    pipeline?.traces.agentStart();
  });
  pi.on("agent_settled", (event) => {
    pipeline?.traces.agentSettled(event.aborted);
  });
  pi.on("turn_start", (event) => {
    pipeline?.traces.turnStart(event.turnIndex, event.timestamp);
    pipeline?.logs.turnStart();
  });
  pi.on("turn_end", () => {
    pipeline?.traces.turnEnd();
  });
  pi.on("after_provider_response", (event) => {
    pipeline?.logs.providerResponse(event.status);
  });
  pi.on("message_end", (event) => {
    if (pipeline === undefined || event.message.role !== "assistant") {
      return;
    }
    pipeline.metrics.recordAssistantMessage(event.message);
    const chat = pipeline.traces.assistantMessage(event.message);
    pipeline.logs.assistantMessage(event.message, chat);
  });
  pi.on("tool_execution_start", (event) => {
    pipeline?.traces.toolStart(event);
  });
  pi.on("tool_execution_end", (event) => {
    pipeline?.metrics.recordToolExecution(event);
    pipeline?.traces.toolEnd(event);
  });
  // Each subagent child session also gets quit when it closes, which looks the same as the process quitting.
  pi.on("session_shutdown", async (event) => {
    pipeline?.logs.sessionShutdown(event.reason);
    pipeline?.traces.interrupt();
    if (event.reason === "quit") {
      await flushProcessTelemetry();
    }
  });
}

function createPipeline(ctx: ExtensionContext): Pipeline {
  const session = detectSession(ctx.getSystemPrompt());
  const conversationId = ctx.sessionManager.getSessionId();
  const telemetry = processTelemetry();
  const metrics = createPiMetrics(telemetry, sessionAttributes(session));
  const traces = createPiTraces(telemetry, { ...session, conversationId });
  const logs = createPiLogs(
    telemetry,
    { ...sessionAttributes(session), [ATTR_GEN_AI_CONVERSATION_ID]: conversationId },
    { errorMessages: logErrorMessages(), activeContext: () => traces.activeContext() },
  );
  return { metrics, traces, logs };
}
