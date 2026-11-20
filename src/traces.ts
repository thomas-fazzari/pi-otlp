// SPDX-FileCopyrightText: 2026 Thomas Fazzari
// SPDX-License-Identifier: MIT

import { encodeAttributes } from "./attributes.ts";
import type { Attributes } from "./attributes.ts";
import { SPAN_KIND, STATUS_CODE } from "./otlp.ts";
import type * as otlp from "./otlp.ts";
import type { Brand } from "./utils/brand.ts";
import { randomHex } from "./utils/random.ts";
import { unixNanos } from "./utils/time.ts";

const TRACE_ID_BYTES = 16;
const SPAN_ID_BYTES = 8;

export type TraceId = Brand<string, "TraceId">;
export type SpanId = Brand<string, "SpanId">;

export interface SpanContext {
  readonly traceId: TraceId;
  readonly spanId: SpanId;
}

export interface SpanOptions {
  kind?: keyof typeof SPAN_KIND;
  parent?: SpanContext | undefined;
  attributes?: Attributes;
  startTimeMs?: number;
}

export interface SpanResult {
  attributes?: Attributes;
  status?: SpanStatus;
  endTimeMs?: number;
}

interface SpanStatus {
  code: keyof typeof STATUS_CODE;
  message?: string;
}

export interface Span {
  readonly context: SpanContext;
  end(result?: SpanResult): void;
}

export function startSpan(
  name: string,
  options: SpanOptions,
  onEnd: (span: otlp.Span) => void,
): Span {
  const context: SpanContext = {
    traceId: options.parent?.traceId ?? newTraceId(),
    spanId: newSpanId(),
  };
  const startTimeUnixNano = unixNanos(options.startTimeMs ?? Date.now());
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
        endTimeUnixNano: unixNanos(result.endTimeMs ?? Date.now()),
        attributes: encodeAttributes({ ...options.attributes, ...result.attributes }),
        status: encodeStatus(result.status),
      });
    },
  };
}

function newTraceId(): TraceId {
  // oxlint-disable-next-line typescript/consistent-type-assertions, typescript/no-unsafe-type-assertion
  return randomHex(TRACE_ID_BYTES) as TraceId;
}

function newSpanId(): SpanId {
  // oxlint-disable-next-line typescript/consistent-type-assertions, typescript/no-unsafe-type-assertion
  return randomHex(SPAN_ID_BYTES) as SpanId;
}

function encodeStatus(status: SpanStatus | undefined): otlp.Status | undefined {
  if (status === undefined) {
    return undefined;
  }
  return { code: STATUS_CODE[status.code], message: status.message };
}
