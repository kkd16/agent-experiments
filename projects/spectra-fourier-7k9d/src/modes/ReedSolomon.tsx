import { useEffect, useMemo, useState } from 'react'
import { CanvasCard } from '../components/CanvasCard'
import { Panel, Field, Slider, Select, Segmented, Toggle, Button, Readout } from '../components/Controls'
import { useDprCanvas, prepareContext } from '../hooks/useDprCanvas'
import { fillPlotBg, grid, axisLabel } from '../lib/draw'
import type { Rect } from '../lib/draw'
import { readHashParams, shareLink, readNum, readStr, readBool } from '../lib/urlState'
import {
  RS_CODES,
  rsById,
  rsGenerator,
  rsEncode,
  rsDecode,
  rsRng,
  randomMessage,
  rsBlockErrorProb,
  rsOutputSymbolErrorProb,
  type GF,
} from '../lib/rs'
import { runConcatFrame, concatWaterfall, type ConcatFrame, type ConcatPoint } from '../lib/rschain'

const TEAL = '#5eead4'
const BLUE = '#38bdf8'
const VIOLET = '#a78bfa'
const ROSE = '#fb7185'
const AMBER = '#fbbf24'

const CODE_OPTIONS = RS_CODES.map((c) => ({ id: c.id, label: c.label }))
// Codes small enough to draw every symbol as a clickable cell.
const SMALL_CODES = RS_CODES.filter((c) => c.n <= 31).map((c) => ({ id: c.id, label: c.label }))

// --- field element formatting ------------------------------------------------
function fmtElem(f: GF, v: number): string {
  if (v === 0) return '0'
  if (v === 1) return '1'
  return `α${sup(f.log[v])}`
}
function sup(n: number): string {
  const map: Record<string, string> = { '0': '⁰', '1': '¹', '2': '²', '3': '³', '4': '⁴', '5': '⁵', '6': '⁶', '7': '⁷', '8': '⁸', '9': '⁹' }
  return String(n).split('').map((d) => map[d] ?? d).join('')
}
function hex(f: GF, v: number): string {
  return f.m <= 4 ? v.toString(16).toUpperCase() : v.toString(16).toUpperCase().padStart(2, '0')
}
/** A polynomial (index-0-high) as a readable string in α-powers. */
function polyString(f: GF, p: number[], varName = 'x'): string {
  const deg = p.length - 1
  const terms: string[] = []
  for (let i = 0; i < p.length; i++) {
    const c = p[i]
    if (c === 0) continue
    const power = deg - i
    const cs = c === 1 && power !== 0 ? '' : fmtElem(f, c)
    const xs = power === 0 ? '' : power === 1 ? varName : `${varName}${sup(power)}`
    terms.push((cs && xs ? cs + '·' : cs) + xs || '1')
  }
  return terms.length ? terms.join(' + ') : '0'
}

// ===========================================================================
// Tab 1 — the algebraic decode pipeline
// ===========================================================================

type Corruption = { kind: 'error' | 'erase'; delta: number }

