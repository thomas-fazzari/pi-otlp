// SPDX-FileCopyrightText: 2026 Thomas Fazzari
// SPDX-License-Identifier: MIT

import { VERSION } from "@earendil-works/pi-coding-agent";
import { afterEach, expect, setSystemTime, test } from "bun:test";
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
import { createTelemetryCore } from "../src/telemetry.ts";
import {
  Collector,
  configure,
  latestPoints,
  metric,
  resetConfig,
  unusedPort,
} from "./collector.ts";

const NANOS = expect.stringMatching(/^\d{19}$/u);
const UUID = expect.stringMatching(/^[0-9a-f-]{36}$/u);

let collector: Collector | undefined;

function startCollector(port?: number): Collector {
  collector = new Collector(port);
  return collector;
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

function sums(body: otlp.ExportMetricsServiceRequest | undefined, name: string): number[] {
  const points: any[] = metric(body, name).sum.dataPoints;
  return points.map((point) => point.asDouble);
}

function numbered(prefix: string, from: number, count: number): string[] {
  return Array.from({ length: count }, (_, k) => `${prefix}-${from + k}`);
}

afterEach(async () => {
  resetConfig();
  await collector?.stop();
  collector = undefined;
});

test("encodes metrics, spans and logs as OTLP JSON", async () => {
  const receiver = startCollector();
  configure(receiver.url);
  const { telemetry, flush } = createTelemetryCore();

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
    eventName: "test.event",
    severity: "warn",
    body: "hello",
    attributes: { ratio: 0.5 },
    context: child.context,
  });
  await flush();

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
                        asDouble: 0,
                      },
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
                        count: "0",
                        sum: 0,
                        min: undefined,
                        max: undefined,
                        bucketCounts: ["0", "0", "0"],
                        explicitBounds: [1, 2],
                      },
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
                  eventName: "test.event",
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
  configure(receiver.url);
  const { telemetry, flush } = createTelemetryCore();
  const tokens = telemetry.counter("tokens");
  const latency = telemetry.histogram("latency", { boundaries: [1, 5] });

  tokens.add(10);
  for (const value of [0.5, 1, 3, 9]) {
    latency.record(value);
  }
  await flush();
  tokens.add(5);
  latency.record(7);
  await flush();

  const first = receiver.bodies("/v1/metrics").at(0);
  const last = receiver.bodies("/v1/metrics").at(-1);
  expect(latestPoints(metric(first, "tokens").sum.dataPoints)).toMatchObject([{ asDouble: 10 }]);
  expect(latestPoints(metric(first, "latency").histogram.dataPoints)).toMatchObject([
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
  const { telemetry, flush } = createTelemetryCore();
  const counter = telemetry.counter("typed");

  counter.add(1, { a: 1, b: true });
  counter.add(1, { b: true, a: 1 });
  for (const a of ["1", Number.NaN, Infinity, -Infinity]) {
    counter.add(1, { a, b: true });
  }
  await flush();

  const dataPoints = latestPoints(
    metric(receiver.bodies("/v1/metrics").at(0), "typed").sum.dataPoints,
  );
  expect(dataPoints).toHaveLength(5);
  expect(dataPoints[0]).toMatchObject({ asDouble: 2 });
});

