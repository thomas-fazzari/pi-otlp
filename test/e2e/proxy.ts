// SPDX-FileCopyrightText: 2026 Thomas Fazzari
// SPDX-License-Identifier: MIT

import type * as otlp from "../../src/otlp.ts";

const NANOS_PER_MS = 1_000_000n;
const MS_PER_SECOND = 1000;

export type CollectorMode = "accept" | "refuse" | "ingest-then-refuse";

export interface Proxy {
  url: string;
  setMode: (mode: CollectorMode) => void;
  lastForwardedMetricsSeconds: () => number;
  traceIds: () => string[];
  stop: () => Promise<void>;
}

function latestPointSeconds(body: otlp.ExportMetricsServiceRequest): number {
  let latestNanos = 0n;
  for (const resource of body.resourceMetrics) {
    for (const scope of resource.scopeMetrics) {
      for (const metric of scope.metrics) {
        const points = "sum" in metric ? metric.sum.dataPoints : metric.histogram.dataPoints;
        for (const point of points) {
          const nanos = BigInt(point.timeUnixNano);
          if (nanos > latestNanos) {
            latestNanos = nanos;
          }
        }
      }
    }
  }
  return Number(latestNanos / NANOS_PER_MS) / MS_PER_SECOND;
}

function requestTraceIds(body: otlp.ExportTraceServiceRequest): string[] {
  return body.resourceSpans
    .flatMap((resource) => resource.scopeSpans)
    .flatMap((scope) => scope.spans)
    .map((span) => span.traceId);
}

// Forwards OTLP requests to otel-lgtm, or fails them on demand
export function startProxy(otlpUrl: string): Proxy {
  let mode: CollectorMode = "accept";
  let lastForwardedMetricsSeconds = 0;
  const traceIds = new Set<string>();
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(request) {
      const path = new URL(request.url).pathname;
      if (mode === "refuse") {
        return new Response(null, { status: 503 });
      }
      const body = await request.text();
      if (path === "/v1/metrics") {
        lastForwardedMetricsSeconds = latestPointSeconds(JSON.parse(body));
      }
      const upstream = await fetch(`${otlpUrl}${path}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
      });
      if (path === "/v1/traces" && upstream.ok) {
        for (const id of requestTraceIds(JSON.parse(body))) {
          traceIds.add(id);
        }
      }
      if (mode === "ingest-then-refuse" && path === "/v1/metrics") {
        mode = "accept";
        return new Response(null, { status: 503 });
      }
      return new Response(await upstream.arrayBuffer(), { status: upstream.status });
    },
  });
  return {
    url: `http://127.0.0.1:${server.port}`,
    setMode: (next) => {
      mode = next;
    },
    lastForwardedMetricsSeconds: () => lastForwardedMetricsSeconds,
    traceIds: () => [...traceIds],
    stop: () => server.stop(true),
  };
}
