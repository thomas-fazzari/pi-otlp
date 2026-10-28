// SPDX-FileCopyrightText: 2026 Thomas Fazzari
// SPDX-License-Identifier: MIT

export class BoundedQueue<T> {
  readonly #capacity: number;
  readonly #onEject: (count: number) => void;
  #items: T[] = [];

  constructor(capacity: number, onEject: (count: number) => void) {
    this.#capacity = capacity;
    this.#onEject = onEject;
  }

  push(item: T): void {
    this.#items.push(item);
    this.#trim();
  }

  takeAll(): T[] {
    const items = this.#items;
    this.#items = [];
    return items;
  }

  restoreFront(items: readonly T[]): void {
    this.#items = [...items, ...this.#items];
    this.#trim();
  }

  #trim(): void {
    const excess = this.#items.length - this.#capacity;
    if (excess <= 0) {
      return;
    }
    this.#items = this.#items.slice(excess);
    this.#onEject(excess);
  }
}
