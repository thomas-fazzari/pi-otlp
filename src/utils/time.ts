// SPDX-FileCopyrightText: 2026 Thomas Fazzari
// SPDX-License-Identifier: MIT

import type { Brand } from "./brand.ts";

const NANOS_PER_MS = 1_000_000;

// Epoch nanoseconds in the decimal string form that proto3 JSON uses for 64-bit integers.
export type UnixNanos = Brand<`${bigint}`, "UnixNanos">;

// Splits whole and fractional milliseconds because epoch nanoseconds exceed the integers a double holds exactly.
export function unixNanos(epochMs: number): UnixNanos {
  const wholeMs = Math.floor(epochMs);
  const fractionNanos = Math.round((epochMs - wholeMs) * NANOS_PER_MS);
  // oxlint-disable-next-line typescript/consistent-type-assertions, typescript/no-unsafe-type-assertion
  return `${BigInt(wholeMs) * BigInt(NANOS_PER_MS) + BigInt(fractionNanos)}` as UnixNanos;
}

export function nowUnixNanos(): UnixNanos {
  return unixNanos(Date.now());
}
