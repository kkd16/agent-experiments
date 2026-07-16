import { useEffect, useMemo, useRef, useState } from 'react'
import type { PointerEvent as ReactPointerEvent, ReactNode } from 'react'
import './ProbView.css'
import type { Model, DTMC, MDP } from '../engine/prob/types'
import { validate } from '../engine/prob/types'
import { parseModel } from '../engine/prob/parser'
import { PROB_EXAMPLES } from '../engine/prob/examples'
import { ftoStr, ftoDecimal, ftoNumber } from '../engine/prob/frac'
import type { Frac } from '../engine/prob/frac'
import {
  reachExact,
  boundedUntilExact,
  expectedStepsExact,
} from '../engine/prob/dtmc'
import { policyIterationExact, optimalBoundedUntilFloat } from '../engine/prob/mdp'
import { parsePctl, checkState, queryProb, isQuery, PctlError, showState } from '../engine/prob/pctl'
import type { StateF } from '../engine/prob/pctl'
import { samplePath, estimateUntil } from '../engine/prob/simulate'
import { runProbSelfTest } from '../engine/prob/selftest'

export type ProbTab = 'chain' | 'query' | 'bounded' | 'simulate' | 'verify' | 'about'

const TABS: { id: ProbTab; label: string }[] = [
  { id: 'chain', label: 'Chain' },
  { id: 'query', label: 'Query' },
  { id: 'bounded', label: 'Bounded' },
  { id: 'simulate', label: 'Simulate' },
  { id: 'verify', label: 'Verify' },
  { id: 'about', label: 'About' },
]

interface Props {
  source: string
  onSource: (s: string) => void
  query: string
  onQuery: (q: string) => void
  tab: ProbTab
  onTab: (t: ProbTab) => void
}

const R = 7 // node radius in the 0..100 canvas

// ---- colour helpers --------------------------------------------------------

function mix(a: [number, number, number], b: [number, number, number], t: number): string {
  const c = a.map((x, i) => Math.round(x + (b[i] - x) * t))
  return `rgb(${c[0]},${c[1]},${c[2]})`
}
const COLD: [number, number, number] = [42, 51, 88] // --node
const HOT: [number, number, number] = [70, 224, 160] // --good
/** Heat colour for a probability in [0,1] — cold slate → warm green. */
function heat(p: number): string {
  return mix(COLD, HOT, Math.max(0, Math.min(1, p)))
}

// ---------------------------------------------------------------------------

export default function ProbView({ source, onSource, query, onQuery, tab, onTab }: Props) {
  const parsed = useMemo(() => parseModel(source), [source])
  const model = parsed.model
  const issues = useMemo(() => (model ? validate(model) : []), [model])

  // draggable node positions (overrides on top of the parser's layout)
  const [override, setOverride] = useState<Map<number, { x: number; y: number }>>(new Map())
  const [lastSource, setLastSource] = useState(source)
  if (source !== lastSource) {
    setLastSource(source)
    setOverride(new Map())
  }
  const pos = (s: number): { x: number; y: number } => override.get(s) ?? model!.pos[s] ?? { x: 50, y: 50 }
  const onMove = (s: number, x: number, y: number) =>
    setOverride((m) => new Map(m).set(s, { x: Math.max(6, Math.min(94, x)), y: Math.max(8, Math.min(92, y)) }))

  return (
    <div className="workspace prob-ws">
      <main className="viewer">
        <nav className="tabs">
          {TABS.map((t) => (
            <button key={t.id} className={`tab${tab === t.id ? ' active' : ''}`} onClick={() => onTab(t.id)}>
              {t.label}
            </button>
          ))}
        </nav>
        <div className="canvas prob-canvas">
          {!model ? (
            <ParseErrorPane errors={parsed.errors} />
          ) : tab === 'verify' ? (
            <VerifyTab />
          ) : tab === 'about' ? (
            <AboutTab />
          ) : tab === 'query' ? (
            <QueryCanvas model={model} query={query} pos={pos} onMove={onMove} />
          ) : tab === 'bounded' ? (
            <BoundedCanvas model={model} pos={pos} onMove={onMove} />
          ) : tab === 'simulate' ? (
            <SimulateCanvas model={model} pos={pos} onMove={onMove} />
          ) : (
            <ChainOnlyCanvas model={model} pos={pos} onMove={onMove} />
          )}
        </div>
      </main>

      <aside className="rail">
        <Rail
          model={model}
          parseErrors={parsed.errors}
          issues={issues}
          source={source}
          onSource={onSource}
          query={query}
          onQuery={onQuery}
          tab={tab}
        />
      </aside>
    </div>
  )
}

