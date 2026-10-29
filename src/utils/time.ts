// SPDX-FileCopyrightText: 2026 Thomas Fazzari
// SPDX-License-Identifier: MIT

const NANOS_PER_MS = 1_000_000;

// Splits whole and fractional milliseconds because epoch nanoseconds exceed the integers a double holds exactly.
export function unixNanos(epochMs: number): `${bigint}` {
  const wholeMs = Math.floor(epochMs);
  const fractionNanos = Math.round((epochMs - wholeMs) * NANOS_PER_MS);
  return `${BigInt(wholeMs) * BigInt(NANOS_PER_MS) + BigInt(fractionNanos)}`;
}

export function nowUnixNanos(): `${bigint}` {
  return unixNanos(Date.now());
}
