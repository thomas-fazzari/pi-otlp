// SPDX-FileCopyrightText: 2026 Thomas Fazzari
// SPDX-License-Identifier: MIT

import { VERSION } from "@earendil-works/pi-coding-agent";
import { encodeAttributes } from "./attributes.ts";
import { readConfig } from "./config.ts";
import { ExportLoop, post, RecordQueue } from "./export.ts";
import type { DeliveryReport } from "./export.ts";
import { encodeLogRecord } from "./logs.ts";
import type { LogRecord } from "./logs.ts";
import { Meter } from "./metrics.ts";
import type { Counter, Histogram, HistogramOptions, InstrumentOptions } from "./metrics.ts";
import type * as otlp from "./otlp.ts";
import {
  ATTR_ERROR_TYPE,
  ATTR_OTEL_COMPONENT_TYPE,
  ATTR_SERVICE_INSTANCE_ID,
  ATTR_SERVICE_NAME,
  ATTR_SERVICE_VERSION,
  METRIC_OTEL_SDK_EXPORTER_LOG_EXPORTED,
  METRIC_OTEL_SDK_EXPORTER_METRIC_DATA_POINT_EXPORTED,
  METRIC_OTEL_SDK_EXPORTER_SPAN_EXPORTED,
  METRIC_OTEL_SDK_PROCESSOR_LOG_PROCESSED,
  METRIC_OTEL_SDK_PROCESSOR_SPAN_PROCESSED,
  OTEL_COMPONENT_TYPE_VALUE_BATCHING_LOG_PROCESSOR,
  OTEL_COMPONENT_TYPE_VALUE_BATCHING_SPAN_PROCESSOR,
  OTEL_COMPONENT_TYPE_VALUE_OTLP_HTTP_JSON_LOG_EXPORTER,
  OTEL_COMPONENT_TYPE_VALUE_OTLP_HTTP_JSON_METRIC_EXPORTER,
  OTEL_COMPONENT_TYPE_VALUE_OTLP_HTTP_JSON_SPAN_EXPORTER,
} from "./semconv.ts";
import { startSpan } from "./traces.ts";
import type { Span, SpanOptions } from "./traces.ts";
import { raceAbort } from "./utils/abort.ts";

const EXPORT_TIMEOUT_MS = 10_000;
const FINAL_FLUSH_MS = 1500;
const SERVICE_NAME = "pi";
const SCOPE: otlp.InstrumentationScope = { name: "pi-otlp" };
const SHARED_KEY = Symbol.for("pi-otlp");
// Batching processors must report records dropped by a full queue with this error type.
const ERROR_TYPE_QUEUE_FULL = "queue_full";

interface Pipeline {
  unit: string;
  exportedMetric: string;
  processedMetric: string;
  exporterType: string;
  processorType: string;
}

const SPAN_PIPELINE: Pipeline = {
  unit: "{span}",
  exportedMetric: METRIC_OTEL_SDK_EXPORTER_SPAN_EXPORTED,
  processedMetric: METRIC_OTEL_SDK_PROCESSOR_SPAN_PROCESSED,
  exporterType: OTEL_COMPONENT_TYPE_VALUE_OTLP_HTTP_JSON_SPAN_EXPORTER,
  processorType: OTEL_COMPONENT_TYPE_VALUE_BATCHING_SPAN_PROCESSOR,
};
const LOG_PIPELINE: Pipeline = {
  unit: "{log_record}",
  exportedMetric: METRIC_OTEL_SDK_EXPORTER_LOG_EXPORTED,
  processedMetric: METRIC_OTEL_SDK_PROCESSOR_LOG_PROCESSED,
  exporterType: OTEL_COMPONENT_TYPE_VALUE_OTLP_HTTP_JSON_LOG_EXPORTER,
  processorType: OTEL_COMPONENT_TYPE_VALUE_BATCHING_LOG_PROCESSOR,
};

interface Telemetry {
  counter(name: string, options?: InstrumentOptions): Counter;
  histogram(name: string, options: HistogramOptions): Histogram;
  startSpan(name: string, options?: SpanOptions): Span;
  emitLog(record: LogRecord): void;
}

interface Core {
  telemetry: Telemetry;
  flush(): Promise<void>;
  shutdown(): Promise<void>;
}

interface Shared {
  instanceId: string;
  refs: number;
  core: Core | undefined;
}

// Pi evaluates this module again on /reload, so the process-wide core lives on globalThis.
function shared(): Shared {
  // The index signature lets TypeScript accept globalThis, which declares no slot for this symbol.
  const store: { [SHARED_KEY]?: Shared; [key: string]: unknown } = globalThis;
  store[SHARED_KEY] ??= { instanceId: crypto.randomUUID(), refs: 0, core: undefined };
  return store[SHARED_KEY];
}

export function acquireTelemetry(): Telemetry {
  const state = shared();
  state.core ??= createCore(state.instanceId);
  state.refs++;
  return state.core.telemetry;
}

export async function releaseTelemetry(): Promise<void> {
  const state = shared();
  if (state.refs === 0) {
    return;
  }
  state.refs--;
  const core = state.core;
  if (state.refs > 0 || core === undefined) {
    return;
  }
  state.core = undefined;
  await core.shutdown();
}