// ---------------------------------------------------------------------------
// The shared chain drawing
// ---------------------------------------------------------------------------

interface CanvasProps {
  model: Model
  pos: (s: number) => { x: number; y: number }
  onMove: (s: number, x: number, y: number) => void
  /** Fill colour per state (defaults to the neutral node colour). */
  fill?: (s: number) => string
  /** Small value text inside a node (e.g. a probability). */
  nodeText?: (s: number) => string | null
  /** States drawn with a target ring. */
  marks?: boolean[]
  /** A single highlighted "current" state (simulation). */
  current?: number
  /** States drawn as satisfying (green outline). */
  sat?: boolean[]
}

function edgeGeo(a: { x: number; y: number }, b: { x: number; y: number }, curve: number) {
  const dx = b.x - a.x
  const dy = b.y - a.y
  const len = Math.hypot(dx, dy) || 1
  const ux = dx / len
  const uy = dy / len
  const px = -uy * curve
  const py = ux * curve
  const sx = a.x + ux * R
  const sy = a.y + uy * R
  const ex = b.x - ux * (R + 1.8)
  const ey = b.y - uy * (R + 1.8)
  const cx = (a.x + b.x) / 2 + px
  const cy = (a.y + b.y) / 2 + py
  const d = curve ? `M${sx},${sy} Q${cx},${cy} ${ex},${ey}` : `M${sx},${sy} L${ex},${ey}`
  const t = 0.42
  const mt = 1 - t
  const mx = curve ? mt * mt * sx + 2 * mt * t * cx + t * t * ex : sx + (ex - sx) * t
  const my = curve ? mt * mt * sy + 2 * mt * t * cy + t * t * ey : sy + (ey - sy) * t
  return { d, mx, my }
}

function selfLoopGeo(p: { x: number; y: number }) {
  const d = `M${p.x - 2.4},${p.y - R} C${p.x - 11},${p.y - R - 12} ${p.x + 11},${p.y - R - 12} ${p.x + 2.4},${p.y - R}`
  return { d, mx: p.x, my: p.y - R - 8.5 }
}

interface EdgeSpec {
  from: number
  to: number
  label: string
  actIdx: number
}

/** Flatten a model into drawable edges (one per probabilistic branch). */
function modelEdges(m: Model): EdgeSpec[] {
  const edges: EdgeSpec[] = []
  if (m.kind === 'dtmc') {
    for (let s = 0; s < m.n; s++) for (const e of m.trans[s]) edges.push({ from: s, to: e.to, label: ftoStr(e.p), actIdx: 0 })
  } else {
    for (let s = 0; s < m.n; s++) {
      m.actions[s].forEach((a, ai) => {
        for (const e of a.dist) edges.push({ from: s, to: e.to, label: `${a.name} ${ftoStr(e.p)}`, actIdx: ai })
      })
    }
  }
  return edges
}

const ACTION_COLORS = ['var(--accent)', 'var(--warn)', 'var(--good)', '#c58bff', '#ff8f6b']

