// SPDX-FileCopyrightText: 2026 Thomas Fazzari
// SPDX-License-Identifier: MIT

const NANOS_PER_MS = 1_000_000n;

export function unixNanos(epochMs: number): `${bigint}` {
  return `${BigInt(epochMs) * NANOS_PER_MS}`;
}

export function nowUnixNanos(): `${bigint}` {
  return unixNanos(Date.now());
}
