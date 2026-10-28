// SPDX-FileCopyrightText: 2026 Thomas Fazzari
// SPDX-License-Identifier: MIT

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { spawnSync } from "node:child_process";

const FILE_TOOLS = new Set(["edit", "write"]);
const FORMATTED_FILE = /\.(?:md|json|jsonc|ya?ml|toml|m?js|ts)$/u;

export default function (pi: ExtensionAPI) {
  pi.on("tool_result", (event, ctx) => {
    const path = event.input["path"];
    if (event.isError || !FILE_TOOLS.has(event.toolName) || typeof path !== "string") {
      return;
    }
    if (FORMATTED_FILE.test(path)) {
      spawnSync("bunx", ["--bun", "oxfmt", "--write", "--no-error-on-unmatched-pattern", path], {
        cwd: ctx.cwd,
      });
    }
  });
}
