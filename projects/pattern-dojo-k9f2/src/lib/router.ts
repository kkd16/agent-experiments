import { useEffect, useState } from "react";

/** Parsed hash route, e.g. "#/pattern/two-pointers" -> ["pattern","two-pointers"]. */
export function parseHash(): string[] {
  const raw = window.location.hash.replace(/^#\/?/, "").trim();
  if (!raw) return [];
  return raw.split("/").filter(Boolean).map(decodeURIComponent);
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
