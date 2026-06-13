import { useMemo } from "react";
import { StepperControls } from "../components/Stepper";
import { useStepper } from "../lib/useStepper";

/* ---------------- Greedy: Kadane's max subarray ---------------- */

interface KadaneFrame {
  active: number;
  start: number; // start of current run
  cur: number;
  best: number;
  bestL: number;
  bestR: number;
  restarted: boolean;
  caption: string;
}

function buildKadaneFrames(nums: number[]): KadaneFrame[] {
  const frames: KadaneFrame[] = [];
  let cur = nums[0];
  let best = nums[0];
  let start = 0;
  let bestL = 0;
  let bestR = 0;
  frames.push({ active: 0, start: 0, cur, best, bestL, bestR, restarted: false, caption: `Start: current run = best = nums[0] = ${nums[0]}.` });
  for (let i = 1; i < nums.length; i++) {
    let restarted = false;
    if (nums[i] > cur + nums[i]) {
      cur = nums[i];
      start = i;
      restarted = true;
    } else {
      cur = cur + nums[i];
    }
    if (cur > best) {
      best = cur;
      bestL = start;
      bestR = i;
    }
    frames.push({
      active: i,
      start,
      cur,
      best,
      bestL,
      bestR,
      restarted,
      caption: restarted
        ? `nums[${i}]=${nums[i]} alone beats extending (${nums[i]} > prev run) → RESTART the run here. cur=${cur}, best=${best}.`
        : `Extend the run: cur += ${nums[i]} = ${cur}. best=${best}.`,
    });
  }
  return frames;
}

export function GreedyViz() {
  const nums = useMemo(() => [-2, 1, -3, 4, -1, 2, 1, -5, 4], []);
  const frames = useMemo(() => buildKadaneFrames(nums), [nums]);
  const stepper = useStepper(frames.length);
  const f = frames[stepper.i];

  return (
    <div className="viz">
      <div className="viz-stage">
        <div className="cells">
          {nums.map((v, idx) => {
            const inRun = idx >= f.start && idx <= f.active;
            const inBest = idx >= f.bestL && idx <= f.bestR;
            const cls = [
              "cell",
              idx === f.active ? "active" : "",
              inRun ? "in-window" : "",
              inBest && !inRun ? "match" : "",
            ]
              .filter(Boolean)
              .join(" ");
            return (
              <div key={idx} className={cls} style={inBest ? { boxShadow: "0 3px 0 0 var(--good)" } : undefined}>
                <span className="idx">{idx}</span>
                {v}
              </div>
            );
          })}
        </div>
        <div className="viz-readout">
          <span>current run = <b>{f.cur}</b></span>
          <span>best = <b>{f.best}</b></span>
          <span className="faint">best span [{f.bestL}…{f.bestR}]</span>
        </div>
      </div>
      <StepperControls stepper={stepper} caption={f.caption} />
    </div>
  );
}

/* ---------------- Bit Manipulation: XOR single number ---------------- */

interface XorFrame {
  active: number;
  acc: number;
  caption: string;
}

function toBits(n: number, width = 4): string {
  return (n >>> 0).toString(2).padStart(width, "0");
}

function buildXorFrames(nums: number[]): XorFrame[] {
  const frames: XorFrame[] = [];
  let acc = 0;
  frames.push({ active: -1, acc, caption: "Accumulator starts at 0. XOR-ing a value with itself yields 0, so pairs cancel." });
  for (let i = 0; i < nums.length; i++) {
    acc ^= nums[i];
    frames.push({
      active: i,
      acc,
      caption: `acc ^= ${nums[i]} → ${toBits(acc)} (${acc}). ${
        nums.filter((x) => x === nums[i]).length === 2 ? "Its partner will cancel it later." : "This one has no partner — it survives."
      }`,
    });
  }
  frames.push({ active: -1, acc, caption: `All pairs cancelled to 0; the lone value remains: ${acc}.` });
  return frames;
}

