import { useEffect, useMemo, useRef, useState } from 'react'
import { CanvasCard } from '../components/CanvasCard'
import { Panel, Field, Slider, Select, Segmented, Toggle, Button, Readout } from '../components/Controls'
import { useDprCanvas, prepareContext } from '../hooks/useDprCanvas'
import {
  IMAGES,
  proceduralImage,
  loadImageFile,
  radialMask,
} from '../lib/images'
import type { ImageName, MaskKind } from '../lib/images'
import { fieldFromGray, fft2, fftShift2, logMagnitude2 } from '../lib/fft2'
import { colormapLUT } from '../lib/colormap'
import { readHashParams, shareLink, readNum, readStr, readBool } from '../lib/urlState'

const SIZES: { id: '64' | '128' | '256'; label: string }[] = [
  { id: '64', label: '64 × 64' },
  { id: '128', label: '128 × 128' },
  { id: '256', label: '256 × 256' },
]

const MASKS: { id: MaskKind; label: string }[] = [
  { id: 'low', label: 'Low-pass' },
  { id: 'high', label: 'High-pass' },
  { id: 'band', label: 'Band-pass' },
]

type ThirdView = 'recon' | 'residual'

// Paint a grayscale buffer (0..1) into a canvas, scaling it up to fill.
function drawGray(
  canvas: HTMLCanvasElement | null,
  size: { width: number; height: number; dpr: number },
  gray: Float64Array,
  n: number,
  smooth: boolean,
) {
  const ctx = prepareContext(canvas, size)
  if (!ctx) return
  const off = document.createElement('canvas')
  off.width = n
  off.height = n
  const octx = off.getContext('2d')
  if (!octx) return
  const img = octx.createImageData(n, n)
  for (let i = 0; i < n * n; i++) {
    const v = Math.max(0, Math.min(255, Math.round(gray[i] * 255)))
    img.data[i * 4] = v
    img.data[i * 4 + 1] = v
    img.data[i * 4 + 2] = v
    img.data[i * 4 + 3] = 255
  }
  octx.putImageData(img, 0, 0)
  ctx.imageSmoothingEnabled = smooth
  ctx.imageSmoothingQuality = 'high'
  ctx.drawImage(off, 0, 0, n, n, 0, 0, size.width, size.height)
}

// Paint a normalized field (0..1) through a colormap LUT.
function drawColormap(
  canvas: HTMLCanvasElement | null,
  size: { width: number; height: number; dpr: number },
  data: Float64Array,
  n: number,
  lut: Uint8ClampedArray,
) {
  const ctx = prepareContext(canvas, size)
  if (!ctx) return null
  const off = document.createElement('canvas')
  off.width = n
  off.height = n
  const octx = off.getContext('2d')
  if (!octx) return null
  const img = octx.createImageData(n, n)
  for (let i = 0; i < n * n; i++) {
    const li = (Math.max(0, Math.min(255, Math.round(data[i] * 255))) & 255) * 4
    img.data[i * 4] = lut[li]
    img.data[i * 4 + 1] = lut[li + 1]
    img.data[i * 4 + 2] = lut[li + 2]
    img.data[i * 4 + 3] = 255
  }
  octx.putImageData(img, 0, 0)
  ctx.imageSmoothingEnabled = true
  ctx.imageSmoothingQuality = 'high'
  ctx.drawImage(off, 0, 0, n, n, 0, 0, size.width, size.height)
  return ctx
}

