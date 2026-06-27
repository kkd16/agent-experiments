import { useCallback, useEffect, useRef, useState } from 'react'
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
  moveFlag,
  movePromo,
  FLAG_CASTLE,
  castleKingDest,
  squareName,
  TACTICS,
  type TacticCase,
  parsePgn,
  sanToMove,
  Game,
  EPD_SUITES,
  type EpdCase,
  type KbnkVerification,
  GTB_CONFIGS,
  WDL_CONFIGS,
  wdlMatch,
  wdlReady,
  probeWdl,
  wdlStats,
  isKPvK,
  pawnTbReady,
  pawnTbStats,
  ROOK,
  QUEEN,
  tbCacheKeys,
  tbCacheClear,
  type GtbVerification,
  type WdlVerification,
  type PawnTbVerification,
  Accumulator,
  nnueEvalFresh,
  NnueTrainer,
  gradCheck,
  mulberry32,
  START_FEN,
  WHITE,
  chess960Selftest,
  reviewSelftest,
  Searcher,
  deserializeNnue,
  defaultNnueBlob,
  nnueLoad,
  type NnueWeights,
} from '../engine'
import { useEngine } from '../hooks/useEngine'
import NnueLab from './NnueLab'

type Mode = 'perft' | 'tactics' | 'epd' | 'tablebase' | 'gtb' | 'wdl' | 'pawn' | 'nnue' | 'arena' | 'checks'

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

