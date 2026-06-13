import { useMemo } from "react";
import { StepperControls } from "../components/Stepper";
import { useStepper } from "../lib/useStepper";

/* ---------------- 1-D DP: House Robber ---------------- */

interface DP1Frame {
  dp: (number | null)[];
  active: number;
  sources: number[];
  caption: string;
}

function buildDP1Frames(nums: number[]): DP1Frame[] {
  const frames: DP1Frame[] = [];
  const dp: (number | null)[] = nums.map(() => null);
  for (let i = 0; i < nums.length; i++) {
    const skip = i >= 1 ? (dp[i - 1] as number) : 0;
    const take = nums[i] + (i >= 2 ? (dp[i - 2] as number) : 0);
    dp[i] = Math.max(skip, take);
    const sources = [i - 1, i - 2].filter((k) => k >= 0);
    frames.push({
      dp: [...dp],
      active: i,
      sources,
      caption:
        i === 0
          ? `dp[0] = nums[0] = ${nums[0]}. Best loot considering only the first house.`
          : `dp[${i}] = max(skip = dp[${i - 1}]=${skip}, rob = nums[${i}]+dp[${i - 2}]=${nums[i]}+${i >= 2 ? dp[i - 2] : 0}=${take}) = ${dp[i]}.`,
    });
  }
  return frames;
}

export function DP1DViz() {
  const nums = useMemo(() => [2, 7, 9, 3, 1], []);
  const frames = useMemo(() => buildDP1Frames(nums), [nums]);
  const stepper = useStepper(frames.length);
  const f = frames[stepper.i];

  return (
    <div className="viz">
      <div className="viz-stage">
        <div>
          <div className="faint" style={{ fontSize: "0.74rem", textAlign: "center", marginBottom: 6 }}>house values</div>
          <div className="dp-row">
            {nums.map((v, i) => (
              <div key={i} className={`dp-cell ${i === f.active ? "active" : ""} ${f.sources.includes(i) ? "source" : ""}`}>
                <span className="idx">{i}</span>
                {v}
              </div>
            ))}
          </div>
        </div>
        <div>
          <div className="faint" style={{ fontSize: "0.74rem", textAlign: "center", marginBottom: 6 }}>dp[i] = best loot up to house i</div>
          <div className="dp-row">
            {f.dp.map((v, i) => (
              <div key={i} className={`dp-cell ${v === null ? "empty" : "filled"} ${i === f.active ? "active" : ""} ${f.sources.includes(i) ? "source" : ""}`}>
                <span className="idx">{i}</span>
                {v === null ? "·" : v}
              </div>
            ))}
          </div>
        </div>
        <div className="viz-readout"><span>answer = <b>{f.dp[f.active]}</b></span></div>
      </div>
      <StepperControls stepper={stepper} caption={f.caption} />
    </div>
  );
}

/* ---------------- 2-D DP: Longest Common Subsequence ---------------- */

interface DP2Frame {
  grid: (number | null)[][];
  ai: number;
  bj: number;
  match: boolean | null;
  sources: [number, number][];
  caption: string;
}

function buildDP2Frames(a: string, b: string): DP2Frame[] {
  const m = a.length;
  const n = b.length;
  const grid: (number | null)[][] = Array.from({ length: m + 1 }, () => Array(n + 1).fill(null));
  for (let i = 0; i <= m; i++) grid[i][0] = 0;
  for (let j = 0; j <= n; j++) grid[0][j] = 0;
  const frames: DP2Frame[] = [];
  frames.push({
    grid: grid.map((r) => [...r]),
    ai: 0,
    bj: 0,
    match: null,
    sources: [],
    caption: "Base row & column are 0 (an empty string shares nothing). Now fill cell by cell.",
  });
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      const match = a[i - 1] === b[j - 1];
      if (match) {
        grid[i][j] = (grid[i - 1][j - 1] as number) + 1;
        frames.push({
          grid: grid.map((r) => [...r]),
          ai: i,
          bj: j,
          match: true,
          sources: [[i - 1, j - 1]],
          caption: `'${a[i - 1]}' == '${b[j - 1]}' → extend the diagonal: dp = dp[↖] + 1 = ${grid[i][j]}.`,
        });
      } else {
        grid[i][j] = Math.max(grid[i - 1][j] as number, grid[i][j - 1] as number);
        frames.push({
          grid: grid.map((r) => [...r]),
          ai: i,
          bj: j,
          match: false,
          sources: [[i - 1, j], [i, j - 1]],
          caption: `'${a[i - 1]}' ≠ '${b[j - 1]}' → take best of top & left: max(${grid[i - 1][j]}, ${grid[i][j - 1]}) = ${grid[i][j]}.`,
        });
      }
    }
  }
  return frames;
}

