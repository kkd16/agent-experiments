import { useMemo, useState } from 'react'
import { PageHeader, Panel, Stat } from '../components/ui'
import { LineChart } from '../components/charts'
import {
  CONV_7_5,
  CONV_171_133,
  convEncode,
  viterbiDecode,
  freeDistance,
  branchOutput,
  nextState,
  type ConvCode,
} from '../lib/convolutional'
import { RNG, awgn, ebN0dBtoEsN0 } from '../lib/channel'

export function Convolutional() {
  const [codeId, setCodeId] = useState<'75' | '171'>('75')
  const code: ConvCode = codeId === '75' ? CONV_7_5 : CONV_171_133
  const [bitsStr, setBitsStr] = useState('101100')
  const [flips, setFlips] = useState<Set<number>>(new Set([3]))
  const [seed, setSeed] = useState(1)

  const inputBits = useMemo(() => bitsStr.split('').filter((c) => c === '0' || c === '1').map(Number), [bitsStr])

  const enc = useMemo(() => convEncode(code, inputBits, true), [code, inputBits])
  const received = useMemo(() => enc.coded.map((b, i) => (flips.has(i) ? b ^ 1 : b)), [enc.coded, flips])
  const decode = useMemo(() => viterbiDecode(code, received, { soft: false, terminate: true }), [code, received])
  const dfree = useMemo(() => freeDistance(code), [code])

  const decodedOk = decode.bits.length === inputBits.length && decode.bits.every((b, i) => b === inputBits[i])
  const channelErrors = flips.size

  const toggle = (i: number) =>
    setFlips((prev) => {
      const n = new Set(prev)
      if (n.has(i)) n.delete(i)
      else n.add(i)
      return n
    })

  // BER waterfall over AWGN — hard vs soft Viterbi vs uncoded.
  const waterfall = useMemo(() => computeWaterfall(code, seed), [code, seed])

  return (
    <div>
      <PageHeader
        kicker="Channel coding · the trellis codes"
        title="Convolutional Codes & Viterbi"
        lede={
          <>
            A convolutional encoder slides a small register over the bit stream, emitting parity taps as
            it goes — so every output bit blends a window of inputs and a single channel error gets{' '}
            <b>out-voted by its neighbours</b>. The encoder is a finite-state machine, so all possible
            transmissions form a <b>trellis</b>; the <b>Viterbi</b> algorithm finds the maximum-likelihood
            path through it — the one closest to what arrived. These codes flew on <b>Voyager</b> and run
            in <b>GSM, Wi-Fi and satellite</b> links.
          </>
        }
      />

      <Panel title="Configure & encode">
        <div className="row" style={{ gap: 16, marginBottom: 12 }}>
          <div className="chip-row">
            <button className={`chip${codeId === '75' ? ' active' : ''}`} onClick={() => setCodeId('75')}>(7,5)₈ · K=3</button>
            <button className={`chip${codeId === '171' ? ' active' : ''}`} onClick={() => setCodeId('171')}>(171,133)₈ · K=7</button>
          </div>
          <label className="field" style={{ minWidth: 220 }}>
            input bits
            <input value={bitsStr} onChange={(e) => { setBitsStr(e.target.value); setFlips(new Set()) }} spellCheck={false} style={{ fontFamily: 'var(--mono)' }} />
          </label>
        </div>
        <div className="grid grid-4">
          <Stat label="Rate" value={`1/${code.n}`} sub={`${code.n} out per in`} />
          <Stat label="Constraint K" value={code.K} sub={`${code.states} states`} />
          <Stat label="Free distance" value={dfree} accent sub={`corrects ~${Math.floor((dfree - 1) / 2)} / window`} />
          <Stat label="Coded bits" value={enc.coded.length} sub={`+ ${code.K - 1}-bit flush`} />
        </div>
      </Panel>

      <Panel
        title="Corrupt the coded stream"
        note="Each input bit produces a group of coded bits (separated below). Click any coded bit to flip it, then watch Viterbi trace the survivor path back through the trellis and recover the input anyway."
      >
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: 14 }}>
          {Array.from({ length: enc.steps }, (_, t) => (
            <div key={t} style={{ display: 'flex', gap: 2, padding: '2px 4px', borderRadius: 5, background: 'var(--panel-2)', border: '1px solid var(--border)' }}>
              {Array.from({ length: code.n }, (_, r) => {
                const idx = t * code.n + r
                const flipped = flips.has(idx)
                return (
                  <span
                    key={r}
                    onClick={() => toggle(idx)}
                    title={`step ${t}, output ${r}`}
                    style={{
                      width: 20, height: 26, cursor: 'pointer', borderRadius: 3,
                      display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                      fontFamily: 'var(--mono)', fontSize: 12,
                      background: flipped ? 'var(--red)' : 'transparent',
                      color: flipped ? '#0a0d13' : 'var(--text-mid)',
                    }}
                  >
                    {received[idx]}
                  </span>
                )
              })}
            </div>
          ))}
        </div>
        <div className="grid grid-4">
          <Stat label="Channel errors" value={channelErrors} />
          <Stat label="Path metric" value={decode.finalMetric} sub="Hamming distance to survivor" />
          <Stat label="Decoded input" value={<span style={{ fontFamily: 'var(--mono)' }}>{decode.bits.join('') || '—'}</span>} accent />
          <Stat label="Recovered = sent?" value={decodedOk ? 'yes ✓' : 'no ✗'} sub={`sent ${inputBits.join('')}`} />
        </div>
      </Panel>

      {code.states <= 8 && (
        <Panel
          title="The trellis & the survivor path"
          note="Rows are encoder states, columns are time. Faint lines are all possible transitions; the bold teal path is the maximum-likelihood survivor Viterbi selected. Edge labels are the expected 2-bit output; the decoder walks the path whose outputs are closest to what arrived."
        >
          <Trellis code={code} survivor={decode.survivorStates} steps={enc.steps} />
        </Panel>
      )}

      <Panel
        title="BER waterfall — the coding gain"
        note="Bit-error rate after decoding vs channel quality (Eb/N₀) over an AWGN channel. The coded curves peel away from the uncoded diagonal: at a target BER, the horizontal gap is the coding gain in dB. Soft-decision Viterbi (using the analog samples) beats hard-decision (thresholded bits) by ~2 dB — for free."
        right={<button className="btn" onClick={() => setSeed((s) => s + 1)}>Re-run trials</button>}
      >
        <LineChart
          series={[
            { label: 'uncoded', color: 'var(--text-dim)', points: waterfall.uncoded, dashed: true },
            { label: 'hard-decision Viterbi', color: 'var(--blue)', points: waterfall.hard },
            { label: 'soft-decision Viterbi', color: 'var(--teal)', points: waterfall.soft },
          ]}
          xDomain={[waterfall.xMin, waterfall.xMax]}
          yDomain={[1e-4, 1]}
          logY
          xLabel="Eb/N₀ (dB)"
          yLabel="bit error rate"
          xFmt={(v) => v.toFixed(0)}
          yFmt={(v) => (v >= 0.01 ? v.toFixed(2) : v.toExponential(0))}
        />
      </Panel>
    </div>
  )
}

