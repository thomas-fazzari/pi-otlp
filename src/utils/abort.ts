// SPDX-FileCopyrightText: 2026 Thomas Fazzari
// SPDX-License-Identifier: MIT

export async function raceAbort(work: Promise<unknown>, signal: AbortSignal): Promise<void> {
  if (signal.aborted) {
    return;
  }
  const aborted = new Promise<void>((resolve) => {
    signal.addEventListener("abort", () => resolve(), { once: true });
  });
  await Promise.race([work, aborted]);
}
