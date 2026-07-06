import { useEffect, useMemo, useState } from 'react'
import { CanvasCard } from '../components/CanvasCard'
import { Panel, Field, Slider, Select, Segmented, Toggle, Readout, Button } from '../components/Controls'
import { useDprCanvas, prepareContext } from '../hooks/useDprCanvas'
import { useAnimationFrame } from '../hooks/useAnimationFrame'
import { fillPlotBg, grid, axisLabel } from '../lib/draw'
import type { Rect } from '../lib/draw'
import { readHashParams, shareLink, readNum, readStr, readBool } from '../lib/urlState'
import {
  CONV_CODES,
  PUNCTURES,
  codeById,
  punctureById,
  buildTrellis,
  distanceSpectrum,
  codedBerCurve,
  unionBoundSoft,
  unionBoundHard,
  uncodedBer,
  asymptoticGainDb,
  punctureRate,
  decodeDemo,
  convEncode,
  viterbiSoft,
  viterbiHard,
  textToBits,
  bitsToText,
  mulberry32,
  gaussian,
} from '../lib/fec'

const TEAL = '#5eead4'
const BLUE = '#38bdf8'
const VIOLET = '#a78bfa'
const ROSE = '#fb7185'
const AMBER = '#fbbf24'

const CODE_OPTIONS = CONV_CODES.map((c) => ({ id: c.id, label: c.label }))
// The trellis animation stays readable only for small state counts (≤ 16 states).
const SMALL_CODE_OPTIONS = CONV_CODES.filter((c) => c.K <= 4).map((c) => ({ id: c.id, label: c.label }))
const PUNC_OPTIONS = PUNCTURES.map((p) => ({ id: p.id, label: p.label }))

// ---------------------------------------------------------------------------
// Tab 1 — the animated Viterbi trellis
// ---------------------------------------------------------------------------