function Trellis({ code, survivor, steps }: { code: ConvCode; survivor: number[]; steps: number }) {
  const S = code.states
  const dx = Math.max(48, Math.min(90, 640 / (steps + 1)))
  const dy = 46
  const padL = 30
  const padT = 20
  const W = padL + steps * dx + 30
  const H = padT + (S - 1) * dy + 40
  const px = (t: number) => padL + t * dx
  const py = (s: number) => padT + s * dy

  // All transitions (background).
  const edges: { t: number; from: number; to: number; out: number[]; onPath: boolean }[] = []
  for (let t = 0; t < steps; t++) {
    for (let s = 0; s < S; s++) {
      for (let b = 0; b < 2; b++) {
        const ns = nextState(code, s, b)
        const onPath = survivor[t] === s && survivor[t + 1] === ns
        edges.push({ t, from: s, to: ns, out: branchOutput(code, s, b), onPath })
      }
    }
  }

  return (
    <div style={{ overflowX: 'auto' }}>
      <svg viewBox={`0 0 ${W} ${H}`} width="100%" style={{ minWidth: Math.min(W, 640) }}>
        {/* state row labels */}
        {Array.from({ length: S }, (_, s) => (
          <text key={s} x={4} y={py(s) + 4} fontSize={10} fontFamily="var(--mono)" fill="var(--text-dim)">
            {s.toString(2).padStart(code.K - 1, '0')}
          </text>
        ))}
        {/* edges: background first, then survivor */}
        {edges.filter((e) => !e.onPath).map((e, i) => (
          <line key={`b${i}`} x1={px(e.t)} y1={py(e.from)} x2={px(e.t + 1)} y2={py(e.to)} stroke="var(--border)" strokeWidth={1} opacity={0.4} />
        ))}
        {edges.filter((e) => e.onPath).map((e, i) => (
          <g key={`p${i}`}>
            <line x1={px(e.t)} y1={py(e.from)} x2={px(e.t + 1)} y2={py(e.to)} stroke="var(--teal)" strokeWidth={2.5} />
            <text x={(px(e.t) + px(e.t + 1)) / 2} y={(py(e.from) + py(e.to)) / 2 - 4} fontSize={9} fontFamily="var(--mono)" fill="var(--teal)" textAnchor="middle">
              {e.out.join('')}
            </text>
          </g>
        ))}
        {/* nodes */}
        {Array.from({ length: steps + 1 }, (_, t) =>
          Array.from({ length: S }, (_, s) => {
            const on = survivor[t] === s
            return <circle key={`${t}-${s}`} cx={px(t)} cy={py(s)} r={on ? 5 : 3} fill={on ? 'var(--teal)' : 'var(--panel-hi)'} stroke={on ? 'var(--teal)' : 'var(--border-hi)'} />
          }),
        )}
        {Array.from({ length: steps + 1 }, (_, t) => (
          <text key={`t${t}`} x={px(t)} y={H - 8} fontSize={9} fill="var(--text-dim)" textAnchor="middle">{t}</text>
        ))}
      </svg>
    </div>
  )
}

