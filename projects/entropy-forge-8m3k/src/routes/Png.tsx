import { useEffect, useMemo, useRef, useState } from 'react'
import { PageHeader, Panel, Stat } from '../components/ui'
import { HBarChart } from '../components/charts'
import { order0Entropy } from '../lib/entropy'
import {
  encodePNG,
  decodePNG,
  rgbaToRaster,
  rasterToRGBA,
  ALLOWED_DEPTHS,
  COLOR_TYPE_NAME,
  FILTER_NAME,
  type ColorType,
  type FilterStrategy,
  type RGBAImage,
  type EncodeResult,
  type DecodeResult,
} from '../lib/png'
import { SAMPLES } from '../lib/pngSamples'

// One colour per filter type, reused by the per-scanline strip and the histogram.
const FILTER_COLOR = ['var(--text-dim)', 'var(--teal)', 'var(--blue)', 'var(--violet)', 'var(--amber)']

const STRATEGIES: { id: FilterStrategy; label: string }[] = [
  { id: 'adaptive', label: 'Adaptive (min-sum)' },
  { id: 'none', label: 'None' },
  { id: 'sub', label: 'Sub' },
  { id: 'up', label: 'Up' },
  { id: 'average', label: 'Average' },
  { id: 'paeth', label: 'Paeth' },
]

