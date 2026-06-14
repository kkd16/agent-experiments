import { useCallback, useEffect, useState } from "react";

/**
 * Spaced-repetition engine for Pattern Dojo.
 *
 * Each pattern is a "card" scheduled with an SM-2–style algorithm tuned for a
 * small deck of conceptual patterns (not thousands of vocabulary cards): short
 * learning steps to lock in a new pattern the same session, then expanding
 * review intervals driven by an ease factor. Everything is persisted to
 * localStorage and synced across components in the same tab.
 */

const KEY = "pattern-dojo:srs:v1";
const LEGACY_KEY = "pattern-dojo:progress:v1";
const EVENT = "pd-srs-change";

export const MINUTE = 60 * 1000;
export const DAY = 24 * 60 * MINUTE;

/** 0 = Again, 1 = Hard, 2 = Good, 3 = Easy. */
export type Grade = 0 | 1 | 2 | 3;
export type CardStatus = "new" | "learning" | "review";

export interface Card {
  id: string;
  status: CardStatus;
  /** ease factor — multiplier applied to the interval on a "Good" review. */
  ease: number;
  /** current spacing interval, in days (meaningful once status === "review"). */
  intervalDays: number;
  /** epoch-ms timestamp when the card next becomes due. */
  due: number;
  /** successful graduations / reviews. */
  reps: number;
  /** times the card was forgotten after graduating. */
  lapses: number;
  /** index into the learning-step ladder. */
  learningStep: number;
  /** epoch-ms of the last review. */
  last: number;
  lastGrade: Grade | null;
}

export type Mastery = "new" | "learning" | "young" | "mastered";

interface Store {
  v: 1;
  cards: Record<string, Card>;
}

/** Learning ladder, in minutes — a brand-new card climbs these before graduating. */
const LEARNING_STEPS = [1, 10];
const MIN_EASE = 1.3;
const MAX_EASE = 3.0;
const MAX_INTERVAL = 365;
/** A "young" card is still consolidating; past this it's considered mastered. */
export const MATURE_DAYS = 21;

function freshStore(): Store {
  return { v: 1, cards: {} };
}

function newCard(id: string, now: number): Card {
  return {
    id,
    status: "new",
    ease: 2.5,
    intervalDays: 0,
    due: now,
    reps: 0,
    lapses: 0,
    learningStep: 0,
    last: 0,
    lastGrade: null,
  };
}

function clampEase(e: number): number {
  return Math.max(MIN_EASE, Math.min(MAX_EASE, e));
}

function clampInterval(d: number): number {
  return Math.max(1, Math.min(MAX_INTERVAL, Math.round(d)));
}

/**
 * Pure scheduler: given a card and a grade, return the updated card. Exposed so
 * the UI can preview "next due" labels for each button before committing.
 */
export function schedule(card: Card, grade: Grade, now: number = Date.now()): Card {
  const c: Card = { ...card, last: now, lastGrade: grade };

  if (card.status === "review") {
    if (grade === 0) {
      // Lapse — demote to relearning and shrink the interval.
      c.status = "learning";
      c.learningStep = 0;
      c.lapses = card.lapses + 1;
      c.ease = clampEase(card.ease - 0.2);
      c.intervalDays = Math.max(1, Math.round(card.intervalDays * 0.4));
      c.due = now + LEARNING_STEPS[0] * MINUTE;
      return c;
    }
    let factor: number;
    if (grade === 1) {
      c.ease = clampEase(card.ease - 0.15);
      factor = 1.2;
    } else if (grade === 2) {
      c.ease = card.ease;
      factor = card.ease;
    } else {
      c.ease = clampEase(card.ease + 0.15);
      factor = card.ease * 1.3;
    }
    c.intervalDays = clampInterval(Math.max(card.intervalDays + 1, card.intervalDays * factor));
    c.reps = card.reps + 1;
    c.due = now + c.intervalDays * DAY;
    return c;
  }

  // status is "new" or "learning"
  if (grade === 0) {
    c.status = "learning";
    c.learningStep = 0;
    c.due = now + LEARNING_STEPS[0] * MINUTE;
    return c;
  }
  if (grade === 3) {
    // Easy on a learning card graduates it straight away with a head start.
    c.status = "review";
    c.intervalDays = 4;
    c.reps = card.reps + 1;
    c.learningStep = 0;
    c.due = now + c.intervalDays * DAY;
    return c;
  }

  // Hard (1) repeats the current step; Good (2) advances it.
  const step = grade === 2 ? card.learningStep + 1 : card.learningStep;
  if (step >= LEARNING_STEPS.length) {
    // Graduate.
    c.status = "review";
    c.intervalDays = 1;
    c.reps = card.reps + 1;
    c.learningStep = 0;
    c.due = now + c.intervalDays * DAY;
    return c;
  }
  c.status = "learning";
  c.learningStep = step;
  c.due = now + LEARNING_STEPS[step] * MINUTE;
  return c;
}