function TrellisTab() {
  const sp = useMemo(() => readHashParams(), [])
  const [codeId, setCodeId] = useState(() => readStr(sp, 'tcode', 'k3_r12', SMALL_CODE_OPTIONS.map((c) => c.id)))
  const [ebn0, setEbn0] = useState(() => readNum(sp, 'tebn0', 3))
  const [soft, setSoft] = useState(() => readBool(sp, 'soft', true))
  const [msgLen, setMsgLen] = useState(() => readNum(sp, 'mlen', 10))
  const [seed, setSeed] = useState(1234)
  const [playing, setPlaying] = useState(true)
  const [prog, setProg] = useState(0) // animation progress in "columns" (float)
  const [copied, setCopied] = useState(false)

  const tr = useMemo(() => buildTrellis(codeById(codeId)), [codeId])
  const demo = useMemo(() => decodeDemo(tr, msgLen, ebn0, soft, seed), [tr, msgLen, ebn0, soft, seed])
  const steps = demo.steps

  // Reset the animation whenever the underlying decode changes (render-phase
  // adjustment — the sanctioned React pattern, no effect needed).
  const [prevDemo, setPrevDemo] = useState(demo)
  if (prevDemo !== demo) {
    setPrevDemo(demo)
    setProg(0)
  }

  useAnimationFrame((dt) => {
    setProg((p) => {
      const np = p + dt * 3.2 // ~3 columns/second
      return np > steps + 2.2 ? 0 : np // loop with a short hold at the end
    })
  }, playing)

  const { ref, size } = useDprCanvas()

  useEffect(() => {
    const ctx = prepareContext(ref.current, size)
    if (!ctx) return
    const { width: w, height: h } = size
    const r: Rect = { x: 0, y: 0, w, h }
    fillPlotBg(ctx, r)

    const S = tr.numStates
    const bits = tr.code.K - 1
    const padL = 54
    const padR = 16
    const padT = 24
    const padB = 26
    const plotW = w - padL - padR
    const plotH = h - padT - padB
    const colX = (t: number) => padL + (steps <= 0 ? 0 : (t / steps) * plotW)
    const rowY = (s: number) => padT + (S <= 1 ? plotH / 2 : (s / (S - 1)) * plotH)

    // state labels on the left
    for (let s = 0; s < S; s++) {
      axisLabel(ctx, s.toString(2).padStart(bits, '0'), padL - 8, rowY(s) + 3, 'right')
    }
    axisLabel(ctx, 'state', 8, padT - 8, 'left')
    axisLabel(ctx, 'time →', w - padR, h - 8, 'right')

    const p = Math.min(prog, steps)
    const shownCols = Math.floor(p)

    // 1. faint: every trellis branch, for the columns already swept.
    ctx.lineWidth = 1
    for (let t = 0; t < shownCols; t++) {
      for (let s = 0; s < S; s++) {
        if (demo.vit.metrics[t] && demo.vit.metrics[t][s] >= 1e17 && t > 0) {
          // state unreached yet — still draw its outgoing edges faintly
        }
        for (let inp = 0; inp < 2; inp++) {
          const ns = tr.branch[s][inp].nextState
          ctx.strokeStyle = 'rgba(120,140,220,0.10)'
          ctx.beginPath()
          ctx.moveTo(colX(t), rowY(s))
          ctx.lineTo(colX(t + 1), rowY(ns))
          ctx.stroke()
        }
      }
    }

    // 2. survivor edges into each reached state (the pruned paths).
    ctx.lineWidth = 1.6
    for (let t = 0; t < shownCols; t++) {
      const surv = demo.vit.survPred[t]
      if (!surv) continue
      for (let s = 0; s < S; s++) {
        const prev = surv[s]
        if (prev < 0) continue
        ctx.strokeStyle = 'rgba(94,234,212,0.34)'
        ctx.beginPath()
        ctx.moveTo(colX(t), rowY(prev))
        ctx.lineTo(colX(t + 1), rowY(s))
        ctx.stroke()
      }
    }

    // 3. the true (transmitted) encoder path — the answer, in dashed violet.
    ctx.strokeStyle = 'rgba(167,139,250,0.55)'
    ctx.lineWidth = 1.4
    ctx.setLineDash([4, 4])
    ctx.beginPath()
    for (let t = 0; t <= Math.min(shownCols, steps); t++) {
      const x = colX(t)
      const y = rowY(demo.truePath[t])
      if (t === 0) ctx.moveTo(x, y)
      else ctx.lineTo(x, y)
    }
    ctx.stroke()
    ctx.setLineDash([])

    // 4. the maximum-likelihood survivor path (bright), traced back from the end
    //    once the sweep has passed each column.
    ctx.strokeStyle = TEAL
    ctx.lineWidth = 2.6
    ctx.beginPath()
    for (let t = 0; t <= shownCols; t++) {
      const x = colX(t)
      const y = rowY(demo.vit.path[t])
      if (t === 0) ctx.moveTo(x, y)
      else ctx.lineTo(x, y)
    }
    ctx.stroke()

    // 5. nodes with metric numbers (only for small state counts to avoid clutter).
    const showMetrics = S <= 4
    for (let t = 0; t <= shownCols; t++) {
      for (let s = 0; s < S; s++) {
        const reached = t === 0 ? s === 0 : demo.vit.metrics[t - 1] && demo.vit.metrics[t - 1][s] < 1e17
        if (!reached) continue
        const onPath = demo.vit.path[t] === s
        ctx.fillStyle = onPath ? TEAL : 'rgba(180,196,240,0.6)'
        ctx.beginPath()
        ctx.arc(colX(t), rowY(s), onPath ? 4 : 2.6, 0, Math.PI * 2)
        ctx.fill()
        if (showMetrics && t > 0) {
          const m = demo.vit.metrics[t - 1][s]
          if (m < 1e17) {
            axisLabel(ctx, (soft ? m.toFixed(1) : m.toFixed(0)), colX(t) + 6, rowY(s) - 5, 'left')
          }
        }
      }
    }

    // 6. moving frontier line.
    if (p < steps) {
      const fx = colX(p)
      ctx.strokeStyle = 'rgba(56,189,248,0.5)'
      ctx.lineWidth = 1.4
      ctx.beginPath()
      ctx.moveTo(fx, padT - 6)
      ctx.lineTo(fx, h - padB + 6)
      ctx.stroke()
    }
  }, [tr, demo, prog, steps, size, ref, soft])

  const onShare = () => {
    shareLink('coding', { tab: 'trellis', tcode: codeId, tebn0: ebn0, soft, mlen: msgLen }).then((ok) => {
      if (ok) {
        setCopied(true)
        setTimeout(() => setCopied(false), 1400)
      }
    })
  }

  const codedStr = useMemo(() => Array.from(demo.coded).join(''), [demo])
  const errSet = useMemo(() => new Set(demo.channelErrors), [demo])

  return (
    <div className="mode">
      <div className="mode-side">
        <Panel title="Decoder">
          <Field label="Code">
            <Select value={codeId} options={SMALL_CODE_OPTIONS} onChange={setCodeId} />
          </Field>
          <Field label="Eb/N0" value={`${ebn0.toFixed(1)} dB`}>
            <Slider min={-2} max={8} step={0.5} value={ebn0} onChange={setEbn0} />
          </Field>
          <Field label="Message bits" value={`${msgLen}`}>
            <Slider min={4} max={20} step={1} value={msgLen} onChange={(v) => setMsgLen(Math.round(v))} />
          </Field>
          <Toggle label="Soft decision (Euclidean)" checked={soft} onChange={setSoft} />
          <div className="btn-row">
            <Button variant={playing ? 'ghost' : 'primary'} onClick={() => setPlaying((x) => !x)}>
              {playing ? 'Pause' : 'Play'}
            </Button>
            <Button variant="ghost" onClick={() => setSeed((s) => s + 1)}>
              Re-roll noise
            </Button>
          </div>
          <div className="btn-row">
            <Button variant="ghost" onClick={onShare}>
              {copied ? 'Copied ✓' : 'Copy link'}
            </Button>
          </div>
          <p className="hint">
            Watch the <strong>survivor sweep</strong>: at every column each state keeps only the one
            incoming path with the best metric (add–compare–select). The bright teal line is the
            surviving maximum-likelihood path; the dashed violet is the true transmitted path. When
            they coincide, every channel error was repaired.
          </p>
        </Panel>

        <Panel title="This block">
          <Readout
            items={[
              { label: 'Channel errors', value: `${demo.channelErrors.length} / ${demo.coded.length}` },
              { label: 'After decoding', value: `${demo.residualErrors} / ${demo.msg.length}` },
              { label: 'Decision', value: soft ? 'soft' : 'hard' },
              { label: 'Recovered', value: demo.residualErrors === 0 ? 'yes ✓' : 'no ✗' },
            ]}
          />
          <p className="hint">
            The channel flips {demo.channelErrors.length} of the {demo.coded.length} coded bits, yet the
            trellis still snaps back to the sent message whenever those errors fall inside the code's
            correcting power.
          </p>
        </Panel>
      </div>

      <div className="mode-main">
        <p className="mode-intro">
          A <strong>convolutional code</strong> smears each message bit across several transmitted bits
          through a shift register, so the legal sequences are the paths through a <strong>trellis</strong>.
          The <strong>Viterbi</strong> decoder finds the single path closest to what arrived — the
          maximum-likelihood message — in one left-to-right sweep. Here it runs live on {tr.code.label}.
        </p>
        <CanvasCard title="Viterbi trellis (live)" note="teal = surviving ML path · dashed violet = true path" height={340}>
          <canvas ref={ref} />
        </CanvasCard>
        <CanvasCard title="Coded stream through the channel" note="red = a bit the noise flipped" height={96}>
          <BitStrip coded={codedStr} errSet={errSet} n={demo.n} />
        </CanvasCard>
      </div>
    </div>
  )
}

