import { useCallback, useEffect, useState } from "react";

const KEY = "pattern-dojo:progress:v1";

type Progress = Record<string, boolean>;

function read(): Progress {
  try {
    return JSON.parse(localStorage.getItem(KEY) || "{}");
  } catch {
    return {};
  }
}

function write(p: Progress) {
  try {
    localStorage.setItem(KEY, JSON.stringify(p));
  } catch {
    /* ignore quota / private mode */
  }
  // notify other hook instances in the same tab
  window.dispatchEvent(new CustomEvent("progress-change"));
}

/**
 * Tracks which patterns the learner has marked "got it", persisted to
 * localStorage and synced across components in the same tab.
 */
export function useProgress() {
  const [done, setDone] = useState<Progress>(read);

  useEffect(() => {
    const sync = () => setDone(read());
    window.addEventListener("storage", sync);
    window.addEventListener("progress-change", sync as EventListener);
    return () => {
      window.removeEventListener("storage", sync);
      window.removeEventListener("progress-change", sync as EventListener);
    };
  }, []);

  const toggle = useCallback((id: string) => {
    const next = { ...read() };
    if (next[id]) delete next[id];
    else next[id] = true;
    write(next);
    setDone(next);
  }, []);

  const reset = useCallback(() => {
    write({});
    setDone({});
  }, []);

  const isDone = useCallback((id: string) => !!done[id], [done]);
  const count = Object.keys(done).filter((k) => done[k]).length;

  return { done, isDone, toggle, reset, count };
}
