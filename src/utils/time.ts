// SPDX-FileCopyrightText: 2026 Thomas Fazzari
// SPDX-License-Identifier: MIT

export function nowUnixNanos(): `${bigint}` {
  return `${BigInt(Date.now()) * 1_000_000n}`;
}
