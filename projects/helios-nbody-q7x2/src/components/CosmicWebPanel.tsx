// The Cosmic Web Lab — watch structure form in an expanding universe.
//
// This lab drives Helios's Particle-Mesh solver (`sim/pm.ts`), the first *grid*
// force solver here: mass is painted onto a mesh, Poisson's equation is solved once
// with an FFT, and the force is read back. It runs in **comoving** coordinates
// against an expanding background a(t), so tiny Gaussian ripples laid down by the
// Zel'dovich approximation grow — at first exactly as linear theory predicts (σ ∝ a),
// then, as gravity wins, collapsing into the filaments, walls and voids of the
// **cosmic web**. The growth plot shows the measured σ pulling away from the linear
// line: the moment structure formation goes nonlinear.

import { useCallback, useEffect, useRef, useState } from 'react'
import { CosmicPM } from '../sim/pm'
import { sampleColorMap } from '../render/colormap'
import { Slider } from './primitives'

const BOX = 1
const A_INIT = 0.05
const A_FINAL = 3.0
const DT = 0.006

interface GrowthPoint {
  a: number
  sigma: number
  linear: number
}

interface Snapshot {
  a: number
  z: number
  sigma: number
  n: number
  growth: GrowthPoint[]
}

export function CosmicWebPanel() {
  const [gridExp, setGridExp] = useState(7) // mesh side = 2^gridExp
  const [pSide, setPSide] = useState(128) // particles per side
  const [slope, setSlope] = useState(-2) // P(k) ∝ kⁿ
  const [sigma1, setSigma1] = useState(0.3) // linear σ at a = 1
  const [seed, setSeed] = useState(7)
  const [playing, setPlaying] = useState(false)
  const [snap, setSnap] = useState<Snapshot | null>(null)

  const viewRef = useRef<HTMLCanvasElement | null>(null)
  const plotRef = useRef<HTMLCanvasElement | null>(null)
  const simRef = useRef<CosmicPM | null>(null)
  const growthRef = useRef<GrowthPoint[]>([])
  const sigmaInitRef = useRef<number>(1)
  const raf = useRef(0)
  const playingRef = useRef(false)

  // Build (or rebuild) the simulation from the current controls.
  const build = useCallback(() => {
    const m = 1 << gridExp
    const sim = new CosmicPM({
      m,
      box: BOX,
      particlesPerSide: pSide,
      spectralIndex: slope,
      sigma1,
      seed,
      aInit: A_INIT,
    })
    simRef.current = sim
    const s0 = sim.sigma()
    sigmaInitRef.current = s0 > 0 ? s0 : 1
    growthRef.current = [{ a: sim.a, sigma: s0, linear: s0 }]
    return sim
  }, [gridExp, pSide, slope, sigma1, seed])

  const render = useCallback(() => {
    const sim = simRef.current
    const canvas = viewRef.current
    if (!sim || !canvas) return
    const dpr = Math.min(window.devicePixelRatio || 1, 2)
    const cssW = canvas.clientWidth || 280
    const R = Math.max(120, Math.round(cssW * dpr))
    canvas.width = R
    canvas.height = R

    // Accumulate particles into a render-resolution buffer (a fine density map),
    // then log-normalise and colour-map it — the classic cosmic-web image.
    const acc = new Float32Array(R * R)
    const px = sim.px
    const py = sim.py
    const n = sim.n
    const s = R / BOX
    for (let i = 0; i < n; i++) {
      let u = (px[i] * s) | 0
      let v = (py[i] * s) | 0
      if (u < 0) u = 0
      else if (u >= R) u = R - 1
      if (v < 0) v = 0
      else if (v >= R) v = R - 1
      acc[v * R + u] += 1
    }
    let max = 0
    for (let i = 0; i < acc.length; i++) if (acc[i] > max) max = acc[i]
    const norm = 1 / Math.log1p(6 * Math.max(max, 1))
    const img = new ImageData(R, R)
    const data = img.data
    for (let i = 0; i < acc.length; i++) {
      const t = Math.log1p(6 * acc[i]) * norm
      const [r, g, b] = sampleColorMap('inferno', t)
      const o = i * 4
      data[o] = r
      data[o + 1] = g
      data[o + 2] = b
      data[o + 3] = 255
    }
    const ctx = canvas.getContext('2d')
    if (ctx) ctx.putImageData(img, 0, 0)
  }, [])

  const drawPlot = useCallback((growth: GrowthPoint[]) => {
    const canvas = plotRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    const dpr = Math.min(window.devicePixelRatio || 1, 2)
    const w = canvas.clientWidth
    const h = 150
    canvas.width = Math.max(1, Math.round(w * dpr))
    canvas.height = Math.round(h * dpr)
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.clearRect(0, 0, w, h)
    const padL = 40
    const padB = 20
    const padT = 14
    const plotW = w - padL - 8
    const plotH = h - padB - padT

    // y: log10(σ) over a fixed range; x: scale factor a (linear).
    const yLo = -3
    const yHi = 1
    const xOf = (a: number) => padL + ((a - A_INIT) / (A_FINAL - A_INIT)) * plotW
    const yOf = (sig: number) => padT + (1 - (Math.log10(Math.max(sig, 1e-4)) - yLo) / (yHi - yLo)) * plotH

    ctx.strokeStyle = 'rgba(255,255,255,0.08)'
    ctx.fillStyle = 'rgba(255,255,255,0.4)'
    ctx.font = '9px ui-monospace, monospace'
    ctx.lineWidth = 1
    for (let l = yLo; l <= yHi; l++) {
      const y = yOf(Math.pow(10, l))
      ctx.beginPath()
      ctx.moveTo(padL, y)
      ctx.lineTo(w - 8, y)
      ctx.stroke()
      ctx.fillText(`1e${l}`, 2, y + 3)
    }
    // σ = 1 collapse threshold.
    ctx.strokeStyle = 'rgba(255,209,102,0.35)'
    ctx.setLineDash([3, 3])
    ctx.beginPath()
    ctx.moveTo(padL, yOf(1))
    ctx.lineTo(w - 8, yOf(1))
    ctx.stroke()
    ctx.setLineDash([])
    ctx.fillStyle = 'rgba(255,209,102,0.7)'
    ctx.fillText('σ = 1  (nonlinear)', padL + 4, yOf(1) - 3)
    ctx.fillStyle = 'rgba(255,255,255,0.4)'
    ctx.fillText('a →', w - 26, h - 6)

    const line = (key: 'sigma' | 'linear', color: string, dash: number[]) => {
      ctx.strokeStyle = color
      ctx.lineWidth = 1.8
      ctx.setLineDash(dash)
      ctx.beginPath()
      let started = false
      for (const pt of growth) {
        const x = xOf(pt.a)
        const y = yOf(pt[key])
        if (!started) {
          ctx.moveTo(x, y)
          started = true
        } else ctx.lineTo(x, y)
      }
      ctx.stroke()
      ctx.setLineDash([])
    }
    line('linear', 'rgba(120,180,255,0.75)', [4, 3])
    line('sigma', 'rgba(95,208,255,1)', [])

    ctx.fillStyle = 'rgba(95,208,255,1)'
    ctx.fillText('● measured σ(a)', padL + 2, 10)
    ctx.fillStyle = 'rgba(120,180,255,0.9)'
    ctx.fillText('- - linear ∝ a', padL + 96, 10)
  }, [])

  const publish = useCallback(() => {
    const sim = simRef.current
    if (!sim) return
    setSnap({ a: sim.a, z: sim.redshift(), sigma: sim.sigma(), n: sim.n, growth: growthRef.current.slice() })
  }, [])

  // Ensure a sim exists and render the initial state.
  useEffect(() => {
    build()
    render()
    publish()
    drawPlot(growthRef.current)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [build])

  useEffect(() => {
    drawPlot(snap?.growth ?? [])
  }, [snap, drawPlot])

  const stop = useCallback(() => {
    playingRef.current = false
    cancelAnimationFrame(raf.current)
    setPlaying(false)
  }, [])

  const advance = useCallback(
    (steps: number) => {
      const sim = simRef.current
      if (!sim) return
      for (let i = 0; i < steps && sim.a < A_FINAL; i++) sim.step(DT)
      const sig = sim.sigma()
      const g = growthRef.current
      const last = g[g.length - 1]
      if (!last || sim.a - last.a > 0.015 || sim.a >= A_FINAL) {
        // Linear reference anchored at the initial measured σ (grows ∝ a).
        g.push({ a: sim.a, sigma: sig, linear: sigmaInitRef.current * (sim.a / A_INIT) })
      }
    },
    [],
  )

  // The animation frame is held in a ref so it can schedule itself without a
  // self-referential useCallback. The ref is refreshed in an effect (never during
  // render) so it always closes over the latest advance/render/publish.
  const loopRef = useRef<() => void>(() => {})
  useEffect(() => {
    loopRef.current = () => {
      if (!playingRef.current) return
      advance(1)
      render()
      publish()
      const sim = simRef.current
      if (sim && sim.a >= A_FINAL) {
        stop()
        return
      }
      raf.current = requestAnimationFrame(() => loopRef.current())
    }
  })

  const play = useCallback(() => {
    const sim = simRef.current
    if (!sim || sim.a >= A_FINAL) {
      build()
      render()
    }
    playingRef.current = true
    setPlaying(true)
    raf.current = requestAnimationFrame(() => loopRef.current())
  }, [build, render])

  const stepOnce = useCallback(() => {
    stop()
    advance(4)
    render()
    publish()
  }, [stop, advance, render, publish])

  const reset = useCallback(() => {
    stop()
    build()
    render()
    publish()
  }, [stop, build, render, publish])

  useEffect(() => () => stop(), [stop])

  const growthRatio =
    snap && snap.growth.length > 2
      ? snap.growth[snap.growth.length - 1].sigma / snap.growth[snap.growth.length - 1].linear
      : 1

  return (
    <div className="chaos-panel">
      <p className="integrator-blurb">
        The <strong>Particle-Mesh</strong> solver paints mass onto a grid, solves Poisson's equation with a
        single <strong>FFT</strong>, and reads the force back — the method behind every cosmological N-body
        code. Here it runs in an <strong>expanding universe</strong>: Zel'dovich ripples grow as linear theory
        predicts (σ ∝ a), then collapse into the <strong>cosmic web</strong> of filaments and voids.
      </p>

      <div className="atlas-wrap">
        <canvas ref={viewRef} className="atlas-canvas" style={{ width: '100%', aspectRatio: '1 / 1' }} />
      </div>

      {snap && (
        <div className="fmm-stats">
          <div className="fmm-stat">
            <span className="fmm-k">scale a</span>
            <span className="fmm-v">{snap.a.toFixed(3)}</span>
          </div>
          <div className="fmm-stat">
            <span className="fmm-k">redshift z</span>
            <span className="fmm-v">{snap.z.toFixed(2)}</span>
          </div>
          <div className="fmm-stat">
            <span className="fmm-k">σ (rms δ)</span>
            <span className="fmm-v">{snap.sigma.toFixed(3)}</span>
          </div>
          <div className="fmm-stat">
            <span className="fmm-k">σ / linear</span>
            <span className="fmm-v">{growthRatio.toFixed(2)}×</span>
          </div>
          <div className="fmm-stat">
            <span className="fmm-k">particles</span>
            <span className="fmm-v">{snap.n.toLocaleString()}</span>
          </div>
          <div className="fmm-stat">
            <span className="fmm-k">mesh</span>
            <span className="fmm-v">{1 << gridExp}²</span>
          </div>
        </div>
      )}

      <div className="atlas-wrap">
        <canvas ref={plotRef} className="plot" style={{ width: '100%', height: 150 }} />
      </div>

      <div className="btn-row" style={{ marginTop: 8 }}>
        <button type="button" className={`btn primary${playing ? ' paused' : ''}`} onClick={() => (playing ? stop() : play())}>
          {playing ? '❚❚ Pause' : snap && snap.a >= A_FINAL ? '↻ Replay' : '▶ Evolve'}
        </button>
        <button type="button" className="btn ghost" onClick={stepOnce} disabled={playing}>
          ⏭ Step
        </button>
        <button type="button" className="btn ghost" onClick={reset}>
          ⟲ Reset
        </button>
      </div>

      <Slider
        label="Mesh 2ⁿ"
        value={gridExp}
        min={5}
        max={8}
        step={1}
        onChange={(v) => setGridExp(Math.round(v))}
        format={(v) => `${1 << Math.round(v)}²`}
        title="Poisson mesh resolution — the FFT grid side is 2ⁿ"
      />
      <Slider
        label="Particles/side"
        value={pSide}
        min={48}
        max={192}
        step={16}
        onChange={(v) => setPSide(Math.round(v))}
        format={(v) => `${Math.round(v)}² = ${(Math.round(v) ** 2).toLocaleString()}`}
        title="The initial lattice is P × P particles"
      />
      <Slider
        label="Spectral slope n"
        value={slope}
        min={-3}
        max={0}
        step={0.5}
        onChange={setSlope}
        format={(v) => `P(k) ∝ k^${v.toFixed(1)}`}
        title="Power-spectrum slope of the initial Gaussian field — bluer (larger n) has more small-scale power"
      />
      <Slider
        label="Amplitude σ₁"
        value={sigma1}
        min={0.1}
        max={0.6}
        step={0.05}
        onChange={setSigma1}
        format={(v) => v.toFixed(2)}
        title="Linear σ extrapolated to a = 1 — larger seeds collapse sooner"
      />
      <Slider
        label="Seed"
        value={seed}
        min={1}
        max={40}
        step={1}
        onChange={(v) => setSeed(Math.round(v))}
        format={(v) => `${Math.round(v)}`}
        title="Random seed for the Gaussian initial field"
      />
    </div>
  )
}
