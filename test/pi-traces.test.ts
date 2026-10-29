// SPDX-FileCopyrightText: 2026 Thomas Fazzari
// SPDX-License-Identifier: MIT

import { expect, test } from "bun:test";
import { assistant, loadExtension, toolEnd, toolStart, useCollector } from "./pi-harness.ts";
import { decodeAttributes } from "./otlp-json.ts";
import { spanTrees } from "./span-tree.ts";

const PROVIDER = "anthropic";
const LATER_MS = 100;
const NANOS_PER_MS = 1_000_000n;

const collector = useCollector();

function spansOf(conversationId: string): any[] {
  const bodies: any[] = collector().bodies("/v1/traces");
  return bodies
    .flatMap((body) => body.resourceSpans[0].scopeSpans[0].spans)
    .filter(
      (span) => decodeAttributes(span.attributes)["gen_ai.conversation.id"] === conversationId,
    );
}

function spanNamed(spans: any[], name: string): any {
  return spans.find((span) => span.name === name);
}

function turnStart(turnIndex: number, timestamp = Date.now()) {
  return { type: "turn_start", turnIndex, timestamp };
}

test("builds one trace per run, with turns, model requests and nested tool calls", async () => {
  const emit = loadExtension({ sessionId: "tree" });
  const first = Date.now();
  const later = first + LATER_MS;
  await emit({ type: "session_start" });
  await emit({ type: "agent_start" });
  await emit(turnStart(0, first));
  await emit(assistant(PROVIDER, { stopReason: "toolUse", durationMs: 5 }));
  await emit(toolStart("code", "call-1"));
  await emit(toolStart("read", "call-1/1", "call-1"));
  await emit(toolEnd("read", false, 1, "call-1/1"));
  await emit(toolEnd("code", false, 2, "call-1"));
  await emit(toolStart("late", "call-1/2", "call-1"));
  await emit(toolEnd("late", false, 1, "call-1/2"));
  await emit({ type: "turn_end" });
  await emit(turnStart(1, later));
  await emit(assistant(PROVIDER, { timestamp: later, durationMs: 5 }));
  await emit({ type: "turn_end" });
  await emit({ type: "agent_end" });
  await emit({ type: "agent_settled", aborted: false });
  await emit({ type: "session_shutdown", reason: "quit" });

  const spans = spansOf("tree");
  expect(spanTrees(spans)).toEqual([
    "invoke_agent pi(pi.turn(chat claude,execute_tool code(execute_tool read),execute_tool late),pi.turn(chat claude))",
  ]);
  expect(new Set(spans.map((span) => span.traceId)).size).toBe(1);
  expect(spanNamed(spans, "pi.turn").startTimeUnixNano).toBe(`${BigInt(first) * NANOS_PER_MS}`);
  for (const span of spans) {
    expect(decodeAttributes(span.attributes)).toMatchObject({
      "pi.session.kind": "main",
      "gen_ai.conversation.id": "tree",
    });
  }
  expect(decodeAttributes(spanNamed(spans, "invoke_agent pi").attributes)).toMatchObject({
    "gen_ai.operation.name": "invoke_agent",
    "gen_ai.agent.name": "pi",
  });
  const turnIndexes = spans
    .filter((span) => span.name === "pi.turn")
    .map((span) => decodeAttributes(span.attributes)["pi.turn.index"]);
  expect(turnIndexes.toSorted((a, b) => Number(a) - Number(b))).toEqual([0, 1]);
  expect(decodeAttributes(spanNamed(spans, "execute_tool read").attributes)).toMatchObject({
    "gen_ai.operation.name": "execute_tool",
    "gen_ai.tool.name": "read",
    "gen_ai.tool.call.id": "call-1/1",
  });
});

test("dates a chat span from the request start and counts cached tokens as input", async () => {
  const emit = loadExtension({ sessionId: "chat" });
  await emit({ type: "session_start" });

  await emit(
    assistant(PROVIDER, {
      stopReason: "toolUse",
      timestamp: 1_793_000_000_123,
      durationMs: 1234.5,
      responseId: "response-1",
      responseModel: "claude-2026",
      usage: {
        input: 100,
        output: 20,
        cacheRead: 50,
        cacheWrite: 10,
        reasoning: 7,
        cost: { total: 0.25 },
      },
    }),
  );
  await emit(assistant(PROVIDER, { model: "unreported", timestamp: 1_793_000_000_123 }));
  await emit(assistant(PROVIDER, { model: "plain", durationMs: 3 }));
  await emit({ type: "session_shutdown", reason: "quit" });

  const spans = spansOf("chat");
  expect(spans.map((span) => span.name)).toEqual(["chat claude", "chat plain"]);
  const [chat, plain] = spans;
  expect(chat).toMatchObject({
    kind: 3,
    startTimeUnixNano: "1793000000123000000",
    endTimeUnixNano: "1793000001357500000",
  });
  expect(decodeAttributes(chat.attributes)).toEqual({
    "pi.session.kind": "main",
    "gen_ai.conversation.id": "chat",
    "gen_ai.operation.name": "chat",
    "gen_ai.provider.name": PROVIDER,
    "gen_ai.request.model": "claude",
    "gen_ai.response.model": "claude-2026",
    "gen_ai.response.finish_reasons": ["toolUse"],
    "gen_ai.usage.input_tokens": 160,
    "gen_ai.usage.output_tokens": 20,
    "gen_ai.usage.cache_read.input_tokens": 50,
    "gen_ai.usage.cache_creation.input_tokens": 10,
    "gen_ai.usage.reasoning.output_tokens": 7,
    "pi.cost.usd": 0.25,
    "gen_ai.response.id": "response-1",
  });
  const plainAttributes = decodeAttributes(plain.attributes);
  expect(plainAttributes["gen_ai.response.model"]).toBe("plain");
  expect(plainAttributes).not.toHaveProperty("gen_ai.response.id");
  expect(plainAttributes).not.toHaveProperty("gen_ai.usage.reasoning.output_tokens");
  const plainAttributeList: any[] = plain.attributes;
  const plainCost = plainAttributeList.find((attribute) => attribute.key === "pi.cost.usd");
  expect(plainCost.value).toEqual({ doubleValue: 0 });
});

