import { useEffect, useMemo, useState } from 'react'
import { CanvasCard } from '../components/CanvasCard'
import { Panel, Field, Slider, Select, Segmented, Readout, Button, Toggle } from '../components/Controls'
import { useDprCanvas, prepareContext } from '../hooks/useDprCanvas'
import { fillPlotBg, axisLabel } from '../lib/draw'
import type { Rect } from '../lib/draw'
import { readHashParams, shareLink, readNum, readStr, readBool } from '../lib/urlState'
import {
  buildCode,
  encode,
  decodeSC,
  decodeSCL,
  transformStages,
  channelCapacities,
  biAwgnLimitDb,
  waterfall,
  uncodedBer,
  crcById,
  CRCS,
  mulberry32,
  type Construction,
  type PolarCode,
  type WaterfallPoint,
} from '../lib/polar'

const TEAL = '#5eead4'
const BLUE = '#38bdf8'
const ROSE = '#fb7185'
const AMBER = '#fbbf24'
const INK = 'rgba(226,232,240,0.85)'
const DIM = 'rgba(148,163,204,0.45)'

const CONSTRUCTIONS: { id: Construction; label: string }[] = [
  { id: 'ga', label: 'Gaussian approx (AWGN)' },
  { id: 'bhattacharyya', label: 'Bhattacharyya (BEC)' },
]

const CRC_OPTIONS = CRCS.map((c) => ({ id: c.id, label: c.label }))

// A random payload deterministically derived from a code + seed.
function randomPayload(code: PolarCode, seed: number): Uint8Array {
  const rng = mulberry32(seed * 2654435761)
  const m = new Uint8Array(code.msgLen)
  for (let i = 0; i < code.msgLen; i++) m[i] = rng() < 0.5 ? 0 : 1
  return m
}

// ===========================================================================
// Tab 1 — Polarization: the synthetic channels split toward 0 and 1
// ===========================================================================