function ChainCanvas({ model, pos, onMove, fill, nodeText, marks, current, sat }: CanvasProps) {
  const svgRef = useRef<SVGSVGElement | null>(null)
  const drag = useRef<{ s: number; moved: boolean } | null>(null)
  const m = model
  const edges = useMemo(() => modelEdges(m), [m])

  const toSvg = (e: ReactPointerEvent): { x: number; y: number } => {
    const svg = svgRef.current
    if (!svg) return { x: 0, y: 0 }
    const ctm = svg.getScreenCTM()
    if (!ctm) return { x: 0, y: 0 }
    const p = new DOMPoint(e.clientX, e.clientY).matrixTransform(ctm.inverse())
    return { x: p.x, y: p.y }
  }
  const down = (e: ReactPointerEvent, s: number) => {
    ;(e.target as Element).setPointerCapture?.(e.pointerId)
    drag.current = { s, moved: false }
  }
  const move = (e: ReactPointerEvent) => {
    if (!drag.current) return
    const p = toSvg(e)
    drag.current.moved = true
    onMove(drag.current.s, p.x, p.y)
  }
  const up = () => {
    drag.current = null
  }

  const edgeEls: ReactNode[] = []
  const pillEls: ReactNode[] = []
  edges.forEach((e, i) => {
    const a = pos(e.from)
    const b = pos(e.to)
    const twoWay = e.from !== e.to && edges.some((x) => x.from === e.to && x.to === e.from)
    const geo = e.from === e.to ? selfLoopGeo(a) : edgeGeo(a, b, twoWay ? 4.5 : 0)
    const color = m.kind === 'mdp' ? ACTION_COLORS[e.actIdx % ACTION_COLORS.length] : 'var(--line-strong, #3a4784)'
    edgeEls.push(
      <path key={`e${i}`} className="p-edge" d={geo.d} markerEnd="url(#p-arrow)" fill="none" stroke={color} />,
    )
    pillEls.push(
      <g key={`p${i}`} className="p-pill" transform={`translate(${geo.mx} ${geo.my})`}>
        <rect x={-e.label.length * 1.35 - 1.4} y={-2.6} width={e.label.length * 2.7 + 2.8} height={5.2} rx={2} />
        <text textAnchor="middle" y={1.7}>{e.label}</text>
      </g>,
    )
  })

  return (
    <svg ref={svgRef} className="prob-svg" viewBox="-7 -13 114 126" preserveAspectRatio="xMidYMid meet" onPointerMove={move} onPointerUp={up}>
      <defs>
        <marker id="p-arrow" viewBox="0 0 10 10" refX="8.5" refY="5" markerWidth="5" markerHeight="5" orient="auto-start-reverse">
          <path d="M0,1 L9,5 L0,9 z" fill="var(--muted)" />
        </marker>
      </defs>
      <g>{edgeEls}</g>
      <g>
        {Array.from({ length: m.n }, (_, s) => {
          const p = pos(s)
          const f = fill ? fill(s) : 'var(--node)'
          const isCur = current === s
          const isSat = sat ? sat[s] : false
          const stroke = isCur ? 'var(--warn)' : isSat ? 'var(--good)' : 'var(--node-stroke)'
          const sw = isCur ? 1.4 : isSat ? 1.1 : 0.6
          const props = [...m.label[s]].join(' ')
          return (
            <g key={s} className="p-node" transform={`translate(${p.x} ${p.y})`} onPointerDown={(e) => down(e, s)}>
              {marks && marks[s] ? <circle r={R + 1.7} fill="none" stroke="var(--good)" strokeWidth={0.5} strokeDasharray="1.5 1.2" /> : null}
              {s === m.init ? <path className="p-init" d={`M${-R - 7},0 L${-R - 1.5},0`} markerEnd="url(#p-arrow)" /> : null}
              <circle r={R} fill={f} stroke={stroke} strokeWidth={sw} />
              {nodeText && nodeText(s) ? <text className="p-nval" y={1.7} textAnchor="middle">{nodeText(s)}</text> : null}
              <text className="p-lbl" y={-R - 4.2} textAnchor="middle">{m.labels[s]}</text>
              {props ? <text className="p-props" y={R + 5.4} textAnchor="middle">{props}</text> : null}
            </g>
          )
        })}
      </g>
    </svg>
  )
}

function ChainOnlyCanvas({ model, pos, onMove }: { model: Model; pos: (s: number) => { x: number; y: number }; onMove: CanvasProps['onMove'] }) {
  return <ChainCanvas model={model} pos={pos} onMove={onMove} />
}

// ---------------------------------------------------------------------------
// Query tab canvas — evaluate a PCTL formula and colour by probability / sat
// ---------------------------------------------------------------------------

interface Evaluated {
  kind: 'query' | 'bool' | 'error'
  message?: string
  formula?: StateF
  prob?: { exact: Frac[] | null; approx: number[] }
  sat?: boolean[]
}

function evaluateQuery(model: Model, query: string): Evaluated {
  let formula: StateF
  try {
    formula = parsePctl(query)
  } catch (e) {
    return { kind: 'error', message: e instanceof PctlError ? e.message : String(e) }
  }
  try {
    if (isQuery(formula)) {
      const prob = queryProb(model, formula)
      return { kind: 'query', formula, prob }
    }
    const sat = checkState(model, formula)
    return { kind: 'bool', formula, sat }
  } catch (e) {
    return { kind: 'error', message: e instanceof PctlError ? e.message : String(e) }
  }
}

