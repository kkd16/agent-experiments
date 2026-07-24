import { useCallback, useEffect, useRef, useState } from 'react'
import './App.css'
import About from './components/About'
import Controls from './components/Controls'
import Race from './components/Race'
import type { LaneMeta } from './components/Race'
import Stats from './components/Stats'
import { Lane } from './engine/lane'
import type { LiveStats } from './engine/simulation'
import type { LaneConfig, Mode, StudioConfig } from './engine/permalink'
import { decodeConfig, shareUrl, writeHash } from './engine/permalink'
import { renderField } from './render/field'
import {
  drawAcf,
  drawAcfMulti,
  drawConvergence,
  drawHistMulti,
  drawHistogram,
  drawTrace,
  drawTraceMulti,
} from './render/plots'
import { SAMPLERS, samplerById } from './samplers/samplers'
import { TARGETS } from './targets/targets'

// Two lanes, two identities. Lane A is the studio blue, lane B a warm amber.
const LANE_COLORS = ['#6ea8ff', '#ffb54a']
const LANE_TRAIL: [number, number, number][] = [
  [150, 190, 255],
  [255, 190, 110],
]
const LANE_SPLAT = ['rgba(120,180,255,0.05)', 'rgba(255,181,74,0.05)']

function defaultParams(samplerId: string): Record<string, number> {
  const def = samplerById(samplerId)
  const p: Record<string, number> = {}
  for (const spec of def.params) p[spec.key] = spec.default
  return p
}

const EMPTY_STATS: LiveStats = {
  iters: 0, acceptRate: 0, essX: 0, essY: 0, rhatX: NaN, rhatY: NaN, tauX: NaN,
  meanX: 0, meanY: 0, sdX: 0, sdY: 0, ci: [NaN, NaN],
  densityEvals: 0, gradEvals: 0, essPerKEval: 0, usedForStats: 0,
}

/** Build the initial config once, from the URL hash if present, else defaults. */
function makeInitial(): StudioConfig {
  const hash = typeof window !== 'undefined' ? window.location.hash : ''
  const base = decodeConfig(hash)
  const targetOk = (id: string) => TARGETS.some((t) => t.id === id)
  const samplerOk = (id: string) => SAMPLERS.some((s) => s.id === id)
  const lane = (l: LaneConfig | undefined, fallback: string): LaneConfig => {
    const sid = l && samplerOk(l.samplerId) ? l.samplerId : fallback
    return { samplerId: sid, params: { ...defaultParams(sid), ...(l?.params ?? {}) } }
  }
  return {
    mode: base?.mode === 'race' ? 'race' : 'single',
    targetId: base && targetOk(base.targetId) ? base.targetId : 'banana',
    seed: base?.seed ?? 1234,
    burnInFrac: base?.burnInFrac ?? 0.1,
    lanes: [lane(base?.lanes[0], 'hmc'), lane(base?.lanes[1], 'rwm')],
  }
}