// Monte-Carlo BER over AWGN for uncoded BPSK, hard- and soft-decision Viterbi.
function computeWaterfall(code: ConvCode, seed: number) {
  const xs = [0, 1, 2, 3, 4, 5, 6]
  const rate = 1 / code.n
  const N = 120 // blocks per point
  const blockLen = 80
  const uncoded: [number, number][] = []
  const hard: [number, number][] = []
  const soft: [number, number][] = []
  const rng = new RNG(0xc0de + seed * 40503)
  for (const dB of xs) {
    const esN0 = ebN0dBtoEsN0(dB, rate)
    let ncU = 0
    let neU = 0
    let ncH = 0
    let neH = 0
    let ncS = 0
    let neS = 0
    for (let blk = 0; blk < N; blk++) {
      const bits = Array.from({ length: blockLen }, () => (rng.float() < 0.5 ? 0 : 1))
      // Uncoded: BPSK at full Eb/N0 (rate 1).
      const u = awgn(bits, ebN0dBtoEsN0(dB, 1), rng)
      for (let i = 0; i < bits.length; i++) { ncU++; if (u.hard[i] !== bits[i]) neU++ }
      // Coded.
      const { coded } = convEncode(code, bits, true)
      const chan = awgn(coded, esN0, rng)
      const dh = viterbiDecode(code, chan.hard, { soft: false, terminate: true })
      const ds = viterbiDecode(code, chan.samples, { soft: true, terminate: true })
      for (let i = 0; i < bits.length; i++) {
        ncH++; if (dh.bits[i] !== bits[i]) neH++
        ncS++; if (ds.bits[i] !== bits[i]) neS++
      }
    }
    const floor = 1e-4 // = the chart's y-axis minimum, so floored points still render
    uncoded.push([dB, Math.max(neU / ncU, floor)])
    hard.push([dB, Math.max(neH / ncH, floor)])
    soft.push([dB, Math.max(neS / ncS, floor)])
  }
  return { uncoded, hard, soft, xMin: xs[0], xMax: xs[xs.length - 1] }
}