function uci(m: number): string {
  if (moveFlag(m) === FLAG_CASTLE) return squareName(moveFrom(m)) + squareName(castleKingDest(moveFrom(m), moveTo(m)))
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

// ---------------- EPD suites ----------------

interface EpdRow {
  id: string
  want: string
  got: string | null
  scoreText: string | null
  depth: number | null
  status: 'idle' | 'running' | 'solved' | 'missed'
  fen: string
}

const EPD_BUDGETS = [1000, 2000, 4000]

function EpdLab() {
  const engine = useEngine()
  const [suiteIdx, setSuiteIdx] = useState(0)
  const [budget, setBudget] = useState(2000)
  const [running, setRunning] = useState(false)
  const [rows, setRows] = useState<EpdRow[]>([])

  const suite = EPD_SUITES[suiteIdx]

  const toUci = (m: number) => uci(m)
  const movesToUci = useCallback((c: EpdCase, list: string[]): string[] => {
    const pos = parseFen(c.fen)
    const out: string[] = []
    for (const san of list) {
      const m = sanToMove(pos, san)
      if (m !== null) out.push(toUci(m))
    }
    return out
  }, [])

  const run = useCallback(async () => {
    setRunning(true)
    const init: EpdRow[] = suite.cases.map((c) => ({
      id: c.id,
      want: c.bm.length ? c.bm.join(' / ') : 'avoid ' + c.am.join(' / '),
      got: null,
      scoreText: null,
      depth: null,
      status: 'idle',
      fen: c.fen,
    }))
    setRows(init)
    await sleep(30)
    for (let i = 0; i < suite.cases.length; i++) {
      const c = suite.cases[i]
      setRows((prev) => prev.map((r, j) => (j === i ? { ...r, status: 'running' } : r)))
      const pos = parseFen(c.fen)
      const legal = generateLegal(pos)
      const res = await engine.think({ fen: c.fen, history: [], maxDepth: 24, maxTime: budget }, () => {})
      const best = res.pv[0]
      const gotUci = best ? uci(best) : '—'
      const gotSan = best ? moveToSan(pos, best, legal) : '—'
      const bmUci = movesToUci(c, c.bm)
      const amUci = movesToUci(c, c.am)
      const solved = bmUci.length ? bmUci.includes(gotUci) : !amUci.includes(gotUci)
      const scoreText = res.mate !== null ? `#${res.mate}` : (res.score >= 0 ? '+' : '') + (res.score / 100).toFixed(2)
      setRows((prev) =>
        prev.map((r, j) =>
          j === i ? { ...r, got: gotSan, scoreText, depth: res.depth, status: solved ? 'solved' : 'missed' } : r,
        ),
      )
    }
    setRunning(false)
  }, [engine, suite, budget, movesToUci])

  const solved = rows.filter((r) => r.status === 'solved').length
  const done = rows.filter((r) => r.status === 'solved' || r.status === 'missed').length

  return (
    <div className="lab">
      <div className="lab-intro">
        <p>
          <strong>EPD test suites</strong> are how engines are benchmarked: a position with a <em>published</em> best
          move. The engine gets a fixed budget on each and we report how many it finds — an honest, externally-defined
          measure of strength (these answers are not the engine's own). {suite.blurb}
        </p>
        <div className="epd-controls">
          <label>
            Suite{' '}
            <select value={suiteIdx} onChange={(e) => setSuiteIdx(Number(e.target.value))} disabled={running}>
              {EPD_SUITES.map((s, i) => (
                <option key={s.name} value={i}>
                  {s.name} ({s.cases.length})
                </option>
              ))}
            </select>
          </label>
          <label>
            Budget{' '}
            <select value={budget} onChange={(e) => setBudget(Number(e.target.value))} disabled={running}>
              {EPD_BUDGETS.map((b) => (
                <option key={b} value={b}>
                  {b / 1000}s / move
                </option>
              ))}
            </select>
          </label>
          <button className="btn primary" onClick={run} disabled={running}>
            {running ? 'Solving…' : 'Run suite'}
          </button>
          {done > 0 && (
            <span className={`lab-summary ${solved === rows.length ? 'ok' : solved >= rows.length * 0.6 ? '' : 'bad'}`}>
              {solved}/{rows.length} solved
            </span>
          )}
        </div>
      </div>
      <table className="lab-table">
        <thead>
          <tr>
            <th>ID</th>
            <th>Best move</th>
            <th>Engine</th>
            <th>Eval</th>
            <th>Depth</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr
              key={r.id}
              className={`lab-row ${r.status === 'solved' ? 'pass' : r.status === 'missed' ? 'fail' : r.status}`}
            >
              <td title={r.fen}>{r.id}</td>
              <td>{r.want}</td>
              <td>{r.got ?? '—'}</td>
              <td>{r.scoreText ?? '—'}</td>
              <td>{r.depth ?? '—'}</td>
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

// ---------------- KBN vs K tablebase ----------------

function TablebaseLab() {
  const engine = useEngine()
  const [running, setRunning] = useState(false)
  const [frac, setFrac] = useState(0)
  const [phase, setPhase] = useState('')
  const [report, setReport] = useState<KbnkVerification | null>(null)

  const run = useCallback(async () => {
    setRunning(true)
    setReport(null)
    setFrac(0)
    setPhase('starting')
    await sleep(30)
    const r = await engine.verifyKbnk({ sample: 300000, games: 3000 }, (f, ph) => {
      setFrac(f)
      setPhase(ph)
    })
    setReport(r)
    setRunning(false)
  }, [engine])

  const s = report?.stats
  const rows: { name: string; value: string; ok: boolean }[] = report
    ? [
        {
          name: 'Winning positions solved (White to move)',
          value: s!.won.toLocaleString(),
          ok: s!.won > 10_000_000,
        },
        {
          name: 'Lost positions for the defender',
          value: s!.lost.toLocaleString(),
          ok: s!.lost > 10_000_000,
        },
        { name: 'Drawn positions (piece hangs / stalemate)', value: s!.draw.toLocaleString(), ok: true },
        {
          name: 'Longest forced mate',
          value: `${Math.ceil(s!.maxDtm / 2)} moves (${s!.maxDtm} plies)`,
          ok: s!.maxDtm === 65,
        },
        { name: 'Build time (retrograde analysis)', value: `${(s!.buildMs / 1000).toFixed(1)} s`, ok: true },
        {
          name: 'Retrograde consistency checks',
          value: `${(report.consChecked - report.consBad).toLocaleString()} / ${report.consChecked.toLocaleString()} hold`,
          ok: report.consBad === 0,
        },
        {
          name: 'Optimal self-play games reaching mate',
          value: `${report.selfPlayMated.toLocaleString()} / ${report.selfPlayGames.toLocaleString()}`,
          ok: report.selfPlayMated === report.selfPlayGames,
        },
        {
          name: 'Self-play distance-to-mate mismatches',
          value: `${report.selfPlayMismatch}`,
          ok: report.selfPlayMismatch === 0,
        },
      ]
    : []
  const allOk = rows.length > 0 && rows.every((r) => r.ok)

  return (
    <div className="lab">
      <div className="lab-intro">
        <p>
          The <strong>King + Bishop + Knight vs King</strong> mate is the hardest of the elementary checkmates — it only
          exists in the two corners the bishop controls, and the longest forced win is <strong>33 moves</strong>. This
          builds the <strong>complete distance-to-mate tablebase</strong> — all ~33.6&nbsp;million positions — right here
          in your browser by <strong>backward retrograde analysis</strong> (no embedded data), then proves it from the
          inside: every won position has a faster-losing child, every lost position has all children winning, and
          thousands of optimal self-play games reach mate in exactly the stored distance. Once built, the engine plays
          this ending perfectly.
        </p>
        <button className="btn primary" onClick={run} disabled={running}>
          {running ? 'Solving…' : 'Build & verify KBN vs K'}
        </button>
        {report && (
          <span className={`lab-summary ${allOk ? 'ok' : 'bad'}`}>{allOk ? 'verified ✓' : 'check failed'}</span>
        )}
      </div>
      {running && (
        <div className="tb-progress">
          <div className="tb-bar">
            <div className="tb-fill" style={{ width: `${Math.round(frac * 100)}%` }} />
          </div>
          <span className="tb-phase">
            {phase} — {Math.round(frac * 100)}%
          </span>
        </div>
      )}
      {report && (
        <>
          <table className="lab-table">
            <thead>
              <tr>
                <th>Property</th>
                <th>Value</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.name} className={`lab-row ${r.ok ? 'pass' : 'fail'}`}>
                  <td>{r.name}</td>
                  <td>{r.value}</td>
                  <td className="lab-status">{r.ok ? '✓' : '✗'}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {s!.maxDtmFen && (
            <p className="tb-note">
              A position realising the longest mate (White to move, mate in {Math.ceil(s!.maxDtm / 2)}):{' '}
              <code>{s!.maxDtmFen}</code>
            </p>
          )}
        </>
      )}
    </div>
  )
}

// ---------------- Generalized endgame tablebases ----------------

function EndgamesLab() {
  const engine = useEngine()
  const [id, setId] = useState('KBBvK')
  const [running, setRunning] = useState(false)
  const [frac, setFrac] = useState(0)
  const [phase, setPhase] = useState('')
  const [report, setReport] = useState<GtbVerification | null>(null)
  const [fromCache, setFromCache] = useState(false)
  const [cached, setCached] = useState<string[]>([])

  const refreshCache = useCallback(() => {
    tbCacheKeys().then(setCached)
  }, [])
  useEffect(() => {
    refreshCache()
  }, [refreshCache])

  const config = GTB_CONFIGS.find((c) => c.id === id)!

  const run = useCallback(async () => {
    setRunning(true)
    setReport(null)
    setFrac(0)
    setPhase('starting')
    await sleep(30)
    const before = await tbCacheKeys()
    const r = await engine.verifyGtb({ id, sample: 400000, games: 3000 }, (f, ph) => {
      setFrac(f)
      setPhase(ph)
    })
    setFromCache(before.includes(id))
    setReport(r)
    setRunning(false)
    refreshCache()
  }, [engine, id, refreshCache])

  const clearOne = useCallback(async () => {
    await tbCacheClear(id)
    refreshCache()
  }, [id, refreshCache])

  const s = report?.stats
  const isCached = cached.includes(id)
  const moves = (plies: number) => `${Math.ceil(plies / 2)} moves (${plies} plies)`

  const rows: { name: string; value: string; ok: boolean }[] = report
    ? [
        {
          name: 'Verdict',
          value: s!.decisive ? `forced win — mate in ≤ ${moves(s!.maxDtm)}` : 'drawn with best play',
          ok: true,
        },
        { name: 'Table size (side · squares⁴)', value: s!.size.toLocaleString() + ' entries', ok: true },
        { name: 'Winning positions (strong to move)', value: s!.won.toLocaleString(), ok: true },
        { name: 'Lost positions (defender to move)', value: s!.lost.toLocaleString(), ok: true },
        { name: 'Drawn / non-winning positions', value: s!.draw.toLocaleString(), ok: true },
        {
          name: 'Build time (retrograde analysis)',
          value: `${(s!.buildMs / 1000).toFixed(1)} s${fromCache ? ' (loaded from cache)' : ''}`,
          ok: true,
        },
        ...(report.oracleName
          ? [
              {
                name: `Bit-for-bit vs hand-rolled ${report.oracleName}`,
                value: `${(report.oracleChecked - report.oracleBad).toLocaleString()} / ${report.oracleChecked.toLocaleString()} match`,
                ok: report.oracleBad === 0 && report.oracleChecked > 0,
              },
            ]
          : []),
        {
          name: 'Bellman optimality (sampled)',
          value: `${(report.consChecked - report.consBad).toLocaleString()} / ${report.consChecked.toLocaleString()} hold`,
          ok: report.consBad === 0,
        },
        {
          name: 'Optimal self-play reaching mate',
          value: `${report.selfPlayMated.toLocaleString()} / ${report.selfPlayGames.toLocaleString()}`,
          ok: report.selfPlayMated === report.selfPlayGames,
        },
        {
          name: 'Self-play distance-to-mate mismatches',
          value: `${report.selfPlayMismatch}`,
          ok: report.selfPlayMismatch === 0,
        },
      ]
    : []
  const allOk = rows.length > 0 && rows.every((r) => r.ok)

  return (
    <div className="lab">
      <div className="lab-intro">
        <p>
          One <strong>material-generic</strong> retrograde solver derives the whole family of pawnless 3–4-man{' '}
          <strong>distance-to-mate tablebases</strong> in your browser — no embedded data. It reproduces the hand-rolled{' '}
          <strong>KRvK</strong>, <strong>KQvK</strong> and <strong>KBNvK</strong> tables <em>bit-for-bit</em> (the proof
          it's correct), and newly solves <strong>KBBvK</strong> (a forced win), <strong>KNNvK</strong> (a draw) and the
          major-piece combinations. Built tables are <strong>persisted to IndexedDB</strong>, so the engine then plays
          the ending perfectly with no rebuild. Each build is proven from the inside: Bellman optimality on a random
          sample and thousands of optimal self-play games that mate in exactly the stored distance.
        </p>
        <div className="epd-controls">
          <label>
            Ending{' '}
            <select value={id} onChange={(e) => setId(e.target.value)} disabled={running}>
              {GTB_CONFIGS.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.label}
                  {cached.includes(c.id) ? ' ●' : ''}
                </option>
              ))}
            </select>
          </label>
          <button className="btn primary" onClick={run} disabled={running}>
            {running ? 'Solving…' : `Build & verify ${config.id}`}
          </button>
          {isCached && (
            <button className="btn" onClick={clearOne} disabled={running}>
              Clear cache
            </button>
          )}
          {isCached && <span className="lab-summary">cached ●</span>}
          {report && <span className={`lab-summary ${allOk ? 'ok' : 'bad'}`}>{allOk ? 'verified ✓' : 'check failed'}</span>}
        </div>
      </div>
      {running && (
        <div className="tb-progress">
          <div className="tb-bar">
            <div className="tb-fill" style={{ width: `${Math.round(frac * 100)}%` }} />
          </div>
          <span className="tb-phase">
            {phase} — {Math.round(frac * 100)}%
          </span>
        </div>
      )}
      {report && (
        <>
          <table className="lab-table">
            <thead>
              <tr>
                <th>Property</th>
                <th>Value</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.name} className={`lab-row ${r.ok ? 'pass' : 'fail'}`}>
                  <td>{r.name}</td>
                  <td>{r.value}</td>
                  <td className="lab-status">{r.ok ? '✓' : '✗'}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {s!.decisive && s!.maxDtmFen && (
            <p className="tb-note">
              A position realising the longest mate (White = strong, mate in {Math.ceil(s!.maxDtm / 2)}):{' '}
              <code>{s!.maxDtmFen}</code>
            </p>
          )}
        </>
      )}
    </div>
  )
}