test("routes measurements beyond 1999 series to the overflow series", async () => {
  const receiver = startCollector();
  configure(receiver.url);
  const { telemetry, flush } = createTelemetryCore();
  const counter = telemetry.counter("capped");

  for (let i = 0; i < 2001; i++) {
    counter.add(1, { i });
  }
  counter.add(1, { i: 0 });
  await flush();

  const dataPoints = latestPoints(
    metric(receiver.bodies("/v1/metrics").at(0), "capped").sum.dataPoints,
  );
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
  configure(`http://127.0.0.1:${port}`);
  const { telemetry, flush } = createTelemetryCore();
  const emit = (from: number, to: number) => {
    for (let i = from; i < to; i++) {
      telemetry.startSpan(`span-${i}`).end();
      telemetry.emitLog({ eventName: "test.event", severity: "info", body: `log-${i}` });
    }
  };

  emit(0, 2100);
  await flush();
  const receiver = startCollector(port);
  receiver.mode = "unavailable";
  await flush();
  emit(2100, 2110);
  receiver.mode = "ok";
  await flush();

  expect(spanNames(receiver.bodies("/v1/traces").at(-1))).toEqual(numbered("span", 62, 2048));
  const last = receiver.bodies("/v1/metrics").at(-1);
  const points = (name: string) => latestPoints(metric(last, name).sum.dataPoints);
  expect(points(METRIC_OTEL_SDK_EXPORTER_SPAN_EXPORTED)).toMatchObject([
    {
      attributes: [component(OTEL_COMPONENT_TYPE_VALUE_OTLP_HTTP_JSON_SPAN_EXPORTER)],
      asDouble: 2048,
    },
  ]);
  expect(points(METRIC_OTEL_SDK_PROCESSOR_SPAN_PROCESSED)).toMatchObject([
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
  const { telemetry, flush } = createTelemetryCore();

  for (let i = 0; i < 3; i++) {
    telemetry.startSpan(`span-${i}`).end();
  }
  await flush();
  receiver.mode = "reject";
  for (let i = 0; i < 2050; i++) {
    telemetry.emitLog({ eventName: "test.event", severity: "info", body: `log-${i}` });
  }
  await flush();

  const last = receiver.bodies("/v1/metrics").at(-1);
  const points = (name: string) => latestPoints(metric(last, name).sum.dataPoints);
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

test("dates the zero start point before the current point, even within the same millisecond", async () => {
  const receiver = startCollector();
  configure(receiver.url);
  const { telemetry, flush } = createTelemetryCore();

  setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
  try {
    telemetry.counter("instant").add(1);
    telemetry.histogram("instant-histogram", { boundaries: [1] }).record(0.5);
    await flush();
  } finally {
    setSystemTime();
  }

  const body = receiver.bodies("/v1/metrics").at(0);
  const points = [
    metric(body, "instant").sum.dataPoints,
    metric(body, "instant-histogram").histogram.dataPoints,
  ];
  for (const [zero, current] of points) {
    expect(BigInt(zero.timeUnixNano)).toBeLessThan(BigInt(current.timeUnixNano));
  }
});

test("keeps the zero start point of a series created while an export is in flight", async () => {
  const receiver = startCollector();
  configure(receiver.url);
  const { telemetry, flush } = createTelemetryCore();
  telemetry.counter("early").add(1);

  receiver.mode = "slow";
  const inFlight = flush();
  await receiver.waitFor("/v1/metrics");
  telemetry.counter("during").add(1);
  await inFlight;
  receiver.mode = "ok";
  await flush();

  const second = receiver.bodies("/v1/metrics").at(1);
  expect(sums(second, "early")).toEqual([1]);
  expect(sums(second, "during")).toEqual([0, 1]);
});

test("prefixes each series with a zero start point until an export containing it gets a final answer", async () => {
  const receiver = startCollector();
  configure(receiver.url);
  const { telemetry, flush } = createTelemetryCore();
  const counter = telemetry.counter("calls");
  const delays = telemetry.histogram("delays", { boundaries: [1] });

  receiver.mode = "unavailable";
  counter.add(3);
  delays.record(0.5);
  await flush();
  receiver.mode = "ok";
  counter.add(1);
  await flush();
  counter.add(1);
  telemetry.counter("late").add(2);
  receiver.mode = "reject";
  await flush();
  receiver.mode = "ok";
  await flush();

  const bodies = receiver.bodies("/v1/metrics");
  expect(sums(bodies[0], "calls")).toEqual([0, 3]);
  expect(sums(bodies[1], "calls")).toEqual([0, 4]);
  expect(sums(bodies[2], "calls")).toEqual([5]);
  expect(sums(bodies[2], "late")).toEqual([0, 2]);
  expect(sums(bodies[3], "late")).toEqual([2]);
  const [zero, current] = metric(bodies[1], "delays").histogram.dataPoints;
  expect(zero).toMatchObject({ count: "0", sum: 0, bucketCounts: ["0", "0"] });
  expect(zero.timeUnixNano).toBe(zero.startTimeUnixNano);
  expect(current.startTimeUnixNano).toBe(zero.startTimeUnixNano);
  expect(metric(bodies[2], "delays").histogram.dataPoints).toMatchObject([{ count: "1" }]);
});

test("gives up the final flush after about 1.5 s when the collector never answers", async () => {
  const receiver = startCollector();
  receiver.mode = "hang";
  configure(receiver.url);
  const { telemetry, flush } = createTelemetryCore();
  telemetry.startSpan("stuck").end();

  const started = performance.now();
  await flush();
  const elapsed = performance.now() - started;

  expect(elapsed).toBeGreaterThanOrEqual(1450);
  expect(elapsed).toBeLessThan(2000);
});
