import { useMemo, useState } from "react";
import { patterns, levelLabel } from "../data/patterns";
import { useSRS, MASTERY_LABEL } from "../lib/srs";
import { href } from "../lib/router";
import type { Pattern } from "../data/types";

type SortKey = "order" | "name" | "level" | "time";
const LEVEL_RANK: Record<Pattern["level"], number> = { foundational: 0, core: 1, advanced: 2 };

/** Heuristic ordering of common Big-O classes for sorting the time column. */
const COMPLEXITY_RANK: [RegExp, number][] = [
  [/O\(1\)/, 0],
  [/O\(log/, 1],
  [/O\(n log|O\(n·log|O\(n \* log/i, 3],
  [/O\(n\)/, 2],
  [/O\(n \+ m\)|O\(V \+ E\)|O\(E/i, 2],
  [/O\(n\^?2\)|O\(n²\)/, 4],
  [/O\(n\^?3\)|O\(n³\)/, 5],
  [/O\(2\^?n\)|O\(2\^n\)/, 6],
  [/O\(n!\)/, 7],
];

function complexityRank(s: string): number {
  for (const [re, rank] of COMPLEXITY_RANK) if (re.test(s)) return rank;
  return 3.5;
}

function bestRow(p: Pattern) {
  // The last complexity row is authored as the pattern's optimized approach.
  return p.complexity[p.complexity.length - 1];
}

export default function Cheatsheet() {
  const srs = useSRS();
  const [sort, setSort] = useState<SortKey>("order");
  const [dir, setDir] = useState<1 | -1>(1);
  const [level, setLevel] = useState<"all" | Pattern["level"]>("all");
  const [q, setQ] = useState("");

  const rows = useMemo(() => {
    let list = [...patterns];
    if (level !== "all") list = list.filter((p) => p.level === level);
    if (q.trim()) {
      const needle = q.toLowerCase();
      list = list.filter(
        (p) =>
          p.name.toLowerCase().includes(needle) ||
          p.tagline.toLowerCase().includes(needle) ||
          p.recognize.some((r) => r.toLowerCase().includes(needle)),
      );
    }
    list.sort((a, b) => {
      let cmp: number;
      if (sort === "name") cmp = a.name.localeCompare(b.name);
      else if (sort === "level") cmp = LEVEL_RANK[a.level] - LEVEL_RANK[b.level] || a.order - b.order;
      else if (sort === "time") cmp = complexityRank(bestRow(a).time) - complexityRank(bestRow(b).time);
      else cmp = a.order - b.order;
      return cmp * dir;
    });
    return list;
  }, [sort, dir, level, q]);

  const toggleSort = (key: SortKey) => {
    if (sort === key) setDir((d) => (d === 1 ? -1 : 1));
    else {
      setSort(key);
      setDir(1);
    }
  };

  const arrow = (key: SortKey) => (sort === key ? (dir === 1 ? " ▲" : " ▼") : "");

  return (
    <div className="container cheatsheet">
      <div className="spread cs-head no-print">
        <div>
          <span className="eyebrow">One-pager</span>
          <h1 style={{ margin: "6px 0 2px" }}>Complexity cheat-sheet</h1>
          <p className="muted" style={{ margin: 0 }}>
            All 18 patterns, their optimized complexity, and the cue that gives each one away.
            Sort, filter, then print or save as PDF.
          </p>
        </div>
        <button className="btn primary" onClick={() => window.print()} title="Print or save as PDF">
          🖨 Print / PDF
        </button>
      </div>

      <div className="cs-controls no-print">
        <input
          className="cs-search"
          placeholder="Filter by name, cue…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
        <div className="cs-levels">
          {(["all", "foundational", "core", "advanced"] as const).map((lv) => (
            <button
              key={lv}
              className={`btn sm ${level === lv ? "primary" : ""}`}
              onClick={() => setLevel(lv)}
            >
              {lv === "all" ? "All levels" : levelLabel[lv]}
            </button>
          ))}
        </div>
      </div>

      <div className="print-title">Pattern Dojo — Complexity cheat-sheet</div>

      <div className="cs-table-wrap">
        <table className="cs-table">
          <thead>
            <tr>
              <th className="sortable" onClick={() => toggleSort("order")}>#{arrow("order")}</th>
              <th className="sortable" onClick={() => toggleSort("name")}>Pattern{arrow("name")}</th>
              <th className="sortable" onClick={() => toggleSort("level")}>Level{arrow("level")}</th>
              <th className="sortable" onClick={() => toggleSort("time")}>Time{arrow("time")}</th>
              <th>Space</th>
              <th>Recognize it by…</th>
              <th className="no-print">Status</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((p) => {
              const row = bestRow(p);
              const m = srs.masteryOf(p.id);
              return (
                <tr key={p.id}>
                  <td className="faint mono">{p.order}</td>
                  <td>
                    <a className="cs-name" href={href(`/pattern/${p.id}`)}>
                      <span className="cs-icon" style={{ background: `${p.color}22` }}>{p.icon}</span>
                      {p.name}
                    </a>
                  </td>
                  <td><span className="tag">{levelLabel[p.level]}</span></td>
                  <td className="mono cs-time">{row?.time}</td>
                  <td className="mono">{row?.space}</td>
                  <td className="muted cs-cue">{p.recognize[0]}</td>
                  <td className="no-print">
                    {m === "new" ? <span className="faint">—</span> : <span className={`mastery-badge ${m}`}>{MASTERY_LABEL[m]}</span>}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {rows.length === 0 && <p className="muted center" style={{ marginTop: 24 }}>No patterns match that filter.</p>}
      <p className="faint print-foot">Generated from patterndojo · {new Date().toLocaleDateString()}</p>
    </div>
  );
}
