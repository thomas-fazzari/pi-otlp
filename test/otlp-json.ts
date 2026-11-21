// SPDX-FileCopyrightText: 2026 Thomas Fazzari
// SPDX-License-Identifier: MIT

import { match, P } from "ts-pattern";
import type * as otlp from "../src/otlp.ts";

function decodeValue(value: otlp.AnyValue): unknown {
  return match(value)
    .with({ intValue: P.select() }, Number)
    .with({ arrayValue: P.select() }, (array) => array.values.map(decodeValue))
    .with({ stringValue: P.select() }, (text) => text)
    .with({ boolValue: P.select() }, (bool) => bool)
    .with({ doubleValue: P.select() }, (double) => double)
    .exhaustive();
}

export function decodeAttributes(attributes: otlp.KeyValue[]): Record<string, unknown> {
  return Object.fromEntries(attributes.map((kv) => [kv.key, decodeValue(kv.value)]));
}