export function BitXorViz() {
  const nums = useMemo(() => [4, 1, 2, 1, 2], []);
  const frames = useMemo(() => buildXorFrames(nums), [nums]);
  const stepper = useStepper(frames.length);
  const f = frames[stepper.i];

  return (
    <div className="viz">
      <div className="viz-stage">
        <div className="cells">
          {nums.map((v, idx) => {
            const cls = ["cell", idx === f.active ? "active" : "", idx < f.active ? "done" : ""].filter(Boolean).join(" ");
            return (
              <div key={idx} className={cls} style={{ width: 54, height: 54, flexDirection: "column", gap: 2 }}>
                <span style={{ fontSize: "1rem" }}>{v}</span>
                <span style={{ fontSize: "0.6rem", color: "var(--text-faint)", fontFamily: "var(--mono)" }}>{toBits(v)}</span>
              </div>
            );
          })}
        </div>
        <div style={{ textAlign: "center" }}>
          <div className="faint" style={{ fontSize: "0.74rem", marginBottom: 6 }}>accumulator (binary)</div>
          <div style={{ display: "flex", gap: 6, justifyContent: "center" }}>
            {toBits(f.acc).split("").map((bit, i) => (
              <span
                key={i}
                className="cell"
                style={{ width: 34, height: 34, fontSize: "1rem", color: bit === "1" ? "var(--accent)" : "var(--text-faint)" }}
              >
                {bit}
              </span>
            ))}
          </div>
          <div className="viz-readout" style={{ marginTop: 10 }}>
            <span>acc = <b>{f.acc}</b></span>
          </div>
        </div>
      </div>
      <StepperControls stepper={stepper} caption={f.caption} />
    </div>
  );
}

/* ---------------- Math: rotate matrix 90° ---------------- */

type Mat = number[][];

interface RotFrame {
  grid: Mat;
  highlight: [number, number][];
  caption: string;
}

function buildRotateFrames(start: Mat): RotFrame[] {
  const n = start.length;
  const grid: Mat = start.map((r) => [...r]);
  const frames: RotFrame[] = [];
  frames.push({ grid: grid.map((r) => [...r]), highlight: [], caption: "Goal: rotate 90° clockwise. Step 1 — transpose across the main diagonal." });
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      [grid[i][j], grid[j][i]] = [grid[j][i], grid[i][j]];
      frames.push({
        grid: grid.map((r) => [...r]),
        highlight: [[i, j], [j, i]],
        caption: `Transpose: swap cell (${i},${j}) with (${j},${i}).`,
      });
    }
  }
  frames.push({ grid: grid.map((r) => [...r]), highlight: [], caption: "Transpose done. Step 2 — reverse each row." });
  for (let i = 0; i < n; i++) {
    grid[i].reverse();
    frames.push({
      grid: grid.map((r) => [...r]),
      highlight: grid[i].map((_, j) => [i, j] as [number, number]),
      caption: `Reverse row ${i}. After all rows are reversed, the matrix is rotated 90° clockwise.`,
    });
  }
  return frames;
}

export function RotateMatrixViz() {
  const start = useMemo<Mat>(() => [[1, 2, 3], [4, 5, 6], [7, 8, 9]], []);
  const frames = useMemo(() => buildRotateFrames(start), [start]);
  const stepper = useStepper(frames.length, { speed: 650 });
  const f = frames[stepper.i];
  const hl = (r: number, c: number) => f.highlight.some(([a, b]) => a === r && b === c);

  return (
    <div className="viz">
      <div className="viz-stage">
        <div className="grid-board" style={{ gridTemplateColumns: `repeat(${f.grid.length}, 1fr)` }}>
          {f.grid.map((row, r) =>
            row.map((v, c) => (
              <div
                key={`${r}-${c}`}
                className="grid-cell"
                style={{
                  width: 46,
                  height: 46,
                  fontSize: "1rem",
                  color: "var(--text)",
                  borderColor: hl(r, c) ? "var(--accent)" : undefined,
                  background: hl(r, c) ? "var(--accent-glow)" : undefined,
                  boxShadow: hl(r, c) ? "0 0 0 2px var(--accent-glow)" : undefined,
                }}
              >
                {v}
              </div>
            )),
          )}
        </div>
      </div>
      <StepperControls stepper={stepper} caption={f.caption} />
    </div>
  );
}

/* ---------------- Advanced Graphs: Dijkstra ---------------- */

const DNODES = ["A", "B", "C", "D", "E"];
const DPOS = [
  { x: 60, y: 110 },
  { x: 200, y: 40 },
  { x: 200, y: 180 },
  { x: 350, y: 110 },
  { x: 470, y: 110 },
];
// directed edges with weights
const DEDGES: [number, number, number][] = [
  [0, 1, 4],
  [0, 2, 1],
  [2, 1, 2],
  [1, 3, 1],
  [2, 3, 5],
  [3, 4, 3],
  [2, 4, 8],
];

