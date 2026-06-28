import { useEffect, useMemo, useRef, useState } from 'react';
import {
  dtwRun, coinMatrix, classicalLineWalk, positionStats,
  buildGraph, ctqwEngine, ctqwLimiting, classicalCTRW, laplacian,
  spatialSearch, scanGamma,
  type CoinType, type CoinStart, type GraphFamily,
} from '../quantum/walks';

/**
 * Quantum Walks lab — three modes:
 *   • Discrete-time coined walk on a line: the ballistic two-horned distribution vs classical √t.
 *   • Continuous-time walk on a graph: e^{−iAt} with perfect state transfer and a quantum-vs-classical
 *     transport overlay.
 *   • Quantum spatial search (Childs–Goldstone): the continuous-time cousin of Grover, O(√N).
 */
type Mode = 'discrete' | 'continuous' | 'search';

export default function WalkLab() {
  const [mode, setMode] = useState<Mode>('discrete');
  return (
    <div style={{ maxWidth: 860 }}>
      <p style={{ color: '#64748b', fontSize: 12, margin: '0 0 16px', lineHeight: 1.6 }}>
        A classical random walker <b style={{ color: '#94a3b8' }}>diffuses</b> — its spread grows like{' '}
        <code style={{ color: '#67e8f9' }}>σ ∝ √t</code>. A quantum walker rides the interference of a
        coherent superposition and spreads <b style={{ color: '#22d3ee' }}>ballistically</b>,{' '}
        <code style={{ color: '#67e8f9' }}>σ ∝ t</code> — the quadratic head start behind
        Grover-as-a-walk, element distinctness, and spatial search. Two inequivalent models share the
        name: the <b style={{ color: '#a78bfa' }}>discrete-time coined</b> walk and the{' '}
        <b style={{ color: '#a78bfa' }}>continuous-time</b> walk, where the graph's adjacency matrix{' '}
        <i>is</i> the Hamiltonian and the evolution <code style={{ color: '#67e8f9' }}>e<sup>−iAt</sup></code>{' '}
        is computed exactly by diagonalising it with the lab's own Hermitian eigensolver.
      </p>
      <div style={{ display: 'flex', gap: 4, marginBottom: 18 }}>
        {([['discrete', '⟷ Discrete-time (coined)'], ['continuous', '🕸️ Continuous-time (graph)'], ['search', '🔍 Spatial search']] as [Mode, string][]).map(([m, lbl]) => (
          <button
            key={m}
            onClick={() => setMode(m)}
            style={{
              flex: 1, padding: '8px 10px', borderRadius: 8, cursor: 'pointer',
              border: `1px solid ${mode === m ? '#22d3ee' : 'rgba(30,58,95,0.6)'}`,
              background: mode === m ? 'rgba(34,211,238,0.15)' : 'rgba(14,22,41,0.6)',
              color: mode === m ? '#67e8f9' : '#64748b', fontWeight: mode === m ? 700 : 500, fontSize: 12,
            }}
          >{lbl}</button>
        ))}
      </div>
      {mode === 'discrete' && <DiscreteCard />}
      {mode === 'continuous' && <ContinuousCard />}
      {mode === 'search' && <SearchCard />}
    </div>
  );
}