export default function ImageFFT() {
  const sp = useMemo(() => readHashParams(), [])
  const [imgName, setImgName] = useState<ImageName>(() =>
    readStr<ImageName>(sp, 'img', 'grating', IMAGES.map((i) => i.id)),
  )
  const [sizeStr, setSizeStr] = useState(() => readStr(sp, 'n', '128', ['64', '128', '256'] as const))
  const [maskKind, setMaskKind] = useState<MaskKind>(() =>
    readStr<MaskKind>(sp, 'mask', 'low', ['low', 'high', 'band']),
  )
  const [radius, setRadius] = useState(() => readNum(sp, 'r', 0.28))
  const [bandWidth, setBandWidth] = useState(() => readNum(sp, 'bw', 0.12))
  const [softness, setSoftness] = useState(() => readNum(sp, 'soft', 0.08))
  const [showMask, setShowMask] = useState(() => readBool(sp, 'ov', true))
  const [third, setThird] = useState<ThirdView>('recon')
  const [uploaded, setUploaded] = useState<Float64Array | null>(null)
  const [copied, setCopied] = useState(false)

  const fileRef = useRef<HTMLInputElement>(null)
  const n = parseInt(sizeStr, 10)

  const { ref: srcRef, size: srcSize } = useDprCanvas()
  const { ref: specRef, size: specSize } = useDprCanvas()
  const { ref: outRef, size: outSize } = useDprCanvas()

  // Source grayscale image.
  const gray = useMemo<Float64Array>(() => {
    if (uploaded && uploaded.length === n * n) return uploaded
    return proceduralImage(imgName, n)
  }, [uploaded, imgName, n])

  // Forward transform (recomputed only when the image changes).
  const spectrum = useMemo(() => {
    const field = fieldFromGray(gray, n, n)
    const F = fft2(field, false)
    const Fshift = fftShift2(F) // DC centered
    const logMag = logMagnitude2(Fshift)
    // Total energy for the "energy kept" readout.
    let totalE = 0
    for (let i = 0; i < n * n; i++) {
      totalE += Fshift.re[i] * Fshift.re[i] + Fshift.im[i] * Fshift.im[i]
    }
    return { Fshift, logMag, totalE }
  }, [gray, n])

  const maskParams = useMemo(
    () => ({ kind: maskKind, radius, width: bandWidth, softness }),
    [maskKind, radius, bandWidth, softness],
  )

  const mask = useMemo(() => radialMask(n, n, maskParams), [n, maskParams])

  // Apply the mask and inverse-transform.
  const recon = useMemo(() => {
    const { Fshift, totalE } = spectrum
    const masked = { width: n, height: n, re: new Float64Array(n * n), im: new Float64Array(n * n) }
    let keptE = 0
    for (let i = 0; i < n * n; i++) {
      const m = mask[i]
      masked.re[i] = Fshift.re[i] * m
      masked.im[i] = Fshift.im[i] * m
      keptE += masked.re[i] * masked.re[i] + masked.im[i] * masked.im[i]
    }
    // Undo the shift (involutive for even sizes), then invert.
    const unshifted = fftShift2(masked)
    const spatial = fft2(unshifted, true)
    const out = new Float64Array(n * n)
    const residual = new Float64Array(n * n)
    for (let i = 0; i < n * n; i++) {
      const v = spatial.re[i]
      out[i] = Math.max(0, Math.min(1, v))
      residual[i] = Math.min(1, Math.abs(gray[i] - v) * 2.2)
    }
    return { out, residual, keptFrac: totalE > 0 ? keptE / totalE : 0 }
  }, [spectrum, mask, gray, n])

  // ---- draw source ----
  useEffect(() => {
    drawGray(srcRef.current, srcSize, gray, n, n <= 128)
  }, [gray, n, srcSize, srcRef])

  // ---- draw spectrum + mask overlay ----
  useEffect(() => {
    const lut = colormapLUT('viridis')
    const ctx = drawColormap(specRef.current, specSize, spectrum.logMag, n, lut)
    if (!ctx || !showMask) return
    const { width: w, height: h } = specSize
    const cx = w / 2
    const cy = h / 2
    // Cutoff radius (fraction of Nyquist-corner distance) → display pixels.
    const toPx = (frac: number) => frac * (Math.hypot(w / 2, h / 2))
    ctx.strokeStyle = 'rgba(94,234,212,0.9)'
    ctx.lineWidth = 1.6
    ctx.setLineDash([5, 4])
    const ring = (frac: number) => {
      ctx.beginPath()
      ctx.arc(cx, cy, toPx(Math.max(0, frac)), 0, Math.PI * 2)
      ctx.stroke()
    }
    if (maskKind === 'band') {
      ring(radius - bandWidth)
      ring(radius + bandWidth)
    } else {
      ring(radius)
    }
    ctx.setLineDash([])
  }, [spectrum, specSize, specRef, showMask, maskKind, radius, bandWidth, n])

  // ---- draw reconstruction / residual ----
  useEffect(() => {
    if (third === 'residual') {
      const lut = colormapLUT('inferno')
      drawColormap(outRef.current, outSize, recon.residual, n, lut)
    } else {
      drawGray(outRef.current, outSize, recon.out, n, n <= 128)
    }
  }, [recon, third, outSize, outRef, n])

  const onUpload = (file: File | undefined) => {
    if (!file) return
    loadImageFile(file, n).then((buf) => {
      if (buf) setUploaded(buf)
    })
  }

  const onShare = () => {
    shareLink('image', {
      img: imgName,
      n: sizeStr,
      mask: maskKind,
      r: radius.toFixed(3),
      bw: bandWidth.toFixed(3),
      soft: softness.toFixed(3),
      ov: showMask,
    }).then((ok) => {
      if (ok) {
        setCopied(true)
        setTimeout(() => setCopied(false), 1400)
      }
    })
  }

  return (
    <div className="mode">
      <div className="mode-side">
        <Panel title="Image">
          <Field label="Source">
            <Select value={imgName} options={IMAGES} onChange={(v) => { setUploaded(null); setImgName(v) }} />
          </Field>
          <Field label="Resolution">
            <Select value={sizeStr} options={SIZES} onChange={(v) => { setUploaded(null); setSizeStr(v) }} />
          </Field>
          <div className="btn-row">
            <Button variant="ghost" onClick={() => fileRef.current?.click()}>
              Upload photo…
            </Button>
            {uploaded && (
              <Button variant="ghost" onClick={() => setUploaded(null)}>
                Use sample
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

        <Panel title="Frequency mask">
          <Segmented value={maskKind} options={MASKS} onChange={setMaskKind} />
          <Field label={maskKind === 'band' ? 'Center radius' : 'Cutoff radius'} value={radius.toFixed(2)}>
            <Slider min={0.02} max={1} step={0.01} value={radius} onChange={setRadius} />
          </Field>
          {maskKind === 'band' && (
            <Field label="Band half-width" value={bandWidth.toFixed(2)}>
              <Slider min={0.02} max={0.4} step={0.01} value={bandWidth} onChange={setBandWidth} />
            </Field>
          )}
          <Field label="Edge softness" value={softness.toFixed(2)}>
            <Slider min={0.01} max={0.3} step={0.01} value={softness} onChange={setSoftness} />
          </Field>
          <Toggle label="Show mask on spectrum" checked={showMask} onChange={setShowMask} />
          <Field label="Third panel">
            <Segmented
              value={third}
              options={[
                { id: 'recon', label: 'Filtered' },
                { id: 'residual', label: 'Residual' },
              ]}
              onChange={setThird}
            />
          </Field>
          <Readout
            items={[
              { label: 'Energy kept', value: `${(recon.keptFrac * 100).toFixed(1)}%` },
              { label: 'Pixels', value: `${n}²` },
              { label: 'Transforms', value: `${2 * n} 1-D FFTs` },
            ]}
          />
          <div className="btn-row">
            <Button variant="primary" onClick={onShare}>
              {copied ? 'Link copied ✓' : 'Copy link'}
            </Button>
          </div>
        </Panel>
      </div>

      <div className="mode-main">
        <p className="mode-intro">
          The Fourier transform is <strong>separable</strong>: transform every row of an image, then
          every column, and you have its <strong>2-D spectrum</strong>. Bright spots near the center
          are coarse structure; the edges are fine detail. Paint a <em>mask</em> over the frequency
          plane — keep the middle for a blur, keep the rim for an edge-finder — then invert to see
          the filtered image rebuild itself.
        </p>
        <div className="img-grid">
          <CanvasCard title="Source image" note={uploaded ? 'your upload' : 'procedural'} aspect={1}>
            <canvas ref={srcRef} />
          </CanvasCard>
          <CanvasCard title="2-D spectrum" note="log-magnitude · DC centered" aspect={1}>
            <canvas ref={specRef} />
          </CanvasCard>
          <CanvasCard
            title={third === 'residual' ? 'Removed detail' : 'Reconstruction'}
            note={third === 'residual' ? 'what the mask discarded' : 'inverse 2-D FFT'}
            aspect={1}
          >
            <canvas ref={outRef} />
          </CanvasCard>
        </div>
      </div>
    </div>
  )
}
