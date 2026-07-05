import { useEffect, useMemo, useRef, useState } from 'react'
import { PageHeader, Panel, Stat } from '../components/ui'
import { HBarChart, LineChart } from '../components/charts'
import {
  encodeJPEG,
  decodeJPEG,
  psnr,
  rgbToYCbCr,
  type Subsampling,
  type EncodeResult,
} from '../lib/jpeg'
import { fdct8x8, idct8x8 } from '../lib/dct'
import { STD_LUMA_QUANT, scaleQuantTable } from '../lib/jpegTables'
import { SAMPLES } from '../lib/pngSamples'
import type { RGBAImage } from '../lib/png'
import { runJpegInterop, jpegInteropAvailable, type InteropResult } from '../lib/selftest'

const W = 128
const H = 96

type Mode = Subsampling | 'gray'
const MODES: { id: Mode; label: string; note: string }[] = [
  { id: '4:4:4', label: '4:4:4', note: 'full chroma' },
  { id: '4:2:2', label: '4:2:2', note: 'half-width chroma' },
  { id: '4:2:0', label: '4:2:0', note: 'quarter chroma (the web default)' },
  { id: 'gray', label: 'Gray', note: 'luma only' },
]

function fmtBytes(n: number): string {
  return n < 1024 ? `${n} B` : `${(n / 1024).toFixed(1)} KB`
}

// ---- draw an RGBA image to a crisp, nearest-neighbour-scaled canvas ----
function PixelCanvas({ image, scale = 2, label }: { image: RGBAImage; scale?: number; label?: string }) {
  const ref = useRef<HTMLCanvasElement>(null)
  useEffect(() => {
    const cv = ref.current
    if (!cv) return
    cv.width = image.width
    cv.height = image.height
    try {
      const ctx = cv.getContext('2d')
      if (!ctx) return
      ctx.putImageData(new ImageData(new Uint8ClampedArray(image.rgba), image.width, image.height), 0, 0)
    } catch {
      /* sandboxed thumbnail — ignore */
    }
  }, [image])
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      <div style={{ width: image.width * scale, maxWidth: '100%', borderRadius: 8, overflow: 'hidden', border: '1px solid var(--border)' }}>
        <canvas ref={ref} style={{ width: '100%', height: 'auto', display: 'block', imageRendering: 'pixelated' }} />
      </div>
      {label && <div className="muted mono" style={{ fontSize: 12 }}>{label}</div>}
    </div>
  )
}

// heat ramp: t∈[0,1] → deep navy → teal → amber (matches the lab palette feel)
function heat(t: number): string {
  const c = Math.max(0, Math.min(1, t))
  const stops: [number, number, number][] = [
    [14, 19, 28],
    [46, 120, 150],
    [46, 196, 182],
    [242, 183, 74],
    [235, 92, 112],
  ]
  const x = c * (stops.length - 1)
  const i = Math.min(stops.length - 2, Math.floor(x))
  const f = x - i
  const a = stops[i]
  const b = stops[i + 1]
  return `rgb(${Math.round(a[0] + (b[0] - a[0]) * f)},${Math.round(a[1] + (b[1] - a[1]) * f)},${Math.round(a[2] + (b[2] - a[2]) * f)})`
}

// an 8×8 matrix rendered as a labelled heat grid
function Grid8({ values, colorFor, fmt, cell = 40 }: { values: Float64Array | number[]; colorFor: (v: number, i: number) => string; fmt: (v: number) => string; cell?: number }) {
  const size = cell * 8
  return (
    <div style={{ overflowX: 'auto' }}>
      <svg viewBox={`0 0 ${size} ${size}`} width={size} style={{ maxWidth: '100%', borderRadius: 6 }} role="img">
        {Array.from({ length: 64 }, (_, i) => {
          const x = (i % 8) * cell
          const y = Math.floor(i / 8) * cell
          const v = values[i]
          const bg = colorFor(v, i)
          // pick a legible text colour from background luminance
          const m = /rgb\((\d+),(\d+),(\d+)\)/.exec(bg)
          const lum = m ? (0.299 * +m[1] + 0.587 * +m[2] + 0.114 * +m[3]) / 255 : 0.3
          const txt = lum > 0.6 ? '#0a0d13' : 'rgba(255,255,255,0.86)'
          return (
            <g key={i}>
              <rect x={x + 0.5} y={y + 0.5} width={cell - 1} height={cell - 1} fill={bg} stroke="var(--border)" strokeWidth={0.5} />
              <text x={x + cell / 2} y={y + cell / 2 + 3.5} textAnchor="middle" fontSize={Math.min(12, cell / 3.4)} fontFamily="var(--mono)" fill={txt}>
                {fmt(v)}
              </text>
            </g>
          )
        })}
      </svg>
    </div>
  )
}

