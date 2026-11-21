// SPDX-FileCopyrightText: 2026 Thomas Fazzari
// SPDX-License-Identifier: MIT

import { basename } from "node:path";

const PROJECT_KEY = Symbol.for("pi-otlp.project");

// A subagent can run in another directory (worktree for example), so we use the first session of the process
const store: { [PROJECT_KEY]?: string; [key: string]: unknown } = globalThis;

export function processProject(cwd: string): string {
  store[PROJECT_KEY] ??= basename(cwd);
  return store[PROJECT_KEY];
}

export function resetProcessProject(): void {
  delete store[PROJECT_KEY];
}
