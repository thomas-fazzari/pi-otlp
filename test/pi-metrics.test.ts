// SPDX-FileCopyrightText: 2026 Thomas Fazzari
// SPDX-License-Identifier: MIT

import { expect, test } from "bun:test";
import { latestPoints, metric } from "./collector.ts";
import { decodeAttributes } from "./otlp-json.ts";
import { assistant, loadExtension, toolEnd, useCollector } from "./pi-harness.ts";

const MAIN = { "pi.session.kind": "main" };

const collector = useCollector();

function dataPoints(name: string, filter: Record<string, unknown>): any[] {
  const found = metric(collector().bodies("/v1/metrics").at(-1), name);
  const points = latestPoints(found?.sum?.dataPoints ?? found?.histogram?.dataPoints ?? []);
  return points.filter((point) => {
    const attributes = decodeAttributes(point.attributes);
    return Object.entries(filter).every(([key, value]) => attributes[key] === value);
  });
}

function sums(
  name: string,
  filter: Record<string, unknown>,
): { attributes: object; value: number }[] {
  return dataPoints(name, filter).map((point) => ({
    attributes: decodeAttributes(point.attributes),
    value: point.asDouble,
  }));
}

function histograms(
  name: string,
  filter: Record<string, unknown>,
): { attributes: object; count: number; sum: number }[] {
  return dataPoints(name, filter).map((point) => ({
    attributes: decodeAttributes(point.attributes),
    count: Number(point.count),
    sum: point.sum,
  }));
}

test("counts disjoint token types and cost, and creates no series for zero values", async () => {
  const emit = loadExtension();
  await emit({ type: "session_start" });

  await emit(
    assistant("tokens", {
      usage: {
        input: 100,
        output: 20,
        cacheRead: 0,
        cacheWrite: 10,
        cacheWrite1h: 4,
        reasoning: 7,
        cost: { total: 0.5 },
      },
    }),
  );
  await emit(
    assistant("tokens", {
      usage: { input: 5, output: 1, cacheRead: 30, cacheWrite: 3, cost: { total: 0.25 } },
    }),
  );
  await emit(
    assistant("tokens", {
      model: "free",
      usage: { input: 8, output: 0, cacheRead: 0, cacheWrite: 0, cost: { total: 0 } },
    }),
  );
  await emit({ type: "session_shutdown", reason: "quit" });

  const provider = { "gen_ai.provider.name": "tokens" };
  const claude = { ...MAIN, ...provider, "gen_ai.request.model": "claude" };
  const free = { ...MAIN, ...provider, "gen_ai.request.model": "free" };
  expect(sums("pi.token.usage", provider)).toEqual([
    { attributes: { ...claude, "gen_ai.token.type": "input" }, value: 105 },
    { attributes: { ...claude, "gen_ai.token.type": "output" }, value: 21 },
    { attributes: { ...claude, "gen_ai.token.type": "cache_write" }, value: 9 },
    { attributes: { ...claude, "gen_ai.token.type": "cache_write_1h" }, value: 4 },
    { attributes: { ...claude, "gen_ai.token.type": "cache_read" }, value: 30 },
    { attributes: { ...free, "gen_ai.token.type": "input" }, value: 8 },
  ]);
  expect(sums("pi.cost", provider)).toEqual([{ attributes: claude, value: 0.75 }]);
});

