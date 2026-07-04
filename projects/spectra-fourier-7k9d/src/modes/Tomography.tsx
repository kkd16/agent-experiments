import { useEffect, useMemo, useRef, useState } from 'react'
import { CanvasCard } from '../components/CanvasCard'
import { Panel, Field, Slider, Select, Segmented, Toggle, Button, Readout } from '../components/Controls'
import { useDprCanvas, prepareContext } from '../hooks/useDprCanvas'
import { useAnimationFrame } from '../hooks/useAnimationFrame'
import { paintGray, paintColormap } from '../lib/draw'
import { colormapLUT } from '../lib/colormap'
import { makePhantom, PHANTOMS } from '../lib/phantom'
import type { PhantomName } from '../lib/phantom'
import { loadImageFile } from '../lib/images'
import {
  forwardRadon,
  filterSinogram,
  backprojectAngle,
  backproject,
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
import { readHashParams, shareLink, readNum, readStr, readBool } from '../lib/urlState'

type Method = 'fbp' | 'fourier' | 'backproj'
type SizeStr = '64' | '128' | '256'

const SIZES: { id: SizeStr; label: string }[] = [
  { id: '64', label: '64 × 64' },
  { id: '128', label: '128 × 128' },
  { id: '256', label: '256 × 256' },
]

const METHODS: { id: Method; label: string }[] = [
  { id: 'fbp', label: 'Filtered BP' },
  { id: 'fourier', label: 'Fourier slice' },
  { id: 'backproj', label: 'Raw BP' },
]

export default function Tomography() {
  const sp = useMemo(() => readHashParams(), [])
  const [phantom, setPhantom] = useState<PhantomName>(() =>
    readStr<PhantomName>(sp, 'ph', 'shepp', PHANTOMS.map((p) => p.id)),
  )
  const [sizeStr, setSizeStr] = useState<SizeStr>(() =>
    readStr<SizeStr>(sp, 'n', '128', ['64', '128', '256']),
  )
  const [angles, setAngles] = useState(() => Math.round(readNum(sp, 'ang', 180)))
  const [method, setMethod] = useState<Method>(() =>
    readStr<Method>(sp, 'm', 'fbp', ['fbp', 'fourier', 'backproj']),
  )
  const [filter, setFilter] = useState<FilterName>(() =>
    readStr<FilterName>(sp, 'f', 'ramlak', FILTERS.map((x) => x.id)),
  )
  const [noise, setNoise] = useState(() => readNum(sp, 'noise', 0))
  const [speed, setSpeed] = useState(() => readNum(sp, 'spd', 1))
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

  // The measured sinogram (with optional dose noise) — the heavy compute.
  const sino = useMemo<Sinogram>(() => {
    const raw = forwardRadon(image, size, angles)
    return noise > 0 ? addNoise(raw, noise) : raw
  }, [image, size, angles, noise])

  const nDet = sino.nDet

  // Filtered sinogram (for FBP) and the two possible reconstructions.
  const filtered = useMemo(() => filterSinogram(sino, filter), [sino, filter])
  const fourier = useMemo(() => directFourier(sino, size), [sino, size])

  // Full reconstruction (all angles) — what the animation converges to.
  const reconFull = useMemo<Float64Array>(() => {
    if (method === 'fourier') return fourier.recon
    if (method === 'backproj') return backproject(sino, size)
    return backproject(filtered, size)
  }, [method, fourier, sino, filtered, size])

  const metrics = useMemo(() => {
    const { error, rmse } = affineError(reconFull, image)
    return { error, rmse, corr: correlation(reconFull, image) }
  }, [reconFull, image])

  // The true 2-D spectrum, shown with the sampled radial slices overlaid.
  const spectrum = useMemo(() => trueSpectrum(image, size), [image, size])

  const { ref: objRef, size: objSize } = useDprCanvas()
  const { ref: sinoRef, size: sinoSize } = useDprCanvas()
  const { ref: reconRef, size: reconSize } = useDprCanvas()
  const { ref: fourierRef, size: fourierSize } = useDprCanvas()

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
    const ctx = prepareContext(fourierRef.current, fourierSize)
    if (!ctx) return
    const w = fourierSize.width
    const h = fourierSize.height
    if (method === 'fourier') {
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
        const theta = (a * Math.PI) / angles
        const dx = Math.cos(theta)
        const dy = -Math.sin(theta)
        ctx.strokeStyle = 'rgba(94,234,212,0.16)'
        ctx.beginPath()
        ctx.moveTo(cx - dx * R, cy - dy * R)
        ctx.lineTo(cx + dx * R, cy + dy * R)
        ctx.stroke()
      }
    }
  }, [method, fourier, spectrum, showSlices, angles, size, fourierSize, fourierRef, magma])

  // ---- animated reconstruction (progressive back-projection) ----
  const accRef = useRef<Float64Array>(new Float64Array(size * size))
  const doneRef = useRef(0) // number of angles back-projected so far
  const [built, setBuilt] = useState(0) // mirror of doneRef for the readout

  // Reset the accumulator whenever the inputs change (refs only — the RAF below
  // syncs the `built` readout, so no setState is needed in this effect).
  useEffect(() => {
    accRef.current = new Float64Array(size * size)
    doneRef.current = 0
  }, [filtered, sino, method, size])

  useAnimationFrame(() => {
    const ctx = prepareContext(reconRef.current, reconSize)
    if (!ctx) return
    const rect = { x: 0, y: 0, w: reconSize.width, h: reconSize.height }

    if (showError) {
      const emax = metrics.error.reduce((m, v) => (v > m ? v : m), 1e-9)
      const en = new Float64Array(metrics.error.length)
      for (let i = 0; i < en.length; i++) en[i] = metrics.error[i] / emax
      paintColormap(ctx, rect, en, size, size, inferno, true)
      return
    }

    if (method === 'fourier') {
      paintGray(ctx, rect, normalize01(fourier.recon), size, size, true)
      return
    }

    const src = method === 'backproj' ? sino : filtered
    if (running && doneRef.current < angles) {
      const perFrame = Math.max(1, Math.round((angles / 90) * speed))
      for (let s = 0; s < perFrame && doneRef.current < angles; s++) {
        backprojectAngle(accRef.current, src, doneRef.current, size)
        doneRef.current++
      }
    }
    // Keep the readout in sync (also picks up a reset while paused).
    if (built !== doneRef.current) setBuilt(doneRef.current)
    paintGray(ctx, rect, normalize01(accRef.current), size, size, true)
  }, true)

  const replay = () => {
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
      m: method,
      f: filter,
      noise: noise.toFixed(2),
      spd: speed.toFixed(1),
      err: showError,
      sl: showSlices,
    }).then((ok) => {
      if (ok) {
        setCopied(true)
        setTimeout(() => setCopied(false), 1400)
      }
    })
  }

  const progress =
    method === 'fourier'
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
          <Field label="Dose noise" value={noise === 0 ? 'clean' : `${(noise * 100).toFixed(0)}%`}>
            <Slider min={0} max={0.15} step={0.005} value={noise} onChange={setNoise} />
          </Field>
        </Panel>

        <Panel title="Reconstruction">
          <Segmented value={method} options={METHODS} onChange={setMethod} />
          {method === 'fbp' && (
            <Field label="Ramp filter">
              <Select value={filter} options={FILTERS} onChange={setFilter} />
            </Field>
          )}
          {method !== 'fourier' && (
            <>
              <Field label="Build speed" value={`${speed.toFixed(1)}×`}>
                <Slider min={0.3} max={4} step={0.1} value={speed} onChange={setSpeed} />
              </Field>
              <div className="btn-row">
                <Button variant={running ? 'default' : 'primary'} onClick={() => setRunning((r) => !r)}>
                  {running ? 'Pause' : 'Play'}
                </Button>
                <Button variant="ghost" onClick={replay}>
                  Replay
                </Button>
              </div>
            </>
          )}
          <Toggle label="Show error map" checked={showError} onChange={setShowError} />
          <Toggle label="Show sampled slices" checked={showSlices} onChange={setShowSlices} />
        </Panel>

        <Panel title="Quality">
          <Readout
            items={[
              { label: 'RMSE', value: metrics.rmse.toFixed(4) },
              { label: 'Correlation', value: metrics.corr.toFixed(3) },
              { label: 'Detectors', value: String(nDet) },
              { label: 'Rays', value: `${(angles * nDet / 1000).toFixed(1)}k` },
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
          angle these are the <strong>sinogram</strong>. Recovering the slice is the{' '}
          <strong>Fourier Slice Theorem</strong> at work: the 1-D transform of each projection is a
          radial line through the object's 2-D spectrum. Fill enough lines and one inverse transform
          brings the picture back. Watch <em>Filtered back-projection</em> smear each reading across
          the image and resolve a sharp reconstruction — then compare the raw, unfiltered blur.
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
            note={showError ? `RMSE ${metrics.rmse.toFixed(3)}` : progress}
            aspect={1}
          >
            <canvas ref={reconRef} />
          </CanvasCard>
          <CanvasCard
            title={method === 'fourier' ? 'k-space (filled by slices)' : '2-D spectrum + slices'}
            note={method === 'fourier' ? 'gridded projections' : 'Fourier slice theorem'}
            aspect={1}
          >
            <canvas ref={fourierRef} />
          </CanvasCard>
        </div>
      </div>
    </div>
  )
}
