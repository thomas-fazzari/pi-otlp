// SPDX-FileCopyrightText: 2026 Thomas Fazzari
// SPDX-License-Identifier: MIT

// OpenTelemetry treats only the case-insensitive string "true" as true.
export function booleanFromEnv(name: string): boolean {
  return process.env[name]?.toLowerCase() === "true";
}

export function positiveNumberFromEnv(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  if (Number.isFinite(value) && value > 0) {
    return value;
  }
  return fallback;
}
