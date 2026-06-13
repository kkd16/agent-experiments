import { patterns, levelLabel } from "../data/patterns";
import { useProgress } from "../lib/progress";
import { href } from "../lib/router";

export default function Roadmap() {
  const { isDone, count } = useProgress();
  const sorted = [...patterns].sort((a, b) => a.order - b.order);

  return (
    <div className="container narrow">
      <span className="eyebrow">Suggested order</span>
      <h1>The learning roadmap</h1>
      <p className="muted">
        Patterns build on each other. Work top to bottom: foundational tools first (they show up
        inside everything else), then core techniques, then the advanced patterns that combine
        them. You've learned <b>{count}</b> of <b>{patterns.length}</b>.
      </p>

      <div className="roadmap">
        {sorted.map((p, i) => {
          const done = isDone(p.id);
          const showLevel = i === 0 || sorted[i - 1].level !== p.level;
          return (
            <div key={p.id}>
              {showLevel && <div className="roadmap-level">{levelLabel[p.level]}</div>}
              <a className={`roadmap-item ${done ? "done" : ""}`} href={href(`/pattern/${p.id}`)}>
                <span className="roadmap-num" style={{ borderColor: p.color, color: done ? "#07122b" : p.color, background: done ? p.color : "transparent" }}>
                  {done ? "✓" : p.order}
                </span>
                <span className="roadmap-icon">{p.icon}</span>
                <span className="roadmap-body">
                  <span className="roadmap-name">{p.name}</span>
                  <span className="roadmap-tag muted">{p.tagline}</span>
                </span>
                {p.visualizer && <span className="tag" style={{ color: p.color }}>interactive</span>}
              </a>
            </div>
          );
        })}
      </div>
    </div>
  );
}
