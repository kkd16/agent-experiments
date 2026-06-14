import { useRef, useState } from "react";
import { patterns } from "../data/patterns";
import { useSRS, formatDue, MASTERY_LABEL } from "../lib/srs";
import type { Mastery } from "../lib/srs";
import { useStreak, dayKey } from "../lib/streak";
import { downloadBackup, importFromFile } from "../lib/backup";
import type { ImportResult } from "../lib/backup";
import { href } from "../lib/router";

const WEEKS = 18;
const DAY_MS = 24 * 60 * 60 * 1000;
const MASTERY_ORDER: Mastery[] = ["new", "learning", "young", "mastered"];
const MASTERY_COLOR: Record<Mastery, string> = {
  new: "var(--text-faint)",
  learning: "var(--warn)",
  young: "var(--accent)",
  mastered: "var(--good)",
};

/** Map an activity count to a heatmap intensity level 0–4. */
function level(count: number): number {
  if (count <= 0) return 0;
  if (count === 1) return 1;
  if (count <= 3) return 2;
  if (count <= 6) return 3;
  return 4;
}

/** Build a Sunday-aligned grid of the last WEEKS weeks ending this week. */
function buildGrid(counts: Record<string, number>) {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  // end at the upcoming Saturday so the current week is the last column
  const end = new Date(today.getTime() + (6 - today.getDay()) * DAY_MS);
  const start = new Date(end.getTime() - (WEEKS * 7 - 1) * DAY_MS);
  const cols: { date: Date; lvl: number; future: boolean }[][] = [];
  const cursor = new Date(start);
  for (let w = 0; w < WEEKS; w++) {
    const col: { date: Date; lvl: number; future: boolean }[] = [];
    for (let d = 0; d < 7; d++) {
      const date = new Date(cursor);
      col.push({
        date,
        lvl: level(counts[dayKey(date)] ?? 0),
        future: date.getTime() > today.getTime(),
      });
      cursor.setTime(cursor.getTime() + DAY_MS);
    }
    cols.push(col);
  }
  return cols;
}

