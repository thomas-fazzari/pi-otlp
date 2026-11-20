// SPDX-FileCopyrightText: 2026 Thomas Fazzari
// SPDX-License-Identifier: MIT

import { match, P } from "ts-pattern";
import { toInt64 } from "./otlp.ts";
import type * as otlp from "./otlp.ts";

const SAFE_INTEGER = P.number.int().between(Number.MIN_SAFE_INTEGER, Number.MAX_SAFE_INTEGER);

// A number that stays a double even when whole, because backends store int and double attributes apart.
interface DoubleValue {
  readonly double: number;
}
export type AttributeValue = string | number | boolean | readonly string[] | DoubleValue;
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
  return match<AttributeValue, otlp.AnyValue>(value)
    .with(P.string, (text) => ({ stringValue: text }))
    .with(P.boolean, (flag) => ({ boolValue: flag }))
    .with(SAFE_INTEGER, (integer) => ({ intValue: toInt64(integer) }))
    .with(P.number, (number) => ({ doubleValue: encodeDouble(number) }))
    .with({ double: P.select() }, (double) => ({ doubleValue: encodeDouble(double) }))
    .with(P.array(P.string), (items) => ({
      arrayValue: { values: items.map((item) => ({ stringValue: item })) },
    }))
    .exhaustive();
}

function encodeDouble(value: number): otlp.Double {
  return match<number, otlp.Double>(value)
    .with(Number.NaN, () => "NaN")
    .with(Infinity, () => "Infinity")
    .with(-Infinity, () => "-Infinity")
    .otherwise((finite) => finite);
}
