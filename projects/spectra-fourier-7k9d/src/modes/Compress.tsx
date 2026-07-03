import { useEffect, useMemo, useRef, useState } from 'react'
import { CanvasCard } from '../components/CanvasCard'
import { Panel, Field, Slider, Select, Segmented, Toggle, Readout, Button } from '../components/Controls'
import { useDprCanvas, prepareContext } from '../hooks/useDprCanvas'
import { IMAGES, proceduralImage, loadImageFile } from '../lib/images'
import type { ImageName } from '../lib/images'
import { compressImage, blockCoeffs, BLOCK, qTableForQuality } from '../lib/dct'
import { colormapLUT } from '../lib/colormap'
import { fillPlotBg, axisLabel, paintGray, paintColormap } from '../lib/draw'
import type { Rect } from '../lib/draw'
import { readHashParams, shareLink, readNum, readStr, readBool } from '../lib/urlState'

type SizeId = '128' | '256'

const SIZES: { id: SizeId; label: string }[] = [
  { id: '128', label: '128 × 128' },
  { id: '256', label: '256 × 256' },
]

type MainView = 'recon' | 'residual'

// Draw the 8×8 grid overlay + highlight the inspected block on the source image.
function drawBlockOverlay(ctx: CanvasRenderingContext2D, r: Rect, n: number, bx: number, by: number) {
  const cell = r.w / n
  ctx.strokeStyle = 'rgba(94,234,212,0.10)'
  ctx.lineWidth = 1
  for (let i = 0; i <= n; i += BLOCK) {
    const p = i * cell
    ctx.beginPath()
    ctx.moveTo(r.x + p, r.y)
    ctx.lineTo(r.x + p, r.y + r.h)
    ctx.moveTo(r.x, r.y + p)
    ctx.lineTo(r.x + r.w, r.y + p)
    ctx.stroke()
  }
  ctx.strokeStyle = '#5eead4'
  ctx.lineWidth = 2
  // bx,by are block indices; each block spans BLOCK source pixels.
  ctx.strokeRect(r.x + bx * BLOCK * cell, r.y + by * BLOCK * cell, BLOCK * cell, BLOCK * cell)
}