function DecodeTab() {
  const sp = useMemo(() => readHashParams(), [])
  const [codeId, setCodeId] = useState(() => readStr(sp, 'dcode', 'rs15_11', SMALL_CODES.map((c) => c.id)))
  const [seed, setSeed] = useState(() => readNum(sp, 'dseed', 7))
  const [corrupt, setCorrupt] = useState<Map<number, Corruption>>(new Map())
  const [copied, setCopied] = useState(false)

  const code = useMemo(() => rsById(codeId), [codeId])
  const f = code.field
  const gen = useMemo(() => rsGenerator(code), [code])
  const message = useMemo(() => randomMessage(code, rsRng(seed)), [code, seed])
  const codeword = useMemo(() => rsEncode(code, message, gen), [code, message, gen])

  // Reset corruptions when the code or message changes.
  const [prevKey, setPrevKey] = useState(codeId + seed)
  if (prevKey !== codeId + seed) {
    setPrevKey(codeId + seed)
    setCorrupt(new Map())
  }

  const received = useMemo(() => {
    const r = codeword.slice()
    for (const [pos, c] of corrupt) r[pos] = codeword[pos] ^ c.delta
    return r
  }, [codeword, corrupt])

  const erasures = useMemo(() => [...corrupt.entries()].filter(([, c]) => c.kind === 'erase').map(([p]) => p), [corrupt])
  const dec = useMemo(() => rsDecode(code, received, erasures), [code, received, erasures])

  const nErr = [...corrupt.values()].filter((c) => c.kind === 'error').length
  const nEra = erasures.length
  const budget = 2 * nErr + nEra

  const cycle = (pos: number) => {
    setCorrupt((prev) => {
      const next = new Map(prev)
      const cur = next.get(pos)
      const rng = rsRng(pos * 2654435761 + 1)
      let delta = 0
      while (delta === 0) delta = Math.floor(rng() * f.size)
      if (!cur) next.set(pos, { kind: 'error', delta })
      else if (cur.kind === 'error') next.set(pos, { kind: 'erase', delta: cur.delta })
      else next.delete(pos)
      return next
    })
  }

  const share = () => {
    shareLink('reedsolomon', { tab: 'decode', dcode: codeId, dseed: seed }).then((ok) => {
      if (ok) {
        setCopied(true)
        setTimeout(() => setCopied(false), 1400)
      }
    })
  }

  const posSet = new Set(dec.errPositions)
  const located = dec.ok ? posSet : new Set<number>()

  return (
    <div className="mode">
      <div className="mode-side">
        <Panel title="Code">
          <Field label="Reed–Solomon code">
            <Select value={codeId} options={SMALL_CODES} onChange={setCodeId} />
          </Field>
          <Field label="Random message" value={`seed ${seed}`}>
            <Slider min={0} max={40} step={1} value={seed} onChange={setSeed} />
          </Field>
          <Readout
            items={[
              { label: 'n', value: String(code.n) },
              { label: 'k', value: String(code.k) },
              { label: '2t', value: String(code.nsym) },
              { label: 't', value: String(code.t) },
            ]}
          />
          <p className="mode-note">
            g(x) = ∏<sub>i=0</sub><sup>{code.nsym}−1</sup>(x − α<sup>{code.fcr}+i</sup>), degree {code.nsym}. Every codeword is a
            multiple of g, so it is a zero of all {code.nsym} check roots.
          </p>
        </Panel>
        <Panel title="Corrupt the codeword">
          <p className="mode-note">
            Click a symbol to cycle it: <span style={{ color: ROSE }}>error</span> (unknown value) →{' '}
            <span style={{ color: AMBER }}>erasure</span> (known-lost) → clean. The decoder fixes any e errors and f
            erasures with <strong>2e + f ≤ {code.nsym}</strong>.
          </p>
          <Readout
            items={[
              { label: 'errors e', value: String(nErr) },
              { label: 'erasures f', value: String(nEra) },
              { label: '2e+f', value: `${budget}/${code.nsym}` },
            ]}
          />
          <div style={{ display: 'flex', gap: 8, marginTop: 4 }}>
            <Button variant="ghost" onClick={() => setCorrupt(new Map())}>
              Clear
            </Button>
            <Button variant="ghost" onClick={share}>
              {copied ? 'Copied ✓' : 'Share'}
            </Button>
          </div>
        </Panel>
      </div>

      <div className="mode-main">
        <p className="mode-intro">
          A <strong>Reed–Solomon</strong> code decodes by <em>algebra</em>, not search. The syndromes
          measure the error as seen from the {code.nsym} check frequencies; <strong>Berlekamp–Massey</strong> solves
          them for the error-locator polynomial Λ(x); a <strong>Chien search</strong> finds its roots (the error
          positions); and <strong>Forney</strong> reads off each error's exact value. Corrupt the word and watch the
          machine locate and repair it.
        </p>

        <div className="rs-block">
          <div className="rs-block-head">
            transmitted codeword — <span style={{ color: TEAL }}>data</span> · <span style={{ color: BLUE }}>parity</span>
          </div>
          <SymbolStrip
            f={f}
            values={codeword}
            k={code.k}
            onClick={cycle}
            classify={(i) => (i < code.k ? 'data' : 'parity')}
          />
        </div>

        <div className="rs-block">
          <div className="rs-block-head">received — after the channel</div>
          <SymbolStrip
            f={f}
            values={received}
            k={code.k}
            onClick={cycle}
            classify={(i) => {
              const c = corrupt.get(i)
              if (c?.kind === 'error') return 'err'
              if (c?.kind === 'erase') return 'erase'
              return i < code.k ? 'data' : 'parity'
            }}
          />
        </div>

        <div className="rs-pipeline">
          <div className="rs-stage">
            <div className="rs-stage-head">1 · syndromes S<sub>j</sub> = r(α<sup>{code.fcr}+j</sup>)</div>
            <div className="rs-synd-row">
              {dec.syndromes.map((s, j) => (
                <span key={j} className={`rs-synd ${s === 0 ? 'zero' : 'nz'}`} title={`S${j}`}>
                  {fmtElem(f, s)}
                </span>
              ))}
            </div>
            <div className="rs-stage-note">
              {dec.syndromes.every((s) => s === 0)
                ? 'all zero → r is already a valid codeword'
                : 'not all zero → the word carries errors'}
            </div>
          </div>

          <div className="rs-stage">
            <div className="rs-stage-head">2 · error locator Λ(x) — Berlekamp–Massey</div>
            <div className="rs-poly">{dec.errLoc.length ? polyString(f, dec.errLoc) : '—'}</div>
            <div className="rs-stage-note">
              degree {Math.max(0, dec.errLoc.length - 1)} → up to {Math.max(0, dec.errLoc.length - 1)} error locations
            </div>
          </div>

          <div className="rs-stage">
            <div className="rs-stage-head">3 · locations (Chien) · 4 · magnitudes (Forney)</div>
            {dec.ok && dec.errPositions.length > 0 ? (
              <div className="rs-fix-list">
                {dec.errPositions.map((p, i) => (
                  <span key={p} className="rs-fix">
                    pos {p} <span className="rs-fix-mag">⊕ {fmtElem(f, dec.magnitudes[i])}</span>
                  </span>
                ))}
              </div>
            ) : (
              <div className="rs-stage-note">{dec.ok ? 'nothing to fix' : '—'}</div>
            )}
          </div>
        </div>

        <div className="rs-block">
          <div className="rs-block-head">corrected codeword</div>
          <SymbolStrip
            f={f}
            values={dec.corrected}
            k={code.k}
            classify={(i) => {
              if (!dec.ok) return corrupt.has(i) ? 'err' : i < code.k ? 'data' : 'parity'
              if (located.has(i)) return 'fixed'
              return i < code.k ? 'data' : 'parity'
            }}
          />
        </div>

        <div className={`rs-verdict ${dec.ok ? 'ok' : 'no'}`}>
          {dec.ok
            ? budget === 0
              ? 'No errors — the received word was already a valid codeword.'
              : `Recovered — ${dec.errorsCorrected} located error${dec.errorsCorrected === 1 ? '' : 's'} + ${nEra} erasure${nEra === 1 ? '' : 's'}, 2e+f = ${budget} ≤ 2t = ${code.nsym}. Every syndrome is zero again.`
            : `Uncorrectable (and detected): 2e+f = ${budget} exceeds 2t = ${code.nsym}. The decoder refuses to guess.`}
        </div>
      </div>
    </div>
  )
}

