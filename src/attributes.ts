// SPDX-FileCopyrightText: 2026 Thomas Fazzari
// SPDX-License-Identifier: MIT

import { toInt64 } from "./otlp.ts";
import type * as otlp from "./otlp.ts";

type ScalarValue = string | number | boolean;
// A number that stays a double even when whole, because backends store int and double attributes apart.
interface DoubleValue {
  readonly double: number;
}
export type AttributeValue = ScalarValue | readonly string[] | DoubleValue;
// An undefined value leaves the attribute out.
export type Attributes = Readonly<Record<string, AttributeValue | undefined>>;

export function asDouble(value: number): DoubleValue {
  return { double: value };
}

export function encodeAttributes(attributes: Attributes): otlp.KeyValue[] {
  return definedEntries(attributes).map(([key, value]) => ({ key, value: encodeValue(value) }));
}

export function definedEntries(attributes: Attributes): [string, AttributeValue][] {
  return Object.entries(attributes).filter(
    (entry): entry is [string, AttributeValue] => entry[1] !== undefined,
  );
}

function encodeValue(value: AttributeValue): otlp.AnyValue {
  if (typeof value !== "object") {
    return encodeScalar(value);
  }
  if ("double" in value) {
    return { doubleValue: encodeDouble(value.double) };
  }
  return { arrayValue: { values: value.map((item) => ({ stringValue: item })) } };
}

function encodeScalar(value: ScalarValue): otlp.AnyValue {
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
