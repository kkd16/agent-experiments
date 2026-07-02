import { useMemo, useState } from 'react'
import { PageHeader, Panel, Stat } from '../components/ui'
import { InputPanel } from '../components/InputPanel'
import { ColumnChart } from '../components/charts'
import { analyze } from '../lib/entropy'
import { strToBytes } from '../lib/bits'
import { byteLabel, fmtNum, pct } from '../lib/format'

export function Analyzer() {
  const [text, setText] = useState(
    'MISSISSIPPI RIVER — the classic teaching string: few symbols, wildly uneven frequencies.',
  )
  const report = useMemo(() => analyze(strToBytes(text)), [text])
  const cols = report.stats.slice(0, 48).map((s) => ({ label: byteLabel(s.symbol), value: s.count }))

  return (
    <div>
      <PageHeader
        kicker="Module 01"
        title="Entropy Analyzer"
        lede={
          <>
            The information content of a message sets the hard floor for how small any lossless coder
            can make it. This page measures that floor — Shannon's entropy H(X) — and shows exactly
            which symbols carry the bits.
          </>
        }
      />

      <Panel title="Message">
        <InputPanel value={text} onChange={setText} rows={4} />
      </Panel>

      <div className="grid grid-4" style={{ marginTop: 16 }}>
        <Stat label="Length" value={report.length} unit="bytes" />
        <Stat label="Distinct symbols" value={report.distinct} />
        <Stat label="Order-0 entropy" value={fmtNum(report.order0)} unit="bits/sym" accent />
        <Stat label="Ideal size" value={Math.ceil(report.idealBits / 8)} unit="bytes" sub={`${Math.ceil(report.idealBits)} bits`} />
      </div>

      <Panel title="Symbol frequency distribution" note="Top 48 symbols by count. A skewed shape means compressibility." >
        <ColumnChart cols={cols} />
      </Panel>

      <div className="grid grid-2">
        <Panel title="What the numbers mean">
          <div className="prose" style={{ fontSize: 14 }}>
            <p>
              <strong>Order-0 entropy</strong> ({fmtNum(report.order0)} b/sym) is the average code
              length any memoryless coder must pay. Multiply by {report.length} symbols to get the{' '}
              {Math.ceil(report.idealBits)}-bit floor.
            </p>
            <p>
              <strong>Redundancy</strong> ({pct(report.redundancy)}) is how far the distribution
              sits below a uniform one over the same alphabet ({fmtNum(report.maxEntropy)} b/sym).
              Zero redundancy — like random bytes — means order-0 coders cannot help.
            </p>
            <p>
              <strong>Order-1 / order-2 entropy</strong> ({fmtNum(report.order1)} /{' '}
              {fmtNum(report.order2)} b/sym) condition each symbol on the ones before it. When these
              are much lower than order-0, a context-modelling coder can win big — that is the whole
              premise of arithmetic-order-1, LZ, and BWT.
            </p>
          </div>
        </Panel>
        <Panel title="Per-symbol information" note="−log₂ p is the ideal code length; rarer symbols cost more bits.">
          <div className="table-wrap" style={{ maxHeight: 320, overflowY: 'auto' }}>
            <table className="data">
              <thead>
                <tr>
                  <th>Symbol</th>
                  <th>Count</th>
                  <th>P(x)</th>
                  <th>−log₂P</th>
                  <th>Bits</th>
                </tr>
              </thead>
              <tbody>
                {report.stats.slice(0, 40).map((s) => (
                  <tr key={s.symbol}>
                    <td className="mono">{byteLabel(s.symbol)}</td>
                    <td className="num">{s.count}</td>
                    <td className="num">{pct(s.prob, 1)}</td>
                    <td className="num">{fmtNum(s.info)}</td>
                    <td className="num">{Math.round(s.codeContribution)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Panel>
      </div>
    </div>
  )
}
