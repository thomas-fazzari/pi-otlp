// SPDX-FileCopyrightText: 2026 Thomas Fazzari
// SPDX-License-Identifier: MIT

import { decodeAttributes } from "./otlp-json.ts";

// The OTLP JSON span fields that the tree needs, whether they come from the collector stub or from Tempo.
export interface TreeSpan {
  spanId: string;
  parentSpanId?: string | undefined;
  name: string;
  startTimeUnixNano: string;
  attributes: any[];
}

const MARKED_ATTRIBUTES = ["error.type", "pi.aborted", "pi.interrupted"];

// One line per trace root, such as `invoke_agent pi(pi.turn(chat m,execute_tool read[error.type=not_run]))`, children in start order.
export function spanTrees(spans: TreeSpan[]): string[] {
  const ids = new Set(spans.map((span) => span.spanId));
  const children = new Map<string, TreeSpan[]>();
  const roots: TreeSpan[] = [];
  for (const span of spans) {
    const parent = span.parentSpanId;
    if (parent === undefined || parent === "" || !ids.has(parent)) {
      roots.push(span);
      continue;
    }
    children.set(parent, [...(children.get(parent) ?? []), span]);
  }
  const render = (span: TreeSpan): string => {
    const attributes = decodeAttributes(span.attributes);
    const marks = MARKED_ATTRIBUTES.filter((key) => key in attributes).map(
      (key) => `${key}=${String(attributes[key])}`,
    );
    const kids = byStart(children.get(span.spanId) ?? []).map(render);
    let text = span.name;
    if (marks.length > 0) {
      text += `[${marks.join(",")}]`;
    }
    if (kids.length > 0) {
      text += `(${kids.join(",")})`;
    }
    return text;
  };
  return byStart(roots).map(render);
}

function byStart(spans: TreeSpan[]): TreeSpan[] {
  return spans.toSorted((a, b) => {
    const difference = BigInt(a.startTimeUnixNano) - BigInt(b.startTimeUnixNano);
    if (difference !== 0n) {
      return difference < 0n ? -1 : 1;
    }
    return a.name < b.name ? -1 : 1;
  });
}