export default function App() {
  const [init] = useState(makeInitial)

  const [mode, setMode] = useState<Mode>(init.mode)
  const [targetId, setTargetId] = useState(init.targetId)
  const [lanes, setLanes] = useState<[LaneConfig, LaneConfig]>([init.lanes[0], init.lanes[1]])
  const [selLane, setSelLane] = useState(0)
  const [seed, setSeed] = useState(init.seed)
  const [burnInFrac, setBurnInFrac] = useState(init.burnInFrac)
  const [speed, setSpeed] = useState(30)
  const [running, setRunning] = useState(true)
  const [showField, setShowField] = useState(true)
  const [showTrail, setShowTrail] = useState(true)
  const [showTrajectory, setShowTrajectory] = useState(true)
  const [showCloud, setShowCloud] = useState(true)
  const [showAbout, setShowAbout] = useState(false)
  const [copied, setCopied] = useState(false)
  const [stats, setStats] = useState<[LiveStats, LiveStats]>([EMPTY_STATS, EMPTY_STATS])

  const laneCount = mode === 'race' ? 2 : 1

  // Per-lane engine + canvas runtime (opaque to React; driven via methods).
  const laneRef = useRef<[Lane, Lane]>([
    new Lane(0, LANE_SPLAT[0], LANE_TRAIL[0]),
    new Lane(1, LANE_SPLAT[1], LANE_TRAIL[1]),
  ])
  const fieldRef = useRef<HTMLCanvasElement | null>(null)

  const traceXRef = useRef<HTMLCanvasElement | null>(null)
  const traceYRef = useRef<HTMLCanvasElement | null>(null)
  const histXRef = useRef<HTMLCanvasElement | null>(null)
  const histYRef = useRef<HTMLCanvasElement | null>(null)
  const acfRef = useRef<HTMLCanvasElement | null>(null)
  const convRef = useRef<HTMLCanvasElement | null>(null)

  // Loop-facing mirrors of reactive state (so the rAF loop never restarts).
  const runningRef = useRef(running)
  const speedRef = useRef(speed)
  const showFieldRef = useRef(showField)
  const showCloudRef = useRef(showCloud)
  const laneCountRef = useRef(laneCount)
  const sceneOptsRef = useRef({ showField, showTrail, showTrajectory })
  useEffect(() => {
    runningRef.current = running
    speedRef.current = speed
    showFieldRef.current = showField
    showCloudRef.current = showCloud
    laneCountRef.current = laneCount
    sceneOptsRef.current = { showField, showTrail, showTrajectory }
  }, [running, speed, showField, showCloud, showTrail, showTrajectory, laneCount])

  const readStats = useCallback((): [LiveStats, LiveStats] => {
    const rt = laneRef.current
    return [rt[0].stats() ?? EMPTY_STATS, rt[1].stats() ?? EMPTY_STATS]
  }, [])

  // ── (re)build simulations whenever the configuration changes ────────
  // Pure engine work — no setState, so it's safe to run from an effect.
  const rebuild = useCallback(() => {
    const rt = laneRef.current
    for (let i = 0; i < 2; i++) {
      if (i < laneCount) {
        rt[i].rebuild({
          targetId,
          samplerId: lanes[i].samplerId,
          params: lanes[i].params,
          seed,
          burnInFrac,
        })
      } else {
        rt[i].clear()
      }
    }
  }, [laneCount, targetId, lanes, seed, burnInFrac])

  // Rebuild + immediately refresh the readout (for buttons / keyboard).
  const hardReset = useCallback(() => {
    rebuild()
    setStats(readStats())
  }, [rebuild, readStats])

  useEffect(() => {
    rebuild()
    // Defer the stat refresh out of the effect body (next frame) so we never
    // setState synchronously during commit.
    const id = requestAnimationFrame(() => setStats(readStats()))
    return () => cancelAnimationFrame(id)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, targetId, seed, JSON.stringify(lanes)])

  // burn-in only changes which slice stats use — no rebuild needed.
  useEffect(() => {
    const rt = laneRef.current
    rt[0].setBurnIn(burnInFrac)
    rt[1].setBurnIn(burnInFrac)
  }, [burnInFrac])

  // ── shared density field for the current target ─────────────────────
  useEffect(() => {
    const t = TARGETS.find((x) => x.id === targetId)!
    fieldRef.current = renderField(t, 260)
  }, [targetId])

  // ── permalink: mirror the whole config into the URL hash ────────────
  useEffect(() => {
    writeHash({ mode, targetId, seed, burnInFrac, lanes: lanes.slice(0, laneCount) })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, targetId, seed, burnInFrac, JSON.stringify(lanes), laneCount])

  // ── size the canvases to their containers (DPI aware) ───────────────
  const sizeCanvases = useCallback(() => {
    const t = TARGETS.find((x) => x.id === targetId)!
    const rt = laneRef.current
    for (let i = 0; i < laneCount; i++) rt[i].resize(t.view)
    for (const ref of [traceXRef, traceYRef, histXRef, histYRef, acfRef, convRef]) {
      const c = ref.current
      if (c) sizeDiag(c)
    }
  }, [targetId, laneCount])

  useEffect(() => {
    sizeCanvases()
    window.addEventListener('resize', sizeCanvases)
    // Re-fit shortly after a mode switch so the newly-mounted lane lays out.
    const id = window.setTimeout(sizeCanvases, 0)
    return () => {
      window.clearTimeout(id)
      window.removeEventListener('resize', sizeCanvases)
    }
  }, [sizeCanvases])

  const drawPlots = useCallback(() => {
    const rt = laneRef.current
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
    const truthX = TARGETS.find((t) => t.id === targetId)?.trueMean?.[0]
    if (laneCount === 2) {
      // Head-to-head: overlay both chains in their lane colours.
      const cx = [rt[0].column(0), rt[1].column(0)]
      const cy = [rt[0].column(1), rt[1].column(1)]
      const h0 = rt[0].history(0)
      const h1 = rt[1].history(0)
      draw(traceXRef, (ctx, w, h) => drawTraceMulti(ctx, w, h, cx, LANE_COLORS))
      draw(traceYRef, (ctx, w, h) => drawTraceMulti(ctx, w, h, cy, LANE_COLORS))
      draw(histXRef, (ctx, w, h) => drawHistMulti(ctx, w, h, cx, LANE_COLORS))
      draw(histYRef, (ctx, w, h) => drawHistMulti(ctx, w, h, cy, LANE_COLORS))
      draw(acfRef, (ctx, w, h) => drawAcfMulti(ctx, w, h, cx, LANE_COLORS))
      draw(convRef, (ctx, w, h) =>
        drawConvergence(ctx, w, h, [h0.iter, h1.iter], [h0.val, h1.val], LANE_COLORS, truthX),
      )
    } else {
      const cx = rt[0].column(0)
      const cy = rt[0].column(1)
      const h0 = rt[0].history(0)
      draw(traceXRef, (ctx, w, h) => drawTrace(ctx, w, h, cx, '#6ea8ff'))
      draw(traceYRef, (ctx, w, h) => drawTrace(ctx, w, h, cy, '#ff9f6e'))
      draw(histXRef, (ctx, w, h) => drawHistogram(ctx, w, h, cx, '#6ea8ff'))
      draw(histYRef, (ctx, w, h) => drawHistogram(ctx, w, h, cy, '#ff9f6e'))
      draw(acfRef, (ctx, w, h) => drawAcf(ctx, w, h, cx))
      draw(convRef, (ctx, w, h) => drawConvergence(ctx, w, h, [h0.iter], [h0.val], ['#6ea8ff'], truthX))
    }
  }, [laneCount, targetId])

  // ── the single animation loop (mounted once) ────────────────────────
  useEffect(() => {
    let raf = 0
    let lastStats = 0
    const loop = () => {
      const rt = laneRef.current
      const n = laneCountRef.current
      const opts = sceneOptsRef.current
      let stepped = false
      for (let i = 0; i < n; i++) {
        if (runningRef.current) {
          rt[i].step(speedRef.current)
          stepped = true
        }
        rt[i].render(showFieldRef.current ? fieldRef.current : null, showCloudRef.current, opts)
      }
      const now = performance.now()
      if (stepped && now - lastStats > 220) {
        lastStats = now
        setStats(readStats())
        drawPlots()
      }
      raf = requestAnimationFrame(loop)
    }
    raf = requestAnimationFrame(loop)
    return () => cancelAnimationFrame(raf)
  }, [drawPlots, readStats])

  // ── handlers ────────────────────────────────────────────────────────
  const onSampler = (id: string) =>
    setLanes((ls) => {
      const next: LaneConfig = { samplerId: id, params: defaultParams(id) }
      return selLane === 0 ? [next, ls[1]] : [ls[0], next]
    })
  const onParam = (key: string, v: number) =>
    setLanes((ls) => {
      const cur = ls[selLane]
      const next: LaneConfig = { samplerId: cur.samplerId, params: { ...cur.params, [key]: v } }
      return selLane === 0 ? [next, ls[1]] : [ls[0], next]
    })
  const onReseed = () => setSeed((sd) => (sd * 1103515245 + 12345) & 0x7fffffff)
  const onReset = () => hardReset()
  const onStep = () => {
    const rt = laneRef.current
    for (let i = 0; i < laneCount; i++) rt[i].step(1)
    setStats(readStats())
    drawPlots()
  }
  const onExport = () => {
    const sim = laneRef.current[selLane].chain
    if (!sim) return
    try {
      const n = sim.xs.length
      const rows: string[] = ['index,' + (target.axes ?? ['x', 'y']).join(',') + ',logdensity']
      for (let i = 0; i < n; i++) {
        rows.push(`${i},${sim.xs[i].toFixed(6)},${sim.ys[i].toFixed(6)},${sim.logps[i].toFixed(6)}`)
      }
      const blob = new Blob([rows.join('\n')], { type: 'text/csv' })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `markov-${targetId}-${lanes[selLane].samplerId}-${n}.csv`
      a.click()
      URL.revokeObjectURL(url)
    } catch {
      /* download blocked (e.g. sandboxed preview) — ignore */
    }
  }
  const onCopyLink = () => {
    const url = shareUrl({ mode, targetId, seed, burnInFrac, lanes: lanes.slice(0, laneCount) })
    try {
      navigator.clipboard?.writeText(url)
    } catch {
      /* clipboard blocked — the hash is already in the address bar regardless */
    }
    setCopied(true)
    window.setTimeout(() => setCopied(false), 1400)
  }
  const onMode = (m: Mode) => {
    setMode(m)
    if (m === 'single') setSelLane(0)
  }
  const onToggle = (k: 'showField' | 'showTrail' | 'showTrajectory' | 'showCloud') => {
    if (k === 'showField') setShowField((v) => !v)
    if (k === 'showTrail') setShowTrail((v) => !v)
    if (k === 'showTrajectory') setShowTrajectory((v) => !v)
    if (k === 'showCloud') setShowCloud((v) => !v)
  }

  // keyboard shortcuts: space = run/pause, s = step, r = reset
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement) return
      if (e.code === 'Space') {
        e.preventDefault()
        setRunning((v) => !v)
      } else if (e.key === 's') {
        onStep()
      } else if (e.key === 'r') {
        hardReset()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hardReset, laneCount])

  const target = TARGETS.find((t) => t.id === targetId)!
  const axes = target.axes ?? ['x', 'y']
  const meta: [LaneMeta, LaneMeta] = [
    { name: samplerById(lanes[0].samplerId).name, color: LANE_COLORS[0] },
    { name: samplerById(lanes[1].samplerId).name, color: LANE_COLORS[1] },
  ]

  return (
    <div className="studio">
      <Controls
        targets={TARGETS}
        samplers={SAMPLERS}
        targetId={targetId}
        samplerId={lanes[selLane].samplerId}
        params={lanes[selLane].params}
        seed={seed}
        burnInFrac={burnInFrac}
        speed={speed}
        running={running}
        mode={mode}
        selLane={selLane}
        laneColors={LANE_COLORS}
        laneNames={[meta[0].name, meta[1].name]}
        showField={showField}
        showTrail={showTrail}
        showTrajectory={showTrajectory}
        showCloud={showCloud}
        onMode={onMode}
        onSelLane={setSelLane}
        onTarget={setTargetId}
        onSampler={onSampler}
        onParam={onParam}
        onSeed={onReseed}
        onBurnIn={setBurnInFrac}
        onSpeed={setSpeed}
        onToggleRun={() => setRunning((r) => !r)}
        onStep={onStep}
        onReset={onReset}
        onExport={onExport}
        onCopyLink={onCopyLink}
        copied={copied}
        onToggle={onToggle}
      />

      <main className="stage">
        <div className="stage-head">
          <h2>{target.name}</h2>
          {mode === 'single' && <span className="stage-sampler">{meta[0].name}</span>}
          <button className="about-btn" onClick={() => setShowAbout(true)}>
            ? the math
          </button>
        </div>

        {mode === 'single' ? (
          <>
            <div className="canvas-wrap" ref={(el) => laneRef.current[0].attachWrap(el)}>
              <canvas ref={(el) => laneRef.current[0].attachCanvas(el)} className="main-canvas" />
            </div>
            <Stats s={stats[0]} axes={axes} />
          </>
        ) : (
          <>
            <div className="lane-grid">
              {[0, 1].map((i) => (
                <div className="lane" key={i}>
                  <div className="lane-head">
                    <span className="lane-dot" style={{ background: LANE_COLORS[i] }} />
                    <span className="lane-name" style={{ color: LANE_COLORS[i] }}>
                      {meta[i].name}
                    </span>
                  </div>
                  <div className="canvas-wrap" ref={(el) => laneRef.current[i].attachWrap(el)}>
                    <canvas
                      ref={(el) => laneRef.current[i].attachCanvas(el)}
                      className="main-canvas"
                    />
                  </div>
                </div>
              ))}
            </div>
            <Race stats={stats} meta={meta} axes={axes} />
          </>
        )}
      </main>

      <section className="diag-rail">
        <div className="diag-head">{mode === 'race' ? 'Diagnostics · A vs B' : 'Diagnostics'}</div>
        <DiagCard title={`trace · ${axes[0]}`} subtitle="the chain, coordinate 1">
          <canvas ref={traceXRef} className="diag-canvas" />
        </DiagCard>
        <DiagCard title={`trace · ${axes[1]}`} subtitle="the chain, coordinate 2">
          <canvas ref={traceYRef} className="diag-canvas" />
        </DiagCard>
        <DiagCard title={`marginal · ${axes[0]}`} subtitle="histogram of coordinate 1">
          <canvas ref={histXRef} className="diag-canvas" />
        </DiagCard>
        <DiagCard title={`marginal · ${axes[1]}`} subtitle="histogram of coordinate 2">
          <canvas ref={histYRef} className="diag-canvas" />
        </DiagCard>
        <DiagCard title={`autocorrelation · ${axes[0]}`} subtitle="how fast the chain forgets">
          <canvas ref={acfRef} className="diag-canvas" />
        </DiagCard>
        <DiagCard
          title={`convergence · ${axes[0]}`}
          subtitle={target.trueMean ? 'running mean → true value' : 'running mean vs iterations'}
        >
          <canvas ref={convRef} className="diag-canvas" />
        </DiagCard>
      </section>

      {showAbout && <About onClose={() => setShowAbout(false)} />}
    </div>
  )
}

/** DPI-aware resize for the small diagnostic canvases. */
function sizeDiag(canvas: HTMLCanvasElement) {
  const dpr = Math.min(2, window.devicePixelRatio || 1)
  const r = canvas.getBoundingClientRect()
  canvas.width = Math.round(r.width * dpr)
  canvas.height = Math.round(r.height * dpr)
  const ctx = canvas.getContext('2d')
  if (ctx) ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
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
