import { useEffect, useMemo, useRef, useState } from 'react'
import { CanvasCard } from '../components/CanvasCard'
import { Panel, Field, Slider, Select, Segmented, Toggle, Button, Readout } from '../components/Controls'
import { useDprCanvas, prepareContext } from '../hooks/useDprCanvas'
import { useAnimationFrame } from '../hooks/useAnimationFrame'
import { paintGray, paintColormap, fillPlotBg, grid, axisLabel, type Rect } from '../lib/draw'
import { colormapLUT } from '../lib/colormap'
import { makePhantom, PHANTOMS } from '../lib/phantom'
import type { PhantomName } from '../lib/phantom'
import { loadImageFile } from '../lib/images'
import {
  forwardRadon,
  filterSinogram,
  backprojectAngle,
  backproject,
  fbp,
  directFourier,
  trueSpectrum,
  normalize01,
  affineError,
  correlation,
  addNoise,
  FILTERS,
  type FilterName,
  type Sinogram,
} from '../lib/radon'
import {
  geometryFromSino,
  makeSolver,
  ITER_METHODS,
  type IterMethod,
  type CTSolver,
} from '../lib/iterative'
import { readHashParams, shareLink, readNum, readStr, readBool } from '../lib/urlState'

type Family = 'direct' | 'iterative'
type DirectMethod = 'fbp' | 'fourier' | 'backproj'
type SizeStr = '64' | '128' | '256'

const SIZES: { id: SizeStr; label: string }[] = [
  { id: '64', label: '64 × 64' },
  { id: '128', label: '128 × 128' },
  { id: '256', label: '256 × 256' },
]

const FAMILIES: { id: Family; label: string }[] = [
  { id: 'direct', label: 'Direct' },
  { id: 'iterative', label: 'Iterative' },
]

const DIRECT_METHODS: { id: DirectMethod; label: string }[] = [
  { id: 'fbp', label: 'Filtered BP' },
  { id: 'fourier', label: 'Fourier slice' },
  { id: 'backproj', label: 'Raw BP' },
]

/** Draw a decreasing convergence curve (0 at the bottom) with an FBP reference line. */
function drawConvergence(
  ctx: CanvasRenderingContext2D,
  r: Rect,
  history: number[],
  fbpRmse: number,
  label: string,
): void {
  fillPlotBg(ctx, r)
  grid(ctx, r, 6, 4)
  const first = history.length ? history[0] : 1
  const ymax = Math.max(first, fbpRmse, 1e-6) * 1.08
  const yOf = (v: number) => r.y + r.h - Math.max(0, Math.min(1, v / ymax)) * r.h * 0.9 - r.h * 0.05
  // FBP baseline — the bar iterative aims to duck under.
  const yb = yOf(fbpRmse)
  ctx.strokeStyle = 'rgba(248,180,120,0.85)'
  ctx.setLineDash([5, 4])
  ctx.lineWidth = 1.5
  ctx.beginPath()
  ctx.moveTo(r.x, yb)
  ctx.lineTo(r.x + r.w, yb)
  ctx.stroke()
  ctx.setLineDash([])
  axisLabel(ctx, `FBP ${fbpRmse.toFixed(3)}`, r.x + r.w - 6, yb - 5, 'right')
  // The iterative RMSE trajectory.
  if (history.length > 1) {
    ctx.strokeStyle = '#5eead4'
    ctx.lineWidth = 2
    ctx.lineJoin = 'round'
    ctx.beginPath()
    const n = history.length
    for (let i = 0; i < n; i++) {
      const x = r.x + (i / Math.max(1, n - 1)) * r.w
      const y = yOf(history[i])
      if (i === 0) ctx.moveTo(x, y)
      else ctx.lineTo(x, y)
    }
    ctx.stroke()
    // Marker + readout at the newest point.
    const lx = r.x + r.w
    const ly = yOf(history[n - 1])
    ctx.fillStyle = '#5eead4'
    ctx.beginPath()
    ctx.arc(lx - 2, ly, 3, 0, Math.PI * 2)
    ctx.fill()
  }
  axisLabel(ctx, label, r.x + 6, r.y + 14, 'left')
  axisLabel(ctx, 'RMSE ↓', r.x + 6, r.y + r.h - 6, 'left')
  axisLabel(ctx, 'iteration →', r.x + r.w - 6, r.y + r.h - 6, 'right')
}

