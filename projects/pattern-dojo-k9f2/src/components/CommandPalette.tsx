import { useEffect, useMemo, useRef, useState } from "react";
import { patterns } from "../data/patterns";
import { navigate } from "../lib/router";
import { useTheme } from "../lib/theme";

interface Cmd {
  id: string;
  label: string;
  hint?: string;
  icon: string;
  group: string;
  run: () => void;
}

/** Lightweight subsequence fuzzy match returning a score (lower = better), or null. */
function fuzzy(needle: string, hay: string): number | null {
  if (!needle) return 0;
  const n = needle.toLowerCase();
  const h = hay.toLowerCase();
  let hi = 0;
  let score = 0;
  let prev = -1;
  for (let i = 0; i < n.length; i++) {
    const ch = n[i];
    const found = h.indexOf(ch, hi);
    if (found === -1) return null;
    if (prev >= 0) score += found - prev; // reward adjacency
    prev = found;
    hi = found + 1;
  }
  return score + found0Bonus(h, n);
}
function found0Bonus(h: string, n: string): number {
  return h.startsWith(n) ? -5 : 0;
}

export default function CommandPalette() {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const [sel, setSel] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const { theme, toggle } = useTheme();

  const commands = useMemo<Cmd[]>(() => {
    const pages: Cmd[] = [
      { id: "go-home", label: "All patterns", icon: "◆", group: "Go to", run: () => navigate("/") },
      { id: "go-review", label: "Spaced review", hint: "study due cards", icon: "🗂️", group: "Go to", run: () => navigate("/review") },
      { id: "go-roadmap", label: "Roadmap", icon: "🗺️", group: "Go to", run: () => navigate("/roadmap") },
      { id: "go-quiz", label: "Pattern trainer", icon: "🎯", group: "Go to", run: () => navigate("/quiz") },
      { id: "go-cheat", label: "Complexity cheat-sheet", icon: "📋", group: "Go to", run: () => navigate("/cheatsheet") },
      { id: "go-stats", label: "Progress & stats", hint: "heatmap, backup", icon: "📊", group: "Go to", run: () => navigate("/stats") },
      { id: "go-settings", label: "Settings", hint: "session size, theme", icon: "⚙️", group: "Go to", run: () => navigate("/settings") },
    ];
    const actions: Cmd[] = [
      {
        id: "theme",
        label: theme === "dark" ? "Switch to light theme" : "Switch to dark theme",
        icon: theme === "dark" ? "☀️" : "🌙",
        group: "Actions",
        run: toggle,
      },
    ];
    const pats: Cmd[] = patterns
      .slice()
      .sort((a, b) => a.order - b.order)
      .map((p) => ({
        id: `p-${p.id}`,
        label: p.name,
        hint: p.tagline,
        icon: p.icon,
        group: "Patterns",
        run: () => navigate(`/pattern/${p.id}`),
      }));
    return [...pages, ...actions, ...pats];
  }, [theme, toggle]);

  const results = useMemo(() => {
    if (!q.trim()) return commands;
    const scored: { c: Cmd; s: number }[] = [];
    for (const c of commands) {
      const s = fuzzy(q, `${c.label} ${c.hint ?? ""}`);
      if (s !== null) scored.push({ c, s });
    }
    scored.sort((a, b) => a.s - b.s);
    return scored.map((x) => x.c);
  }, [q, commands]);

  // Global open shortcut. Resetting query/selection happens in this event
  // handler (not in an effect body) so opening always starts clean.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setOpen((o) => {
          if (!o) {
            setQ("");
            setSel(0);
          }
          return !o;
        });
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // Focus the input once the palette mounts (DOM side-effect only).
  useEffect(() => {
    if (open) requestAnimationFrame(() => inputRef.current?.focus());
  }, [open]);

  // keep the selected row in view
  useEffect(() => {
    const el = listRef.current?.querySelector<HTMLElement>(`[data-idx="${sel}"]`);
    el?.scrollIntoView({ block: "nearest" });
  }, [sel]);

  if (!open) return null;

  const choose = (c?: Cmd) => {
    if (!c) return;
    c.run();
    setOpen(false);
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") setOpen(false);
    else if (e.key === "ArrowDown") {
      e.preventDefault();
      setSel((s) => Math.min(results.length - 1, s + 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setSel((s) => Math.max(0, s - 1));
    } else if (e.key === "Enter") {
      e.preventDefault();
      choose(results[sel]);
    }
  };

  let lastGroup = "";

  return (
    <div className="cmdk-overlay" onMouseDown={() => setOpen(false)}>
      <div className="cmdk" onMouseDown={(e) => e.stopPropagation()} onKeyDown={onKeyDown}>
        <div className="cmdk-search">
          <span className="cmdk-search-icon">⌕</span>
          <input
            ref={inputRef}
            value={q}
            onChange={(e) => {
              setQ(e.target.value);
              setSel(0);
            }}
            placeholder="Jump to a pattern, page or action…"
            aria-label="Command palette search"
          />
          <span className="kbd">Esc</span>
        </div>
        <div className="cmdk-list" ref={listRef}>
          {results.length === 0 && <div className="cmdk-empty">No matches</div>}
          {results.map((c, idx) => {
            const header = c.group !== lastGroup ? c.group : null;
            lastGroup = c.group;
            return (
              <div key={c.id}>
                {header && <div className="cmdk-group">{header}</div>}
                <button
                  data-idx={idx}
                  className={`cmdk-item ${idx === sel ? "active" : ""}`}
                  onMouseMove={() => setSel(idx)}
                  onClick={() => choose(c)}
                >
                  <span className="cmdk-icon">{c.icon}</span>
                  <span className="cmdk-label">{c.label}</span>
                  {c.hint && <span className="cmdk-hint">{c.hint}</span>}
                </button>
              </div>
            );
          })}
        </div>
        <div className="cmdk-foot">
          <span><span className="kbd">↑</span><span className="kbd">↓</span> navigate</span>
          <span><span className="kbd">↵</span> open</span>
          <span><span className="kbd">⌘</span><span className="kbd">K</span> toggle</span>
        </div>
      </div>
    </div>
  );
}