export function Jpeg() {
  const [sampleId, setSampleId] = useState('photo')
  const [quality, setQuality] = useState(50)
  const [mode, setMode] = useState<Mode>('4:2:0')
  const [block, setBlock] = useState<[number, number]>([7, 5])

  const source = useMemo<RGBAImage>(() => {
    const def = SAMPLES.find((s) => s.id === sampleId) ?? SAMPLES[0]
    return def.make(W, H)
  }, [sampleId])

  const encOpts = useMemo(
    () => (mode === 'gray' ? { quality, grayscale: true } : { quality, subsampling: mode }),
    [quality, mode],
  )

  const { enc, decoded, err, ratio } = useMemo(() => {
    const enc: EncodeResult = encodeJPEG(source, encOpts)
    const decoded = decodeJPEG(enc.bytes).image
    // amplified error map
    const err = new Uint8Array(W * H * 4)
    for (let i = 0; i < W * H; i++) {
      const o = i * 4
      for (let c = 0; c < 3; c++) err[o + c] = Math.min(255, Math.abs(source.rgba[o + c] - decoded.rgba[o + c]) * 6)
      err[o + 3] = 255
    }
    const raw = W * H * 3
    return { enc, decoded, err: { width: W, height: H, rgba: err } as RGBAImage, ratio: raw / enc.bytes.length }
  }, [source, encOpts])

  const distortion = psnr(source, decoded)

  // ---- rate–distortion sweep for the current image + subsampling ----
  const rdCurve = useMemo(() => {
    const pts: [number, number][] = []
    for (const q of [5, 10, 15, 20, 30, 40, 50, 60, 70, 80, 90, 95, 100]) {
      const e = encodeJPEG(source, mode === 'gray' ? { quality: q, grayscale: true } : { quality: q, subsampling: mode })
      const d = decodeJPEG(e.bytes).image
      const p = psnr(source, d)
      pts.push([e.bitsPerPixel, Number.isFinite(p) ? p : 60])
    }
    return pts
  }, [source, mode])

  const curPoint: [number, number] = [enc.bitsPerPixel, Number.isFinite(distortion) ? distortion : 60]
  const maxBpp = Math.max(...rdCurve.map((p) => p[0]), curPoint[0]) * 1.05
  const maxPsnr = Math.max(...rdCurve.map((p) => p[1]), curPoint[1]) + 3

  // ---- the 8×8 block story ----
  const lumaQ = useMemo(() => scaleQuantTable(STD_LUMA_QUANT, quality), [quality])
  const story = useMemo(() => {
    const [bx, by] = block
    const px0 = bx * 8
    const py0 = by * 8
    const spatial = new Float64Array(64)
    for (let y = 0; y < 8; y++) {
      for (let x = 0; x < 8; x++) {
        const sx = Math.min(W - 1, px0 + x)
        const sy = Math.min(H - 1, py0 + y)
        const o = (sy * W + sx) * 4
        const [Y] = rgbToYCbCr(source.rgba[o], source.rgba[o + 1], source.rgba[o + 2])
        spatial[y * 8 + x] = Y
      }
    }
    const shifted = spatial.map((v) => v - 128)
    const freq = fdct8x8(shifted)
    const quant = new Float64Array(64)
    const dequant = new Float64Array(64)
    let survivors = 0
    for (let i = 0; i < 64; i++) {
      const q = Math.round(freq[i] / lumaQ[i])
      quant[i] = q
      dequant[i] = q * lumaQ[i]
      if (q !== 0) survivors++
    }
    const recon = idct8x8(dequant).map((v) => Math.max(0, Math.min(255, Math.round(v + 128))))
    return { spatial, freq, quant, recon, survivors }
  }, [source, block, lumaQ])

  // pick a block by clicking the original
  const onPickBlock = (e: React.MouseEvent<HTMLDivElement>) => {
    const rect = e.currentTarget.getBoundingClientRect()
    const x = ((e.clientX - rect.left) / rect.width) * W
    const y = ((e.clientY - rect.top) / rect.height) * H
    setBlock([Math.max(0, Math.min(15, Math.floor(x / 8))), Math.max(0, Math.min(11, Math.floor(y / 8)))])
  }

  const dcBits = enc.components.reduce((a, c) => a + c.dcBits, 0)
  const acBits = enc.components.reduce((a, c) => a + c.acBits, 0)

  return (
    <div>
      <PageHeader
        kicker="Lossy compression · Shannon's third theorem"
        title="JPEG · the rate–distortion frontier"
        lede={
          <>
            Every lossless coder in this lab chases one hard floor — the entropy <em>H</em>. JPEG steps
            straight past it by throwing information away <em>on purpose</em>, but only the information the eye
            cannot see. A change of basis (the <strong>8×8 DCT</strong>) concentrates each block's energy into a
            few coefficients; <strong>quantisation</strong> — the one lossy step — spends bits only where they
            show. The result is a real <code>.jpg</code>, built here from scratch: the self-test proves the
            browser's own decoder renders our file, and that we decode the browser's.
          </>
        }
      />

      <div className="controls">
        <label className="field">
          Image
          <div className="chip-row">
            {SAMPLES.map((s) => (
              <button key={s.id} className={`chip${sampleId === s.id ? ' active' : ''}`} onClick={() => setSampleId(s.id)}>
                {s.name}
              </button>
            ))}
          </div>
        </label>
      </div>
      <div className="controls">
        <label className="field" style={{ minWidth: 260 }}>
          Quality — {quality}
          <input type="range" min={1} max={100} value={quality} onChange={(e) => setQuality(+e.target.value)} style={{ width: 260 }} />
        </label>
        <label className="field">
          Chroma subsampling
          <div className="chip-row">
            {MODES.map((m) => (
              <button key={m.id} className={`chip${mode === m.id ? ' active' : ''}`} onClick={() => setMode(m.id)} title={m.note}>
                {m.label}
              </button>
            ))}
          </div>
        </label>
      </div>

      <div className="grid grid-4" style={{ marginBottom: 16 }}>
        <Stat label="Compression" value={ratio.toFixed(1)} unit="×" sub={`vs ${fmtBytes(W * H * 3)} raw RGB`} accent />
        <Stat label="Rate" value={enc.bitsPerPixel.toFixed(2)} unit="bpp" sub={fmtBytes(enc.bytes.length)} />
        <Stat label="Distortion" value={Number.isFinite(distortion) ? distortion.toFixed(1) : '∞'} unit="dB PSNR" sub={distortion > 40 ? 'transparent' : distortion > 32 ? 'excellent' : distortion > 26 ? 'visible artefacts' : 'heavy'} />
        <Stat label="Model" value={enc.subsampling} sub={`quality ${enc.quality}`} />
      </div>

      <Panel title="Original → decoded → error" note="What quantisation kept, and what it discarded (error amplified ×6). Click the original to inspect any 8×8 block below.">
        <div className="grid grid-3">
          <div onClick={onPickBlock} style={{ cursor: 'crosshair' }} title="click to pick a block">
            <PixelCanvas image={source} label={`original · ${W}×${H}`} />
          </div>
          <PixelCanvas image={decoded} label={`JPEG · ${fmtBytes(enc.bytes.length)} · ${enc.bitsPerPixel.toFixed(2)} bpp`} />
          <PixelCanvas image={err} label={`|difference| ×6 · ${Number.isFinite(distortion) ? distortion.toFixed(1) : '∞'} dB`} />
        </div>
      </Panel>

      <Panel
        title="The rate–distortion curve"
        note="Sweep the quality knob and every point is a real encode+decode of this image. Fidelity climbs with rate and saturates — Shannon's third theorem made operational: to halve the distortion you must pay in bits."
      >
        <LineChart
          series={[{ label: 'operational R–D (this image)', color: 'var(--teal)', points: rdCurve }]}
          xDomain={[0, maxBpp]}
          yDomain={[Math.max(0, Math.min(...rdCurve.map((p) => p[1])) - 3), maxPsnr]}
          xLabel="rate — bits / pixel"
          yLabel="fidelity — PSNR (dB)"
          xFmt={(v) => v.toFixed(1)}
          yFmt={(v) => v.toFixed(0)}
          markers={[{ x: curPoint[0], y: curPoint[1], label: `q${quality}` }]}
          height={260}
        />
      </Panel>

      <Panel
        title={`Inside one 8×8 block — (${block[0]}, ${block[1]})`}
        note="The whole JPEG idea in one block: transform to frequency, divide by the quantisation table, and watch most coefficients collapse to zero. Only the survivors are transmitted."
      >
        <div className="grid grid-2" style={{ gap: 18 }}>
          <div>
            <div className="section-title">1 · luma pixels</div>
            <Grid8 values={story.spatial} colorFor={(v) => heat(v / 255)} fmt={(v) => v.toFixed(0)} />
          </div>
          <div>
            <div className="section-title">2 · DCT coefficients</div>
            <Grid8
              values={story.freq}
              colorFor={(v, i) => (i === 0 ? 'var(--panel-hi)' : heat(Math.min(1, Math.log10(1 + Math.abs(v)) / 2.6)))}
              fmt={(v) => (Math.abs(v) >= 1 ? v.toFixed(0) : '·')}
            />
          </div>
          <div>
            <div className="section-title">3 · quantisation table (luma × q{quality})</div>
            <Grid8 values={Array.from(lumaQ)} colorFor={(v) => heat(1 - Math.min(1, Math.log10(v) / 2.4))} fmt={(v) => v.toFixed(0)} />
          </div>
          <div>
            <div className="section-title">4 · quantised — {story.survivors}/64 survive</div>
            <Grid8
              values={story.quant}
              colorFor={(v) => (v === 0 ? 'var(--panel-2)' : heat(Math.min(1, 0.3 + Math.log10(1 + Math.abs(v)) / 2)))}
              fmt={(v) => (v === 0 ? '' : v.toFixed(0))}
            />
          </div>
        </div>
        <div className="row" style={{ marginTop: 14, gap: 16, alignItems: 'flex-start' }}>
          <div>
            <div className="section-title">5 · reconstructed (inverse DCT of the survivors)</div>
            <Grid8 values={story.recon} colorFor={(v) => heat(v / 255)} fmt={(v) => v.toFixed(0)} cell={40} />
          </div>
          <div className="prose" style={{ maxWidth: 320 }}>
            <p className="muted" style={{ fontSize: 13 }}>
              At quality {quality}, {64 - story.survivors} of this block's 64 coefficients were quantised to zero and
              cost <strong>nothing</strong> to send — the run-length + Huffman stage packs the trailing zeros into a single
              end-of-block symbol. The DC term (top-left) is coded as a difference from the previous block's DC, because
              neighbouring blocks share a brightness.
            </p>
          </div>
        </div>
      </Panel>

      <div className="grid grid-2">
        <Panel title="Where the bits went" note="Every bit in the entropy stream, split by component and by DC (block averages) vs AC (detail).">
          <HBarChart
            bars={[
              { label: 'DC (block averages)', value: dcBits / 8, color: 'var(--blue)' },
              { label: 'AC (detail)', value: acBits / 8, color: 'var(--teal)' },
              ...enc.components.map((c) => ({ label: `${c.name} · ${c.blocks} blocks`, value: (c.dcBits + c.acBits) / 8, color: 'var(--violet)' })),
            ]}
            unit=" B"
            valueFmt={(v) => v.toFixed(0)}
          />
          <div className="muted" style={{ fontSize: 12.5, marginTop: 8 }}>
            Header {fmtBytes(enc.headerBytes)} · entropy-coded scan {fmtBytes(enc.scanBytes)}. The header (tables +
            markers) is a fixed overhead that amortises away on larger images.
          </div>
        </Panel>

        <Panel title="JFIF anatomy" note="The marker segments of the file we emitted — a real baseline JPEG stream.">
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr>
                  <th>segment</th>
                  <th style={{ textAlign: 'right' }}>offset</th>
                  <th style={{ textAlign: 'right' }}>bytes</th>
                </tr>
              </thead>
              <tbody>
                {enc.markers.map((m, i) => (
                  <tr key={i}>
                    <td className="mono">{m.name}</td>
                    <td className="mono" style={{ textAlign: 'right' }}>{m.offset}</td>
                    <td className="mono" style={{ textAlign: 'right' }}>{m.length}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Panel>
      </div>

      <Panel title="Native interoperability — the showstopper" note="Lossy means the pixels legitimately differ, so the bar is a high-PSNR agreement rather than a bit-for-bit match. Two independent codecs converging on the same picture is the proof our JPEG is real.">
        <JpegInterop />
      </Panel>
    </div>
  )
}

// ---- live cross-check against the platform's own JPEG codec ----
function JpegInterop() {
  const [state, setState] = useState<'checking' | 'done' | 'unavailable'>(() => (jpegInteropAvailable() ? 'checking' : 'unavailable'))
  const [results, setResults] = useState<InteropResult[]>([])
  useEffect(() => {
    if (!jpegInteropAvailable()) return
    let live = true
    runJpegInterop().then((r) => {
      if (live) {
        setResults(r)
        setState('done')
      }
    })
    return () => {
      live = false
    }
  }, [])
  if (state === 'unavailable') {
    return <div className="muted" style={{ fontSize: 13 }}>The platform's canvas/ImageBitmap API isn't available here, so the live cross-check is skipped.</div>
  }
  const forward = results.filter((r) => r.name.startsWith('native decode'))
  const backward = results.filter((r) => r.name.startsWith('ours.decode'))
  const badge = (r: InteropResult) => (
    <div key={r.name} className="row" style={{ gap: 8, padding: '7px 0' }}>
      <span className={r.pass ? 'dot-ok' : 'dot-bad'} />
      <span style={{ fontSize: 13 }}>{r.detail}</span>
    </div>
  )
  return (
    <div className="grid grid-2">
      <div>
        <div className="section-title">Our encoder → the browser's decoder</div>
        {state === 'checking' ? <div className="muted">checking…</div> : forward.map(badge)}
      </div>
      <div>
        <div className="section-title">The browser's encoder → our decoder</div>
        {state === 'checking' ? <div className="muted">checking…</div> : backward.map(badge)}
      </div>
    </div>
  )
}
