import type { Pattern } from "../data/types";
import { levelLabel } from "../data/patterns";
import { href } from "../lib/router";

export function ProgressDonut({ done, total }: { done: number; total: number }) {
  const pct = total === 0 ? 0 : Math.round((done / total) * 100);
  const r = 34;
  const c = 2 * Math.PI * r;
  const offset = c - (pct / 100) * c;
  return (
    <svg width="86" height="86" viewBox="0 0 86 86">
      <circle cx="43" cy="43" r={r} fill="none" stroke="var(--border)" strokeWidth="8" />
      <circle
        cx="43"
        cy="43"
        r={r}
        fill="none"
        stroke="url(#grad)"
        strokeWidth="8"
        strokeLinecap="round"
        strokeDasharray={c}
        strokeDashoffset={offset}
        transform="rotate(-90 43 43)"
        style={{ transition: "stroke-dashoffset 0.5s ease" }}
      />
      <defs>
        <linearGradient id="grad" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stopColor="var(--accent)" />
          <stop offset="100%" stopColor="var(--accent-2)" />
        </linearGradient>
      </defs>
      <text x="43" y="40" textAnchor="middle" fontSize="18" fontWeight="800" fill="var(--text)">
        {pct}%
      </text>
      <text x="43" y="56" textAnchor="middle" fontSize="9" fill="var(--text-faint)">
        {done}/{total}
      </text>
    </svg>
  );
}

export function PatternCard({ p, done }: { p: Pattern; done: boolean }) {
  return (
    <a className="pattern-card" href={href(`/pattern/${p.id}`)} style={{ borderTopColor: p.color }}>
      <div className="pattern-card-top">
        <span className="pattern-icon" style={{ background: `${p.color}22`, borderColor: `${p.color}55` }}>
          {p.icon}
        </span>
        {done && <span className="done-pip" title="Marked as learned">✓</span>}
      </div>
      <h3>{p.name}</h3>
      <p className="muted">{p.tagline}</p>
      <div className="row" style={{ marginTop: "auto", gap: 6 }}>
        <span className="tag">{levelLabel[p.level]}</span>
        {p.visualizer && <span className="tag" style={{ color: p.color }}>interactive</span>}
      </div>
    </a>
  );
}

export function Difficulty({ d }: { d: "easy" | "medium" | "hard" }) {
  return <span className={`diff ${d}`}>{d}</span>;
}
