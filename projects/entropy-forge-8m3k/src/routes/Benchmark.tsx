import { useMemo, useState } from 'react'
import { PageHeader, Panel, Stat } from '../components/ui'
import { HBarChart } from '../components/charts'
import { CODECS } from '../lib/codecs'
import { CORPUS } from '../lib/corpus'
import { analyze } from '../lib/entropy'
import { bytesEqual, strToBytes } from '../lib/bits'
import { fmtNum, seriesColor } from '../lib/format'

interface Cell {
  bytes: number
  ratio: number
  ok: boolean
  bps: number // bits per original symbol
}

export function Benchmark() {
  const [sampleId, setSampleId] = useState('declaration')

  // Compute the full codec × sample matrix once (inputs are small; this is fast).
  const matrix = useMemo(() => {
    return CORPUS.map((s) => {
      const data = strToBytes(s.text)
      const floor = analyze(data)
      const cells: Record<string, Cell> = {}
      for (const c of CODECS) {
        const enc = c.encode(data)
        const dec = c.decode(enc)
        const ok = bytesEqual(dec, data)
        cells[c.id] = {
          bytes: enc.length,
          ratio: data.length > 0 ? enc.length / data.length : 1,
          ok,
          bps: data.length > 0 ? (enc.length * 8) / data.length : 0,
        }
      }
      return { sample: s, data, floor, cells }
    })
  }, [])

  const active = matrix.find((m) => m.sample.id === sampleId)!
  const bars = CODECS.map((c, i) => ({
    label: c.name,
    value: active.cells[c.id].bytes,
    color: seriesColor(i),
    caption: `${(active.cells[c.id].ratio * 100).toFixed(0)}%`,
  }))
  const floorBytes = Math.ceil(active.floor.idealBits / 8)
  const best = CODECS.reduce((a, b) => (active.cells[a.id].bytes <= active.cells[b.id].bytes ? a : b))
  const allOk = matrix.every((m) => CODECS.every((c) => m.cells[c.id].ok))

  return (
    <div>
      <PageHeader
        kicker="Module 06"
        title="Benchmark"
        lede={
          <>
            Every codec, raced on shared corpora, each result <strong>verified by a full decode</strong>{' '}
            back to the original bytes. The dashed line is the order-0 entropy floor — dictionary and
            transform coders beat it by exploiting structure that a memoryless model cannot see.
          </>
        }
      />

      <div className="grid grid-4">
        <Stat label="Codecs" value={CODECS.length} />
        <Stat label="Corpora" value={CORPUS.length} />
        <Stat label="Round-trips" value={matrix.length * CODECS.length} sub={allOk ? 'all verified ✓' : 'FAILURE'} accent={allOk} />
        <Stat label="Best on sample" value={best.name.split(' ')[0]} sub={`${(active.cells[best.id].ratio * 100).toFixed(0)}% of original`} />
      </div>

      <Panel
        title={`Compressed size — ${active.sample.name}`}
        note={active.sample.note}
        right={
          <select value={sampleId} onChange={(e) => setSampleId(e.target.value)} style={{ width: 220 }}>
            {CORPUS.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
        }
      >
        <div className="muted" style={{ fontSize: 13, marginBottom: 10 }}>
          Original: <b style={{ color: 'var(--text)' }}>{active.data.length} bytes</b> · order-0 entropy floor:{' '}
          <b style={{ color: 'var(--amber)' }}>{floorBytes} bytes</b> ({fmtNum(active.floor.order0)} b/sym)
        </div>
        <HBarChart
          bars={bars}
          max={active.data.length}
          unit=" B"
          marker={{ value: floorBytes, label: 'entropy floor' }}
          valueFmt={(v) => v.toFixed(0)}
        />
      </Panel>

      <Panel title="Full results — compression ratio (%)" note="Lower is better. Green = verified round-trip. The header row lists each corpus.">
        <div className="table-wrap">
          <table className="data">
            <thead>
              <tr>
                <th>Codec</th>
                {CORPUS.map((s) => (
                  <th key={s.id} title={s.note}>
                    {s.name}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              <tr>
                <td style={{ color: 'var(--amber)' }}>Entropy floor</td>
                {matrix.map((m) => (
                  <td key={m.sample.id} className="num" style={{ color: 'var(--amber)' }}>
                    {((m.floor.idealBits / 8 / Math.max(1, m.data.length)) * 100).toFixed(0)}%
                  </td>
                ))}
              </tr>
              {CODECS.map((c, ci) => (
                <tr key={c.id}>
                  <td style={{ textAlign: 'left' }}>
                    <span className="dot-swatch" style={{ background: seriesColor(ci) }} /> {c.name}
                  </td>
                  {matrix.map((m) => {
                    const cell = m.cells[c.id]
                    const isBest =
                      cell.bytes === Math.min(...CODECS.map((x) => m.cells[x.id].bytes))
                    return (
                      <td
                        key={m.sample.id}
                        className="num"
                        style={{
                          color: cell.ok ? (isBest ? 'var(--green)' : 'var(--text)') : 'var(--red)',
                          fontWeight: isBest ? 700 : 400,
                        }}
                        title={`${cell.bytes} B · ${fmtNum(cell.bps)} bits/sym${cell.ok ? '' : ' · ROUND-TRIP FAILED'}`}
                      >
                        {(cell.ratio * 100).toFixed(0)}
                        {!cell.ok && '✗'}
                      </td>
                    )
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="legend" style={{ marginTop: 12 }}>
          {CODECS.map((c, i) => (
            <span key={c.id}>
              <span className="swatch" style={{ background: seriesColor(i) }} />
              {c.name} — <span className="muted">{c.blurb}</span>
            </span>
          ))}
        </div>
      </Panel>

      <Panel title="Reading the results">
        <div className="prose" style={{ fontSize: 14 }}>
          <p>
            On <strong>English prose</strong> the entropy coders (Huffman, arithmetic) land near the
            order-0 floor, while order-1 arithmetic and the BWT/LZ coders dip well below it by using
            context. On <strong>repetitive</strong> and <strong>source-code</strong> inputs the
            dictionary coders dominate — repetition is invisible to a memoryless model but is exactly
            what LZ77/LZW encode. On <strong>high-entropy</strong> data everything lands at ~100% (or
            slightly above, from headers): you cannot compress randomness, and the small overshoot is
            the theorem biting back.
          </p>
        </div>
      </Panel>
    </div>
  )
}