function SymbolStrip({
  f,
  values,
  k,
  onClick,
  classify,
}: {
  f: GF
  values: number[]
  k: number
  onClick?: (i: number) => void
  classify: (i: number) => string
}) {
  return (
    <div className="rs-strip">
      {values.map((v, i) => (
        <button
          key={i}
          type="button"
          className={`rs-cell ${classify(i)}${onClick ? ' click' : ''}`}
          onClick={onClick ? () => onClick(i) : undefined}
          title={`index ${i} · ${i < k ? 'data' : 'parity'} · ${fmtElem(f, v)}`}
        >
          {hex(f, v)}
        </button>
      ))}
    </div>
  )
}

// ===========================================================================
// Tab 2 — burst errors & cross-interleaving (the CD / QR story)
// ===========================================================================

function BurstTab() {
  const sp = useMemo(() => readHashParams(), [])
  const [codeId, setCodeId] = useState(() => readStr(sp, 'bcode', 'rs15_11', SMALL_CODES.map((c) => c.id)))
  const [rows, setRows] = useState(() => readNum(sp, 'brows', 6))
  const [burst, setBurst] = useState(() => readNum(sp, 'bburst', 5))
  const [start, setStart] = useState(() => readNum(sp, 'bstart', 20))
  const [interleave, setInterleave] = useState(() => readBool(sp, 'bintl', true))
  const [copied, setCopied] = useState(false)

  const code = useMemo(() => rsById(codeId), [codeId])
  const I = rows
  const n = code.n

  // Build I codewords, lay them out, and hit a contiguous burst on the wire.
  const model = useMemo(() => {
    const rng = rsRng(4242)
    const codewords: number[][] = []
    for (let i = 0; i < I; i++) codewords.push(rsEncode(code, randomMessage(code, rng)))
    const total = I * n
    // transmit order → (row, col) for a wire index
    const wireToRC = (w: number): [number, number] =>
      interleave ? [w % I, Math.floor(w / I)] : [Math.floor(w / n), w % n]
    const bstart = Math.min(start, total - burst)
    const hit = new Set<number>() // wire indices in the burst
    for (let w = bstart; w < bstart + burst; w++) hit.add(w)
    // apply: each hit symbol becomes an error
    const rx = codewords.map((c) => c.slice())
    const errFlag: boolean[][] = codewords.map((c) => c.map(() => false))
    for (const w of hit) {
      const [r, cIdx] = wireToRC(w)
      const drng = rsRng(w * 40503 + 1)
      let d = 0
      while (d === 0) d = Math.floor(drng() * code.field.size)
      rx[r][cIdx] ^= d
      errFlag[r][cIdx] = true
    }
    // decode each codeword
    const recovered: boolean[] = []
    const errCount: number[] = []
    for (let r = 0; r < I; r++) {
      const ec = errFlag[r].filter(Boolean).length
      errCount.push(ec)
      const dec = rsDecode(code, rx[r])
      recovered.push(dec.ok && !dec.corrected.some((v, j) => v !== codewords[r][j]))
    }
    return { errFlag, recovered, errCount, bstart, total }
  }, [code, I, n, burst, start, interleave])

  const nRecovered = model.recovered.filter(Boolean).length

  const { ref, size } = useDprCanvas()
  useEffect(() => {
    const ctx = prepareContext(ref.current, size)
    if (!ctx) return
    const { width: w, height: h } = size
    const r: Rect = { x: 0, y: 0, w, h }
    fillPlotBg(ctx, r)
    const padL = 96
    const padT = 26
    const padB = 16
    const padR = 14
    const gw = w - padL - padR
    const gh = h - padT - padB
    const cw = gw / n
    const ch = Math.min(gh / I, 26)
    const gridH = ch * I

    for (let row = 0; row < I; row++) {
      for (let col = 0; col < n; col++) {
        const x = padL + col * cw
        const y = padT + row * ch
        const err = model.errFlag[row][col]
        const recov = model.recovered[row]
        ctx.fillStyle = err
          ? recov
            ? 'rgba(94,234,212,0.95)' // corrected
            : 'rgba(251,113,133,0.95)' // failed
          : col < code.k
            ? 'rgba(56,189,248,0.34)'
            : 'rgba(167,139,250,0.34)'
        ctx.fillRect(x + 1, y + 1, Math.max(cw - 2, 1), ch - 2)
        ctx.strokeStyle = 'rgba(7,9,18,0.85)'
        ctx.lineWidth = 1
        ctx.strokeRect(x + 0.5, y + 0.5, cw - 1, ch - 1)
      }
      // row label + status
      ctx.fillStyle = model.recovered[row] ? TEAL : ROSE
      ctx.font = '11px JetBrains Mono, ui-monospace, monospace'
      ctx.textAlign = 'right'
      ctx.textBaseline = 'middle'
      ctx.fillText(
        `cw ${row} · ${model.errCount[row]}${model.recovered[row] ? '✓' : '✗'}`,
        padL - 8,
        padT + row * ch + ch / 2,
      )
    }
    axisLabel(ctx, interleave ? 'symbol index within codeword →' : 'wire order →', padL, padT - 10, 'left')
    axisLabel(ctx, `t = ${code.t}`, w - padR, padT - 10, 'right')
    // divider between data and parity columns
    ctx.strokeStyle = 'rgba(226,232,240,0.25)'
    ctx.setLineDash([3, 3])
    const xd = padL + code.k * cw
    ctx.beginPath()
    ctx.moveTo(xd, padT)
    ctx.lineTo(xd, padT + gridH)
    ctx.stroke()
    ctx.setLineDash([])
  }, [ref, size, model, n, I, code, interleave])

  const share = () => {
    shareLink('reedsolomon', {
      tab: 'burst',
      bcode: codeId,
      brows: rows,
      bburst: burst,
      bstart: start,
      bintl: interleave,
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
        <Panel title="Frame">
          <Field label="Code">
            <Select value={codeId} options={SMALL_CODES} onChange={setCodeId} />
          </Field>
          <Field label="Codewords (interleave depth)" value={String(rows)}>
            <Slider min={2} max={12} step={1} value={rows} onChange={setRows} />
          </Field>
          <Field label="Burst length (symbols)" value={String(burst)}>
            <Slider min={1} max={Math.min(model.total, 2 * rows * code.t + 4)} step={1} value={burst} onChange={setBurst} />
          </Field>
          <Field label="Burst start" value={String(model.bstart)}>
            <Slider min={0} max={Math.max(0, model.total - burst)} step={1} value={start} onChange={setStart} />
          </Field>
          <Toggle label="Cross-interleave the symbols" checked={interleave} onChange={setInterleave} />
          <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
            <Button variant="ghost" onClick={share}>
              {copied ? 'Copied ✓' : 'Share'}
            </Button>
          </div>
        </Panel>
        <Panel title="Outcome">
          <Readout
            items={[
              { label: 'codewords', value: String(I) },
              { label: 'recovered', value: `${nRecovered}/${I}` },
              { label: 'burst', value: String(burst) },
            ]}
          />
          <p className="mode-note">
            {interleave
              ? `Interleaved: a burst of ${burst} spreads to at most ⌈${burst}/${I}⌉ = ${Math.ceil(burst / I)} symbols per codeword. Each stays ≤ t = ${code.t}, so all recover.`
              : `Un-interleaved: the whole burst lands in one codeword. Past ${code.t} errors it is lost.`}
          </p>
        </Panel>
      </div>
      <div className="mode-main">
        <p className="mode-intro">
          A scratch on a CD, a coffee stain on a QR code, a fade on a radio link — real errors come in{' '}
          <strong>bursts</strong>. One RS codeword only survives t of them. The trick that made the compact disc
          possible is <strong>cross-interleaving</strong>: scatter each codeword's symbols across the frame so a
          burst is chopped into one-per-codeword crumbs, each easily corrected. Toggle it and drag the scratch.
        </p>
        <CanvasCard title="the frame — one row per codeword, the burst in red" height={340}>
          <canvas ref={ref} />
        </CanvasCard>
        <p className="mode-note">
          Blue/violet = intact data/parity symbols · <span style={{ color: ROSE }}>red = a burst error that broke its codeword</span> ·{' '}
          <span style={{ color: TEAL }}>teal = a burst error the code corrected</span>. The dashed line splits data from parity.
        </p>
      </div>
    </div>
  )
}

// ===========================================================================
// Tab 3 — the waterfall: Monte-Carlo vs the closed-form theory
// ===========================================================================

function WaterfallTab() {
  const sp = useMemo(() => readHashParams(), [])
  const [codeId, setCodeId] = useState(() => readStr(sp, 'wcode', 'rs15_11', CODE_OPTIONS.map((c) => c.id)))
  const [ps, setPs] = useState(() => readNum(sp, 'wps', 0.1))
  const [copied, setCopied] = useState(false)

  const code = useMemo(() => rsById(codeId), [codeId])

  // Monte-Carlo across a log-spaced set of channel symbol-error rates.
  const points = useMemo(() => {
    const psList: number[] = []
    for (let e = -2.6; e <= -0.15; e += 0.2) psList.push(Math.pow(10, e))
    const rng = rsRng(20260703)
    const gen = rsGenerator(code)
    return psList.map((p) => {
      // budget: enough blocks to see ~40 block errors, capped for the big field.
      const maxBlocks = code.n > 100 ? 1600 : 6000
      const minBlocks = 200
      let blocks = 0
      let blockErr = 0
      let symErr = 0
      while (blocks < maxBlocks && (blockErr < 40 || blocks < minBlocks)) {
        const cw = rsEncode(code, randomMessage(code, rng), gen)
        const r = cw.slice()
        for (let i = 0; i < code.n; i++) {
          if (rng() < p) {
            let d = 0
            while (d === 0) d = Math.floor(rng() * code.field.size)
            r[i] ^= d
          }
        }
        const dec = rsDecode(code, r)
        const wrong = !dec.ok || dec.corrected.some((v, i) => v !== cw[i])
        if (wrong) {
          blockErr++
          // residual symbol errors: if uncorrectable we leave the received errors in
          const src = dec.ok ? dec.corrected : r
          for (let i = 0; i < code.n; i++) if (src[i] !== cw[i]) symErr++
        }
        blocks++
      }
      return {
        ps: p,
        blockMeasured: blockErr / blocks,
        symMeasured: symErr / (blocks * code.n),
        blockTheory: rsBlockErrorProb(code, p),
        symTheory: rsOutputSymbolErrorProb(code, p),
        blocks,
      }
    })
  }, [code])

  const { ref, size } = useDprCanvas()
  useEffect(() => {
    const ctx = prepareContext(ref.current, size)
    if (!ctx) return
    const { width: w, height: h } = size
    const r: Rect = { x: 44, y: 16, w: w - 60, h: h - 44 }
    fillPlotBg(ctx, { x: 0, y: 0, w, h })
    grid(ctx, r, 8, 6)

    const xmin = -2.6
    const xmax = -0.15 // log10 ps
    const ymin = -6
    const ymax = 0 // log10 rate
    const X = (lp: number) => r.x + ((lp - xmin) / (xmax - xmin)) * r.w
    const Y = (rate: number) => {
      const ly = Math.log10(Math.max(rate, 1e-7))
      return r.y + (1 - (ly - ymin) / (ymax - ymin)) * r.h
    }

    // axes labels
    for (let e = Math.ceil(xmin); e <= xmax; e++) {
      const x = X(e)
      ctx.strokeStyle = 'rgba(120,140,220,0.10)'
      ctx.beginPath()
      ctx.moveTo(x, r.y)
      ctx.lineTo(x, r.y + r.h)
      ctx.stroke()
      axisLabel(ctx, `10${sup(e)}`, x, r.y + r.h + 15, 'center')
    }
    for (let e = ymin; e <= ymax; e++) {
      axisLabel(ctx, `10${sup(e)}`, r.x - 6, Y(Math.pow(10, e)) + 3, 'right')
    }

    // the uncoded diagonal: output symbol error = input ps
    ctx.strokeStyle = 'rgba(226,232,240,0.6)'
    ctx.lineWidth = 1.6
    ctx.setLineDash([4, 4])
    ctx.beginPath()
    for (let lp = xmin; lp <= xmax; lp += 0.05) {
      const x = X(lp)
      const y = Y(Math.pow(10, lp))
      if (lp === xmin) ctx.moveTo(x, y)
      else ctx.lineTo(x, y)
    }
    ctx.stroke()
    ctx.setLineDash([])

    const theoryLine = (fn: (p: number) => number, color: string) => {
      ctx.strokeStyle = color
      ctx.lineWidth = 2
      ctx.beginPath()
      let started = false
      for (let lp = xmin; lp <= xmax; lp += 0.03) {
        const p = Math.pow(10, lp)
        const v = fn(p)
        if (v <= 0) continue
        const x = X(lp)
        const y = Y(v)
        if (!started) {
          ctx.moveTo(x, y)
          started = true
        } else ctx.lineTo(x, y)
      }
      ctx.stroke()
    }
    theoryLine((p) => rsBlockErrorProb(code, p), VIOLET)
    theoryLine((p) => rsOutputSymbolErrorProb(code, p), BLUE)

    const dot = (lp: number, v: number, color: string) => {
      if (v <= 0) return
      ctx.fillStyle = color
      ctx.beginPath()
      ctx.arc(X(lp), Y(v), 3, 0, Math.PI * 2)
      ctx.fill()
    }
    for (const p of points) {
      dot(Math.log10(p.ps), p.blockMeasured, VIOLET)
      dot(Math.log10(p.ps), p.symMeasured, BLUE)
    }

    // operating marker
    const mx = X(Math.log10(ps))
    ctx.strokeStyle = 'rgba(94,234,212,0.55)'
    ctx.setLineDash([3, 4])
    ctx.beginPath()
    ctx.moveTo(mx, r.y)
    ctx.lineTo(mx, r.y + r.h)
    ctx.stroke()
    ctx.setLineDash([])

    axisLabel(ctx, 'channel symbol-error rate p →', r.x + r.w, r.y + r.h + 15, 'right')
    axisLabel(ctx, 'error rate', r.x, r.y - 4, 'left')

    const legend: [string, string][] = [
      ['uncoded (= p)', 'rgba(226,232,240,0.8)'],
      ['block error', VIOLET],
      ['output symbol error', BLUE],
    ]
    legend.forEach(([txt, col], i) => {
      const ly = r.y + 10 + i * 15
      const lx = r.x + 14
      ctx.strokeStyle = col
      ctx.lineWidth = 2
      ctx.beginPath()
      ctx.moveTo(lx, ly)
      ctx.lineTo(lx + 18, ly)
      ctx.stroke()
      axisLabel(ctx, txt, lx + 24, ly + 3, 'left')
    })
  }, [ref, size, points, code, ps])

  const marker = useMemo(
    () => ({ block: rsBlockErrorProb(code, ps), sym: rsOutputSymbolErrorProb(code, ps) }),
    [code, ps],
  )

  const share = () => {
    shareLink('reedsolomon', { tab: 'waterfall', wcode: codeId, wps: ps }).then((ok) => {
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
          <Field label="Reed–Solomon code">
            <Select value={codeId} options={CODE_OPTIONS} onChange={setCodeId} />
          </Field>
          <Readout
            items={[
              { label: 'n', value: String(code.n) },
              { label: 'k', value: String(code.k) },
              { label: 't', value: String(code.t) },
              { label: 'rate', value: (code.k / code.n).toFixed(2) },
            ]}
          />
        </Panel>
        <Panel title="Operating point">
          <Field label="Channel symbol-error rate" value={ps.toExponential(1)}>
            <Slider min={-2.6} max={-0.15} step={0.01} value={Math.log10(ps)} onChange={(v) => setPs(Math.pow(10, v))} />
          </Field>
          <Readout
            items={[
              { label: 'block err', value: marker.block.toExponential(1) },
              { label: 'sym err out', value: marker.sym.toExponential(1) },
            ]}
          />
          <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
            <Button variant="ghost" onClick={share}>
              {copied ? 'Copied ✓' : 'Share'}
            </Button>
          </div>
          <p className="mode-note">
            The dots are a live Monte-Carlo run; the curves are the exact combinatorial theory
            P<sub>block</sub> = Σ<sub>i&gt;t</sub> C(n,i) p<sup>i</sup>(1−p)<sup>n−i</sup>. They land on top of each other — the
            strongest validation there is.
          </p>
        </Panel>
      </div>
      <div className="mode-main">
        <p className="mode-intro">
          Below the diagonal is coding gain. On a channel that corrupts each symbol with probability p, an RS(n,k)
          code only fails when <strong>more than t = {code.t}</strong> of its {code.n} symbols are wrong — and that
          becomes astronomically unlikely as p drops. The measured block-error dots fall exactly along the closed-form
          curve, and the output symbol-error rate dives orders of magnitude below the raw channel.
        </p>
        <CanvasCard title="RS waterfall — measured vs closed-form (log–log)" height={360}>
          <canvas ref={ref} />
        </CanvasCard>
      </div>
    </div>
  )
}

// ===========================================================================
// Tab 4 — the concatenated deep-space chain (RS ⊗ convolutional)
// ===========================================================================

function ConcatTab() {
  const sp = useMemo(() => readHashParams(), [])
  const [ebn0, setEbn0] = useState(() => readNum(sp, 'cebn0', 2.2))
  const [I, setI] = useState(() => readNum(sp, 'cI', 5))
  const [interleave, setInterleave] = useState(() => readBool(sp, 'cintl', true))
  const [frameSeed, setFrameSeed] = useState(1)
  const [wf, setWf] = useState<ConcatPoint[] | null>(null)
  const [running, setRunning] = useState(false)
  const [copied, setCopied] = useState(false)

  const code = useMemo(() => rsById('rs255_223'), [])

  const frame: ConcatFrame = useMemo(
    () => runConcatFrame(code, ebn0, I, interleave, frameSeed * 104729 + 17),
    [code, ebn0, I, interleave, frameSeed],
  )

  const { ref, size } = useDprCanvas()
  useEffect(() => {
    const ctx = prepareContext(ref.current, size)
    if (!ctx) return
    const { width: w, height: h } = size
    const r: Rect = { x: 0, y: 0, w, h }
    fillPlotBg(ctx, r)
    const padL = 60
    const padT = 22
    const padB = 14
    const padR = 12
    const n = code.n
    const cw = (w - padL - padR) / n
    const ch = Math.min((h - padT - padB) / I, 30)
    for (let row = 0; row < I; row++) {
      for (let col = 0; col < n; col++) {
        const x = padL + col * cw
        const y = padT + row * ch
        const err = frame.innerByteErrors[row][col]
        const recov = frame.rsRecovered[row]
        ctx.fillStyle = err
          ? recov
            ? 'rgba(94,234,212,0.95)'
            : 'rgba(251,113,133,0.95)'
          : col < code.k
            ? 'rgba(56,189,248,0.22)'
            : 'rgba(167,139,250,0.22)'
        ctx.fillRect(x, y, Math.max(cw, 0.6), ch - 1)
      }
      ctx.fillStyle = frame.rsRecovered[row] ? TEAL : ROSE
      ctx.font = '11px JetBrains Mono, ui-monospace, monospace'
      ctx.textAlign = 'right'
      ctx.textBaseline = 'middle'
      ctx.fillText(`${frame.errorsPerCodeword[row]}${frame.rsRecovered[row] ? '✓' : '✗'}`, padL - 8, padT + row * ch + ch / 2)
    }
    axisLabel(ctx, 'RS symbol (byte) index →', padL, padT - 8, 'left')
    axisLabel(ctx, `t = ${code.t}`, w - padR, padT - 8, 'right')
  }, [ref, size, frame, code, I])

  // Waterfall canvas
  const { ref: wfRef, size: wfSize } = useDprCanvas()
  useEffect(() => {
    const ctx = prepareContext(wfRef.current, wfSize)
    if (!ctx) return
    const { width: w, height: h } = wfSize
    const r: Rect = { x: 46, y: 16, w: w - 62, h: h - 44 }
    fillPlotBg(ctx, { x: 0, y: 0, w, h })
    grid(ctx, r, 6, 6)
    const xmin = 1.0
    const xmax = 4.5
    const ymin = -6
    const ymax = 0
    const X = (db: number) => r.x + ((db - xmin) / (xmax - xmin)) * r.w
    const Y = (v: number) => r.y + (1 - (Math.log10(Math.max(v, 1e-7)) - ymin) / (ymax - ymin)) * r.h
    for (let db = Math.ceil(xmin); db <= xmax; db++) {
      axisLabel(ctx, String(db), X(db), r.y + r.h + 15, 'center')
    }
    for (let e = ymin; e <= ymax; e++) axisLabel(ctx, `10${sup(e)}`, r.x - 6, Y(Math.pow(10, e)) + 3, 'right')

    if (wf) {
      const line = (key: (p: ConcatPoint) => number, color: string, dash?: number[]) => {
        ctx.strokeStyle = color
        ctx.lineWidth = 2
        if (dash) ctx.setLineDash(dash)
        ctx.beginPath()
        let started = false
        for (const p of wf) {
          const v = key(p)
          if (v <= 0) continue
          const x = X(p.ebn0Db)
          const y = Y(v)
          if (!started) {
            ctx.moveTo(x, y)
            started = true
          } else ctx.lineTo(x, y)
        }
        ctx.stroke()
        ctx.setLineDash([])
        for (const p of wf) {
          const v = key(p)
          if (v <= 0) continue
          ctx.fillStyle = color
          ctx.beginPath()
          ctx.arc(X(p.ebn0Db), Y(v), 3, 0, Math.PI * 2)
          ctx.fill()
        }
      }
      line((p) => p.uncoded, 'rgba(226,232,240,0.8)', [4, 4])
      line((p) => p.innerByteError, BLUE)
      line((p) => Math.max(p.concatByteError, p.concatFrameError > 0 ? 1e-6 : 0), VIOLET)
    } else {
      ctx.fillStyle = 'rgba(154,166,212,0.7)'
      ctx.font = '13px Inter, sans-serif'
      ctx.textAlign = 'center'
      ctx.fillText('Press “Run waterfall” to sweep the chain', r.x + r.w / 2, r.y + r.h / 2)
    }

    // operating marker
    const mx = X(ebn0)
    ctx.strokeStyle = 'rgba(94,234,212,0.5)'
    ctx.setLineDash([3, 4])
    ctx.beginPath()
    ctx.moveTo(mx, r.y)
    ctx.lineTo(mx, r.y + r.h)
    ctx.stroke()
    ctx.setLineDash([])
    axisLabel(ctx, 'Eb/N0 into the inner code (dB) →', r.x + r.w, r.y + r.h + 15, 'right')

    const legend: [string, string][] = [
      ['uncoded BPSK', 'rgba(226,232,240,0.8)'],
      ['inner (Viterbi)', BLUE],
      ['concatenated', VIOLET],
    ]
    legend.forEach(([txt, col], i) => {
      const ly = r.y + 10 + i * 15
      const lx = r.x + r.w - 132
      ctx.strokeStyle = col
      ctx.lineWidth = 2
      ctx.beginPath()
      ctx.moveTo(lx, ly)
      ctx.lineTo(lx + 18, ly)
      ctx.stroke()
      axisLabel(ctx, txt, lx + 24, ly + 3, 'left')
    })
  }, [wfRef, wfSize, wf, ebn0])

  const runWaterfall = () => {
    setRunning(true)
    // let the button paint before the synchronous sweep
    setTimeout(() => {
      const pts = concatWaterfall(code, [1.5, 2.0, 2.5, 3.0, 3.5, 4.0], I, 6, 909)
      setWf(pts)
      setRunning(false)
    }, 20)
  }

  const share = () => {
    shareLink('reedsolomon', { tab: 'concat', cebn0: ebn0, cI: I, cintl: interleave }).then((ok) => {
      if (ok) {
        setCopied(true)
        setTimeout(() => setCopied(false), 1400)
      }
    })
  }

  return (
    <div className="mode">
      <div className="mode-side">
        <Panel title="The deep-space chain">
          <p className="mode-note">
            RS(255,223) <strong>outer</strong> ⊗ K=7 (171,133) convolutional <strong>inner</strong> — the CCSDS
            standard that flew on Voyager. The inner code's Viterbi decoder fails in <em>bursts</em>; the outer RS
            code, fed by an interleaver, eats them.
          </p>
          <Field label="Eb/N0 into the inner code" value={`${ebn0.toFixed(1)} dB`}>
            <Slider min={1} max={4.5} step={0.1} value={ebn0} onChange={setEbn0} />
          </Field>
          <Field label="Interleave depth (codewords / frame)" value={String(I)}>
            <Slider min={1} max={8} step={1} value={I} onChange={setI} />
          </Field>
          <Toggle label="Cross-interleave before the inner code" checked={interleave} onChange={setInterleave} />
          <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
            <Button variant="ghost" onClick={() => setFrameSeed((s) => s + 1)}>
              New frame
            </Button>
            <Button variant="ghost" onClick={share}>
              {copied ? 'Copied ✓' : 'Share'}
            </Button>
          </div>
        </Panel>
        <Panel title="This frame">
          <Readout
            items={[
              { label: 'inner bad bytes', value: String(frame.innerByteErrorCount) },
              { label: 'codewords', value: `${frame.rsRecovered.filter(Boolean).length}/${I}` },
              { label: 'residual', value: String(frame.residualByteErrors) },
            ]}
          />
          <div className={`rs-verdict ${frame.frameRecovered ? 'ok' : 'no'}`} style={{ marginTop: 10 }}>
            {frame.frameRecovered
              ? `Frame recovered — the Viterbi decoder left ${frame.innerByteErrorCount} byte error${frame.innerByteErrorCount === 1 ? '' : 's'}, RS erased them all.`
              : `Frame lost — a burst overwhelmed a codeword's t = ${code.t} budget.`}
          </div>
        </Panel>
      </div>
      <div className="mode-main">
        <p className="mode-intro">
          This is how the pictures got back from the outer planets. A soft <strong>Viterbi</strong> decoder cleans the
          channel but stumbles in bursts; a depth-{I} interleaver scatters each burst across {I} Reed–Solomon
          codewords so none exceeds its t = {code.t} budget; and RS(255,223) mops up what's left. Together they beat
          the convolutional code alone by several dB.
        </p>
        <CanvasCard title={`the frame after Viterbi — ${I} RS codewords, bursts in colour`} height={220}>
          <canvas ref={ref} />
        </CanvasCard>
        <p className="mode-note">
          <span style={{ color: ROSE }}>red = a byte the inner code got wrong that broke its codeword</span> ·{' '}
          <span style={{ color: TEAL }}>teal = a byte error the RS code corrected</span>. Interleaving keeps each row's
          count under t.
        </p>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, margin: '4px 0 10px' }}>
          <Button variant="primary" onClick={runWaterfall}>
            {running ? 'Running…' : 'Run waterfall'}
          </Button>
          <span className="mode-note" style={{ margin: 0 }}>
            Sweeps 1.5 – 4.0 dB, {I} codewords × 6 frames per point.
          </span>
        </div>
        <CanvasCard title="uncoded vs inner-only vs concatenated" height={320}>
          <canvas ref={wfRef} />
        </CanvasCard>
      </div>
    </div>
  )
}

// ===========================================================================
// Shell
// ===========================================================================

export default function ReedSolomon() {
  const sp = useMemo(() => readHashParams(), [])
  const [tab, setTab] = useState<'decode' | 'burst' | 'waterfall' | 'concat'>(() =>
    readStr(sp, 'tab', 'decode', ['decode', 'burst', 'waterfall', 'concat'] as const),
  )
  return (
    <div className="mode-wrap">
      <div className="mode-tabs">
        <Segmented
          value={tab}
          options={[
            { id: 'decode', label: 'Decode' },
            { id: 'burst', label: 'Burst & interleave' },
            { id: 'waterfall', label: 'Waterfall' },
            { id: 'concat', label: 'Deep space' },
          ]}
          onChange={setTab}
        />
      </div>
      {tab === 'decode' && <DecodeTab />}
      {tab === 'burst' && <BurstTab />}
      {tab === 'waterfall' && <WaterfallTab />}
      {tab === 'concat' && <ConcatTab />}
    </div>
  )
}
