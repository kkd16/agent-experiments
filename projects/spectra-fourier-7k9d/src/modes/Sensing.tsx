import { useEffect, useMemo, useState } from 'react'
import { CanvasCard } from '../components/CanvasCard'
import { Panel, Field, Slider, Select, Segmented, Toggle, Button, Readout } from '../components/Controls'
import { useDprCanvas, prepareContext } from '../hooks/useDprCanvas'
import { fillPlotBg, grid, zeroLine, linePlot, axisLabel, paintColormap, type Rect } from '../lib/draw'
import { colormapLUT } from '../lib/colormap'
import {
  recover,
  buildProblem,
  fista,
  ista,
  phaseTransition,
  BASES,
  OPERATORS,
  SOLVERS,
  type BasisKind,
  type OperatorKind,
  type SolverKind,
  type RecoverConfig,
  type PhaseResult,
} from '../lib/cs'
import { readHashParams, shareLink, readNum, readStr, readBool } from '../lib/urlState'

type SizeStr = '64' | '128' | '256'
const SIZES: { id: SizeStr; label: string }[] = [
  { id: '64', label: 'N = 64' },
  { id: '128', label: 'N = 128' },
  { id: '256', label: 'N = 256' },
]

const TEAL = '#5eead4'
const BLUE = '#38bdf8'
const VIOLET = '#a78bfa'
const ROSE = '#fb7185'

// ---- local canvas painters -------------------------------------------------

function drawSignals(ctx: CanvasRenderingContext2D, r: Rect, xTrue: Float64Array, xHat: Float64Array) {
  fillPlotBg(ctx, r)
  grid(ctx, r, 8, 4)
  zeroLine(ctx, r)
  let range = 1e-6
  for (let i = 0; i < xTrue.length; i++) range = Math.max(range, Math.abs(xTrue[i]), Math.abs(xHat[i]))
  linePlot(ctx, r, xTrue, range, 'rgba(94,234,212,0.35)', 3.5)
  linePlot(ctx, r, xHat, range, VIOLET, 1.6)
}

function drawStems(ctx: CanvasRenderingContext2D, r: Rect, sTrue: Float64Array, sHat: Float64Array) {
  fillPlotBg(ctx, r)
  grid(ctx, r, 8, 4)
  const n = sTrue.length
  let range = 1e-6
  for (let i = 0; i < n; i++) range = Math.max(range, Math.abs(sTrue[i]), Math.abs(sHat[i]))
  const midY = r.y + r.h / 2
  ctx.strokeStyle = 'rgba(120,140,220,0.5)'
  ctx.lineWidth = 1.2
  ctx.beginPath()
  ctx.moveTo(r.x, midY)
  ctx.lineTo(r.x + r.w, midY)
  ctx.stroke()
  const px = (i: number) => r.x + (n === 1 ? 0.5 : i / (n - 1)) * r.w
  const py = (v: number) => midY - (v / range) * (r.h / 2) * 0.9
  // True support: teal stems with a dot marker.
  for (let i = 0; i < n; i++) {
    if (Math.abs(sTrue[i]) < range * 1e-4) continue
    const x = px(i)
    ctx.strokeStyle = 'rgba(94,234,212,0.85)'
    ctx.lineWidth = 2.4
    ctx.beginPath()
    ctx.moveTo(x, midY)
    ctx.lineTo(x, py(sTrue[i]))
    ctx.stroke()
    ctx.fillStyle = TEAL
    ctx.beginPath()
    ctx.arc(x, py(sTrue[i]), 3, 0, 2 * Math.PI)
    ctx.fill()
  }
  // Recovered: thin violet stems with an open marker, so overlap is visible.
  for (let i = 0; i < n; i++) {
    if (Math.abs(sHat[i]) < range * 5e-3) continue
    const x = px(i)
    ctx.strokeStyle = 'rgba(167,139,250,0.9)'
    ctx.lineWidth = 1.2
    ctx.beginPath()
    ctx.moveTo(x, midY)
    ctx.lineTo(x, py(sHat[i]))
    ctx.stroke()
    ctx.strokeStyle = VIOLET
    ctx.lineWidth = 1.4
    ctx.beginPath()
    ctx.arc(x, py(sHat[i]), 2.6, 0, 2 * Math.PI)
    ctx.stroke()
  }
}