// ====================================================================================== Discrete
function DiscreteCard() {
  const [steps, setSteps] = useState(60);
  const [coin, setCoin] = useState<CoinType>('hadamard');
  const [bias, setBias] = useState(0.5);
  const [start, setStart] = useState<CoinStart>('symmetric');

  const data = useMemo(() => {
    const run = dtwRun(steps, coinMatrix(coin, bias), start);
    const cl = classicalLineWalk(steps, run.N, run.center);
    const sc = positionStats(cl, run.center).stdev;
    return { run, cl, sc };
  }, [steps, coin, bias, start]);

  const { run, cl, sc } = data;
  const ratio = sc > 0 ? run.stdev / sc : 0;

  return (
    <Card title="Discrete-time coined walk — the ballistic two-horned distribution" accent="#22d3ee">
      <p style={{ fontSize: 12, color: '#94a3b8', margin: '0 0 10px', lineHeight: 1.6 }}>
        Each step flips a coin qubit (a 2×2 unitary) then shifts the walker left/right conditioned on it.
        The two-path interference builds the unmistakable <b style={{ color: '#22d3ee' }}>two horns</b> —
        most of the probability rides out at the edges of the light cone, not in the middle. The
        classical binomial walk (grey) is a single bell peak at the origin.
      </p>
      <div style={{ display: 'flex', gap: 14, alignItems: 'center', marginBottom: 10, flexWrap: 'wrap' }}>
        <Slider label="steps t" min={10} max={110} step={1} value={steps} onChange={setSteps} color="#0891b2" accent="#67e8f9" fmt={(v) => `${v}`} />
        <Seg label="coin" value={coin} onChange={(v) => setCoin(v as CoinType)} options={[['hadamard', 'Hadamard'], ['symmetric', 'Y (symmetric)'], ['biased', 'biased']]} />
        {coin === 'biased' && <Slider label="bias ρ" min={0.05} max={0.95} step={0.05} value={bias} onChange={setBias} color="#0891b2" accent="#67e8f9" fmt={(v) => v.toFixed(2)} />}
        <Seg label="coin start" value={start} onChange={(v) => setStart(v as CoinStart)} options={[['symmetric', '(|0⟩+i|1⟩)/√2'], ['up', '|0⟩'], ['down', '|1⟩']]} />
      </div>
      <div style={{ display: 'flex', gap: 10, marginBottom: 12, flexWrap: 'wrap' }}>
        <Metric label="σ quantum" value={run.stdev.toFixed(2)} color="#22d3ee" />
        <Metric label="σ_q / t" value={(run.stdev / steps).toFixed(3)} color="#a78bfa" />
        <Metric label="σ classical (=√t)" value={sc.toFixed(2)} color="#94a3b8" />
        <Metric label="quantum speedup σ_q/σ_c" value={`${ratio.toFixed(2)}×`} color="#34d399" />
      </div>
      <Label>Position distribution after {steps} steps — quantum (cyan) vs classical binomial (grey)</Label>
      <DistPlot quantum={run.finalProb} classical={cl} center={run.center} />
      <Label>Space-time light cone — probability vs position (x) and time (↓), brighter = more likely</Label>
      <LightCone spacetime={run.spacetime} center={run.center} steps={steps} />
      <p style={{ fontSize: 10, color: '#475569', margin: '8px 0 0', lineHeight: 1.5 }}>
        For the Hadamard walk the standard deviation grows as σ ≈ √(1−1/√2)·t ≈ 0.5412·t — strictly{' '}
        <b style={{ color: '#22d3ee' }}>linear</b> in time, versus the classical √t. The biased coin tilts
        the cone; the |0⟩ or |1⟩ coin start breaks the left/right symmetry.
      </p>
    </Card>
  );
}

function DistPlot({ quantum, classical, center }: { quantum: number[]; classical: number[]; center: number }) {
  const w = 600, h = 180, pad = 36;
  // window: show ±span around center where there's meaningful mass
  const span = Math.min(center, quantum.length - 1 - center);
  const xs: number[] = [];
  for (let x = center - span; x <= center + span; x++) xs.push(x);
  const yMax = Math.max(...xs.map((x) => Math.max(quantum[x], classical[x])), 1e-6) * 1.08;
  const sx = (x: number) => pad + ((x - (center - span)) / (2 * span)) * (w - pad - 12);
  const sy = (v: number) => 10 + (1 - v / yMax) * (h - 30);
  const line = (arr: number[]) => xs.map((x, i) => `${i === 0 ? 'M' : 'L'}${sx(x).toFixed(1)},${sy(arr[x]).toFixed(1)}`).join(' ');
  const ticks = [-span, -span / 2, 0, span / 2, span].map(Math.round);
  return (
    <svg width="100%" viewBox={`0 0 ${w} ${h}`} style={{ background: 'rgba(2,6,23,0.5)', borderRadius: 6, border: '1px solid #1e293b', marginBottom: 12 }}>
      {[yMax, yMax / 2, 0].map((v, i) => (
        <g key={i}>
          <line x1={pad} y1={sy(v)} x2={w - 12} y2={sy(v)} stroke="#1e293b" strokeWidth={1} />
          <text x={pad - 4} y={sy(v) + 3} fontSize={8} fill="#475569" textAnchor="end">{v.toFixed(3)}</text>
        </g>
      ))}
      <path d={`${line(classical)} L${sx(center + span)},${sy(0)} L${sx(center - span)},${sy(0)} Z`} fill="rgba(148,163,184,0.18)" stroke="#94a3b8" strokeWidth={1} />
      <path d={line(quantum)} fill="none" stroke="#22d3ee" strokeWidth={1.8} />
      {ticks.map((d, i) => <text key={i} x={sx(center + d)} y={h - 4} fontSize={8} fill="#475569" textAnchor="middle">{d}</text>)}
      <text x={w - 12} y={h - 4} fontSize={9} fill="#64748b" textAnchor="end">position − start</text>
      <text x={pad - 4} y={9} fontSize={9} fill="#64748b" textAnchor="end">P(x)</text>
    </svg>
  );
}

