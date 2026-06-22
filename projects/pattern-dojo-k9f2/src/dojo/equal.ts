import type { CompareMode } from "./types";

/**
 * Deterministic value comparison for the Code Dojo judge.
 *
 * `JSON.stringify` is unusable as a canonical form here: it drops `undefined`,
 * coerces `NaN`/`±Infinity` to `null`, and serialises object keys in insertion
 * order. This module builds a stable canonical string that round-trips those
 * edge cases and sorts object keys, then layers the order-insensitive and
 * floating-point comparison modes on top.
 */

function canonical(value: unknown): string {
  if (value === null) return "null";
  if (value === undefined) return "undefined";
  const t = typeof value;
  if (t === "number") {
    const n = value as number;
    if (Number.isNaN(n)) return "NaN";
    if (n === Infinity) return "Infinity";
    if (n === -Infinity) return "-Infinity";
    return Object.is(n, -0) ? "0" : String(n);
  }
  if (t === "string") return JSON.stringify(value);
  if (t === "boolean") return value ? "true" : "false";
  if (t === "bigint") return `${value}n`;
  if (Array.isArray(value)) {
    return "[" + value.map(canonical).join(",") + "]";
  }
  if (t === "object") {
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj).sort();
    return "{" + keys.map((k) => JSON.stringify(k) + ":" + canonical(obj[k])).join(",") + "}";
  }
  // functions / symbols shouldn't appear in judged output
  return String(value);
}

/** Recursively sort every array (by canonical form) so ordering becomes irrelevant. */
function sortDeep(value: unknown): unknown {
  if (Array.isArray(value)) {
    const mapped = value.map(sortDeep);
    mapped.sort((a, b) => {
      const ca = canonical(a);
      const cb = canonical(b);
      return ca < cb ? -1 : ca > cb ? 1 : 0;
    });
    return mapped;
  }
  if (value && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(obj)) out[k] = sortDeep(obj[k]);
    return out;
  }
  return value;
}

const APPROX_EPS = 1e-4;

function approxEqual(a: unknown, b: unknown): boolean {
  if (typeof a === "number" && typeof b === "number") {
    if (Number.isNaN(a) && Number.isNaN(b)) return true;
    if (!Number.isFinite(a) || !Number.isFinite(b)) return a === b;
    const diff = Math.abs(a - b);
    return diff <= APPROX_EPS || diff <= APPROX_EPS * Math.max(Math.abs(a), Math.abs(b));
  }
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    return a.every((x, i) => approxEqual(x, b[i]));
  }
  if (a && b && typeof a === "object" && typeof b === "object") {
    const ka = Object.keys(a as object).sort();
    const kb = Object.keys(b as object).sort();
    if (canonical(ka) !== canonical(kb)) return false;
    return ka.every((k) =>
      approxEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]),
    );
  }
  return canonical(a) === canonical(b);
}

/** True when `got` satisfies `expected` under the given comparison mode. */
export function compareValues(got: unknown, expected: unknown, mode: CompareMode = "deep"): boolean {
  switch (mode) {
    case "deep":
      return canonical(got) === canonical(expected);
    case "approx":
      return approxEqual(got, expected);
    case "unordered": {
      if (!Array.isArray(got) || !Array.isArray(expected)) {
        return canonical(got) === canonical(expected);
      }
      if (got.length !== expected.length) return false;
      const a = got.map(canonical).sort();
      const b = expected.map(canonical).sort();
      return a.every((x, i) => x === b[i]);
    }
    case "unordered-deep":
      return canonical(sortDeep(got)) === canonical(sortDeep(expected));
    default:
      return canonical(got) === canonical(expected);
  }
}

/** A compact, human-readable rendering of a value for the results console. */
export function display(value: unknown, max = 200): string {
  let s: string;
  try {
    s = JSON.stringify(value, (_k, v) => {
      if (typeof v === "number") {
        if (Number.isNaN(v)) return "NaN";
        if (v === Infinity) return "Infinity";
        if (v === -Infinity) return "-Infinity";
      }
      return v;
    });
  } catch {
    s = String(value);
  }
  if (s === undefined) s = "undefined";
  return s.length > max ? s.slice(0, max - 1) + "…" : s;
}
