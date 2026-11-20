// SPDX-FileCopyrightText: 2026 Thomas Fazzari
// SPDX-License-Identifier: MIT

declare const brand: unique symbol;

// A primitive that only its owner's ctor can produce, so 2 values of the same primitive type cannot be swapped
export type Brand<T, Name extends string> = T & { readonly [brand]: Name };
