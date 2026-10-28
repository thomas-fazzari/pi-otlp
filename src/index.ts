// SPDX-FileCopyrightText: 2026 Thomas Fazzari
// SPDX-License-Identifier: MIT

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { sdkDisabled } from "./config.ts";
import { acquireTelemetry, flushTelemetry, releaseTelemetry } from "./telemetry.ts";

export default function piOtlp(pi: ExtensionAPI): void {
  if (sdkDisabled()) {
    return;
  }
  // Pi delivers session_start twice to a replacement runtime, so each runtime holds at most one reference.
  let held = false;
  pi.on("session_start", () => {
    if (held) {
      return;
    }
    held = true;
    acquireTelemetry();
  });
  pi.on("session_shutdown", async (event) => {
    if (held) {
      held = false;
      await releaseTelemetry();
    }
    // References still held by child sessions or by runtimes Pi never shut down must not cost the data at exit.
    if (event.reason === "quit") {
      await flushTelemetry();
    }
  });
}