function QueryCanvas({ model, query, pos, onMove }: { model: Model; query: string; pos: (s: number) => { x: number; y: number }; onMove: CanvasProps['onMove'] }) {
  const ev = useMemo(() => evaluateQuery(model, query), [model, query])
  if (ev.kind === 'error') {
    return (
      <div className="prob-split">
        <ChainCanvas model={model} pos={pos} onMove={onMove} />
        <div className="q-badge bad">✗ {ev.message}</div>
      </div>
    )
  }
  if (ev.kind === 'bool' && ev.sat) {
    const sat = ev.sat
    return (
      <div className="prob-split">
        <ChainCanvas model={model} pos={pos} onMove={onMove} sat={sat} fill={(s) => (sat[s] ? 'color-mix(in srgb, var(--good) 30%, var(--node))' : 'var(--node)')} />
        <div className={`q-badge ${sat[model.init] ? 'ok' : 'bad'}`}>
          {sat[model.init] ? '✓ holds' : '✗ fails'} in the initial state · {sat.filter(Boolean).length}/{model.n} states satisfy it
        </div>
      </div>
    )
  }
  const prob = ev.prob!
  const val = (s: number) => (prob.exact ? ftoNumber(prob.exact[s]) : prob.approx[s])
  const initVal = val(model.init)
  return (
    <div className="prob-split">
      <ChainCanvas
        model={model}
        pos={pos}
        onMove={onMove}
        fill={(s) => heat(val(s))}
        nodeText={(s) => (prob.exact ? shortFrac(prob.exact[s]) : val(s).toFixed(2))}
      />
      <div className="q-answer">
        <span className="q-answer-k">P(init)</span>
        <span className="q-answer-v">{prob.exact ? ftoStr(prob.exact[model.init]) : initVal.toFixed(6)}</span>
        <span className="q-answer-d">≈ {initVal.toFixed(6)}</span>
      </div>
      <div className="heat-legend">
        <span>0</span>
        <i style={{ background: `linear-gradient(90deg, ${heat(0)}, ${heat(0.5)}, ${heat(1)})` }} />
        <span>1</span>
      </div>
    </div>
  )
}

function shortFrac(f: Frac): string {
  const s = ftoStr(f)
  return s.length <= 6 ? s : ftoDecimal(f, 3)
}

// ---------------------------------------------------------------------------
// Bounded tab — Pr(F<=k target) vs k, converging to the unbounded value
// ---------------------------------------------------------------------------

function firstProp(model: Model): string {
  return model.props[0] ?? ''
}

function BoundedCanvas({ model, pos, onMove }: { model: Model; pos: (s: number) => { x: number; y: number }; onMove: CanvasProps['onMove'] }) {
  const [prop, setProp] = useState(() => firstProp(model))
  const [k, setK] = useState(6)
  const [lastModel, setLastModel] = useState(model)
  if (model !== lastModel) {
    setLastModel(model)
    setProp(firstProp(model))
  }
  const target = useMemo(() => model.label.map((l) => l.has(prop)), [model, prop])
  const all = useMemo(() => new Array<boolean>(model.n).fill(true), [model])

  const KMAX = 24
  const series = useMemo(() => {
    const out: number[] = []
    if (model.kind === 'dtmc') {
      for (let kk = 0; kk <= KMAX; kk++) out.push(ftoNumber(boundedUntilExact(model, all, target, kk)[model.init]))
    } else {
      for (let kk = 0; kk <= KMAX; kk++) out.push(optimalBoundedUntilFloat(model, all, target, 'max', kk)[model.init])
    }
    return out
  }, [model, all, target])

  const unbounded = useMemo(() => {
    if (model.kind === 'dtmc') return ftoNumber(reachExact(model, target)[model.init])
    return ftoNumber(policyIterationExact(model, all, target, 'max').value[model.init])
  }, [model, all, target])

  const cur = useMemo(() => {
    if (model.kind === 'dtmc') return boundedUntilExact(model, all, target, k).map(ftoNumber)
    return optimalBoundedUntilFloat(model, all, target, 'max', k)
  }, [model, all, target, k])

  return (
    <div className="prob-split">
      <ChainCanvas model={model} pos={pos} onMove={onMove} marks={target} fill={(s) => heat(cur[s])} nodeText={(s) => cur[s].toFixed(2)} />
      <div className="bounded-controls">
        <div className="bc-row">
          <span className="bc-label">target</span>
          {model.props.map((p) => (
            <button key={p} className={`chip${prop === p ? ' on' : ''}`} onClick={() => setProp(p)}>{p}</button>
          ))}
        </div>
        <StepChart series={series} unbounded={unbounded} k={k} onK={setK} kmax={KMAX} />
        <div className="bc-readout">
          {model.kind === 'mdp' ? 'Pmax' : 'P'}(F≤<b>{k}</b> {prop || '—'}) = <b>{series[k]?.toFixed(6)}</b>
          <span className="bc-limit"> → {unbounded.toFixed(6)} as k→∞</span>
        </div>
      </div>
    </div>
  )
}