function PolarizeTab() {
  const sp = useMemo(() => readHashParams(), [])
  const [n, setN] = useState(() => readNum(sp, 'pn', 8))
  const [rate, setRate] = useState(() => readNum(sp, 'prate', 0.5))
  const [construction, setConstruction] = useState<Construction>(() =>
    readStr(sp, 'pcon', 'ga', ['ga', 'bhattacharyya'] as const),
  )
  const [designSnr, setDesignSnr] = useState(() => readNum(sp, 'pdes', 2))
  const [copied, setCopied] = useState(false)

  const N = 1 << n
  const K = Math.max(1, Math.min(N - 1, Math.round(rate * N)))
  const code = useMemo(
    () => buildCode(N, K, construction, designSnr, crcById('none')),
    [N, K, construction, designSnr],
  )
  const caps = useMemo(() => channelCapacities(code.rel), [code])
  const sortedCaps = useMemo(() => Float64Array.from(caps).sort((a, b) => b - a), [caps])

  const sumCap = useMemo(() => caps.reduce((s, c) => s + c, 0), [caps])
  const polarized = useMemo(() => {
    let extreme = 0
    for (const c of caps) if (c < 0.05 || c > 0.95) extreme++
    return extreme / caps.length
  }, [caps])
  const shannon = biAwgnLimitDb(code.rate)

  // Canvas 1 — the polarization staircase (capacity of each channel, sorted).
  const { ref: stairRef, size: stairSize } = useDprCanvas()
  useEffect(() => {
    const ctx = prepareContext(stairRef.current, stairSize)
    if (!ctx) return
    const { width: w, height: h } = stairSize
    fillPlotBg(ctx, { x: 0, y: 0, w, h })
    const pad = { l: 42, r: 12, t: 14, b: 26 }
    const r: Rect = { x: pad.l, y: pad.t, w: w - pad.l - pad.r, h: h - pad.t - pad.b }
    ctx.strokeStyle = 'rgba(120,140,220,0.12)'
    ctx.lineWidth = 1
    for (let g = 0; g <= 4; g++) {
      const y = r.y + (g / 4) * r.h
      ctx.beginPath()
      ctx.moveTo(r.x, y)
      ctx.lineTo(r.x + r.w, y)
      ctx.stroke()
      axisLabel(ctx, (1 - g / 4).toFixed(2), r.x - 6, y + 3, 'right')
    }
    // bars, sorted descending; the first K are "information" channels.
    const bw = r.w / N
    for (let i = 0; i < N; i++) {
      const c = sortedCaps[i]
      const x = r.x + i * bw
      const bh = c * r.h
      ctx.fillStyle = i < K ? 'rgba(94,234,212,0.55)' : 'rgba(148,163,204,0.28)'
      ctx.fillRect(x, r.y + r.h - bh, Math.max(1, bw - 0.5), bh)
    }
    // K cutoff line
    const cx = r.x + K * bw
    ctx.strokeStyle = AMBER
    ctx.setLineDash([4, 4])
    ctx.lineWidth = 1.4
    ctx.beginPath()
    ctx.moveTo(cx, r.y)
    ctx.lineTo(cx, r.y + r.h)
    ctx.stroke()
    ctx.setLineDash([])
    axisLabel(ctx, `K=${K} info`, cx - 4, r.y + 12, 'right')
    axisLabel(ctx, 'frozen →', cx + 4, r.y + 12, 'left')
    axisLabel(ctx, 'capacity', r.x, r.y - 2, 'left')
    axisLabel(ctx, 'channels sorted by reliability →', r.x + r.w, r.y + r.h + 15, 'right')
  }, [stairRef, stairSize, sortedCaps, N, K])

  // Canvas 2 — the natural-order map: every synthetic channel in transmit order,
  // colored by capacity, frozen vs information marked. Reveals the fractal set.
  const { ref: mapRef, size: mapSize } = useDprCanvas()
  useEffect(() => {
    const ctx = prepareContext(mapRef.current, mapSize)
    if (!ctx) return
    const { width: w, height: h } = mapSize
    fillPlotBg(ctx, { x: 0, y: 0, w, h })
    const pad = { l: 10, r: 10, t: 16, b: 18 }
    const cols = Math.min(N, 64)
    const rows = Math.ceil(N / cols)
    const cw = (w - pad.l - pad.r) / cols
    const chh = (h - pad.t - pad.b) / rows
    for (let i = 0; i < N; i++) {
      const col = i % cols
      const row = Math.floor(i / cols)
      const x = pad.l + col * cw
      const y = pad.t + row * chh
      const c = caps[i]
      const info = code.frozen[i] === 0
      // teal ramp for capacity, dim if frozen
      const g = Math.round(60 + c * 180)
      ctx.fillStyle = info
        ? `rgba(94,${g + 20},212,0.9)`
        : `rgba(${70 + Math.round(c * 60)},${80 + Math.round(c * 40)},120,0.5)`
      ctx.fillRect(x + 0.5, y + 0.5, cw - 1, chh - 1)
      if (info) {
        ctx.strokeStyle = 'rgba(94,234,212,0.9)'
        ctx.lineWidth = 1
        ctx.strokeRect(x + 0.75, y + 0.75, cw - 1.5, chh - 1.5)
      }
    }
    axisLabel(ctx, 'transmit order (row-major) — bright = information channel', pad.l, 12, 'left')
  }, [mapRef, mapSize, caps, code, N])

  const onShare = () => {
    shareLink('polar', {
      tab: 'polarize',
      pn: n,
      prate: rate,
      pcon: construction,
      pdes: designSnr,
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
        <Panel title="Block & construction">
          <Field label="Block length N" value={`2^${n} = ${N}`}>
            <Slider min={3} max={10} step={1} value={n} onChange={setN} />
          </Field>
          <Field label="Code rate K/N" value={`${rate.toFixed(2)} → K=${K}`}>
            <Slider min={0.1} max={0.9} step={0.05} value={rate} onChange={setRate} />
          </Field>
          <Field label="Construction">
            <Select value={construction} options={CONSTRUCTIONS} onChange={setConstruction} />
          </Field>
          <Field label="Design Eb/N0" value={`${designSnr.toFixed(1)} dB`}>
            <Slider min={-2} max={6} step={0.5} value={designSnr} onChange={setDesignSnr} />
          </Field>
          <Button onClick={onShare} variant="ghost">
            {copied ? 'link copied ✓' : 'share this view'}
          </Button>
        </Panel>
        <Panel title="This code">
          <Readout
            items={[
              { label: 'N', value: `${N}` },
              { label: 'K', value: `${K}` },
              { label: 'rate', value: code.rate.toFixed(3) },
              { label: 'polarized', value: `${(polarized * 100).toFixed(0)}%` },
              { label: 'Σ capacity', value: sumCap.toFixed(1) },
              { label: 'Shannon', value: `${shannon.toFixed(2)} dB` },
            ]}
          />
        </Panel>
      </div>
      <div className="mode-main">
        <p className="mode-intro">
          Arıkan's insight: recursively combine and split N copies of a channel and the{' '}
          <em>synthetic</em> bit-channels polarize — each races toward a perfect (capacity 1) or
          useless (capacity 0) channel. Send information only on the good ones and freeze the rest to
          0. The total capacity is conserved (Σ capacity ≈ N·C), so the fraction of good channels →
          the channel capacity: <strong>this is how you reach Shannon with an explicit code.</strong>
        </p>
        <CanvasCard
          title="Polarization staircase — synthetic-channel capacity, sorted"
          note={`${polarized > 0 ? (polarized * 100).toFixed(0) : 0}% of channels are near 0 or 1`}
          height={300}
        >
          <canvas ref={stairRef} />
        </CanvasCard>
        <CanvasCard
          title="The frozen set — every channel in transmit order"
          note="bright cells carry information; the pattern is self-similar"
          height={220}
        >
          <canvas ref={mapRef} />
        </CanvasCard>
      </div>
    </div>
  )
}

// ===========================================================================
// Tab 2 — Encoder: the F^{⊗n} butterfly network
// ===========================================================================

function EncoderTab() {
  const sp = useMemo(() => readHashParams(), [])
  const [n, setN] = useState(() => readNum(sp, 'en', 4))
  const [rate, setRate] = useState(() => readNum(sp, 'erate', 0.5))
  const [construction, setConstruction] = useState<Construction>(() =>
    readStr(sp, 'econ', 'ga', ['ga', 'bhattacharyya'] as const),
  )
  const [designSnr, setDesignSnr] = useState(() => readNum(sp, 'edes', 2))
  const [seed, setSeed] = useState(1)

  const N = 1 << n
  const K = Math.max(1, Math.min(N - 1, Math.round(rate * N)))
  const code = useMemo(
    () => buildCode(N, K, construction, designSnr, crcById('none')),
    [N, K, construction, designSnr],
  )
  const enc = useMemo(() => encode(randomPayload(code, seed), code), [code, seed])
  const stages = useMemo(() => transformStages(enc.u), [enc])

  const { ref: graphRef, size: graphSize } = useDprCanvas()
  useEffect(() => {
    const ctx = prepareContext(graphRef.current, graphSize)
    if (!ctx) return
    const { width: w, height: h } = graphSize
    fillPlotBg(ctx, { x: 0, y: 0, w, h })
    const padL = 66
    const padR = 66
    const padT = 22
    const padB = 14
    const rowY = (i: number) => padT + (i / Math.max(1, N - 1)) * (h - padT - padB)
    const stageX = (s: number) => padL + (s / n) * (w - padL - padR)

    // edges: for each stage k (0..n-1), butterfly with len = 2^k
    for (let k = 0; k < n; k++) {
      const len = 1 << k
      const x0 = stageX(k)
      const x1 = stageX(k + 1)
      for (let i = 0; i < N; i += len << 1) {
        for (let j = 0; j < len; j++) {
          const top = i + j
          const bot = i + j + len
          // straight carry lines
          ctx.strokeStyle = 'rgba(120,140,220,0.22)'
          ctx.lineWidth = 1
          ctx.beginPath()
          ctx.moveTo(x0, rowY(top))
          ctx.lineTo(x1, rowY(top))
          ctx.stroke()
          ctx.beginPath()
          ctx.moveTo(x0, rowY(bot))
          ctx.lineTo(x1, rowY(bot))
          ctx.stroke()
          // the XOR cross: bottom feeds the top (top ^= bottom)
          ctx.strokeStyle = 'rgba(167,139,250,0.5)'
          ctx.beginPath()
          ctx.moveTo(x0, rowY(bot))
          ctx.lineTo(x1, rowY(top))
          ctx.stroke()
          // ⊕ marker at the top node output
          const mx = x1
          const my = rowY(top)
          ctx.fillStyle = 'rgba(167,139,250,0.85)'
          ctx.beginPath()
          ctx.arc(mx, my, 2.4, 0, Math.PI * 2)
          ctx.fill()
        }
      }
    }

    // nodes: value dots at each stage
    const drawCol = (s: number, vals: Uint8Array, frozenMark: boolean) => {
      for (let i = 0; i < N; i++) {
        const x = stageX(s)
        const y = rowY(i)
        const one = vals[i] === 1
        ctx.fillStyle = one ? BLUE : 'rgba(30,41,64,0.95)'
        ctx.strokeStyle = one ? BLUE : 'rgba(120,140,220,0.5)'
        ctx.lineWidth = 1.2
        ctx.beginPath()
        ctx.arc(x, y, 4.6, 0, Math.PI * 2)
        ctx.fill()
        ctx.stroke()
        if (frozenMark && code.frozen[i]) {
          ctx.strokeStyle = 'rgba(148,163,204,0.7)'
          ctx.lineWidth = 1
          ctx.beginPath()
          ctx.arc(x, y, 7.5, 0, Math.PI * 2)
          ctx.stroke()
        }
      }
    }
    for (let s = 0; s <= n; s++) drawCol(s, stages[s], s === 0)

    // labels
    ctx.fillStyle = INK
    ctx.font = '11px JetBrains Mono, ui-monospace, monospace'
    ctx.textAlign = 'right'
    for (let i = 0; i < N && N <= 32; i++) {
      const info = code.frozen[i] === 0
      ctx.fillStyle = info ? TEAL : DIM
      ctx.fillText(`u${i}${info ? '' : '·0'}`, padL - 10, rowY(i) + 3)
    }
    ctx.textAlign = 'left'
    for (let i = 0; i < N && N <= 32; i++) {
      ctx.fillStyle = INK
      ctx.fillText(`x${i}`, w - padR + 10, rowY(i) + 3)
    }
    ctx.textAlign = 'center'
    axisLabel(ctx, 'u (input)', padL, 12, 'center')
    axisLabel(ctx, 'x (codeword)', w - padR, 12, 'center')
  }, [graphRef, graphSize, stages, code, N, n])

  return (
    <div className="mode">
      <div className="mode-side">
        <Panel title="Code">
          <Field label="Block length N" value={`2^${n} = ${N}`}>
            <Slider min={2} max={5} step={1} value={n} onChange={setN} />
          </Field>
          <Field label="Code rate K/N" value={`${rate.toFixed(2)} → K=${K}`}>
            <Slider min={0.1} max={0.9} step={0.05} value={rate} onChange={setRate} />
          </Field>
          <Field label="Construction">
            <Select value={construction} options={CONSTRUCTIONS} onChange={setConstruction} />
          </Field>
          <Field label="Design Eb/N0" value={`${designSnr.toFixed(1)} dB`}>
            <Slider min={-2} max={6} step={0.5} value={designSnr} onChange={setDesignSnr} />
          </Field>
          <Button onClick={() => setSeed((s) => s + 1)} variant="primary">
            reroll message
          </Button>
        </Panel>
        <Panel title="This encode">
          <Readout
            items={[
              { label: 'info bits', value: `${code.K}` },
              { label: 'weight(x)', value: `${enc.x.reduce((a, b) => a + b, 0)}` },
              { label: 'stages', value: `${n}` },
            ]}
          />
        </Panel>
      </div>
      <div className="mode-main">
        <p className="mode-intro">
          Encoding is nothing but XOR. The generator is F^{'⊗'}
          <sup>n</sup> with F = [[1,0],[1,1]] — a butterfly network of {n} stages. Frozen inputs (ringed)
          are held at 0; the information bits (teal) ride the reliable channels. Every dot is a bit;
          purple crossings are XORs. The transform is <strong>its own inverse over GF(2)</strong>, so
          the very same network run backwards recovers u from a clean x.
        </p>
        <CanvasCard title={`Polar encoder F^⊗${n} — u·F^⊗${n} = x`} height={420}>
          <canvas ref={graphRef} />
        </CanvasCard>
      </div>
    </div>
  )
}

// ===========================================================================
// Tab 3 — Decode: SC vs SCL vs CA-SCL on one noisy word
// ===========================================================================

function DecodeTab() {
  const sp = useMemo(() => readHashParams(), [])
  const [n, setN] = useState(() => readNum(sp, 'dn', 7))
  const [rate, setRate] = useState(() => readNum(sp, 'drate', 0.5))
  const [construction, setConstruction] = useState<Construction>(() =>
    readStr(sp, 'dcon', 'ga', ['ga', 'bhattacharyya'] as const),
  )
  const [crc, setCrc] = useState(() => readStr(sp, 'dcrc', 'crc8', CRCS.map((c) => c.id)))
  const [listSize, setListSize] = useState(() => readNum(sp, 'dL', 8))
  const [snr, setSnr] = useState(() => readNum(sp, 'dsnr', 1.5))
  const [exact, setExact] = useState(() => readBool(sp, 'dex', true))
  const [seed, setSeed] = useState(1)

  const N = 1 << n
  const crcSpec = crcById(crc)
  // K must exceed the CRC width (so there is a real payload) and stay below N.
  const K = Math.max(crcSpec.width + 2, Math.min(N - 1, Math.round(rate * N)))
  const code = useMemo(
    () => buildCode(N, K, construction, designSafe(snr), crcSpec),
    [N, K, construction, snr, crcSpec],
  )

  // build one received word and decode it three ways
  const run = useMemo(() => {
    const msg = randomPayload(code, seed)
    const { u, x } = encode(msg, code)
    const rng = mulberry32(seed * 40503 + 12345)
    const sigma = ebn0ToSigmaLocal(snr, code.rate)
    const llr = new Float64Array(N)
    const rx = new Float64Array(N)
    const flips = new Uint8Array(N)
    const inv = 1 / (sigma * sigma)
    for (let i = 0; i < N; i++) {
      const s = x[i] === 0 ? 1 : -1
      const g = gaussLocal(rng)
      const y = s + sigma * g
      rx[i] = y
      llr[i] = 2 * y * inv
      const hard = y >= 0 ? 0 : 1
      flips[i] = hard !== x[i] ? 1 : 0
    }
    const sc = decodeSC(llr, code, exact)
    const scl = decodeSCL(llr, code, listSize, exact)
    // plain SCL (ignore CRC in the pick) for contrast
    const bestByMetric = scl.bestByMetric
    const plainInfo = new Uint8Array(code.K)
    for (let i = 0; i < code.infoPos.length; i++) plainInfo[i] = bestByMetric[code.infoPos[i]]
    const berr = (info: Uint8Array) => {
      let e = 0
      for (let i = 0; i < code.msgLen; i++) if (info[i] !== msg[i]) e++
      return e
    }
    return {
      msg,
      u,
      x,
      rx,
      llr,
      flips,
      channelFlips: flips.reduce((a, b) => a + b, 0),
      sc: { info: sc.info, err: berr(sc.info) },
      sclPlain: { info: plainInfo, err: berr(plainInfo) },
      scl: { info: scl.info, err: berr(scl.info), ok: scl.ok, survivors: scl.survivors },
    }
  }, [code, seed, snr, exact, listSize, N])

  // channel strip: received soft values + flipped positions
  const { ref: stripRef, size: stripSize } = useDprCanvas()
  useEffect(() => {
    const ctx = prepareContext(stripRef.current, stripSize)
    if (!ctx) return
    const { width: w, height: h } = stripSize
    fillPlotBg(ctx, { x: 0, y: 0, w, h })
    const pad = { l: 10, r: 10, t: 16, b: 16 }
    const cols = Math.min(N, 64)
    const rows = Math.ceil(N / cols)
    const cw = (w - pad.l - pad.r) / cols
    const chh = (h - pad.t - pad.b) / rows
    let maxAbs = 1e-6
    for (let i = 0; i < N; i++) maxAbs = Math.max(maxAbs, Math.abs(run.rx[i]))
    for (let i = 0; i < N; i++) {
      const col = i % cols
      const row = Math.floor(i / cols)
      const x = pad.l + col * cw
      const y = pad.t + row * chh
      const v = run.rx[i]
      const t = Math.min(1, Math.abs(v) / maxAbs)
      // blue for +（bit0-leaning), rose for −(bit1-leaning)
      ctx.fillStyle = v >= 0 ? `rgba(56,189,248,${0.25 + 0.6 * t})` : `rgba(251,113,133,${0.25 + 0.6 * t})`
      ctx.fillRect(x + 0.5, y + 0.5, cw - 1, chh - 1)
      if (run.flips[i]) {
        ctx.strokeStyle = AMBER
        ctx.lineWidth = 1.6
        ctx.strokeRect(x + 1, y + 1, cw - 2, chh - 2)
      }
    }
    axisLabel(ctx, 'received samples — blue +1·leaning, rose −1·leaning, amber = channel flipped', pad.l, 12, 'left')
  }, [stripRef, stripSize, run, N])

  const rows: { label: string; err: number; ok: boolean | null; strong?: boolean }[] = [
    { label: 'SC (list = 1)', err: run.sc.err, ok: null },
    { label: `SCL (L=${listSize}, best metric)`, err: run.sclPlain.err, ok: null },
    {
      label: crcSpec.width > 0 ? `CA-SCL (L=${listSize}, CRC)` : `SCL (L=${listSize})`,
      err: run.scl.err,
      ok: crcSpec.width > 0 ? run.scl.ok : null,
      strong: true,
    },
  ]

  return (
    <div className="mode">
      <div className="mode-side">
        <Panel title="Code & channel">
          <Field label="Block length N" value={`2^${n} = ${N}`}>
            <Slider min={4} max={10} step={1} value={n} onChange={setN} />
          </Field>
          <Field label="Code rate K/N" value={`${rate.toFixed(2)} → K=${K}`}>
            <Slider min={0.1} max={0.9} step={0.05} value={rate} onChange={setRate} />
          </Field>
          <Field label="Construction">
            <Select value={construction} options={CONSTRUCTIONS} onChange={setConstruction} />
          </Field>
          <Field label="Outer CRC">
            <Select value={crc} options={CRC_OPTIONS} onChange={setCrc} />
          </Field>
          <Field label="List size L" value={`${listSize}`}>
            <Slider min={1} max={32} step={1} value={listSize} onChange={(v) => setListSize(roundPow2(v))} />
          </Field>
          <Field label="Channel Eb/N0" value={`${snr.toFixed(1)} dB`}>
            <Slider min={-2} max={6} step={0.25} value={snr} onChange={setSnr} />
          </Field>
          <Toggle label="Exact box-plus (vs min-sum)" checked={exact} onChange={setExact} />
          <Button onClick={() => setSeed((s) => s + 1)} variant="primary">
            reroll noise
          </Button>
        </Panel>
        <Panel title="Outcome (this word)">
          <div className="poly-table">
            {rows.map((rw) => (
              <div key={rw.label} className={rw.strong ? 'poly-row strong' : 'poly-row'}>
                <span className="poly-name">{rw.label}</span>
                <span
                  className="poly-status"
                  style={{ color: rw.err === 0 ? TEAL : ROSE }}
                >
                  {rw.err === 0 ? '✓ decoded' : `✗ ${rw.err} bit err`}
                  {rw.ok !== null && (
                    <span style={{ color: rw.ok ? TEAL : AMBER, marginLeft: 8 }}>
                      {rw.ok ? 'CRC ✓' : 'CRC ✗'}
                    </span>
                  )}
                </span>
              </div>
            ))}
          </div>
          <Readout
            items={[
              { label: 'channel flips', value: `${run.channelFlips}/${N}` },
              { label: 'payload', value: `${code.msgLen} b` },
            ]}
          />
        </Panel>
      </div>
      <div className="mode-main">
        <p className="mode-intro">
          One codeword through AWGN, decoded three ways. <strong>SC</strong> commits to each bit
          irreversibly — one early wrong guess dooms the block. <strong>SCL</strong> keeps the L
          most-likely paths alive; the true path usually survives even when it isn't the
          instantaneous favourite. The <strong>CRC</strong> is the referee: it lets the list-decoder
          reject the plausible-but-wrong survivor and pick the one that actually checks — the trick
          that put polar codes into 5G.
        </p>
        <CanvasCard title="The received block" height={190}>
          <canvas ref={stripRef} />
        </CanvasCard>
        {crcSpec.width > 0 && (
          <SurvivorList survivors={run.scl.survivors} chosen={run.scl.info} />
        )}
      </div>
    </div>
  )
}

function SurvivorList({
  survivors,
  chosen,
}: {
  survivors: { pm: number; info: Uint8Array; crcOk: boolean }[]
  chosen: Uint8Array
}) {
  const eq = (a: Uint8Array, b: Uint8Array) => {
    if (a.length !== b.length) return false
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false
    return true
  }
  const top = survivors.slice(0, 12)
  const pmMin = survivors.length ? survivors[0].pm : 0
  return (
    <div className="canvas-card">
      <div className="canvas-head">
        <span className="canvas-title">List survivors — ranked by path metric</span>
        <span className="canvas-note">green = passes CRC · ★ = chosen path</span>
      </div>
      <div className="poly-survivors">
        {top.map((s, i) => (
          <div key={i} className="poly-surv-row">
            <span className="poly-surv-rank">#{i + 1}</span>
            <span className="poly-surv-bar">
              <span
                className="poly-surv-fill"
                style={{
                  width: `${Math.max(4, 100 - Math.min(100, (s.pm - pmMin) * 6))}%`,
                  background: s.crcOk ? TEAL : DIM,
                }}
              />
            </span>
            <span className="poly-surv-pm">PM {s.pm.toFixed(2)}</span>
            <span className="poly-surv-crc" style={{ color: s.crcOk ? TEAL : ROSE }}>
              {s.crcOk ? 'CRC ✓' : 'CRC ✗'}
            </span>
            <span className="poly-surv-star">{eq(s.info, chosen) ? '★' : ''}</span>
          </div>
        ))}
      </div>
    </div>
  )
}

// ===========================================================================
// Tab 4 — Waterfall: BLER/BER vs Eb/N0
// ===========================================================================

const XMIN = 0
const XMAX = 5
const EBN0_LIST: number[] = (() => {
  const list: number[] = []
  for (let db = XMIN; db <= XMAX + 1e-9; db += 0.5) list.push(Math.round(db * 2) / 2)
  return list
})()

interface Curve {
  id: string
  label: string
  color: string
  pts: WaterfallPoint[]
}

function WaterfallTab() {
  const sp = useMemo(() => readHashParams(), [])
  const [n, setN] = useState(() => readNum(sp, 'wn', 8))
  const [rate, setRate] = useState(() => readNum(sp, 'wrate', 0.5))
  const [construction, setConstruction] = useState<Construction>(() =>
    readStr(sp, 'wcon', 'ga', ['ga', 'bhattacharyya'] as const),
  )
  const [effort, setEffort] = useState<'quick' | 'balanced' | 'deep'>(() =>
    readStr(sp, 'weff', 'quick', ['quick', 'balanced', 'deep'] as const),
  )
  const [metric, setMetric] = useState<'ber' | 'bler'>(() =>
    readStr(sp, 'wmet', 'bler', ['ber', 'bler'] as const),
  )
  const [curves, setCurves] = useState<Curve[] | null>(null)
  const [running, setRunning] = useState(false)
  const [progress, setProgress] = useState('')
  const [copied, setCopied] = useState(false)
  const [runNonce, setRunNonce] = useState(0)

  const N = 1 << n
  // Keep K above the fixed CRC-8 width so the CA-SCL curve always has a payload.
  const K = Math.max(12, Math.min(N - 1, Math.round(rate * N)))

  const budget = useMemo(() => {
    if (effort === 'quick') return { minBlocks: 100, maxBlocks: 600, targetBlockErrors: 25 }
    if (effort === 'deep') return { minBlocks: 300, maxBlocks: 4000, targetBlockErrors: 80 }
    return { minBlocks: 180, maxBlocks: 1600, targetBlockErrors: 45 }
  }, [effort])

  useEffect(() => {
    let cancelled = false
    const codePlain = buildCode(N, K, construction, 2, crcById('none'))
    const codeCrc = buildCode(N, K, construction, 2, crcById('crc8'))
    const plan: { id: string; label: string; color: string; code: PolarCode; kind: 'sc' | 'scl' | 'ca-scl'; L: number }[] = [
      { id: 'sc', label: 'SC', color: ROSE, code: codePlain, kind: 'sc', L: 1 },
      { id: 'scl2', label: 'SCL L=2', color: AMBER, code: codePlain, kind: 'scl', L: 2 },
      { id: 'scl8', label: 'SCL L=8', color: BLUE, code: codePlain, kind: 'scl', L: 8 },
      { id: 'cascl8', label: 'CA-SCL L=8', color: TEAL, code: codeCrc, kind: 'ca-scl', L: 8 },
    ]
    const acc: Curve[] = []
    let i = 0
    const step = () => {
      if (cancelled) return
      if (i === 0) {
        setRunning(true)
        setCurves(null)
      }
      const job = plan[i]
      setProgress(`simulating ${job.label}…`)
      const pts = waterfall(
        job.code,
        { kind: job.kind, L: job.L },
        EBN0_LIST,
        true,
        { ...budget, seed: 20260724 + i * 13 },
      )
      acc.push({ id: job.id, label: job.label, color: job.color, pts })
      i++
      if (i < plan.length) setTimeout(step, 0)
      else {
        setCurves([...acc])
        setRunning(false)
        setProgress('')
      }
    }
    const id = setTimeout(step, 0)
    return () => {
      cancelled = true
      clearTimeout(id)
    }
  }, [N, K, construction, budget, runNonce])

  const shannon = biAwgnLimitDb(K / N)

  const { ref: plotRef, size: plotSize } = useDprCanvas()
  useEffect(() => {
    const ctx = prepareContext(plotRef.current, plotSize)
    if (!ctx) return
    const { width: w, height: h } = plotSize
    const pad = { l: 50, r: 14, t: 16, b: 30 }
    const r: Rect = { x: pad.l, y: pad.t, w: w - pad.l - pad.r, h: h - pad.t - pad.b }
    fillPlotBg(ctx, { x: 0, y: 0, w, h })
    const topExp = 0
    const botExp = -5
    const X = (db: number) => r.x + ((db - XMIN) / (XMAX - XMIN)) * r.w
    const Y = (val: number) => {
      const e = Math.log10(Math.max(val, 1e-6))
      const t = (e - topExp) / (botExp - topExp)
      return r.y + Math.max(0, Math.min(1, t)) * r.h
    }
    ctx.strokeStyle = 'rgba(120,140,220,0.12)'
    ctx.lineWidth = 1
    for (let e = topExp; e >= botExp; e--) {
      const y = Y(Math.pow(10, e))
      ctx.beginPath()
      ctx.moveTo(r.x, y)
      ctx.lineTo(r.x + r.w, y)
      ctx.stroke()
      axisLabel(ctx, e === 0 ? '1' : `1e${e}`, r.x - 6, y + 3, 'right')
    }
    for (let db = XMIN; db <= XMAX; db += 1) {
      const x = X(db)
      ctx.beginPath()
      ctx.moveTo(x, r.y)
      ctx.lineTo(x, r.y + r.h)
      ctx.stroke()
      axisLabel(ctx, `${db}`, x, r.y + r.h + 16, 'center')
    }
    // uncoded BPSK reference (BER only meaningful; draw dimmed)
    if (metric === 'ber') {
      ctx.strokeStyle = INK
      ctx.lineWidth = 2
      ctx.beginPath()
      let s0 = false
      for (let db = XMIN; db <= XMAX; db += 0.1) {
        const x = X(db)
        const y = Y(uncodedBer(db))
        if (!s0) {
          ctx.moveTo(x, y)
          s0 = true
        } else ctx.lineTo(x, y)
      }
      ctx.stroke()
    }
    // Shannon limit
    if (shannon >= XMIN && shannon <= XMAX) {
      ctx.strokeStyle = 'rgba(94,234,212,0.55)'
      ctx.setLineDash([4, 4])
      ctx.lineWidth = 1.5
      ctx.beginPath()
      ctx.moveTo(X(shannon), r.y)
      ctx.lineTo(X(shannon), r.y + r.h)
      ctx.stroke()
      ctx.setLineDash([])
      axisLabel(ctx, 'Shannon', X(shannon) + 4, r.y + 12, 'left')
    }
    if (curves) {
      for (const c of curves) {
        ctx.strokeStyle = c.color
        ctx.lineWidth = c.id === 'cascl8' ? 2.6 : 1.8
        ctx.beginPath()
        let s = false
        for (const p of c.pts) {
          const val = metric === 'ber' ? p.ber : p.bler
          if (val <= 0) continue
          const x = X(p.ebn0Db)
          const y = Y(val)
          if (!s) {
            ctx.moveTo(x, y)
            s = true
          } else ctx.lineTo(x, y)
        }
        ctx.stroke()
        for (const p of c.pts) {
          const val = metric === 'ber' ? p.ber : p.bler
          if (val <= 0) continue
          ctx.fillStyle = c.color
          ctx.beginPath()
          ctx.arc(X(p.ebn0Db), Y(val), 2.2, 0, Math.PI * 2)
          ctx.fill()
        }
      }
    }
    axisLabel(ctx, 'Eb/N0 (dB) →', r.x + r.w, r.y + r.h + 16, 'right')
    axisLabel(ctx, metric.toUpperCase(), r.x, r.y - 3, 'left')
    // legend
    const legend: [string, string][] = [
      ['SC', ROSE],
      ['SCL L=2', AMBER],
      ['SCL L=8', BLUE],
      ['CA-SCL L=8', TEAL],
    ]
    legend.forEach(([txt, col], i) => {
      const ly = r.y + 10 + i * 15
      ctx.strokeStyle = col
      ctx.lineWidth = 2.4
      ctx.beginPath()
      ctx.moveTo(r.x + r.w - 118, ly)
      ctx.lineTo(r.x + r.w - 98, ly)
      ctx.stroke()
      axisLabel(ctx, txt, r.x + r.w - 92, ly + 3, 'left')
    })
  }, [plotRef, plotSize, curves, metric, shannon])

  const onShare = () => {
    shareLink('polar', {
      tab: 'waterfall',
      wn: n,
      wrate: rate,
      wcon: construction,
      weff: effort,
      wmet: metric,
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
        <Panel title="Simulation">
          <Field label="Block length N" value={`2^${n} = ${N}`}>
            <Slider min={5} max={9} step={1} value={n} onChange={setN} />
          </Field>
          <Field label="Code rate K/N" value={`${rate.toFixed(2)} → K=${K}`}>
            <Slider min={0.25} max={0.75} step={0.05} value={rate} onChange={setRate} />
          </Field>
          <Field label="Construction">
            <Select value={construction} options={CONSTRUCTIONS} onChange={setConstruction} />
          </Field>
          <Field label="Metric">
            <Segmented
              value={metric}
              options={[
                { id: 'bler', label: 'BLER' },
                { id: 'ber', label: 'BER' },
              ]}
              onChange={setMetric}
            />
          </Field>
          <Field label="Effort">
            <Segmented
              value={effort}
              options={[
                { id: 'quick', label: 'Quick' },
                { id: 'balanced', label: 'Balanced' },
                { id: 'deep', label: 'Deep' },
              ]}
              onChange={setEffort}
            />
          </Field>
          <Button onClick={() => setRunNonce((x) => x + 1)} variant="primary">
            {running ? 'running…' : 'run again'}
          </Button>
          <Button onClick={onShare} variant="ghost">
            {copied ? 'link copied ✓' : 'share this view'}
          </Button>
        </Panel>
        <Panel title="At a glance">
          <Readout
            items={[
              { label: 'N', value: `${N}` },
              { label: 'K', value: `${K}` },
              { label: 'rate', value: (K / N).toFixed(2) },
              { label: 'Shannon', value: `${shannon.toFixed(2)} dB` },
            ]}
          />
          {progress && <p className="mode-note">{progress}</p>}
        </Panel>
      </div>
      <div className="mode-main">
        <p className="mode-intro">
          The payoff curve. Plain <strong>SC</strong> is a couple of dB from capacity; growing the
          list closes most of the gap, and the <strong>CRC-aided list</strong> (the 5G decoder) drops
          the block-error rate by another order of magnitude — a short polar code landing within ~1 dB
          of the finite-length Shannon limit. Monte-Carlo, adaptive block budget, everything computed
          live on the same from-scratch decoder.
        </p>
        <CanvasCard
          title={`${metric.toUpperCase()} waterfall — N=${N}, K=${K}, R=${(K / N).toFixed(2)}`}
          note={running ? progress : 'four decoders, one channel'}
          height={380}
        >
          <canvas ref={plotRef} />
        </CanvasCard>
      </div>
    </div>
  )
}

// --- small local helpers ---------------------------------------------------

function roundPow2(v: number): number {
  const p = Math.round(Math.log2(Math.max(1, v)))
  return 1 << Math.max(0, Math.min(5, p))
}

function designSafe(snr: number): number {
  // a sensible design point tracks the operating SNR but stays in a good range
  return Math.max(-1, Math.min(4, snr))
}

function ebn0ToSigmaLocal(ebn0Db: number, rate: number): number {
  const esn0Db = ebn0Db + 10 * Math.log10(Math.max(1e-6, rate))
  const gamma = Math.pow(10, esn0Db / 10)
  return Math.sqrt(1 / (2 * gamma))
}

function gaussLocal(rng: () => number): number {
  let u = 0
  while (u === 0) u = rng()
  const v = rng()
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v)
}

// ===========================================================================

export default function Polar() {
  const sp = useMemo(() => readHashParams(), [])
  const [tab, setTab] = useState<'polarize' | 'encoder' | 'decode' | 'waterfall'>(() =>
    readStr(sp, 'tab', 'polarize', ['polarize', 'encoder', 'decode', 'waterfall'] as const),
  )
  return (
    <div className="mode-wrap">
      <div className="mode-tabs">
        <Segmented
          value={tab}
          options={[
            { id: 'polarize', label: 'Polarization' },
            { id: 'encoder', label: 'Encoder' },
            { id: 'decode', label: 'Decode' },
            { id: 'waterfall', label: 'Waterfall' },
          ]}
          onChange={setTab}
        />
      </div>
      {tab === 'polarize' && <PolarizeTab />}
      {tab === 'encoder' && <EncoderTab />}
      {tab === 'decode' && <DecodeTab />}
      {tab === 'waterfall' && <WaterfallTab />}
    </div>
  )
}