// ---------------- WDL tablebases (a piece on both sides) ----------------

function WdlLab() {
  const engine = useEngine()
  const [id, setId] = useState('KQvKR')
  const [running, setRunning] = useState(false)
  const [frac, setFrac] = useState(0)
  const [phase, setPhase] = useState('')
  const [report, setReport] = useState<WdlVerification | null>(null)
  const [fromCache, setFromCache] = useState(false)
  const [cached, setCached] = useState<string[]>([])

  const refreshCache = useCallback(() => {
    tbCacheKeys().then((ks) => setCached(ks.filter((k) => k.startsWith('WDL:')).map((k) => k.slice(4))))
  }, [])
  useEffect(() => {
    refreshCache()
  }, [refreshCache])

  const config = WDL_CONFIGS.find((c) => c.id === id)!

  const run = useCallback(async () => {
    setRunning(true)
    setReport(null)
    setFrac(0)
    setPhase('starting')
    await sleep(30)
    const before = await tbCacheKeys()
    const r = await engine.verifyWdl({ id, sample: 400000, games: 3000 }, (f, ph) => {
      setFrac(f)
      setPhase(ph)
    })
    setFromCache(before.includes('WDL:' + id))
    setReport(r)
    setRunning(false)
    refreshCache()
  }, [engine, id, refreshCache])

  const clearOne = useCallback(async () => {
    await tbCacheClear('WDL:' + id)
    refreshCache()
  }, [id, refreshCache])

  const s = report?.stats
  const isCached = cached.includes(id)
  const moves = (plies: number) => `${Math.ceil(plies / 2)} moves (${plies} plies)`
  const pct = (n: number) => (s && s.legal > 0 ? ((n / s.legal) * 100).toFixed(1) + '%' : '')

  const verdict =
    s &&
    (report!.theoryExpectDecisive
      ? `a forced win for the stronger side — longest mate in ${moves(s.maxDtm)}`
      : config.white === config.black
        ? 'a draw with best play (a perfectly symmetric balance)'
        : `a draw with best play — the rook converts only ${pct(s.whiteWin)} of positions, the minor never wins`)

  const rows: { name: string; value: string; ok: boolean }[] = report
    ? [
        { name: 'Verdict (perfect play)', value: verdict!, ok: true },
        { name: 'Table size (stm · squares⁴)', value: s!.size.toLocaleString() + ' entries', ok: true },
        { name: 'Legal positions', value: s!.legal.toLocaleString(), ok: true },
        { name: `Wins for the ${config.white === config.black ? 'first' : 'stronger'} side`, value: `${s!.whiteWin.toLocaleString()} (${pct(s!.whiteWin)})`, ok: true },
        { name: 'Wins for the defender (it snaps off a hanging piece)', value: `${s!.blackWin.toLocaleString()} (${pct(s!.blackWin)})`, ok: true },
        { name: 'Drawn positions', value: `${s!.draw.toLocaleString()} (${pct(s!.draw)})`, ok: true },
        {
          name: 'Build time (WDL retrograde analysis)',
          value: `${(s!.buildMs / 1000).toFixed(1)} s${fromCache ? ' (loaded from cache)' : ''}`,
          ok: true,
        },
        {
          name: 'Bellman optimality (sampled)',
          value: `${(report.consChecked - report.consBad).toLocaleString()} / ${report.consChecked.toLocaleString()} hold`,
          ok: report.consBad === 0,
        },
        {
          name: 'Optimal self-play matches the stored DTM',
          value: `${report.selfPlayOk.toLocaleString()} / ${report.selfPlayGames.toLocaleString()}`,
          ok: report.selfPlayMismatch === 0 && report.selfPlayOk > 0,
        },
        {
          name: 'Endgame-theory cross-check',
          value: report.theoryExpectDecisive ? 'decisive (queen wins)' : 'drawn / balanced',
          ok: report.theoryPass,
        },
      ]
    : []
  const allOk = rows.length > 0 && rows.every((r) => r.ok)

  return (
    <div className="lab">
      <div className="lab-intro">
        <p>
          Every other tablebase here assumes the defender is a <em>lone king</em>. These solve the genuinely{' '}
          <strong>three-valued</strong> endings with a <strong>piece on both sides</strong> — where the side to move can{' '}
          <strong>win, lose, or draw</strong>. A from-scratch <strong>Win/Draw/Loss + distance-to-mate</strong> retrograde
          solver builds the whole ~33.5-million-position table in your browser (no embedded data); captures leave the table
          to the 3-man KQvK/KRvK sub-tables. The headline <strong>KQvKR</strong> is a win (the famous mate-in-35), while{' '}
          <strong>KRvKB</strong>/<strong>KRvKN</strong> are draws — the defender escaping with …Bxr into a drawn K+minor
          ending. Each build is proven from the inside: <strong>Bellman optimality</strong> on a random sample and thousands
          of <strong>optimal self-play</strong> games that mate in exactly the stored distance.
        </p>
        <div className="epd-controls">
          <label>
            Ending{' '}
            <select value={id} onChange={(e) => setId(e.target.value)} disabled={running}>
              {WDL_CONFIGS.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.label}
                  {cached.includes(c.id) ? ' ●' : ''}
                </option>
              ))}
            </select>
          </label>
          <button className="btn primary" onClick={run} disabled={running}>
            {running ? 'Solving…' : `Build & verify ${config.id}`}
          </button>
          {isCached && (
            <button className="btn" onClick={clearOne} disabled={running}>
              Clear cache
            </button>
          )}
          {isCached && <span className="lab-summary">cached ●</span>}
          {report && <span className={`lab-summary ${allOk ? 'ok' : 'bad'}`}>{allOk ? 'verified ✓' : 'check failed'}</span>}
        </div>
        <p className="tb-note">Heads-up: a full build runs ~20–55 s of retrograde analysis the first time; it is then cached.</p>
      </div>
      {running && (
        <div className="tb-progress">
          <div className="tb-bar">
            <div className="tb-fill" style={{ width: `${Math.round(frac * 100)}%` }} />
          </div>
          <span className="tb-phase">
            {phase} — {Math.round(frac * 100)}%
          </span>
        </div>
      )}
      {report && (
        <>
          <table className="lab-table">
            <thead>
              <tr>
                <th>Property</th>
                <th>Value</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.name} className={`lab-row ${r.ok ? 'pass' : 'fail'}`}>
                  <td>{r.name}</td>
                  <td>{r.value}</td>
                  <td className="lab-status">{r.ok ? '✓' : '✗'}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {s!.maxDtm > 0 && s!.maxDtmFen && (
            <p className="tb-note">
              A position realising the longest mate (White holds the {config.label.split(' ')[0].slice(2)}, mate in{' '}
              {Math.ceil(s!.maxDtm / 2)}): <code>{s!.maxDtmFen}</code>
            </p>
          )}
        </>
      )}
    </div>
  )
}