function StepChart({ series, unbounded, k, onK, kmax }: { series: number[]; unbounded: number; k: number; onK: (k: number) => void; kmax: number }) {
  const W = 320
  const H = 150
  const pad = 24
  const x = (i: number) => pad + (i / kmax) * (W - pad - 6)
  const y = (v: number) => H - pad - v * (H - pad - 8)
  const pts = series.map((v, i) => `${x(i)},${y(v)}`).join(' ')
  return (
    <svg className="step-chart" viewBox={`0 0 ${W} ${H}`} width="100%">
      <line x1={pad} y1={y(0)} x2={W - 4} y2={y(0)} className="axis" />
      <line x1={pad} y1={y(1)} x2={pad} y2={y(0)} className="axis" />
      <line x1={pad} y1={y(unbounded)} x2={W - 4} y2={y(unbounded)} className="limit-line" />
      <text className="chart-tick" x={pad - 4} y={y(1) + 3} textAnchor="end">1</text>
      <text className="chart-tick" x={pad - 4} y={y(0) + 3} textAnchor="end">0</text>
      <text className="chart-tick" x={pad - 4} y={y(unbounded) + 3} textAnchor="end">{unbounded.toFixed(2)}</text>
      <polyline className="series" points={pts} fill="none" />
      {series.map((v, i) => (
        <circle key={i} className={`pt${i === k ? ' on' : ''}`} cx={x(i)} cy={y(v)} r={i === k ? 3.2 : 1.8} onClick={() => onK(i)} />
      ))}
      <text className="chart-axis-label" x={(W + pad) / 2} y={H - 4} textAnchor="middle">step bound k</text>
    </svg>
  )
}

// ---------------------------------------------------------------------------
// Simulate tab — Monte-Carlo convergence + an animated sample path
// ---------------------------------------------------------------------------