function LightCone({ spacetime, center, steps }: { spacetime: number[][]; center: number; steps: number }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const cv = ref.current; if (!cv) return;
    const span = steps + 1;
    const W = 2 * span + 1, H = spacetime.length;
    cv.width = W; cv.height = H;
    const ctx = cv.getContext('2d'); if (!ctx) return;
    const img = ctx.createImageData(W, H);
    // per-row normalisation so early rows (sharp) and late rows (spread) are both visible
    for (let t = 0; t < H; t++) {
      const row = spacetime[t];
      let max = 1e-9;
      for (let x = center - span; x <= center + span; x++) if (row[x] > max) max = row[x];
      for (let c = 0; c < W; c++) {
        const x = center - span + c;
        const v = x >= 0 && x < row.length ? Math.sqrt(Math.max(0, row[x]) / max) : 0;
        const [r, g, b] = ramp(v);
        const o = 4 * (t * W + c);
        img.data[o] = r; img.data[o + 1] = g; img.data[o + 2] = b; img.data[o + 3] = 255;
      }
    }
    ctx.putImageData(img, 0, 0);
  }, [spacetime, center, steps]);
  return (
    <canvas
      ref={ref}
      style={{ width: '100%', height: 200, imageRendering: 'pixelated', borderRadius: 6, border: '1px solid #1e293b', marginBottom: 6, background: '#020617', display: 'block' }}
    />
  );
}

// a dark→violet→cyan→white perceptual-ish ramp
function ramp(v: number): [number, number, number] {
  const stops: [number, number, number, number][] = [
    [0, 5, 10, 24], [0.25, 49, 17, 92], [0.5, 124, 58, 237], [0.72, 34, 211, 238], [1, 224, 255, 255],
  ];
  let a = stops[0], b = stops[stops.length - 1];
  for (let i = 0; i + 1 < stops.length; i++) if (v >= stops[i][0] && v <= stops[i + 1][0]) { a = stops[i]; b = stops[i + 1]; break; }
  const f = b[0] === a[0] ? 0 : (v - a[0]) / (b[0] - a[0]);
  return [Math.round(a[1] + f * (b[1] - a[1])), Math.round(a[2] + f * (b[2] - a[2])), Math.round(a[3] + f * (b[3] - a[3]))];
}

// ==================================================================================== Continuous
const FAMILY_RANGE: Record<GraphFamily, { min: number; max: number; def: number; plabel: string }> = {
  path: { min: 2, max: 18, def: 9, plabel: 'vertices' },
  cycle: { min: 3, max: 18, def: 10, plabel: 'vertices' },
  complete: { min: 2, max: 12, def: 6, plabel: 'vertices' },
  star: { min: 3, max: 16, def: 8, plabel: 'vertices' },
  hypercube: { min: 1, max: 5, def: 3, plabel: 'dimension' },
  grid: { min: 2, max: 6, def: 4, plabel: 'side L' },
};

