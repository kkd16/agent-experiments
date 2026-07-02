import { useMemo, useState } from 'react'
import { PageHeader, Panel, Stat } from '../components/ui'
import { InputPanel } from '../components/InputPanel'
import { arithEncode, Order0Adaptive, Order1Adaptive } from '../lib/arithmetic'
import { huffmanEncode } from '../lib/huffman'
import { analyze, frequencies } from '../lib/entropy'
import { strToBytes } from '../lib/bits'
import { byteLabel, fmtNum, seriesColor } from '../lib/format'

// Renders the shrinking-interval diagram. Each row stretches the current
// [low, high) to full width, subdivides it by the (static) symbol probabilities,
// and highlights the band the next symbol selects — the next row zooms into it.
function IntervalViz({ data }: { data: Uint8Array }) {
  const rows = useMemo(() => {
    const n = data.length
    if (n === 0) return null
    const counts = frequencies(data)
    const order: number[] = []
    for (let b = 0; b < 256; b++) if (counts[b] > 0) order.push(b)
    const total = n
    const bounds = new Map<number, [number, number]>()
    let acc = 0
    for (const s of order) {
      bounds.set(s, [acc / total, (acc + counts[s]) / total])
      acc += counts[s]
    }
    const colorIndex = new Map<number, number>()
    order.forEach((s, i) => colorIndex.set(s, i))
    const steps: {
      symbol: number
      low: number
      high: number
      bands: { symbol: number; lo: number; hi: number }[]
    }[] = []
    let low = 0
    let high = 1
    const limit = Math.min(n, 14)
    for (let i = 0; i < limit; i++) {
      const w = high - low
      const bands = order.map((s) => {
        const [cl, ch] = bounds.get(s)!
        return { symbol: s, lo: cl, hi: ch }
      })
      const sym = data[i]
      const [cl, ch] = bounds.get(sym)!
      steps.push({ symbol: sym, low, high, bands })
      high = low + w * ch
      low = low + w * cl
    }
    return { steps, colorIndex, truncated: n > limit, low, high }
  }, [data])

  if (!rows) return <div className="muted">Empty input.</div>
  const W = 720
  const rowH = 30
  const gap = 12
  return (
    <div style={{ overflowX: 'auto' }}>
      <svg viewBox={`0 0 ${W + 120} ${rows.steps.length * (rowH + gap)}`} width="100%" style={{ minWidth: 560 }}>
        {rows.steps.map((st, i) => {
          const y = i * (rowH + gap)
          const sym = st.symbol
          return (
            <g key={i}>
              {st.bands.map((band, bi) => {
                const x = band.lo * W
                const bw = (band.hi - band.lo) * W
                const chosen = band.symbol === sym
                return (
                  <g key={bi}>
                    <rect
                      x={x}
                      y={y}
                      width={Math.max(0.5, bw)}
                      height={rowH}
                      fill={seriesColor(rows.colorIndex.get(band.symbol) ?? 0)}
                      opacity={chosen ? 0.9 : 0.16}
                      stroke={chosen ? 'var(--text)' : 'none'}
                      strokeWidth={chosen ? 1 : 0}
                    />
                    {bw > 26 && (
                      <text x={x + bw / 2} y={y + rowH / 2 + 4} textAnchor="middle" fontSize={11} fill={chosen ? '#0a0d13' : 'var(--text-dim)'}>
                        {byteLabel(band.symbol)}
                      </text>
                    )}
                  </g>
                )
              })}
              <text x={W + 12} y={y + rowH / 2 + 4} fontSize={12} fill="var(--text-mid)" fontFamily="var(--mono)">
                → {byteLabel(sym)}  [{st.low.toFixed(4)}, {st.high.toFixed(4)})
              </text>
            </g>
          )
        })}
      </svg>
      {rows.truncated && <div className="muted" style={{ fontSize: 12, marginTop: 6 }}>Showing the first 14 symbols; the interval keeps shrinking for the rest.</div>}
    </div>
  )
}

export function Arithmetic() {
  const [text, setText] = useState('bananas are a good source of potassium and bananas are cheap')
  const data = useMemo(() => strToBytes(text), [text])
  const report = useMemo(() => analyze(data), [data])

  const stats = useMemo(() => {
    const a0 = arithEncode(data, () => new Order0Adaptive(256))
    const a1 = arithEncode(data, () => new Order1Adaptive(256))
    const huff = huffmanEncode(data)
    return { a0: a0.encodedBits, a1: a1.encodedBits, huff: huff.encodedBits }
  }, [data])

  const origBits = data.length * 8
  const idealBits = Math.ceil(report.idealBits)

  return (
    <div>
      <PageHeader
        kicker="Module 03 · Entropy coding"
        title="Arithmetic Coding"
        lede={
          <>
            Instead of one code per symbol, arithmetic coding represents the entire message as a
            single number inside a shrinking interval of [0, 1). Because the interval narrows by a
            symbol's <em>probability</em>, it can spend a fractional number of bits per symbol —
            reaching the entropy bound that Huffman only approaches.
          </>
        }
      />

      <Panel title="Input">
        <InputPanel value={text} onChange={setText} rows={3} />
      </Panel>

      <Panel title="The interval narrows" note="Each row zooms into the previous symbol's sub-interval; the final interval names the message.">
        <IntervalViz data={data} />
      </Panel>

      <div className="grid grid-4">
        <Stat label="Original" value={origBits} unit="bits" />
        <Stat label="Order-0 ideal" value={idealBits} unit="bits" sub="entropy floor" />
        <Stat label="Huffman" value={stats.huff} unit="bits" sub={`+${Math.max(0, stats.huff - idealBits)} over ideal`} />
        <Stat label="Arithmetic o0" value={stats.a0} unit="bits" accent sub="hugs the floor" />
      </div>

      <div className="grid grid-2">
        <Panel title="Why it beats Huffman">
          <div className="prose" style={{ fontSize: 14 }}>
            <p>
              Huffman must round every code to a whole number of bits, wasting up to ~1 bit per
              symbol when probabilities are not powers of two. Here Huffman spends{' '}
              <strong>{stats.huff} bits</strong> versus the <strong>{idealBits}-bit</strong> entropy
              floor, while the arithmetic coder reaches <strong>{stats.a0} bits</strong> — within a
              couple of bits of the theoretical minimum, the fixed overhead of flushing the coder.
            </p>
            <p>
              This implementation is the genuine Witten–Neal–Cleary integer coder: 32-bit low/high
              registers, E1/E2/E3 renormalisation, and pending-bit underflow handling. It is{' '}
              <em>adaptive</em> — the model learns frequencies as it goes — so no probability table
              is transmitted, and decode replays the identical model to stay in lock-step.
            </p>
          </div>
        </Panel>
        <Panel title="Context modelling: order-1">
          <div className="grid grid-2" style={{ marginBottom: 10 }}>
            <Stat label="Order-0 arithmetic" value={stats.a0} unit="bits" />
            <Stat label="Order-1 arithmetic" value={stats.a1} unit="bits" accent sub={`${fmtNum(report.order1)} b/sym floor`} />
          </div>
          <div className="prose" style={{ fontSize: 14 }}>
            <p>
              Swap the memoryless model for one that conditions on the <em>previous byte</em> and the
              coder now targets the order-1 entropy ({fmtNum(report.order1)} b/sym vs{' '}
              {fmtNum(report.order0)}). On natural language the drop is large — <code>u</code> almost
              always follows <code>q</code>, spaces cluster — which is why context models power the
              strongest compressors.
            </p>
          </div>
        </Panel>
      </div>
    </div>
  )
}