function drawMeasurements(ctx: CanvasRenderingContext2D, r: Rect, y: Float64Array) {
  fillPlotBg(ctx, r)
  grid(ctx, r, 8, 4)
  const midY = r.y + r.h / 2
  ctx.strokeStyle = 'rgba(120,140,220,0.5)'
  ctx.lineWidth = 1.2
  ctx.beginPath()
  ctx.moveTo(r.x, midY)
  ctx.lineTo(r.x + r.w, midY)
  ctx.stroke()
  const n = y.length
  let range = 1e-6
  for (let i = 0; i < n; i++) range = Math.max(range, Math.abs(y[i]))
  const px = (i: number) => r.x + (n === 1 ? 0.5 : i / (n - 1)) * r.w
  const py = (v: number) => midY - (v / range) * (r.h / 2) * 0.9
  for (let i = 0; i < n; i++) {
    const x = px(i)
    ctx.strokeStyle = 'rgba(56,189,248,0.55)'
    ctx.lineWidth = 1.4
    ctx.beginPath()
    ctx.moveTo(x, midY)
    ctx.lineTo(x, py(y[i]))
    ctx.stroke()
    ctx.fillStyle = BLUE
    ctx.beginPath()
    ctx.arc(x, py(y[i]), 2.1, 0, 2 * Math.PI)
    ctx.fill()
  }
}

function drawConvergence(ctx: CanvasRenderingContext2D, r: Rect, histFista: number[], histIsta: number[]) {
  fillPlotBg(ctx, r)
  grid(ctx, r, 8, 4)
  const all = histFista.concat(histIsta)
  if (all.length === 0) return
  let lo = Infinity
  let hi = -Infinity
  for (const v of all) {
    if (v < lo) lo = v
    if (v > hi) hi = v
  }
  const floor = Math.max(lo, 1e-12)
  // Log-scale the objective so the O(1/k²) vs O(1/k) gap is legible.
  const logHi = Math.log10(hi + 1e-12)
  const logLo = Math.log10(floor + 1e-12)
  const span = Math.max(logHi - logLo, 1e-6)
  const plot = (hist: number[], color: string, width: number) => {
    if (hist.length < 2) return
    ctx.strokeStyle = color
    ctx.lineWidth = width
    ctx.lineJoin = 'round'
    ctx.beginPath()
    for (let i = 0; i < hist.length; i++) {
      const x = r.x + (i / (hist.length - 1)) * r.w
      const t = (Math.log10(Math.max(hist[i], 1e-12) + 1e-12) - logLo) / span
      const yy = r.y + (1 - Math.max(0, Math.min(1, t))) * r.h * 0.92 + r.h * 0.04
      if (i === 0) ctx.moveTo(x, yy)
      else ctx.lineTo(x, yy)
    }
    ctx.stroke()
  }
  plot(histIsta, ROSE, 1.8) // ISTA (rose)
  plot(histFista, BLUE, 2.2) // FISTA (blue)
  // Legend: a coloured dot then its label (axisLabel sets its own text colour).
  const dot = (cx: number, cy: number, color: string) => {
    ctx.fillStyle = color
    ctx.beginPath()
    ctx.arc(cx, cy, 3.5, 0, 2 * Math.PI)
    ctx.fill()
  }
  dot(r.x + 14, r.y + 15, BLUE)
  axisLabel(ctx, 'FISTA', r.x + 24, r.y + 19)
  dot(r.x + 14, r.y + 31, ROSE)
  axisLabel(ctx, 'ISTA', r.x + 24, r.y + 35)
  axisLabel(ctx, 'iteration →', r.x + r.w - 6, r.y + r.h - 8, 'right')
  axisLabel(ctx, 'objective ↓ (log)', r.x + r.w - 6, r.y + 19, 'right')
}