export function DP2DViz() {
  const a = "AGCAT";
  const b = "GACT";
  const frames = useMemo(() => buildDP2Frames(a, b), []);
  const stepper = useStepper(frames.length, { speed: 600 });
  const f = frames[stepper.i];

  const isSource = (i: number, j: number) => f.sources.some(([r, c]) => r === i && c === j);

  return (
    <div className="viz">
      <div className="viz-stage">
        <table className="dp-grid">
          <thead>
            <tr>
              <th></th>
              <th>∅</th>
              {b.split("").map((c, j) => (
                <th key={j}>{c}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {f.grid.map((row, i) => (
              <tr key={i}>
                <th>{i === 0 ? "∅" : a[i - 1]}</th>
                {row.map((v, j) => {
                  const active = i === f.ai && j === f.bj;
                  const cls = [v === null ? "empty" : "filled", active ? "active" : "", isSource(i, j) ? "source" : ""]
                    .filter(Boolean)
                    .join(" ");
                  return (
                    <td key={j} className={cls}>
                      {v === null ? "" : v}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
        <div className="viz-readout">
          <span>LCS length = <b>{f.grid[a.length][b.length] ?? "…"}</b></span>
        </div>
      </div>
      <StepperControls stepper={stepper} caption={f.caption} />
    </div>
  );
}

/* ---------------- Backtracking: Subsets ---------------- */

interface BTFrame {
  path: number[];
  results: number[][];
  action: "record" | "choose" | "unchoose";
  caption: string;
}

function buildBTFrames(nums: number[]): BTFrame[] {
  const frames: BTFrame[] = [];
  const path: number[] = [];
  const results: number[][] = [];
  const snap = (action: BTFrame["action"], caption: string) =>
    frames.push({ path: [...path], results: results.map((r) => [...r]), action, caption });

  const backtrack = (start: number) => {
    results.push([...path]);
    snap("record", `Record current subset: [${path.join(", ")}]${path.length === 0 ? " (the empty set)" : ""}.`);
    for (let i = start; i < nums.length; i++) {
      path.push(nums[i]);
      snap("choose", `Choose ${nums[i]} → path = [${path.join(", ")}]. Explore deeper.`);
      backtrack(i + 1);
      path.pop();
      snap("unchoose", `Un-choose ${nums[i]} (backtrack) → path = [${path.join(", ")}]. Try the next option.`);
    }
  };
  backtrack(0);
  return frames;
}

export function BacktrackingViz() {
  const nums = useMemo(() => [1, 2, 3], []);
  const frames = useMemo(() => buildBTFrames(nums), [nums]);
  const stepper = useStepper(frames.length, { speed: 700 });
  const f = frames[stepper.i];

  const actionColor =
    f.action === "record" ? "var(--good)" : f.action === "choose" ? "var(--accent)" : "var(--warn)";

  return (
    <div className="viz">
      <div className="viz-stage">
        <div className="viz-readout">
          <span style={{ color: "var(--text-faint)" }}>nums = [{nums.join(", ")}]</span>
        </div>
        <div>
          <div className="faint" style={{ fontSize: "0.74rem", textAlign: "center", marginBottom: 6 }}>current path</div>
          <div className="bt-path" style={{ color: actionColor }}>
            [{f.path.join(", ")}]
          </div>
        </div>
        <div>
          <div className="faint" style={{ fontSize: "0.74rem", textAlign: "center", marginBottom: 6 }}>
            collected subsets ({f.results.length})
          </div>
          <div className="bt-results">
            {f.results.map((r, k) => (
              <span key={k} className="bt-result">[{r.join(", ")}]</span>
            ))}
          </div>
        </div>
      </div>
      <StepperControls stepper={stepper} caption={f.caption} />
    </div>
  );
}

/* ---------------- Intervals: Merge ---------------- */

interface IVFrame {
  // each interval gets a state
  states: ("pending" | "current" | "merged" | "done")[];
  merged: [number, number][];
  caption: string;
}

const RAW_INTERVALS: [number, number][] = [
  [1, 3],
  [2, 6],
  [8, 10],
  [9, 12],
  [15, 18],
];

function buildIntervalFrames(): IVFrame[] {
  const intervals = [...RAW_INTERVALS].sort((a, b) => a[0] - b[0]);
  const frames: IVFrame[] = [];
  const merged: [number, number][] = [intervals[0]];
  frames.push({
    states: intervals.map((_, i) => (i === 0 ? "current" : "pending")),
    merged: merged.map((m) => [...m] as [number, number]),
    caption: `Sorted by start. Seed the merged list with the first interval [${intervals[0].join(", ")}].`,
  });
  for (let i = 1; i < intervals.length; i++) {
    const [s, e] = intervals[i];
    const last = merged[merged.length - 1];
    if (s <= last[1]) {
      last[1] = Math.max(last[1], e);
      frames.push({
        states: intervals.map((_, k) => (k < i ? "done" : k === i ? "current" : "pending")),
        merged: merged.map((m) => [...m] as [number, number]),
        caption: `[${s}, ${e}] starts at ${s} ≤ ${last[0] === s ? s : "previous end"} ${last[1]} → overlaps! Extend the merged interval to [${last[0]}, ${last[1]}].`,
      });
    } else {
      merged.push([s, e]);
      frames.push({
        states: intervals.map((_, k) => (k < i ? "done" : k === i ? "current" : "pending")),
        merged: merged.map((m) => [...m] as [number, number]),
        caption: `[${s}, ${e}] starts after the previous end → no overlap. Start a new merged interval.`,
      });
    }
  }
  return frames;
}

export function IntervalsViz() {
  const intervals = useMemo(() => [...RAW_INTERVALS].sort((a, b) => a[0] - b[0]), []);
  const frames = useMemo(() => buildIntervalFrames(), []);
  const stepper = useStepper(frames.length, { speed: 850 });
  const f = frames[stepper.i];
  const maxV = 19;

  const pct = (v: number) => `${(v / maxV) * 100}%`;

  return (
    <div className="viz">
      <div className="viz-stage">
        <div style={{ width: "100%", maxWidth: 480 }}>
          <div className="faint" style={{ fontSize: "0.74rem", marginBottom: 6 }}>input (sorted by start)</div>
          {intervals.map(([s, e], i) => (
            <div key={i} className="iv-track">
              <div
                className={`iv-bar ${f.states[i] === "current" ? "" : f.states[i] === "done" ? "dim" : ""}`}
                style={{
                  left: pct(s),
                  width: pct(e - s),
                  borderColor: f.states[i] === "current" ? "var(--accent)" : undefined,
                  boxShadow: f.states[i] === "current" ? "0 0 0 2px var(--accent-glow)" : undefined,
                }}
              >
                <span style={{ fontSize: "0.66rem", paddingLeft: 4, color: "var(--text-dim)" }}>{s}–{e}</span>
              </div>
            </div>
          ))}
          <div className="faint" style={{ fontSize: "0.74rem", margin: "12px 0 6px" }}>merged result</div>
          {f.merged.map(([s, e], i) => (
            <div key={i} className="iv-track">
              <div className="iv-bar merged" style={{ left: pct(s), width: pct(e - s) }}>
                <span style={{ fontSize: "0.66rem", paddingLeft: 4, color: "var(--good)" }}>{s}–{e}</span>
              </div>
            </div>
          ))}
          <div className="iv-axis">
            <span>0</span>
            <span>{Math.round(maxV / 2)}</span>
            <span>{maxV}</span>
          </div>
        </div>
      </div>
      <StepperControls stepper={stepper} caption={f.caption} />
    </div>
  );
}
