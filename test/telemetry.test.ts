// SPDX-FileCopyrightText: 2026 Thomas Fazzari
// SPDX-License-Identifier: MIT

import { VERSION } from "@earendil-works/pi-coding-agent";
import { afterEach, expect, test } from "bun:test";
import type * as otlp from "../src/otlp.ts";
import {
  ATTR_ERROR_TYPE,
  ATTR_OTEL_COMPONENT_TYPE,
  METRIC_OTEL_SDK_EXPORTER_LOG_EXPORTED,
  METRIC_OTEL_SDK_EXPORTER_SPAN_EXPORTED,
  METRIC_OTEL_SDK_PROCESSOR_LOG_PROCESSED,
  METRIC_OTEL_SDK_PROCESSOR_SPAN_PROCESSED,
  OTEL_COMPONENT_TYPE_VALUE_BATCHING_LOG_PROCESSOR,
  OTEL_COMPONENT_TYPE_VALUE_BATCHING_SPAN_PROCESSOR,
  OTEL_COMPONENT_TYPE_VALUE_OTLP_HTTP_JSON_LOG_EXPORTER,
  OTEL_COMPONENT_TYPE_VALUE_OTLP_HTTP_JSON_SPAN_EXPORTER,
} from "../src/semconv.ts";
import { acquireTelemetry, flushTelemetry, releaseTelemetry } from "../src/telemetry.ts";
import { Collector, unusedPort } from "./collector.ts";

const ENV_KEYS = [
  "OTEL_EXPORTER_OTLP_ENDPOINT",
  "OTEL_METRIC_EXPORT_INTERVAL",
  "OTEL_BSP_SCHEDULE_DELAY",
  "OTEL_BLRP_SCHEDULE_DELAY",
];
const NEVER_MS = 60_000;
const NANOS = expect.stringMatching(/^\d{19}$/u);
const UUID = expect.stringMatching(/^[0-9a-f-]{36}$/u);

let collector: Collector | undefined;

function configure(
  endpoint: string,
  intervals: { metrics?: number; spans?: number; logs?: number } = {},
): void {
  process.env["OTEL_EXPORTER_OTLP_ENDPOINT"] = endpoint;
  process.env["OTEL_METRIC_EXPORT_INTERVAL"] = String(intervals.metrics ?? NEVER_MS);
  process.env["OTEL_BSP_SCHEDULE_DELAY"] = String(intervals.spans ?? NEVER_MS);
  process.env["OTEL_BLRP_SCHEDULE_DELAY"] = String(intervals.logs ?? NEVER_MS);
}

function startCollector(port?: number): Collector {
  collector = new Collector(port);
  return collector;
}

function metric(body: otlp.ExportMetricsServiceRequest | undefined, name: string): any {
  return body?.resourceMetrics[0]?.scopeMetrics[0]?.metrics.find(
    (candidate) => candidate.name === name,
  );
}

function spanNames(body: otlp.ExportTraceServiceRequest | undefined): string[] {
  return body?.resourceSpans[0]?.scopeSpans[0]?.spans.map((span) => span.name) ?? [];
}

function logBodies(bodies: otlp.ExportLogsServiceRequest[]): unknown[] {
  return bodies.flatMap(
    (body) => body.resourceLogs[0]?.scopeLogs[0]?.logRecords.map((log) => log.body) ?? [],
  );
}

function component(type: string): otlp.KeyValue {
  return { key: ATTR_OTEL_COMPONENT_TYPE, value: { stringValue: type } };
}

function error(type: string): otlp.KeyValue {
  return { key: ATTR_ERROR_TYPE, value: { stringValue: type } };
}

function numbered(prefix: string, from: number, count: number): string[] {
  return Array.from({ length: count }, (_, k) => `${prefix}-${from + k}`);
}

afterEach(async () => {
  for (const key of ENV_KEYS) {
    delete process.env[key];
  }
  await collector?.stop();
  collector = undefined;
});

