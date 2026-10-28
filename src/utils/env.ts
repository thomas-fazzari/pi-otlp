// SPDX-FileCopyrightText: 2026 Thomas Fazzari
// SPDX-License-Identifier: MIT

export function positiveNumberFromEnv(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  if (Number.isFinite(value) && value > 0) {
    return value;
  }
  return fallback;
}
