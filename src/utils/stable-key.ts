// SPDX-FileCopyrightText: 2026 Thomas Fazzari
// SPDX-License-Identifier: MIT

export function stableKey(record: Readonly<Record<string, string | number | boolean>>): string {
  const entries = Object.entries(record).map(
    ([key, value]) => [key, typeof value, String(value)] as const,
  );
  return JSON.stringify(entries.toSorted(([a], [b]) => (a < b ? -1 : 1)));
}