test("encodes metrics, spans and logs as OTLP JSON", async () => {
  const receiver = startCollector();
  configure(receiver.url);
  const telemetry = acquireTelemetry();

  telemetry.counter("requests", { unit: "{request}" }).add(2, { retry: false, model: "m" });
  telemetry.histogram("duration", { unit: "s", boundaries: [1, 2] }).record(1.5);
  const parent = telemetry.startSpan("parent");
  const child = telemetry.startSpan("child", {
    kind: "client",
    parent: parent.context,
    attributes: { attempt: 1 },
  });
  child.end({ status: { code: "error", message: "boom" } });
  parent.end();
  telemetry.emitLog({
    severity: "warn",
    body: "hello",
    attributes: { ratio: 0.5 },
    context: child.context,
  });
  await releaseTelemetry();

  expect(parent.context.traceId).toMatch(/^[0-9a-f]{32}$/u);
  expect(child.context.spanId).toMatch(/^[0-9a-f]{16}$/u);
  expect(receiver.requests.map((request) => request.contentType)).toEqual(
    Array(3).fill("application/json"),
  );
  const resource: otlp.Resource = {
    attributes: [
      { key: "service.name", value: { stringValue: "pi" } },
      { key: "service.version", value: { stringValue: VERSION } },
      { key: "service.instance.id", value: { stringValue: UUID } },
    ],
  };
  const scope = { name: "pi-otlp" };

  expect(receiver.bodies("/v1/metrics")).toEqual([
    {
      resourceMetrics: [
        {
          resource,
          scopeMetrics: [
            {
              scope,
              metrics: expect.arrayContaining([
                {
                  name: "requests",
                  unit: "{request}",
                  description: undefined,
                  sum: {
                    aggregationTemporality: 2,
                    isMonotonic: true,
                    dataPoints: [
                      {
                        attributes: [
                          { key: "retry", value: { boolValue: false } },
                          { key: "model", value: { stringValue: "m" } },
                        ],
                        startTimeUnixNano: NANOS,
                        timeUnixNano: NANOS,
                        asDouble: 2,
                      },
                    ],
                  },
                } satisfies otlp.Metric,
                {
                  name: "duration",
                  unit: "s",
                  description: undefined,
                  histogram: {
                    aggregationTemporality: 2,
                    dataPoints: [
                      {
                        attributes: [],
                        startTimeUnixNano: NANOS,
                        timeUnixNano: NANOS,
                        count: "1",
                        sum: 1.5,
                        min: 1.5,
                        max: 1.5,
                        bucketCounts: ["0", "1", "0"],
                        explicitBounds: [1, 2],
                      },
                    ],
                  },
                } satisfies otlp.Metric,
              ]),
            },
          ],
        },
      ],
    } satisfies otlp.ExportMetricsServiceRequest,
  ]);

  expect(receiver.bodies("/v1/traces")).toEqual([
    {
      resourceSpans: [
        {
          resource,
          scopeSpans: [
            {
              scope,
              spans: [
                {
                  traceId: parent.context.traceId,
                  spanId: child.context.spanId,
                  parentSpanId: parent.context.spanId,
                  name: "child",
                  kind: 3,
                  startTimeUnixNano: NANOS,
                  endTimeUnixNano: NANOS,
                  attributes: [{ key: "attempt", value: { intValue: "1" } }],
                  status: { code: 2, message: "boom" },
                },
                {
                  traceId: parent.context.traceId,
                  spanId: parent.context.spanId,
                  parentSpanId: undefined,
                  name: "parent",
                  kind: 1,
                  startTimeUnixNano: NANOS,
                  endTimeUnixNano: NANOS,
                  attributes: [],
                  status: undefined,
                },
              ],
            },
          ],
        },
      ],
    } satisfies otlp.ExportTraceServiceRequest,
  ]);

  expect(receiver.bodies("/v1/logs")).toEqual([
    {
      resourceLogs: [
        {
          resource,
          scopeLogs: [
            {
              scope,
              logRecords: [
                {
                  timeUnixNano: NANOS,
                  observedTimeUnixNano: NANOS,
                  severityNumber: 13,
                  severityText: "WARN",
                  body: { stringValue: "hello" },
                  attributes: [{ key: "ratio", value: { doubleValue: 0.5 } }],
                  traceId: parent.context.traceId,
                  spanId: child.context.spanId,
                },
              ],
            },
          ],
        },
      ],
    } satisfies otlp.ExportLogsServiceRequest,
  ]);
});

