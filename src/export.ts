// SPDX-FileCopyrightText: 2026 Thomas Fazzari
// SPDX-License-Identifier: MIT

import type { ExportRequest } from "./otlp.ts";
import { ERROR_TYPE_VALUE_OTHER } from "./semconv.ts";
import { BoundedQueue } from "./utils/bounded-queue.ts";

const MAX_QUEUE_SIZE = 2048;
// The OTLP/HTTP spec makes only network errors and these statuses retryable.
const RETRYABLE_STATUSES = new Set([429, 502, 503, 504]);

type PostResult = { outcome: "sent" } | { outcome: "retry" | "drop"; errorType: string };

// Each record is reported once, at its final outcome. A failed attempt that requeues the batch reports nothing.
export interface DeliveryReport {
  sent(count: number): void;
  dropped(count: number, errorType: string): void;
  ejected(count: number): void;
}

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

export class ExportLoop {
  readonly #send: (signal: AbortSignal) => Promise<void>;
  #inFlight: Promise<void> | undefined;

  constructor(send: (signal: AbortSignal) => Promise<void>) {
    this.#send = send;
  }

  run(signal: AbortSignal): Promise<void> {
    this.#inFlight ??= this.#send(signal).finally(() => {
      this.#inFlight = undefined;
    });
    return this.#inFlight;
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
    switch (result.outcome) {
      case "sent":
        this.#report.sent(batch.length);
        return;
      case "retry":
        this.#queue.restoreFront(batch);
        return;
      case "drop":
        this.#report.dropped(batch.length, result.errorType);
        return;
    }
  }
}
