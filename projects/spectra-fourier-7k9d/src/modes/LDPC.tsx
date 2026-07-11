import { useEffect, useMemo, useState } from 'react'
import { CanvasCard } from '../components/CanvasCard'
import { Panel, Field, Slider, Select, Segmented, Readout, Button } from '../components/Controls'
import { useDprCanvas, prepareContext } from '../hooks/useDprCanvas'
import { useAnimationFrame } from '../hooks/useAnimationFrame'
import { fillPlotBg, axisLabel } from '../lib/draw'
import type { Rect } from '../lib/draw'
import { readHashParams, shareLink, readNum, readStr } from '../lib/urlState'
import {
  codeCatalogue,
  codeById,
  decodeDemo,
  waterfall,
  uncodedBer,
  shannonLimitDb,
  girth,
  degreeStats,
  DECODERS,
} from '../lib/ldpc'
import type { DecoderAlgo, WaterfallPoint } from '../lib/ldpc'

const TEAL = '#5eead4'
const BLUE = '#38bdf8'
const VIOLET = '#a78bfa'
const ROSE = '#fb7185'
const AMBER = '#fbbf24'
const INK = 'rgba(226,232,240,0.85)'

const CODE_OPTIONS = codeCatalogue().map((c) => ({ id: c.id, label: c.label }))
const SMALL_CODE_OPTIONS = codeCatalogue()
  .filter((c) => c.n <= 96)
  .map((c) => ({ id: c.id, label: c.label }))
const DECODER_OPTIONS = DECODERS.map((d) => ({ id: d.id, label: d.label }))

// ---------------------------------------------------------------------------
// Tab 1 — the animated Tanner graph + belief propagation
// ---------------------------------------------------------------------------

// The inputs live in a thin wrapper; the animation state lives here and is reset
// by remounting (a `key` off the decode parameters) — no reset effect required.
interface GraphInnerProps {
  codeId: string
  setCodeId: (v: string) => void
  algo: DecoderAlgo
  setAlgo: (v: DecoderAlgo) => void
  ebn0: number
  setEbn0: (v: number) => void
  maxIter: number
  setMaxIter: (v: number) => void
  seed: number
  reroll: () => void
}

