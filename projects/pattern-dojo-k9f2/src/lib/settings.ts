import { useCallback, useEffect, useState } from "react";

/**
 * User-tunable knobs for the spaced-repetition flow, persisted to localStorage
 * and synced across components. Kept tiny and self-contained.
 */

const KEY = "pattern-dojo:settings:v1";
const EVENT = "pd-settings-change";

export interface Settings {
  /** Max cards reviewed in one session (caps the due queue). */
  sessionSize: number;
  /** Max brand-new patterns introduced in a single "learn ahead" run. */
  newPerDay: number;
}

export const DEFAULTS: Settings = { sessionSize: 20, newPerDay: 6 };

export const LIMITS = {
  sessionSize: { min: 5, max: 50, step: 5 },
  newPerDay: { min: 1, max: 18, step: 1 },
};

function clamp(v: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, v));
}

function read(): Settings {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) {
      const p = JSON.parse(raw) as Partial<Settings>;
      return {
        sessionSize: clamp(Number(p.sessionSize) || DEFAULTS.sessionSize, LIMITS.sessionSize.min, LIMITS.sessionSize.max),
        newPerDay: clamp(Number(p.newPerDay) || DEFAULTS.newPerDay, LIMITS.newPerDay.min, LIMITS.newPerDay.max),
      };
    }
  } catch {
    /* ignore */
  }
  return { ...DEFAULTS };
}

function write(s: Settings) {
  try {
    localStorage.setItem(KEY, JSON.stringify(s));
  } catch {
    /* ignore */
  }
  window.dispatchEvent(new CustomEvent(EVENT));
}

export function useSettings() {
  const [settings, setSettings] = useState<Settings>(read);

  useEffect(() => {
    const sync = () => setSettings(read());
    window.addEventListener(EVENT, sync);
    window.addEventListener("storage", sync);
    return () => {
      window.removeEventListener(EVENT, sync);
      window.removeEventListener("storage", sync);
    };
  }, []);

  const update = useCallback((patch: Partial<Settings>) => {
    const next = { ...read(), ...patch };
    write(next);
    setSettings(next);
  }, []);

  const reset = useCallback(() => {
    write({ ...DEFAULTS });
    setSettings({ ...DEFAULTS });
  }, []);

  return { settings, update, reset };
}