function ContinuousCard() {
  const [family, setFamily] = useState<GraphFamily>('hypercube');
  const [param, setParam] = useState(3);
  const [useLap, setUseLap] = useState(false);
  const [t, setT] = useState(1.2);
  const TMAX = 12;

  // keep param in range when family changes
  const range = FAMILY_RANGE[family];
  const p = Math.min(range.max, Math.max(range.min, param));

  const model = useMemo(() => {
    const g = buildGraph(family, p);
    const H = useLap ? laplacian(g.adjacency) : g.adjacency;
    const eng = ctqwEngine(H);
    const target = g.antipode ? g.antipode(0) : farthest(g.adjacency, 0);
    const Lap = laplacian(g.adjacency); // classical comparison always uses the Laplacian heat kernel
    const times = Array.from({ length: 200 }, (_, i) => (i * TMAX) / 199);
    const qTransport = times.map((tt) => eng.transport(0, target, tt));
    const cTransport = times.map((tt) => classicalCTRW(Lap, 0, tt)[target]);
    const lim = ctqwLimiting(eng, 0);
    // perfect state transfer detection: peak |amp|² to the target
    let pstTime = 0, pstVal = 0;
    for (let i = 0; i < times.length; i++) if (qTransport[i] > pstVal) { pstVal = qTransport[i]; pstTime = times[i]; }
    return { g, eng, target, times, qTransport, cTransport, lim, pstTime, pstVal };
  }, [family, p, useLap]);

  const probs = useMemo(() => model.eng.prob(0, t), [model, t]);

  return (
    <Card title="Continuous-time walk — e^{−iAt} on a graph, exact via eigendecomposition" accent="#a78bfa">
      <p style={{ fontSize: 12, color: '#94a3b8', margin: '0 0 10px', lineHeight: 1.6 }}>
        No coin: the graph's adjacency matrix <b style={{ color: '#a78bfa' }}>is</b> the Hamiltonian, so
        the walker evolves by <code style={{ color: '#67e8f9' }}>|ψ(t)⟩ = e<sup>−iAt</sup>|0⟩</code>,
        diagonalised exactly. Node glow = <code style={{ color: '#67e8f9' }}>|ψ_i(t)|²</code>. The
        hypercube shows the headline effect — <b style={{ color: '#34d399' }}>perfect state transfer</b>{' '}
        to the antipodal corner at exactly t = π/2.
      </p>
      <div style={{ display: 'flex', gap: 14, alignItems: 'center', marginBottom: 10, flexWrap: 'wrap' }}>
        <Seg label="graph" value={family} onChange={(v) => { const f = v as GraphFamily; setFamily(f); setParam(FAMILY_RANGE[f].def); }}
          options={[['path', 'Path'], ['cycle', 'Cycle'], ['complete', 'Complete'], ['star', 'Star'], ['hypercube', 'Hypercube'], ['grid', 'Grid']]} />
        <Slider label={range.plabel} min={range.min} max={range.max} step={1} value={p} onChange={setParam} color="#7c3aed" accent="#c4b5fd" fmt={(v) => `${v}`} />
        <Slider label="time t" min={0} max={TMAX} step={0.05} value={t} onChange={setT} color="#7c3aed" accent="#c4b5fd" fmt={(v) => v.toFixed(2)} />
        <Seg label="H =" value={useLap ? 'lap' : 'adj'} onChange={(v) => setUseLap(v === 'lap')} options={[['adj', 'adjacency A'], ['lap', 'Laplacian L']]} />
      </div>
      <div style={{ display: 'flex', gap: 10, marginBottom: 12, flexWrap: 'wrap' }}>
        <Metric label="graph" value={model.g.label} color="#c4b5fd" />
        <Metric label="vertices" value={`${model.g.n}`} color="#67e8f9" />
        <Metric label="target (●)" value={`#${model.target}`} color="#fbbf24" />
        <Metric label="peak transport |amp|²" value={model.pstVal.toFixed(4)} color={model.pstVal > 0.999 ? '#34d399' : '#94a3b8'} />
        <Metric label="at t" value={model.pstTime.toFixed(3)} color="#a78bfa" />
        {model.pstVal > 0.999 && <Metric label="perfect state transfer" value="✓ yes" color="#34d399" />}
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
        <div>
          <Label>The walk on the graph at t = {t.toFixed(2)} (◇ start, ● target)</Label>
          <GraphView graph={model.g} probs={probs} start={0} target={model.target} />
        </div>
        <div>
          <Label>Transport to the target: quantum (violet) vs classical heat kernel (grey)</Label>
          <TransportPlot times={model.times} q={model.qTransport} c={model.cTransport} tNow={t} tMax={TMAX} pst={model.pstVal > 0.999 ? model.pstTime : null} />
          <Label>Limiting (time-averaged) distribution P∞ from the start</Label>
          <MiniBars values={model.lim} highlight={model.target} />
        </div>
      </div>
      <p style={{ fontSize: 10, color: '#475569', margin: '8px 0 0', lineHeight: 1.5 }}>
        Classical comparison uses the heat kernel e<sup>−Lt</sup> (always a probability distribution).
        Perfect state transfer also occurs on P₂, P₃ and weighted paths; generic graphs instead settle
        toward the time-averaged limiting distribution P∞ shown above.
      </p>
    </Card>
  );
}