interface DijkstraFrame {
  dist: number[];
  settled: boolean[];
  active: number;
  relaxing?: [number, number];
  caption: string;
}

function buildDijkstraFrames(): DijkstraFrame[] {
  const n = DNODES.length;
  const INF = Infinity;
  const dist = Array(n).fill(INF);
  const settled = Array(n).fill(false);
  const adj: [number, number][][] = Array.from({ length: n }, () => []);
  for (const [u, v, w] of DEDGES) adj[u].push([v, w]);
  dist[0] = 0;
  const frames: DijkstraFrame[] = [];
  frames.push({ dist: [...dist], settled: [...settled], active: -1, caption: "Source A has distance 0; everything else ∞. Repeatedly settle the closest unsettled node." });
  for (let iter = 0; iter < n; iter++) {
    // pick closest unsettled
    let u = -1;
    let bestD = INF;
    for (let i = 0; i < n; i++) {
      if (!settled[i] && dist[i] < bestD) {
        bestD = dist[i];
        u = i;
      }
    }
    if (u === -1) break;
    settled[u] = true;
    frames.push({ dist: [...dist], settled: [...settled], active: u, caption: `Closest unsettled node is ${DNODES[u]} (dist ${dist[u]}). Settle it — its distance is now final.` });
    for (const [v, w] of adj[u]) {
      if (!settled[v] && dist[u] + w < dist[v]) {
        const old = dist[v];
        dist[v] = dist[u] + w;
        frames.push({
          dist: [...dist],
          settled: [...settled],
          active: u,
          relaxing: [u, v],
          caption: `Relax edge ${DNODES[u]}→${DNODES[v]} (w=${w}): ${dist[u]}+${w}=${dist[v]} < ${old === Infinity ? "∞" : old}. Update ${DNODES[v]}.`,
        });
      }
    }
  }
  frames.push({ dist: [...dist], settled: [...settled], active: -1, caption: `Done. Final shortest distances from A: ${DNODES.map((nm, i) => `${nm}=${dist[i]}`).join(", ")}.` });
  return frames;
}

export function DijkstraViz() {
  const frames = useMemo(() => buildDijkstraFrames(), []);
  const stepper = useStepper(frames.length, { speed: 900 });
  const f = frames[stepper.i];

  return (
    <div className="viz">
      <div className="viz-stage">
        <svg className="viz-svg" viewBox="0 0 530 220">
          {DEDGES.map(([u, v, w], i) => {
            const relaxing = f.relaxing && f.relaxing[0] === u && f.relaxing[1] === v;
            const mx = (DPOS[u].x + DPOS[v].x) / 2;
            const my = (DPOS[u].y + DPOS[v].y) / 2;
            return (
              <g key={i}>
                <line
                  className="edge-line"
                  x1={DPOS[u].x}
                  y1={DPOS[u].y}
                  x2={DPOS[v].x}
                  y2={DPOS[v].y}
                  stroke={relaxing ? "var(--accent)" : "var(--border)"}
                  strokeWidth={relaxing ? 3 : 2}
                />
                <circle cx={mx} cy={my} r={10} fill="var(--bg)" stroke="var(--border-soft)" />
                <text x={mx} y={my} fill="var(--text-dim)" fontSize="11" textAnchor="middle" dominantBaseline="central">{w}</text>
              </g>
            );
          })}
          {DNODES.map((nm, i) => {
            const cls = ["node-circle", f.active === i ? "active" : f.settled[i] ? "visited" : ""].filter(Boolean).join(" ");
            return (
              <g key={nm}>
                <circle className={cls} cx={DPOS[i].x} cy={DPOS[i].y} r={20} />
                <text className="node-text" x={DPOS[i].x} y={DPOS[i].y - 2}>{nm}</text>
                <text x={DPOS[i].x} y={DPOS[i].y + 11} fontSize="9" textAnchor="middle" fill="var(--accent)">
                  {f.dist[i] === Infinity ? "∞" : f.dist[i]}
                </text>
              </g>
            );
          })}
        </svg>
        <div className="faint" style={{ fontSize: "0.74rem" }}>numbers inside nodes = best-known distance from A · green = settled</div>
      </div>
      <StepperControls stepper={stepper} caption={f.caption} />
    </div>
  );
}
