// SPDX-FileCopyrightText: 2026 Thomas Fazzari
// SPDX-License-Identifier: MIT

import { match } from "ts-pattern";
import type * as otlp from "../src/otlp.ts";

const RESPONSE_DELAY_MS = 100;
const NEVER_MS = 60_000;
const ENV_KEYS = [
  "OTEL_EXPORTER_OTLP_ENDPOINT",
  "OTEL_METRIC_EXPORT_INTERVAL",
  "OTEL_BSP_SCHEDULE_DELAY",
  "OTEL_BLRP_SCHEDULE_DELAY",
];

interface Bodies {
  "/v1/metrics": otlp.ExportMetricsServiceRequest;
  "/v1/traces": otlp.ExportTraceServiceRequest;
  "/v1/logs": otlp.ExportLogsServiceRequest;
}

type SignalPath = keyof Bodies;

export type SumPoint = Extract<otlp.Metric, { sum: unknown }>["sum"]["dataPoints"][number];
export type HistogramPoint = otlp.HistogramDataPoint;

interface ReceivedRequest {
  path: string;
  contentType: string | null;
}

// Local stand-in for the OTLP/HTTP receiver of a collector.
export class Collector {
  readonly requests: ReceivedRequest[] = [];
  readonly #bodies: { [P in SignalPath]: Bodies[P][] } = {
    "/v1/metrics": [],
    "/v1/traces": [],
    "/v1/logs": [],
  };
  mode: "ok" | "slow" | "reject" | "unavailable" | "hang" = "ok";
  readonly #server: ReturnType<typeof Bun.serve>;

  constructor(port = 0) {
    this.#server = Bun.serve({
      port,
      hostname: "127.0.0.1",
      fetch: async (request) => this.#receive(request),
    });
  }

  get url(): string {
    return `http://127.0.0.1:${this.#server.port}`;
  }

  bodies<P extends SignalPath>(path: P): Bodies[P][] {
    return this.#bodies[path];
  }

  async waitFor(path: SignalPath, count = 1): Promise<void> {
    const deadline = performance.now() + 3000;
    while (this.bodies(path).length < count) {
      if (performance.now() > deadline) {
        throw new Error(`timed out waiting for ${count} requests to ${path}`);
      }
      await Bun.sleep(10);
    }
  }

  async stop(): Promise<void> {
    await this.#server.stop(true);
  }

  async #receive(request: Request): Promise<Response> {
    const path = new URL(request.url).pathname;
    this.requests.push({ path, contentType: request.headers.get("content-type") });
    if (!isSignalPath(path)) {
      return new Response(null, { status: 404 });
    }
    this.#bodies[path].push(JSON.parse(await request.text()));
    return match(this.mode)
      .returnType<Promise<Response>>()
      .with("ok", async () => Response.json({}))
      .with("hang", () => new Promise<Response>(() => {}))
      .with("reject", async () => new Response(null, { status: 400 }))
      .with("slow", async () => {
        await Bun.sleep(RESPONSE_DELAY_MS);
        return Response.json({});
      })
      .with("unavailable", async () => {
        await Bun.sleep(RESPONSE_DELAY_MS);
        return new Response(null, { status: 503 });
      })
      .exhaustive();
  }
}

export function configure(
  endpoint: string,
  intervals: { metrics?: number; spans?: number; logs?: number } = {},
): void {
  process.env["OTEL_EXPORTER_OTLP_ENDPOINT"] = endpoint;
  process.env["OTEL_METRIC_EXPORT_INTERVAL"] = String(intervals.metrics ?? NEVER_MS);
  process.env["OTEL_BSP_SCHEDULE_DELAY"] = String(intervals.spans ?? NEVER_MS);
  process.env["OTEL_BLRP_SCHEDULE_DELAY"] = String(intervals.logs ?? NEVER_MS);
}

export function resetConfig(): void {
  for (const key of ENV_KEYS) {
    delete process.env[key];
  }
}

function isSignalPath(path: string): path is SignalPath {
  return path === "/v1/metrics" || path === "/v1/traces" || path === "/v1/logs";
}

function metric(
  body: otlp.ExportMetricsServiceRequest | undefined,
  name: string,
): otlp.Metric | undefined {
  return body?.resourceMetrics[0]?.scopeMetrics[0]?.metrics.find(
    (candidate) => candidate.name === name,
  );
}

export function sumPoints(
  body: otlp.ExportMetricsServiceRequest | undefined,
  name: string,
): SumPoint[] {
  const found = metric(body, name);
  if (found === undefined) {
    return [];
  }
  if (!("sum" in found)) {
    throw new Error(`${name} is not a sum`);
  }
  return found.sum.dataPoints;
}

export function histogramPoints(
  body: otlp.ExportMetricsServiceRequest | undefined,
  name: string,
): HistogramPoint[] {
  const found = metric(body, name);
  if (found === undefined) {
    return [];
  }
  if (!("histogram" in found)) {
    throw new Error(`${name} is not a histogram`);
  }
  return found.histogram.dataPoints;
}

export function latestPoints<T extends { attributes: otlp.KeyValue[] }>(dataPoints: T[]): T[] {
  const bySeries = new Map<string, T>();
  for (const point of dataPoints) {
    bySeries.set(JSON.stringify(point.attributes), point);
  }
  return [...bySeries.values()];
}

export async function unusedPort(): Promise<number> {
  const probe = Bun.serve({ port: 0, fetch: () => new Response() });
  const port = probe.port;
  await probe.stop(true);
  if (port === undefined) {
    throw new Error("the probe server has no TCP port");
  }
  return port;
}