test("records model request durations with the stop reason and error.type for failed requests", async () => {
  const emit = loadExtension();
  await emit({ type: "session_start" });

  await emit(
    assistant("durations", {
      stopReason: "toolUse",
      durationMs: 1500,
      responseModel: "claude-2026",
    }),
  );
  await emit(assistant("durations", { stopReason: "error", durationMs: 200 }));
  await emit(assistant("durations", { stopReason: "aborted", durationMs: 100 }));
  await emit(assistant("durations", { stopReason: "length", durationMs: 300 }));
  await emit(assistant("durations", { stopReason: "stop" }));
  await emit({ type: "session_shutdown", reason: "quit" });

  const provider = { "gen_ai.provider.name": "durations" };
  const request = {
    ...MAIN,
    ...provider,
    "gen_ai.request.model": "claude",
    "gen_ai.operation.name": "chat",
    "gen_ai.response.model": "claude",
  };
  expect(histograms("gen_ai.client.operation.duration", provider)).toEqual([
    {
      attributes: {
        ...request,
        "gen_ai.response.model": "claude-2026",
        "pi.stop_reason": "toolUse",
      },
      count: 1,
      sum: 1.5,
    },
    {
      attributes: { ...request, "pi.stop_reason": "error", "error.type": "error" },
      count: 1,
      sum: 0.2,
    },
    {
      attributes: { ...request, "pi.stop_reason": "aborted", "error.type": "aborted" },
      count: 1,
      sum: 0.1,
    },
    { attributes: { ...request, "pi.stop_reason": "length" }, count: 1, sum: 0.3 },
  ]);
});

test("tells tools that failed while running from tools that never ran", async () => {
  const emit = loadExtension();
  await emit({ type: "session_start" });

  await emit(toolEnd("lookup", false, 4));
  await emit(toolEnd("lookup", false, 0));
  await emit(toolEnd("shell", true, 2500));
  await emit(toolEnd("shell", true));
  await emit({ type: "session_shutdown", reason: "quit" });

  const lookup = { ...MAIN, "gen_ai.tool.name": "lookup" };
  const shell = { ...MAIN, "gen_ai.tool.name": "shell" };
  expect([...sums("pi.tool.calls", lookup), ...sums("pi.tool.calls", shell)]).toEqual([
    { attributes: lookup, value: 2 },
    { attributes: { ...shell, "error.type": "tool_error" }, value: 1 },
    { attributes: { ...shell, "error.type": "not_run" }, value: 1 },
  ]);
  expect([
    ...histograms("pi.tool.duration", lookup),
    ...histograms("pi.tool.duration", shell),
  ]).toEqual([
    { attributes: lookup, count: 2, sum: 0.004 },
    { attributes: { ...shell, "error.type": "tool_error" }, count: 1, sum: 2.5 },
  ]);
});

test("labels a pi-subagents child with its own agent name, after any inherited tag", async () => {
  const main = loadExtension();
  const child = loadExtension({
    systemPrompt: `<active_agent name="worker"/>\n\nParent prompt.\n\n<active_agent name="Explore"/>\n\nChild prompt quoting the tag: \`<active_agent name="x"/>\`.`,
  });
  await main({ type: "session_start" });
  await child({ type: "session_start" });

  await main(toolEnd("spawn", false, 50));
  await child(toolEnd("spawn", false, 5));
  await child({ type: "session_shutdown", reason: "quit" });
  await main({ type: "session_shutdown", reason: "quit" });

  expect(sums("pi.tool.calls", { "gen_ai.tool.name": "spawn" })).toEqual([
    { attributes: { ...MAIN, "gen_ai.tool.name": "spawn" }, value: 1 },
    {
      attributes: {
        "pi.session.kind": "subagent",
        "gen_ai.agent.name": "Explore",
        "gen_ai.tool.name": "spawn",
      },
      value: 1,
    },
  ]);
});

test("keeps counting in the same series across session replacement", async () => {
  const first = loadExtension();
  await first({ type: "session_start" });
  await first(toolEnd("replaced", false, 1));
  await first({ type: "session_shutdown", reason: "new" });
  const second = loadExtension();
  await second({ type: "session_start" });
  await second(toolEnd("replaced", false, 1));
  await second({ type: "session_shutdown", reason: "quit" });

  const points = dataPoints("pi.tool.calls", { "gen_ai.tool.name": "replaced" });
  expect(points).toMatchObject([{ asDouble: 2 }]);
});