test("keeps histogram buckets and sums cumulative across exports", async () => {
  const receiver = startCollector();
  configure(receiver.url, { metrics: 50 });
  const telemetry = acquireTelemetry();
  const tokens = telemetry.counter("tokens");
  const latency = telemetry.histogram("latency", { boundaries: [1, 5] });

  tokens.add(10);
  for (const value of [0.5, 1, 3, 9]) {
    latency.record(value);
  }
  await receiver.waitFor("/v1/metrics");
  tokens.add(5);
  latency.record(7);
  await releaseTelemetry();

  const first = receiver.bodies("/v1/metrics").at(0);
  const last = receiver.bodies("/v1/metrics").at(-1);
  expect(metric(first, "tokens").sum.dataPoints).toMatchObject([{ asDouble: 10 }]);
  expect(metric(first, "latency").histogram.dataPoints).toMatchObject([
    { count: "4", sum: 13.5, min: 0.5, max: 9, bucketCounts: ["2", "1", "1"] },
  ]);
  expect(metric(last, "tokens").sum.dataPoints).toMatchObject([{ asDouble: 15 }]);
  expect(metric(last, "latency").histogram.dataPoints).toMatchObject([
    { count: "5", sum: 20.5, min: 0.5, max: 9, bucketCounts: ["2", "1", "2"] },
  ]);
  expect(metric(last, "tokens").sum.dataPoints[0].startTimeUnixNano).toBe(
    metric(first, "tokens").sum.dataPoints[0].startTimeUnixNano,
  );
});

test("keeps one series per attribute set, whatever the key order, and tells value types apart", async () => {
  const receiver = startCollector();
  configure(receiver.url);
  const counter = acquireTelemetry().counter("typed");

  counter.add(1, { a: 1, b: true });
  counter.add(1, { b: true, a: 1 });
  for (const a of ["1", Number.NaN, Infinity, -Infinity]) {
    counter.add(1, { a, b: true });
  }
  await releaseTelemetry();

  const dataPoints = metric(receiver.bodies("/v1/metrics").at(0), "typed").sum.dataPoints;
  expect(dataPoints).toHaveLength(5);
  expect(dataPoints[0]).toMatchObject({ asDouble: 2 });
});

test("routes measurements beyond 1999 series to the overflow series", async () => {
  const receiver = startCollector();
  configure(receiver.url);
  const counter = acquireTelemetry().counter("capped");

  for (let i = 0; i < 2001; i++) {
    counter.add(1, { i });
  }
  counter.add(1, { i: 0 });
  await releaseTelemetry();

  const dataPoints = metric(receiver.bodies("/v1/metrics").at(0), "capped").sum.dataPoints;
  expect(dataPoints).toHaveLength(2000);
  expect(dataPoints[0]).toMatchObject({
    attributes: [{ key: "i", value: { intValue: "0" } }],
    asDouble: 2,
  });
  expect(dataPoints[1999]).toMatchObject({
    attributes: [{ key: "otel.metric.overflow", value: { boolValue: true } }],
    asDouble: 2,
  });
});

test("keeps the newest 2048 spans and logs, failed batches first, until the collector accepts them", async () => {
  const port = await unusedPort();
  configure(`http://127.0.0.1:${port}`, { spans: 50, logs: 50 });
  const telemetry = acquireTelemetry();
  const emit = (from: number, to: number) => {
    for (let i = from; i < to; i++) {
      telemetry.startSpan(`span-${i}`).end();
      telemetry.emitLog({ severity: "info", body: `log-${i}` });
    }
  };

  emit(0, 2100);
  await Bun.sleep(200);
  const receiver = startCollector(port);
  receiver.mode = "unavailable";
  await receiver.waitFor("/v1/traces");
  await receiver.waitFor("/v1/logs");
  emit(2100, 2110);
  receiver.mode = "ok";
  await receiver.waitFor("/v1/traces", 2);
  await receiver.waitFor("/v1/logs", 2);
  await releaseTelemetry();

  expect(spanNames(receiver.bodies("/v1/traces").at(-1))).toEqual(numbered("span", 62, 2048));
  const last = receiver.bodies("/v1/metrics").at(-1);
  expect(metric(last, METRIC_OTEL_SDK_EXPORTER_SPAN_EXPORTED).sum.dataPoints).toMatchObject([
    {
      attributes: [component(OTEL_COMPONENT_TYPE_VALUE_OTLP_HTTP_JSON_SPAN_EXPORTER)],
      asDouble: 2048,
    },
  ]);
  expect(metric(last, METRIC_OTEL_SDK_PROCESSOR_SPAN_PROCESSED).sum.dataPoints).toMatchObject([
    {
      attributes: [
        component(OTEL_COMPONENT_TYPE_VALUE_BATCHING_SPAN_PROCESSOR),
        error("queue_full"),
      ],
      asDouble: 62,
    },
    { attributes: [component(OTEL_COMPONENT_TYPE_VALUE_BATCHING_SPAN_PROCESSOR)], asDouble: 2048 },
  ]);
  expect(logBodies(receiver.bodies("/v1/logs").slice(-1))).toEqual(
    numbered("log", 62, 2048).map((stringValue) => ({ stringValue })),
  );
});

