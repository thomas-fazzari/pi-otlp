// SPDX-FileCopyrightText: 2026 Thomas Fazzari
// SPDX-License-Identifier: MIT

import { definedEntries } from "../attributes.ts";
import type { Attributes, AttributeValue } from "../attributes.ts";

export function stableKey(record: Attributes): string {
  const entries = definedEntries(record).map(
    ([key, value]) => [key, typeof value, valueText(value)] as const,
  );
  return JSON.stringify(entries.toSorted(([a], [b]) => (a < b ? -1 : 1)));
}

// String() would join ["a,b"] and ["a", "b"] into the same text.
function valueText(value: AttributeValue): string {
  if (typeof value === "object") {
    return JSON.stringify(value);
  }
  return String(value);
}
