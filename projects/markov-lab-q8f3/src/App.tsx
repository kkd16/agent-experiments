import { useCallback, useEffect, useRef, useState } from 'react'
import './App.css'
import Controls from './components/Controls'
import Stats from './components/Stats'
import { Simulation } from './engine/simulation'
import type { LiveStats } from './engine/simulation'
import { makeTransform, renderField } from './render/field'
import type { Transform } from './render/field'
import { drawAcf, drawHistogram, drawTrace } from './render/plots'
import { drawScene } from './render/scene'
import { SAMPLERS, samplerById } from './samplers/samplers'
import { TARGETS } from './targets/targets'

function defaultParams(samplerId: string): Record<string, number> {
  const def = samplerById(samplerId)
  const p: Record<string, number> = {}
  for (const spec of def.params) p[spec.key] = spec.default
  return p
}

/** Attach a DPI-aware backing store to a canvas and return its 2-D context. */
function prepCanvas(canvas: HTMLCanvasElement, cssW: number, cssH: number): CanvasRenderingContext2D {
  const dpr = Math.min(2, window.devicePixelRatio || 1)
  canvas.width = Math.round(cssW * dpr)
  canvas.height = Math.round(cssH * dpr)
  const ctx = canvas.getContext('2d')!
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  return ctx
}

const EMPTY_STATS: LiveStats = {
  iters: 0, acceptRate: 0, essX: 0, essY: 0, rhatX: NaN, rhatY: NaN, tauX: NaN,
  meanX: 0, meanY: 0, sdX: 0, sdY: 0, ci: [NaN, NaN],
  densityEvals: 0, gradEvals: 0, essPerKEval: 0, usedForStats: 0,
}

