import { useState } from 'react'
import { perft, PERFT_SUITE, parseFen } from '../engine'

interface Row {
  name: string
  depth: number
  expected: number
  got: number | null
  ms: number | null
  status: 'idle' | 'running' | 'pass' | 'fail'
}

const initialRows: Row[] = PERFT_SUITE.map((c) => ({
  name: c.name,
  depth: c.depth,
  expected: c.expected,
  got: null,
  ms: null,
  status: 'idle',
}))

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

export default function Lab() {
  const [rows, setRows] = useState<Row[]>(initialRows)
  const [running, setRunning] = useState(false)

  async function run() {
    setRunning(true)
    setRows(initialRows)
    await sleep(30)
    for (let i = 0; i < PERFT_SUITE.length; i++) {
      const c = PERFT_SUITE[i]
      setRows((prev) => prev.map((r, j) => (j === i ? { ...r, status: 'running' } : r)))
      await sleep(20)
      const pos = parseFen(c.fen)
      const t0 = performance.now()
      const got = perft(pos, c.depth)
      const ms = Math.round(performance.now() - t0)
      const status: Row['status'] = got === c.expected ? 'pass' : 'fail'
      setRows((prev) => prev.map((r, j) => (j === i ? { ...r, got, ms, status } : r)))
      await sleep(20)
    }
    setRunning(false)
  }

  const passed = rows.filter((r) => r.status === 'pass').length
  const total = rows.length

  return (
    <div className="lab">
      <div className="lab-intro">
        <p>
          <strong>perft</strong> counts the exact number of leaf nodes in the move tree to a given depth. Matching the
          known reference counts proves the move generator handles castling, en passant, promotion and check evasion
          correctly — the foundation a correct engine is built on.
        </p>
        <button className="btn primary" onClick={run} disabled={running}>
          {running ? 'Running…' : 'Run perft suite'}
        </button>
        {!running && rows.some((r) => r.status !== 'idle') && (
          <span className={`lab-summary ${passed === total ? 'ok' : 'bad'}`}>
            {passed}/{total} passed
          </span>
        )}
      </div>

      <table className="lab-table">
        <thead>
          <tr>
            <th>Position</th>
            <th>Depth</th>
            <th>Expected</th>
            <th>Computed</th>
            <th>Time</th>
            <th>Speed</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.name} className={`lab-row ${r.status}`}>
              <td>{r.name}</td>
              <td>{r.depth}</td>
              <td>{r.expected.toLocaleString()}</td>
              <td>{r.got === null ? '—' : r.got.toLocaleString()}</td>
              <td>{r.ms === null ? '—' : `${r.ms} ms`}</td>
              <td>{r.ms ? `${Math.round((r.got! / Math.max(1, r.ms)) / 1000)}M/s` : '—'}</td>
              <td className="lab-status">
                {r.status === 'pass' && '✓'}
                {r.status === 'fail' && '✗'}
                {r.status === 'running' && '…'}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