function farthest(adj: number[][], from: number): number {
  // BFS for the graph-distance-farthest vertex (a reasonable "target" on graphs with no antipode)
  const n = adj.length;
  const dist = new Array<number>(n).fill(-1);
  dist[from] = 0; const q = [from];
  while (q.length) {
    const v = q.shift()!;
    for (let u = 0; u < n; u++) if (adj[v][u] && dist[u] < 0) { dist[u] = dist[v] + 1; q.push(u); }
  }
  let best = from, bd = -1;
  for (let i = 0; i < n; i++) if (dist[i] > bd) { bd = dist[i]; best = i; }
  return best;
}

function GraphView({ graph, probs, start, target }: { graph: ReturnType<typeof buildGraph>; probs: number[]; start: number; target: number }) {
  const S = 300, pad = 18;
  const px = (x: number) => pad + x * (S - 2 * pad);
  const py = (y: number) => pad + y * (S - 2 * pad);
  const pmax = Math.max(...probs, 1e-6);
  return (
    <svg width="100%" viewBox={`0 0 ${S} ${S}`} style={{ background: 'rgba(2,6,23,0.5)', borderRadius: 6, border: '1px solid #1e293b', aspectRatio: '1', marginBottom: 8 }}>
      {graph.edges.map(([i, j], k) => (
        <line key={k} x1={px(graph.layout[i].x)} y1={py(graph.layout[i].y)} x2={px(graph.layout[j].x)} y2={py(graph.layout[j].y)} stroke="#1e293b" strokeWidth={1} />
      ))}
      {graph.layout.map((pos, i) => {
        const v = probs[i] / pmax;
        const r = 3 + 11 * Math.sqrt(v);
        const [rr, gg, bb] = ramp(Math.sqrt(v));
        return (
          <g key={i}>
            {v > 0.02 && <circle cx={px(pos.x)} cy={py(pos.y)} r={r + 4} fill={`rgba(${rr},${gg},${bb},0.25)`} />}
            <circle cx={px(pos.x)} cy={py(pos.y)} r={r} fill={`rgb(${rr},${gg},${bb})`} stroke={i === start ? '#fff' : i === target ? '#fbbf24' : 'none'} strokeWidth={i === start || i === target ? 1.8 : 0} />
            {i === start && <text x={px(pos.x)} y={py(pos.y) - r - 3} fontSize={9} fill="#fff" textAnchor="middle">◇</text>}
            {i === target && <text x={px(pos.x)} y={py(pos.y) - r - 3} fontSize={9} fill="#fbbf24" textAnchor="middle">●</text>}
          </g>
        );
      })}
    </svg>
  );
}

function TransportPlot({ times, q, c, tNow, tMax, pst }: { times: number[]; q: number[]; c: number[]; tNow: number; tMax: number; pst: number | null }) {
  const w = 320, h = 130, pad = 28;
  const sx = (t: number) => pad + (t / tMax) * (w - pad - 8);
  const sy = (v: number) => 8 + (1 - v) * (h - 26);
  const line = (arr: number[]) => times.map((t, i) => `${i === 0 ? 'M' : 'L'}${sx(t).toFixed(1)},${sy(arr[i]).toFixed(1)}`).join(' ');
  return (
    <svg width="100%" viewBox={`0 0 ${w} ${h}`} style={{ background: 'rgba(2,6,23,0.5)', borderRadius: 6, border: '1px solid #1e293b', marginBottom: 10 }}>
      {[1, 0.5, 0].map((v, i) => (
        <g key={i}>
          <line x1={pad} y1={sy(v)} x2={w - 8} y2={sy(v)} stroke="#1e293b" strokeWidth={1} />
          <text x={pad - 3} y={sy(v) + 3} fontSize={7} fill="#475569" textAnchor="end">{v}</text>
        </g>
      ))}
      {pst != null && <line x1={sx(pst)} y1={6} x2={sx(pst)} y2={h - 16} stroke="#34d399" strokeWidth={1} strokeDasharray="3 3" opacity={0.7} />}
      <line x1={sx(tNow)} y1={6} x2={sx(tNow)} y2={h - 16} stroke="#67e8f9" strokeWidth={1} opacity={0.5} />
      <path d={line(c)} fill="none" stroke="#94a3b8" strokeWidth={1.3} />
      <path d={line(q)} fill="none" stroke="#a78bfa" strokeWidth={1.8} />
      {[0, tMax / 2, tMax].map((t, i) => <text key={i} x={sx(t)} y={h - 3} fontSize={7} fill="#475569" textAnchor="middle">{t.toFixed(0)}</text>)}
      <text x={w - 8} y={h - 3} fontSize={8} fill="#64748b" textAnchor="end">t</text>
    </svg>
  );
}

