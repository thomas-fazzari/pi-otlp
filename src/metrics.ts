// SPDX-FileCopyrightText: 2026 Thomas Fazzari
// SPDX-License-Identifier: MIT

import { encodeAttributes } from "./attributes.ts";
import type { Attributes } from "./attributes.ts";
import { AGGREGATION_TEMPORALITY_CUMULATIVE, toInt64 } from "./otlp.ts";
import type * as otlp from "./otlp.ts";
import { stableKey } from "./utils/stable-key.ts";
import { nowUnixNanos, unixNanos } from "./utils/time.ts";

const MAX_SERIES_PER_INSTRUMENT = 2000;
// The OpenTelemetry metrics SDK spec routes measurements beyond the cardinality limit to this series.
const OVERFLOW_ATTRIBUTES: Attributes = { "otel.metric.overflow": true };
// Prometheus keeps one sample per millisecond, so a zero start point must never share one with the current point.
const SERIES_START_LEAD_MS = 1;

export interface InstrumentOptions {
  unit?: string;
  description?: string;
}

export interface HistogramOptions extends InstrumentOptions {
  boundaries: readonly number[];
}

export interface Counter {
  add(value: number, attributes?: Attributes): void;
}

export interface Histogram {
  record(value: number, attributes?: Attributes): void;
}

export interface MetricsCollection {
  metrics: otlp.Metric[];
  // Call once the export has a final outcome, so later exports stop adding zero start points.
  commit: () => void;
}

interface Delivery {
  delivered: boolean;
}

interface Series<T> extends Delivery {
  attributes: otlp.KeyValue[];
  startTimeUnixNano: otlp.Int64;
  data: T;
}

interface HistogramData {
  bucketCounts: number[];
  count: number;
  sum: number;
  min: number;
  max: number;
}

type HistogramValues = Omit<
  otlp.HistogramDataPoint,
  "attributes" | "startTimeUnixNano" | "timeUnixNano"
>;

type Encode = (time: otlp.Int64, pending: Delivery[]) => otlp.Metric | undefined;

type Instrument =
  | { kind: "counter"; handle: Counter; encode: Encode }
  | { kind: "histogram"; handle: Histogram; encode: Encode };

class SeriesMap<T> {
  readonly #series = new Map<string, Series<T>>();
  readonly #create: () => T;

  constructor(create: () => T) {
    this.#create = create;
  }

  getOrCreate(attributes: Attributes): Series<T> {
    let key = stableKey(attributes);
    let seriesAttributes = attributes;
    if (!this.#series.has(key) && this.#series.size >= MAX_SERIES_PER_INSTRUMENT - 1) {
      key = stableKey(OVERFLOW_ATTRIBUTES);
      seriesAttributes = OVERFLOW_ATTRIBUTES;
    }
    let series = this.#series.get(key);
    if (series === undefined) {
      series = {
        attributes: encodeAttributes(seriesAttributes),
        startTimeUnixNano: unixNanos(Date.now() - SERIES_START_LEAD_MS),
        data: this.#create(),
        delivered: false,
      };
      this.#series.set(key, series);
    }
    return series;
  }

  encode<P>(time: otlp.Int64, point: (data: T) => P, zero: P, pending: Delivery[]) {
    const points = [];
    for (const series of this.#series.values()) {
      const base = { attributes: series.attributes, startTimeUnixNano: series.startTimeUnixNano };
      if (!series.delivered) {
        // Prometheus increase() ignores the first sample of a series, so it must be a zero.
        points.push({ ...base, timeUnixNano: series.startTimeUnixNano, ...zero });
        pending.push(series);
      }
      points.push({ ...base, timeUnixNano: time, ...point(series.data) });
    }
    return points;
  }
}

export class Meter {
  readonly #instruments = new Map<string, Instrument>();

  counter(name: string, options: InstrumentOptions = {}): Counter {
    const instrument =
      this.#instruments.get(name) ?? this.#register(name, createCounter(name, options));
    if (instrument.kind !== "counter") {
      throw new Error(`pi-otlp: instrument ${name} is already a ${instrument.kind}`);
    }
    return instrument.handle;
  }

