// SPDX-FileCopyrightText: 2026 Thomas Fazzari
// SPDX-License-Identifier: MIT

import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import type { AssistantMessage, Model, TranscriptContext } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export const PROVIDER = "faux-test";
export const MODEL = "faux-1";
const RESPONSE_DELAY_MS = 30;
const SPAWN_KEYWORD = "spawn";
const BLOCKED_TOOL = "bash";

// The transcript since the last user message picks the step: "spawn" calls Agent once, other prompts call read, then a blocked bash, then answer.
function nextContent(context: TranscriptContext): AssistantMessage["content"] {
  const lastUser = context.messages.findLastIndex((message) => message.role === "user");
  const prompt = JSON.stringify(context.messages[lastUser]?.content ?? "");
  const results = context.messages
    .slice(lastUser)
    .filter((message) => message.role === "toolResult").length;
  const id = `call_${crypto.randomUUID().slice(0, 8)}`;
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
    return [{ type: "toolCall", id, name: BLOCKED_TOOL, arguments: { command: "true" } }];
  }
  return [{ type: "text", text: "done" }];
}

function respond(model: Model<string>, context: TranscriptContext) {
  const stream = createAssistantMessageEventStream();
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
      timestamp: Date.now(),
    };
    stream.push({ type: "start", partial: { ...message, content: [] } });
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
  pi.on("tool_call", (event) => {
    if (event.toolName !== BLOCKED_TOOL) {
      return undefined;
    }
    return { block: true, reason: "blocked by the e2e provider" };
  });
}