test("marks failed model requests and tools with an error status and error.type, never a message", async () => {
  const emit = loadExtension({ sessionId: "errors" });
  await emit({ type: "session_start" });

  for (const stopReason of ["error", "aborted", "stop"]) {
    await emit(
      assistant(PROVIDER, { model: stopReason, stopReason, durationMs: 1, errorMessage: "secret" }),
    );
  }
  for (const [toolName, isError, durationMs] of [
    ["failed", true, 3],
    ["blocked", true, undefined],
    ["fine", false, 3],
  ] as const) {
    await emit(toolStart(toolName, toolName));
    await emit({ ...toolEnd(toolName, isError, durationMs, toolName), result: "secret" });
  }
  await emit({ type: "session_shutdown", reason: "quit" });

  const spans = spansOf("errors");
  const outcome = (name: string) => {
    const span = spanNamed(spans, name);
    return { status: span.status, errorType: decodeAttributes(span.attributes)["error.type"] };
  };
  expect(outcome("chat error")).toEqual({ status: { code: 2 }, errorType: "error" });
  expect(outcome("chat aborted")).toEqual({ status: { code: 2 }, errorType: "aborted" });
  expect(outcome("chat stop")).toEqual({ status: undefined, errorType: undefined });
  expect(outcome("execute_tool failed")).toEqual({ status: { code: 2 }, errorType: "tool_error" });
  expect(outcome("execute_tool blocked")).toEqual({ status: { code: 2 }, errorType: "not_run" });
  expect(outcome("execute_tool fine")).toEqual({ status: undefined, errorType: undefined });
  expect(JSON.stringify(spans)).not.toContain("secret");
});

test("ends the spans still open at shutdown, children first, and exports them", async () => {
  const emit = loadExtension({ sessionId: "interrupted" });
  await emit({ type: "session_start" });
  await emit({ type: "agent_start" });
  await emit(turnStart(0));
  await emit(assistant(PROVIDER, { stopReason: "toolUse", durationMs: 2 }));
  await emit(toolStart("bash", "call-1"));

  await emit({ type: "session_shutdown", reason: "quit" });

  const spans = spansOf("interrupted");
  expect(spanTrees(spans)).toEqual([
    "invoke_agent pi[pi.interrupted=true](pi.turn[pi.interrupted=true](chat claude,execute_tool bash[pi.interrupted=true]))",
  ]);
  const order = spans.map((span) => span.name);
  expect(order.indexOf("execute_tool bash")).toBeLessThan(order.indexOf("pi.turn"));
  expect(order.indexOf("pi.turn")).toBeLessThan(order.indexOf("invoke_agent pi"));
});

test("keeps a retried run in one invoke_agent span and marks an aborted run without an error", async () => {
  const retried = loadExtension({ sessionId: "retried" });
  const later = Date.now() + LATER_MS;
  await retried({ type: "session_start" });
  await retried({ type: "agent_start" });
  await retried(turnStart(0));
  await retried(assistant(PROVIDER, { stopReason: "error", durationMs: 1 }));
  await retried({ type: "turn_end" });
  await retried({ type: "agent_end" });
  await retried({ type: "agent_start" });
  await retried(turnStart(0, later));
  await retried(assistant(PROVIDER, { timestamp: later, durationMs: 1 }));
  await retried({ type: "turn_end" });
  await retried({ type: "agent_end" });
  await retried({ type: "agent_settled", aborted: false });
  const aborted = loadExtension({ sessionId: "aborted" });
  await aborted({ type: "session_start" });
  await aborted({ type: "agent_start" });
  await aborted({ type: "agent_settled", aborted: true });
  await aborted({ type: "session_shutdown", reason: "quit" });

  expect(spanTrees(spansOf("retried"))).toEqual([
    "invoke_agent pi(pi.turn(chat claude[error.type=error]),pi.turn(chat claude))",
  ]);
  const [run] = spansOf("aborted");
  expect(spanTrees([run])).toEqual(["invoke_agent pi[pi.aborted=true]"]);
  expect(run.status).toBeUndefined();
});

test("names the root span after the pi-subagents agent in a child session", async () => {
  const emit = loadExtension({
    sessionId: "child",
    systemPrompt: `<active_agent name="Explore"/>\n\nChild prompt.`,
  });
  await emit({ type: "session_start" });
  await emit({ type: "agent_start" });
  await emit({ type: "agent_settled", aborted: false });
  await emit({ type: "session_shutdown", reason: "quit" });

  const [run] = spansOf("child");
  expect(run.name).toBe("invoke_agent Explore");
  expect(decodeAttributes(run.attributes)).toMatchObject({
    "gen_ai.agent.name": "Explore",
    "pi.session.kind": "subagent",
  });
});