function GraphInner({ codeId, setCodeId, algo, setAlgo, ebn0, setEbn0, maxIter, setMaxIter, seed, reroll }: GraphInnerProps) {
  const [playing, setPlaying] = useState(true)
  const [iterView, setIterView] = useState(0) // which trace frame we're showing (float for easing)
  const [copied, setCopied] = useState(false)

  const code = useMemo(() => codeById(codeId), [codeId])
  const demo = useMemo(
    () => decodeDemo(code, ebn0, algo, maxIter, seed),
    [code, ebn0, algo, maxIter, seed],
  )
  const frames = demo.result.hardTrace ?? []
  const nFrames = frames.length

  // Advance through the decode frames, then hold on the last one.
  useAnimationFrame(
    (dt) => {
      setIterView((p) => {
        const next = p + dt * 2.2 // ~2 frames/sec
        return next >= nFrames - 1 ? nFrames - 1 : next
      })
    },
    playing && nFrames > 1,
  )

  const frameIdx = Math.max(0, Math.min(nFrames - 1, Math.round(iterView)))
  const hardNow = frames[frameIdx] ?? demo.result.hard

  // --- node layout (variables on a lower ring/row, checks on an upper row) ---
  const { ref, size } = useDprCanvas()
  useEffect(() => {
    const ctx = prepareContext(ref.current, size)
    if (!ctx) return
    const { width: w, height: h } = size
    ctx.clearRect(0, 0, w, h)
    const padX = 26
    const topY = 46
    const botY = h - 54
    const nV = code.n
    const nC = code.m
    const vx = (i: number) => padX + (i / Math.max(1, nV - 1)) * (w - 2 * padX)
    const cx = (i: number) => padX + (i / Math.max(1, nC - 1)) * (w - 2 * padX)

    // unsatisfied checks under the current hard decision
    const unsat = new Uint8Array(nC)
    for (let c = 0; c < nC; c++) {
      let p = 0
      for (const v of code.checkNodes[c]) p ^= hardNow[v] & 1
      unsat[c] = p
    }

    // edges: dim, but light up when they touch an unsatisfied check
    for (let e = 0; e < code.edgeVar.length; e++) {
      const v = code.edgeVar[e]
      const c = code.edgeChk[e]
      ctx.strokeStyle = unsat[c] ? 'rgba(251,191,36,0.5)' : 'rgba(120,140,220,0.14)'
      ctx.lineWidth = unsat[c] ? 1.3 : 0.7
      ctx.beginPath()
      ctx.moveTo(cx(c), topY)
      ctx.lineTo(vx(v), botY)
      ctx.stroke()
    }

    // check nodes (squares): amber when unsatisfied, teal when satisfied
    for (let c = 0; c < nC; c++) {
      const x = cx(c)
      const s = 6
      ctx.fillStyle = unsat[c] ? AMBER : 'rgba(94,234,212,0.55)'
      ctx.strokeStyle = unsat[c] ? '#fff3d6' : TEAL
      ctx.lineWidth = 1
      ctx.beginPath()
      ctx.rect(x - s / 2, topY - s / 2, s, s)
      ctx.fill()
      ctx.stroke()
    }

    // variable nodes (circles): rose where the current hard bit is still wrong
    const wrong = new Uint8Array(nV)
    for (const i of demo.finalErrors) wrong[i] = 1
    for (let v = 0; v < nV; v++) {
      const x = vx(v)
      const isErr = hardNow[v] !== demo.tx[v]
      ctx.fillStyle = isErr ? ROSE : hardNow[v] ? 'rgba(56,189,248,0.85)' : 'rgba(148,163,184,0.7)'
      ctx.beginPath()
      ctx.arc(x, botY, 4.2, 0, Math.PI * 2)
      ctx.fill()
      if (isErr) {
        ctx.strokeStyle = '#ffd0d8'
        ctx.lineWidth = 1.2
        ctx.stroke()
      }
    }

    axisLabel(ctx, `${nC} parity checks`, padX, topY - 16, 'left')
    axisLabel(ctx, `${nV} code bits`, padX, botY + 20, 'left')
    const unsatCount = unsat.reduce((a, b) => a + b, 0)
    axisLabel(
      ctx,
      unsatCount === 0 ? 'all checks satisfied ✓' : `${unsatCount} unsatisfied`,
      w - padX,
      topY - 16,
      'right',
    )
  }, [ref, size, code, hardNow, demo])

  // --- syndrome-weight trace chart ---
  const trace = demo.result.syndromeTrace
  const { ref: traceRef, size: traceSize } = useDprCanvas()
  useEffect(() => {
    const ctx = prepareContext(traceRef.current, traceSize)
    if (!ctx) return
    const { width: w, height: h } = traceSize
    const pad = { l: 40, r: 12, t: 12, b: 24 }
    const r: Rect = { x: pad.l, y: pad.t, w: w - pad.l - pad.r, h: h - pad.t - pad.b }
    fillPlotBg(ctx, { x: 0, y: 0, w, h })
    const maxS = Math.max(1, ...trace)
    const X = (i: number) => r.x + (trace.length <= 1 ? 0 : (i / (trace.length - 1)) * r.w)
    const Y = (s: number) => r.y + r.h - (s / maxS) * r.h * 0.95
    // gridlines
    ctx.strokeStyle = 'rgba(120,140,220,0.12)'
    ctx.lineWidth = 1
    for (let g = 0; g <= 4; g++) {
      const y = r.y + (g / 4) * r.h
      ctx.beginPath()
      ctx.moveTo(r.x, y)
      ctx.lineTo(r.x + r.w, y)
      ctx.stroke()
    }
    axisLabel(ctx, `${maxS}`, r.x - 6, r.y + 8, 'right')
    axisLabel(ctx, '0', r.x - 6, r.y + r.h, 'right')
    // the descending syndrome curve
    ctx.strokeStyle = AMBER
    ctx.lineWidth = 2
    ctx.beginPath()
    trace.forEach((s, i) => {
      const x = X(i)
      const y = Y(s)
      if (i === 0) ctx.moveTo(x, y)
      else ctx.lineTo(x, y)
    })
    ctx.stroke()
    // dots up to the current playhead
    trace.forEach((s, i) => {
      ctx.fillStyle = i <= frameIdx ? (s === 0 ? TEAL : AMBER) : 'rgba(148,163,184,0.4)'
      ctx.beginPath()
      ctx.arc(X(i), Y(s), i === frameIdx ? 4 : 2.4, 0, Math.PI * 2)
      ctx.fill()
    })
    axisLabel(ctx, 'iteration →', r.x + r.w, r.y + r.h + 16, 'right')
    axisLabel(ctx, 'unsatisfied checks', r.x, r.y - 1, 'left')
  }, [traceRef, traceSize, trace, frameIdx])

  const onShare = () => {
    shareLink('ldpc', { tab: 'graph', gcode: codeId, galgo: algo, gebn0: ebn0, gmax: maxIter }).then(
      (ok) => {
        if (ok) {
          setCopied(true)
          setTimeout(() => setCopied(false), 1400)
        }
      },
    )
  }

  const res = demo.result
  return (
    <div className="mode">
      <div className="mode-side">
        <Panel title="Code & channel">
          <Field label="Code">
            <Select value={codeId} options={SMALL_CODE_OPTIONS} onChange={setCodeId} />
          </Field>
          <Field label="Decoder">
            <Select value={algo} options={DECODER_OPTIONS} onChange={(v) => setAlgo(v as DecoderAlgo)} />
          </Field>
          <Field label="Eb/N0" value={`${ebn0.toFixed(1)} dB`}>
            <Slider min={-1} max={6} step={0.5} value={ebn0} onChange={setEbn0} />
          </Field>
          <Field label="Max iterations" value={`${maxIter}`}>
            <Slider min={4} max={50} step={1} value={maxIter} onChange={(v) => setMaxIter(Math.round(v))} />
          </Field>
          <div className="btn-row">
            <Button variant={playing ? 'ghost' : 'primary'} onClick={() => setPlaying((x) => !x)}>
              {playing ? 'Pause' : 'Replay'}
            </Button>
            <Button variant="ghost" onClick={reroll}>
              Re-roll noise
            </Button>
          </div>
          <Field label="Scrub iteration" value={`${frameIdx} / ${nFrames - 1}`}>
            <Slider
              min={0}
              max={Math.max(0, nFrames - 1)}
              step={1}
              value={frameIdx}
              onChange={(v) => {
                setPlaying(false)
                setIterView(v)
              }}
            />
          </Field>
          <div className="btn-row">
            <Button variant="ghost" onClick={onShare}>
              {copied ? 'Copied ✓' : 'Copy link'}
            </Button>
          </div>
        </Panel>

        <Panel title="This block">
          <Readout
            items={[
              { label: 'Rate', value: `${code.k}/${code.n} = ${code.rate.toFixed(3)}` },
              { label: 'Channel errors', value: `${demo.channelErrors.length} / ${code.n}` },
              { label: 'Iterations', value: `${res.iterations}` },
              { label: 'Result', value: demo.recovered ? 'decoded ✓' : `${demo.finalErrors.length} wrong ✗` },
            ]}
          />
          <p className="hint">
            The channel flips <em>{demo.channelErrors.length}</em> of {code.n} coded bits. Each round,
            every check node tells its bits which way to lean; the bits pool that advice with the
            channel and re-decide. Amber checks are <em>unsatisfied</em> — watch them wink out as belief
            propagates. The instant all parity checks pass, decoding stops.
          </p>
        </Panel>
      </div>

      <div className="mode-main">
        <p className="mode-intro">
          An <strong>LDPC code</strong> is a sparse <strong>Tanner graph</strong>: code bits on the
          bottom, parity checks on top, an edge wherever a bit takes part in a check. Decoding is{' '}
          <strong>belief propagation</strong> — soft messages flow back and forth along the edges
          until every check is satisfied. It's how Wi-Fi, 5G, and deep-space links get within a
          fraction of a dB of Shannon.
        </p>
        <CanvasCard
          title="Tanner graph — belief propagation live"
          note="■ checks (amber = unsatisfied) · ● bits (rose = still wrong)"
          height={330}
        >
          <canvas ref={ref} />
        </CanvasCard>
        <CanvasCard title="Syndrome weight per iteration" note="unsatisfied checks → 0 = success" height={150}>
          <canvas ref={traceRef} />
        </CanvasCard>
      </div>
    </div>
  )
}

