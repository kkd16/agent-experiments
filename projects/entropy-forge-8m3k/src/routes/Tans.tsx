import { useMemo, useState } from 'react'
import { PageHeader, Panel, Stat } from '../components/ui'
import { InputPanel } from '../components/InputPanel'
import { HBarChart, ColumnChart } from '../components/charts'
import { strToBytes } from '../lib/bits'
import { byteLabel, seriesColor } from '../lib/format'
import { CORPUS } from '../lib/corpus'
import {
  tansTableFromData,
  tansEncode,
  buildDecodeTables,
  tansQuantisedEntropy,
  TANS_L,
  TANS_TABLE_LOG,
} from '../lib/tans'
import { ransEncode, tableFromData } from '../lib/rans'
import { arithEncode, Order0Adaptive } from '../lib/arithmetic'
import { frequencies, order0Entropy } from '../lib/entropy'

const DEFAULT = CORPUS.find((c) => c.id === 'dna')?.text ?? 'abracadabra abracadabra'

export function Tans() {
  const [text, setText] = useState(DEFAULT)
  const data = useMemo(() => strToBytes(text), [text])

  const table = useMemo(() => tansTableFromData(data), [data])
  const dec = useMemo(() => buildDecodeTables(table), [table])
  const encoded = useMemo(() => tansEncode(data, table).encoded, [data, table])

  const counts = useMemo(() => Array.from(frequencies(data)), [data])
  const floorBps = useMemo(() => tansQuantisedEntropy(table, counts), [table, counts])
  const h0 = useMemo(() => order0Entropy(data), [data])

  // Colour each present symbol distinctly, in descending frequency.
  const symColor = useMemo(() => {
    const m = new Map<number, string>()
    const order = [...table.symbols].sort((a, b) => table.freq[b] - table.freq[a])
    order.forEach((s, i) => m.set(s, seriesColor(i)))
    return m
  }, [table])

  // Size comparison — every model-based coder hits the same quantised floor.
  const sizes = useMemo(() => {
    const n = data.length
    const tans = encoded.length
    const rans = data.length ? ransEncode(data, tableFromData(data)).encoded.length : 0
    const arith = data.length ? arithEncode(data, () => new Order0Adaptive(256)).encoded.length : 0
    const floor = Math.ceil((floorBps * n) / 8)
    return { tans, rans, arith, floor }
  }, [data, encoded, floorBps])

  // Distribution of "bits read per state" across the whole L-slot table.
  const nbHist = useMemo(() => {
    const h = new Array(TANS_TABLE_LOG + 1).fill(0)
    for (let u = 0; u < TANS_L; u++) h[dec.nbBits[u]]++
    return h.map((v, i) => ({ label: `${i}`, value: v })).filter((_, i) => i <= 13)
  }, [dec])

  // A strip of the first slots, coloured by the symbol the spread placed there —
  // the near-uniform interleaving that keeps the coding loss small.
  const STRIP = Math.min(TANS_L, 256)
  const strip = useMemo(() => Array.from({ length: STRIP }, (_, u) => dec.symbol[u]), [dec, STRIP])

  // The finite-state machine itself: the first states' transitions.
  const ROWS = 28
  const fsmRows = Array.from({ length: Math.min(ROWS, TANS_L) }, (_, u) => ({
    state: u,
    symbol: dec.symbol[u],
    nbBits: dec.nbBits[u],
    newState: dec.newState[u],
  }))

  const inBytes = data.length
  const savings = inBytes > 0 ? 1 - sizes.tans / inBytes : 0

  return (
    <div>
      <PageHeader
        kicker="Entropy coder · the multiply-free one"
        title="tANS / FSE"
        lede={
          <>
            <b>Table-driven ANS</b> reaches the same entropy floor as arithmetic coding and rANS, but
            with <b>no multiplies</b> — just table lookups, shifts and bit I/O. It's the{' '}
            <b>Finite State Entropy</b> coder inside <b>Zstandard</b> and Apple's LZFSE. The state is a
            small integer in a window of {TANS_L.toLocaleString()} values; one table, built from the
            symbol frequencies, drives the whole finite-state machine.
          </>
        }
      />

      <InputPanel value={text} onChange={setText} rows={4} maxNote="live" />

      <div className="grid grid-4" style={{ margin: '18px 0' }}>
        <Stat label="Input" value={inBytes} unit="B" />
        <Stat label="tANS stream" value={sizes.tans} unit="B" accent sub={`${(savings * 100).toFixed(0)}% smaller`} />
        <Stat label="Table" value={`2^${TANS_TABLE_LOG}`} sub={`${TANS_L.toLocaleString()} states`} />
        <Stat label="Quantised floor" value={floorBps.toFixed(3)} unit="b/sym" sub={`order-0 H = ${h0.toFixed(3)}`} />
      </div>

      <Panel
        title="Same floor, four ways"
        note="tANS, rANS and an adaptive arithmetic coder all reach the model's quantised entropy floor — tANS gets there with only shifts and lookups. (The table these static coders transmit is excluded here; this compares the coded payloads.)"
      >
        <HBarChart
          bars={[
            { label: 'quantised floor', value: sizes.floor, color: 'var(--text-dim)' },
            { label: 'tANS / FSE', value: sizes.tans, color: 'var(--teal)' },
            { label: 'rANS', value: sizes.rans, color: 'var(--violet)' },
            { label: 'arithmetic · order-0', value: sizes.arith, color: 'var(--blue)' },
          ]}
          unit=" B"
        />
      </Panel>

      <Panel
        title="Symbol spread across the state table"
        note={`Each symbol claims freq/${TANS_L.toLocaleString()} of the states; the FSE stride interleaves them near-uniformly. First ${STRIP} of ${TANS_L.toLocaleString()} slots, coloured by symbol.`}
      >
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 2 }}>
          {strip.map((s, i) => (
            <span
              key={i}
              title={`slot ${i} → ${byteLabel(s)}`}
              style={{ width: 10, height: 16, borderRadius: 2, background: symColor.get(s) ?? 'var(--panel-hi)' }}
            />
          ))}
        </div>
        <div className="chip-row" style={{ marginTop: 12 }}>
          {[...table.symbols]
            .sort((a, b) => table.freq[b] - table.freq[a])
            .slice(0, 12)
            .map((s) => (
              <span key={s} className="chip" style={{ borderColor: symColor.get(s), color: symColor.get(s), cursor: 'default' }}>
                {byteLabel(s)} · {table.freq[s]}/{TANS_L}
              </span>
            ))}
        </div>
      </Panel>

      <div className="grid grid-2" style={{ gap: 16 }}>
        <Panel
          title="The finite-state machine"
          note="Decoding is pure table lookup: read the symbol at the current state, read that state's bit-count, jump to newState + those bits. No arithmetic."
        >
          <div className="table-wrap" style={{ maxHeight: 340, overflowY: 'auto' }}>
            <table className="data">
              <thead>
                <tr>
                  <th style={{ textAlign: 'left' }}>state</th>
                  <th style={{ textAlign: 'left' }}>symbol</th>
                  <th style={{ textAlign: 'right' }}>read bits</th>
                  <th style={{ textAlign: 'right' }}>→ newState +</th>
                </tr>
              </thead>
              <tbody>
                {fsmRows.map((r) => (
                  <tr key={r.state}>
                    <td style={{ textAlign: 'left', fontFamily: 'var(--mono)' }}>{r.state}</td>
                    <td style={{ textAlign: 'left', color: symColor.get(r.symbol) }}>{byteLabel(r.symbol)}</td>
                    <td style={{ textAlign: 'right' }}>{r.nbBits}</td>
                    <td style={{ textAlign: 'right', fontFamily: 'var(--mono)', color: 'var(--teal)' }}>{r.newState}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Panel>

        <Panel
          title="Bits read per state"
          note="How many states read k bits on a transition. Frequent symbols occupy many states and mostly read 0–1 bits — that's where the sub-bit efficiency comes from."
        >
          <ColumnChart cols={nbHist} color="var(--violet)" height={200} />
        </Panel>
      </div>
    </div>
  )
}
