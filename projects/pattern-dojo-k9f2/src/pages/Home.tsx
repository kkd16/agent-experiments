import { patterns, levelLabel } from "../data/patterns";
import { useProgress } from "../lib/progress";
import { PatternCard, ProgressDonut } from "../components/ui";
import { href } from "../lib/router";
import type { Pattern } from "../data/types";

const order: Pattern["level"][] = ["foundational", "core", "advanced"];

export default function Home() {
  const { isDone, count } = useProgress();
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
            understand <b>why</b> it works through interactive visualizations, and carry that
            intuition into the interview.
          </p>
          <div className="row">
            <a className="btn primary" href={href(`/pattern/${patterns[0].id}`)}>
              Start learning →
            </a>
            <a className="btn" href={href("/roadmap")}>
              See the roadmap
            </a>
            <a className="btn ghost" href={href("/quiz")}>
              Try the trainer
            </a>
          </div>
        </div>
        <div className="hero-progress card">
          <ProgressDonut done={count} total={patterns.length} />
          <div>
            <div style={{ fontWeight: 700 }}>Your progress</div>
            <div className="muted" style={{ fontSize: "0.88rem" }}>
              {count === 0
                ? "Mark patterns as you learn them — saved in your browser."
                : count === patterns.length
                  ? "All patterns learned. You're interview-ready! 🎉"
                  : `${patterns.length - count} pattern${patterns.length - count === 1 ? "" : "s"} to go.`}
            </div>
          </div>
        </div>
      </section>

      <section className="features">
        <Feature icon="🧠" title="Intuition first" desc="Each pattern starts with the 'aha' — a sticky mental model and why the trick works, not just the code." />
        <Feature icon="🎬" title="Interactive visualizers" desc="Step through pointers, windows, recursion trees and DP tables frame by frame." />
        <Feature icon="🔍" title="Pattern recognition" desc="Train the real interview skill: reading a problem and naming the pattern before you code." />
        <Feature icon="📈" title="Progress tracking" desc="Tick off patterns as you internalize them; your dojo remembers where you are." />
      </section>

      {grouped.map(({ lvl, items }) => (
        <section key={lvl} className="pattern-section">
          <div className="spread" style={{ marginBottom: 14 }}>
            <h2 style={{ margin: 0 }}>{levelLabel[lvl]}</h2>
            <span className="muted" style={{ fontSize: "0.86rem" }}>
              {items.filter((p) => isDone(p.id)).length}/{items.length} learned
            </span>
          </div>
          <div className="pattern-grid">
            {items.map((p) => (
              <PatternCard key={p.id} p={p} done={isDone(p.id)} />
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