export function masteryOf(card: Card | undefined): Mastery {
  if (!card || (card.status === "new" && card.reps === 0)) return "new";
  if (card.status === "learning") return "learning";
  if (card.intervalDays >= MATURE_DAYS) return "mastered";
  return "young";
}

export const MASTERY_LABEL: Record<Mastery, string> = {
  new: "New",
  learning: "Learning",
  young: "Reviewing",
  mastered: "Mastered",
};

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

function migrateLegacy(): Record<string, Card> {
  const cards: Record<string, Card> = {};
  try {
    const raw = localStorage.getItem(LEGACY_KEY);
    if (!raw) return cards;
    const old = JSON.parse(raw) as Record<string, boolean>;
    const now = Date.now();
    for (const id of Object.keys(old)) {
      if (!old[id]) continue;
      // A previously "learned" pattern becomes a graduated card due for review now.
      cards[id] = {
        ...newCard(id, now),
        status: "review",
        intervalDays: 4,
        reps: 1,
        due: now,
        last: now,
        lastGrade: 2,
      };
    }
  } catch {
    /* ignore */
  }
  return cards;
}

function read(): Store {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Store;
      if (parsed && parsed.cards) return parsed;
    }
  } catch {
    /* ignore */
  }
  // First run with the new engine — pull anything from the legacy boolean store.
  const migrated = migrateLegacy();
  const store: Store = { v: 1, cards: migrated };
  if (Object.keys(migrated).length) write(store);
  return store;
}

