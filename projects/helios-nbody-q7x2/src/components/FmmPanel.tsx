// The FMM Lab — watch an O(N) force solver beat O(N²), and prove it stays exact.
//
// Helios's default gravity is Barnes–Hut, O(N log N). This lab drives the Fast
// Multipole Method (see `sim/fmm.ts`) and measures the two claims that matter:
//
//   • Accuracy — the FMM reproduces the brute-force O(N²) sum it accelerates, with
//     an error that falls *geometrically* as the expansion order rises (the
//     convergence plot), and
//   • Cost — the work scales like N, not N², so it pulls away from the direct sum
//     as the crowd grows (the scaling plot, log–log, against the ideal N and N²
//     guide slopes).
//
// Everything is computed live in your browser against the exact same softened
// Newtonian kernel the simulation uses, so the numbers are honest and yours to
// reproduce.

import { useCallback, useEffect, useRef, useState } from 'react'
import { directAccel, fmmAccel, forceError } from '../sim/fmm'
import { Slider } from './primitives'

// Deterministic two-cluster blob, so the adaptive tree has real structure.
function makeSystem(n: number, seed: number) {
  let s = seed >>> 0
  const rng = () => ((s = (s * 1664525 + 1013904223) >>> 0), s / 0xffffffff)
  const posX = new Float64Array(n)
  const posY = new Float64Array(n)
  const mass = new Float64Array(n)
  for (let i = 0; i < n; i++) {
    const off = i < n / 2 ? -70 : 70
    posX[i] = off + (rng() - 0.5) * 180
    posY[i] = (rng() - 0.5) * 180
    mass[i] = 0.4 + rng() * 2.4
  }
  return { posX, posY, mass }
}

interface ConvPoint {
  p: number
  rms: number
}
interface ScalePoint {
  n: number
  fmmMs: number
  directMs: number | null // null when N is too large to sum directly in time
}
interface Accuracy {
  n: number
  p: number
  theta: number
  max: number
  rms: number
  fmmMs: number
  directMs: number
  speedup: number
}

interface Results {
  accuracy: Accuracy | null
  convergence: ConvPoint[]
  scaling: ScalePoint[]
}

const EPS2 = 16 // softening 4, matching the lab's default feel
const G = 1
const SCALE_NS = [500, 1000, 2000, 4000, 8000, 16000, 32000]
const DIRECT_MAX_N = 4000 // beyond this, timing the O(N²) sum would stall the tab

