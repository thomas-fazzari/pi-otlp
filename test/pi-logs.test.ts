// SPDX-FileCopyrightText: 2026 Thomas Fazzari
// SPDX-License-Identifier: MIT

import { afterEach, expect, test } from "bun:test";
import { decodeAttributes } from "./otlp-json.ts";
import { assistant, loadExtension, toolStart, useCollector } from "./pi-harness.ts";

const PROVIDER = "anthropic";
const SECRET = "secret";
const ERROR_MESSAGES_ENV = "PI_OTLP_LOG_ERROR_MESSAGES";
const MAX_ERROR_MESSAGE_LENGTH = 1024;

// Every test shares the collector, so each one uses its own session id.
const collector = useCollector();

afterEach(() => {
  delete process.env[ERROR_MESSAGES_ENV];
});

// The log records exported for one conversation, in export order.
function logsOf(conversationId: string): any[] {
  const bodies: any[] = collector().bodies("/v1/logs");
  return bodies
    .flatMap((body) => body.resourceLogs[0].scopeLogs[0].logRecords)
    .filter(
      (record) => decodeAttributes(record.attributes)["gen_ai.conversation.id"] === conversationId,
    );
}

function summary(record: any) {
  return {
    eventName: record.eventName,
    severity: record.severityText,
    body: record.body.stringValue,
    attributes: decodeAttributes(record.attributes),
  };
}

function spansOf(conversationId: string): any[] {
  const bodies: any[] = collector().bodies("/v1/traces");
  return bodies
    .flatMap((body) => body.resourceSpans[0].scopeSpans[0].spans)
    .filter(
      (span) => decodeAttributes(span.attributes)["gen_ai.conversation.id"] === conversationId,
    );
}

function failed(fields: Record<string, unknown> = {}) {
  return assistant(PROVIDER, { stopReason: "error", errorMessage: SECRET, ...fields });
}

function response(status: number) {
  return { type: "after_provider_response", status, headers: {} };
}

test("logs session, model, thinking level and compaction events with metadata only", async () => {
  const emit = loadExtension({ sessionId: "events" });
  const common = { "pi.session.kind": "main", "gen_ai.conversation.id": "events" };
  await emit({ type: "session_start", reason: "resume", previousSessionFile: SECRET });
  await emit({
    type: "model_select",
    model: { provider: PROVIDER, id: "claude", name: SECRET },
    previousModel: { provider: "openai", id: "gpt" },
    source: "set",
  });
  await emit({
    type: "model_select",
    model: { provider: PROVIDER, id: "claude" },
    previousModel: undefined,
    source: "cycle",
  });
  await emit({ type: "thinking_level_select", level: "high", previousLevel: "off" });
  const entry = { summary: SECRET, firstKeptEntryId: SECRET, tokensBefore: 5000 };
  await emit({
    type: "session_compact",
    compactionEntry: {
      ...entry,
      usage: {
        input: 100,
        output: 20,
        cacheRead: 50,
        cacheWrite: 10,
        reasoning: 7,
        cost: { total: 0.1 },
      },
    },
    reason: "threshold",
    willRetry: false,
    fromExtension: false,
  });
  await emit({
    type: "session_compact",
    compactionEntry: entry,
    reason: "overflow",
    willRetry: true,
    fromExtension: true,
  });
  for (const aborted of [true, false]) {
    await emit({
      type: "session_compact_failed",
      reason: "manual",
      errorMessage: SECRET,
      aborted,
      willRetry: false,
      fromExtension: false,
    });
  }
  await emit({ type: "session_shutdown", reason: "quit", targetSessionFile: SECRET });

  const records = logsOf("events");
  expect(JSON.stringify(records)).not.toContain(SECRET);
  expect(records.map(summary)).toEqual([
    {
      eventName: "pi.session.start",
      severity: "INFO",
      body: "Session started",
      attributes: {
        ...common,
        "pi.session.start_reason": "resume",
        "pi.thinking_level.selected": "off",
      },
    },
    {
      eventName: "pi.model.select",
      severity: "INFO",
      body: "Model selected",
      attributes: {
        ...common,
        "gen_ai.provider.name": PROVIDER,
        "gen_ai.request.model": "claude",
        "pi.model.source": "set",
        "pi.model.previous_provider": "openai",
        "pi.model.previous_model": "gpt",
      },
    },
    {
      eventName: "pi.model.select",
      severity: "INFO",
      body: "Model selected",
      attributes: {
        ...common,
        "gen_ai.provider.name": PROVIDER,
        "gen_ai.request.model": "claude",
        "pi.model.source": "cycle",
      },
    },
    {
      eventName: "pi.thinking_level.select",
      severity: "INFO",
      body: "Thinking level selected",
      attributes: {
        ...common,
        "pi.thinking_level.selected": "high",
        "pi.thinking_level.previous": "off",
      },
    },
    {
      eventName: "pi.compaction",
      severity: "INFO",
      body: "Context compacted",
      attributes: {
        ...common,
        "pi.compaction.reason": "threshold",
        "pi.compaction.tokens_before": 5000,
        "pi.compaction.will_retry": false,
        "pi.compaction.from_extension": false,
        "gen_ai.usage.input_tokens": 160,
        "gen_ai.usage.output_tokens": 20,
        "gen_ai.usage.cache_read.input_tokens": 50,
        "gen_ai.usage.cache_creation.input_tokens": 10,
        "gen_ai.usage.reasoning.output_tokens": 7,
      },
    },
    {
      eventName: "pi.compaction",
      severity: "INFO",
      body: "Context compacted",
      attributes: {
        ...common,
        "pi.compaction.reason": "overflow",
        "pi.compaction.tokens_before": 5000,
        "pi.compaction.will_retry": true,
        "pi.compaction.from_extension": true,
      },
    },
    {
      eventName: "pi.compaction.failed",
      severity: "WARN",
      body: "Context compaction failed",
      attributes: {
        ...common,
        "pi.compaction.reason": "manual",
        "pi.compaction.aborted": true,
        "pi.compaction.will_retry": false,
        "pi.compaction.from_extension": false,
      },
    },
    {
      eventName: "pi.compaction.failed",
      severity: "ERROR",
      body: "Context compaction failed",
      attributes: {
        ...common,
        "pi.compaction.reason": "manual",
        "pi.compaction.aborted": false,
        "pi.compaction.will_retry": false,
        "pi.compaction.from_extension": false,
      },
    },
    {
      eventName: "pi.session.shutdown",
      severity: "INFO",
      body: "Session shut down",
      attributes: { ...common, "pi.session.shutdown_reason": "quit" },
    },
  ]);
  expect(records.map((record) => record.traceId)).toEqual(Array(records.length).fill(undefined));
});

