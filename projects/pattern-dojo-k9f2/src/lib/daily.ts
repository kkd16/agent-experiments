import { dayKey } from "./streak";

/** Deterministic, date-seeded pick so everyone sees the same "pattern of the day". */
export function patternOfTheDay<T>(items: T[], date: Date = new Date()): T {
  const key = dayKey(date);
  let h = 2166136261;
  for (let i = 0; i < key.length; i++) {
    h ^= key.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  const idx = Math.abs(h) % items.length;
  return items[idx];
}
