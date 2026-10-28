// SPDX-FileCopyrightText: 2026 Thomas Fazzari
// SPDX-License-Identifier: MIT

// The subset of OTLP/HTTP JSON that pi-otlp sends. JSON.stringify leaves out fields set to undefined.

export const AGGREGATION_TEMPORALITY_CUMULATIVE = 2;
export const SPAN_KIND = { internal: 1, client: 3 } as const;
export const STATUS_CODE = { ok: 1, error: 2 } as const;
export const SEVERITY_NUMBER = { info: 9, warn: 13, error: 17 } as const;

// proto3 JSON writes 64-bit integers as decimal strings.
export type Int64 = `${bigint}`;
export type Double = number | "NaN" | "Infinity" | "-Infinity";

export type AnyValue =
  | { stringValue: string }
  | { boolValue: boolean }
  | { intValue: Int64 }
  | { doubleValue: Double };

export function toInt64(value: number): Int64 {
  return `${BigInt(value)}`;
}

export interface KeyValue {
  key: string;
  value: AnyValue;
}

export interface Resource {
  attributes: KeyValue[];
}

export interface InstrumentationScope {
  name: string;
}

interface DataPointBase {
  attributes: KeyValue[];
  startTimeUnixNano: Int64;
  timeUnixNano: Int64;
}

interface NumberDataPoint extends DataPointBase {
  asDouble: number;
}

export interface HistogramDataPoint extends DataPointBase {
  count: Int64;
  sum: number;
  min: number | undefined;
  max: number | undefined;
  bucketCounts: Int64[];
  explicitBounds: readonly number[];
}

interface MetricBase {
  name: string;
  unit: string | undefined;
  description: string | undefined;
}

interface SumMetric extends MetricBase {
  sum: {
    aggregationTemporality: typeof AGGREGATION_TEMPORALITY_CUMULATIVE;
    isMonotonic: true;
    dataPoints: NumberDataPoint[];
  };
}

interface HistogramMetric extends MetricBase {
  histogram: {
    aggregationTemporality: typeof AGGREGATION_TEMPORALITY_CUMULATIVE;
    dataPoints: HistogramDataPoint[];
  };
}

export type Metric = SumMetric | HistogramMetric;

export interface Status {
  code: (typeof STATUS_CODE)[keyof typeof STATUS_CODE];
  message: string | undefined;
}

export interface Span {
  traceId: string;
  spanId: string;
  parentSpanId: string | undefined;
  name: string;
  kind: (typeof SPAN_KIND)[keyof typeof SPAN_KIND];
  startTimeUnixNano: Int64;
  endTimeUnixNano: Int64;
  attributes: KeyValue[];
  status: Status | undefined;
}

export interface LogRecord {
  timeUnixNano: Int64;
  observedTimeUnixNano: Int64;
  severityNumber: (typeof SEVERITY_NUMBER)[keyof typeof SEVERITY_NUMBER];
  severityText: string;
  body: AnyValue;
  attributes: KeyValue[];
  traceId: string | undefined;
  spanId: string | undefined;
}

export interface ExportMetricsServiceRequest {
  resourceMetrics: {
    resource: Resource;
    scopeMetrics: { scope: InstrumentationScope; metrics: Metric[] }[];
  }[];
}

export interface ExportTraceServiceRequest {
  resourceSpans: {
    resource: Resource;
    scopeSpans: { scope: InstrumentationScope; spans: Span[] }[];
  }[];
}

export interface ExportLogsServiceRequest {
  resourceLogs: {
    resource: Resource;
    scopeLogs: { scope: InstrumentationScope; logRecords: LogRecord[] }[];
  }[];
}

export type ExportRequest =
  | ExportMetricsServiceRequest
  | ExportTraceServiceRequest
  | ExportLogsServiceRequest;
