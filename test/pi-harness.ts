// SPDX-FileCopyrightText: 2026 Thomas Fazzari
// SPDX-License-Identifier: MIT

import { afterAll, beforeAll } from "bun:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import piOtlp from "../src/index.ts";
import type * as otlp from "../src/otlp.ts";
import { resetProcessTelemetry } from "../src/telemetry.ts";
import { Collector, configure, resetConfig } from "./collector.ts";
import { decodeAttributes } from "./otlp-json.ts";

type Handler = (event: never, ctx: never) => unknown;
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
    resetProcessTelemetry();
  });
  return () => {
    if (receiver === undefined) {
      throw new Error("the collector starts in beforeAll");
    }
    return receiver;
  };
}

export function spansOf(receiver: Collector, conversationId: string): otlp.Span[] {
  return receiver
    .bodies("/v1/traces")
    .flatMap((body) => body.resourceSpans[0]?.scopeSpans[0]?.spans ?? [])
    .filter(
      (span) => decodeAttributes(span.attributes)["gen_ai.conversation.id"] === conversationId,
    );
}

// Loads the extension the way Pi does and returns a function that delivers Pi events to it.
export function loadExtension(
  options: {
    systemPrompt?: string;
    sessionId?: string;
    model?: { provider: string; id: string };
    thinkingLevel?: ReturnType<ExtensionAPI["getThinkingLevel"]>;
  } = {},
): Emit {
  const handlers = new Map<string, Handler>();
  piOtlp({
    on: (name: string, handler: Handler) => {
      handlers.set(name, handler);
      return () => handlers.delete(name);
    },
    getThinkingLevel: () => options.thinkingLevel ?? "off",
  });
  const ctx = {
    getSystemPrompt: () => options.systemPrompt ?? MAIN_PROMPT,
    sessionManager: { getSessionId: () => options.sessionId ?? "session" },
    model: options.model,
  };
  return async (event) => {
    const handler = handlers.get(event.type);
    if (handler !== undefined) {
      await Reflect.apply(handler, undefined, [event, ctx]);
    }
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