function MiniBars({ values, highlight }: { values: number[]; highlight: number }) {
  const w = 320, h = 70, pad = 18;
  const max = Math.max(...values, 1e-6);
  const bw = (w - pad - 6) / values.length;
  return (
    <svg width="100%" viewBox={`0 0 ${w} ${h}`} style={{ background: 'rgba(2,6,23,0.5)', borderRadius: 6, border: '1px solid #1e293b' }}>
      {values.map((v, i) => {
        const bh = (v / max) * (h - 20);
        return <rect key={i} x={pad + i * bw} y={h - 12 - bh} width={Math.max(1, bw - 1)} height={bh} fill={i === highlight ? '#fbbf24' : '#7c3aed'} opacity={0.85} />;
      })}
      <text x={pad} y={h - 2} fontSize={7} fill="#475569">vertex 0</text>
      <text x={w - 6} y={h - 2} fontSize={7} fill="#475569" textAnchor="end">{values.length - 1}</text>
    </svg>
  );
}

// ======================================================================================== Search
function SearchCard() {
  const [N, setN] = useState(32);
  const [gammaScale, setGammaScale] = useState(1); // gamma = gammaScale / N
  const [w, setW] = useState(0);

  const data = useMemo(() => {
    const adj = buildGraph('complete', N).adjacency;
    const marked = Math.min(w, N - 1);
    const tStar = (Math.PI / 2) * Math.sqrt(N);
    const times = Array.from({ length: 300 }, (_, i) => (i * 2.2 * tStar) / 299);
    const gamma = gammaScale / N;
    const res = spatialSearch(adj, marked, gamma, times);
    const scan = scanGamma(adj, marked, times, 0.2 / N, 4 / N, 32);
    return { adj, marked, tStar, times, gamma, res, scan };
  }, [N, gammaScale, w]);

  const groverIters = Math.round((Math.PI / 4) * Math.sqrt(N));

  return (
    <Card title="Quantum spatial search — Grover, but as a continuous-time walk (Childs–Goldstone)" accent="#34d399">
      <p style={{ fontSize: 12, color: '#94a3b8', margin: '0 0 10px', lineHeight: 1.6 }}>
        Add a marked-vertex energy well to the walk Hamiltonian,{' '}
        <code style={{ color: '#67e8f9' }}>H = −γ·A − |w⟩⟨w|</code>, start from the uniform
        superposition, and let it evolve. On the complete graph the amplitude rushes onto the marked
        vertex, hitting <b style={{ color: '#34d399' }}>success ≈ 1</b> at{' '}
        <code style={{ color: '#67e8f9' }}>t ≈ (π/2)√N</code> — the same <b>O(√N)</b> as Grover's{' '}
        {groverIters} iterations, but in continuous time. The effect is a{' '}
        <b style={{ color: '#fbbf24' }}>resonance</b>: it only works near the critical{' '}
        <code style={{ color: '#67e8f9' }}>γ = 1/N</code>.
      </p>
      <div style={{ display: 'flex', gap: 14, alignItems: 'center', marginBottom: 10, flexWrap: 'wrap' }}>
        <Slider label="N (= K_N)" min={4} max={64} step={1} value={N} onChange={(v) => { setN(v); if (w >= v) setW(0); }} color="#059669" accent="#6ee7b7" fmt={(v) => `${v}`} />
        <Slider label="γ × N" min={0.2} max={4} step={0.1} value={gammaScale} onChange={setGammaScale} color="#059669" accent="#6ee7b7" fmt={(v) => v.toFixed(1)} />
        <Slider label="marked w" min={0} max={N - 1} step={1} value={w} onChange={setW} color="#059669" accent="#6ee7b7" fmt={(v) => `#${v}`} />
      </div>
      <div style={{ display: 'flex', gap: 10, marginBottom: 12, flexWrap: 'wrap' }}>
        <Metric label="peak success" value={data.res.optSuccess.toFixed(4)} color={data.res.optSuccess > 0.9 ? '#34d399' : '#fbbf24'} />
        <Metric label="at time" value={data.res.optTime.toFixed(2)} color="#6ee7b7" />
        <Metric label="optimal t = (π/2)√N" value={data.tStar.toFixed(2)} color="#94a3b8" />
        <Metric label="γ (now)" value={data.gamma.toFixed(4)} color="#67e8f9" />
        <Metric label="best γ (scan) ≈ 1/N" value={data.scan.bestGamma.toFixed(4)} color="#a78bfa" />
        <Metric label="1/N" value={(1 / N).toFixed(4)} color="#475569" />
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
        <div>
          <Label>Success probability |⟨w|ψ(t)⟩|² over time (optimum dashed)</Label>
          <SuccessPlot times={data.times} success={data.res.success} tStar={data.tStar} tMax={data.times[data.times.length - 1]} />
        </div>
        <div>
          <Label>γ-scan: peak success vs γ — the resonance sits at γ = 1/N (orange)</Label>
          <GammaScanPlot gammas={data.scan.gammas} peaks={data.scan.peaks} critical={1 / N} />
        </div>
      </div>
      <p style={{ fontSize: 10, color: '#475569', margin: '8px 0 0', lineHeight: 1.5 }}>
        Detuning γ away from 1/N destroys the resonance and the success probability collapses — the
        continuous-time analogue of running Grover with the wrong rotation angle. The complete graph is
        the cleanest case; the same construction searches the hypercube and lattices above their
        critical dimension.
      </p>
    </Card>
  );
}

