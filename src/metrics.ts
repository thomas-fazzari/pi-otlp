// SPDX-FileCopyrightText: 2026 Thomas Fazzari
// SPDX-License-Identifier: MIT

import { encodeAttributes } from "./attributes.ts";
import type { Attributes } from "./attributes.ts";
import { AGGREGATION_TEMPORALITY_CUMULATIVE, toInt64 } from "./otlp.ts";
import type * as otlp from "./otlp.ts";
import { stableKey } from "./utils/stable-key.ts";
import { nowUnixNanos } from "./utils/time.ts";

const MAX_SERIES_PER_INSTRUMENT = 2000;
// The OpenTelemetry metrics SDK spec routes measurements beyond the cardinality limit to this series.
const OVERFLOW_ATTRIBUTES: Attributes = { "otel.metric.overflow": true };

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

interface Series<T> {
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

type Instrument =
  | { kind: "counter"; handle: Counter; encode: (time: otlp.Int64) => otlp.Metric | undefined }
  | { kind: "histogram"; handle: Histogram; encode: (time: otlp.Int64) => otlp.Metric | undefined };

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
        startTimeUnixNano: nowUnixNanos(),
        data: this.#create(),
      };
      this.#series.set(key, series);
    }
    return series;
  }

  encode<P>(time: otlp.Int64, point: (data: T) => P) {
    return [...this.#series.values()].map((series) => ({
      attributes: series.attributes,
      startTimeUnixNano: series.startTimeUnixNano,
      timeUnixNano: time,
      ...point(series.data),
    }));
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

  collect(): otlp.Metric[] {
    const time = nowUnixNanos();
    return [...this.#instruments.values()]
      .map((instrument) => instrument.encode(time))
      .filter((metric) => metric !== undefined);
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
  const encode = (time: otlp.Int64): otlp.Metric | undefined => {
    const dataPoints = series.encode(time, (data) => ({ asDouble: data.value }));
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
    bucketCounts: Array<number>(boundaries.length + 1).fill(0),
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
  const encode = (time: otlp.Int64): otlp.Metric | undefined => {
    const dataPoints = series.encode(time, (data) => ({
      count: toInt64(data.count),
      sum: data.sum,
      min: data.min,
      max: data.max,
      bucketCounts: data.bucketCounts.map(toInt64),
      explicitBounds: boundaries,
    }));
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
