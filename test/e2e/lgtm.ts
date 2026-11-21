// SPDX-FileCopyrightText: 2026 Thomas Fazzari
// SPDX-License-Identifier: MIT

import type * as otlp from "../../src/otlp.ts";
import type { TreeSpan } from "../span-tree.ts";

export const LGTM_IMAGE = process.env["LGTM_IMAGE"] ?? "";
const CONTAINER = `pi-otlp-e2e-${process.pid}`;
const LGTM_OTLP_PORT = "4318/tcp";
const LGTM_PROMETHEUS_PORT = "9090/tcp";
const LGTM_TEMPO_PORT = "3200/tcp";
const LGTM_LOKI_PORT = "3100/tcp";
const READY_TIMEOUT_MS = 120_000;
const READY_POLL_MS = 500;
const FETCH_TIMEOUT_MS = 5000;
const LOG_QUERY_LIMIT = 1000;
const NANOS_PER_SECOND = 1_000_000_000n;

export interface Lgtm {
  otlpUrl: string;
  prometheusUrl: string;
  tempoUrl: string;
  lokiUrl: string;
}

export interface PrometheusSeries {
  values?: [number, string][];
  value?: [number, string];
}

interface PrometheusResponse {
  status: string;
  data: { result: PrometheusSeries[] };
}

type TempoSpan = Omit<TreeSpan, "attributes"> & { attributes?: otlp.KeyValue[] };

interface TempoTrace {
  trace: { resourceSpans: { scopeSpans: { spans: TempoSpan[] }[] }[] };
}

export interface LokiStream {
  stream: Record<string, string>;
  values: [string, string][];
}

interface LokiResponse {
  data: { result: LokiStream[] };
}

async function run(command: string[]): Promise<string> {
  const proc = Bun.spawn(command, { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (code !== 0) {
    throw new Error(`${command.join(" ")} exited with ${code}: ${stderr}`);
  }
  return stdout;
}

async function getJson<T>(url: string): Promise<T> {
  const response = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  return JSON.parse(await response.text());
}

async function lgtmReady(lgtm: Lgtm): Promise<boolean> {
  const signal = AbortSignal.timeout(FETCH_TIMEOUT_MS);
  try {
    const responses = await Promise.all([
      fetch(`${lgtm.prometheusUrl}/-/ready`, { signal }),
      fetch(`${lgtm.tempoUrl}/ready`, { signal }),
      fetch(`${lgtm.lokiUrl}/ready`, { signal }),
      fetch(`${lgtm.otlpUrl}/v1/metrics`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ resourceMetrics: [] }),
        signal,
      }),
    ]);
    return responses.every((response) => response.ok);
  } catch {
    return false;
  }
}

async function hostUrl(containerPort: string): Promise<string> {
  const binding = (await run(["docker", "port", CONTAINER, containerPort])).split("\n")[0];
  return `http://${binding}`;
}

// A fresh container per scenario, on ports Docker picks, so Prometheus, Tempo and Loki hold only that scenario's data
export async function startLgtm(): Promise<Lgtm> {
  await removeLgtm();
  await run([
    "docker",
    "run",
    "-d",
    "--name",
    CONTAINER,
    "-p",
    `127.0.0.1::${LGTM_OTLP_PORT}`,
    "-p",
    `127.0.0.1::${LGTM_PROMETHEUS_PORT}`,
    "-p",
    `127.0.0.1::${LGTM_TEMPO_PORT}`,
    "-p",
    `127.0.0.1::${LGTM_LOKI_PORT}`,
    LGTM_IMAGE,
  ]);
  const [otlpUrl, prometheusUrl, tempoUrl, lokiUrl] = await Promise.all([
    hostUrl(LGTM_OTLP_PORT),
    hostUrl(LGTM_PROMETHEUS_PORT),
    hostUrl(LGTM_TEMPO_PORT),
    hostUrl(LGTM_LOKI_PORT),
  ]);
  const lgtm = { otlpUrl, prometheusUrl, tempoUrl, lokiUrl };
  const deadline = performance.now() + READY_TIMEOUT_MS;
  while (!(await lgtmReady(lgtm))) {
    if (performance.now() > deadline) {
      throw new Error(`${LGTM_IMAGE} was not ready after ${READY_TIMEOUT_MS} ms`);
    }
    await Bun.sleep(READY_POLL_MS);
  }
  return lgtm;
}

export async function removeLgtm(): Promise<void> {
  await run(["docker", "rm", "-f", CONTAINER]);
}

// For signal handlers, which cannot wait for a promise
export function removeLgtmSync(): void {
  Bun.spawnSync(["docker", "rm", "-f", CONTAINER]);
}

export async function prometheusQuery(
  prometheusUrl: string,
  promql: string,
  time?: number,
): Promise<PrometheusSeries[]> {
  const params = new URLSearchParams({ query: promql });
  if (time !== undefined) {
    params.set("time", String(time));
  }
  const json = await getJson<PrometheusResponse>(
    `${prometheusUrl}/api/v1/query?${params.toString()}`,
  );
  if (json.status !== "success") {
    throw new Error(`${promql}: ${JSON.stringify(json)}`);
  }
  return json.data.result;
}

// Spans Tempo holds for the given traces, read by id because Tempo search only finds a trace about 30 s after it arrives
export async function tempoSpans(tempoUrl: string, traceIds: string[]): Promise<TreeSpan[]> {
  const traces = await Promise.all(
    traceIds.map(async (id) => {
      const response = await fetch(`${tempoUrl}/api/v2/traces/${id}`, {
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
      if (response.status === 404) {
        return [];
      }
      const json: TempoTrace = JSON.parse(await response.text());
      return json.trace.resourceSpans
        .flatMap((resource) => resource.scopeSpans)
        .flatMap((scope) => scope.spans);
    }),
  );
  return traces.flat().map((span) => ({ ...span, attributes: span.attributes ?? [] }));
}

export async function lokiStreams(
  lokiUrl: string,
  startSeconds: number,
  endSeconds: number,
): Promise<LokiStream[]> {
  const params = new URLSearchParams({
    query: '{service_name="pi"}',
    start: String(BigInt(Math.floor(startSeconds)) * NANOS_PER_SECOND),
    end: String(BigInt(Math.ceil(endSeconds)) * NANOS_PER_SECOND),
    limit: String(LOG_QUERY_LIMIT),
  });
  const json = await getJson<LokiResponse>(
    `${lokiUrl}/loki/api/v1/query_range?${params.toString()}`,
  );
  return json.data.result;
}
