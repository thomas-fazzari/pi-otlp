// SPDX-FileCopyrightText: 2026 Thomas Fazzari
// SPDX-License-Identifier: MIT

import type * as otlp from "../src/otlp.ts";

const RESPONSE_DELAY_MS = 100;
const NEVER_MS = 60_000;
const ENV_KEYS = [
  "OTEL_EXPORTER_OTLP_ENDPOINT",
  "OTEL_METRIC_EXPORT_INTERVAL",
  "OTEL_BSP_SCHEDULE_DELAY",
  "OTEL_BLRP_SCHEDULE_DELAY",
];

interface ReceivedRequest {
  path: string;
  contentType: string | null;
  body: any;
}

// Local stand-in for the OTLP/HTTP receiver of a collector.
export class Collector {
  readonly requests: ReceivedRequest[] = [];
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

  bodies(path: string): any[] {
    return this.requests.filter((request) => request.path === path).map((request) => request.body);
  }

  async waitFor(path: string, count = 1): Promise<void> {
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
    this.requests.push({
      path,
      contentType: request.headers.get("content-type"),
      body: await request.json(),
    });
    if (this.mode === "hang") {
      return new Promise<Response>(() => {});
    }
    if (this.mode === "reject") {
      return new Response(null, { status: 400 });
    }
    if (this.mode === "slow") {
      await Bun.sleep(RESPONSE_DELAY_MS);
      return Response.json({});
    }
    if (this.mode === "unavailable") {
      await Bun.sleep(RESPONSE_DELAY_MS);
      return new Response(null, { status: 503 });
    }
    return Response.json({});
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

export function metric(body: otlp.ExportMetricsServiceRequest | undefined, name: string): any {
  return body?.resourceMetrics[0]?.scopeMetrics[0]?.metrics.find(
    (candidate) => candidate.name === name,
  );
}

export function latestPoints(dataPoints: any[]): any[] {
  const bySeries = new Map<string, any>();
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
