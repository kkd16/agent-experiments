import { patterns, levelLabel } from "../data/patterns";
import { useSRS } from "../lib/srs";
import { useStreak } from "../lib/streak";
import { patternOfTheDay } from "../lib/daily";
import { PatternCard, ProgressDonut } from "../components/ui";
import { href } from "../lib/router";
import type { Pattern } from "../data/types";

const order: Pattern["level"][] = ["foundational", "core", "advanced"];

export default function Home() {
  const srs = useSRS();
  const { current: streak, longest } = useStreak();
  const { learned, due, mastered, learning } = srs.counts;
  const potd = patternOfTheDay(patterns);

  const grouped = order.map((lvl) => ({
    lvl,
    items: patterns.filter((p) => p.level === lvl).sort((a, b) => a.order - b.order),
  }));

  return (
    <div className="container">
      <section className="hero">
        <div className="hero-text">
          <span className="eyebrow">Interview pattern dojo</span>
          <h1>
            Master the <span className="grad-text">18 patterns</span> behind the NeetCode 150.
          </h1>
          <p className="muted hero-sub">
            Stop memorizing solutions. Learn to <b>recognize the pattern</b> in any problem,
            understand <b>why</b> it works through interactive visualizations, then lock it in with
            <b> spaced repetition</b> so it's there when the interview is.
          </p>
          <div className="row">
            <a className="btn primary" href={href(`/pattern/${patterns[0].id}`)}>
              Start learning →
            </a>
            {due > 0 && (
              <a className="btn" href={href("/review")}>
                Review {due} due →
              </a>
            )}
            <a className="btn ghost" href={href("/quiz")}>
              Try the trainer
            </a>
          </div>
        </div>
        <div className="hero-progress card">
          <ProgressDonut done={learned} total={patterns.length} />
          <div>
            <div style={{ fontWeight: 700 }}>Your progress</div>
            <div className="muted" style={{ fontSize: "0.88rem" }}>
              {learned === 0
                ? "Mark patterns as you learn them — saved in your browser."
                : learned === patterns.length
                  ? "All patterns learned. Keep them sharp in review! 🎉"
                  : `${patterns.length - learned} pattern${patterns.length - learned === 1 ? "" : "s"} to go.`}
            </div>
            {learned > 0 && (
              <div className="mastery-legend">
                {mastered > 0 && <span><b>{mastered}</b> mastered</span>}
                {learning > 0 && <span><b>{learning}</b> learning</span>}
                {due > 0 && <span className="accent-text"><b>{due}</b> due</span>}
              </div>
            )}
          </div>
        </div>
      </section>

      <section className="today-strip">
        <a className="today-card potd" href={href(`/pattern/${potd.id}`)} style={{ borderColor: `${potd.color}55` }}>
          <span className="eyebrow">Pattern of the day</span>
          <div className="today-potd-body">
            <span className="pattern-icon" style={{ background: `${potd.color}22`, borderColor: `${potd.color}55` }}>
              {potd.icon}
            </span>
            <div>
              <div className="today-potd-name">{potd.name}</div>
              <div className="muted" style={{ fontSize: "0.85rem" }}>{potd.tagline}</div>
            </div>
          </div>
        </a>
        <a className="today-card review-cta" href={href("/review")}>
          <span className="eyebrow">Spaced review</span>
          <div className="today-review-num">{due}</div>
          <div className="muted" style={{ fontSize: "0.85rem" }}>
            {due > 0 ? `pattern${due === 1 ? "" : "s"} due now →` : "all caught up — learn ahead →"}
          </div>
        </a>
        <div className="today-card streak-card">
          <span className="eyebrow">Daily streak</span>
          <div className="today-streak-num">{streak} {streak > 0 && "🔥"}</div>
          <div className="muted" style={{ fontSize: "0.85rem" }}>
            {streak === 0 ? "review a pattern to start a streak" : `best: ${longest} day${longest === 1 ? "" : "s"}`}
          </div>
        </div>
      </section>

      <section className="features">
        <Feature icon="🧠" title="Intuition first" desc="Each pattern starts with the 'aha' — a sticky mental model and why the trick works, not just the code." />
        <Feature icon="🎬" title="Interactive visualizers" desc="Step through pointers, windows, recursion trees and DP tables frame by frame, with keyboard control." />
        <Feature icon="🔁" title="Spaced repetition" desc="Mark a pattern learned and it enters a review schedule that resurfaces it right before you'd forget." />
        <Feature icon="🔍" title="Pattern recognition" desc="Train the real interview skill: reading a problem and naming the pattern before you code." />
      </section>

      {grouped.map(({ lvl, items }) => (
        <section key={lvl} className="pattern-section">
          <div className="spread" style={{ marginBottom: 14 }}>
            <h2 style={{ margin: 0 }}>{levelLabel[lvl]}</h2>
            <span className="muted" style={{ fontSize: "0.86rem" }}>
              {items.filter((p) => srs.isLearned(p.id)).length}/{items.length} learned
            </span>
          </div>
          <div className="pattern-grid">
            {items.map((p) => (
              <PatternCard key={p.id} p={p} done={srs.isLearned(p.id)} mastery={srs.masteryOf(p.id)} />
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}

function Feature({ icon, title, desc }: { icon: string; title: string; desc: string }) {
  return (
    <div className="feature card">
      <div className="feature-icon">{icon}</div>
      <div>
        <h4 style={{ margin: "0 0 4px" }}>{title}</h4>
        <p className="muted" style={{ margin: 0, fontSize: "0.88rem" }}>{desc}</p>
      </div>
    </div>
  );
}
