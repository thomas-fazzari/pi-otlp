// SPDX-FileCopyrightText: 2026 Thomas Fazzari
// SPDX-License-Identifier: MIT

import type { Attributes } from "./attributes.ts";
import { ATTR_GEN_AI_AGENT_NAME } from "./semconv.ts";

const ATTR_PI_SESSION_KIND = "pi.session.kind";
// pi-subagents puts this tag on its own line in each child prompt, after any tag inherited from a parent prompt.
const ACTIVE_AGENT_TAG = /^<active_agent name="([^"]+)"\/>$/gmu;

export function sessionAttributes(systemPrompt: string): Attributes {
  const agentName = [...systemPrompt.matchAll(ACTIVE_AGENT_TAG)].at(-1)?.[1];
  if (agentName === undefined) {
    return { [ATTR_PI_SESSION_KIND]: "main" };
  }
  return { [ATTR_PI_SESSION_KIND]: "subagent", [ATTR_GEN_AI_AGENT_NAME]: agentName };
}