test("adds the initial model and thinking level to the session start record", async () => {
  const emit = loadExtension({
    sessionId: "initial",
    model: { provider: PROVIDER, id: "claude" },
    thinkingLevel: "medium",
  });
  await emit({ type: "session_start", reason: "startup" });
  await emit({ type: "session_shutdown", reason: "quit" });

  const [start] = logsOf("initial");
  expect(summary(start).attributes).toEqual({
    "pi.session.kind": "main",
    "gen_ai.conversation.id": "initial",
    "pi.session.start_reason": "startup",
    "pi.thinking_level.selected": "medium",
    "gen_ai.provider.name": PROVIDER,
    "gen_ai.request.model": "claude",
  });
});

test("logs a failed model request, but not an aborted one, with the agent name of a subagent", async () => {
  const emit = loadExtension({
    sessionId: "failed",
    systemPrompt: `<active_agent name="Explore"/>`,
  });
  await emit({ type: "session_start", reason: "startup" });
  await emit(failed({ model: "claude" }));
  await emit(assistant(PROVIDER, { stopReason: "aborted", errorMessage: SECRET }));
  await emit({ type: "session_shutdown", reason: "quit" });

  const records = logsOf("failed").filter(
    (record) => record.eventName === "pi.model.request.failed",
  );
  expect(JSON.stringify(records)).not.toContain(SECRET);
  expect(records.map(summary)).toEqual([
    {
      eventName: "pi.model.request.failed",
      severity: "ERROR",
      body: "Model request failed",
      attributes: {
        "pi.session.kind": "subagent",
        "gen_ai.agent.name": "Explore",
        "gen_ai.conversation.id": "failed",
        "gen_ai.provider.name": PROVIDER,
        "gen_ai.request.model": "claude",
        "error.type": "error",
      },
    },
  ]);
});

test("logs a duplicated session_start or session_shutdown once", async () => {
  const emit = loadExtension({ sessionId: "duplicates" });
  await emit({ type: "session_start", reason: "new" });
  await emit({ type: "session_start", reason: "startup" });
  await emit({ type: "session_shutdown", reason: "new" });
  await emit({ type: "session_shutdown", reason: "quit" });

  expect(logsOf("duplicates").map((record) => summary(record).attributes)).toMatchObject([
    { "pi.session.start_reason": "new" },
    { "pi.session.shutdown_reason": "new" },
  ]);
});

