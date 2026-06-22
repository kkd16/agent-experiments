import { useCallback, useEffect, useState } from "react";

/**
 * Persistence for the Code Dojo: per-challenge solve progress (synced across
 * components via a custom event, like the SRS store) and per-challenge editor
 * drafts (written straight through, no React state, so typing never re-renders
 * the rest of the app). Everything is wrapped in try/catch so the catalog's
 * sandboxed thumbnail — where storage can throw — still renders.
 */

const KEY = "pattern-dojo:dojo:v1";
const EVENT = "pd-dojo-change";

export interface ChallengeProgress {
  solved: boolean;
  attempts: number;
  solvedAt?: number;
  /** fastest total judge time across solves, ms */
  bestMs?: number;
}

interface DojoStore {
  v: 1;
  progress: Record<string, ChallengeProgress>;
  drafts: Record<string, string>;
}

function fresh(): DojoStore {
  return { v: 1, progress: {}, drafts: {} };
}

function read(): DojoStore {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as DojoStore;
      if (parsed && parsed.progress) {
        return { v: 1, progress: parsed.progress, drafts: parsed.drafts ?? {} };
      }
    }
  } catch {
    /* ignore */
  }
  return fresh();
}

function write(store: DojoStore, notify = true) {
  try {
    localStorage.setItem(KEY, JSON.stringify(store));
  } catch {
    /* ignore quota / private mode */
  }
  if (notify) window.dispatchEvent(new CustomEvent(EVENT));
}

// --- Drafts: read/write directly, no event (the editor owns its own state) ---

export function loadDraft(id: string): string | null {
  const d = read().drafts[id];
  return typeof d === "string" ? d : null;
}

export function saveDraft(id: string, code: string) {
  const store = read();
  store.drafts[id] = code;
  write(store, false);
}

export function clearDraft(id: string) {
  const store = read();
  if (id in store.drafts) {
    delete store.drafts[id];
    write(store, false);
  }
}

// --- Progress: event-synced hook ---

export interface DojoApi {
  progress: Record<string, ChallengeProgress>;
  isSolved: (id: string) => boolean;
  attemptsOf: (id: string) => number;
  /** record a failed/partial run (bumps attempt count) */
  recordAttempt: (id: string) => void;
  /** record a full pass; returns true if this was the first solve */
  recordSolve: (id: string, totalMs: number) => boolean;
  reset: () => void;
  solvedCount: number;
  solvedByPattern: (patternIdOf: (challengeId: string) => string | undefined) => Record<string, number>;
}

export function useDojo(): DojoApi {
  const [store, setStore] = useState<DojoStore>(read);

  useEffect(() => {
    const sync = () => setStore(read());
    window.addEventListener(EVENT, sync);
    window.addEventListener("storage", sync);
    return () => {
      window.removeEventListener(EVENT, sync);
      window.removeEventListener("storage", sync);
    };
  }, []);

  const commit = useCallback((mut: (s: DojoStore) => void) => {
    const cur = read();
    mut(cur);
    write(cur);
    setStore(cur);
  }, []);

  const isSolved = useCallback((id: string) => !!store.progress[id]?.solved, [store]);
  const attemptsOf = useCallback((id: string) => store.progress[id]?.attempts ?? 0, [store]);

  const recordAttempt = useCallback(
    (id: string) => {
      commit((s) => {
        const p = s.progress[id] ?? { solved: false, attempts: 0 };
        s.progress[id] = { ...p, attempts: p.attempts + 1 };
      });
    },
    [commit],
  );

  const recordSolve = useCallback(
    (id: string, totalMs: number) => {
      let firstSolve = false;
      commit((s) => {
        const p = s.progress[id] ?? { solved: false, attempts: 0 };
        firstSolve = !p.solved;
        s.progress[id] = {
          solved: true,
          attempts: p.attempts + 1,
          solvedAt: p.solvedAt ?? Date.now(),
          bestMs: p.bestMs === undefined ? totalMs : Math.min(p.bestMs, totalMs),
        };
      });
      return firstSolve;
    },
    [commit],
  );

  const reset = useCallback(() => {
    const cur = read();
    write({ v: 1, progress: {}, drafts: cur.drafts });
    setStore(read());
  }, []);

  const solvedCount = Object.values(store.progress).filter((p) => p.solved).length;

  const solvedByPattern = useCallback(
    (patternIdOf: (challengeId: string) => string | undefined) => {
      const out: Record<string, number> = {};
      for (const [id, p] of Object.entries(store.progress)) {
        if (!p.solved) continue;
        const pid = patternIdOf(id);
        if (pid) out[pid] = (out[pid] ?? 0) + 1;
      }
      return out;
    },
    [store],
  );

  return {
    progress: store.progress,
    isSolved,
    attemptsOf,
    recordAttempt,
    recordSolve,
    reset,
    solvedCount,
    solvedByPattern,
  };
}