function drawPhase(ctx: CanvasRenderingContext2D, r: Rect, phase: PhaseResult, lut: Uint8ClampedArray) {
  const { field, mVals, kVals, N } = phase
  const cols = mVals.length
  const rows = kVals.length
  // Reorient so measurements increase rightward and sparsity increases upward.
  const img = new Float64Array(cols * rows)
  for (let iy = 0; iy < rows; iy++) {
    for (let c = 0; c < cols; c++) img[iy * cols + c] = field[(rows - 1 - iy) * cols + c]
  }
  paintColormap(ctx, r, img, cols, rows, lut, true)
  // Reference curve m ≈ 2k·ln(N/k), the classic sufficient-measurement scaling.
  const kMax = kVals[kVals.length - 1]
  ctx.strokeStyle = 'rgba(251,191,36,0.9)'
  ctx.lineWidth = 2
  ctx.setLineDash([5, 4])
  ctx.beginPath()
  let started = false
  for (let k = 1; k <= kMax; k++) {
    const mRef = 2 * k * Math.log(N / k)
    const x = r.x + Math.max(0, Math.min(1, mRef / N)) * r.w
    const y = r.y + (1 - k / kMax) * r.h
    if (!started) {
      ctx.moveTo(x, y)
      started = true
    } else ctx.lineTo(x, y)
  }
  ctx.stroke()
  ctx.setLineDash([])
  ctx.fillStyle = 'rgba(230,236,255,0.85)'
  ctx.font = '11px JetBrains Mono, ui-monospace, monospace'
  ctx.textAlign = 'left'
  ctx.fillText('measurements m →', r.x + 6, r.y + r.h - 8)
  ctx.save()
  ctx.translate(r.x + 12, r.y + 14)
  ctx.fillText('← sparsity k', 0, 0)
  ctx.restore()
  ctx.fillStyle = 'rgba(251,191,36,0.95)'
  ctx.textAlign = 'right'
  ctx.fillText('m ≈ 2k·ln(N/k)', r.x + r.w - 6, r.y + 16)
}

// ---------------------------------------------------------------------------

