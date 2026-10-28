// SPDX-FileCopyrightText: 2026 Thomas Fazzari
// SPDX-License-Identifier: MIT

import { toInt64 } from "./otlp.ts";
import type * as otlp from "./otlp.ts";

type AttributeValue = string | number | boolean;
export type Attributes = Readonly<Record<string, AttributeValue>>;

export function encodeAttributes(attributes: Attributes): otlp.KeyValue[] {
  return Object.entries(attributes).map(([key, value]) => ({ key, value: encodeValue(value) }));
}

function encodeValue(value: AttributeValue): otlp.AnyValue {
  if (typeof value === "string") {
    return { stringValue: value };
  }
  if (typeof value === "boolean") {
    return { boolValue: value };
  }
  if (Number.isSafeInteger(value)) {
    return { intValue: toInt64(value) };
  }
  return { doubleValue: encodeDouble(value) };
}

function encodeDouble(value: number): otlp.Double {
  if (Number.isNaN(value)) {
    return "NaN";
  }
  if (value === Infinity) {
    return "Infinity";
  }
  if (value === -Infinity) {
    return "-Infinity";
  }
  return value;
}