// ---------------- Pawnful KPvK distance-to-mate tablebase ----------------

function PawnTbLab() {
  const engine = useEngine()
  const [running, setRunning] = useState(false)
  const [frac, setFrac] = useState(0)
  const [phase, setPhase] = useState('')
  const [report, setReport] = useState<PawnTbVerification | null>(null)
  const [fromCache, setFromCache] = useState(false)
  const [cached, setCached] = useState(false)

  const refreshCache = useCallback(() => {
    tbCacheKeys().then((ks) => setCached(ks.includes('KPvK')))
  }, [])
  useEffect(() => {
    refreshCache()
  }, [refreshCache])

  const run = useCallback(async () => {
    setRunning(true)
    setReport(null)
    setFrac(0)
    setPhase('starting')
    await sleep(30)
    const before = await tbCacheKeys()
    const r = await engine.verifyPawnTb({ sample: 120000, games: 3000 }, (f, ph) => {
      setFrac(f)
      setPhase(ph)
    })
    setFromCache(before.includes('KPvK'))
    setReport(r)
    setRunning(false)
    refreshCache()
  }, [engine, refreshCache])

  const clearOne = useCallback(async () => {
    await tbCacheClear('KPvK')
    refreshCache()
  }, [refreshCache])

  const s = report?.stats
  const pct = (n: number) => (s && s.legal > 0 ? ((n / s.legal) * 100).toFixed(1) + '%' : '')
  const moves = (plies: number) => `${Math.ceil(plies / 2)} moves (${plies} plies)`

  const rows: { name: string; value: string; ok: boolean }[] = report
    ? [
        { name: 'Verdict (perfect play)', value: `the pawn side wins ${pct(s!.wins)} of legal positions; the rest are exact draws`, ok: true },
        { name: 'Legal positions', value: s!.legal.toLocaleString(), ok: true },
        { name: 'Wins for the pawn side', value: `${s!.wins.toLocaleString()} (${pct(s!.wins)})`, ok: true },
        { name: 'Drawn positions', value: `${s!.draws.toLocaleString()} (${pct(s!.draws)})`, ok: true },
        { name: 'Longest forced mate', value: moves(s!.maxDtm), ok: true },
        {
          name: 'EXHAUSTIVE WDL agreement vs the kpk bitbase',
          value: `${(report.oracleChecked - report.oracleMismatch).toLocaleString()} / ${report.oracleChecked.toLocaleString()} agree`,
          ok: report.oracleMismatch === 0,
        },
        {
          name: 'Bellman optimality (sampled)',
          value: `${(report.bellmanChecked - report.bellmanBad).toLocaleString()} / ${report.bellmanChecked.toLocaleString()} hold`,
          ok: report.bellmanBad === 0,
        },
        {
          name: 'Self-play to promotion matches the stored DTM',
          value: `${report.selfPlayOk.toLocaleString()} / ${report.selfPlayGames.toLocaleString()}`,
          ok: report.selfPlayBad === 0 && report.selfPlayOk > 0,
        },
        { name: 'Cached to IndexedDB', value: fromCache ? 'loaded from cache' : 'built + persisted', ok: true },
      ]
    : []
  const allOk = rows.length > 0 && rows.every((r) => r.ok)

  return (
    <div className="lab">
      <div className="lab-intro">
        <p>
          The engine's first <strong>pawnful</strong> tablebase. Every other table here is{' '}
          <em>pawnless</em> — the material never changes. A pawn breaks that: it only moves forward, and it{' '}
          <strong>promotes</strong>, <em>leaving</em> King + Pawn vs King to become a brand-new K+Q-vs-K or
          K+R-vs-K position. There is no checkmate in KPvK at all, so <strong>every win flows through a
          promotion</strong>: the win values are seeded by <strong>promotion edges into the already-solved
          KQvK / KRvK distance-to-mate tables</strong>. The pawn side queens with the fastest forced mate —
          and <em>underpromotes to a rook</em> when a queen would only stalemate. The whole ~378-thousand
          position table is solved in-browser by retrograde analysis (no embedded data) and proven three ways:
          an <strong>exhaustive</strong> win/draw agreement against the wholly-independent KPK bitbase, Bellman
          optimality, and optimal self-play whose plies-to-promotion plus the sub-table's mate equal the stored
          distance.
        </p>
        <div className="epd-controls">
          <button className="btn primary" onClick={run} disabled={running}>
            {running ? 'Solving…' : 'Build & verify KPvK'}
          </button>
          {cached && (
            <button className="btn" onClick={clearOne} disabled={running}>
              Clear cache
            </button>
          )}
          {cached && <span className="lab-summary">cached ●</span>}
          {report && <span className={`lab-summary ${allOk ? 'ok' : 'bad'}`}>{allOk ? 'verified ✓' : 'check failed'}</span>}
        </div>
        <p className="tb-note">
          Once built &amp; verified here it is cached, and the engine plays King + Pawn vs King with literally
          perfect technique. (The classical KPK bitbase already prevents blunders before you build this.)
        </p>
      </div>
      {running && (
        <div className="tb-progress">
          <div className="tb-bar">
            <div className="tb-fill" style={{ width: `${Math.round(frac * 100)}%` }} />
          </div>
          <span className="tb-phase">
            {phase} — {Math.round(frac * 100)}%
          </span>
        </div>
      )}
      {report && (
        <>
          <table className="lab-table">
            <thead>
              <tr>
                <th>Property</th>
                <th>Value</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.name} className={`lab-row ${r.ok ? 'pass' : 'fail'}`}>
                  <td>{r.name}</td>
                  <td>{r.value}</td>
                  <td className="lab-status">{r.ok ? '✓' : '✗'}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {s!.maxDtm > 0 && s!.maxDtmFen && (
            <p className="tb-note">
              A position realising the longest forced win (mate in {Math.ceil(s!.maxDtm / 2)}):{' '}
              <code>{s!.maxDtmFen}</code>
            </p>
          )}
        </>
      )}
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

  // WDL (pieces-on-both-sides) routing + probe. The big tables build in the WDL TBs
  // tab; here we check the classification is correct and — when a table is resident —
  // that the probe + colour-canonicalisation agree on a known win.
  const wm1 = wdlMatch('8/8/8/4k3/8/8/8/Q2K1r2 w - - 0 1')
  out.push({ group: 'WDL', name: 'K+Q vs K+R routes to the KQvKR table', pass: wm1 === 'KQvKR', detail: String(wm1) })
  const wm2 = wdlMatch('8/8/8/4k3/8/8/4r3/3K1b2 w - - 0 1') // R vs B → stronger piece first
  out.push({ group: 'WDL', name: 'K+R vs K+B routes to the KRvKB table', pass: wm2 === 'KRvKB', detail: String(wm2) })
  const wm3 = wdlMatch('8/8/8/4k3/4p3/8/8/Q2K1r2 w - - 0 1') // pawns present → not a WDL ending
  out.push({ group: 'WDL', name: 'a position with pawns is not a WDL ending', pass: wm3 === null, detail: String(wm3) })
  const kqvkrStats = wdlReady('KQvKR') ? wdlStats('KQvKR') : null
  if (kqvkrStats && kqvkrStats.maxDtmFen) {
    // The stored longest-win position (White holds the Q) must probe as that exact win,
    // and a vertical colour-mirror (real Black holds the Q) must recover it identically.
    const sqOf: Record<string, number> = {}
    const [place, stm] = kqvkrStats.maxDtmFen.split(/\s+/)
    place.split('/').forEach((row, r) => {
      const rank = 7 - r
      let f = 0
      for (const ch of row) {
        if (ch >= '1' && ch <= '8') f += +ch
        else {
          sqOf[ch] = rank * 8 + f
          f++
        }
      }
    })
    const a = probeWdl('KQvKR', sqOf['K'], sqOf['k'], QUEEN, sqOf['Q'], ROOK, sqOf['r'], stm === 'w')
    const b = probeWdl('KQvKR', sqOf['k'] ^ 56, sqOf['K'] ^ 56, ROOK, sqOf['r'] ^ 56, QUEEN, sqOf['Q'] ^ 56, stm !== 'w')
    out.push({
      group: 'WDL',
      name: 'KQvKR longest-win probe + colour-mirror agree',
      pass: a.wdl === 'win' && a.dtm === kqvkrStats.maxDtm && b.wdl === 'win' && b.dtm === a.dtm,
      detail: `${a.wdl} ${a.dtm} / ${b.wdl} ${b.dtm}`,
    })
  } else {
    out.push({ group: 'WDL', name: 'KQvKR table resident (build it in the WDL TBs tab)', pass: true, detail: 'not built — optional' })
  }

  // Pawnful KPvK routing + the always-on (bitbase) verdict. The exact-DTM table
  // builds in the Pawn TB tab; here we check classification and the won/drawn eval
  // that the classical KPK bitbase already gives before any build.
  out.push({ group: 'Pawn TB', name: 'K+P vs K is detected as a pawn ending', pass: isKPvK('4k3/8/4K3/4P3/8/8/8/8 w - - 0 1'), detail: 'isKPvK' })
  out.push({ group: 'Pawn TB', name: 'K+Q vs K is not a KPvK ending', pass: !isKPvK('8/8/8/5k2/8/8/8/Q3K3 w - - 0 1'), detail: 'isKPvK' })
  const kpWin = evaluate(parseFen('4k3/8/4K3/4P3/8/8/8/8 w - - 0 1'))
  out.push({ group: 'Pawn TB', name: 'Ke6/Pe5 vs Ke8 → winning for the pawn side', pass: kpWin > 500, detail: String(kpWin) })
  const kpDraw = evaluate(parseFen('k7/8/8/8/8/8/P7/K7 w - - 0 1'))
  out.push({ group: 'Pawn TB', name: 'a-pawn, defending king on a8 (cut off) → draw', pass: kpDraw === 0, detail: String(kpDraw) })
  if (pawnTbReady()) {
    const st = pawnTbStats()
    out.push({ group: 'Pawn TB', name: 'exact DTM table resident → KPvK plays perfectly', pass: st.wins > 0 && st.maxDtm > 0, detail: `maxDTM ${st.maxDtm}` })
  } else {
    out.push({ group: 'Pawn TB', name: 'exact DTM table resident (build it in the Pawn TB tab)', pass: true, detail: 'not built — optional' })
  }
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

  // NNUE: the incrementally-updated accumulator must stay bit-for-bit identical to
  // a from-scratch refresh across a sequence of make/unmake (the defining property
  // that makes the net cheap to run in search), and the hand-derived gradients must
  // agree with finite differences.
  {
    const w = new NnueTrainer({ h: 32, seed: 0x42, weightInit: 0.3 }).w
    const rng = mulberry32(7)
    const acc = new Accumulator(w)
    const gg = new Game(START_FEN)
    acc.refresh(gg.pos)
    let maxDiff = 0
    let mismatch = 0
    let n = 0
    for (let ply = 0; ply < 40; ply++) {
      const moves = generateLegal(gg.pos)
      if (moves.length === 0) break
      const m = moves[Math.floor(rng() * moves.length)]
      acc.applyMove(gg.pos, m, 1)
      gg.apply(m)
      n++
      const fresh = new Accumulator(w)
      fresh.refresh(gg.pos)
      for (let j = 0; j < w.h; j++) {
        maxDiff = Math.max(maxDiff, Math.abs(acc.white[j] - fresh.white[j]), Math.abs(acc.black[j] - fresh.black[j]))
      }
      if (acc.evalScore(gg.pos.turn) !== nnueEvalFresh(w, gg.pos)) mismatch++
    }
    out.push({
      group: 'NNUE',
      name: 'incremental accumulator == full refresh',
      pass: maxDiff < 1e-3 && mismatch === 0,
      detail: `max Δ ${maxDiff.toExponential(2)}, ${mismatch}/${n} eval mismatches`,
    })
  }
  {
    const gc = gradCheck(11, 16)
    out.push({
      group: 'NNUE',
      name: 'hand-derived gradients vs finite differences',
      pass: gc.maxRelErr < 1e-2,
      detail: `max rel err ${gc.maxRelErr.toExponential(2)} over ${gc.checked} params`,
    })
  }

  // Chess960 (Fischer Random): the whole layer self-verifies — id⇄position
  // bijection, the standard position routed through the 960 castle code matches
  // reference perft, make/unmake + hashing stay exact across random 960 trees,
  // an independent oracle confirms every castle move, and perft is colour-symmetric.
  for (const c of chess960Selftest()) out.push({ group: 'Chess960', name: c.name, pass: c.pass, detail: c.detail })

  // Cortex Coach review model: win% is monotone/symmetric and pinned at 50 cp=0,
  // accuracy is 100 at no loss and decreasing, and the classifier flags a forced
  // mate / a large swing / a best move correctly.
  for (const c of reviewSelftest().checks) out.push({ group: 'Review', name: c.name, pass: c.ok, detail: c.detail })

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
          every move <strong>round-trips through the SAN parser</strong>, a real master game <strong>imports from
          PGN</strong> and replays to checkmate, and the entire <strong>Chess960</strong> layer self-verifies (id⇄position
          bijection, an exact perft anchor, hash/make-unmake integrity, and an independent castle-move oracle).
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

// ---------------- Engine Arena ----------------

// A node budget per move — the engine's binding constraint here, so the ladder is
// deterministic and the games stay fast. More nodes ⇒ deeper search ⇒ stronger.
interface ArenaLevel {
  label: string
  nodes: number
}
const ARENA_LEVELS: ArenaLevel[] = [
  { label: '2k nodes', nodes: 2000 },
  { label: '8k nodes', nodes: 8000 },
  { label: '30k nodes', nodes: 30000 },
  { label: '100k nodes', nodes: 100000 },
]

type ArenaEval = 'classical' | 'nnue'

interface ArenaConfig {
  level: number
  eval: ArenaEval
}

// Balanced, varied opening positions so the games aren't carbon copies. Each is
// played from both sides as the match alternates colours.
const ARENA_OPENINGS: { name: string; fen: string }[] = [
  { name: 'Ruy Lopez', fen: 'r1bqkbnr/1ppp1ppp/p1n5/1B2p3/4P3/5N2/PPPP1PPP/RNBQK2R w KQkq - 0 4' },
  { name: 'Italian', fen: 'r1bqkbnr/pppp1ppp/2n5/4p3/2B1P3/5N2/PPPP1PPP/RNBQK2R b KQkq - 4 3' },
  { name: 'Sicilian', fen: 'rnbqkbnr/pp1ppppp/8/2p5/4P3/8/PPPP1PPP/RNBQKBNR w KQkq c6 0 2' },
  { name: 'French', fen: 'rnbqkbnr/pppp1ppp/4p3/8/3PP3/8/PPP2PPP/RNBQKBNR b KQkq d3 0 2' },
  { name: 'Caro-Kann', fen: 'rnbqkbnr/pp1ppppp/2p5/8/3PP3/8/PPP2PPP/RNBQKBNR b KQkq d3 0 2' },
  { name: 'Queen’s Gambit', fen: 'rnbqkbnr/ppp1pppp/8/3p4/2PP4/8/PP2PPPP/RNBQKBNR b KQkq - 0 2' },
  { name: 'King’s Indian', fen: 'rnbqkb1r/pppppp1p/5np1/8/3P4/8/PPP1PPPP/RNBQKBNR w KQkq - 0 3' },
  { name: 'English', fen: 'rnbqkbnr/pppp1ppp/8/4p3/2P5/8/PP1PPPPP/RNBQKBNR w KQkq - 0 2' },
]

interface ArenaGame {
  opening: string
  aWhite: boolean
  result: 'a' | 'b' | 'draw'
  reason: string
  plies: number
}

interface ArenaState {
  running: boolean
  done: number
  total: number
  games: ArenaGame[]
}

// numeric erf for the likelihood-of-superiority calculation.
function erf(x: number): number {
  const t = 1 / (1 + 0.3275911 * Math.abs(x))
  const y =
    1 -
    ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) *
      t *
      Math.exp(-x * x)
  return x >= 0 ? y : -y
}