export default function App() {
  const [targetId, setTargetId] = useState('banana')
  const [samplerId, setSamplerId] = useState('hmc')
  const [params, setParams] = useState<Record<string, number>>(() => defaultParams('hmc'))
  const [seed, setSeed] = useState(1234)
  const [burnInFrac, setBurnInFrac] = useState(0.1)
  const [speed, setSpeed] = useState(30)
  const [running, setRunning] = useState(true)
  const [showField, setShowField] = useState(true)
  const [showTrail, setShowTrail] = useState(true)
  const [showTrajectory, setShowTrajectory] = useState(true)
  const [stats, setStats] = useState<LiveStats>(EMPTY_STATS)

  // Mutable engine state that must survive re-renders.
  const simRef = useRef<Simulation | null>(null)
  const fieldRef = useRef<HTMLCanvasElement | null>(null)
  const tfRef = useRef<Transform | null>(null)

  const mainRef = useRef<HTMLCanvasElement | null>(null)
  const mainWrapRef = useRef<HTMLDivElement | null>(null)
  const mainCtxRef = useRef<CanvasRenderingContext2D | null>(null)

  const traceXRef = useRef<HTMLCanvasElement | null>(null)
  const traceYRef = useRef<HTMLCanvasElement | null>(null)
  const histXRef = useRef<HTMLCanvasElement | null>(null)
  const histYRef = useRef<HTMLCanvasElement | null>(null)
  const acfRef = useRef<HTMLCanvasElement | null>(null)

  // Loop-facing mirrors of reactive state (so the rAF loop never restarts).
  const runningRef = useRef(running)
  const speedRef = useRef(speed)
  const showFieldRef = useRef(showField)
  const sceneOptsRef = useRef({ showField, showTrail, showTrajectory })
  useEffect(() => {
    runningRef.current = running
    speedRef.current = speed
    showFieldRef.current = showField
    sceneOptsRef.current = { showField, showTrail, showTrajectory }
  }, [running, speed, showField, showTrail, showTrajectory])

  // ── (re)build the simulation whenever the configuration changes ─────
  const rebuild = useCallback(() => {
    simRef.current = new Simulation({ targetId, samplerId, params, seed, burnInFrac })
    setStats(simRef.current.stats())
  }, [targetId, samplerId, params, seed, burnInFrac])

  useEffect(() => {
    rebuild()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [targetId, samplerId, JSON.stringify(params), seed])

  // burn-in only changes which slice stats use — no rebuild needed.
  useEffect(() => {
    if (simRef.current) simRef.current.config.burnInFrac = burnInFrac
  }, [burnInFrac])

  // ── rebuild the density field when the target changes ───────────────
  useEffect(() => {
    const t = TARGETS.find((x) => x.id === targetId)!
    fieldRef.current = renderField(t, 260)
  }, [targetId])

  // ── size the canvases to their containers (DPI aware) ───────────────
  const sizeCanvases = useCallback(() => {
    const wrap = mainWrapRef.current
    const canvas = mainRef.current
    if (wrap && canvas) {
      const rect = wrap.getBoundingClientRect()
      const side = Math.max(160, Math.min(rect.width, rect.height))
      canvas.style.width = `${side}px`
      canvas.style.height = `${side}px`
      mainCtxRef.current = prepCanvas(canvas, side, side)
      const t = TARGETS.find((x) => x.id === targetId)!
      tfRef.current = makeTransform(t.view, side, side)
    }
    for (const ref of [traceXRef, traceYRef, histXRef, histYRef, acfRef]) {
      const c = ref.current
      if (c) {
        const r = c.getBoundingClientRect()
        prepCanvas(c, r.width, r.height)
      }
    }
  }, [targetId])

  useEffect(() => {
    sizeCanvases()
    const ro = new ResizeObserver(() => sizeCanvases())
    if (mainWrapRef.current) ro.observe(mainWrapRef.current)
    window.addEventListener('resize', sizeCanvases)
    return () => {
      ro.disconnect()
      window.removeEventListener('resize', sizeCanvases)
    }
  }, [sizeCanvases])

  const drawPlots = useCallback((sim: Simulation) => {
    const cx = sim.column(0)
    const cy = sim.column(1)
    const draw = (
      ref: React.RefObject<HTMLCanvasElement | null>,
      fn: (ctx: CanvasRenderingContext2D, w: number, h: number) => void,
    ) => {
      const c = ref.current
      if (!c) return
      const ctx = c.getContext('2d')
      if (!ctx) return
      const r = c.getBoundingClientRect()
      fn(ctx, r.width, r.height)
    }
    draw(traceXRef, (ctx, w, h) => drawTrace(ctx, w, h, cx, '#6ea8ff'))
    draw(traceYRef, (ctx, w, h) => drawTrace(ctx, w, h, cy, '#ff9f6e'))
    draw(histXRef, (ctx, w, h) => drawHistogram(ctx, w, h, cx, '#6ea8ff'))
    draw(histYRef, (ctx, w, h) => drawHistogram(ctx, w, h, cy, '#ff9f6e'))
    draw(acfRef, (ctx, w, h) => drawAcf(ctx, w, h, cx))
  }, [])

  // ── the single animation loop (mounted once) ────────────────────────
  useEffect(() => {
    let raf = 0
    let lastStats = 0
    const loop = () => {
      const sim = simRef.current
      const ctx = mainCtxRef.current
      const tf = tfRef.current
      if (sim && ctx && tf) {
        if (runningRef.current) sim.step(speedRef.current)
        drawScene(ctx, sim, tf, showFieldRef.current ? fieldRef.current : null, sceneOptsRef.current)
        const now = performance.now()
        if (now - lastStats > 220) {
          lastStats = now
          setStats(sim.stats())
          drawPlots(sim)
        }
      }
      raf = requestAnimationFrame(loop)
    }
    raf = requestAnimationFrame(loop)
    return () => cancelAnimationFrame(raf)
  }, [drawPlots])

  // ── handlers ────────────────────────────────────────────────────────
  const onSampler = (id: string) => {
    setSamplerId(id)
    setParams(defaultParams(id))
  }
  const onParam = (key: string, v: number) => setParams((p) => ({ ...p, [key]: v }))
  const onReseed = () => setSeed((s) => (s * 1103515245 + 12345) & 0x7fffffff)
  const onReset = () => rebuild()
  const onStep = () => {
    simRef.current?.step(1)
    if (simRef.current) {
      setStats(simRef.current.stats())
      drawPlots(simRef.current)
    }
  }
  const onToggle = (k: 'showField' | 'showTrail' | 'showTrajectory') => {
    if (k === 'showField') setShowField((v) => !v)
    if (k === 'showTrail') setShowTrail((v) => !v)
    if (k === 'showTrajectory') setShowTrajectory((v) => !v)
  }

  const target = TARGETS.find((t) => t.id === targetId)!

  return (
    <div className="studio">
      <Controls
        targets={TARGETS}
        samplers={SAMPLERS}
        targetId={targetId}
        samplerId={samplerId}
        params={params}
        seed={seed}
        burnInFrac={burnInFrac}
        speed={speed}
        running={running}
        showField={showField}
        showTrail={showTrail}
        showTrajectory={showTrajectory}
        onTarget={setTargetId}
        onSampler={onSampler}
        onParam={onParam}
        onSeed={onReseed}
        onBurnIn={setBurnInFrac}
        onSpeed={setSpeed}
        onToggleRun={() => setRunning((r) => !r)}
        onStep={onStep}
        onReset={onReset}
        onToggle={onToggle}
      />

      <main className="stage">
        <div className="stage-head">
          <h2>{target.name}</h2>
          <span className="stage-sampler">{samplerById(samplerId).name}</span>
        </div>
        <div className="canvas-wrap" ref={mainWrapRef}>
          <canvas ref={mainRef} className="main-canvas" />
        </div>
        <Stats s={stats} />
      </main>

      <section className="diag-rail">
        <div className="diag-head">Diagnostics</div>
        <DiagCard title="trace · x" subtitle="the chain, coordinate 1">
          <canvas ref={traceXRef} className="diag-canvas" />
        </DiagCard>
        <DiagCard title="trace · y" subtitle="the chain, coordinate 2">
          <canvas ref={traceYRef} className="diag-canvas" />
        </DiagCard>
        <DiagCard title="marginal · x" subtitle="histogram of coordinate 1">
          <canvas ref={histXRef} className="diag-canvas" />
        </DiagCard>
        <DiagCard title="marginal · y" subtitle="histogram of coordinate 2">
          <canvas ref={histYRef} className="diag-canvas" />
        </DiagCard>
        <DiagCard title="autocorrelation · x" subtitle="how fast the chain forgets">
          <canvas ref={acfRef} className="diag-canvas" />
        </DiagCard>
      </section>
    </div>
  )
}

function DiagCard({
  title,
  subtitle,
  children,
}: {
  title: string
  subtitle: string
  children: React.ReactNode
}) {
  return (
    <div className="diag-card">
      <div className="diag-card-head">
        <span className="diag-title">{title}</span>
        <span className="diag-sub">{subtitle}</span>
      </div>
      {children}
    </div>
  )
}
