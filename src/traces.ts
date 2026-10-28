// SPDX-FileCopyrightText: 2026 Thomas Fazzari
// SPDX-License-Identifier: MIT

import { encodeAttributes } from "./attributes.ts";
import type { Attributes } from "./attributes.ts";
import { SPAN_KIND, STATUS_CODE } from "./otlp.ts";
import type * as otlp from "./otlp.ts";
import { randomHex } from "./utils/random.ts";
import { nowUnixNanos } from "./utils/time.ts";

const TRACE_ID_BYTES = 16;
const SPAN_ID_BYTES = 8;

export interface SpanContext {
  readonly traceId: string;
  readonly spanId: string;
}

export interface SpanOptions {
  kind?: keyof typeof SPAN_KIND;
  parent?: SpanContext;
  attributes?: Attributes;
}

interface SpanStatus {
  code: keyof typeof STATUS_CODE;
  message?: string;
}

export interface Span {
  readonly context: SpanContext;
  end(result?: { attributes?: Attributes; status?: SpanStatus }): void;
}

export function startSpan(
  name: string,
  options: SpanOptions,
  onEnd: (span: otlp.Span) => void,
): Span {
  const context = {
    traceId: options.parent?.traceId ?? randomHex(TRACE_ID_BYTES),
    spanId: randomHex(SPAN_ID_BYTES),
  };
  const startTimeUnixNano = nowUnixNanos();
  let ended = false;
  return {
    context,
    end(result = {}) {
      if (ended) {
        return;
      }
      ended = true;
      onEnd({
        ...context,
        parentSpanId: options.parent?.spanId,
        name,
        kind: SPAN_KIND[options.kind ?? "internal"],
        startTimeUnixNano,
        endTimeUnixNano: nowUnixNanos(),
        attributes: encodeAttributes({ ...options.attributes, ...result.attributes }),
        status: encodeStatus(result.status),
      });
    },
  };
}

function encodeStatus(status: SpanStatus | undefined): otlp.Status | undefined {
  if (status === undefined) {
    return undefined;
  }
  return { code: STATUS_CODE[status.code], message: status.message };
}