export default function Sensing() {
  const sp = useMemo(() => readHashParams(), [])
  const [basis, setBasis] = useState<BasisKind>(() => readStr<BasisKind>(sp, 'b', 'spike', BASES.map((x) => x.id)))
  const [sizeStr, setSizeStr] = useState<SizeStr>(() => readStr<SizeStr>(sp, 'n', '128', ['64', '128', '256']))
  const [operator, setOperator] = useState<OperatorKind>(() =>
    readStr<OperatorKind>(sp, 'op', 'gaussian', OPERATORS.map((x) => x.id)),
  )
  const [solver, setSolver] = useState<SolverKind>(() => readStr<SolverKind>(sp, 's', 'fista', SOLVERS.map((x) => x.id)))
  const [k, setK] = useState(() => Math.round(readNum(sp, 'k', 8)))
  const [m, setM] = useState(() => Math.round(readNum(sp, 'm', 40)))
  const [lambda, setLambda] = useState(() => readNum(sp, 'lam', 0.02))
  const [iterations, setIterations] = useState(() => Math.round(readNum(sp, 'it', 300)))
  const [noise, setNoise] = useState(() => readNum(sp, 'noise', 0))
  const [seedBump, setSeedBump] = useState(0)
  const [showPhase, setShowPhase] = useState(() => readBool(sp, 'pt', false))
  const [copied, setCopied] = useState(false)

  const N = parseInt(sizeStr, 10)
  const seed = 1000 + seedBump

  // Keep k, m in bounds when N changes.
  const kClamped = Math.max(1, Math.min(k, Math.floor(N / 2)))
  const mClamped = Math.max(1, Math.min(m, N))

  const cfg = useMemo<RecoverConfig>(
    () => ({ N, k: kClamped, m: mClamped, basis, operator, solver, lambda, iterations, noise, seed }),
    [N, kClamped, mClamped, basis, operator, solver, lambda, iterations, noise, seed],
  )

  const result = useMemo(() => recover(cfg), [cfg])

  // FISTA vs ISTA on the identical problem, for the convergence comparison.
  const convergence = useMemo(() => {
    const prob = buildProblem(cfg)
    const f = fista(prob.B, prob.y, lambda, iterations, mClamped, N)
    const i = ista(prob.B, prob.y, lambda, iterations, mClamped, N)
    return { fista: f.history, ista: i.history }
  }, [cfg, lambda, iterations, mClamped, N])

  const magma = useMemo(() => colormapLUT('magma'), [])

  // Phase transition is the heavy compute — run it lazily off a button/toggle.
  const [phase, setPhase] = useState<PhaseResult | null>(null)
  const [computing, setComputing] = useState(false)
  const phaseKey = `${basis}|${operator}|${solver}`
  const [phaseKeyDone, setPhaseKeyDone] = useState('')
  // Derive validity instead of clearing state in an effect: a diagram is stale the
  // moment its basis/operator/solver no longer match the current controls.
  const activePhase = phase && phaseKeyDone === phaseKey ? phase : null

  useEffect(() => {
    if (!computing) return
    const id = setTimeout(() => {
      const pt = phaseTransition({
        N: 48,
        basis,
        operator,
        solver: solver === 'omp' ? 'omp' : 'fista',
        mSteps: 10,
        kSteps: 10,
        trials: 6,
        iterations: 120,
        lambda,
        seed: 7,
      })
      setPhase(pt)
      setPhaseKeyDone(phaseKey)
      setComputing(false)
    }, 24)
    return () => clearTimeout(id)
  }, [computing, basis, operator, solver, lambda, phaseKey])

  // ---- canvases ----
  const { ref: sigRef, size: sigSize } = useDprCanvas()
  const { ref: stemRef, size: stemSize } = useDprCanvas()
  const { ref: measRef, size: measSize } = useDprCanvas()
  const { ref: convRef, size: convSize } = useDprCanvas()
  const { ref: phaseRef, size: phaseSize } = useDprCanvas()

  useEffect(() => {
    const ctx = prepareContext(sigRef.current, sigSize)
    if (ctx) drawSignals(ctx, { x: 0, y: 0, w: sigSize.width, h: sigSize.height }, result.x, result.xHat)
  }, [result, sigSize, sigRef])

  useEffect(() => {
    const ctx = prepareContext(stemRef.current, stemSize)
    if (ctx) drawStems(ctx, { x: 0, y: 0, w: stemSize.width, h: stemSize.height }, result.sTrue, result.sHat)
  }, [result, stemSize, stemRef])

  useEffect(() => {
    const ctx = prepareContext(measRef.current, measSize)
    if (ctx) drawMeasurements(ctx, { x: 0, y: 0, w: measSize.width, h: measSize.height }, result.y)
  }, [result, measSize, measRef])

  useEffect(() => {
    const ctx = prepareContext(convRef.current, convSize)
    if (ctx) drawConvergence(ctx, { x: 0, y: 0, w: convSize.width, h: convSize.height }, convergence.fista, convergence.ista)
  }, [convergence, convSize, convRef])

  useEffect(() => {
    const ctx = prepareContext(phaseRef.current, phaseSize)
    if (!ctx) return
    const rect = { x: 0, y: 0, w: phaseSize.width, h: phaseSize.height }
    if (activePhase) {
      drawPhase(ctx, rect, activePhase, magma)
    } else {
      fillPlotBg(ctx, rect)
      grid(ctx, rect, 8, 6)
      ctx.fillStyle = 'rgba(154,166,212,0.85)'
      ctx.font = '12px JetBrains Mono, ui-monospace, monospace'
      ctx.textAlign = 'center'
      ctx.fillText(
        computing ? 'sweeping (k, m)…' : 'compute the phase diagram →',
        rect.w / 2,
        rect.h / 2,
      )
    }
  }, [activePhase, phaseSize, phaseRef, magma, computing])

  const onShare = () => {
    shareLink('sensing', {
      b: basis,
      n: sizeStr,
      op: operator,
      s: solver,
      k: kClamped,
      m: mClamped,
      lam: lambda.toFixed(3),
      it: iterations,
      noise: noise.toFixed(2),
      pt: showPhase,
    }).then((ok) => {
      if (ok) {
        setCopied(true)
        setTimeout(() => setCopied(false), 1400)
      }
    })
  }

  const isL1 = solver === 'fista' || solver === 'ista'
  const nyquist = mClamped < N
  const verdict = result.exact ? 'exact ✓' : `rel err ${result.relError.toExponential(1)}`

  return (
    <div className="mode">
      <div className="mode-side">
        <Panel title="Sparse signal">
          <Field label="Sparse in">
            <Select value={basis} options={BASES} onChange={setBasis} />
          </Field>
          <Field label="Length N">
            <Select value={sizeStr} options={SIZES} onChange={setSizeStr} />
          </Field>
          <Field label="Sparsity k (non-zeros)" value={String(kClamped)}>
            <Slider min={1} max={Math.floor(N / 3)} step={1} value={kClamped} onChange={(v) => setK(Math.round(v))} />
          </Field>
          <div className="btn-row">
            <Button variant="ghost" onClick={() => setSeedBump((s) => s + 1)}>
              New signal
            </Button>
          </div>
        </Panel>

        <Panel title="Sensing">
          <Field label="Operator">
            <Select value={operator} options={OPERATORS} onChange={setOperator} />
          </Field>
          <Field label="Measurements m" value={`${mClamped}  (${(result.measRatio * 100).toFixed(0)}% of N)`}>
            <Slider min={1} max={N} step={1} value={mClamped} onChange={(v) => setM(Math.round(v))} />
          </Field>
          <Field label="Dose noise" value={noise === 0 ? 'clean' : `${(noise * 100).toFixed(0)}%`}>
            <Slider min={0} max={0.2} step={0.005} value={noise} onChange={setNoise} />
          </Field>
        </Panel>

        <Panel title="Recovery">
          <Segmented value={solver} options={SOLVERS} onChange={setSolver} />
          {isL1 && (
            <Field label="λ (ℓ₁ weight)" value={lambda.toFixed(3)}>
              <Slider min={0.001} max={0.15} step={0.001} value={lambda} onChange={setLambda} />
            </Field>
          )}
          {solver !== 'omp' && (
            <Field label="Iterations" value={String(iterations)}>
              <Slider min={20} max={600} step={10} value={iterations} onChange={(v) => setIterations(Math.round(v))} />
            </Field>
          )}
        </Panel>

        <Panel title="Result">
          <Readout
            items={[
              { label: 'Rel. error', value: result.exact ? '≈0' : result.relError.toExponential(1) },
              { label: 'Support', value: `${(result.supportRecall * 100).toFixed(0)}%` },
              { label: 'm / N', value: result.measRatio.toFixed(2) },
              { label: 'Rate', value: `${((mClamped / kClamped) || 0).toFixed(1)}×k` },
            ]}
          />
          <div className="btn-row">
            <Button variant="ghost" onClick={onShare}>
              {copied ? 'Link copied ✓' : 'Copy link'}
            </Button>
          </div>
        </Panel>

        <Panel title="Phase diagram">
          <Toggle label="Show phase transition" checked={showPhase} onChange={setShowPhase} />
          {showPhase && (
            <div className="btn-row">
              <Button variant="primary" onClick={() => setComputing(true)}>
                {computing ? 'Computing…' : activePhase ? 'Recompute' : 'Compute (≈1s)'}
              </Button>
            </div>
          )}
        </Panel>
      </div>

      <div className="mode-main">
        <p className="mode-intro">
          The whole lab preaches <strong>Nyquist</strong>: pin down a signal and you need two samples
          per period. <strong>Compressed sensing</strong> is the beautiful heresy that overturns it —
          if a signal is <em>sparse</em> in some basis, a handful of random measurements{' '}
          <strong>far below Nyquist</strong> pin it down <em>exactly</em>, provided you reconstruct by
          minimising the <strong>ℓ₁ norm</strong> instead of the energy. Here a length-{N} signal with{' '}
          <strong>{kClamped}</strong> non-zeros is sensed through <strong>{mClamped}</strong> numbers
          {nyquist ? ` — ${((1 - mClamped / N) * 100).toFixed(0)}% fewer than its length` : ''} and
          rebuilt from scratch. Switch to <em>Min-ℓ₂</em> to watch the naive least-energy solution smear,
          while <em>FISTA</em> and <em>OMP</em> nail the spikes.
        </p>
        <div className="tomo-grid">
          <CanvasCard title="Signal — true vs recovered" note={verdict} aspect={1.6}>
            <canvas ref={sigRef} />
          </CanvasCard>
          <CanvasCard
            title="Sparse coefficients"
            note={`teal = truth · violet = recovered (${result.support.length} atoms)`}
            aspect={1.6}
          >
            <canvas ref={stemRef} />
          </CanvasCard>
          <CanvasCard title="Compressed measurements" note={`the ${mClamped} numbers the sensor keeps`} aspect={1.6}>
            <canvas ref={measRef} />
          </CanvasCard>
          <CanvasCard title="Convergence — FISTA vs ISTA" note="accelerated proximal gradient" aspect={1.6}>
            <canvas ref={convRef} />
          </CanvasCard>
        </div>
        {showPhase && (
          <div className="cs-phase-row">
            <CanvasCard
              title="Phase transition (Donoho–Tanner)"
              note={activePhase ? `success fraction · ${activePhase.N}² problems` : 'press Compute'}
              height={360}
            >
              <canvas ref={phaseRef} />
            </CanvasCard>
            <p className="mode-intro" style={{ maxWidth: 320 }}>
              Sweep every <strong>(sparsity k, measurements m)</strong> and count how often ℓ₁ recovers
              the signal <em>exactly</em>. A razor-sharp diagonal <strong>phase transition</strong>{' '}
              separates <em>always recovers</em> (bright) from <em>never</em> (dark) — the signature
              result of the field. The dashed curve is the textbook{' '}
              <code>m ≈ 2k·ln(N/k)</code> sufficient-measurement scaling; the empirical boundary hugs
              it. Below the ridge you are recovering signals from far fewer numbers than Nyquist would
              ever allow.
            </p>
          </div>
        )}
      </div>
    </div>
  )
}
