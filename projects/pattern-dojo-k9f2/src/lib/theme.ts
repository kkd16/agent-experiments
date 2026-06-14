import { useCallback, useEffect, useState } from "react";

const KEY = "pattern-dojo:theme";
const EVENT = "pd-theme-change";

export type Theme = "dark" | "light";

function systemPref(): Theme {
  try {
    return window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
  } catch {
    return "dark";
  }
}

function read(): Theme {
  try {
    const v = localStorage.getItem(KEY);
    if (v === "light" || v === "dark") return v;
  } catch {
    /* ignore */
  }
  return systemPref();
}

/** Apply the theme to <html> so CSS variable overrides take effect globally. */
export function applyTheme(theme: Theme) {
  document.documentElement.dataset.theme = theme;
  document.documentElement.style.colorScheme = theme;
}

/** Call once at boot, before React renders, to avoid a flash of the wrong theme. */
export function initTheme() {
  applyTheme(read());
}

export function useTheme() {
  const [theme, setTheme] = useState<Theme>(read);

  useEffect(() => {
    const sync = () => setTheme(read());
    window.addEventListener(EVENT, sync);
    window.addEventListener("storage", sync);
    return () => {
      window.removeEventListener(EVENT, sync);
      window.removeEventListener("storage", sync);
    };
  }, []);

  const set = useCallback((t: Theme) => {
    try {
      localStorage.setItem(KEY, t);
    } catch {
      /* ignore */
    }
    applyTheme(t);
    setTheme(t);
    window.dispatchEvent(new CustomEvent(EVENT));
  }, []);

  const toggle = useCallback(() => set(read() === "dark" ? "light" : "dark"), [set]);

  return { theme, set, toggle };
}
