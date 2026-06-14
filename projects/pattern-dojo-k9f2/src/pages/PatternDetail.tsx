import { useState } from "react";
import { patterns, patternById, levelLabel } from "../data/patterns";
import { useSRS, gradePreviews, formatDue, MASTERY_LABEL } from "../lib/srs";
import type { Grade } from "../lib/srs";
import { useStreak } from "../lib/streak";
import { approachFor } from "../data/approaches";
import type { Problem } from "../data/types";
import CodeBlock from "../components/CodeBlock";
import { Difficulty } from "../components/ui";
import { Visualizer } from "../visualizers";
import { hasVisualizer } from "../visualizers/keys";
import { href, navigate } from "../lib/router";

const GRADES: { g: Grade; label: string; cls: string }[] = [
  { g: 0, label: "Again", cls: "again" },
  { g: 1, label: "Hard", cls: "hard" },
  { g: 2, label: "Good", cls: "good" },
  { g: 3, label: "Easy", cls: "easy" },
];

export default function PatternDetail({ id }: { id: string }) {
  const p = patternById(id);
  const srs = useSRS();
  const { recordToday } = useStreak();

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

  const card = srs.cardOrNew(p.id);
  const tracked = srs.isLearned(p.id);
  const mastery = srs.masteryOf(p.id);
  const previews = gradePreviews(card);

  const doGrade = (g: Grade) => {
    srs.grade(p.id, g);
    recordToday();
  };

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
            {tracked && <span className={`mastery-badge ${mastery}`}>{MASTERY_LABEL[mastery]}</span>}
          </div>
          <h1 style={{ margin: "8px 0 4px" }}>{p.name}</h1>
          <p className="muted" style={{ margin: 0 }}>{p.tagline}</p>
        </div>
        {!tracked && (
          <button
            className="btn primary"
            onClick={() => {
              srs.markLearned(p.id);
              recordToday();
            }}
          >
            Mark as learned
          </button>
        )}
      </header>

      {tracked && (
        <section className="study-box card">
          <div className="study-status">
            <span className="study-dot" data-m={mastery} />
            <div>
              <div style={{ fontWeight: 700 }}>
                {MASTERY_LABEL[mastery]} · next review in {formatDue(card.due)}
              </div>
              <div className="faint" style={{ fontSize: "0.82rem" }}>
                {card.reps} review{card.reps === 1 ? "" : "s"}
                {card.lapses > 0 && ` · ${card.lapses} lapse${card.lapses === 1 ? "" : "s"}`}
                {" · "}
                <button className="linklike" onClick={() => srs.forget(p.id)}>reset</button>
              </div>
            </div>
          </div>
          <div className="study-grades">
            <span className="grade-prompt">Recall it now? Grade yourself:</span>
            <div className="grade-buttons compact">
              {GRADES.map((m) => (
                <button key={m.g} className={`grade-btn ${m.cls}`} onClick={() => doGrade(m.g)}>
                  <span className="grade-label">{m.label}</span>
                  <span className="grade-next">{previews[m.g]}</span>
                </button>
              ))}
            </div>
          </div>
        </section>
      )}

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
            Press play, or step through one frame at a time — use the keyboard, and share a link to any step.
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
          These NeetCode-150 problems exercise different variants of the pattern. Stuck? Reveal a
          hint first, then the guided approach — the goal is to feel the pattern underneath.
        </p>
        <div className="problem-grid">
          {p.problems.map((prob, i) => (
            <ProblemRow key={i} patternId={p.id} prob={prob} color={p.color} />
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

function ProblemRow({ patternId, prob, color }: { patternId: string; prob: Problem; color: string }) {
  const [open, setOpen] = useState(false);
  const a = approachFor(patternId, prob.name);
  const hint = prob.hint ?? a?.hint;
  const approach = prob.approach ?? a?.approach;
  const hasGuide = !!(hint || approach);

  return (
    <div className={`problem-row ${open ? "open" : ""}`}>
      <div className="problem-row-head">
        <div>
          <div style={{ fontWeight: 600 }}>{prob.name}</div>
          {prob.note && <div className="faint" style={{ fontSize: "0.8rem" }}>{prob.note}</div>}
        </div>
        <div className="row" style={{ gap: 8 }}>
          <Difficulty d={prob.difficulty} />
          {hasGuide && (
            <button
              className="reveal-btn"
              onClick={() => setOpen((o) => !o)}
              aria-expanded={open}
              style={open ? { borderColor: color, color } : undefined}
            >
              {open ? "Hide" : "Approach"} {open ? "▴" : "▾"}
            </button>
          )}
        </div>
      </div>
      {open && hasGuide && (
        <div className="problem-guide" style={{ borderColor: `${color}44` }}>
          {hint && (
            <div className="guide-hint">
              <span className="guide-label">💡 Hint</span> {hint}
            </div>
          )}
          {approach && (
            <div className="guide-approach">
              <span className="guide-label">🧭 Approach</span> {approach}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
