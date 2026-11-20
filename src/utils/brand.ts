// SPDX-FileCopyrightText: 2026 Thomas Fazzari
// SPDX-License-Identifier: MIT

declare const brand: unique symbol;

// A primitive type that only its owner module creates, so that a TraceId cannot stand in for a SpanId.
export type Brand<T, Name extends string> = T & { readonly [brand]: Name };