function eloFromScore(score: number): number {
  const s = Math.max(1e-4, Math.min(1 - 1e-4, score))
  return -400 * Math.log10(1 / s - 1)
}

function ArenaConfigPicker({
  label,
  cfg,
  set,
}: {
  label: string
  cfg: ArenaConfig
  set: (c: ArenaConfig) => void
}) {
  return (
    <div className="arena-cfg">
      <div className="arena-cfg-label">{label}</div>
      <div className="mpv-seg arena-seg">
        {ARENA_LEVELS.map((lv, i) => (
          <button key={lv.label} className={cfg.level === i ? 'mpv-btn active' : 'mpv-btn'} onClick={() => set({ ...cfg, level: i })}>
            {lv.label}
          </button>
        ))}
      </div>
      <div className="mpv-seg arena-seg">
        {(['classical', 'nnue'] as ArenaEval[]).map((e) => (
          <button key={e} className={cfg.eval === e ? 'mpv-btn active' : 'mpv-btn'} onClick={() => set({ ...cfg, eval: e })}>
            {e === 'nnue' ? 'NNUE' : 'classical'}
          </button>
        ))}
      </div>
    </div>
  )
}

function ArenaLab() {
  const [a, setA] = useState<ArenaConfig>({ level: 0, eval: 'classical' })
  const [b, setB] = useState<ArenaConfig>({ level: 2, eval: 'classical' })
  const [gamesN, setGamesN] = useState(12)
  const [state, setState] = useState<ArenaState | null>(null)
  const netRef = useRef<NnueWeights | null>(null)
  const cancelRef = useRef(false)

  // Lazily load a net (a Lab-trained one if present, else the shipped default).
  const ensureNet = useCallback(async (): Promise<NnueWeights> => {
    if (netRef.current) return netRef.current
    const saved = await nnueLoad().catch(() => null)
    const blob = saved?.blob ?? defaultNnueBlob()
    netRef.current = deserializeNnue(blob)
    return netRef.current
  }, [])

  const run = useCallback(async () => {
    cancelRef.current = false
    const net = a.eval === 'nnue' || b.eval === 'nnue' ? await ensureNet() : null
    const sA = new Searcher()
    sA.setEvaluator(a.eval === 'nnue' ? net : null)
    const sB = new Searcher()
    sB.setEvaluator(b.eval === 'nnue' ? net : null)
    const nodesA = ARENA_LEVELS[a.level].nodes
    const nodesB = ARENA_LEVELS[b.level].nodes

    const st: ArenaState = { running: true, done: 0, total: gamesN, games: [] }
    setState({ ...st, games: [] })

    for (let game = 0; game < gamesN && !cancelRef.current; game++) {
      const opening = ARENA_OPENINGS[game % ARENA_OPENINGS.length]
      const aWhite = game % 2 === 0
      const g = new Game(opening.fen)
      let ply = 0
      const maxPly = 200
      for (; ply < maxPly && g.result() === 'playing'; ply++) {
        const useA = (g.pos.turn === WHITE) === aWhite
        const s = useA ? sA : sB
        const r = s.search(g.pos, {
          maxDepth: 30,
          maxTime: 0,
          maxNodes: useA ? nodesA : nodesB,
          history: g.keyHistory(),
        })
        if (!r.pv[0]) break
        g.apply(r.pv[0])
        if (ply % 3 === 0) await sleep(0)
      }
      const res = g.result()
      let result: ArenaGame['result'] = 'draw'
      let reason = res === 'playing' ? 'adjudicated draw (200 plies)' : res
      if (res === 'checkmate') {
        const loserWhite = g.pos.turn === WHITE
        const aLost = loserWhite === aWhite
        result = aLost ? 'b' : 'a'
        reason = 'checkmate'
      }
      st.games.push({ opening: opening.name, aWhite, result, reason, plies: ply })
      st.done = game + 1
      setState({ ...st, games: st.games.slice() })
      await sleep(0)
    }
    st.running = false
    setState({ ...st, games: st.games.slice() })
  }, [a, b, gamesN, ensureNet])

  const stop = useCallback(() => {
    cancelRef.current = true
  }, [])

  // Tallies + Elo.
  const stats = (() => {
    if (!state || state.games.length === 0) return null
    let aw = 0
    let bw = 0
    let dr = 0
    for (const gm of state.games) {
      if (gm.result === 'a') aw++
      else if (gm.result === 'b') bw++
      else dr++
    }
    const n = state.games.length
    const pointsA = aw + dr / 2
    const score = pointsA / n
    const elo = eloFromScore(score)
    // 95% CI on the score → asymmetric Elo bounds.
    const xs: number[] = state.games.map((gm) => (gm.result === 'a' ? 1 : gm.result === 'draw' ? 0.5 : 0))
    const mean = score
    const variance = n > 1 ? xs.reduce((acc, x) => acc + (x - mean) * (x - mean), 0) / (n - 1) : 0
    const se = Math.sqrt(variance / n)
    const margin = 1.96 * se
    const eloLow = eloFromScore(mean - margin)
    const eloHigh = eloFromScore(mean + margin)
    const decisive = aw + bw
    const los = decisive > 0 ? 0.5 * (1 + erf((aw - bw) / Math.sqrt(2 * decisive))) : 0.5
    return { aw, bw, dr, n, pointsA, score, elo, eloLow, eloHigh, los }
  })()

  const cfgLabel = (c: ArenaConfig) => `${ARENA_LEVELS[c.level].label} · ${c.eval === 'nnue' ? 'NNUE' : 'classical'}`

  const running = state?.running ?? false

  return (
    <div className="lab arena-lab">
      <div className="lab-intro">
        <p>
          <strong>Engine Arena.</strong> Pit two configurations of the same engine head-to-head over a set of varied
          openings (each played from both colours), then read off the result as an <strong>Elo difference</strong> with
          a 95% confidence interval and the likelihood one side is genuinely stronger (LOS). A real, in-browser way to
          measure that more search — or the neural eval — actually buys strength.
        </p>
      </div>

      <div className="arena-configs">
        <ArenaConfigPicker label="Engine A" cfg={a} set={setA} />
        <span className="arena-vs">vs</span>
        <ArenaConfigPicker label="Engine B" cfg={b} set={setB} />
      </div>

      <div className="arena-controls">
        <div className="arena-games">
          <span className="movetime-label">Games</span>
          <div className="mpv-seg">
            {[6, 12, 20, 40].map((n) => (
              <button key={n} className={gamesN === n ? 'mpv-btn active' : 'mpv-btn'} onClick={() => setGamesN(n)} disabled={running}>
                {n}
              </button>
            ))}
          </div>
        </div>
        {running ? (
          <button className="btn" onClick={stop}>Stop</button>
        ) : (
          <button className="btn primary" onClick={run}>Play match</button>
        )}
      </div>

      {state && (
        <>
          <div className="arena-score">
            <div className="arena-side a">
              <div className="arena-side-name">A · {cfgLabel(a)}</div>
              <div className="arena-side-pts">{stats ? stats.pointsA.toFixed(1) : '0'}</div>
            </div>
            <div className="arena-mid">
              <div className="arena-progress-text">{state.done}/{state.total}{running ? ' · playing…' : ''}</div>
              {stats && (
                <div className="arena-wdl">
                  +{stats.aw} ={stats.dr} −{stats.bw}
                </div>
              )}
            </div>
            <div className="arena-side b">
              <div className="arena-side-name">B · {cfgLabel(b)}</div>
              <div className="arena-side-pts">{stats ? (stats.n - stats.pointsA).toFixed(1) : '0'}</div>
            </div>
          </div>

          {stats && (
            <div className="arena-elo">
              <div className="arena-elo-main">
                A − B: <strong>{stats.elo >= 0 ? '+' : ''}{stats.elo.toFixed(0)}</strong> Elo
                <span className="arena-elo-ci">
                  {' '}[{stats.eloLow.toFixed(0)}, {stats.eloHigh.toFixed(0)}] · 95% CI
                </span>
              </div>
              <div className="arena-los">
                LOS (A stronger): <strong>{(stats.los * 100).toFixed(1)}%</strong>
              </div>
            </div>
          )}

          <div className="arena-games-strip">
            {state.games.map((gm, i) => (
              <span
                key={i}
                className={`arena-dot ${gm.result}`}
                title={`Game ${i + 1}: ${gm.opening} — A played ${gm.aWhite ? 'White' : 'Black'} — ${
                  gm.result === 'a' ? 'A won' : gm.result === 'b' ? 'B won' : 'draw'
                } (${gm.reason}, ${gm.plies} plies)`}
              />
            ))}
          </div>
        </>
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
        <button className={mode === 'epd' ? 'tab active' : 'tab'} onClick={() => setMode('epd')}>
          EPD suites
        </button>
        <button className={mode === 'tablebase' ? 'tab active' : 'tab'} onClick={() => setMode('tablebase')}>
          KBN vs K
        </button>
        <button className={mode === 'gtb' ? 'tab active' : 'tab'} onClick={() => setMode('gtb')}>
          Endgame TBs
        </button>
        <button className={mode === 'wdl' ? 'tab active' : 'tab'} onClick={() => setMode('wdl')}>
          WDL TBs
        </button>
        <button className={mode === 'pawn' ? 'tab active' : 'tab'} onClick={() => setMode('pawn')}>
          Pawn TB
        </button>
        <button className={mode === 'nnue' ? 'tab active' : 'tab'} onClick={() => setMode('nnue')}>
          NNUE
        </button>
        <button className={mode === 'arena' ? 'tab active' : 'tab'} onClick={() => setMode('arena')}>
          Arena
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
      {mode === 'epd' && <EpdLab />}
      {mode === 'tablebase' && <TablebaseLab />}
      {mode === 'gtb' && <EndgamesLab />}
      {mode === 'wdl' && <WdlLab />}
      {mode === 'pawn' && <PawnTbLab />}
      {mode === 'nnue' && <NnueLab />}
      {mode === 'arena' && <ArenaLab />}
      {mode === 'checks' && <ChecksLab />}
    </div>
  )
}
