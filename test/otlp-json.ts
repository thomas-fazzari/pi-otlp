// SPDX-FileCopyrightText: 2026 Thomas Fazzari
// SPDX-License-Identifier: MIT

function decodeValue(value: any): unknown {
  if (value.intValue !== undefined) {
    return Number(value.intValue);
  }
  if (value.arrayValue !== undefined) {
    const values: any[] = value.arrayValue.values;
    return values.map(decodeValue);
  }
  return value.stringValue ?? value.boolValue ?? value.doubleValue;
}

export function decodeAttributes(attributes: any[]): Record<string, unknown> {
  return Object.fromEntries(attributes.map((kv) => [kv.key, decodeValue(kv.value)]));
}