export default function Compress() {
  const sp = useMemo(() => readHashParams(), [])
  const [imgName, setImgName] = useState<ImageName>(() =>
    readStr<ImageName>(sp, 'img', 'portrait', IMAGES.map((i) => i.id)),
  )
  const [sizeStr, setSizeStr] = useState<SizeId>(() =>
    readStr<SizeId>(sp, 'n', '128', SIZES.map((s) => s.id)),
  )
  const [quality, setQuality] = useState(() => readNum(sp, 'q', 18))
  const [view, setView] = useState<MainView>(() => readStr<MainView>(sp, 'v', 'recon', ['recon', 'residual']))
  const [showGrid, setShowGrid] = useState(() => readBool(sp, 'g', true))
  const [uploaded, setUploaded] = useState<Float64Array | null>(null)
  const [block, setBlock] = useState<{ bx: number; by: number }>({ bx: 4, by: 4 })
  const [copied, setCopied] = useState(false)
  const fileRef = useRef<HTMLInputElement>(null)

  const n = Number(sizeStr)

  const { ref: srcRef, size: srcSize } = useDprCanvas()
  const { ref: outRef, size: outSize } = useDprCanvas()
  const { ref: coeffRef, size: coeffSize } = useDprCanvas()
  const { ref: qRef, size: qSize } = useDprCanvas()

  const gray = useMemo(() => {
    if (uploaded && uploaded.length === n * n) return uploaded
    return proceduralImage(imgName, n)
  }, [imgName, n, uploaded])

  const result = useMemo(() => compressImage(gray, n, n, quality), [gray, n, quality])

  const onUpload = (file: File | undefined) => {
    if (!file) return
    loadImageFile(file, n).then((buf) => {
      if (buf) setUploaded(buf)
    })
  }

  const onShare = () => {
    shareLink('compress', { img: imgName, n: sizeStr, q: quality, v: view, g: showGrid }).then((ok) => {
      if (ok) {
        setCopied(true)
        setTimeout(() => setCopied(false), 1400)
      }
    })
  }

  const grayLut = useMemo(() => colormapLUT('viridis'), [])
  const coeffLut = useMemo(() => colormapLUT('inferno'), [])

  // Source image + block picker overlay.
  useEffect(() => {
    const ctx = prepareContext(srcRef.current, srcSize)
    if (!ctx) return
    const r: Rect = { x: 0, y: 0, w: srcSize.width, h: srcSize.height }
    paintGray(ctx, r, gray, n, n, false)
    if (showGrid) drawBlockOverlay(ctx, r, n, block.bx, block.by)
  }, [gray, n, srcSize, showGrid, block, srcRef])

  const pickBlock = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const canvas = srcRef.current
    if (!canvas) return
    const rect = canvas.getBoundingClientRect()
    const fx = (e.clientX - rect.left) / rect.width
    const fy = (e.clientY - rect.top) / rect.height
    const bx = Math.max(0, Math.min(Math.floor(n / BLOCK) - 1, Math.floor((fx * n) / BLOCK)))
    const by = Math.max(0, Math.min(Math.floor(n / BLOCK) - 1, Math.floor((fy * n) / BLOCK)))
    setBlock({ bx, by })
  }

  // Reconstruction or amplified residual.
  useEffect(() => {
    const ctx = prepareContext(outRef.current, outSize)
    if (!ctx) return
    const r: Rect = { x: 0, y: 0, w: outSize.width, h: outSize.height }
    if (view === 'recon') {
      paintGray(ctx, r, result.recon, n, n, false)
    } else {
      const amp = new Float64Array(n * n)
      for (let i = 0; i < n * n; i++) amp[i] = Math.min(1, result.residual[i] * 6)
      paintColormap(ctx, r, amp, n, n, coeffLut, false)
      axisLabel(ctx, 'error ×6', r.w - 8, 16, 'right')
    }
  }, [result, view, n, outSize, coeffLut, outRef])

  // DCT coefficient heatmap of the inspected 8×8 block (log-magnitude).
  useEffect(() => {
    const ctx = prepareContext(coeffRef.current, coeffSize)
    if (!ctx) return
    const r: Rect = { x: 0, y: 0, w: coeffSize.width, h: coeffSize.height }
    fillPlotBg(ctx, r)
    const coeff = blockCoeffs(gray, n, n, block.bx * BLOCK, block.by * BLOCK)
    const qt = qTableForQuality(quality)
    const field = new Float64Array(BLOCK * BLOCK)
    let maxLog = 1e-6
    const logs = new Float64Array(BLOCK * BLOCK)
    for (let i = 0; i < BLOCK * BLOCK; i++) {
      logs[i] = Math.log(1 + Math.abs(coeff[i]))
      if (logs[i] > maxLog) maxLog = logs[i]
    }
    for (let i = 0; i < BLOCK * BLOCK; i++) field[i] = logs[i] / maxLog
    // Blit at native 8×8 (nearest-neighbour) so each coefficient is a crisp cell.
    const side = Math.min(r.w, r.h)
    const ox = r.x + (r.w - side) / 2
    const oy = r.y + (r.h - side) / 2
    paintColormap(ctx, { x: ox, y: oy, w: side, h: side }, field, BLOCK, BLOCK, coeffLut, false)
    // Mark coefficients that survive quantisation at this quality (|coeff| >= q/2).
    const cell = side / BLOCK
    ctx.strokeStyle = 'rgba(94,234,212,0.9)'
    ctx.lineWidth = 1.4
    for (let k = 0; k < BLOCK; k++) {
      for (let j = 0; j < BLOCK; j++) {
        const idx = k * BLOCK + j
        if (Math.abs(coeff[idx]) >= qt[idx] / 2) {
          ctx.strokeRect(ox + j * cell + 1, oy + k * cell + 1, cell - 2, cell - 2)
        }
      }
    }
    axisLabel(ctx, 'DC', ox + 2, oy + 12, 'left')
    axisLabel(ctx, 'kept ▢', r.x + r.w - 6, r.y + r.h - 6, 'right')
  }, [gray, n, block, quality, coeffSize, coeffLut, coeffRef])

  // The quantisation table itself, scaled by quality (bigger = coarser = darker→bright).
  useEffect(() => {
    const ctx = prepareContext(qRef.current, qSize)
    if (!ctx) return
    const r: Rect = { x: 0, y: 0, w: qSize.width, h: qSize.height }
    fillPlotBg(ctx, r)
    const qt = qTableForQuality(quality)
    let maxq = 1
    for (const v of qt) maxq = Math.max(maxq, v)
    const field = new Float64Array(BLOCK * BLOCK)
    for (let i = 0; i < BLOCK * BLOCK; i++) field[i] = Math.min(1, qt[i] / maxq)
    const side = Math.min(r.w, r.h)
    const ox = r.x + (r.w - side) / 2
    const oy = r.y + (r.h - side) / 2
    paintColormap(ctx, { x: ox, y: oy, w: side, h: side }, field, BLOCK, BLOCK, grayLut, false)
    axisLabel(ctx, `step ${qt[0]}…${Math.round(maxq)}`, r.x + r.w - 6, r.y + r.h - 6, 'right')
  }, [quality, qSize, grayLut, qRef])

  const psnrStr = result.psnr === Infinity ? '∞' : `${result.psnr.toFixed(1)} dB`
  const sparsity = ((1 - result.nonzero / result.total) * 100).toFixed(1)

  return (
    <div className="mode">
      <div className="mode-side">
        <Panel title="Image">
          <Field label="Source">
            <Select
              value={imgName}
              options={IMAGES}
              onChange={(v) => {
                setImgName(v)
                setUploaded(null)
              }}
            />
          </Field>
          <Field label="Resolution">
            <Segmented value={sizeStr} options={SIZES} onChange={setSizeStr} />
          </Field>
          <div className="btn-row">
            <Button variant="ghost" onClick={() => fileRef.current?.click()}>
              Upload image…
            </Button>
            {uploaded && (
              <Button variant="ghost" onClick={() => setUploaded(null)}>
                Clear
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
          <p className="hint">Click the source image to inspect any 8×8 block's coefficients.</p>
        </Panel>

        <Panel title="Quantisation">
          <Field label="JPEG quality" value={String(quality)}>
            <Slider min={1} max={100} step={1} value={quality} onChange={(v) => setQuality(Math.round(v))} />
          </Field>
          <Readout
            items={[
              { label: 'PSNR', value: psnrStr },
              { label: 'Ratio', value: `${result.ratio.toFixed(1)}×` },
              { label: 'bits/px', value: result.entropyBpp.toFixed(2) },
            ]}
          />
          <Readout
            items={[
              { label: 'Zeroed coeffs', value: `${sparsity}%` },
              { label: 'Block', value: `${block.bx},${block.by}` },
            ]}
          />
        </Panel>

        <Panel title="View &amp; share">
          <Segmented
            value={view}
            options={[
              { id: 'recon', label: 'Reconstruction' },
              { id: 'residual', label: 'Error map' },
            ]}
            onChange={setView}
          />
          <Toggle label="8×8 block grid" checked={showGrid} onChange={setShowGrid} />
          <div className="btn-row">
            <Button variant="ghost" onClick={onShare}>
              {copied ? 'Link copied ✓' : 'Copy link'}
            </Button>
          </div>
        </Panel>
      </div>

      <div className="mode-main">
        <p className="mode-intro">
          JPEG is a Fourier transform in disguise. Split the image into 8×8 blocks, take the{' '}
          <strong>discrete cosine transform</strong> of each — a cousin of the FFT that packs almost
          all the energy into a few low-frequency coefficients — then <strong>quantise</strong>:
          divide by a table and round, throwing away the coefficients the eye won't miss. Drop the
          quality and watch the classic <em>ringing</em> and <em>blocking</em> artefacts appear as
          those coefficients vanish.
        </p>
        <div className="split-2">
          <CanvasCard title="Source" note="click to pick a block" aspect={1}>
            <canvas ref={srcRef} onClick={pickBlock} style={{ cursor: 'crosshair' }} />
          </CanvasCard>
          <CanvasCard
            title={view === 'recon' ? 'Reconstructed' : 'Error map'}
            note={view === 'recon' ? `${psnrStr} · ${result.ratio.toFixed(1)}× smaller` : 'absolute error, amplified'}
            aspect={1}
          >
            <canvas ref={outRef} />
          </CanvasCard>
        </div>
        <div className="split-2">
          <CanvasCard title="Block DCT coefficients" note="log-magnitude · ▢ = survives quantisation" aspect={1.35}>
            <canvas ref={coeffRef} />
          </CanvasCard>
          <CanvasCard title="Quantisation table" note="JPEG luma × quality" aspect={1.35}>
            <canvas ref={qRef} />
          </CanvasCard>
        </div>
      </div>
    </div>
  )
}
