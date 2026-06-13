import { patterns, patternById, levelLabel } from "../data/patterns";
import { useProgress } from "../lib/progress";
import CodeBlock from "../components/CodeBlock";
import { Difficulty } from "../components/ui";
import { Visualizer } from "../visualizers";
import { hasVisualizer } from "../visualizers/keys";
import { href, navigate } from "../lib/router";

export default function PatternDetail({ id }: { id: string }) {
  const p = patternById(id);
  const { isDone, toggle } = useProgress();

  if (!p) {
    return (
      <div className="container">
        <div className="card center">
          <h2>Pattern not found</h2>
          <a className="btn" href={href("/")}>← Back home</a>
        </div>
      </div>
    );
  }

  const sorted = [...patterns].sort((a, b) => a.order - b.order);
  const pos = sorted.findIndex((x) => x.id === p.id);
  const prev = sorted[pos - 1];
  const next = sorted[pos + 1];
  const showViz = hasVisualizer(p.visualizer);
  const done = isDone(p.id);

  return (
    <div className="container detail">
      <a className="back-link" href={href("/")}>← All patterns</a>

      <header className="detail-head" style={{ borderColor: `${p.color}44` }}>
        <span className="pattern-icon lg" style={{ background: `${p.color}22`, borderColor: `${p.color}66` }}>
          {p.icon}
        </span>
        <div style={{ flex: 1, minWidth: 200 }}>
          <div className="row" style={{ gap: 8 }}>
            <span className="chip" style={{ color: p.color, borderColor: `${p.color}55` }}>
              {levelLabel[p.level]}
            </span>
            <span className="faint" style={{ fontSize: "0.82rem" }}>Pattern {p.order} of {patterns.length}</span>
          </div>
          <h1 style={{ margin: "8px 0 4px" }}>{p.name}</h1>
          <p className="muted" style={{ margin: 0 }}>{p.tagline}</p>
        </div>
        <button className={`btn ${done ? "" : "primary"}`} onClick={() => toggle(p.id)}>
          {done ? "✓ Learned" : "Mark as learned"}
        </button>
      </header>

      <section className="detail-block">
        <span className="eyebrow">The intuition</span>
        <h2>Why it works</h2>
        {p.intuition.map((para, i) => (
          <p key={i} className="prose">{para}</p>
        ))}
        <div className="mental-model" style={{ borderColor: `${p.color}55` }}>
          <span className="mm-label">🧠 Mental model</span>
          <p>{p.mentalModel}</p>
        </div>
      </section>

      {showViz && (
        <section className="detail-block">
          <span className="eyebrow">See it move</span>
          <h2>Interactive walkthrough</h2>
          <p className="muted" style={{ marginTop: 0 }}>
            Press play, or step through one frame at a time. Watch what changes and read the caption.
          </p>
          <Visualizer vizKey={p.visualizer} />
        </section>
      )}

      <div className="two-col">
        <section className="detail-block">
          <span className="eyebrow">Pattern radar</span>
          <h2>When to reach for it</h2>
          <ul className="signal-list">
            {p.recognize.map((r, i) => (
              <li key={i}>{r}</li>
            ))}
          </ul>
        </section>

        <section className="detail-block">
          <span className="eyebrow">Mechanics</span>
          <h2>How it works</h2>
          <ol className="step-list">
            {p.howItWorks.map((s, i) => (
              <li key={i}>{s}</li>
            ))}
          </ol>
        </section>
      </div>

      <section className="detail-block">
        <span className="eyebrow">The template</span>
        <h2>Canonical code</h2>
        <CodeBlock code={p.template.code} label={p.template.label} lang={p.template.lang} />
      </section>

      <div className="two-col">
        <section className="detail-block">
          <span className="eyebrow">Cost</span>
          <h2>Complexity</h2>
          <table className="cx-table">
            <thead>
              <tr>
                <th>Approach</th>
                <th>Time</th>
                <th>Space</th>
              </tr>
            </thead>
            <tbody>
              {p.complexity.map((row, i) => (
                <tr key={i}>
                  <td>{row.approach}</td>
                  <td className="mono">{row.time}</td>
                  <td className="mono">{row.space}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>

        <section className="detail-block">
          <span className="eyebrow">Watch out</span>
          <h2>Common pitfalls</h2>
          <ul className="pitfall-list">
            {p.pitfalls.map((pit, i) => (
              <li key={i}>{pit}</li>
            ))}
          </ul>
        </section>
      </div>

      <section className="detail-block">
        <span className="eyebrow">Practice</span>
        <h2>Representative problems</h2>
        <p className="muted" style={{ marginTop: 0 }}>
          These NeetCode-150 problems exercise different variants of the pattern. The goal isn't to
          memorize them — it's to feel the pattern underneath.
        </p>
        <div className="problem-grid">
          {p.problems.map((prob, i) => (
            <div key={i} className="problem-row">
              <div>
                <div style={{ fontWeight: 600 }}>{prob.name}</div>
                {prob.note && <div className="faint" style={{ fontSize: "0.8rem" }}>{prob.note}</div>}
              </div>
              <Difficulty d={prob.difficulty} />
            </div>
          ))}
        </div>
      </section>

      {p.related.length > 0 && (
        <section className="detail-block">
          <span className="eyebrow">Connections</span>
          <h2>Related patterns</h2>
          <div className="row">
            {p.related.map((rid) => {
              const rp = patternById(rid);
              if (!rp) return null;
              return (
                <a key={rid} className="related-chip" href={href(`/pattern/${rid}`)}>
                  <span>{rp.icon}</span> {rp.name}
                </a>
              );
            })}
          </div>
        </section>
      )}

      <nav className="detail-nav">
        {prev ? (
          <button className="btn" onClick={() => navigate(`/pattern/${prev.id}`)}>
            ← {prev.icon} {prev.name}
          </button>
        ) : (
          <span />
        )}
        {next ? (
          <button className="btn primary" onClick={() => navigate(`/pattern/${next.id}`)}>
            {next.icon} {next.name} →
          </button>
        ) : (
          <a className="btn primary" href={href("/quiz")}>
            Test yourself in the trainer →
          </a>
        )}
      </nav>
    </div>
  );
}
