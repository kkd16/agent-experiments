import { useMemo, useState } from 'react'
import { PageHeader, Panel, Stat } from '../components/ui'
import { HBarChart } from '../components/charts'
import { bwtEncodeSA, suffixArray } from '../lib/suffixArray'
import { bwtEncode as bwtNaive } from '../lib/bwt'
import { strToBytes } from '../lib/bits'
import { byteGlyph } from '../lib/format'

const DEFAULT = 'mississippi'

export function Suffix() {
  const [text, setText] = useState(DEFAULT)
  const data = useMemo(() => strToBytes(text.slice(0, 48)), [text])

  const sa = useMemo(() => suffixArray(data), [data])
  const bwt = useMemo(() => bwtEncodeSA(data), [data])

  // The suffix strings, in sorted (suffix-array) order. We render the sentinel as
  // ⟂ and highlight the last column — that column *is* the BWT.
  const rows = useMemo(() => {
    const n = data.length
    return Array.from(sa).map((start, rank) => {
      const chars: string[] = []
      for (let k = 0; k < n + 1; k++) {
        const pos = start + k
        chars.push(pos < n ? byteGlyph(data[pos]) : pos === n ? '⟂' : '')
      }
      const last = start === 0 ? '⟂' : byteGlyph(data[start - 1])
      return { rank, start, chars, last, isSentinel: start === n }
    })
  }, [sa, data])

  return (
    <div>
      <PageHeader
        kicker="Module 05 · scaling the transform"
        title="Suffix array — SA-IS in linear time"
        lede={
          <>
            The lab's original BWT sorts every rotation with a full O(n² log n) comparison sort —
            fine for a sentence, hopeless for a kilobyte. <strong>SA-IS</strong> (Nong–Zhang–Chan,
            2009) sorts the <em>suffixes</em> in <strong>O(n)</strong> by classifying each position
            S/L-type and inducing the order from the sorted LMS-substrings. The BWT reads straight
            off it: <span className="mono">L[i] = T[SA[i]−1]</span>.
          </>
        }
      />

      <Panel title="Input">
        <div className="row spread" style={{ marginBottom: 8 }}>
          <div className="stat-label">string (≤ 48 chars for the table)</div>
          <div className="muted" style={{ fontSize: 12 }}>{data.length} bytes</div>
        </div>
        <input
          type="text"
          value={text}
          onChange={(e) => setText(e.target.value)}
          spellCheck={false}
          style={{ width: '100%', fontFamily: 'var(--mono)' }}
        />
        <div className="chip-row" style={{ marginTop: 10 }}>
          {['mississippi', 'banana', 'abracadabra', 'the quick brown fox'].map((s) => (
            <button key={s} className={`chip${text === s ? ' active' : ''}`} onClick={() => setText(s)}>
              {s}
            </button>
          ))}
        </div>
      </Panel>

      <div className="grid grid-3" style={{ marginTop: 16 }}>
        <Stat label="suffixes" value={data.length + 1} sub="incl. the ⟂ sentinel" />
        <Stat label="sentinel row" value={bwt.sentinelRow} accent sub="primary index for inverse" />
        <Stat label="BWT length" value={bwt.transformed.length} unit="B" />
      </div>

      <Panel title="Sorted suffixes" note="the suffix array; the highlighted last column is the Burrows–Wheeler transform">
        <div className="table-wrap">
          <table className="data">
            <thead>
              <tr>
                <th>rank</th>
                <th>SA[i]</th>
                <th style={{ textAlign: 'left' }}>suffix (sorted)</th>
                <th>BWT</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.rank}>
                  <td className="num">{r.rank}</td>
                  <td className="num">{r.start}</td>
                  <td className="mono" style={{ textAlign: 'left', letterSpacing: 1 }}>
                    {r.chars.join('')}
                  </td>
                  <td
                    className="mono"
                    style={{
                      color: 'var(--teal)',
                      fontWeight: 600,
                      background: r.rank === bwt.sentinelRow ? 'color-mix(in srgb, var(--amber) 16%, transparent)' : undefined,
                    }}
                  >
                    {r.last}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Panel>

      <ScalingDemo />
    </div>
  )
}

// A live micro-benchmark: build the BWT of a repeated payload at growing sizes,
// timing the naive rotation sort against SA-IS. The naive column grows quadratic­ally
// and blows past the linear one — the whole reason SA-IS exists, made measurable.
function ScalingDemo() {
  const [result, setResult] = useState<{ n: number; naive: number; sais: number }[] | null>(null)
  const [running, setRunning] = useState(false)

  const run = () => {
    setRunning(true)
    // Defer so the button paints its disabled state before the blocking loop.
    setTimeout(() => {
      const base = strToBytes('lorem ipsum dolor sit amet consectetur adipiscing elit ')
      const sizes = [500, 1000, 2000, 4000, 8000]
      const out: { n: number; naive: number; sais: number }[] = []
      for (const n of sizes) {
        const data = new Uint8Array(n)
        for (let i = 0; i < n; i++) data[i] = base[i % base.length]
        let t0 = performance.now()
        bwtNaive(data)
        const naive = performance.now() - t0
        t0 = performance.now()
        bwtEncodeSA(data)
        const sais = performance.now() - t0
        out.push({ n, naive, sais })
      }
      setResult(out)
      setRunning(false)
    }, 20)
  }

  const bars = result
    ? result.flatMap((r) => [
        { label: `naive · ${r.n}B`, value: r.naive, color: 'var(--amber)', caption: `${r.naive.toFixed(1)}ms` },
        { label: `SA-IS · ${r.n}B`, value: r.sais, color: 'var(--teal)', caption: `${r.sais.toFixed(1)}ms` },
      ])
    : []

  return (
    <Panel
      title="Scaling: naive rotation sort vs SA-IS"
      note="both build the same BWT; time is wall-clock in this browser"
      right={
        <button className="btn primary small" onClick={run} disabled={running}>
          {running ? 'running…' : 'Run benchmark'}
        </button>
      }
    >
      {result ? (
        <>
          <HBarChart bars={bars} unit="" valueFmt={(v) => `${v.toFixed(1)}ms`} />
          <div className="legend" style={{ marginTop: 12 }}>
            <span>
              At 8000 bytes SA-IS is{' '}
              <strong>
                {(result[result.length - 1].naive / Math.max(0.01, result[result.length - 1].sais)).toFixed(1)}×
              </strong>{' '}
              faster, and the gap widens with every doubling — quadratic vs linear.
            </span>
          </div>
        </>
      ) : (
        <div className="muted">Press “Run benchmark” to time both transforms on payloads from 500 B to 8 KB.</div>
      )}
    </Panel>
  )
}
