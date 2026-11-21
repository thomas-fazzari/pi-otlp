// SPDX-FileCopyrightText: 2026 Thomas Fazzari
// SPDX-License-Identifier: MIT

import { match, P } from "ts-pattern";
import type { MetricsCollection } from "./metrics.ts";
import type { ExportRequest, Metric } from "./otlp.ts";
import { ERROR_TYPE_VALUE_OTHER } from "./semconv.ts";
import { BoundedQueue } from "./utils/bounded-queue.ts";

const MAX_QUEUE_SIZE = 2048;
const EXPORT_TIMEOUT_MS = 10_000;
const OVERDUE_TICKS = 2;
// The OTLP/HTTP spec makes only network errors and these statuses retryable.
const RETRYABLE_STATUSES = new Set([429, 502, 503, 504]);

type PostResult = { outcome: "sent" } | { outcome: "retry" | "drop"; errorType: string };

// Each record is reported once, at its final outcome. A failed attempt that requeues the batch reports nothing.
export interface DeliveryReport {
  sent(count: number): void;
  dropped(count: number, errorType: string): void;
  ejected(count: number): void;
}

export type OutcomeCounter = (count: number, errorType?: string) => void;

export async function post(
  url: string,
  body: ExportRequest,
  signal: AbortSignal,
): Promise<PostResult> {
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal,
    });
    await response.arrayBuffer();
    if (response.ok) {
      return { outcome: "sent" };
    }
    const outcome = RETRYABLE_STATUSES.has(response.status) ? "retry" : "drop";
    return { outcome, errorType: String(response.status) };
  } catch (error) {
    return { outcome: "retry", errorType: errorType(error) };
  }
}

function errorType(error: unknown): string {
  if (!(error instanceof Error)) {
    return ERROR_TYPE_VALUE_OTHER;
  }
  if ("code" in error && typeof error.code === "string") {
    return error.code;
  }
  return error.name;
}

// Bun 1.3 timers and AbortSignal.timeout can stop firing after the machine sleeps (oven-sh/bun#34564).
export class ExportLoop {
  readonly #send: (signal: AbortSignal) => Promise<void>;
  readonly #intervalMs: number;
  #inFlight: Promise<void> | undefined;
  #lastRunAt = Date.now();

  constructor(send: (signal: AbortSignal) => Promise<void>, intervalMs: number) {
    this.#send = send;
    this.#intervalMs = intervalMs;
    setInterval(() => void this.run(AbortSignal.timeout(EXPORT_TIMEOUT_MS)), intervalMs).unref();
  }

  runIfOverdue(): void {
    if (Date.now() - this.#lastRunAt >= OVERDUE_TICKS * this.#intervalMs) {
      void this.run(AbortSignal.timeout(EXPORT_TIMEOUT_MS));
    }
  }

  run(signal: AbortSignal): Promise<void> {
    const now = Date.now();
    if (this.#inFlight !== undefined && now - this.#lastRunAt < EXPORT_TIMEOUT_MS) {
      return this.#inFlight;
    }
    this.#lastRunAt = now;
    const inFlight = this.#send(signal).finally(() => {
      if (this.#inFlight === inFlight) {
        this.#inFlight = undefined;
      }
    });
    this.#inFlight = inFlight;
    return inFlight;
  }

  async drain(signal: AbortSignal): Promise<void> {
    await this.#inFlight;
    await this.run(signal);
  }
}

export class RecordQueue<T> {
  readonly #url: string;
  readonly #wrap: (records: T[]) => ExportRequest;
  readonly #report: DeliveryReport;
  readonly #queue: BoundedQueue<T>;

  constructor(url: string, wrap: (records: T[]) => ExportRequest, report: DeliveryReport) {
    this.#url = url;
    this.#wrap = wrap;
    this.#report = report;
    this.#queue = new BoundedQueue(MAX_QUEUE_SIZE, (count) => report.ejected(count));
  }

  push(record: T): void {
    this.#queue.push(record);
  }

  async send(signal: AbortSignal): Promise<void> {
    const batch = this.#queue.takeAll();
    if (batch.length === 0) {
      return;
    }
    const result = await post(this.#url, this.#wrap(batch), signal);
    match(result)
      .with({ outcome: "sent" }, () => this.#report.sent(batch.length))
      .with({ outcome: "retry" }, () => this.#queue.restoreFront(batch))
      .with({ outcome: "drop", errorType: P.select() }, (type) =>
        this.#report.dropped(batch.length, type),
      )
      .exhaustive();
  }
}

export class MetricExport {
  readonly #url: string;
  readonly #collect: () => MetricsCollection;
  readonly #wrap: (metrics: Metric[]) => ExportRequest;
  readonly #exported: OutcomeCounter;

  constructor(
    url: string,
    collect: () => MetricsCollection,
    wrap: (metrics: Metric[]) => ExportRequest,
    exported: OutcomeCounter,
  ) {
    this.#url = url;
    this.#collect = collect;
    this.#wrap = wrap;
    this.#exported = exported;
  }

  async send(signal: AbortSignal): Promise<void> {
    const { metrics, commit } = this.#collect();
    if (metrics.length === 0) {
      return;
    }
    const result = await post(this.#url, this.#wrap(metrics), signal);
    const count = countDataPoints(metrics);
    // Prometheus rejects a whole request that re-sends a zero it already holds, so only a retryable failure keeps them
    match(result)
      .with({ outcome: "sent" }, () => {
        commit();
        this.#exported(count);
      })
      .with({ outcome: "drop", errorType: P.select() }, (type) => {
        commit();
        this.#exported(count, type);
      })
      .with({ outcome: "retry", errorType: P.select() }, (type) => this.#exported(count, type))
      .exhaustive();
  }
}

function countDataPoints(metrics: Metric[]): number {
  let count = 0;
  for (const metric of metrics) {
    count += "sum" in metric ? metric.sum.dataPoints.length : metric.histogram.dataPoints.length;
  }
  return count;
}
