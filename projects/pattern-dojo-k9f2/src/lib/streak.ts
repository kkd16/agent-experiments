import { useCallback, useEffect, useState } from "react";

/**
 * Daily streak tracking. We record the local calendar dates on which the
 * learner did *something* (reviewed a card, marked a pattern). The current
 * streak is the unbroken run of days ending today or yesterday; the longest
 * streak is the best such run ever.
 */

const KEY = "pattern-dojo:streak:v1";
const EVENT = "pd-streak-change";

interface StreakStore {
  v: 1;
  days: string[]; // sorted unique "YYYY-MM-DD"
}

export function dayKey(d: Date = new Date()): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function read(): StreakStore {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as StreakStore;
      if (parsed && Array.isArray(parsed.days)) return parsed;
    }
  } catch {
    /* ignore */
  }
  return { v: 1, days: [] };
}

function write(s: StreakStore) {
  try {
    localStorage.setItem(KEY, JSON.stringify(s));
  } catch {
    /* ignore */
  }
  window.dispatchEvent(new CustomEvent(EVENT));
}

function addDays(key: string, n: number): string {
  const [y, m, d] = key.split("-").map(Number);
  const dt = new Date(y, m - 1, d + n);
  return dayKey(dt);
}

function computeStreaks(days: string[]): { current: number; longest: number; activeToday: boolean } {
  const set = new Set(days);
  const today = dayKey();
  const yesterday = addDays(today, -1);
  const activeToday = set.has(today);

  // current streak: walk back from today (or yesterday if today not yet active)
  let cursor = activeToday ? today : set.has(yesterday) ? yesterday : null;
  let current = 0;
  while (cursor && set.has(cursor)) {
    current++;
    cursor = addDays(cursor, -1);
  }

  // longest streak across all recorded days
  let longest = 0;
  const sorted = [...set].sort();
  let run = 0;
  let prev: string | null = null;
  for (const day of sorted) {
    if (prev && addDays(prev, 1) === day) run++;
    else run = 1;
    prev = day;
    if (run > longest) longest = run;
  }

  return { current, longest, activeToday };
}

export function useStreak() {
  const [store, setStore] = useState<StreakStore>(read);

  useEffect(() => {
    const sync = () => setStore(read());
    window.addEventListener(EVENT, sync);
    window.addEventListener("storage", sync);
    return () => {
      window.removeEventListener(EVENT, sync);
      window.removeEventListener("storage", sync);
    };
  }, []);

  const recordToday = useCallback(() => {
    const today = dayKey();
    const cur = read();
    if (cur.days.includes(today)) return;
    const next: StreakStore = { v: 1, days: [...cur.days, today].sort() };
    write(next);
    setStore(next);
  }, []);

  const { current, longest, activeToday } = computeStreaks(store.days);
  return { current, longest, activeToday, days: store.days, recordToday };
}