function GraphTab() {
  const sp = useMemo(() => readHashParams(), [])
  const [codeId, setCodeId] = useState(() =>
    readStr(sp, 'gcode', 'peg_48_24', SMALL_CODE_OPTIONS.map((c) => c.id)),
  )
  const [algo, setAlgo] = useState<DecoderAlgo>(() =>
    readStr(sp, 'galgo', 'sp', ['sp', 'ms', 'nms', 'oms'] as const),
  )
  const [ebn0, setEbn0] = useState(() => readNum(sp, 'gebn0', 2.5))
  const [maxIter, setMaxIter] = useState(() => readNum(sp, 'gmax', 20))
  const [seed, setSeed] = useState(1)
  // Remount the animation whenever any decode parameter changes → fresh playhead.
  const key = `${codeId}|${algo}|${ebn0}|${maxIter}|${seed}`
  return (
    <GraphInner
      key={key}
      codeId={codeId}
      setCodeId={setCodeId}
      algo={algo}
      setAlgo={setAlgo}
      ebn0={ebn0}
      setEbn0={setEbn0}
      maxIter={maxIter}
      setMaxIter={setMaxIter}
      seed={seed}
      reroll={() => setSeed((s) => s + 1)}
    />
  )
}

// ---------------------------------------------------------------------------
// Tab 2 — the BER / BLER waterfall
// ---------------------------------------------------------------------------

