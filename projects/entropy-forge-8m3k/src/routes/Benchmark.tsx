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

      <Panel
        title="Entropy vs. achieved size"
        note="each corpus plotted as (order-0 entropy, best coder's bits/symbol); the diagonal is the order-0 floor"
      >
        <EntropyScatter
          points={matrix.map((m, i) => {
            const bestBytes = Math.min(...CODECS.map((c) => m.cells[c.id].bytes))
            return {
              label: m.sample.name,
              x: m.floor.order0,
              y: m.data.length > 0 ? (bestBytes * 8) / m.data.length : 0,
              color: seriesColor(i),
            }
          })}
        />
        <div className="legend" style={{ marginTop: 12 }}>
          <span>
            Points <strong>on</strong> the diagonal are compressed no better than their order-0
            entropy (a memoryless source — e.g. high-entropy data near the top-right corner). Points{' '}
            <strong>below</strong> it are beaten by context and dictionary modelling: repetitive and
            source inputs fall far under their own order-0 floor.
          </span>
        </div>
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

// Scatter of (order-0 entropy, best achieved bits/sym) over a shared 0..8 bit
// axis, with the y = x diagonal drawn as the order-0 floor. The vertical distance
// below the diagonal is exactly how much modelling bought on that corpus.
function EntropyScatter({ points }: { points: { label: string; x: number; y: number; color: string }[] }) {
  const size = 300
  const pad = 40
  const maxBits = 8
  const sx = (v: number) => pad + (Math.min(v, maxBits) / maxBits) * (size - pad * 1.4)
  const sy = (v: number) => size - pad - (Math.min(v, maxBits) / maxBits) * (size - pad * 1.4)
  const ticks = [0, 2, 4, 6, 8]
  return (
    <div style={{ overflowX: 'auto' }}>
      <svg viewBox={`0 0 ${size + 120} ${size}`} width="100%" style={{ minWidth: 420, maxWidth: 560 }}>
        {/* axes */}
        <line x1={pad} y1={size - pad} x2={size - pad * 0.4} y2={size - pad} stroke="var(--border-hi)" />
        <line x1={pad} y1={pad} x2={pad} y2={size - pad} stroke="var(--border-hi)" />
        {/* y = x diagonal (order-0 floor) */}
        <line x1={sx(0)} y1={sy(0)} x2={sx(maxBits)} y2={sy(maxBits)} stroke="var(--amber)" strokeDasharray="4 4" opacity={0.8} />
        <text x={sx(maxBits) - 6} y={sy(maxBits) - 6} fill="var(--amber)" fontSize={10} textAnchor="end">order-0 floor</text>
        {ticks.map((t) => (
          <g key={t}>
            <text x={sx(t)} y={size - pad + 14} fontSize={10} fill="var(--text-dim)" textAnchor="middle">{t}</text>
            <text x={pad - 8} y={sy(t) + 3} fontSize={10} fill="var(--text-dim)" textAnchor="end">{t}</text>
          </g>
        ))}
        <text x={(size) / 2} y={size - 6} fontSize={11} fill="var(--text-mid)" textAnchor="middle">order-0 entropy (bits/sym)</text>
        <text x={12} y={size / 2} fontSize={11} fill="var(--text-mid)" textAnchor="middle" transform={`rotate(-90 12 ${size / 2})`}>achieved (bits/sym)</text>
        {points.map((p, i) => (
          <g key={i}>
            <circle cx={sx(p.x)} cy={sy(p.y)} r={5.5} fill={p.color} stroke="var(--bg)" strokeWidth={1} />
            <text x={size - pad * 0.4 + 8} y={pad + i * 16 + 4} fontSize={11} fill="var(--text-mid)">
              <tspan fill={p.color}>●</tspan> {p.label}
            </text>
          </g>
        ))}
      </svg>
    </div>
  )
}