export function FmmPanel() {
  const [n, setN] = useState(6000)
  const [order, setOrder] = useState(5)
  const [theta, setTheta] = useState(0.4)
  const [running, setRunning] = useState(false)
  const [progress, setProgress] = useState(0)
  const [results, setResults] = useState<Results>({ accuracy: null, convergence: [], scaling: [] })

  const convRef = useRef<HTMLCanvasElement | null>(null)
  const scaleRef = useRef<HTMLCanvasElement | null>(null)
  const raf = useRef(0)
  const job = useRef<{ alive: boolean }>({ alive: false })

  const drawConvergence = useCallback((conv: ConvPoint[], curP: number) => {
    const canvas = convRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    const dpr = Math.min(window.devicePixelRatio || 1, 2)
    const w = canvas.clientWidth
    const h = 170
    canvas.width = Math.max(1, Math.round(w * dpr))
    canvas.height = Math.round(h * dpr)
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.clearRect(0, 0, w, h)
    const padL = 38
    const padB = 22
    const padT = 16
    const plotW = w - padL - 8
    const plotH = h - padB - padT
    // y axis: log10(rms), from 0 (1e0) down to -14.
    const yLo = -14
    const yHi = 0
    const xLo = 1
    const xHi = 8
    const xOf = (p: number) => padL + ((p - xLo) / (xHi - xLo)) * plotW
    const yOf = (l: number) => padT + (1 - (l - yLo) / (yHi - yLo)) * plotH

    ctx.strokeStyle = 'rgba(255,255,255,0.08)'
    ctx.fillStyle = 'rgba(255,255,255,0.4)'
    ctx.font = '9px ui-monospace, monospace'
    ctx.lineWidth = 1
    for (let l = yLo; l <= yHi; l += 2) {
      const y = yOf(l)
      ctx.beginPath()
      ctx.moveTo(padL, y)
      ctx.lineTo(w - 8, y)
      ctx.stroke()
      ctx.fillText(`1e${l}`, 2, y + 3)
    }
    ctx.fillText('rms force error', padL, 10)
    ctx.fillText('order p →', w - 60, h - 6)

    if (conv.length > 1) {
      ctx.strokeStyle = 'rgba(95,208,255,0.95)'
      ctx.lineWidth = 1.8
      ctx.beginPath()
      let started = false
      for (const pt of conv) {
        const l = Math.log10(Math.max(pt.rms, 1e-16))
        const x = xOf(pt.p)
        const y = yOf(l)
        if (!started) {
          ctx.moveTo(x, y)
          started = true
        } else ctx.lineTo(x, y)
      }
      ctx.stroke()
      for (const pt of conv) {
        const l = Math.log10(Math.max(pt.rms, 1e-16))
        ctx.fillStyle = pt.p === curP ? 'rgba(255,209,102,1)' : 'rgba(95,208,255,0.95)'
        ctx.beginPath()
        ctx.arc(xOf(pt.p), yOf(l), pt.p === curP ? 4 : 2.6, 0, 2 * Math.PI)
        ctx.fill()
      }
    }
  }, [])

  const drawScaling = useCallback((scaling: ScalePoint[]) => {
    const canvas = scaleRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    const dpr = Math.min(window.devicePixelRatio || 1, 2)
    const w = canvas.clientWidth
    const h = 190
    canvas.width = Math.max(1, Math.round(w * dpr))
    canvas.height = Math.round(h * dpr)
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.clearRect(0, 0, w, h)
    const padL = 40
    const padB = 24
    const padT = 16
    const plotW = w - padL - 10
    const plotH = h - padB - padT

    const nLo = Math.log10(SCALE_NS[0])
    const nHi = Math.log10(SCALE_NS[SCALE_NS.length - 1])
    // y range over measured times (ms), log scale.
    let tMin = Infinity
    let tMax = -Infinity
    for (const s of scaling) {
      if (s.fmmMs > 0) {
        tMin = Math.min(tMin, s.fmmMs)
        tMax = Math.max(tMax, s.fmmMs)
      }
      if (s.directMs && s.directMs > 0) {
        tMin = Math.min(tMin, s.directMs)
        tMax = Math.max(tMax, s.directMs)
      }
    }
    if (!Number.isFinite(tMin)) {
      tMin = 0.1
      tMax = 100
    }
    const yLo = Math.floor(Math.log10(tMin) - 0.3)
    const yHi = Math.ceil(Math.log10(tMax) + 0.6)
    const xOf = (nn: number) => padL + ((Math.log10(nn) - nLo) / (nHi - nLo)) * plotW
    const yOf = (ms: number) => padT + (1 - (Math.log10(Math.max(ms, 1e-6)) - yLo) / (yHi - yLo)) * plotH

    ctx.strokeStyle = 'rgba(255,255,255,0.08)'
    ctx.fillStyle = 'rgba(255,255,255,0.4)'
    ctx.font = '9px ui-monospace, monospace'
    ctx.lineWidth = 1
    for (let l = yLo; l <= yHi; l++) {
      const y = yOf(Math.pow(10, l))
      ctx.beginPath()
      ctx.moveTo(padL, y)
      ctx.lineTo(w - 10, y)
      ctx.stroke()
      ctx.fillText(l >= 3 ? `${Math.pow(10, l - 3)}s` : `${Math.pow(10, l)}ms`, 2, y + 3)
    }
    for (const nn of SCALE_NS) {
      ctx.fillStyle = 'rgba(255,255,255,0.35)'
      ctx.fillText(nn >= 1000 ? `${nn / 1000}k` : `${nn}`, xOf(nn) - 8, h - 8)
    }

    // Ideal guide slopes anchored at the first FMM point.
    const anchor = scaling.find((s) => s.fmmMs > 0)
    if (anchor) {
      const drawGuide = (slope: number, color: string, label: string) => {
        ctx.strokeStyle = color
        ctx.setLineDash([4, 4])
        ctx.lineWidth = 1
        ctx.beginPath()
        const n0 = SCALE_NS[0]
        const n1 = SCALE_NS[SCALE_NS.length - 1]
        const base = anchor.fmmMs
        const y0 = yOf(base * Math.pow(n0 / anchor.n, slope))
        const y1 = yOf(base * Math.pow(n1 / anchor.n, slope))
        ctx.moveTo(xOf(n0), y0)
        ctx.lineTo(xOf(n1), y1)
        ctx.stroke()
        ctx.setLineDash([])
        ctx.fillStyle = color
        ctx.fillText(label, xOf(n1) - 26, y1 - 4)
      }
      drawGuide(1, 'rgba(120,255,170,0.5)', '∝ N')
      drawGuide(2, 'rgba(255,120,120,0.5)', '∝ N²')
    }

    const line = (key: 'fmmMs' | 'directMs', color: string) => {
      ctx.strokeStyle = color
      ctx.lineWidth = 2
      ctx.beginPath()
      let started = false
      for (const s of scaling) {
        const v = s[key]
        if (v == null || v <= 0) {
          continue
        }
        const x = xOf(s.n)
        const y = yOf(v)
        if (!started) {
          ctx.moveTo(x, y)
          started = true
        } else ctx.lineTo(x, y)
      }
      ctx.stroke()
      for (const s of scaling) {
        const v = s[key]
        if (v == null || v <= 0) continue
        ctx.fillStyle = color
        ctx.beginPath()
        ctx.arc(xOf(s.n), yOf(v), 2.6, 0, 2 * Math.PI)
        ctx.fill()
      }
    }
    line('directMs', 'rgba(255,140,120,0.95)')
    line('fmmMs', 'rgba(95,208,255,0.95)')

    ctx.fillStyle = 'rgba(95,208,255,0.95)'
    ctx.fillText('● FMM O(N)', padL + 2, 11)
    ctx.fillStyle = 'rgba(255,140,120,0.95)'
    ctx.fillText('● direct O(N²)', padL + 78, 11)
  }, [])

  useEffect(() => {
    drawConvergence(results.convergence, order)
    drawScaling(results.scaling)
  }, [results, order, drawConvergence, drawScaling])

  const stop = useCallback(() => {
    job.current.alive = false
    cancelAnimationFrame(raf.current)
    setRunning(false)
  }, [])

  const run = useCallback(() => {
    stop()
    const myJob = { alive: true }
    job.current = myJob
    setRunning(true)
    setProgress(0)
    const acc: Results = { accuracy: null, convergence: [], scaling: [] }
    setResults(acc)

    // Build the task list: 1 accuracy probe, 8 convergence orders, then a scaling
    // sweep. Each runs in its own frame so the UI never blocks.
    type Task = () => void
    const tasks: Task[] = []

    // Accuracy at the chosen (n, order, theta).
    tasks.push(() => {
      const { posX, posY, mass } = makeSystem(n, 1234)
      const fx = new Float64Array(n)
      const fy = new Float64Array(n)
      const dx = new Float64Array(n)
      const dy = new Float64Array(n)
      const t0 = performance.now()
      fmmAccel(n, posX, posY, mass, { order, theta, eps2: EPS2, g: G, ncrit: 32 }, fx, fy)
      const fmmMs = performance.now() - t0
      const t1 = performance.now()
      directAccel(n, posX, posY, mass, EPS2, G, dx, dy)
      const directMs = performance.now() - t1
      const e = forceError(n, fx, fy, dx, dy)
      acc.accuracy = { n, p: order, theta, max: e.max, rms: e.rms, fmmMs, directMs, speedup: directMs / Math.max(fmmMs, 1e-6) }
      setResults({ ...acc })
    })

    // Convergence: rms error vs order at a fixed (smaller) N for speed.
    const convN = Math.min(n, 1500)
    const convSys = makeSystem(convN, 77)
    const convDX = new Float64Array(convN)
    const convDY = new Float64Array(convN)
    let convReady = false
    for (let p = 1; p <= 8; p++) {
      tasks.push(() => {
        if (!convReady) {
          directAccel(convN, convSys.posX, convSys.posY, convSys.mass, EPS2, G, convDX, convDY)
          convReady = true
        }
        const fx = new Float64Array(convN)
        const fy = new Float64Array(convN)
        fmmAccel(convN, convSys.posX, convSys.posY, convSys.mass, { order: p, theta, eps2: EPS2, g: G, ncrit: 32 }, fx, fy)
        const e = forceError(convN, fx, fy, convDX, convDY)
        acc.convergence.push({ p, rms: e.rms })
        setResults({ ...acc })
      })
    }

    // Scaling: FMM time at every N, direct time only where it's tractable.
    for (const nn of SCALE_NS) {
      tasks.push(() => {
        const { posX, posY, mass } = makeSystem(nn, 5)
        const fx = new Float64Array(nn)
        const fy = new Float64Array(nn)
        fmmAccel(nn, posX, posY, mass, { order: 4, theta: 0.5, eps2: EPS2, g: G, ncrit: 32 }, fx, fy) // warm
        const reps = nn <= 4000 ? 3 : 1
        const t0 = performance.now()
        for (let r = 0; r < reps; r++) fmmAccel(nn, posX, posY, mass, { order: 4, theta: 0.5, eps2: EPS2, g: G, ncrit: 32 }, fx, fy)
        const fmmMs = (performance.now() - t0) / reps
        let directMs: number | null = null
        if (nn <= DIRECT_MAX_N) {
          const dx = new Float64Array(nn)
          const dy = new Float64Array(nn)
          const t1 = performance.now()
          directAccel(nn, posX, posY, mass, EPS2, G, dx, dy)
          directMs = performance.now() - t1
        }
        acc.scaling.push({ n: nn, fmmMs, directMs })
        setResults({ ...acc })
      })
    }

    let idx = 0
    const tick = () => {
      if (!myJob.alive) return
      const t0 = performance.now()
      // Run tasks until the frame budget is spent (most tasks are one-per-frame).
      while (idx < tasks.length && performance.now() - t0 < 12) {
        tasks[idx]()
        idx++
        setProgress(idx / tasks.length)
        if (idx < tasks.length && performance.now() - t0 > 6) break
      }
      if (idx >= tasks.length) {
        myJob.alive = false
        setRunning(false)
        return
      }
      raf.current = requestAnimationFrame(tick)
    }
    raf.current = requestAnimationFrame(tick)
  }, [n, order, theta, stop])

  useEffect(() => () => stop(), [stop])

  const a = results.accuracy
  return (
    <div className="chaos-panel">
      <p className="integrator-blurb">
        The <strong>Fast Multipole Method</strong> computes every body's gravity in <strong>O(N)</strong> by
        talking cell-to-cell: a cluster's pull is summarised once as a multipole expansion and delivered to a
        far cluster once as a local Taylor expansion. This lab measures it against the brute-force{' '}
        <strong>O(N²)</strong> sum it accelerates — same softened kernel, live, in your browser.
      </p>
      <Slider
        label="Bodies N"
        value={n}
        min={500}
        max={8000}
        step={250}
        onChange={(v) => setN(Math.round(v))}
        format={(v) => v.toLocaleString()}
        title="Body count for the accuracy probe"
      />
      <Slider
        label="Order p"
        value={order}
        min={1}
        max={8}
        step={1}
        onChange={(v) => setOrder(Math.round(v))}
        format={(v) => `${v}`}
        title="Multipole expansion order — accuracy rises geometrically with p"
      />
      <Slider
        label="Separation θ"
        value={theta}
        min={0.2}
        max={0.7}
        step={0.05}
        onChange={setTheta}
        format={(v) => v.toFixed(2)}
        title="Cell-acceptance parameter — smaller θ does more near-field work for higher accuracy"
      />
      <button type="button" className="btn primary chaos-run" onClick={() => (running ? stop() : run())}>
        {running ? `■ Stop (${Math.round(progress * 100)}%)` : a ? '↻ Re-run benchmark' : '⌁ Run benchmark'}
      </button>
      {running && (
        <div className="atlas-progress">
          <div className="atlas-progress-bar" style={{ width: `${Math.round(progress * 100)}%` }} />
        </div>
      )}
      {a && (
        <div className="fmm-stats">
          <div className="fmm-stat">
            <span className="fmm-k">max error</span>
            <span className="fmm-v">{a.max.toExponential(2)}</span>
          </div>
          <div className="fmm-stat">
            <span className="fmm-k">rms error</span>
            <span className="fmm-v">{a.rms.toExponential(2)}</span>
          </div>
          <div className="fmm-stat">
            <span className="fmm-k">FMM</span>
            <span className="fmm-v">{a.fmmMs.toFixed(1)} ms</span>
          </div>
          <div className="fmm-stat">
            <span className="fmm-k">direct</span>
            <span className="fmm-v">{a.directMs.toFixed(1)} ms</span>
          </div>
          <div className="fmm-stat">
            <span className="fmm-k">speed-up</span>
            <span className="fmm-v">{a.speedup.toFixed(1)}×</span>
          </div>
          <div className="fmm-stat">
            <span className="fmm-k">N</span>
            <span className="fmm-v">{a.n.toLocaleString()}</span>
          </div>
        </div>
      )}
      <div className="atlas-wrap">
        <canvas ref={convRef} className="plot" style={{ width: '100%', height: 170 }} />
      </div>
      <div className="atlas-wrap">
        <canvas ref={scaleRef} className="plot" style={{ width: '100%', height: 190 }} />
      </div>
    </div>
  )
}