export default function Stats() {
  const srs = useSRS();
  const { current, longest, counts: dayCounts } = useStreak();
  const [msg, setMsg] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const grid = buildGrid(dayCounts);

  const counts: Record<Mastery, number> = { new: 0, learning: 0, young: 0, mastered: 0 };
  for (const p of patterns) counts[srs.masteryOf(p.id)]++;
  const totalReviews = Object.values(srs.cards).reduce((s, c) => s + c.reps, 0);
  const totalLapses = Object.values(srs.cards).reduce((s, c) => s + c.lapses, 0);

  const onImport = async (file: File) => {
    const res: ImportResult = await importFromFile(file);
    setMsg(res.ok ? `Restored ${res.keys} section${res.keys === 1 ? "" : "s"} of progress.` : res.error);
    window.setTimeout(() => setMsg(null), 4000);
  };

  const tracked = patterns
    .map((p) => ({ p, card: srs.cards[p.id], m: srs.masteryOf(p.id) }))
    .filter((r) => r.card)
    .sort((a, b) => (a.card!.due - b.card!.due));

  return (
    <div className="container narrow stats-page">
      <span className="eyebrow">Your dojo</span>
      <h1 style={{ marginTop: 6 }}>Progress & stats</h1>
      <p className="muted" style={{ marginTop: 0 }}>
        Everything below lives only in your browser. Back it up to move it between devices.
      </p>

      <div className="review-dash" style={{ gridTemplateColumns: "repeat(4, 1fr)" }}>
        <Stat label="Day streak" value={current > 0 ? `${current} 🔥` : "0"} />
        <Stat label="Best streak" value={longest} />
        <Stat label="Total reviews" value={totalReviews} />
        <Stat label="Mastered" value={`${counts.mastered}/${patterns.length}`} />
      </div>

      <section className="stats-block">
        <h2>Activity</h2>
        <div className="heatmap" role="img" aria-label="Daily activity over the last 18 weeks">
          {grid.map((col, ci) => (
            <div className="heatmap-col" key={ci}>
              {col.map((cell, di) => (
                <div
                  key={di}
                  className={`heatmap-cell l${cell.lvl} ${cell.future ? "future" : ""}`}
                  title={cell.future ? "" : `${dayKey(cell.date)}${cell.lvl ? ` · ${dayCounts[dayKey(cell.date)]} action${dayCounts[dayKey(cell.date)] === 1 ? "" : "s"}` : ""}`}
                />
              ))}
            </div>
          ))}
        </div>
        <div className="heatmap-legend faint">
          <span>{WEEKS} weeks</span>
          <span className="row" style={{ gap: 6 }}>
            less
            <span className="heatmap-cell l0" />
            <span className="heatmap-cell l1" />
            <span className="heatmap-cell l2" />
            <span className="heatmap-cell l3" />
            <span className="heatmap-cell l4" />
            more
          </span>
        </div>
      </section>

      <section className="stats-block">
        <h2>Mastery</h2>
        <div className="mastery-bar">
          {MASTERY_ORDER.map((m) =>
            counts[m] > 0 ? (
              <div
                key={m}
                className="mastery-seg"
                style={{ flex: counts[m], background: MASTERY_COLOR[m] }}
                title={`${MASTERY_LABEL[m]}: ${counts[m]}`}
              />
            ) : null,
          )}
        </div>
        <div className="mastery-key">
          {MASTERY_ORDER.map((m) => (
            <span key={m} className="mastery-key-item">
              <span className="dot" style={{ background: MASTERY_COLOR[m] }} /> {MASTERY_LABEL[m]} · <b>{counts[m]}</b>
            </span>
          ))}
        </div>
        {totalLapses > 0 && (
          <p className="faint" style={{ fontSize: "0.85rem" }}>
            {totalLapses} lapse{totalLapses === 1 ? "" : "s"} so far — that's normal; forgetting and
            re-learning is what makes a memory stick.
          </p>
        )}
      </section>

      {tracked.length > 0 && (
        <section className="stats-block">
          <h2>Tracked patterns</h2>
          <div className="cs-table-wrap">
            <table className="cs-table">
              <thead>
                <tr>
                  <th>Pattern</th>
                  <th>State</th>
                  <th>Reviews</th>
                  <th>Next due</th>
                </tr>
              </thead>
              <tbody>
                {tracked.map(({ p, card, m }) => (
                  <tr key={p.id}>
                    <td>
                      <a className="cs-name" href={href(`/pattern/${p.id}`)}>
                        <span className="cs-icon" style={{ background: `${p.color}22` }}>{p.icon}</span>
                        {p.name}
                      </a>
                    </td>
                    <td><span className={`mastery-badge ${m}`}>{MASTERY_LABEL[m]}</span></td>
                    <td className="mono">{card!.reps}{card!.lapses > 0 && <span className="faint"> · {card!.lapses}✕</span>}</td>
                    <td className="mono cs-time">{formatDue(card!.due)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      <section className="stats-block">
        <h2>Backup</h2>
        <p className="muted" style={{ marginTop: 0 }}>
          Export a JSON snapshot of your progress, or restore one on another device.
        </p>
        <div className="row">
          <button className="btn primary" onClick={downloadBackup}>⬇ Export progress</button>
          <button className="btn" onClick={() => fileRef.current?.click()}>⬆ Import</button>
          <button
            className="btn ghost"
            onClick={() => {
              if (confirm("Reset ALL progress, streaks and review history? This can't be undone.")) {
                srs.resetAll();
                setMsg("All progress reset.");
                window.setTimeout(() => setMsg(null), 3000);
              }
            }}
          >
            Reset everything
          </button>
          <input
            ref={fileRef}
            type="file"
            accept="application/json,.json"
            style={{ display: "none" }}
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) onImport(f);
              e.target.value = "";
            }}
          />
        </div>
        {msg && <div className="stats-msg">{msg}</div>}
      </section>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="review-stat">
      <div className="review-stat-val">{value}</div>
      <div className="review-stat-label">{label}</div>
    </div>
  );
}
