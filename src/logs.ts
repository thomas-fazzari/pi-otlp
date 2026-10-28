// SPDX-FileCopyrightText: 2026 Thomas Fazzari
// SPDX-License-Identifier: MIT

import { encodeAttributes } from "./attributes.ts";
import type { Attributes } from "./attributes.ts";
import { SEVERITY_NUMBER } from "./otlp.ts";
import type * as otlp from "./otlp.ts";
import type { SpanContext } from "./traces.ts";
import { nowUnixNanos } from "./utils/time.ts";

export interface LogRecord {
  severity: keyof typeof SEVERITY_NUMBER;
  body: string;
  attributes?: Attributes;
  context?: SpanContext;
}

export function encodeLogRecord(record: LogRecord): otlp.LogRecord {
  const time = nowUnixNanos();
  return {
    timeUnixNano: time,
    observedTimeUnixNano: time,
    severityNumber: SEVERITY_NUMBER[record.severity],
    severityText: record.severity.toUpperCase(),
    body: { stringValue: record.body },
    attributes: encodeAttributes(record.attributes ?? {}),
    traceId: record.context?.traceId,
    spanId: record.context?.spanId,
  };
}
