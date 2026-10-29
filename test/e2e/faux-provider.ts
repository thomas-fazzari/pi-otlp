// SPDX-FileCopyrightText: 2026 Thomas Fazzari
// SPDX-License-Identifier: MIT

import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import type { AssistantMessage, Model, TranscriptContext } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export const PROVIDER = "faux-test";
export const MODEL = "faux-1";
const RESPONSE_DELAY_MS = 30;
const SPAWN_KEYWORD = "spawn";
const HANG_KEYWORD = "hang";
const FAIL_KEYWORD = "fail";
const BLOCKED_COMMAND = "true";
const HANG_COMMAND = "sleep 300";
// Pi retries errors whose message looks transient, so this one must not.
const FAILURE_MESSAGE = "the faux model rejects this prompt";

function lastUserIndex(context: TranscriptContext): number {
  return context.messages.findLastIndex((message) => message.role === "user");
}

function lastPrompt(context: TranscriptContext): string {
  return JSON.stringify(context.messages[lastUserIndex(context)]?.content ?? "");
}

// Pi asks for compaction and branch summaries without tools, and agent turns always offer some.
function asksForSummary(context: TranscriptContext): boolean {
  return !context.messages.some(
    (message) => message.role === "system" && (message.toolsAdded ?? []).length > 0,
  );
}

function fails(context: TranscriptContext): boolean {
  return lastPrompt(context).includes(FAIL_KEYWORD) && !asksForSummary(context);
}

// The transcript since the last user message picks the step: summaries get text, "spawn" calls Agent once, "hang" runs a long bash, other prompts call read, then a blocked bash, then answer.
function nextContent(context: TranscriptContext): AssistantMessage["content"] {
  const prompt = lastPrompt(context);
  const results = context.messages
    .slice(lastUserIndex(context))
    .filter((message) => message.role === "toolResult").length;
  const id = `call_${crypto.randomUUID().slice(0, 8)}`;
  if (asksForSummary(context)) {
    return [{ type: "text", text: "summary" }];
  }
  if (prompt.includes(HANG_KEYWORD)) {
    return [{ type: "toolCall", id, name: "bash", arguments: { command: HANG_COMMAND } }];
  }
  if (prompt.includes(SPAWN_KEYWORD)) {
    if (results > 0) {
      return [{ type: "text", text: "done" }];
    }
    const args = {
      subagent_type: "Explore",
      description: "probe",
      prompt: "probe",
      run_in_background: false,
    };
    return [{ type: "toolCall", id, name: "Agent", arguments: args }];
  }
  if (results === 0) {
    return [{ type: "toolCall", id, name: "read", arguments: { path: "README.md" } }];
  }
  if (results === 1) {
    return [{ type: "toolCall", id, name: "bash", arguments: { command: BLOCKED_COMMAND } }];
  }
  return [{ type: "text", text: "done" }];
}

function respond(model: Model<string>, context: TranscriptContext) {
  const stream = createAssistantMessageEventStream();
  // Providers date a message from the request start, and Pi times it only if that is not before the stream exists.
  const requestStart = Date.now();
  setTimeout(() => {
    const content = nextContent(context);
    const toolTurn = content[0]?.type === "toolCall";
    const message: AssistantMessage = {
      role: "assistant",
      content,
      api: model.api,
      provider: model.provider,
      model: model.id,
      responseModel: `${model.id}-2026`,
      usage: {
        input: 100,
        output: 20,
        cacheRead: 50,
        cacheWrite: 10,
        cacheWrite1h: 4,
        totalTokens: 180,
        cost: {
          input: 0.0003,
          output: 0.0003,
          cacheRead: 0.00002,
          cacheWrite: 0.00004,
          total: 0.00066,
        },
      },
      stopReason: toolTurn ? "toolUse" : "stop",
      timestamp: requestStart,
    };
    stream.push({ type: "start", partial: { ...message, content: [] } });
    if (fails(context)) {
      const error: AssistantMessage = {
        ...message,
        content: [],
        stopReason: "error",
        errorMessage: FAILURE_MESSAGE,
      };
      stream.push({ type: "error", reason: "error", error });
      stream.end();
      return;
    }
    const block = content[0];
    if (block?.type === "toolCall") {
      stream.push({ type: "toolcall_start", contentIndex: 0, partial: message });
      stream.push({ type: "toolcall_end", contentIndex: 0, toolCall: block, partial: message });
    }
    if (block?.type === "text") {
      stream.push({ type: "text_start", contentIndex: 0, partial: message });
      stream.push({ type: "text_delta", contentIndex: 0, delta: block.text, partial: message });
      stream.push({ type: "text_end", contentIndex: 0, content: block.text, partial: message });
    }
    stream.push({ type: "done", reason: toolTurn ? "toolUse" : "stop", message });
    stream.end();
  }, RESPONSE_DELAY_MS);
  return stream;
}

// A Pi extension with a scripted model, so end-to-end runs need no network and cost nothing.
export default function fauxProvider(pi: ExtensionAPI): void {
  pi.registerProvider(PROVIDER, {
    baseUrl: "http://127.0.0.1:9",
    apiKey: "faux",
    api: "faux-test-api",
    models: [
      {
        id: MODEL,
        name: "Faux 1",
        reasoning: false,
        input: ["text"],
        cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
        contextWindow: 128_000,
        maxTokens: 4096,
      },
    ],
    streamSimple: respond,
  });
  // RPC has no tree navigation command, so the e2e reaches a branch summary through this one.
  pi.registerCommand("e2e-branch-summary", {
    description: "Go back to the first prompt and summarize the abandoned branch",
    handler: async (_args, ctx) => {
      const first = ctx.sessionManager
        .getEntries()
        .find((entry) => entry.type === "message" && entry.message.role === "user");
      if (first === undefined) {
        throw new Error("the session has no prompt to go back to");
      }
      await ctx.navigateTree(first.id, { summarize: true });
    },
  });
  pi.on("tool_call", (event) => {
    if (event.toolName !== "bash" || event.input["command"] !== BLOCKED_COMMAND) {
      return undefined;
    }
    return { block: true, reason: "blocked by the e2e provider" };
  });
}