function write(store: Store) {
  try {
    localStorage.setItem(KEY, JSON.stringify(store));
  } catch {
    /* ignore quota / private mode */
  }
  window.dispatchEvent(new CustomEvent(EVENT));
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

export interface SRSApi {
  cards: Record<string, Card>;
  getCard: (id: string) => Card | undefined;
  /** A card object for `id`, materializing a fresh "new" card if untracked. */
  cardOrNew: (id: string) => Card;
  grade: (id: string, g: Grade) => void;
  /** Quick "I know this" — graduate the card with a Good if it isn't already. */
  markLearned: (id: string) => void;
  /** Toggle a pattern's learned state (compat with the old checkbox UI). */
  toggleLearned: (id: string) => void;
  /** Drop a pattern back to untracked. */
  forget: (id: string) => void;
  resetAll: () => void;
  isLearned: (id: string) => boolean;
  masteryOf: (id: string) => Mastery;
  dueCards: (now?: number) => Card[];
  /** Cards never studied, in pattern order is up to the caller. */
  newIds: (allIds: string[]) => string[];
  counts: { tracked: number; learned: number; due: number; mastered: number; learning: number };
}

export function useSRS(): SRSApi {
  const [store, setStore] = useState<Store>(read);
  // A render-stable "now" so due/overdue computation stays pure. It refreshes
  // whenever the store changes (i.e. after a grade) and on cross-tab sync.
  const [nowTs, setNowTs] = useState<number>(() => Date.now());

  useEffect(() => {
    const sync = () => {
      setStore(read());
      setNowTs(Date.now());
    };
    window.addEventListener("storage", sync);
    window.addEventListener(EVENT, sync as EventListener);
    return () => {
      window.removeEventListener("storage", sync);
      window.removeEventListener(EVENT, sync as EventListener);
    };
  }, []);

  const commit = useCallback((mut: (cards: Record<string, Card>) => void) => {
    const current = read();
    const cards = { ...current.cards };
    mut(cards);
    const next: Store = { v: 1, cards };
    write(next);
    setStore(next);
    setNowTs(Date.now());
  }, []);

  const getCard = useCallback((id: string) => store.cards[id], [store]);
  const cardOrNew = useCallback(
    (id: string) => store.cards[id] ?? newCard(id, Date.now()),
    [store],
  );

  const grade = useCallback(
    (id: string, g: Grade) => {
      const now = Date.now();
      commit((cards) => {
        const base = cards[id] ?? newCard(id, now);
        cards[id] = schedule(base, g, now);
      });
    },
    [commit],
  );

  const markLearned = useCallback(
    (id: string) => {
      const now = Date.now();
      commit((cards) => {
        const base = cards[id] ?? newCard(id, now);
        if (base.status === "review") return;
        cards[id] = {
          ...base,
          status: "review",
          intervalDays: Math.max(1, base.intervalDays || 1),
          reps: Math.max(1, base.reps),
          learningStep: 0,
          last: now,
          lastGrade: 2,
          due: now + Math.max(1, base.intervalDays || 1) * DAY,
        };
      });
    },
    [commit],
  );

  const toggleLearned = useCallback(
    (id: string) => {
      const now = Date.now();
      commit((cards) => {
        const existing = cards[id];
        if (existing && (existing.reps > 0 || existing.status === "review")) {
          delete cards[id];
        } else {
          cards[id] = {
            ...newCard(id, now),
            status: "review",
            intervalDays: 1,
            reps: 1,
            last: now,
            lastGrade: 2,
            due: now + DAY,
          };
        }
      });
    },
    [commit],
  );

  const forget = useCallback(
    (id: string) => commit((cards) => { delete cards[id]; }),
    [commit],
  );

  const resetAll = useCallback(() => {
    write(freshStore());
    setStore(freshStore());
    try {
      localStorage.removeItem(LEGACY_KEY);
    } catch {
      /* ignore */
    }
  }, []);

  const isLearned = useCallback(
    (id: string) => {
      const c = store.cards[id];
      return !!c && (c.reps > 0 || c.status === "review");
    },
    [store],
  );

  const masteryFn = useCallback((id: string) => masteryOf(store.cards[id]), [store]);

  const dueCards = useCallback(
    (now: number = nowTs) =>
      Object.values(store.cards)
        .filter((c) => (c.reps > 0 || c.status !== "new") && c.due <= now)
        .sort((a, b) => a.due - b.due),
    [store, nowTs],
  );

  const newIds = useCallback(
    (allIds: string[]) => allIds.filter((id) => !store.cards[id] || store.cards[id].status === "new"),
    [store],
  );

  const counts = (() => {
    const all = Object.values(store.cards);
    const now = nowTs;
    let learned = 0, mastered = 0, learning = 0, due = 0;
    for (const c of all) {
      if (c.reps > 0 || c.status === "review") learned++;
      if (masteryOf(c) === "mastered") mastered++;
      if (c.status === "learning") learning++;
      if ((c.reps > 0 || c.status !== "new") && c.due <= now) due++;
    }
    return { tracked: all.length, learned, due, mastered, learning };
  })();

  return {
    cards: store.cards,
    getCard,
    cardOrNew,
    grade,
    markLearned,
    toggleLearned,
    forget,
    resetAll,
    isLearned,
    masteryOf: masteryFn,
    dueCards,
    newIds,
    counts,
  };
}

/** Human-friendly "in 3 days" / "in 12 min" label for a future timestamp. */
export function formatDue(due: number, now: number = Date.now()): string {
  const delta = due - now;
  if (delta <= 0) return "now";
  const mins = Math.round(delta / MINUTE);
  if (mins < 60) return `${mins} min`;
  const hours = Math.round(delta / (60 * MINUTE));
  if (hours < 24) return `${hours} hr${hours === 1 ? "" : "s"}`;
  const days = Math.round(delta / DAY);
  if (days < 30) return `${days} day${days === 1 ? "" : "s"}`;
  const months = Math.round(days / 30);
  return `${months} mo${months === 1 ? "" : "s"}`;
}

/** Preview the interval each grade would produce, for button labels. */
export function gradePreviews(card: Card, now: number = Date.now()): Record<Grade, string> {
  return {
    0: formatDue(schedule(card, 0, now).due, now),
    1: formatDue(schedule(card, 1, now).due, now),
    2: formatDue(schedule(card, 2, now).due, now),
    3: formatDue(schedule(card, 3, now).due, now),
  };
}
