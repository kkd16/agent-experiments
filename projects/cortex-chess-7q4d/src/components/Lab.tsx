import { useCallback, useState } from 'react'
import {
  perft,
  PERFT_SUITE,
  parseFen,
  evaluate,
  see,
  generateLegal,
  moveToSan,
  moveFrom,
  moveTo,
  movePromo,
  squareName,
  TACTICS,
  type TacticCase,
  parsePgn,
  sanToMove,
  Game,
} from '../engine'
import { useEngine } from '../hooks/useEngine'

type Mode = 'perft' | 'tactics' | 'checks'

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

function uci(m: number): string {
  return squareName(moveFrom(m)) + squareName(moveTo(m)) + (movePromo(m) ? 'nbrq'[movePromo(m) - 2] : '')
}

// ---------------- Perft ----------------

interface PerftRow {
  name: string
  depth: number
  expected: number
  got: number | null
  ms: number | null
  status: 'idle' | 'running' | 'pass' | 'fail'
}

const initialPerft: PerftRow[] = PERFT_SUITE.map((c) => ({
  name: c.name,
  depth: c.depth,
  expected: c.expected,
  got: null,
  ms: null,
  status: 'idle',
}))

function PerftLab() {
  const [rows, setRows] = useState<PerftRow[]>(initialPerft)
  const [running, setRunning] = useState(false)

  async function run() {
    setRunning(true)
    setRows(initialPerft)
    await sleep(30)
    for (let i = 0; i < PERFT_SUITE.length; i++) {
      const c = PERFT_SUITE[i]
      setRows((prev) => prev.map((r, j) => (j === i ? { ...r, status: 'running' } : r)))
      await sleep(20)
      const pos = parseFen(c.fen)
      const t0 = performance.now()
      const got = perft(pos, c.depth)
      const ms = Math.round(performance.now() - t0)
      const status: PerftRow['status'] = got === c.expected ? 'pass' : 'fail'
      setRows((prev) => prev.map((r, j) => (j === i ? { ...r, got, ms, status } : r)))
      await sleep(20)
    }
    setRunning(false)
  }

  const passed = rows.filter((r) => r.status === 'pass').length

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
          <span className={`lab-summary ${passed === rows.length ? 'ok' : 'bad'}`}>
            {passed}/{rows.length} passed
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
              <td>{r.ms ? `${Math.round(r.got! / Math.max(1, r.ms) / 1000)}M/s` : '—'}</td>
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

// ---------------- Tactics ----------------

interface TacticRow extends TacticCase {
  got: string | null
  san: string | null
  scoreText: string | null
  depth: number | null
  ms: number | null
  status: 'idle' | 'running' | 'solved' | 'missed'
}

const MOVE_MS = 1500

function TacticsLab() {
  const engine = useEngine()
  const [rows, setRows] = useState<TacticRow[]>(() =>
    TACTICS.map((t) => ({ ...t, got: null, san: null, scoreText: null, depth: null, ms: null, status: 'idle' })),
  )
  const [running, setRunning] = useState(false)

  const run = useCallback(async () => {
    setRunning(true)
    setRows((prev) => prev.map((r) => ({ ...r, got: null, san: null, scoreText: null, depth: null, ms: null, status: 'idle' })))
    await sleep(30)
    for (let i = 0; i < TACTICS.length; i++) {
      const t = TACTICS[i]
      setRows((prev) => prev.map((r, j) => (j === i ? { ...r, status: 'running' } : r)))
      const pos = parseFen(t.fen)
      const t0 = performance.now()
      const res = await engine.think({ fen: t.fen, history: [], maxDepth: 16, maxTime: MOVE_MS }, () => {})
      const ms = Math.round(performance.now() - t0)
      const best = res.pv[0]
      const got = best ? uci(best) : '—'
      const san = best ? moveToSan(pos, best, generateLegal(pos)) : '—'
      const ok = t.best.includes(got)
      const scoreText = res.mate !== null ? `#${res.mate}` : (res.score >= 0 ? '+' : '') + (res.score / 100).toFixed(2)
      setRows((prev) =>
        prev.map((r, j) =>
          j === i ? { ...r, got, san, scoreText, depth: res.depth, ms, status: ok ? 'solved' : 'missed' } : r,
        ),
      )
    }
    setRunning(false)
  }, [engine])

  const solved = rows.filter((r) => r.status === 'solved').length
  const done = rows.filter((r) => r.status === 'solved' || r.status === 'missed').length

  return (
    <div className="lab">
      <div className="lab-intro">
        <p>
          A live tactics test. The engine gets <strong>{MOVE_MS} ms</strong> on each position from a famous puzzle set —
          forced mates and winning combinations — and we check whether it finds the known best move. It's an honest,
          reproducible measure of tactical strength, run right here in your browser.
        </p>
        <button className="btn primary" onClick={run} disabled={running}>
          {running ? 'Solving…' : 'Run tactics suite'}
        </button>
        {done > 0 && (
          <span className={`lab-summary ${solved === rows.length ? 'ok' : solved >= rows.length * 0.7 ? '' : 'bad'}`}>
            {solved}/{rows.length} solved
          </span>
        )}
      </div>
      <table className="lab-table">
        <thead>
          <tr>
            <th>Puzzle</th>
            <th>Type</th>
            <th>Found</th>
            <th>Eval</th>
            <th>Depth</th>
            <th>Time</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id} className={`lab-row ${r.status === 'solved' ? 'pass' : r.status === 'missed' ? 'fail' : r.status}`}>
              <td title={r.fen}>{r.note}</td>
              <td>{r.kind === 'mate' ? 'mate' : 'win'}</td>
              <td>{r.san ?? '—'}</td>
              <td>{r.scoreText ?? '—'}</td>
              <td>{r.depth ?? '—'}</td>
              <td>{r.ms === null ? '—' : `${r.ms} ms`}</td>
              <td className="lab-status">
                {r.status === 'solved' && '✓'}
                {r.status === 'missed' && '✗'}
                {r.status === 'running' && '…'}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

// ---------------- Correctness self-tests ----------------

interface CheckRow {
  group: string
  name: string
  pass: boolean
  detail: string
}

function mirrorFen(fen: string): string {
  const [board, stm, castle, ep, half, full] = fen.split(/\s+/)
  const rows = board
    .split('/')
    .reverse()
    .map((r) =>
      r
        .split('')
        .map((ch) => (/[a-z]/.test(ch) ? ch.toUpperCase() : /[A-Z]/.test(ch) ? ch.toLowerCase() : ch))
        .join(''),
    )
  const nstm = stm === 'w' ? 'b' : 'w'
  const ncastle =
    castle === '-'
      ? '-'
      : castle
          .split('')
          .map((c) => (/[a-z]/.test(c) ? c.toUpperCase() : c.toLowerCase()))
          .sort()
          .join('')
  const nep = ep === '-' ? '-' : ep[0] + String(9 - Number(ep[1]))
  return `${rows.join('/')} ${nstm} ${ncastle} ${nep} ${half ?? '0'} ${full ?? '1'}`
}

function seeFor(fen: string, from: string, to: string): number {
  const pos = parseFen(fen)
  const f = (from.charCodeAt(1) - 49) * 16 + (from.charCodeAt(0) - 97)
  const t = (to.charCodeAt(1) - 49) * 16 + (to.charCodeAt(0) - 97)
  for (const m of generateLegal(pos)) if (moveFrom(m) === f && moveTo(m) === t) return see(pos, m)
  return NaN
}

function runChecks(): CheckRow[] {
  const out: CheckRow[] = []

  // SEE
  const see1 = seeFor('4k3/8/8/3p4/4P3/8/8/4K3 w - - 0 1', 'e4', 'd5')
  out.push({ group: 'SEE', name: 'pawn takes hanging pawn = +100', pass: see1 === 100, detail: String(see1) })
  const see2 = seeFor('4k3/8/5p2/4p3/8/2Q5/8/4K3 w - - 0 1', 'c3', 'e5')
  out.push({ group: 'SEE', name: 'Qxp defended by pawn is losing', pass: see2 < 0, detail: String(see2) })
  const see3 = seeFor('4k3/8/8/8/8/4n3/8/4R1K1 w - - 0 1', 'e1', 'e3')
  out.push({ group: 'SEE', name: 'Rxn hanging = +knight', pass: see3 === 320, detail: String(see3) })

  // Evaluation symmetry: a mirrored position must score identically.
  const symFens = [
    'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
    'r1bqk2r/pppp1ppp/2n2n2/2b1p3/2B1P3/2N2N2/PPPP1PPP/R1BQK2R w KQkq - 0 1',
    'r3k2r/p1ppqpb1/bn2pnp1/3PN3/1p2P3/2N2Q1p/PPPBBPPP/R3K2R w KQkq - 0 1',
    'r2q1rk1/1b1nbppp/p2ppn2/1p6/3NPP2/1BN1B3/PPPQ2PP/R4RK1 w - - 0 1',
  ]
  for (const f of symFens) {
    const a = evaluate(parseFen(f))
    const b = evaluate(parseFen(mirrorFen(f)))
    out.push({ group: 'Eval symmetry', name: f.slice(0, 24) + '…', pass: a === b, detail: `${a} = ${b}` })
  }

  // KPK bitbase spot checks.
  const kWin = evaluate(parseFen('4k3/8/4K3/4P3/8/8/8/8 w - - 0 1'))
  out.push({ group: 'KPK', name: 'K+P vs K, king ahead → win', pass: kWin > 500, detail: String(kWin) })
  const kDraw = evaluate(parseFen('7k/8/6KP/8/8/8/8/8 b - - 0 1'))
  out.push({ group: 'KPK', name: 'rook-pawn, king in corner → draw', pass: kDraw === 0, detail: String(kDraw) })

  // KRK / KQK tablebases: decisive when winning, exactly 0 in the drawn cases.
  const krk = evaluate(parseFen('8/8/8/4k3/8/8/8/R3K3 w - - 0 1'))
  out.push({ group: 'Tablebase', name: 'K+R vs K → decisive win', pass: krk > 15000, detail: String(krk) })
  const kqk = evaluate(parseFen('8/8/8/5k2/8/8/8/Q3K3 w - - 0 1'))
  out.push({ group: 'Tablebase', name: 'K+Q vs K → decisive win', pass: kqk > 15000, detail: String(kqk) })
  const krkDraw = evaluate(parseFen('8/8/8/8/8/8/2R5/K1k5 b - - 0 1'))
  out.push({ group: 'Tablebase', name: 'K+R vs K, rook hangs → draw', pass: krkDraw === 0, detail: String(krkDraw) })

  // SAN round-trip: every legal move's notation must parse back to that move.
  const sanFens = [
    'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
    'r3k2r/p1ppqpb1/bn2pnp1/3PN3/1p2P3/2N2Q1p/PPPBBPPP/R3K2R w KQkq - 0 1',
    'n1n5/PPPk4/8/8/8/8/4Kppp/5N1N b - - 0 1', // promotions galore
  ]
  let sanChecked = 0
  let sanBad = 0
  for (const f of sanFens) {
    const pos = parseFen(f)
    const legal = generateLegal(pos)
    for (const m of legal) {
      sanChecked++
      if (sanToMove(pos, moveToSan(pos, m, legal)) !== m) sanBad++
    }
  }
  out.push({
    group: 'SAN',
    name: `${sanChecked} moves round-trip through the parser`,
    pass: sanBad === 0,
    detail: sanBad === 0 ? 'all match' : `${sanBad} failed`,
  })

  // PGN import: a real master game parses, replays, and ends in checkmate.
  const opera =
    '[White "Morphy"] [Black "Allies"] [Result "1-0"]\n' +
    '1.e4 e5 2.Nf3 d6 3.d4 Bg4 4.dxe5 Bxf3 5.Qxf3 dxe5 6.Bc4 Nf6 7.Qb3 Qe7 ' +
    '8.Nc3 c6 9.Bg5 b5 10.Nxb5 cxb5 11.Bxb5+ Nbd7 12.O-O-O Rd8 13.Rxd7 Rxd7 ' +
    '14.Rd1 Qe6 15.Bxd7+ Nxd7 16.Qb8+ Nxb8 17.Rd8# 1-0'
  const pg = parsePgn(opera)[0]
  const g = new Game(pg.startFen)
  for (const m of pg.moves) g.apply(m)
  const pgnOk = !pg.error && pg.moves.length === 33 && pg.result === '1-0' && g.result() === 'checkmate'
  out.push({
    group: 'PGN',
    name: 'Opera Game imports and ends in mate',
    pass: pgnOk,
    detail: `${pg.moves.length} plies, ${g.result()}`,
  })

  return out
}

function ChecksLab() {
  const [rows, setRows] = useState<CheckRow[] | null>(null)
  const passed = rows ? rows.filter((r) => r.pass).length : 0

  return (
    <div className="lab">
      <div className="lab-intro">
        <p>
          Deterministic correctness checks for the parts you can't eyeball: <strong>SEE</strong> returns the right
          material swing, the <strong>evaluation is exactly symmetric</strong> (mirroring the board and swapping colours
          negates the score), the <strong>KPK / KRK / KQK tablebases</strong> agree with theory on won and drawn endings,
          every move <strong>round-trips through the SAN parser</strong>, and a real master game <strong>imports from
          PGN</strong> and replays to checkmate.
        </p>
        <button className="btn primary" onClick={() => setRows(runChecks())}>
          Run self-tests
        </button>
        {rows && (
          <span className={`lab-summary ${passed === rows.length ? 'ok' : 'bad'}`}>
            {passed}/{rows.length} passed
          </span>
        )}
      </div>
      {rows && (
        <table className="lab-table">
          <thead>
            <tr>
              <th>Group</th>
              <th>Check</th>
              <th>Value</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={i} className={`lab-row ${r.pass ? 'pass' : 'fail'}`}>
                <td>{r.group}</td>
                <td>{r.name}</td>
                <td>{r.detail}</td>
                <td className="lab-status">{r.pass ? '✓' : '✗'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  )
}

// ---------------- Shell ----------------

export default function Lab() {
  const [mode, setMode] = useState<Mode>('tactics')
  return (
    <div className="lab-shell">
      <div className="tabs lab-tabs">
        <button className={mode === 'tactics' ? 'tab active' : 'tab'} onClick={() => setMode('tactics')}>
          Tactics
        </button>
        <button className={mode === 'perft' ? 'tab active' : 'tab'} onClick={() => setMode('perft')}>
          Perft
        </button>
        <button className={mode === 'checks' ? 'tab active' : 'tab'} onClick={() => setMode('checks')}>
          Self-tests
        </button>
      </div>
      {mode === 'perft' && <PerftLab />}
      {mode === 'tactics' && <TacticsLab />}
      {mode === 'checks' && <ChecksLab />}
    </div>
  )
}