export async function flushTelemetry(): Promise<void> {
  await shared().core?.flush();
}

function createCore(instanceId: string): Core {
  const config = readConfig();
  const resource: otlp.Resource = {
    attributes: encodeAttributes({
      [ATTR_SERVICE_NAME]: SERVICE_NAME,
      [ATTR_SERVICE_VERSION]: VERSION,
      [ATTR_SERVICE_INSTANCE_ID]: instanceId,
    }),
  };
  const meter = new Meter();
  const spans = new RecordQueue<otlp.Span>(
    `${config.endpoint}/v1/traces`,
    (records): otlp.ExportTraceServiceRequest => ({
      resourceSpans: [{ resource, scopeSpans: [{ scope: SCOPE, spans: records }] }],
    }),
    deliveryReport(meter, SPAN_PIPELINE),
  );
  const logs = new RecordQueue<otlp.LogRecord>(
    `${config.endpoint}/v1/logs`,
    (records): otlp.ExportLogsServiceRequest => ({
      resourceLogs: [{ resource, scopeLogs: [{ scope: SCOPE, logRecords: records }] }],
    }),
    deliveryReport(meter, LOG_PIPELINE),
  );
  const exportedDataPoints = meter.counter(METRIC_OTEL_SDK_EXPORTER_METRIC_DATA_POINT_EXPORTED, {
    unit: "{data_point}",
  });
  const metricExporter = {
    [ATTR_OTEL_COMPONENT_TYPE]: OTEL_COMPONENT_TYPE_VALUE_OTLP_HTTP_JSON_METRIC_EXPORTER,
  };
  const sendMetrics = async (signal: AbortSignal) => {
    const metrics = meter.collect();
    if (metrics.length === 0) {
      return;
    }
    const request: otlp.ExportMetricsServiceRequest = {
      resourceMetrics: [{ resource, scopeMetrics: [{ scope: SCOPE, metrics }] }],
    };
    const result = await post(`${config.endpoint}/v1/metrics`, request, signal);
    // Cumulative points are never queued again, since the next export carries their latest values.
    const failure = result.outcome === "sent" ? {} : { [ATTR_ERROR_TYPE]: result.errorType };
    exportedDataPoints.add(countDataPoints(metrics), { ...metricExporter, ...failure });
  };

  const metricsLoop = new ExportLoop(sendMetrics);
  const spansLoop = new ExportLoop((signal) => spans.send(signal));
  const logsLoop = new ExportLoop((signal) => logs.send(signal));
  const schedules = [
    { loop: metricsLoop, intervalMs: config.metricExportIntervalMs },
    { loop: spansLoop, intervalMs: config.spanScheduleDelayMs },
    { loop: logsLoop, intervalMs: config.logScheduleDelayMs },
  ];
  const timers = schedules.map(({ loop, intervalMs }) =>
    setInterval(() => void loop.run(AbortSignal.timeout(EXPORT_TIMEOUT_MS)), intervalMs).unref(),
  );

  const telemetry: Telemetry = {
    counter: (name, options) => meter.counter(name, options),
    histogram: (name, options) => meter.histogram(name, options),
    startSpan: (name, options = {}) => startSpan(name, options, (span) => spans.push(span)),
    emitLog: (record) => logs.push(encodeLogRecord(record)),
  };

  async function drainAll(deadline: AbortSignal): Promise<void> {
    await Promise.all([spansLoop.drain(deadline), logsLoop.drain(deadline)]);
    // Metrics go last so that they carry the span and log outcomes of this flush.
    await metricsLoop.drain(deadline);
  }

  async function flush(): Promise<void> {
    const deadline = AbortSignal.timeout(FINAL_FLUSH_MS);
    await raceAbort(drainAll(deadline), deadline);
  }

  async function shutdown(): Promise<void> {
    for (const timer of timers) {
      clearInterval(timer);
    }
    await flush();
  }

  return { telemetry, flush, shutdown };
}

function deliveryReport(meter: Meter, pipeline: Pipeline): DeliveryReport {
  const exported = meter.counter(pipeline.exportedMetric, { unit: pipeline.unit });
  const processed = meter.counter(pipeline.processedMetric, { unit: pipeline.unit });
  const exporter = { [ATTR_OTEL_COMPONENT_TYPE]: pipeline.exporterType };
  const processor = { [ATTR_OTEL_COMPONENT_TYPE]: pipeline.processorType };
  return {
    sent(count) {
      exported.add(count, exporter);
      processed.add(count, processor);
    },
    dropped(count, errorType) {
      exported.add(count, { ...exporter, [ATTR_ERROR_TYPE]: errorType });
      processed.add(count, { ...processor, [ATTR_ERROR_TYPE]: errorType });
    },
    ejected(count) {
      processed.add(count, { ...processor, [ATTR_ERROR_TYPE]: ERROR_TYPE_QUEUE_FULL });
    },
  };
}

function countDataPoints(metrics: otlp.Metric[]): number {
  let count = 0;
  for (const metric of metrics) {
    count += "sum" in metric ? metric.sum.dataPoints.length : metric.histogram.dataPoints.length;
  }
  return count;
}
