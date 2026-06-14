import { useEffect, useMemo, useState } from "react";
import { patterns, patternById } from "../data/patterns";
import { useSRS, gradePreviews, formatDue, masteryOf } from "../lib/srs";
import type { Grade } from "../lib/srs";
import { useStreak } from "../lib/streak";
import { href, navigate } from "../lib/router";
import { Difficulty } from "../components/ui";

const GRADE_META: { g: Grade; label: string; key: string; cls: string }[] = [
  { g: 0, label: "Again", key: "1", cls: "again" },
  { g: 1, label: "Hard", key: "2", cls: "hard" },
  { g: 2, label: "Good", key: "3", cls: "good" },
  { g: 3, label: "Easy", key: "4", cls: "easy" },
];

/** Surface the patterns you struggle with first: more lapses, lower ease, more overdue. */
function weakFirst(cards: { id: string; lapses: number; ease: number; due: number }[]): string[] {
  return cards
    .slice()
    .sort((a, b) => b.lapses - a.lapses || a.ease - b.ease || a.due - b.due)
    .map((c) => c.id);
}

export default function Review() {
  const srs = useSRS();
  const { current: streak, recordToday } = useStreak();

  // Build a session queue ONCE per mount: due cards first, then optionally new
  // ones to learn ahead. We freeze the id list so grading doesn't reshuffle it.
  const [queue, setQueue] = useState<string[]>(() => weakFirst(srs.dueCards()));
  const [pos, setPos] = useState(0);
  const [flipped, setFlipped] = useState(false);
  const [reviewed, setReviewed] = useState(0);
  const [mode, setMode] = useState<"due" | "ahead" | null>(() =>
    srs.dueCards().length ? "due" : null,
  );

  const startAhead = () => {
    const fresh = srs.newIds(patterns.map((p) => p.id)).slice(0, 6);
    if (fresh.length) {
      setQueue(fresh);
      setPos(0);
      setReviewed(0);
      setFlipped(false);
      setMode("ahead");
    }
  };

  const reviewAll = () => {
    // Cram: every tracked pattern, due or not, ordered by soonest due.
    const all = Object.values(srs.cards)
      .sort((a, b) => a.due - b.due)
      .map((c) => c.id);
    if (all.length) {
      setQueue(all);
      setPos(0);
      setReviewed(0);
      setFlipped(false);
      setMode("due");
    }
  };

  const currentId = queue[pos];
  const pattern = currentId ? patternById(currentId) : undefined;
  const card = currentId ? srs.cardOrNew(currentId) : undefined;
  const previews = useMemo(
    () => (card ? gradePreviews(card) : null),
    [card],
  );

  const grade = (g: Grade) => {
    if (!currentId) return;
    srs.grade(currentId, g);
    recordToday();
    setReviewed((n) => n + 1);
    setFlipped(false);
    setPos((p) => p + 1);
  };

  // Keyboard: space/enter flips; 1-4 grade once flipped.
  useEffect(() => {
    if (!pattern) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA")) return;
      if (!flipped && (e.key === " " || e.key === "Enter")) {
        e.preventDefault();
        setFlipped(true);
        return;
      }
      if (flipped) {
        const meta = GRADE_META.find((m) => m.key === e.key);
        if (meta) {
          e.preventDefault();
          grade(meta.g);
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [flipped, pattern, currentId]);

  const dueNow = srs.counts.due;

  // ---- Empty / landing state -------------------------------------------------
  if (mode === null) {
    return (
      <div className="container narrow">
        <ReviewDashboard srs={srs} streak={streak} />
        <div className="card center review-empty">
          {dueNow > 0 ? (
            <>
              <div className="review-big">🗂️</div>
              <h2>{dueNow} pattern{dueNow === 1 ? "" : "s"} due for review</h2>
              <p className="muted">
                A quick spaced-repetition session keeps the patterns you've learned from fading.
                You'll recall each one from its cues, then grade how it went.
              </p>
              <button
                className="btn primary lg"
                onClick={() => {
                  setQueue(weakFirst(srs.dueCards()));
                  setMode("due");
                }}
              >
                Start review →
              </button>
            </>
          ) : (
            <>
              <div className="review-big">✅</div>
              <h2>Nothing due right now</h2>
              <p className="muted">
                {srs.counts.tracked === 0
                  ? "Once you mark patterns as learned, they'll show up here on a spaced schedule."
                  : "You're all caught up. Learn a few new patterns ahead of schedule, or cram everything."}
              </p>
              <div className="row" style={{ justifyContent: "center" }}>
                <button className="btn primary" onClick={startAhead}>Study new patterns →</button>
                {srs.counts.tracked > 0 && (
                  <button className="btn" onClick={reviewAll}>Cram all tracked</button>
                )}
                <a className="btn ghost" href={href("/")}>Browse patterns</a>
              </div>
            </>
          )}
        </div>
      </div>
    );
  }

  // ---- Session complete ------------------------------------------------------
  if (!pattern) {
    const nextDue = srs.dueCards(Number.MAX_SAFE_INTEGER)[0];
    return (
      <div className="container narrow">
        <div className="card center review-done">
          <div className="review-big">🎉</div>
          <h2>Session complete</h2>
          <p className="muted">
            You reviewed <b>{reviewed}</b> pattern{reviewed === 1 ? "" : "s"}.{" "}
            {streak > 0 && <>🔥 {streak}-day streak.</>}
          </p>
          {nextDue && (
            <p className="faint">
              Next up: <b>{patternById(nextDue.id)?.name}</b> in {formatDue(nextDue.due)}.
            </p>
          )}
          <div className="row" style={{ justifyContent: "center" }}>
            {srs.counts.due > 0 ? (
              <button
                className="btn primary"
                onClick={() => {
                  setQueue(weakFirst(srs.dueCards()));
                  setPos(0);
                  setReviewed(0);
                }}
              >
                Keep going ({srs.counts.due} due) →
              </button>
            ) : (
              <button className="btn primary" onClick={startAhead}>Learn new patterns →</button>
            )}
            <a className="btn" href={href("/")}>Done for now</a>
          </div>
        </div>
      </div>
    );
  }

  // ---- Active card -----------------------------------------------------------
  const total = queue.length;
  const recall = pattern.recognize.slice(0, 3);
  const sampleProblem = pattern.problems[0];

  return (
    <div className="container narrow">
      <div className="spread review-topline">
        <span className="eyebrow">{mode === "ahead" ? "Learn ahead" : "Spaced review"}</span>
        <span className="muted mono" style={{ fontSize: "0.85rem" }}>
          {pos + 1} / {total}
        </span>
      </div>
      <div className="quiz-progress">
        <div className="quiz-progress-bar" style={{ width: `${(pos / total) * 100}%` }} />
      </div>

      <div className={`review-card card ${flipped ? "flipped" : ""}`}>
        <div className="review-front">
          <span className="eyebrow">Recall the pattern</span>
          <h2 className="review-q">A problem that…</h2>
          <ul className="signal-list">
            {recall.map((r, i) => (
              <li key={i}>{r}</li>
            ))}
          </ul>
          {sampleProblem && (
            <div className="review-sample">
              <span className="faint">e.g.</span> {sampleProblem.name}{" "}
              <Difficulty d={sampleProblem.difficulty} />
            </div>
          )}
          {!flipped && (
            <button className="btn primary lg" onClick={() => setFlipped(true)}>
              Reveal pattern <span className="kbd">Space</span>
            </button>
          )}
        </div>

        {flipped && (
          <div className="review-back">
            <div className="review-reveal-head" style={{ borderColor: `${pattern.color}55` }}>
              <span className="pattern-icon" style={{ background: `${pattern.color}22`, borderColor: `${pattern.color}55` }}>
                {pattern.icon}
              </span>
              <div>
                <h2 style={{ margin: 0 }}>{pattern.name}</h2>
                <p className="muted" style={{ margin: 0 }}>{pattern.tagline}</p>
              </div>
            </div>
            <div className="mental-model" style={{ borderColor: `${pattern.color}55`, marginTop: 14 }}>
              <span className="mm-label">🧠 Mental model</span>
              <p>{pattern.mentalModel}</p>
            </div>
            <div className="review-meta">
              <span className="faint">Best complexity</span>
              <span className="mono">{pattern.complexity[pattern.complexity.length - 1]?.time}</span>
            </div>
            <a className="review-open" href={href(`/pattern/${pattern.id}`)} onClick={(e) => { e.preventDefault(); navigate(`/pattern/${pattern.id}`); }}>
              Open full pattern →
            </a>

            <div className="grade-row">
              <span className="grade-prompt">How well did you recall it?</span>
              <div className="grade-buttons">
                {GRADE_META.map((m) => (
                  <button key={m.g} className={`grade-btn ${m.cls}`} onClick={() => grade(m.g)}>
                    <span className="grade-label">{m.label}</span>
                    <span className="grade-next">{previews?.[m.g]}</span>
                    <span className="grade-key">{m.key}</span>
                  </button>
                ))}
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function ReviewDashboard({
  srs,
  streak,
}: {
  srs: ReturnType<typeof useSRS>;
  streak: number;
}) {
  const total = patterns.length;
  const { learned, mastered, due } = srs.counts;
  const learning = patterns.filter((p) => masteryOf(srs.cards[p.id]) === "learning").length;
  return (
    <div className="review-dash">
      <Stat label="Due now" value={due} accent={due > 0} />
      <Stat label="Learning" value={learning} />
      <Stat label="Mastered" value={`${mastered}/${total}`} />
      <Stat label="Tracked" value={`${learned}/${total}`} />
      <Stat label="Streak" value={streak > 0 ? `${streak} 🔥` : "0"} />
    </div>
  );
}

function Stat({ label, value, accent }: { label: string; value: string | number; accent?: boolean }) {
  return (
    <div className={`review-stat ${accent ? "accent" : ""}`}>
      <div className="review-stat-val">{value}</div>
      <div className="review-stat-label">{label}</div>
    </div>
  );
}
