import { useCallback, useEffect, useState } from "react";
import type { LiveSession, ProblemAttempt } from "./types";

/**
 * Persistence for the Interview Room.
 *
 * Two things are stored: the single *live* session (so a page refresh mid-
 * interview never loses your code or the countdown) and the append-only
 * *history* of finished sessions (for the report cards and analytics). Both
 * sync across components in a tab via a custom event, and everything is wrapped
 * in try/catch so the sandboxed catalog thumbnail still renders if storage
 * throws.
 */

const KEY = "pattern-dojo:interview:v1";
const EVENT = "pd-interview-change";
const HISTORY_CAP = 40;

interface Store {
  v: 1;
  live: LiveSession | null;
  history: LiveSession[];
}

function fresh(): Store {
  return { v: 1, live: null, history: [] };
}

function read(): Store {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Store;
      if (parsed && Array.isArray(parsed.history)) {
        return { v: 1, live: parsed.live ?? null, history: parsed.history };
      }
    }
  } catch {
    /* ignore */
  }
  return fresh();
}

function write(store: Store, notify = true) {
  try {
    localStorage.setItem(KEY, JSON.stringify(store));
  } catch {
    /* ignore quota / private mode */
  }
  if (notify) window.dispatchEvent(new CustomEvent(EVENT));
}

export interface InterviewApi {
  live: LiveSession | null;
  history: LiveSession[];
  /** replace the live session wholesale (also used to clear it with null). */
  setLive: (s: LiveSession | null) => void;
  /** mutate the live session in place and persist. */
  updateLive: (mut: (s: LiveSession) => void) => void;
  /** shallow-merge fields into one problem's attempt. */
  patchAttempt: (problemId: string, patch: Partial<ProblemAttempt>) => void;
  /** finalise the live session: stamp it, push to history, clear live. */
  finish: (reason: LiveSession["endReason"]) => LiveSession | null;
  /** look up a finished session by id. */
  byId: (id: string) => LiveSession | undefined;
  /** discard the live session without recording it. */
  abandon: () => void;
  clearHistory: () => void;
}

export function useInterview(): InterviewApi {
  const [store, setStore] = useState<Store>(read);

  useEffect(() => {
    const sync = () => setStore(read());
    window.addEventListener(EVENT, sync);
    window.addEventListener("storage", sync);
    return () => {
      window.removeEventListener(EVENT, sync);
      window.removeEventListener("storage", sync);
    };
  }, []);

  const commit = useCallback((mut: (s: Store) => void) => {
    const cur = read();
    mut(cur);
    write(cur);
    setStore(cur);
  }, []);

  const setLive = useCallback(
    (s: LiveSession | null) => commit((st) => { st.live = s; }),
    [commit],
  );

  const updateLive = useCallback(
    (mut: (s: LiveSession) => void) =>
      commit((st) => { if (st.live) mut(st.live); }),
    [commit],
  );

  const patchAttempt = useCallback(
    (problemId: string, patch: Partial<ProblemAttempt>) =>
      commit((st) => {
        const live = st.live;
        if (!live) return;
        const cur = live.attempts[problemId];
        if (!cur) return;
        live.attempts[problemId] = { ...cur, ...patch };
      }),
    [commit],
  );

  const finish = useCallback(
    (reason: LiveSession["endReason"]) => {
      let done: LiveSession | null = null;
      commit((st) => {
        if (!st.live) return;
        done = { ...st.live, finishedAt: st.live.finishedAt ?? Date.now(), endReason: reason };
        st.history = [done, ...st.history].slice(0, HISTORY_CAP);
        st.live = null;
      });
      return done;
    },
    [commit],
  );

  const abandon = useCallback(() => commit((st) => { st.live = null; }), [commit]);

  const clearHistory = useCallback(() => commit((st) => { st.history = []; }), [commit]);

  const byId = useCallback(
    (id: string) => {
      if (store.live?.id === id) return store.live;
      return store.history.find((s) => s.id === id);
    },
    [store],
  );

  return {
    live: store.live,
    history: store.history,
    setLive,
    updateLive,
    patchAttempt,
    finish,
    byId,
    abandon,
    clearHistory,
  };
}