function SuccessPlot({ times, success, tStar, tMax }: { times: number[]; success: number[]; tStar: number; tMax: number }) {
  const w = 320, h = 150, pad = 28;
  const sx = (t: number) => pad + (t / tMax) * (w - pad - 8);
  const sy = (v: number) => 8 + (1 - v) * (h - 26);
  const line = times.map((t, i) => `${i === 0 ? 'M' : 'L'}${sx(t).toFixed(1)},${sy(success[i]).toFixed(1)}`).join(' ');
  return (
    <svg width="100%" viewBox={`0 0 ${w} ${h}`} style={{ background: 'rgba(2,6,23,0.5)', borderRadius: 6, border: '1px solid #1e293b', marginBottom: 6 }}>
      {[1, 0.5, 0].map((v, i) => (
        <g key={i}>
          <line x1={pad} y1={sy(v)} x2={w - 8} y2={sy(v)} stroke="#1e293b" strokeWidth={1} />
          <text x={pad - 3} y={sy(v) + 3} fontSize={7} fill="#475569" textAnchor="end">{v}</text>
        </g>
      ))}
      <line x1={sx(tStar)} y1={6} x2={sx(tStar)} y2={h - 16} stroke="#fbbf24" strokeWidth={1} strokeDasharray="3 3" opacity={0.75} />
      <path d={line} fill="none" stroke="#34d399" strokeWidth={1.8} />
      {[0, tMax / 2, tMax].map((t, i) => <text key={i} x={sx(t)} y={h - 3} fontSize={7} fill="#475569" textAnchor="middle">{t.toFixed(0)}</text>)}
      <text x={w - 8} y={h - 3} fontSize={8} fill="#64748b" textAnchor="end">t</text>
    </svg>
  );
}