const DEC_COLOR: Record<DecoderAlgo, string> = { sp: VIOLET, ms: ROSE, nms: BLUE, oms: AMBER }

const XMIN = -1
const XMAX = 6
const EBN0_LIST: number[] = (() => {
  const list: number[] = []
  for (let db = XMIN; db <= XMAX + 1e-9; db += 0.5) list.push(Math.round(db * 2) / 2)
  return list
})()

function WaterfallTab() {
  const sp = useMemo(() => readHashParams(), [])
  const [codeId, setCodeId] = useState(() => readStr(sp, 'wcode', 'peg_96_48', CODE_OPTIONS.map((c) => c.id)))
  const [maxIter, setMaxIter] = useState(() => readNum(sp, 'wmax', 30))
  const [effort, setEffort] = useState<'quick' | 'balanced' | 'deep'>(() =>
    readStr(sp, 'weff', 'balanced', ['quick', 'balanced', 'deep'] as const),
  )
  const [metric, setMetric] = useState<'ber' | 'bler'>(() =>
    readStr(sp, 'wmet', 'ber', ['ber', 'bler'] as const),
  )
  const [curves, setCurves] = useState<Record<DecoderAlgo, WaterfallPoint[]> | null>(null)
  const [running, setRunning] = useState(false)
  const [progress, setProgress] = useState('')
  const [copied, setCopied] = useState(false)
  const [runNonce, setRunNonce] = useState(0)

  const code = useMemo(() => codeById(codeId), [codeId])

  const budget = useMemo(() => {
    if (effort === 'quick') return { minBlocks: 120, maxBlocks: 800, targetBlockErrors: 30 }
    if (effort === 'deep') return { minBlocks: 400, maxBlocks: 6000, targetBlockErrors: 100 }
    return { minBlocks: 200, maxBlocks: 2500, targetBlockErrors: 60 }
  }, [effort])

  // Run the Monte-Carlo sweep off the paint path (chunked via setTimeout) so the UI
  // stays live and the decoder simulation never blocks a frame. The effect body only
  // *schedules* work; every setState happens inside an async callback.
  useEffect(() => {
    let cancelled = false
    const algos: DecoderAlgo[] = ['sp', 'ms', 'nms', 'oms']
    const acc: Record<string, WaterfallPoint[]> = {}
    let i = 0
    const step = () => {
      if (cancelled) return
      if (i === 0) {
        setRunning(true)
        setCurves(null)
      }
      const a = algos[i]
      setProgress(`simulating ${DECODERS.find((d) => d.id === a)!.short}…`)
      acc[a] = waterfall(code, a, EBN0_LIST, maxIter, { ...budget, seed: 20260711 + i * 7 })
      i++
      if (i < algos.length) {
        setTimeout(step, 0)
      } else {
        setCurves(acc as Record<DecoderAlgo, WaterfallPoint[]>)
        setRunning(false)
        setProgress('')
      }
    }
    const id = setTimeout(step, 0)
    return () => {
      cancelled = true
      clearTimeout(id)
    }
  }, [code, maxIter, budget, runNonce])

  const rerun = () => setRunNonce((n) => n + 1)

  const shannon = shannonLimitDb(code.rate)

  const { ref, size } = useDprCanvas()
  useEffect(() => {
    const ctx = prepareContext(ref.current, size)
    if (!ctx) return
    const { width: w, height: h } = size
    const pad = { l: 50, r: 14, t: 16, b: 30 }
    const r: Rect = { x: pad.l, y: pad.t, w: w - pad.l - pad.r, h: h - pad.t - pad.b }
    fillPlotBg(ctx, { x: 0, y: 0, w, h })
    const topExp = 0
    const botExp = -6
    const X = (db: number) => r.x + ((db - XMIN) / (XMAX - XMIN)) * r.w
    const Y = (val: number) => {
      const e = Math.log10(Math.max(val, 1e-7))
      const t = (e - topExp) / (botExp - topExp)
      return r.y + Math.max(0, Math.min(1, t)) * r.h
    }
    // decade gridlines
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

    // uncoded BPSK baseline
    ctx.strokeStyle = INK
    ctx.lineWidth = 2
    ctx.beginPath()
    let started = false
    for (let db = XMIN; db <= XMAX; db += 0.1) {
      const x = X(db)
      const y = Y(uncodedBer(db))
      if (!started) {
        ctx.moveTo(x, y)
        started = true
      } else ctx.lineTo(x, y)
    }
    ctx.stroke()

    // Shannon limit (rate-dependent) vertical line
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

    // measured decoder curves
    if (curves) {
      for (const a of ['ms', 'oms', 'nms', 'sp'] as DecoderAlgo[]) {
        const pts = curves[a]
        if (!pts) continue
        const col = DEC_COLOR[a]
        ctx.strokeStyle = col
        ctx.lineWidth = a === 'sp' ? 2.4 : 1.6
        ctx.beginPath()
        let s = false
        for (const p of pts) {
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
        for (const p of pts) {
          const val = metric === 'ber' ? p.ber : p.bler
          if (val <= 0) continue
          ctx.fillStyle = col
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
      ['uncoded BPSK', INK],
      ['sum-product', VIOLET],
      ['norm min-sum', BLUE],
      ['offset min-sum', AMBER],
      ['min-sum', ROSE],
    ]
    legend.forEach(([txt, col], i) => {
      const ly = r.y + 10 + i * 15
      ctx.strokeStyle = col
      ctx.lineWidth = 2.2
      ctx.beginPath()
      ctx.moveTo(r.x + r.w - 132, ly)
      ctx.lineTo(r.x + r.w - 112, ly)
      ctx.stroke()
      axisLabel(ctx, txt, r.x + r.w - 106, ly + 3, 'left')
    })
  }, [ref, size, curves, metric, shannon, code.rate])

  const onShare = () => {
    shareLink('ldpc', { tab: 'waterfall', wcode: codeId, wmax: maxIter, weff: effort, wmet: metric }).then(
      (ok) => {
        if (ok) {
          setCopied(true)
          setTimeout(() => setCopied(false), 1400)
        }
      },
    )
  }

  // A readable operating-point summary at a fixed reference SNR.
  const refDb = 3
  const summary = curves
    ? (['sp', 'nms', 'oms', 'ms'] as DecoderAlgo[]).map((a) => {
        const pts = curves[a]
        const pt = pts?.find((p) => Math.abs(p.ebn0Db - refDb) < 1e-6)
        return { a, ber: pt?.ber ?? 0, iter: pt?.avgIter ?? 0 }
      })
    : []

  return (
    <div className="mode">
      <div className="mode-side">
        <Panel title="Simulation">
          <Field label="Code">
            <Select value={codeId} options={CODE_OPTIONS} onChange={setCodeId} />
          </Field>
          <Field label="Max iterations" value={`${maxIter}`}>
            <Slider min={4} max={50} step={1} value={maxIter} onChange={(v) => setMaxIter(Math.round(v))} />
          </Field>
          <Field label="Metric">
            <Segmented
              value={metric}
              options={[
                { id: 'ber', label: 'BER' },
                { id: 'bler', label: 'BLER' },
              ]}
              onChange={(v) => setMetric(v as 'ber' | 'bler')}
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
              onChange={(v) => setEffort(v as 'quick' | 'balanced' | 'deep')}
            />
          </Field>
          <div className="btn-row">
            <Button variant="primary" onClick={rerun}>
              {running ? 'Running…' : 'Re-run'}
            </Button>
            <Button variant="ghost" onClick={onShare}>
              {copied ? 'Copied ✓' : 'Copy link'}
            </Button>
          </div>
          <p className="hint">
            {running ? (
              <>Monte-Carlo in progress — {progress}</>
            ) : (
              <>
                Rate {code.rate.toFixed(3)} · Shannon limit <em>{shannon.toFixed(2)} dB</em>. Each point
                accumulates blocks until it has enough frame errors for a stable estimate. The all-zero
                codeword is used (valid for any linear code on a symmetric channel).
              </>
            )}
          </p>
        </Panel>

        {summary.length > 0 && (
          <Panel title={`At ${refDb} dB`}>
            <div className="spec-table">
              <div className="spec-row" style={{ opacity: 0.7 }}>
                <span className="spec-name">decoder</span>
                <span className="spec-cost">BER · avg iters</span>
              </div>
              {summary.map((s) => (
                <div className="spec-row" key={s.a}>
                  <span className="spec-name" style={{ color: DEC_COLOR[s.a] }}>
                    {DECODERS.find((d) => d.id === s.a)!.short}
                  </span>
                  <span className="spec-cost">
                    {s.ber > 0 ? s.ber.toExponential(1) : '—'} · {s.iter.toFixed(1)}
                  </span>
                </div>
              ))}
            </div>
            <p className="hint">
              Sum-product is the exact optimum; <em>normalised min-sum</em> claws most of the gap back
              with only shifts and comparisons — which is why it, not sum-product, is what ships in
              silicon.
            </p>
          </Panel>
        )}
      </div>

      <div className="mode-main">
        <p className="mode-intro">
          The <strong>waterfall</strong>: bit- (or block-) error rate versus Eb/N0. Coding buys you a
          steep cliff far to the left of uncoded BPSK — most of the gain toward the{' '}
          <strong>Shannon limit</strong> for this rate. Compare the exact sum-product decoder against
          the cheap <strong>min-sum</strong> family the hardware actually uses.
        </p>
        <CanvasCard title={`${metric.toUpperCase()} waterfall — ${code.label}`} note="log scale · dots = Monte-Carlo" height={400}>
          <canvas ref={ref} />
        </CanvasCard>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Tab 3 — the code itself: H sparsity, degree distribution, girth
// ---------------------------------------------------------------------------

/** A small degree-distribution bar chart (bucket index = node degree). */
function Histogram({ degrees, color, label }: { degrees: number[]; color: string; label: string }) {
  const { ref, size } = useDprCanvas()
  useEffect(() => {
    const ctx = prepareContext(ref.current, size)
    if (!ctx) return
    const { width: w, height: h } = size
    const pad = { l: 28, r: 8, t: 10, b: 20 }
    const r: Rect = { x: pad.l, y: pad.t, w: w - pad.l - pad.r, h: h - pad.t - pad.b }
    fillPlotBg(ctx, { x: 0, y: 0, w, h })
    const maxCount = Math.max(1, ...degrees)
    const nb = degrees.length
    const bw = r.w / Math.max(1, nb)
    for (let d = 0; d < nb; d++) {
      const cnt = degrees[d]
      if (!cnt) continue
      const bh = (cnt / maxCount) * r.h * 0.9
      ctx.fillStyle = color
      ctx.fillRect(r.x + d * bw + bw * 0.15, r.y + r.h - bh, bw * 0.7, bh)
      axisLabel(ctx, `${d}`, r.x + d * bw + bw / 2, r.y + r.h + 15, 'center')
    }
    axisLabel(ctx, label, r.x, r.y + 2, 'left')
    axisLabel(ctx, `${maxCount}`, r.x - 4, r.y + 9, 'right')
  }, [ref, size, degrees, color, label])
  return (
    <div className="canvas-wrap" style={{ height: 110 }}>
      <canvas ref={ref} />
    </div>
  )
}

function CodeTab() {
  const sp = useMemo(() => readHashParams(), [])
  const [codeId, setCodeId] = useState(() => readStr(sp, 'ccode', 'peg_96_48', CODE_OPTIONS.map((c) => c.id)))
  const [copied, setCopied] = useState(false)
  const code = useMemo(() => codeById(codeId), [codeId])
  const g = useMemo(() => girth(code), [code])
  const stats = useMemo(() => degreeStats(code), [code])

  // --- H sparsity pattern ---
  const { ref, size } = useDprCanvas()
  useEffect(() => {
    const ctx = prepareContext(ref.current, size)
    if (!ctx) return
    const { width: w, height: h } = size
    fillPlotBg(ctx, { x: 0, y: 0, w, h })
    const pad = 10
    const cw = (w - 2 * pad) / code.n
    const ch = (h - 2 * pad) / code.m
    const dot = Math.max(1, Math.min(cw, ch) * 0.9)
    for (let c = 0; c < code.m; c++) {
      for (const v of code.checkNodes[c]) {
        const x = pad + v * cw + cw / 2
        const y = pad + c * ch + ch / 2
        ctx.fillStyle = TEAL
        ctx.fillRect(x - dot / 2, y - dot / 2, dot, dot)
      }
    }
  }, [ref, size, code])

  const density = code.edgeVar.length / (code.n * code.m)
  const onShare = () => {
    shareLink('ldpc', { tab: 'code', ccode: codeId }).then((ok) => {
      if (ok) {
        setCopied(true)
        setTimeout(() => setCopied(false), 1400)
      }
    })
  }

  return (
    <div className="mode">
      <div className="mode-side">
        <Panel title="Code">
          <Field label="Code">
            <Select value={codeId} options={CODE_OPTIONS} onChange={setCodeId} />
          </Field>
          <Readout
            items={[
              { label: 'Length n', value: `${code.n}` },
              { label: 'Message k', value: `${code.k}` },
              { label: 'Rate', value: code.rate.toFixed(3) },
              { label: 'Checks m', value: `${code.m}` },
              { label: 'Rank(H)', value: `${code.rank}` },
              { label: 'Girth', value: g === Infinity ? '∞' : `${g}` },
            ]}
          />
          <div className="btn-row">
            <Button variant="ghost" onClick={onShare}>
              {copied ? 'Copied ✓' : 'Copy link'}
            </Button>
          </div>
          <p className="hint">
            <em>Low-density</em> is literal: only {(density * 100).toFixed(1)}% of H is non-zero
            ({code.edgeVar.length} ones in an {code.m}×{code.n} matrix). Sparsity is what makes belief
            propagation near-linear-time — and a large <em>girth</em> (shortest cycle {g === Infinity ? '∞' : g})
            is what keeps its messages nearly independent, so it actually converges.
          </p>
        </Panel>
        <Panel title="Degree profile">
          <Readout
            items={[
              { label: 'Bit deg', value: stats.minVar === stats.maxVar ? `${stats.minVar}` : `${stats.minVar}–${stats.maxVar}` },
              { label: 'Check deg', value: stats.minCheck === stats.maxCheck ? `${stats.minCheck}` : `${stats.minCheck}–${stats.maxCheck}` },
              { label: 'Avg bit', value: stats.avgVar.toFixed(2) },
              { label: 'Avg check', value: stats.avgCheck.toFixed(2) },
            ]}
          />
          <div className="split-2" style={{ marginTop: 10 }}>
            <Histogram degrees={stats.varDegrees} color={BLUE} label="bit-node degree" />
            <Histogram degrees={stats.checkDegrees} color={VIOLET} label="check-node degree" />
          </div>
        </Panel>
      </div>
      <div className="mode-main">
        <p className="mode-intro">
          Every LDPC code <em>is</em> its parity-check matrix <strong>H</strong> — one dot per edge of
          the Tanner graph, a check per row, a bit per column. A near-empty matrix, a wide girth, a
          flat degree profile: those three properties are the entire art of code design.
        </p>
        <CanvasCard title={`H — sparsity pattern (${code.m}×${code.n})`} note="teal = a 1 (a graph edge)" height={360}>
          <canvas ref={ref} />
        </CanvasCard>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------

export default function LDPC() {
  const sp = useMemo(() => readHashParams(), [])
  const [tab, setTab] = useState<'graph' | 'waterfall' | 'code'>(() =>
    readStr(sp, 'tab', 'graph', ['graph', 'waterfall', 'code'] as const),
  )
  return (
    <div className="mode-wrap">
      <div className="mode-tabs">
        <Segmented
          value={tab}
          options={[
            { id: 'graph', label: 'Belief propagation' },
            { id: 'waterfall', label: 'Waterfall' },
            { id: 'code', label: 'The code' },
          ]}
          onChange={setTab}
        />
      </div>
      {tab === 'graph' && <GraphTab />}
      {tab === 'waterfall' && <WaterfallTab />}
      {tab === 'code' && <CodeTab />}
    </div>
  )
}
