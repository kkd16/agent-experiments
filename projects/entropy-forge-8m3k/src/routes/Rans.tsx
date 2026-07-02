import { useMemo, useState } from 'react'
import { PageHeader, Panel, Stat } from '../components/ui'
import { InputPanel } from '../components/InputPanel'
import { HBarChart } from '../components/charts'
import {
  RANS_M,
  RANS_SCALE_BITS,
  quantisedEntropy,
  ransEncode,
  serialiseTable,
  tableFromData,
} from '../lib/rans'
import { arithEncode, Order0Adaptive } from '../lib/arithmetic'
import { frequencies, analyze } from '../lib/entropy'
import { strToBytes } from '../lib/bits'
import { byteLabel, seriesColor } from '../lib/format'

const DEFAULT =
  'ABRACADABRA! the numeral system codes the whole message into one big integer, ' +
  'then peels the symbols back off it — asymmetric numeral systems, the entropy ' +
  'coder inside zstd and LZFSE.'

export function Rans() {
  const [text, setText] = useState(DEFAULT)
  const data = useMemo(() => strToBytes(text), [text])

  const counts = useMemo(() => frequencies(data), [data])
  const table = useMemo(() => tableFromData(data), [data])
  const floor = useMemo(() => analyze(data), [data])

  const enc = useMemo(() => ransEncode(data, table), [data, table])
  const tableBytes = useMemo(() => serialiseTable(table).length, [table])
  const arithBytes = useMemo(
    () => (data.length > 0 ? Math.ceil(arithEncode(data, () => new Order0Adaptive(256)).encodedBits / 8) : 0),
    [data],
  )
  const qEntropy = useMemo(() => quantisedEntropy(table, counts), [table, counts])

  // Rows for the normalisation table, most frequent first.
  const rows = useMemo(() => {
    return table.symbols
      .map((s) => ({
        symbol: s,
        count: counts[s],
        freq: table.freq[s],
        p: table.freq[s] / RANS_M,
        trueP: data.length > 0 ? counts[s] / data.length : 0,
      }))
      .sort((a, b) => b.freq - a.freq)
  }, [table, counts, data.length])

  const totalStream = enc.encoded.length
  const withTable = 4 + tableBytes + totalStream

  const sizeBars = [
    { label: 'true entropy floor', value: Math.ceil(floor.idealBits / 8), color: 'var(--text-dim)', caption: 'H₀' },
    { label: 'rANS quantised floor', value: data.length > 0 ? Math.ceil((qEntropy * data.length) / 8) : 0, color: 'var(--violet)' },
    { label: 'rANS stream', value: totalStream, color: 'var(--teal)' },
    { label: 'rANS + table', value: withTable, color: 'var(--blue)' },
    { label: 'arithmetic (order-0)', value: arithBytes, color: 'var(--amber)' },
  ]

  return (
    <div>
      <PageHeader
        kicker="Module 03 · a modern entropy backend"
        title="rANS — asymmetric numeral systems"
        lede={
          <>
            ANS is the entropy coder that displaced arithmetic coding in{' '}
            <strong>zstd, LZ4-HC and LZFSE</strong>. It folds the whole message into a single
            growing integer — the <em>state</em> — where each symbol both scales the state up by
            ≈1/p and writes its identity into the low bits. It famously{' '}
            <strong>encodes back-to-front and decodes front-to-back</strong>, renormalising a{' '}
            <strong>whole byte at a time</strong> instead of a bit, which is why it is fast.
          </>
        }
      />

      <Panel title="Input">
        <InputPanel value={text} onChange={setText} rows={4} />
      </Panel>

      <div className="grid grid-4" style={{ marginTop: 16 }}>
        <Stat label="Input" value={data.length} unit="B" />
        <Stat label="rANS stream" value={totalStream} unit="B" accent sub={`+ ${tableBytes}B table`} />
        <Stat label="table total" value={RANS_M} sub={`${RANS_SCALE_BITS}-bit precision (2^${RANS_SCALE_BITS})`} />
        <Stat
          label="quantisation cost"
          value={data.length > 0 ? `+${((qEntropy - floor.order0)).toFixed(3)}` : '0'}
          unit="b/sym"
          sub="over the true entropy"
        />
      </div>

      <Panel
        title="The [0, M) ring"
        note={`every symbol owns a slice of the ${RANS_M}-slot ring proportional to its frequency; decoding reads x mod M to pick the slice`}
      >
        <RingStrip rows={rows} />
      </Panel>

      <Panel
        title="Frequency normalisation"
        note={`raw counts quantised so Σ freq = M = ${RANS_M}, never zeroing a symbol that occurred`}
      >
        <div className="table-wrap">
          <table className="data">
            <thead>
              <tr>
                <th>symbol</th>
                <th>count</th>
                <th>freq / M</th>
                <th>model p</th>
                <th>true p</th>
                <th>ideal bits</th>
              </tr>
            </thead>
            <tbody>
              {rows.slice(0, 24).map((r) => (
                <tr key={r.symbol}>
                  <td className="mono">{byteLabel(r.symbol)}</td>
                  <td className="num">{r.count}</td>
                  <td className="num">{r.freq}</td>
                  <td className="num">{(r.p * 100).toFixed(2)}%</td>
                  <td className="num">{(r.trueP * 100).toFixed(2)}%</td>
                  <td className="num">{(-Math.log2(r.p)).toFixed(2)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {rows.length > 24 && <div className="muted" style={{ marginTop: 8, fontSize: 12 }}>showing 24 of {rows.length} symbols</div>}
      </Panel>

      <Panel title="Size — and where the bits go" note="the rANS stream lands on the quantised floor; the table is the price of a static model">
        <HBarChart bars={sizeBars} unit=" B" valueFmt={(v) => v.toFixed(0)} />
        <div className="legend" style={{ marginTop: 12 }}>
          <span>
            Final 32-bit state flushed into the stream; {enc.bytesOut - 4} renormalisation byte(s) +
            4-byte seed = {enc.bytesOut}B. rANS reaches the same order-0 floor as arithmetic coding
            by a completely different mechanism — a table lookup and a multiply, no interval juggling.
          </span>
        </div>
      </Panel>
    </div>
  )
}

// A single horizontal bar partitioned into per-symbol slices of the [0,M) ring,
// each width ∝ freq. The visual point: rANS *is* a numeral system whose digits
// have unequal widths set by probability.
function RingStrip({ rows }: { rows: { symbol: number; freq: number }[] }) {
  const total = RANS_M
  const W = 900
  const h = 46
  // Draw in symbol order for a stable layout; colour cycles. Precompute each
  // slice's left edge so nothing is reassigned during render.
  const ordered = [...rows].sort((a, b) => a.symbol - b.symbol)
  const slices: { symbol: number; rectX: number; w: number; ci: number }[] = []
  let acc = 0
  for (let i = 0; i < ordered.length; i++) {
    const w = (ordered[i].freq / total) * W
    slices.push({ symbol: ordered[i].symbol, rectX: acc, w, ci: i })
    acc += w
  }
  return (
    <div style={{ overflowX: 'auto' }}>
      <svg viewBox={`0 0 ${W} ${h + 4}`} width="100%" style={{ minWidth: 560 }}>
        {slices.map((s) => (
          <g key={s.symbol}>
            <rect x={s.rectX} y={2} width={Math.max(0.6, s.w - 0.6)} height={h} fill={seriesColor(s.ci)} opacity={0.82} />
            {s.w > 22 && (
              <text x={s.rectX + s.w / 2} y={h / 2 + 5} textAnchor="middle" fontSize={11} fill="#0a0d13">
                {byteLabel(s.symbol)}
              </text>
            )}
          </g>
        ))}
      </svg>
    </div>
  )
}