/** A compact monospace strip of the coded bits with flipped ones marked. */
function BitStrip({ coded, errSet, n }: { coded: string; errSet: Set<number>; n: number }) {
  return (
    <div className="bitstrip">
      {coded.split('').map((b, i) => (
        <span
          key={i}
          className={errSet.has(i) ? 'bit err' : 'bit'}
          style={{ marginRight: (i + 1) % n === 0 ? 6 : 1 }}
        >
          {b}
        </span>
      ))}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Tab 2 — coding gain: BER curves + distance spectrum
// ---------------------------------------------------------------------------

function GainTab() {
  const sp = useMemo(() => readHashParams(), [])
  const [codeId, setCodeId] = useState(() => readStr(sp, 'gcode', 'k7_r12', CODE_OPTIONS.map((c) => c.id)))
  const [puncId, setPuncId] = useState(() => readStr(sp, 'punc', 'none', PUNC_OPTIONS.map((p) => p.id)))
  const [ebn0, setEbn0] = useState(() => readNum(sp, 'gebn0', 4))
  const [copied, setCopied] = useState(false)

  const tr = useMemo(() => buildTrellis(codeById(codeId)), [codeId])
  const spec = useMemo(() => distanceSpectrum(tr), [tr])
  const punc = useMemo(() => punctureById(puncId), [puncId])
  const rate = useMemo(() => punctureRate(tr.n, punc), [tr, punc])

  const { ref: berRef, size: berSize } = useDprCanvas()
  const { ref: specRef, size: specSize } = useDprCanvas()

  const xmin = 0
  const xmax = 10

  const curve = useMemo(() => {
    const list: number[] = []
    for (let db = xmin; db <= xmax; db += 1) list.push(db)
    // Punctured codes shift the union bound; the bound we draw is the mother-code
    // spectrum evaluated at the punctured rate (exact for none, indicative otherwise).
    return codedBerCurve(tr, spec, list, 24000, punc, 918273)
  }, [tr, spec, punc])

  // Coding gain at a target BER (1e-5): dB saved vs uncoded BPSK, from the bounds.
  const gainAt = useMemo(() => {
    const target = 1e-5
    const findDb = (f: (db: number) => number) => {
      for (let db = 0; db <= 14; db += 0.02) if (f(db) <= target) return db
      return NaN
    }
    const dbUncoded = findDb((db) => uncodedBer(db))
    const dbHard = findDb((db) => unionBoundHard(spec, rate, db))
    const dbSoft = findDb((db) => unionBoundSoft(spec, rate, db))
    return { hard: dbUncoded - dbHard, soft: dbUncoded - dbSoft }
  }, [spec, rate])

  const asym = useMemo(() => asymptoticGainDb(spec.dFree, rate), [spec, rate])

  const onShare = () => {
    shareLink('coding', { tab: 'gain', gcode: codeId, punc: puncId, gebn0: ebn0 }).then((ok) => {
      if (ok) {
        setCopied(true)
        setTimeout(() => setCopied(false), 1400)
      }
    })
  }

  // --- BER curve ---
  useEffect(() => {
    const ctx = prepareContext(berRef.current, berSize)
    if (!ctx) return
    const { width: w, height: h } = berSize
    const pad = { l: 46, r: 14, t: 16, b: 28 }
    const r: Rect = { x: pad.l, y: pad.t, w: w - pad.l - pad.r, h: h - pad.t - pad.b }
    fillPlotBg(ctx, { x: 0, y: 0, w, h })
    const topExp = 0
    const botExp = -7
    const X = (db: number) => r.x + ((db - xmin) / (xmax - xmin)) * r.w
    const Y = (ber: number) => {
      const e = Math.log10(Math.max(ber, 1e-8))
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
    for (let db = xmin; db <= xmax; db += 2) {
      const x = X(db)
      ctx.beginPath()
      ctx.moveTo(x, r.y)
      ctx.lineTo(x, r.y + r.h)
      ctx.stroke()
      axisLabel(ctx, `${db}`, x, r.y + r.h + 16, 'center')
    }

    // uncoded BPSK theory (baseline)
    const drawTheory = (f: (db: number) => number, color: string, dash?: number[]) => {
      ctx.strokeStyle = color
      ctx.lineWidth = 2
      if (dash) ctx.setLineDash(dash)
      ctx.beginPath()
      let started = false
      for (let db = xmin; db <= xmax; db += 0.1) {
        const y = Y(f(db))
        const x = X(db)
        if (!started) {
          ctx.moveTo(x, y)
          started = true
        } else ctx.lineTo(x, y)
      }
      ctx.stroke()
      ctx.setLineDash([])
    }
    drawTheory((db) => uncodedBer(db), 'rgba(226,232,240,0.75)')
    drawTheory((db) => unionBoundHard(spec, rate, db), BLUE, [5, 4])
    drawTheory((db) => unionBoundSoft(spec, rate, db), VIOLET, [5, 4])

    // measured points
    const dot = (db: number, ber: number, color: string) => {
      if (ber <= 0) return
      ctx.fillStyle = color
      ctx.beginPath()
      ctx.arc(X(db), Y(ber), 3, 0, Math.PI * 2)
      ctx.fill()
    }
    for (const p of curve) {
      dot(p.ebn0Db, p.hardMeasured, BLUE)
      dot(p.ebn0Db, p.softMeasured, VIOLET)
    }

    // operating marker
    const cx = X(ebn0)
    ctx.strokeStyle = 'rgba(94,234,212,0.6)'
    ctx.setLineDash([3, 4])
    ctx.beginPath()
    ctx.moveTo(cx, r.y)
    ctx.lineTo(cx, r.y + r.h)
    ctx.stroke()
    ctx.setLineDash([])

    axisLabel(ctx, 'Eb/N0 (dB) →', r.x + r.w, r.y + r.h + 16, 'right')
    axisLabel(ctx, 'BER', r.x, r.y - 3, 'left')

    // legend
    const legend: [string, string][] = [
      ['uncoded BPSK', 'rgba(226,232,240,0.85)'],
      ['hard Viterbi', BLUE],
      ['soft Viterbi', VIOLET],
    ]
    legend.forEach(([txt, col], i) => {
      const ly = r.y + 8 + i * 15
      ctx.strokeStyle = col
      ctx.lineWidth = 2
      ctx.beginPath()
      ctx.moveTo(r.x + r.w - 118, ly)
      ctx.lineTo(r.x + r.w - 100, ly)
      ctx.stroke()
      axisLabel(ctx, txt, r.x + r.w - 94, ly + 3, 'left')
    })
  }, [curve, spec, rate, ebn0, berSize, berRef])

  // --- distance spectrum bars ---
  useEffect(() => {
    const ctx = prepareContext(specRef.current, specSize)
    if (!ctx) return
    const { width: w, height: h } = specSize
    const r: Rect = { x: 0, y: 0, w, h }
    fillPlotBg(ctx, r)
    grid(ctx, r, 8, 4)
    const terms = spec.terms
    if (terms.length === 0) return
    const maxC = Math.max(...terms.map((t) => t.cInfo))
    const pad = { l: 34, r: 12, t: 16, b: 24 }
    const pw = w - pad.l - pad.r
    const ph = h - pad.t - pad.b
    const bw = pw / terms.length
    terms.forEach((t, i) => {
      const x = pad.l + i * bw
      const bh = (Math.log10(t.cInfo + 1) / Math.log10(maxC + 1)) * ph
      const isFree = t.d === spec.dFree
      ctx.fillStyle = isFree ? TEAL : 'rgba(56,189,248,0.55)'
      ctx.fillRect(x + bw * 0.15, pad.t + ph - bh, bw * 0.7, bh)
      axisLabel(ctx, `${t.d}`, x + bw / 2, pad.t + ph + 15, 'center')
      axisLabel(ctx, `${t.aCount}`, x + bw / 2, pad.t + ph - bh - 4, 'center')
    })
    axisLabel(ctx, 'output weight d →', w - pad.r, h - 6, 'right')
    axisLabel(ctx, 'error-event count aᵈ (bars: log cᵈ)', pad.l, pad.t - 4, 'left')
    axisLabel(ctx, `d_free = ${spec.dFree}`, pad.l + 2, pad.t + 12, 'left')
  }, [spec, specSize, specRef])

  const cur = useMemo(() => {
    return {
      uncoded: uncodedBer(ebn0),
      hardBound: unionBoundHard(spec, rate, ebn0),
      softBound: unionBoundSoft(spec, rate, ebn0),
    }
  }, [spec, rate, ebn0])

  return (
    <div className="mode">
      <div className="mode-side">
        <Panel title="Code">
          <Field label="Convolutional code">
            <Select value={codeId} options={CODE_OPTIONS} onChange={setCodeId} />
          </Field>
          <Field label="Puncture">
            <Select value={puncId} options={PUNC_OPTIONS} onChange={setPuncId} />
          </Field>
          <Field label="Eb/N0 marker" value={`${ebn0.toFixed(1)} dB`}>
            <Slider min={0} max={10} step={0.5} value={ebn0} onChange={setEbn0} />
          </Field>
          <div className="btn-row">
            <Button variant="ghost" onClick={onShare}>
              {copied ? 'Copied ✓' : 'Copy link'}
            </Button>
          </div>
          <p className="hint">{tr.code.note}.</p>
        </Panel>

        <Panel title="Coding gain">
          <Readout
            items={[
              { label: 'd_free', value: `${spec.dFree}` },
              { label: 'Code rate', value: `${(1 / tr.n).toFixed(2)}${punc.id === 'none' ? '' : ` → ${rate.toFixed(2)}`}` },
              { label: 'Gain @1e-5 (soft)', value: isFinite(gainAt.soft) ? `${gainAt.soft.toFixed(1)} dB` : '—' },
              { label: 'Gain @1e-5 (hard)', value: isFinite(gainAt.hard) ? `${gainAt.hard.toFixed(1)} dB` : '—' },
              { label: 'Asymptotic (soft)', value: `${asym.soft.toFixed(1)} dB` },
              { label: 'Soft over hard', value: `${(asym.soft - asym.hard).toFixed(1)} dB` },
            ]}
          />
          <p className="hint">
            At the marker ({ebn0.toFixed(1)} dB): uncoded {cur.uncoded.toExponential(1)}, hard bound{' '}
            {cur.hardBound.toExponential(1)}, soft bound {cur.softBound.toExponential(1)}. Soft decisions
            buy the classic ~2 dB over hard; the whole curve slides left by the coding gain.
          </p>
        </Panel>
      </div>

      <div className="mode-main">
        <p className="mode-intro">
          The payoff of coding is a <strong>curve that slides left</strong>: to hit a target error rate you
          need less signal power. The dashed lines are the <strong>union bound</strong> — a closed-form
          upper bound built from the code's own <strong>distance spectrum</strong> — and the dots are the
          measured Monte-Carlo error rate, which the bound hugs from above once past threshold.
        </p>
        <CanvasCard title="Bit-error rate vs Eb/N0" note="dots = measured · dashed = union bound · white = uncoded" height={280}>
          <canvas ref={berRef} />
        </CanvasCard>
        <CanvasCard title="Distance spectrum" note="the weights of the code's error events" height={180}>
          <canvas ref={specRef} />
        </CanvasCard>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Tab 3 — the message demo: text through the coded link
// ---------------------------------------------------------------------------

function MessageTab() {
  const sp = useMemo(() => readHashParams(), [])
  const [text, setText] = useState<string>(() => readStr(sp, 'msg', 'CODES REPAIR NOISE'))
  const [codeId, setCodeId] = useState(() => readStr(sp, 'mcode', 'k7_r12', CODE_OPTIONS.map((c) => c.id)))
  const [ebn0, setEbn0] = useState(() => readNum(sp, 'mebn0', 2))
  const [soft, setSoft] = useState(() => readBool(sp, 'msoft', true))
  const [seed, setSeed] = useState(7)
  const [copied, setCopied] = useState(false)

  const tr = useMemo(() => buildTrellis(codeById(codeId)), [codeId])

  const result = useMemo(() => {
    const clean = text.slice(0, 40)
    const msg = textToBits(clean)
    const coded = convEncode(msg, tr)
    const rate = 1 / tr.n
    const g = Math.pow(10, ebn0 / 10)
    const sigmaC = Math.sqrt(1 / (2 * rate * g))
    const rng = mulberry32(seed)
    // Coded path.
    const softRx = new Float64Array(coded.length)
    const hardRx = new Uint8Array(coded.length)
    for (let i = 0; i < coded.length; i++) {
      const s = 1 - 2 * coded[i] + sigmaC * gaussian(rng)
      softRx[i] = s
      hardRx[i] = s >= 0 ? 0 : 1
    }
    const dec = soft ? viterbiSoft(softRx, tr) : viterbiHard(hardRx, tr)
    const decodedText = bitsToText(dec.decoded)
    let codedResidual = 0
    for (let i = 0; i < msg.length; i++) if (dec.decoded[i] !== msg[i]) codedResidual++
    // Uncoded reference: send the raw text bits at the same Eb/N0.
    const sigmaU = Math.sqrt(1 / (2 * g))
    const uncBits = new Uint8Array(msg.length)
    let uncErr = 0
    for (let i = 0; i < msg.length; i++) {
      const s = 1 - 2 * msg[i] + sigmaU * gaussian(rng)
      uncBits[i] = s >= 0 ? 0 : 1
      if (uncBits[i] !== msg[i]) uncErr++
    }
    const uncodedText = bitsToText(uncBits)
    return { clean, decodedText, uncodedText, codedResidual, uncErr, nBits: msg.length, codedBits: coded.length }
  }, [text, tr, ebn0, soft, seed])

  const onShare = () => {
    shareLink('coding', { tab: 'message', msg: text, mcode: codeId, mebn0: ebn0, msoft: soft }).then((ok) => {
      if (ok) {
        setCopied(true)
        setTimeout(() => setCopied(false), 1400)
      }
    })
  }

  return (
    <div className="mode">
      <div className="mode-side">
        <Panel title="Message">
          <Field label="Text (≤ 40 chars)">
            <input
              className="select"
              type="text"
              value={text}
              maxLength={40}
              onChange={(e) => setText(e.target.value.toUpperCase())}
              style={{ width: '100%' }}
            />
          </Field>
          <Field label="Code">
            <Select value={codeId} options={CODE_OPTIONS} onChange={setCodeId} />
          </Field>
          <Field label="Eb/N0" value={`${ebn0.toFixed(1)} dB`}>
            <Slider min={-2} max={8} step={0.5} value={ebn0} onChange={setEbn0} />
          </Field>
          <Toggle label="Soft decision" checked={soft} onChange={setSoft} />
          <div className="btn-row">
            <Button variant="ghost" onClick={() => setSeed((s) => s + 1)}>
              Re-roll noise
            </Button>
            <Button variant="ghost" onClick={onShare}>
              {copied ? 'Copied ✓' : 'Copy link'}
            </Button>
          </div>
        </Panel>
        <Panel title="Outcome">
          <Readout
            items={[
              { label: 'Uncoded bit errors', value: `${result.uncErr} / ${result.nBits}` },
              { label: 'Coded bit errors', value: `${result.codedResidual} / ${result.nBits}` },
              { label: 'Coded overhead', value: `${result.codedBits} bits sent` },
              { label: 'Message', value: result.codedResidual === 0 ? 'intact ✓' : `${result.codedResidual} bad` },
            ]}
          />
        </Panel>
      </div>
      <div className="mode-main">
        <p className="mode-intro">
          Same channel, same energy per bit — the only difference is the code. Send the text raw and the
          noise shreds it; wrap it in the convolutional code and the Viterbi decoder pulls the words back
          out of the same noise. Turn <strong>Eb/N0</strong> down until even the code gives up.
        </p>
        <div className="msg-panels">
          <div className="msg-block">
            <div className="msg-head">Sent</div>
            <TextDiff a={result.clean} b={result.clean} />
          </div>
          <div className="msg-block">
            <div className="msg-head" style={{ color: ROSE }}>
              Uncoded through the noise — {result.uncErr} bit errors
            </div>
            <TextDiff a={result.clean} b={result.uncodedText} />
          </div>
          <div className="msg-block">
            <div className="msg-head" style={{ color: result.codedResidual === 0 ? TEAL : AMBER }}>
              Coded + Viterbi decoded — {result.codedResidual === 0 ? 'perfectly repaired' : `${result.codedResidual} residual`}
            </div>
            <TextDiff a={result.clean} b={result.decodedText} />
          </div>
        </div>
      </div>
    </div>
  )
}

/** Character diff: characters in `b` that differ from `a` are highlighted rose. */
function TextDiff({ a, b }: { a: string; b: string }) {
  const n = Math.max(a.length, b.length)
  const chars: { ch: string; bad: boolean }[] = []
  for (let i = 0; i < n; i++) {
    const cb = b[i] ?? '·'
    chars.push({ ch: cb === ' ' ? '␣' : cb, bad: (a[i] ?? '') !== (b[i] ?? '') })
  }
  return (
    <div className="textdiff">
      {chars.map((c, i) => (
        <span key={i} className={c.bad ? 'td bad' : 'td'}>
          {c.ch}
        </span>
      ))}
    </div>
  )
}

// ---------------------------------------------------------------------------

export default function Coding() {
  const sp = useMemo(() => readHashParams(), [])
  const [tab, setTab] = useState<'trellis' | 'gain' | 'message'>(() =>
    readStr(sp, 'tab', 'trellis', ['trellis', 'gain', 'message'] as const),
  )
  return (
    <div className="mode-wrap">
      <div className="mode-tabs">
        <Segmented
          value={tab}
          options={[
            { id: 'trellis', label: 'Trellis & Viterbi' },
            { id: 'gain', label: 'Coding gain' },
            { id: 'message', label: 'Message demo' },
          ]}
          onChange={setTab}
        />
      </div>
      {tab === 'trellis' && <TrellisTab />}
      {tab === 'gain' && <GainTab />}
      {tab === 'message' && <MessageTab />}
    </div>
  )
}