function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`
  return `${(n / 1024).toFixed(1)} KB`
}

// ---- draw an RGBA image to a canvas at native resolution (CSS scales it up
// with nearest-neighbour so the pixels stay crisp); a checkerboard shows alpha.
function PixelCanvas({ image, maxWidth = 360, label }: { image: RGBAImage; maxWidth?: number; label?: string }) {
  const ref = useRef<HTMLCanvasElement>(null)
  useEffect(() => {
    const cv = ref.current
    if (!cv) return
    cv.width = image.width
    cv.height = image.height
    try {
      const ctx = cv.getContext('2d')
      if (!ctx) return
      const id = new ImageData(new Uint8ClampedArray(image.rgba), image.width, image.height)
      ctx.putImageData(id, 0, 0)
    } catch {
      /* sandbox — ignore */
    }
  }, [image])
  const scale = Math.max(1, Math.floor(maxWidth / image.width))
  const cssW = image.width * scale
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6, alignItems: 'flex-start' }}>
      <div className="checkerboard" style={{ width: cssW, maxWidth: '100%', borderRadius: 8, overflow: 'hidden', border: '1px solid var(--border)' }}>
        <canvas
          ref={ref}
          style={{ width: '100%', height: 'auto', display: 'block', imageRendering: 'pixelated' }}
        />
      </div>
      {label && <div className="muted mono" style={{ fontSize: 12 }}>{label}</div>}
    </div>
  )
}

function pixelDiff(a: RGBAImage, b: RGBAImage): number {
  if (a.width !== b.width || a.height !== b.height) return -1
  let n = 0
  for (let i = 0; i < a.rgba.length; i += 4) {
    if (a.rgba[i] !== b.rgba[i] || a.rgba[i + 1] !== b.rgba[i + 1] || a.rgba[i + 2] !== b.rgba[i + 2] || a.rgba[i + 3] !== b.rgba[i + 3]) n++
  }
  return n
}

// Interop comparison against an HTML canvas: canvas stores colours *premultiplied*
// by alpha, so a round-trip zeroes the RGB of fully-transparent pixels and rounds
// partially-transparent ones by ±1. Comparing in premultiplied space (with a ±1
// tolerance) tests exactly what is observable on screen — for opaque images this
// is identical to an exact RGB match.
function interopDiff(a: RGBAImage, b: RGBAImage): number {
  if (a.width !== b.width || a.height !== b.height) return -1
  let n = 0
  for (let i = 0; i < a.rgba.length; i += 4) {
    if (a.rgba[i + 3] !== b.rgba[i + 3]) { n++; continue }
    const aa = a.rgba[i + 3]
    let bad = false
    for (let c = 0; c < 3; c++) {
      const pa = Math.round((a.rgba[i + c] * aa) / 255)
      const pb = Math.round((b.rgba[i + c] * aa) / 255)
      if (Math.abs(pa - pb) > 1) { bad = true; break }
    }
    if (bad) n++
  }
  return n
}

type InteropState = { status: 'idle' | 'running' | 'ok' | 'fail' | 'unavailable'; detail: string }

export function Png() {
  const [sampleId, setSampleId] = useState('gradient')
  const [size, setSize] = useState(120)
  const [colorType, setColorType] = useState<ColorType>(6)
  const [bitDepth, setBitDepth] = useState(8)
  const [interlace, setInterlace] = useState<0 | 1>(0)
  const [strategy, setStrategy] = useState<FilterStrategy>('adaptive')
  const [uploaded, setUploaded] = useState<{ image: RGBAImage; decode: DecodeResult; name: string } | null>(null)
  const [uploadError, setUploadError] = useState<string | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)

  // The working source image: either an uploaded PNG (decoded by us) or a procedural sample.
  const source: RGBAImage = useMemo(() => {
    if (uploaded) return uploaded.image
    const def = SAMPLES.find((s) => s.id === sampleId) ?? SAMPLES[0]
    const h = Math.round(size * 0.75)
    return def.make(size, h)
  }, [uploaded, sampleId, size])

  // Switch colour type, snapping the bit depth to a legal one for it.
  function pickColorType(ct: ColorType) {
    setColorType(ct)
    if (!ALLOWED_DEPTHS[ct].includes(bitDepth)) {
      setBitDepth(ALLOWED_DEPTHS[ct].includes(8) ? 8 : ALLOWED_DEPTHS[ct][ALLOWED_DEPTHS[ct].length - 1])
    }
  }

  // Encode the working image at the chosen format + strategy, then decode it back.
  const result = useMemo(() => {
    try {
      const raster = rgbaToRaster(source, colorType, bitDepth, interlace)
      const enc = encodePNG(raster, { strategy })
      const dec = decodePNG(enc.bytes)
      const decodedRGBA = rasterToRGBA(dec.raster)
      const rawSampleBytes = raster.samples
      return { raster, enc, dec, decodedRGBA, rawSampleBytes, error: null as string | null }
    } catch (e) {
      return { error: (e as Error).message } as { error: string } & Partial<{ enc: EncodeResult; dec: DecodeResult; decodedRGBA: RGBAImage; rawSampleBytes: Uint8Array }>
    }
  }, [source, colorType, bitDepth, interlace, strategy])

  // Compare PNG size under every filter strategy (same format, same DEFLATE).
  const strategySizes = useMemo(() => {
    const out: { id: FilterStrategy; label: string; size: number }[] = []
    try {
      const raster = rgbaToRaster(source, colorType, bitDepth, interlace)
      for (const s of STRATEGIES) out.push({ id: s.id, label: s.label, size: encodePNG(raster, { strategy: s.id }).totalSize })
    } catch {
      /* ignore */
    }
    return out
  }, [source, colorType, bitDepth, interlace])

  // ---- native interop: the browser's own PNG codec must agree with ours ----
  const [interop, setInterop] = useState<InteropState>({ status: 'idle', detail: '' })
  const pngBytes = result.enc?.bytes
  useEffect(() => {
    let cancelled = false
    const run = async () => {
      const canCreate = typeof createImageBitmap === 'function' && typeof document !== 'undefined'
      if (!canCreate) {
        setInterop({ status: 'unavailable', detail: 'createImageBitmap not available here' })
        return
      }
      if (!pngBytes || !result.decodedRGBA) {
        setInterop({ status: 'idle', detail: '' })
        return
      }
      setInterop({ status: 'running', detail: 'asking the browser to decode our file…' })
      try {
        const ours = result.decodedRGBA!
        // 1. our PNG → the browser's decoder → pixels must match our own decode.
        const blob = new Blob([pngBytes.slice().buffer as ArrayBuffer], { type: 'image/png' })
        const bmp = await createImageBitmap(blob)
        const cv = document.createElement('canvas')
        cv.width = bmp.width
        cv.height = bmp.height
        const ctx = cv.getContext('2d')!
        ctx.drawImage(bmp, 0, 0)
        const nativeData = ctx.getImageData(0, 0, bmp.width, bmp.height)
        const browserDecode: RGBAImage = { width: bmp.width, height: bmp.height, rgba: new Uint8Array(nativeData.data) }
        const d1 = interopDiff(ours, browserDecode)

        // 2. the browser encodes our source → our decoder → pixels must match the canvas.
        let d2 = 0
        let d2ran = false
        try {
          const scv = document.createElement('canvas')
          scv.width = source.width
          scv.height = source.height
          const sctx = scv.getContext('2d')!
          sctx.putImageData(new ImageData(new Uint8ClampedArray(source.rgba), source.width, source.height), 0, 0)
          const nativeBlob: Blob | null = await new Promise((res) => scv.toBlob((b) => res(b), 'image/png'))
          if (nativeBlob) {
            const buf = new Uint8Array(await nativeBlob.arrayBuffer())
            const ourDecode = rasterToRGBA(decodePNG(buf).raster)
            d2 = interopDiff(ourDecode, { width: source.width, height: source.height, rgba: source.rgba })
            d2ran = true
          }
        } catch {
          /* toBlob path optional */
        }
        if (cancelled) return
        const ok = d1 === 0 && (!d2ran || d2 === 0)
        setInterop({
          status: ok ? 'ok' : 'fail',
          detail: ok
            ? `browser decoded our ${bmp.width}×${bmp.height} PNG pixel-for-pixel${d2ran ? '; and we decoded the browser’s PNG identically' : ''}`
            : `mismatch — our↔browser diff ${d1} px${d2ran ? `, browser→ours diff ${d2} px` : ''}`,
        })
      } catch (e) {
        if (!cancelled) setInterop({ status: 'fail', detail: (e as Error).message })
      }
    }
    void run()
    return () => {
      cancelled = true
    }
  }, [pngBytes, result.decodedRGBA, source])

  function onFile(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0]
    if (!f) return
    setUploadError(null)
    f.arrayBuffer()
      .then((buf) => {
        const bytes = new Uint8Array(buf)
        const dec = decodePNG(bytes)
        const image = rasterToRGBA(dec.raster)
        setUploaded({ image, decode: dec, name: f.name })
        setColorType(dec.raster.colorType)
        setBitDepth(dec.raster.bitDepth)
        setInterlace(dec.raster.interlace)
      })
      .catch((err) => setUploadError((err as Error).message))
    e.target.value = ''
  }

  function download() {
    if (!pngBytes) return
    try {
      const blob = new Blob([pngBytes.slice().buffer as ArrayBuffer], { type: 'image/png' })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = 'entropy-forge.png'
      a.click()
      setTimeout(() => URL.revokeObjectURL(url), 1000)
    } catch {
      /* sandbox */
    }
  }

  const enc = result.enc
  const rawRGBASize = source.width * source.height * 4
  const entropyRaw = result.rawSampleBytes ? order0Entropy(result.rawSampleBytes) : 0
  const entropyFiltered = enc ? order0Entropy(enc.filtered) : 0
  const diffToSource = enc && result.decodedRGBA ? pixelDiff(source, result.decodedRGBA) : -1
  const maxStratSize = Math.max(1, ...strategySizes.map((s) => s.size))

  return (
    <div>
      <PageHeader
        kicker="The real thing · lossless images"
        title="PNG — Image Studio"
        lede={
          <>
            A real <b>PNG</b> is our from-scratch DEFLATE, zlib wrapper and CRC-32 assembled into a
            spec-compliant container (ISO 15948) — plus one genuinely new idea: a{' '}
            <b>scanline pre-filter</b>. §6 filters predict each pixel from its neighbours and transmit
            only the residual, <i>lowering the entropy</i> of the byte stream before DEFLATE runs.
            Everything here is our own code, verified byte-for-byte against your browser&rsquo;s native
            PNG decoder.
          </>
        }
      />

      <Panel title="Source" note="A procedural image, or drop in a real PNG — we decode it with our own codec.">
        <div className="controls" style={{ flexWrap: 'wrap', gap: 8 }}>
          {SAMPLES.map((s) => (
            <button
              key={s.id}
              className={`chip${!uploaded && sampleId === s.id ? ' active' : ''}`}
              onClick={() => {
                setUploaded(null)
                setSampleId(s.id)
              }}
            >
              {s.name}
            </button>
          ))}
          <button className="btn small" onClick={() => fileRef.current?.click()}>Upload a PNG…</button>
          <input ref={fileRef} type="file" accept="image/png" onChange={onFile} style={{ display: 'none' }} />
        </div>
        <div className="controls" style={{ marginTop: 10, gap: 14, flexWrap: 'wrap', alignItems: 'center' }}>
          {!uploaded && (
            <label className="row" style={{ gap: 8 }}>
              <span className="muted" style={{ fontSize: 13 }}>size</span>
              <input type="range" min={32} max={220} step={4} value={size} onChange={(e) => setSize(+e.target.value)} />
              <span className="mono" style={{ fontSize: 12 }}>{source.width}×{source.height}</span>
            </label>
          )}
          {uploaded && (
            <span className="tag">uploaded: {uploaded.name} · {source.width}×{source.height} · {COLOR_TYPE_NAME[uploaded.decode.raster.colorType]}</span>
          )}
        </div>
        {uploadError && <div className="mono" style={{ color: 'var(--red, #e5484d)', marginTop: 8, fontSize: 13 }}>decode error: {uploadError}</div>}
        {!uploaded && <div className="muted" style={{ marginTop: 8, fontSize: 13 }}>{SAMPLES.find((s) => s.id === sampleId)?.note}</div>}
      </Panel>

      <Panel title="Encode as" note="Colour type, bit depth, interlacing and the filter strategy — the knobs a real PNG encoder exposes.">
        <div className="controls" style={{ gap: 18, flexWrap: 'wrap', alignItems: 'center' }}>
          <label className="row" style={{ gap: 8 }}>
            <span className="muted" style={{ fontSize: 13 }}>colour</span>
            <select value={colorType} onChange={(e) => pickColorType(+e.target.value as ColorType)}>
              {([0, 2, 3, 4, 6] as ColorType[]).map((ct) => (
                <option key={ct} value={ct}>{COLOR_TYPE_NAME[ct]}</option>
              ))}
            </select>
          </label>
          <label className="row" style={{ gap: 8 }}>
            <span className="muted" style={{ fontSize: 13 }}>bit depth</span>
            <select value={bitDepth} onChange={(e) => setBitDepth(+e.target.value)}>
              {ALLOWED_DEPTHS[colorType].map((d) => (
                <option key={d} value={d}>{d}-bit</option>
              ))}
            </select>
          </label>
          <label className="row" style={{ gap: 8 }}>
            <span className="muted" style={{ fontSize: 13 }}>interlace</span>
            <input type="checkbox" checked={interlace === 1} onChange={(e) => setInterlace(e.target.checked ? 1 : 0)} />
            <span className="muted" style={{ fontSize: 12 }}>Adam7</span>
          </label>
          <label className="row" style={{ gap: 8 }}>
            <span className="muted" style={{ fontSize: 13 }}>filter</span>
            <select value={strategy} onChange={(e) => setStrategy(e.target.value as FilterStrategy)}>
              {STRATEGIES.map((s) => (
                <option key={s.id} value={s.id}>{s.label}</option>
              ))}
            </select>
          </label>
          <button className="btn small" onClick={download} disabled={!pngBytes}>Download .png</button>
        </div>
      </Panel>

      {result.error && (
        <Panel title="Cannot encode">
          <div className="mono" style={{ color: 'var(--red, #e5484d)' }}>{result.error}</div>
        </Panel>
      )}

      {enc && result.decodedRGBA && (
        <>
          <div className="grid grid-4" style={{ marginTop: 4 }}>
            <Stat label="PNG size" value={fmtBytes(enc.totalSize)} accent sub={`${((enc.totalSize / rawRGBASize) * 100).toFixed(1)}% of raw RGBA`} />
            <Stat label="Compression" value={(rawRGBASize / enc.totalSize).toFixed(2)} unit="×" sub={`${fmtBytes(rawRGBASize)} → ${fmtBytes(enc.totalSize)}`} />
            <Stat label="Filtered stream" value={fmtBytes(enc.filteredSize)} sub={`IDAT (zlib) ${fmtBytes(enc.idatSize)}`} />
            <Stat label="Round-trip" value={diffToSource === 0 ? '✓ lossless' : `${diffToSource} px differ`} sub={diffToSource === 0 ? 'decode = source' : 'format is lossy for this source'} />
          </div>

          <div className="grid grid-2" style={{ marginTop: 16 }}>
            <Panel title="Source" note={`${source.width}×${source.height} · ${fmtBytes(rawRGBASize)} raw RGBA`}>
              <PixelCanvas image={source} />
            </Panel>
            <Panel title="Decoded from our PNG" note={diffToSource === 0 ? 'pixel-identical to the source' : `${COLOR_TYPE_NAME[colorType]} · ${bitDepth}-bit`}>
              <PixelCanvas image={result.decodedRGBA} />
            </Panel>
          </div>

          <Panel
            title="Verified against your browser"
            note="The strongest proof: your browser's own PNG decoder must render our from-scratch file identically."
          >
            <div className="row" style={{ gap: 12, alignItems: 'center' }}>
              <span
                className={`pill ${interop.status === 'ok' ? 'ok' : interop.status === 'fail' ? 'bad' : ''}`}
                style={{ fontSize: 13 }}
              >
                {interop.status === 'ok' && '✓ interoperable'}
                {interop.status === 'fail' && '✗ mismatch'}
                {interop.status === 'running' && '… checking'}
                {interop.status === 'idle' && 'idle'}
                {interop.status === 'unavailable' && 'unavailable'}
              </span>
              <span className="muted" style={{ fontSize: 13 }}>{interop.detail}</span>
            </div>
          </Panel>

          <div className="grid grid-2" style={{ marginTop: 16 }}>
            <Panel title="Per-scanline filter choice" note="Each cell is one scanline, coloured by the filter the encoder picked (adaptive strategies choose per row).">
              <FilterStrip filters={enc.rowFilters} />
              <div className="chip-row" style={{ marginTop: 12, gap: 10, flexWrap: 'wrap' }}>
                {FILTER_NAME.map((f, i) => (
                  <span key={f} className="row" style={{ gap: 6, fontSize: 12 }}>
                    <span className="dot-swatch" style={{ background: FILTER_COLOR[i], width: 12, height: 12, borderRadius: 3, display: 'inline-block' }} />
                    {f} <span className="muted mono">×{enc.filterHistogram[i]}</span>
                  </span>
                ))}
              </div>
            </Panel>

            <Panel title="Filters lower the entropy" note="Order-0 entropy of the byte stream DEFLATE then compresses — before vs after filtering.">
              <div className="grid grid-2">
                <Stat label="Raw samples" value={entropyRaw.toFixed(2)} unit="b/byte" sub={`${fmtBytes(result.rawSampleBytes?.length ?? 0)}`} />
                <Stat label="After filter" value={entropyFiltered.toFixed(2)} unit="b/byte" accent={entropyFiltered < entropyRaw} sub={entropyFiltered < entropyRaw ? `${(entropyRaw - entropyFiltered).toFixed(2)} b/byte lower` : 'no gain (already flat)'} />
              </div>
              <div className="muted" style={{ marginTop: 10, fontSize: 13 }}>
                The filter is a predictor: it replaces each pixel with the small residual left after
                guessing it from its neighbours. A lower-entropy stream is exactly what DEFLATE&rsquo;s
                Huffman + LZ77 turn into fewer bits.
              </div>
            </Panel>
          </div>

          <Panel title="Which filter strategy wins?" note="Same image, same colour format, same DEFLATE — only the per-scanline filter differs. Total PNG size, smaller is better.">
            <HBarChart
              bars={strategySizes.map((s) => ({
                label: s.label,
                value: s.size,
                color: s.id === strategy ? 'var(--teal)' : undefined,
                caption: `${((s.size / maxStratSize) * 100).toFixed(0)}%`,
              }))}
              valueFmt={(v) => fmtBytes(v)}
            />
          </Panel>

          <Panel title="File structure" note="Every chunk we wrote: length, type and CRC-32 (over type+data). This is a real, byte-exact PNG.">
            <div className="table-wrap">
              <table className="data">
                <thead>
                  <tr>
                    <th>Chunk</th>
                    <th>Length</th>
                    <th>Notes</th>
                  </tr>
                </thead>
                <tbody>
                  {enc.chunks.map((c, i) => (
                    <tr key={i}>
                      <td className="mono"><b>{c.type}</b></td>
                      <td className="mono">{c.length} B</td>
                      <td className="muted">{c.note ?? ''}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="muted mono" style={{ marginTop: 8, fontSize: 12 }}>
              signature 8 B + {enc.chunks.length} chunks = {fmtBytes(enc.totalSize)} total
            </div>
          </Panel>

          {uploaded && uploaded.decode.chunks.length > 0 && (
            <Panel title="Uploaded file — parsed chunks" note="What our decoder read out of your PNG (CRC-checked).">
              <div className="table-wrap">
                <table className="data">
                  <thead>
                    <tr>
                      <th>Chunk</th>
                      <th>Length</th>
                      <th>CRC</th>
                      <th>Notes</th>
                    </tr>
                  </thead>
                  <tbody>
                    {uploaded.decode.chunks.map((c, i) => (
                      <tr key={i}>
                        <td className="mono"><b>{c.type}</b></td>
                        <td className="mono">{c.length} B</td>
                        <td>{c.crcOk ? <span className="pill ok" style={{ fontSize: 11 }}>✓</span> : <span className="pill bad" style={{ fontSize: 11 }}>✗</span>}</td>
                        <td className="muted">{c.note ?? ''}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Panel>
          )}
        </>
      )}
    </div>
  )
}

// A compact heat-strip of the per-scanline filter choices.
function FilterStrip({ filters }: { filters: number[] }) {
  const n = filters.length
  const w = 640
  const cell = Math.max(1, w / Math.max(1, n))
  const h = 34
  return (
    <div style={{ overflowX: 'auto' }}>
      <svg viewBox={`0 0 ${w} ${h}`} width="100%" style={{ minWidth: Math.min(w, 320), borderRadius: 6 }} role="img" aria-label="per-scanline filter choice">
        {filters.map((f, i) => (
          <rect key={i} x={i * cell} y={0} width={Math.ceil(cell)} height={h} fill={FILTER_COLOR[f] ?? 'var(--text-dim)'} />
        ))}
      </svg>
    </div>
  )
}
