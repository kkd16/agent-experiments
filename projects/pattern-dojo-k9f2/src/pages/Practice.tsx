import { useMemo, useState } from "react";
import { challenges } from "../dojo/challenges";
import { patternIdOfChallenge } from "../dojo/challenges";
import { useDojo } from "../dojo/store";
import { patterns, patternById } from "../data/patterns";
import { href } from "../lib/router";
import { ProgressDonut, Difficulty } from "../components/ui";
import type { Difficulty as Diff } from "../data/types";

type DiffFilter = "all" | Diff;
type StatusFilter = "all" | "unsolved" | "solved";

export default function Practice() {
  const dojo = useDojo();
  const [diff, setDiff] = useState<DiffFilter>("all");
  const [status, setStatus] = useState<StatusFilter>("all");
  const [q, setQ] = useState("");

  const total = challenges.length;
  const solved = dojo.solvedCount;

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return challenges.filter((c) => {
      if (diff !== "all" && c.difficulty !== diff) return false;
      const isSolved = dojo.isSolved(c.id);
      if (status === "solved" && !isSolved) return false;
      if (status === "unsolved" && isSolved) return false;
      if (needle) {
        const hay = `${c.title} ${patternById(c.patternId)?.name ?? ""}`.toLowerCase();
        if (!hay.includes(needle)) return false;
      }
      return true;
    });
  }, [diff, status, q, dojo]);

  // group filtered challenges by pattern, in roadmap order
  const groups = useMemo(() => {
    const order = [...patterns].sort((a, b) => a.order - b.order);
    return order
      .map((p) => ({ pattern: p, items: filtered.filter((c) => c.patternId === p.id) }))
      .filter((g) => g.items.length > 0);
  }, [filtered]);

  const solvedByPattern = dojo.solvedByPattern(patternIdOfChallenge);

  return (
    <div className="container narrow practice-page">
      <span className="eyebrow">Code Dojo</span>
      <div className="practice-head">
        <div>
          <h1>Solve it, don't just recognise it</h1>
          <p className="muted">
            Write real JavaScript and run it against a sandboxed judge — sample tests plus a hidden
            set — right in your browser. Every solve graduates that pattern into your spaced-repetition
            review and feeds your streak. {total} problems across {groups.length || patterns.length} patterns.
          </p>
        </div>
        <div className="practice-ring">
          <ProgressDonut done={solved} total={total} />
          <span className="muted small">{solved}/{total} solved</span>
        </div>
      </div>

      <div className="practice-controls">
        <input
          className="practice-search"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search problems or patterns…"
          aria-label="Search problems"
        />
        <div className="seg" role="group" aria-label="Filter by difficulty">
          {(["all", "easy", "medium", "hard"] as DiffFilter[]).map((d) => (
            <button key={d} className={`seg-btn ${diff === d ? "active" : ""}`} onClick={() => setDiff(d)}>
              {d}
            </button>
          ))}
        </div>
        <div className="seg" role="group" aria-label="Filter by status">
          {(["all", "unsolved", "solved"] as StatusFilter[]).map((s) => (
            <button key={s} className={`seg-btn ${status === s ? "active" : ""}`} onClick={() => setStatus(s)}>
              {s}
            </button>
          ))}
        </div>
      </div>

      {groups.length === 0 && <p className="muted" style={{ marginTop: 24 }}>No problems match those filters.</p>}

      {groups.map(({ pattern, items }) => {
        const totalForPattern = challenges.filter((c) => c.patternId === pattern.id).length;
        const solvedForPattern = solvedByPattern[pattern.id] ?? 0;
        return (
          <section key={pattern.id} className="practice-group">
            <header className="practice-group-head">
              <a href={href(`/pattern/${pattern.id}`)} className="practice-group-title">
                <span className="pattern-icon sm" style={{ background: `${pattern.color}22`, borderColor: `${pattern.color}55` }}>
                  {pattern.icon}
                </span>
                {pattern.name}
              </a>
              <span className="muted small">{solvedForPattern}/{totalForPattern} solved</span>
            </header>
            <div className="challenge-list">
              {items.map((c) => {
                const isSolved = dojo.isSolved(c.id);
                const attempts = dojo.attemptsOf(c.id);
                return (
                  <a key={c.id} className={`challenge-row ${isSolved ? "solved" : ""}`} href={href(`/practice/${c.id}`)}>
                    <span className={`challenge-check ${isSolved ? "on" : ""}`} aria-hidden="true">
                      {isSolved ? "✓" : "○"}
                    </span>
                    <span className="challenge-title">{c.title}</span>
                    <Difficulty d={c.difficulty} />
                    {attempts > 0 && !isSolved && (
                      <span className="muted small">{attempts} attempt{attempts === 1 ? "" : "s"}</span>
                    )}
                  </a>
                );
              })}
            </div>
          </section>
        );
      })}
    </div>
  );
}
