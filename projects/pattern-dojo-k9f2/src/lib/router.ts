import { useEffect, useState } from "react";

/** Parsed hash route, e.g. "#/pattern/two-pointers" -> ["pattern","two-pointers"]. */
export function parseHash(): string[] {
  const raw = window.location.hash.replace(/^#\/?/, "").trim();
  const path = raw.split("?")[0];
  if (!path) return [];
  return path.split("/").filter(Boolean).map(decodeURIComponent);
}

/** Parse the query portion of the hash, e.g. "#/pattern/x?frame=3" -> {frame:"3"}. */
export function parseHashQuery(): Record<string, string> {
  const raw = window.location.hash.replace(/^#\/?/, "");
  const qi = raw.indexOf("?");
  if (qi < 0) return {};
  const out: Record<string, string> = {};
  for (const pair of raw.slice(qi + 1).split("&")) {
    if (!pair) continue;
    const [k, v = ""] = pair.split("=");
    out[decodeURIComponent(k)] = decodeURIComponent(v);
  }
  return out;
}

/** The current hash without its query string, e.g. "#/pattern/x?frame=3" -> "#/pattern/x". */
export function currentPath(): string {
  return window.location.hash.split("?")[0] || "#/";
}

/** Subscribe to hash changes; returns the current route segments. */
export function useHashRoute(): string[] {
  const [segments, setSegments] = useState<string[]>(parseHash());
  useEffect(() => {
    const onChange = () => {
      setSegments(parseHash());
      window.scrollTo({ top: 0, behavior: "instant" as ScrollBehavior });
    };
    window.addEventListener("hashchange", onChange);
    return () => window.removeEventListener("hashchange", onChange);
  }, []);
  return segments;
}

export function navigate(path: string) {
  const clean = path.startsWith("#") ? path : `#${path}`;
  if (window.location.hash === clean) return;
  window.location.hash = clean;
}

/** Helper to build a hash href for links. */
export function href(path: string): string {
  return path.startsWith("#") ? path : `#${path}`;
}