function GammaScanPlot({ gammas, peaks, critical }: { gammas: number[]; peaks: number[]; critical: number }) {
  const w = 320, h = 150, pad = 28;
  const gMin = gammas[0], gMax = gammas[gammas.length - 1];
  const sx = (g: number) => pad + ((Math.log(g) - Math.log(gMin)) / (Math.log(gMax) - Math.log(gMin))) * (w - pad - 8);
  const sy = (v: number) => 8 + (1 - v) * (h - 26);
  const line = gammas.map((g, i) => `${i === 0 ? 'M' : 'L'}${sx(g).toFixed(1)},${sy(peaks[i]).toFixed(1)}`).join(' ');
  return (
    <svg width="100%" viewBox={`0 0 ${w} ${h}`} style={{ background: 'rgba(2,6,23,0.5)', borderRadius: 6, border: '1px solid #1e293b', marginBottom: 6 }}>
      {[1, 0.5, 0].map((v, i) => (
        <g key={i}>
          <line x1={pad} y1={sy(v)} x2={w - 8} y2={sy(v)} stroke="#1e293b" strokeWidth={1} />
          <text x={pad - 3} y={sy(v) + 3} fontSize={7} fill="#475569" textAnchor="end">{v}</text>
        </g>
      ))}
      <line x1={sx(critical)} y1={6} x2={sx(critical)} y2={h - 16} stroke="#fbbf24" strokeWidth={1} strokeDasharray="3 3" opacity={0.75} />
      <text x={sx(critical)} y={4 + 12} fontSize={7} fill="#fbbf24" textAnchor="middle">1/N</text>
      <path d={line} fill="none" stroke="#a78bfa" strokeWidth={1.8} />
      <text x={pad} y={h - 3} fontSize={7} fill="#475569">{gMin.toExponential(0)}</text>
      <text x={w - 8} y={h - 3} fontSize={7} fill="#475569" textAnchor="end">γ {gMax.toExponential(0)}</text>
    </svg>
  );
}

// ================================================================================= shared UI atoms
function Slider({ label, min, max, value, onChange, color, accent, step = 1, fmt }:
  { label: string; min: number; max: number; value: number; onChange: (v: number) => void; color: string; accent: string; step?: number; fmt?: (v: number) => string }) {
  return (
    <label style={{ fontSize: 11, color: '#94a3b8', display: 'flex', gap: 6, alignItems: 'center' }}>
      {label}
      <input type="range" min={min} max={max} step={step} value={value} onChange={(e) => onChange(parseFloat(e.target.value))} style={{ accentColor: color }} />
      <span style={{ fontFamily: 'monospace', color: accent, width: 40 }}>{fmt ? fmt(value) : value}</span>
    </label>
  );
}
function Seg({ label, value, onChange, options }: { label: string; value: string; onChange: (v: string) => void; options: [string, string][] }) {
  return (
    <div style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
      <span style={{ fontSize: 11, color: '#94a3b8' }}>{label}</span>
      <div style={{ display: 'flex', gap: 2 }}>
        {options.map(([v, lbl]) => (
          <button key={v} onClick={() => onChange(v)} style={{
            padding: '3px 8px', borderRadius: 6, fontSize: 10, cursor: 'pointer',
            border: `1px solid ${value === v ? '#22d3ee' : 'rgba(30,58,95,0.6)'}`,
            background: value === v ? 'rgba(34,211,238,0.15)' : 'transparent',
            color: value === v ? '#67e8f9' : '#64748b', fontFamily: 'monospace',
          }}>{lbl}</button>
        ))}
      </div>
    </div>
  );
}
function Label({ children }: { children: React.ReactNode }) {
  return <div style={{ fontSize: 10, color: '#64748b', textTransform: 'uppercase', letterSpacing: 0.4, margin: '4px 0 6px' }}>{children}</div>;
}
function Card({ title, accent, children }: { title: string; accent: string; children: React.ReactNode }) {
  return (
    <div style={{ background: 'rgba(14,22,41,0.6)', border: '1px solid rgba(30,58,95,0.5)', borderRadius: 12, padding: '16px 18px', marginBottom: 16 }}>
      <h3 style={{ margin: '0 0 10px', fontSize: 14, fontWeight: 800, color: accent }}>{title}</h3>
      {children}
    </div>
  );
}
function Metric({ label, value, color }: { label: string; value: string; color: string }) {
  return (
    <div style={{ background: 'rgba(2,6,23,0.5)', border: '1px solid #1e293b', borderRadius: 8, padding: '6px 12px' }}>
      <div style={{ fontSize: 9, color: '#64748b', textTransform: 'uppercase' }}>{label}</div>
      <div style={{ fontSize: 16, fontWeight: 800, color, fontFamily: 'monospace' }}>{value}</div>
    </div>
  );
}