export default function Tomography() {
  const sp = useMemo(() => readHashParams(), [])
  const [phantom, setPhantom] = useState<PhantomName>(() =>
    readStr<PhantomName>(sp, 'ph', 'shepp', PHANTOMS.map((p) => p.id)),
  )
  const [sizeStr, setSizeStr] = useState<SizeStr>(() =>
    readStr<SizeStr>(sp, 'n', '128', ['64', '128', '256']),
  )
  const [angles, setAngles] = useState(() => Math.round(readNum(sp, 'ang', 180)))
  const [coverage, setCoverage] = useState(() => Math.round(readNum(sp, 'cov', 180)))
  const [family, setFamily] = useState<Family>(() =>
    readStr<Family>(sp, 'fam', 'direct', ['direct', 'iterative']),
  )
  const [directMethod, setDirectMethod] = useState<DirectMethod>(() =>
    readStr<DirectMethod>(sp, 'dm', 'fbp', ['fbp', 'fourier', 'backproj']),
  )
  const [iterMethod, setIterMethod] = useState<IterMethod>(() =>
    readStr<IterMethod>(sp, 'im', 'cgls', ITER_METHODS.map((m) => m.id)),
  )
  const [filter, setFilter] = useState<FilterName>(() =>
    readStr<FilterName>(sp, 'f', 'ramlak', FILTERS.map((x) => x.id)),
  )
  const [noise, setNoise] = useState(() => readNum(sp, 'noise', 0))
  const [speed, setSpeed] = useState(() => readNum(sp, 'spd', 1))
  const [iterations, setIterations] = useState(() => Math.round(readNum(sp, 'it', 30)))
  const [relax, setRelax] = useState(() => readNum(sp, 'rx', 1))
  const [lambda, setLambda] = useState(() => readNum(sp, 'lm', 0))
  const [nonneg, setNonneg] = useState(() => readBool(sp, 'nn', true))
  const [showError, setShowError] = useState(() => readBool(sp, 'err', false))
  const [showSlices, setShowSlices] = useState(() => readBool(sp, 'sl', true))
  const [running, setRunning] = useState(true)
  const [uploaded, setUploaded] = useState<Float64Array | null>(null)
  const [copied, setCopied] = useState(false)

  const size = parseInt(sizeStr, 10)
  const fileRef = useRef<HTMLInputElement>(null)

  const magma = useMemo(() => colormapLUT('magma'), [])
  const viridis = useMemo(() => colormapLUT('viridis'), [])
  const inferno = useMemo(() => colormapLUT('inferno'), [])

  // The object being scanned: a procedural phantom, or an uploaded photo.
  const image = useMemo<Float64Array>(
    () => uploaded ?? makePhantom(phantom, size),
    [uploaded, phantom, size],
  )

  // The measured sinogram (with optional dose noise) — the heavy compute. The
  // gantry sweeps `coverage` degrees; below 180° it's a limited-angle scan.
  const sino = useMemo<Sinogram>(() => {
    const arc = (coverage * Math.PI) / 180
    const raw = forwardRadon(image, size, angles, undefined, arc)
    return noise > 0 ? addNoise(raw, noise) : raw
  }, [image, size, angles, noise, coverage])

  const nDet = sino.nDet

  // Filtered sinogram (for FBP) and the two possible direct reconstructions.
  const filtered = useMemo(() => filterSinogram(sino, filter), [sino, filter])
  const fourier = useMemo(() => directFourier(sino, size), [sino, size])

  // Full direct reconstruction (all angles) — what the animation converges to.
  const reconDirect = useMemo<Float64Array>(() => {
    if (directMethod === 'fourier') return fourier.recon
    if (directMethod === 'backproj') return backproject(sino, size)
    return backproject(filtered, size)
  }, [directMethod, fourier, sino, filtered, size])

  const directMetrics = useMemo(() => {
    const { error, rmse } = affineError(reconDirect, image)
    return { error, rmse, corr: correlation(reconDirect, image) }
  }, [reconDirect, image])

  // The FBP baseline RMSE — the reference the iterative convergence plot ducks under.
  const fbpBaseline = useMemo(() => affineError(fbp(sino, size, 'ramlak'), image).rmse, [sino, size, image])

  // The true 2-D spectrum, shown with the sampled radial slices overlaid.
  const spectrum = useMemo(() => trueSpectrum(image, size), [image, size])

  const { ref: objRef, size: objSize } = useDprCanvas()
  const { ref: sinoRef, size: sinoSize } = useDprCanvas()
  const { ref: reconRef, size: reconSize } = useDprCanvas()
  const { ref: fourierRef, size: fourierSize } = useDprCanvas()
  const { ref: convRef, size: convSize } = useDprCanvas()

  // ---- static panels: object, sinogram, fourier ----
  useEffect(() => {
    const ctx = prepareContext(objRef.current, objSize)
    if (ctx) paintGray(ctx, { x: 0, y: 0, w: objSize.width, h: objSize.height }, image, size, size, true)
  }, [image, size, objSize, objRef])

  useEffect(() => {
    const ctx = prepareContext(sinoRef.current, sinoSize)
    if (ctx)
      paintColormap(
        ctx,
        { x: 0, y: 0, w: sinoSize.width, h: sinoSize.height },
        normalize01(sino.data),
        nDet,
        angles,
        viridis,
        true,
      )
  }, [sino, nDet, angles, sinoSize, sinoRef, viridis])

  useEffect(() => {
    if (family === 'iterative') return // this slot shows the convergence plot instead
    const ctx = prepareContext(fourierRef.current, fourierSize)
    if (!ctx) return
    const w = fourierSize.width
    const h = fourierSize.height
    if (directMethod === 'fourier') {
      // Show the polar samples literally filling k-space (the slice theorem).
      paintColormap(ctx, { x: 0, y: 0, w, h }, fourier.kmag, size, size, magma, true)
    } else {
      paintColormap(ctx, { x: 0, y: 0, w, h }, spectrum, size, size, magma, true)
    }
    if (showSlices) {
      // Draw one diameter per projection angle — the lines the transform reads.
      const cx = w / 2
      const cy = h / 2
      const R = Math.hypot(w, h)
      const stride = Math.max(1, Math.round(angles / 90))
      ctx.lineWidth = 1
      for (let a = 0; a < angles; a += stride) {
        const theta = sino.angles[a]
        const dx = Math.cos(theta)
        const dy = -Math.sin(theta)
        ctx.strokeStyle = 'rgba(94,234,212,0.16)'
        ctx.beginPath()
        ctx.moveTo(cx - dx * R, cy - dy * R)
        ctx.lineTo(cx + dx * R, cy + dy * R)
        ctx.stroke()
      }
    }
  }, [family, directMethod, fourier, spectrum, showSlices, angles, sino, size, fourierSize, fourierRef, magma])

  // ---- animated direct reconstruction (progressive back-projection) ----
  const accRef = useRef<Float64Array>(new Float64Array(size * size))
  const doneRef = useRef(0) // number of angles back-projected so far
  const [built, setBuilt] = useState(0) // mirror of doneRef for the readout

  useEffect(() => {
    accRef.current = new Float64Array(size * size)
    doneRef.current = 0
  }, [filtered, sino, directMethod, size])

  // ---- iterative reconstruction (SIRT / SART / CGLS) ----
  const solverRef = useRef<CTSolver | null>(null)
  const iterHistRef = useRef<number[]>([]) // RMSE-vs-truth per iteration
  const [iterInfo, setIterInfo] = useState({ iter: 0, rmse: NaN, corr: 0 })

  // (Re)build the solver whenever the problem or its hyper-parameters change.
  // Refs only — the RAF below syncs the `iterInfo` readout (setState in an effect
  // would trigger cascading renders), mirroring the direct-mode reset pattern.
  useEffect(() => {
    if (family !== 'iterative') {
      solverRef.current = null
      return
    }
    const g = geometryFromSino(sino, size)
    solverRef.current = makeSolver(sino.data, g, { method: iterMethod, relax, nonneg, lambda })
    iterHistRef.current = []
  }, [family, iterMethod, sino, size, relax, nonneg, lambda])

  useAnimationFrame(() => {
    const ctx = prepareContext(reconRef.current, reconSize)
    if (!ctx) return
    const rect: Rect = { x: 0, y: 0, w: reconSize.width, h: reconSize.height }

    // ---------- iterative family ----------
    if (family === 'iterative') {
      const solver = solverRef.current
      if (!solver) return
      if (running && solver.iter < iterations) {
        solver.step()
        iterHistRef.current.push(affineError(solver.x, image).rmse)
      }
      const ae = affineError(solver.x, image)
      // Sync the readout from the RAF (allowed) rather than the effect, and only
      // when it actually changed, so a paused solver doesn't re-render every frame.
      if (iterInfo.iter !== solver.iter || iterInfo.rmse !== ae.rmse) {
        setIterInfo({ iter: solver.iter, rmse: ae.rmse, corr: correlation(solver.x, image) })
      }
      if (showError) {
        const emax = ae.error.reduce((m, v) => (v > m ? v : m), 1e-9)
        const en = new Float64Array(ae.error.length)
        for (let i = 0; i < en.length; i++) en[i] = ae.error[i] / emax
        paintColormap(ctx, rect, en, size, size, inferno, true)
      } else {
        // Non-negative estimates are physically clamped for display.
        const disp = solver.x.slice()
        if (nonneg) for (let i = 0; i < disp.length; i++) if (disp[i] < 0) disp[i] = 0
        paintGray(ctx, rect, normalize01(disp), size, size, true)
      }
      // Convergence plot in the fourth slot.
      const cctx = prepareContext(convRef.current, convSize)
      if (cctx)
        drawConvergence(
          cctx,
          { x: 0, y: 0, w: convSize.width, h: convSize.height },
          iterHistRef.current,
          fbpBaseline,
          ITER_METHODS.find((m) => m.id === iterMethod)?.label ?? '',
        )
      return
    }

    // ---------- direct family ----------
    if (showError) {
      const emax = directMetrics.error.reduce((m, v) => (v > m ? v : m), 1e-9)
      const en = new Float64Array(directMetrics.error.length)
      for (let i = 0; i < en.length; i++) en[i] = directMetrics.error[i] / emax
      paintColormap(ctx, rect, en, size, size, inferno, true)
      return
    }

    if (directMethod === 'fourier') {
      paintGray(ctx, rect, normalize01(fourier.recon), size, size, true)
      return
    }

    const src = directMethod === 'backproj' ? sino : filtered
    if (running && doneRef.current < angles) {
      const perFrame = Math.max(1, Math.round((angles / 90) * speed))
      for (let s = 0; s < perFrame && doneRef.current < angles; s++) {
        backprojectAngle(accRef.current, src, doneRef.current, size)
        doneRef.current++
      }
    }
    if (built !== doneRef.current) setBuilt(doneRef.current)
    paintGray(ctx, rect, normalize01(accRef.current), size, size, true)
  }, true)

  const replay = () => {
    if (family === 'iterative') {
      const g = geometryFromSino(sino, size)
      solverRef.current = makeSolver(sino.data, g, { method: iterMethod, relax, nonneg, lambda })
      iterHistRef.current = []
      setIterInfo({ iter: 0, rmse: NaN, corr: 0 })
      setRunning(true)
      return
    }
    accRef.current = new Float64Array(size * size)
    doneRef.current = 0
    setBuilt(0)
    setRunning(true)
  }

  const onUpload = (file: File | undefined) => {
    if (!file) return
    loadImageFile(file, size).then((buf) => {
      if (buf) setUploaded(buf)
    })
  }

  const onShare = () => {
    shareLink('tomography', {
      ph: phantom,
      n: sizeStr,
      ang: angles,
      cov: coverage,
      fam: family,
      dm: directMethod,
      im: iterMethod,
      f: filter,
      noise: noise.toFixed(2),
      spd: speed.toFixed(1),
      it: iterations,
      rx: relax.toFixed(2),
      lm: lambda.toFixed(3),
      nn: nonneg,
      err: showError,
      sl: showSlices,
    }).then((ok) => {
      if (ok) {
        setCopied(true)
        setTimeout(() => setCopied(false), 1400)
      }
    })
  }

  const isIter = family === 'iterative'
  const metrics = isIter ? { rmse: iterInfo.rmse, corr: iterInfo.corr } : directMetrics
  const progress = isIter
    ? `${iterInfo.iter} / ${iterations} iterations`
    : directMethod === 'fourier'
      ? 'k-space inverse'
      : `${Math.min(built, angles)} / ${angles} projections`

  return (
    <div className="mode">
      <div className="mode-side">
        <Panel title="Object">
          <Field label="Phantom">
            <Select
              value={phantom}
              options={PHANTOMS}
              onChange={(p) => {
                setUploaded(null)
                setPhantom(p)
              }}
            />
          </Field>
          <Field label="Resolution">
            <Select
              value={sizeStr}
              options={SIZES}
              onChange={(v) => {
                setUploaded(null)
                setSizeStr(v)
              }}
            />
          </Field>
          <div className="btn-row">
            <Button variant="ghost" onClick={() => fileRef.current?.click()}>
              Upload photo…
            </Button>
            {uploaded && (
              <Button variant="ghost" onClick={() => setUploaded(null)}>
                Use phantom
              </Button>
            )}
          </div>
          <input
            ref={fileRef}
            type="file"
            accept="image/*"
            style={{ display: 'none' }}
            onChange={(e) => onUpload(e.target.files?.[0])}
          />
        </Panel>

        <Panel title="Scan">
          <Field label="Projections (angles)" value={String(angles)}>
            <Slider min={9} max={240} step={1} value={angles} onChange={(v) => setAngles(Math.round(v))} />
          </Field>
          <Field label="Angular coverage" value={coverage >= 180 ? 'full 180°' : `${coverage}° (limited)`}>
            <Slider min={60} max={180} step={5} value={coverage} onChange={(v) => setCoverage(Math.round(v))} />
          </Field>
          <Field label="Dose noise" value={noise === 0 ? 'clean' : `${(noise * 100).toFixed(0)}%`}>
            <Slider min={0} max={0.15} step={0.005} value={noise} onChange={setNoise} />
          </Field>
        </Panel>

        <Panel title="Reconstruction">
          <Segmented value={family} options={FAMILIES} onChange={setFamily} />
          {!isIter ? (
            <>
              <Segmented value={directMethod} options={DIRECT_METHODS} onChange={setDirectMethod} />
              {directMethod === 'fbp' && (
                <Field label="Ramp filter">
                  <Select value={filter} options={FILTERS} onChange={setFilter} />
                </Field>
              )}
              {directMethod !== 'fourier' && (
                <Field label="Build speed" value={`${speed.toFixed(1)}×`}>
                  <Slider min={0.3} max={4} step={0.1} value={speed} onChange={setSpeed} />
                </Field>
              )}
            </>
          ) : (
            <>
              <Segmented value={iterMethod} options={ITER_METHODS} onChange={setIterMethod} />
              <Field label="Iterations" value={String(iterations)}>
                <Slider min={2} max={80} step={1} value={iterations} onChange={(v) => setIterations(Math.round(v))} />
              </Field>
              {iterMethod === 'cgls' ? (
                <Field label="Tikhonov μ" value={lambda === 0 ? 'none' : lambda.toFixed(2)}>
                  <Slider min={0} max={2} step={0.05} value={lambda} onChange={setLambda} />
                </Field>
              ) : (
                <Field label="Relaxation λ" value={relax.toFixed(2)}>
                  <Slider min={0.2} max={1.9} step={0.05} value={relax} onChange={setRelax} />
                </Field>
              )}
              {iterMethod !== 'cgls' && (
                <Toggle label="Non-negativity (x ≥ 0)" checked={nonneg} onChange={setNonneg} />
              )}
            </>
          )}
          <div className="btn-row">
            <Button variant={running ? 'default' : 'primary'} onClick={() => setRunning((r) => !r)}>
              {running ? 'Pause' : 'Play'}
            </Button>
            <Button variant="ghost" onClick={replay}>
              Replay
            </Button>
          </div>
          <Toggle label="Show error map" checked={showError} onChange={setShowError} />
          {!isIter && <Toggle label="Show sampled slices" checked={showSlices} onChange={setShowSlices} />}
        </Panel>

        <Panel title="Quality">
          <Readout
            items={[
              { label: 'RMSE', value: isNaN(metrics.rmse) ? '—' : metrics.rmse.toFixed(4) },
              { label: 'Correlation', value: metrics.corr.toFixed(3) },
              { label: isIter ? 'FBP RMSE' : 'Detectors', value: isIter ? fbpBaseline.toFixed(4) : String(nDet) },
              { label: 'Rays', value: `${((angles * nDet) / 1000).toFixed(1)}k` },
            ]}
          />
          <div className="btn-row">
            <Button variant="ghost" onClick={onShare}>
              {copied ? 'Link copied ✓' : 'Copy link'}
            </Button>
          </div>
        </Panel>
      </div>

      <div className="mode-main">
        <p className="mode-intro">
          A CT scanner never sees inside you — it only measures <strong>shadows</strong>. For each
          angle it records the line integrals of the object across a detector bank; stacked over
          angle these are the <strong>sinogram</strong>. <em>Direct</em> inversion (filtered
          back-projection, the Fourier slice theorem) is fast and exact only in the limit of many
          clean angles over a full 180°. Starve it — few projections, a noisy dose, a missing wedge
          of angles — and it streaks. The <em>iterative</em> family treats reconstruction as one big
          least-squares system <strong>A x = b</strong> and solves it directly (SIRT, SART, CGLS),
          fitting every ray at once and folding in priors like <strong>x ≥ 0</strong>. Watch the
          convergence curve duck under the FBP baseline — sparse-view and limited-angle are where
          iterative earns its keep.
        </p>
        <div className="tomo-grid">
          <CanvasCard title="Object" note={uploaded ? 'your upload' : 'phantom'} aspect={1}>
            <canvas ref={objRef} />
          </CanvasCard>
          <CanvasCard title="Sinogram" note="θ (down) · detector (across)" aspect={1}>
            <canvas ref={sinoRef} />
          </CanvasCard>
          <CanvasCard
            title={showError ? 'Error map' : 'Reconstruction'}
            note={showError ? `RMSE ${isNaN(metrics.rmse) ? '—' : metrics.rmse.toFixed(3)}` : progress}
            aspect={1}
          >
            <canvas ref={reconRef} />
          </CanvasCard>
          {isIter ? (
            <CanvasCard
              title="Convergence"
              note="RMSE vs iteration · dashed = FBP"
              aspect={1}
            >
              <canvas ref={convRef} />
            </CanvasCard>
          ) : (
            <CanvasCard
              title={directMethod === 'fourier' ? 'k-space (filled by slices)' : '2-D spectrum + slices'}
              note={directMethod === 'fourier' ? 'gridded projections' : 'Fourier slice theorem'}
              aspect={1}
            >
              <canvas ref={fourierRef} />
            </CanvasCard>
          )}
        </div>
      </div>
    </div>
  )
}
