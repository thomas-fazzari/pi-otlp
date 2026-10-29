// SPDX-FileCopyrightText: 2026 Thomas Fazzari
// SPDX-License-Identifier: MIT

import { afterAll, beforeAll } from "bun:test";
import piOtlp from "../src/index.ts";
import { Collector, configure, resetConfig } from "./collector.ts";

type Handler = (event: any, ctx: any) => unknown;
type Emit = (event: { type: string; [key: string]: unknown }) => Promise<void>;

const MAIN_PROMPT = "You are Pi, a coding agent.";

// The extension keeps one telemetry core per process, so a test file shares one collector and drops the core after its tests.
export function useCollector(): () => Collector {
  let receiver: Collector | undefined;
  beforeAll(() => {
    receiver = new Collector();
    configure(receiver.url);
  });
  afterAll(async () => {
    resetConfig();
    await receiver?.stop();
    Reflect.deleteProperty(globalThis, Symbol.for("pi-otlp"));
  });
  return () => {
    if (receiver === undefined) {
      throw new Error("the collector starts in beforeAll");
    }
    return receiver;
  };
}

// Loads the extension the way Pi does and returns a function that delivers Pi events to it.
export function loadExtension(options: { systemPrompt?: string; sessionId?: string } = {}): Emit {
  const handlers = new Map<string, Handler>();
  piOtlp({
    on: (name: string, handler: Handler) => {
      handlers.set(name, handler);
      return () => handlers.delete(name);
    },
  });
  const ctx = {
    getSystemPrompt: () => options.systemPrompt ?? MAIN_PROMPT,
    sessionManager: { getSessionId: () => options.sessionId ?? "session" },
  };
  return async (event) => {
    await handlers.get(event.type)?.(event, ctx);
  };
}

export function assistant(provider: string, fields: Record<string, unknown>) {
  return {
    type: "message_end",
    message: {
      role: "assistant",
      provider,
      model: "claude",
      stopReason: "stop",
      timestamp: Date.now(),
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: { total: 0 } },
      ...fields,
    },
  };
}

export function toolStart(toolName: string, toolCallId: string, parentToolCallId?: string) {
  return { type: "tool_execution_start", toolCallId, toolName, args: {}, parentToolCallId };
}

export function toolEnd(
  toolName: string,
  isError: boolean,
  durationMs?: number,
  toolCallId = "call",
) {
  return { type: "tool_execution_end", toolCallId, toolName, isError, durationMs };
}
