// SPDX-FileCopyrightText: 2026 Thomas Fazzari
// SPDX-License-Identifier: MIT

import type { Attributes } from "./attributes.ts";
import { ATTR_PI_SESSION_KIND } from "./pi-conventions.ts";
import { ATTR_GEN_AI_AGENT_NAME } from "./semconv.ts";

// @tintinweb/pi-subagents and pi-subagents both put this tag on its own line in each child prompt, after any tag inherited from a parent prompt.
const ACTIVE_AGENT_TAG = /^<active_agent name="([^"]+)"\/>$/gmu;

export interface Session {
  kind: "main" | "subagent";
  agentName: string | undefined;
}

export function detectSession(systemPrompt: string): Session {
  const agentName = [...systemPrompt.matchAll(ACTIVE_AGENT_TAG)].at(-1)?.[1];
  if (agentName === undefined) {
    return { kind: "main", agentName };
  }
  return { kind: "subagent", agentName };
}

export function sessionAttributes(session: Session): Attributes {
  if (session.agentName === undefined) {
    return { [ATTR_PI_SESSION_KIND]: session.kind };
  }
  return { [ATTR_PI_SESSION_KIND]: session.kind, [ATTR_GEN_AI_AGENT_NAME]: session.agentName };
}