test("links records inside a run to the innermost open span and a failed request to its chat span", async () => {
  const emit = loadExtension({ sessionId: "context" });
  await emit({ type: "session_start", reason: "startup" });
  await emit({ type: "agent_start" });
  await emit({ type: "turn_start", turnIndex: 0, timestamp: Date.now() });
  await emit({ type: "thinking_level_select", level: "low", previousLevel: "off" });
  await emit(failed({ durationMs: 5 }));
  await emit(failed());
  await emit(toolStart("bash", "call-1"));
  await emit({ type: "session_shutdown", reason: "quit" });

  const spans = spansOf("context");
  const spanId = (name: string) => spans.find((span) => span.name === name).spanId;
  const [run] = spans;
  const records = logsOf("context");
  expect(records.map((record) => [record.eventName, record.traceId, record.spanId])).toEqual([
    ["pi.session.start", undefined, undefined],
    ["pi.thinking_level.select", run.traceId, spanId("pi.turn")],
    ["pi.model.request.failed", run.traceId, spanId("chat claude")],
    ["pi.model.request.failed", run.traceId, spanId("pi.turn")],
    ["pi.session.shutdown", run.traceId, spanId("execute_tool bash")],
  ]);
});

test("adds the HTTP status only when the last response of the failed request reported an error", async () => {
  const emit = loadExtension({ sessionId: "status" });
  await emit({ type: "session_start", reason: "startup" });

  await emit(response(429));
  await emit(failed({ model: "rate-limited" }));
  await emit(response(500));
  await emit(assistant(PROVIDER, { model: "recovered" }));
  await emit(failed({ model: "after-success" }));
  await emit(response(503));
  await emit(response(200));
  await emit(failed({ model: "retried" }));
  await emit(response(502));
  await emit(assistant(PROVIDER, { stopReason: "aborted" }));
  await emit(failed({ model: "after-abort" }));
  await emit(response(429));
  await emit({ type: "turn_start", turnIndex: 0, timestamp: Date.now() });
  await emit(failed({ model: "next-turn" }));
  await emit({ type: "session_shutdown", reason: "quit" });

  const statuses = logsOf("status")
    .filter((record) => record.eventName === "pi.model.request.failed")
    .map((record) => {
      const attributes = decodeAttributes(record.attributes);
      return [attributes["gen_ai.request.model"], attributes["http.response.status_code"]];
    });
  expect(statuses).toEqual([
    ["rate-limited", 429],
    ["after-success", undefined],
    ["retried", undefined],
    ["after-abort", undefined],
    ["next-turn", undefined],
  ]);
});

test("adds truncated error messages to failure records only when PI_OTLP_LOG_ERROR_MESSAGES is true", async () => {
  // Each emoji takes two UTF-16 code units, and the truncation must not split one.
  const emoji = "😀";
  const long = emoji.repeat(MAX_ERROR_MESSAGE_LENGTH + 10);
  const messages: Record<string, unknown> = {};
  for (const value of [undefined, "1", "TRUE"]) {
    if (value !== undefined) {
      process.env[ERROR_MESSAGES_ENV] = value;
    }
    const sessionId = `opt-in-${value ?? "unset"}`;
    const emit = loadExtension({ sessionId });
    await emit({ type: "session_start", reason: "startup" });
    await emit(failed({ errorMessage: long, durationMs: 1 }));
    await emit({
      type: "session_compact_failed",
      reason: "threshold",
      errorMessage: "summary failed",
      aborted: false,
      willRetry: false,
      fromExtension: false,
    });
    await emit({ type: "session_shutdown", reason: "quit" });
    messages[sessionId] = logsOf(sessionId)
      .map((record) => decodeAttributes(record.attributes)["pi.error.message"])
      .filter((message) => message !== undefined);
  }

  expect(messages).toEqual({
    "opt-in-unset": [],
    "opt-in-1": [],
    "opt-in-TRUE": [emoji.repeat(MAX_ERROR_MESSAGE_LENGTH), "summary failed"],
  });
  const spansAndMetrics = JSON.stringify([
    spansOf("opt-in-TRUE"),
    collector().bodies("/v1/metrics"),
  ]);
  expect(spansAndMetrics).toContain("chat claude");
  expect(spansAndMetrics).not.toContain("summary failed");
  expect(spansAndMetrics).not.toContain(emoji);
});