function SimulateCanvas({ model, pos, onMove }: { model: Model; pos: (s: number) => { x: number; y: number }; onMove: CanvasProps['onMove'] }) {
  const [prop, setProp] = useState(() => firstProp(model))
  const [seed, setSeed] = useState(12345)
  const [step, setStep] = useState(0)
  const [playing, setPlaying] = useState(false)
  const [lastModel, setLastModel] = useState(model)
  if (model !== lastModel) {
    setLastModel(model)
    setProp(firstProp(model))
    setStep(0)
  }
  const target = useMemo(() => model.label.map((l) => l.has(prop)), [model, prop])
  const all = useMemo(() => new Array<boolean>(model.n).fill(true), [model])

  const policy = useMemo(() => (model.kind === 'mdp' ? policyIterationExact(model, all, target, 'max').policy : undefined), [model, all, target])
  const path = useMemo(() => samplePath(model, seed, 40, policy), [model, seed, policy])
  const current = path.states[Math.min(step, path.states.length - 1)]

  const exact = useMemo(() => {
    if (model.kind === 'dtmc') return ftoNumber(reachExact(model, target)[model.init])
    return ftoNumber(policyIterationExact(model, all, target, 'max').value[model.init])
  }, [model, all, target])

  const [trials, setTrials] = useState(2000)
  const est = useMemo(() => estimateUntil(model, all, target, seed * 7 + 3, trials, 3000, policy), [model, all, target, seed, trials, policy])

  useEffect(() => {
    if (!playing) return
    const id = window.setInterval(() => setStep((s) => (s + 1 >= path.states.length ? 0 : s + 1)), 380)
    return () => window.clearInterval(id)
  }, [playing, path.states.length])

  const err = Math.abs(est.estimate - exact)
  return (
    <div className="prob-split">
      <ChainCanvas model={model} pos={pos} onMove={onMove} marks={target} current={current} fill={(s) => (s === current ? 'color-mix(in srgb, var(--warn) 45%, var(--node))' : 'var(--node)')} />
      <div className="sim-controls">
        <div className="bc-row">
          <span className="bc-label">target</span>
          {model.props.map((p) => (
            <button key={p} className={`chip${prop === p ? ' on' : ''}`} onClick={() => setProp(p)}>{p}</button>
          ))}
        </div>
        <div className="sim-path">
          <button className="chip on" onClick={() => setPlaying((p) => !p)}>{playing ? '⏸ pause' : '▶ play'}</button>
          <button className="chip" onClick={() => setStep((s) => Math.max(0, s - 1))}>◀</button>
          <button className="chip" onClick={() => setStep((s) => Math.min(path.states.length - 1, s + 1))}>▶</button>
          <button className="chip" onClick={() => { setSeed((x) => (x * 1103515245 + 12345) & 0x7fffffff); setStep(0) }}>🎲 new path</button>
          <span className="sim-step">step {step} · <b>{model.labels[current]}</b></span>
        </div>
        <div className="sim-estimate">
          <div className="se-row"><span>Monte-Carlo ({trials.toLocaleString()} runs)</span><b>{est.estimate.toFixed(4)}</b></div>
          <div className="se-row"><span>exact answer</span><b className="se-exact">{exact.toFixed(4)}</b></div>
          <div className="se-row"><span>|error|</span><b className={err < est.stderr95 + 0.01 ? 'se-ok' : 'se-warn'}>{err.toFixed(4)}</b></div>
          <div className="se-band">95% band ±{est.stderr95.toFixed(4)}</div>
          <label className="trials-slider">samples
            <input type="range" min={200} max={20000} step={200} value={trials} onChange={(e) => setTrials(Number(e.target.value))} />
            <span className="mono">{trials.toLocaleString()}</span>
          </label>
        </div>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Rail (right panel) — context per tab
// ---------------------------------------------------------------------------

interface RailProps {
  model: Model | null
  parseErrors: string[]
  issues: { where: string; message: string }[]
  source: string
  onSource: (s: string) => void
  query: string
  onQuery: (q: string) => void
  tab: ProbTab
}

function Rail({ model, parseErrors, issues, source, onSource, query, onQuery, tab }: RailProps) {
  if (tab === 'verify' || tab === 'about') {
    return (
      <section className="panel">
        <h2>{tab === 'verify' ? 'Differential proof' : 'The theory'}</h2>
        <p className="panel-sub">
          {tab === 'verify'
            ? 'Every probability the engine reports is recomputed three unrelated ways — an exact rational linear solve, floating-point value iteration, and Monte-Carlo sampling — and pinned against textbook closed forms. Run the suite in the main panel.'
            : 'A short tour of discrete-time Markov chains, MDPs, and PCTL. See the main panel.'}
        </p>
      </section>
    )
  }
  return (
    <>
      <section className="panel">
        <h2>Model</h2>
        <p className="panel-sub">
          Pick a chain, or edit the source below. States are created on first mention; probabilities may be
          fractions or decimals, each read <b>exactly</b>. MDP lines carry an action: <span className="mono">s -go-&gt; 7/10: a, 3/10: b</span>.
        </p>
        <div className="example-gallery">
          {PROB_EXAMPLES.map((e) => (
            <button
              key={e.id}
              className={`chip${sameExample(source, e.id) ? ' on' : ''}`}
              title={e.blurb}
              onClick={() => {
                onSource(e.source)
                onQuery(e.queries[0])
              }}
            >
              {e.name}
            </button>
          ))}
        </div>
        {model && (
          <div className="stat-line">
            <span className="stat"><span className="stat-k">type</span><span className="stat-v">{model.kind.toUpperCase()}</span></span>
            <span className="stat"><span className="stat-k">states</span><span className="stat-v">{model.n}</span></span>
            <span className="stat"><span className="stat-k">props</span><span className="stat-v">{model.props.length}</span></span>
          </div>
        )}
        <textarea
          className="source-editor"
          spellCheck={false}
          value={source}
          onChange={(e) => onSource(e.target.value)}
        />
        {parseErrors.length > 0 && (
          <div className="parse-errs">
            {parseErrors.slice(0, 6).map((e, i) => (
              <div key={i} className="perr">⚠ {e}</div>
            ))}
          </div>
        )}
        {model && issues.length > 0 && (
          <div className="parse-errs">
            {issues.slice(0, 6).map((e, i) => (
              <div key={i} className="perr">⚠ {e.where}: {e.message}</div>
            ))}
          </div>
        )}
      </section>

      {(tab === 'query' || tab === 'chain') && model && (
        <QueryRail model={model} source={source} query={query} onQuery={onQuery} />
      )}
    </>
  )
}

function QueryRail({ model, source, query, onQuery }: { model: Model; source: string; query: string; onQuery: (q: string) => void }) {
  const suggestions = suggestQueries(model, source)
  const ev = useMemo(() => evaluateQuery(model, query), [model, query])
  const strat = useMemo(() => {
    if (model.kind !== 'mdp') return null
    if (ev.kind !== 'query' || ev.formula?.t !== 'prob') return null
    const f = ev.formula
    if (f.path.t !== 'until' && f.path.t !== 'eventually') return null
    const opt = f.kind === 'min' ? 'min' : 'max'
    const target = f.path.t === 'eventually' ? checkState(model, f.path.f) : checkState(model, f.path.b)
    const phi = f.path.t === 'eventually' ? new Array<boolean>(model.n).fill(true) : checkState(model, (f.path as { a: StateF }).a)
    const pi = policyIterationExact(model as MDP, phi, target, opt)
    return { policy: pi.policy, value: pi.value, opt }
  }, [model, ev])

  return (
    <section className="panel">
      <h2>PCTL query</h2>
      <p className="panel-sub">
        <b>P⋈p [ ψ ]</b> tests the probability of a path property; <b>P=? [ ψ ]</b> reports it.
        Paths: <span className="mono">X φ</span>, <span className="mono">φ U ψ</span>, <span className="mono">F ψ</span>, <span className="mono">G ψ</span> (add <span className="mono">&lt;=k</span> for a step bound). <b>S=? [ φ ]</b> is the long-run frequency.
      </p>
      <input className="query-input" spellCheck={false} value={query} onChange={(e) => onQuery(e.target.value)} placeholder="P=? [ F goal ]" />
      <div className="example-gallery">
        {suggestions.map((q) => (
          <button key={q} className={`chip${query.trim() === q ? ' on' : ''}`} onClick={() => onQuery(q)}>{q}</button>
        ))}
      </div>
      {ev.kind === 'error' ? (
        <div className="q-badge bad small">✗ {ev.message}</div>
      ) : ev.kind === 'query' && ev.prob ? (
        <div className="q-rail-answer">
          <span className="mono big">{ev.prob.exact ? ftoStr(ev.prob.exact[model.init]) : ev.prob.approx[model.init].toFixed(6)}</span>
          <span className="q-sub">{ev.formula ? showState(ev.formula) : ''} at {model.labels[model.init]}</span>
        </div>
      ) : ev.kind === 'bool' && ev.sat ? (
        <div className={`q-badge ${ev.sat[model.init] ? 'ok' : 'bad'} small`}>
          {ev.sat[model.init] ? '✓ holds' : '✗ fails'} at {model.labels[model.init]} · {ev.sat.filter(Boolean).length}/{model.n} states
        </div>
      ) : null}

      {model.kind === 'dtmc' && (
        <ExpectedSteps model={model} query={query} />
      )}
      {strat && (
        <div className="strat-panel">
          <h3>Optimal {strat.opt === 'max' ? 'maximising' : 'minimising'} strategy</h3>
          <table className="strat-table">
            <tbody>
              {Array.from({ length: model.n }, (_, s) => {
                const menu = (model as MDP).actions[s]
                if (menu.length <= 1) return null
                return (
                  <tr key={s}>
                    <td className="mono">{model.labels[s]}</td>
                    <td className="mono strat-act">{menu[strat.policy[s]]?.name}</td>
                    <td className="mono">{ftoStr(strat.value[s])}</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  )
}

function ExpectedSteps({ model, query }: { model: DTMC; query: string }) {
  const prop = useMemo(() => {
    try {
      const f = parsePctl(query)
      const tgt = firstEventuallyProp(f)
      return tgt ?? model.props[0] ?? ''
    } catch {
      return model.props[0] ?? ''
    }
  }, [model, query])
  const es = useMemo(() => {
    if (!prop) return null
    const target = model.label.map((l) => l.has(prop))
    return expectedStepsExact(model, target)[model.init]
  }, [model, prop])
  if (!prop) return null
  return (
    <div className="expected-steps">
      <span className="es-k">E[steps to {prop}]</span>
      <span className="es-v">{es === null ? '∞' : ftoStr(es)}{es !== null && es.d !== 1n ? ` ≈ ${ftoDecimal(es, 3)}` : ''}</span>
    </div>
  )
}

function firstEventuallyProp(f: StateF): string | null {
  if (f.t === 'prob') {
    const p = f.path
    if (p.t === 'eventually' && p.f.t === 'ap') return p.f.name
    if (p.t === 'until' && p.b.t === 'ap') return p.b.name
  }
  return null
}

// ---------------------------------------------------------------------------
// Verify + About + parse error
// ---------------------------------------------------------------------------

function VerifyTab() {
  const [res, setRes] = useState<ReturnType<typeof runProbSelfTest> | null>(null)
  return (
    <div className="verify-pane">
      <div className="verify-head">
        <h2>Proof harness</h2>
        <button className="chip on" onClick={() => setRes(runProbSelfTest())}>run all checks</button>
      </div>
      <p className="panel-sub">
        Each probability is computed three structurally-independent ways — an <b>exact rational</b> linear solve, a
        floating-point <b>value iteration</b>, and <b>Monte-Carlo</b> sampling — and pinned against textbook closed
        forms (the die's 1/6, craps' 244/495, the ruin martingale, a 2/7 steady state). For MDPs, exact
        <b> policy iteration</b> is refereed by a brute-force scan of every deterministic policy.
      </p>
      {res && (
        <>
          <div className={`verify-banner ${res.ok ? 'ok' : 'bad'}`}>
            {res.ok ? '✓' : '✗'} {res.passed}/{res.total} checks passed
          </div>
          <ul className="verify-list">
            {res.results.map((r, i) => (
              <li key={i} className={r.pass ? 'ok' : 'bad'}>
                <span className="v-ic">{r.pass ? '✓' : '✗'}</span>
                <span className="v-name">{r.name}</span>
                <span className="v-detail">{r.detail}</span>
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  )
}

function ParseErrorPane({ errors }: { errors: string[] }) {
  return (
    <div className="parse-pane">
      <h2>Model won’t parse</h2>
      <ul>
        {errors.map((e, i) => (
          <li key={i} className="mono">{e}</li>
        ))}
      </ul>
      <p className="panel-sub">Fix the source in the right-hand panel, or pick a gallery model to start from.</p>
    </div>
  )
}

function AboutTab() {
  return (
    <div className="about-pane">
      <h2>Probabilistic model checking</h2>
      <p>
        The rest of this lab asks yes/no questions — does the automaton accept, does the system satisfy the
        formula? Real systems are <em>random</em>: a coin flips, a packet drops, a scheduler chooses. This mode
        replaces non-determinism with <b>chance</b> and asks quantitative questions instead — <i>with what
        probability?</i>
      </p>
      <h3>Two models</h3>
      <p>
        A <b>discrete-time Markov chain (DTMC)</b> gives every state a single probability distribution over its
        successors. A <b>Markov decision process (MDP)</b> restores choice: each state offers a menu of{' '}
        <b>actions</b>, and only after an action is chosen does chance act — so an MDP is really a game between a
        controller and fate, and the questions become <b>Pmax</b> (the best scheduler) and <b>Pmin</b> (the worst).
      </p>
      <h3>PCTL</h3>
      <p>
        Probabilistic CTL keeps CTL's shape but swaps the ∀/∃ path quantifiers for a probability operator:{' '}
        <span className="mono">P&gt;=0.99 [ F delivered ]</span> — "with probability at least 0.99, delivery
        eventually happens". Path operators are <b>X</b> (next), <b>U</b> (until), <b>F</b> (eventually) and{' '}
        <b>G</b> (always), each with an optional step bound <span className="mono">&lt;=k</span>. The{' '}
        <span className="mono">S</span> operator asks for the <b>long-run</b> frequency (the stationary
        distribution).
      </p>
      <h3>How the numbers are computed</h3>
      <p>
        Unbounded reachability <span className="mono">P(F ψ)</span> is not a limit to approximate — it is the exact
        solution of a linear system <span className="mono">(I − P)·x = b</span> over the "maybe" states, which the
        engine solves in <b>exact BigInt fractions</b>. So the die really is 1/6 and craps really is 244/495, with
        no floating-point dust. Step-bounded properties are exact matrix iteration; MDP optima come from value
        iteration and exact <b>policy iteration</b>; the long run comes from the stationary distributions of the
        chain's bottom strongly-connected components.
      </p>
      <h3>Why you can trust it</h3>
      <p>
        The <b>Verify</b> tab is a differential proof: the exact rational solve, an independent floating-point value
        iteration, and a Monte-Carlo simulation must all agree, on the gallery and on hundreds of random models —
        and the closed-form answers from the textbooks must come out on the nose. For MDPs, exact policy iteration
        is checked against a brute-force scan of <em>every</em> deterministic policy. Nothing here is a stored
        constant; press the button and watch it recompute.
      </p>
    </div>
  )
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function matchExample(source: string) {
  return PROB_EXAMPLES.find((e) => e.source.trim() === source.trim())
}
function sameExample(source: string, id: string): boolean {
  return matchExample(source)?.id === id
}
/** Suggested queries: the gallery's own if the source is unedited, else generic ones from the props. */
function suggestQueries(model: Model, source: string): string[] {
  const ex = matchExample(source)
  if (ex) return ex.queries.filter((q) => q !== 'R')
  const p = model.props[0]
  if (!p) return []
  if (model.kind === 'mdp') return [`Pmax=? [ F ${p} ]`, `Pmin=? [ F ${p} ]`, `Pmax>=1/2 [ F ${p} ]`]
  return [`P=? [ F ${p} ]`, `P=? [ F<=5 ${p} ]`, `P>=1/2 [ F ${p} ]`, `S=? [ ${p} ]`]
}
