// SPDX-FileCopyrightText: 2026 Thomas Fazzari
// SPDX-License-Identifier: MIT

import { positiveNumberFromEnv } from "./utils/env.ts";

const DEFAULT_ENDPOINT = "http://127.0.0.1:4318";
const DEFAULT_METRIC_EXPORT_INTERVAL_MS = 60_000;
const DEFAULT_SCHEDULE_DELAY_MS = 5000;

interface Config {
  endpoint: string;
  metricExportIntervalMs: number;
  spanScheduleDelayMs: number;
  logScheduleDelayMs: number;
}

export function sdkDisabled(): boolean {
  return process.env["OTEL_SDK_DISABLED"]?.toLowerCase() === "true";
}

export function readConfig(): Config {
  const endpoint = process.env["OTEL_EXPORTER_OTLP_ENDPOINT"] || DEFAULT_ENDPOINT;
  return {
    endpoint: endpoint.replace(/\/+$/u, ""),
    metricExportIntervalMs: positiveNumberFromEnv(
      "OTEL_METRIC_EXPORT_INTERVAL",
      DEFAULT_METRIC_EXPORT_INTERVAL_MS,
    ),
    spanScheduleDelayMs: positiveNumberFromEnv(
      "OTEL_BSP_SCHEDULE_DELAY",
      DEFAULT_SCHEDULE_DELAY_MS,
    ),
    logScheduleDelayMs: positiveNumberFromEnv(
      "OTEL_BLRP_SCHEDULE_DELAY",
      DEFAULT_SCHEDULE_DELAY_MS,
    ),
  };
}