  histogram(name: string, options: HistogramOptions): Histogram {
    const instrument =
      this.#instruments.get(name) ?? this.#register(name, createHistogram(name, options));
    if (instrument.kind !== "histogram") {
      throw new Error(`pi-otlp: instrument ${name} is already a ${instrument.kind}`);
    }
    return instrument.handle;
  }

  collect(): MetricsCollection {
    const time = nowUnixNanos();
    const pending: Delivery[] = [];
    const metrics = [...this.#instruments.values()]
      .map((instrument) => instrument.encode(time, pending))
      .filter((metric) => metric !== undefined);
    const commit = () => {
      for (const series of pending) {
        series.delivered = true;
      }
    };
    return { metrics, commit };
  }

  #register(name: string, instrument: Instrument): Instrument {
    this.#instruments.set(name, instrument);
    return instrument;
  }
}

function createCounter(name: string, options: InstrumentOptions): Instrument {
  const series = new SeriesMap(() => ({ value: 0 }));
  const handle: Counter = {
    add(value, attributes = {}) {
      // A negative or non-finite value would break monotonicity or serialize as null.
      if (!Number.isFinite(value) || value < 0) {
        return;
      }
      series.getOrCreate(attributes).data.value += value;
    },
  };
  const encode: Encode = (time, pending) => {
    const dataPoints = series.encode(
      time,
      (data) => ({ asDouble: data.value }),
      { asDouble: 0 },
      pending,
    );
    if (dataPoints.length === 0) {
      return undefined;
    }
    return {
      name,
      unit: options.unit,
      description: options.description,
      sum: {
        aggregationTemporality: AGGREGATION_TEMPORALITY_CUMULATIVE,
        isMonotonic: true,
        dataPoints,
      },
    };
  };
  return { kind: "counter", handle, encode };
}

function createHistogram(name: string, options: HistogramOptions): Instrument {
  const { boundaries } = options;
  const series = new SeriesMap<HistogramData>(() => ({
    bucketCounts: emptyBuckets(boundaries),
    count: 0,
    sum: 0,
    min: Infinity,
    max: -Infinity,
  }));
  const handle: Histogram = {
    record(value, attributes = {}) {
      if (!Number.isFinite(value)) {
        return;
      }
      addToHistogram(series.getOrCreate(attributes).data, boundaries, value);
    },
  };
  const zero: HistogramValues = {
    count: toInt64(0),
    sum: 0,
    min: undefined,
    max: undefined,
    bucketCounts: emptyBuckets(boundaries).map(toInt64),
    explicitBounds: boundaries,
  };
  const point = (data: HistogramData): HistogramValues => ({
    count: toInt64(data.count),
    sum: data.sum,
    min: data.min,
    max: data.max,
    bucketCounts: data.bucketCounts.map(toInt64),
    explicitBounds: boundaries,
  });
  const encode: Encode = (time, pending) => {
    const dataPoints = series.encode(time, point, zero, pending);
    if (dataPoints.length === 0) {
      return undefined;
    }
    return {
      name,
      unit: options.unit,
      description: options.description,
      histogram: { aggregationTemporality: AGGREGATION_TEMPORALITY_CUMULATIVE, dataPoints },
    };
  };
  return { kind: "histogram", handle, encode };
}

function emptyBuckets(boundaries: readonly number[]): number[] {
  return Array<number>(boundaries.length + 1).fill(0);
}

function addToHistogram(data: HistogramData, boundaries: readonly number[], value: number): void {
  let bucket = boundaries.findIndex((bound) => value <= bound);
  if (bucket === -1) {
    bucket = boundaries.length;
  }
  data.bucketCounts[bucket] = (data.bucketCounts[bucket] ?? 0) + 1;
  data.count++;
  data.sum += value;
  data.min = Math.min(data.min, value);
  data.max = Math.max(data.max, value);
}