test("counts every span and log once, at its final outcome", async () => {
  const receiver = startCollector();
  configure(receiver.url);
  const telemetry = acquireTelemetry();

  for (let i = 0; i < 3; i++) {
    telemetry.startSpan(`span-${i}`).end();
  }
  await flushTelemetry();
  receiver.mode = "reject";
  for (let i = 0; i < 2050; i++) {
    telemetry.emitLog({ severity: "info", body: `log-${i}` });
  }
  await releaseTelemetry();

  const last = receiver.bodies("/v1/metrics").at(-1);
  const points = (name: string) => metric(last, name).sum.dataPoints;
  expect(points(METRIC_OTEL_SDK_EXPORTER_SPAN_EXPORTED)).toMatchObject([
    {
      attributes: [component(OTEL_COMPONENT_TYPE_VALUE_OTLP_HTTP_JSON_SPAN_EXPORTER)],
      asDouble: 3,
    },
  ]);
  expect(points(METRIC_OTEL_SDK_PROCESSOR_SPAN_PROCESSED)).toMatchObject([
    { attributes: [component(OTEL_COMPONENT_TYPE_VALUE_BATCHING_SPAN_PROCESSOR)], asDouble: 3 },
  ]);
  expect(points(METRIC_OTEL_SDK_EXPORTER_LOG_EXPORTED)).toMatchObject([
    {
      attributes: [component(OTEL_COMPONENT_TYPE_VALUE_OTLP_HTTP_JSON_LOG_EXPORTER), error("400")],
      asDouble: 2048,
    },
  ]);
  expect(points(METRIC_OTEL_SDK_PROCESSOR_LOG_PROCESSED)).toMatchObject([
    {
      attributes: [
        component(OTEL_COMPONENT_TYPE_VALUE_BATCHING_LOG_PROCESSOR),
        error("queue_full"),
      ],
      asDouble: 2,
    },
    {
      attributes: [component(OTEL_COMPONENT_TYPE_VALUE_BATCHING_LOG_PROCESSOR), error("400")],
      asDouble: 2048,
    },
  ]);
});

test("keeps exporting until the last reference is released, which flushes", async () => {
  const receiver = startCollector();
  configure(receiver.url, { spans: 50 });
  const telemetry = acquireTelemetry();
  expect(acquireTelemetry()).toBe(telemetry);

  await releaseTelemetry();
  telemetry.startSpan("after-first-release").end();
  await receiver.waitFor("/v1/traces");
  telemetry.emitLog({ severity: "info", body: "final" });
  await releaseTelemetry();

  expect(logBodies(receiver.bodies("/v1/logs"))).toEqual([{ stringValue: "final" }]);
});

test("gives up the final flush after about 1.5 s when the collector never answers", async () => {
  const receiver = startCollector();
  receiver.mode = "hang";
  configure(receiver.url, { spans: 50 });
  acquireTelemetry().startSpan("stuck").end();
  await receiver.waitFor("/v1/traces");

  const started = performance.now();
  await releaseTelemetry();
  const elapsed = performance.now() - started;

  expect(elapsed).toBeGreaterThanOrEqual(1450);
  expect(elapsed).toBeLessThan(2000);
});
