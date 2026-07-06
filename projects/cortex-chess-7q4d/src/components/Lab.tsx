import { Fragment, useCallback, useEffect, useRef, useState } from 'react'
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
  chess960Selftest,
  reviewSelftest,
  mctsSelftest,
  defaultNnueBlob,
  nnueLoad,
  ARENA_OPENINGS,
  losFromH2H,
  type EngineSpec,
  type EvalKind,
  type MatchTally,
  type SprtParams,
  type Standing,
  type NnueBlob,
} from '../engine'
import type { SprtProgress, TourProgress } from '../engine/arena.worker'
import { useEngine } from '../hooks/useEngine'
import NnueLab from './NnueLab'
import BitboardLab from './BitboardLab'

type Mode = 'perft' | 'bitboard' | 'tactics' | 'epd' | 'tablebase' | 'gtb' | 'wdl' | 'pawn' | 'nnue' | 'arena' | 'checks'

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

  // PUCT Monte-Carlo Tree Search (the second search engine): the MCTS-Solver finds
  // and proves known mates, the visit bookkeeping is exact, the priors are a valid
  // distribution and the principal variation is legal.
  {
    const t = mctsSelftest()
    for (const c of t.cases) {
      out.push({
        group: 'MCTS',
        name: c.name,
        pass: c.pass,
        detail: `played ${c.got}${c.expect ? ` (want ${c.expect})` : ''} · ${c.scoreCp >= 0 ? '+' : ''}${(c.scoreCp / 100).toFixed(2)} · ${c.nodes} sims`,
      })
    }
    out.push({ group: 'MCTS', name: 'root priors sum to 1', pass: t.priorsNormalised, detail: `max error ${t.maxPriorError.toExponential(2)}` })
    out.push({ group: 'MCTS', name: 'Σ root visits == simulations', pass: t.visitsConsistent, detail: t.visitsConsistent ? 'exact' : 'mismatch' })
    out.push({ group: 'MCTS', name: 'principal variation is legal', pass: t.pvLegal, detail: t.pvLegal ? 'replays cleanly' : 'illegal move in PV' })
  }

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
//
// A real statistical strength-testing lab. Two modes: an **SPRT match** (A vs B,
// stopped the instant the sequential test decides) and a **round-robin tournament**
// with Bradley–Terry maximum-likelihood ratings. All game-playing happens in a
// dedicated Web Worker (`arena.worker.ts`) so the UI never freezes; the stats
// (SPRT, pentanomial variance, Elo±CI, LOS, MLE ratings) live in `engine/arena.ts`.

const AB_BUDGETS = [2000, 8000, 30000, 100000]
const MCTS_BUDGETS = [800, 2500, 8000]

function makeSpec(search: 'ab' | 'mcts', budget: number, evalKind: EvalKind): EngineSpec {
  const algo = search === 'ab' ? 'AB' : 'MCTS'
  const unit = search === 'ab' ? 'n' : 's'
  const b = budget >= 1000 ? `${budget / 1000}k` : `${budget}`
  return { search, budget, eval: evalKind, label: `${algo} ${b}${unit}·${evalKind === 'nnue' ? 'NN' : 'HCE'}` }
}

// A compact spec editor (algorithm · budget · eval).
function SpecEditor({ spec, set, disabled }: { spec: EngineSpec; set: (s: EngineSpec) => void; disabled?: boolean }) {
  const budgets = spec.search === 'ab' ? AB_BUDGETS : MCTS_BUDGETS
  const budget = budgets.includes(spec.budget) ? spec.budget : budgets[1]
  return (
    <div className="spec-editor">
      <div className="mpv-seg">
        {(['ab', 'mcts'] as const).map((s) => (
          <button
            key={s}
            className={spec.search === s ? 'mpv-btn active' : 'mpv-btn'}
            disabled={disabled}
            onClick={() => set(makeSpec(s, (s === 'ab' ? AB_BUDGETS : MCTS_BUDGETS)[1], spec.eval))}
          >
            {s === 'ab' ? 'Alpha-Beta' : 'MCTS'}
          </button>
        ))}
      </div>
      <div className="mpv-seg">
        {budgets.map((b) => (
          <button key={b} className={budget === b ? 'mpv-btn active' : 'mpv-btn'} disabled={disabled} onClick={() => set(makeSpec(spec.search, b, spec.eval))}>
            {b >= 1000 ? `${b / 1000}k` : b}
            {spec.search === 'ab' ? 'n' : ' sim'}
          </button>
        ))}
      </div>
      <div className="mpv-seg">
        {(['classical', 'nnue'] as EvalKind[]).map((e) => (
          <button key={e} className={spec.eval === e ? 'mpv-btn active' : 'mpv-btn'} disabled={disabled} onClick={() => set(makeSpec(spec.search, spec.budget, e))}>
            {e === 'nnue' ? 'NNUE' : 'classical'}
          </button>
        ))}
      </div>
    </div>
  )
}

// The walking log-likelihood-ratio track between the two SPRT decision bounds.
function LlrTrack({ track, lower, upper }: { track: number[]; lower: number; upper: number }) {
  const W = 520
  const H = 150
  const pad = 4
  const n = Math.max(track.length, 2)
  const lo = Math.min(lower, ...track) - 0.3
  const hi = Math.max(upper, ...track) + 0.3
  const x = (i: number) => pad + (i / (n - 1)) * (W - 2 * pad)
  const y = (v: number) => pad + (1 - (v - lo) / (hi - lo)) * (H - 2 * pad)
  const path = track.map((v, i) => `${i === 0 ? 'M' : 'L'}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(' ')
  const last = track.length ? track[track.length - 1] : 0
  return (
    <svg className="llr-track" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" role="img" aria-label="SPRT log-likelihood-ratio track">
      <line x1={pad} x2={W - pad} y1={y(upper)} y2={y(upper)} className="llr-bound accept" />
      <line x1={pad} x2={W - pad} y1={y(lower)} y2={y(lower)} className="llr-bound reject" />
      <line x1={pad} x2={W - pad} y1={y(0)} y2={y(0)} className="llr-zero" />
      <path d={path} className="llr-line" fill="none" />
      {track.length > 0 && <circle cx={x(track.length - 1)} cy={y(last)} r={3.2} className="llr-head" />}
    </svg>
  )
}

// The pentanomial distribution: A's game-pair result in {0, ½, 1, 1½, 2} points.
function PentaBar({ penta }: { penta: MatchTally['penta'] }) {
  const total = penta.reduce((a, b) => a + b, 0) || 1
  const labels = ['0', '½', '1', '1½', '2']
  const cls = ['p0', 'p1', 'p2', 'p3', 'p4']
  return (
    <div className="penta">
      <div className="penta-bar">
        {penta.map((c, i) => (c > 0 ? <div key={i} className={`penta-seg ${cls[i]}`} style={{ width: `${(c / total) * 100}%` }} title={`${labels[i]} pts: ${c} pairs`} /> : null))}
      </div>
      <div className="penta-legend">
        {penta.map((c, i) => (
          <span key={i} className="penta-key">
            <span className={`penta-dot ${cls[i]}`} /> {labels[i]}: <strong>{c}</strong>
          </span>
        ))}
      </div>
    </div>
  )
}

const SPRT_RANGES: { label: string; elo0: number; elo1: number }[] = [
  { label: '[0, 5]', elo0: 0, elo1: 5 },
  { label: '[0, 10]', elo0: 0, elo1: 10 },
  { label: '[0, 20]', elo0: 0, elo1: 20 },
  { label: '[−3, 3]', elo0: -3, elo1: 3 },
]

function SprtMode({ net }: { net: () => Promise<NnueBlob | null> }) {
  const [a, setA] = useState<EngineSpec>(() => makeSpec('ab', 8000, 'classical'))
  const [b, setB] = useState<EngineSpec>(() => makeSpec('ab', 30000, 'classical'))
  const [rangeIdx, setRangeIdx] = useState(1)
  const [model, setModel] = useState<'pentanomial' | 'trinomial'>('pentanomial')
  const [maxPairs, setMaxPairs] = useState(200)
  const [prog, setProg] = useState<SprtProgress | null>(null)
  const [running, setRunning] = useState(false)
  const workerRef = useRef<Worker | null>(null)

  useEffect(() => () => workerRef.current?.terminate(), [])

  const run = useCallback(async () => {
    const blob = a.eval === 'nnue' || b.eval === 'nnue' ? await net() : null
    let w: Worker
    try {
      w = new Worker(new URL('../engine/arena.worker.ts', import.meta.url), { type: 'module' })
    } catch {
      return
    }
    workerRef.current?.terminate()
    workerRef.current = w
    setProg(null)
    setRunning(true)
    w.onmessage = (e: MessageEvent<SprtProgress>) => {
      setProg(e.data)
      if (e.data.done) setRunning(false)
    }
    const range = SPRT_RANGES[rangeIdx]
    const params: SprtParams = { elo0: range.elo0, elo1: range.elo1, alpha: 0.05, beta: 0.05, model }
    w.postMessage({ type: 'sprt', a, b, openings: ARENA_OPENINGS, params, maxPairs, net: blob })
  }, [a, b, rangeIdx, model, maxPairs, net])

  const stop = useCallback(() => {
    workerRef.current?.postMessage({ type: 'cancel' })
    setRunning(false)
  }, [])

  const verdictBanner = (() => {
    if (!prog) return null
    if (prog.verdict === 'accept-h1') return <div className="sprt-verdict accept">H₁ accepted — <strong>{a.label}</strong> is stronger (gain in the tested range)</div>
    if (prog.verdict === 'accept-h0') return <div className="sprt-verdict reject">H₀ accepted — no gain of the tested size</div>
    if (prog.done) return <div className="sprt-verdict inconclusive">Inconclusive — pair cap reached before a verdict</div>
    return <div className="sprt-verdict running">Testing… LLR walking between the bounds</div>
  })()

  return (
    <div className="sprt-mode">
      <div className="arena-matchup">
        <div className="arena-cfg">
          <div className="arena-cfg-label">Engine A {prog && <span className="arena-elo-badge">{prog.tally.w}–{prog.tally.d}–{prog.tally.l}</span>}</div>
          <SpecEditor spec={a} set={setA} disabled={running} />
        </div>
        <span className="arena-vs">vs</span>
        <div className="arena-cfg">
          <div className="arena-cfg-label">Engine B</div>
          <SpecEditor spec={b} set={setB} disabled={running} />
        </div>
      </div>

      <div className="sprt-params">
        <div className="sprt-param">
          <span className="movetime-label">H₀…H₁ (Elo)</span>
          <div className="mpv-seg">
            {SPRT_RANGES.map((r, i) => (
              <button key={r.label} className={rangeIdx === i ? 'mpv-btn active' : 'mpv-btn'} disabled={running} onClick={() => setRangeIdx(i)}>{r.label}</button>
            ))}
          </div>
        </div>
        <div className="sprt-param">
          <span className="movetime-label">Variance model</span>
          <div className="mpv-seg">
            {(['pentanomial', 'trinomial'] as const).map((m) => (
              <button key={m} className={model === m ? 'mpv-btn active' : 'mpv-btn'} disabled={running} onClick={() => setModel(m)}>{m}</button>
            ))}
          </div>
        </div>
        <div className="sprt-param">
          <span className="movetime-label">Max pairs</span>
          <div className="mpv-seg">
            {[100, 200, 400, 1000].map((n) => (
              <button key={n} className={maxPairs === n ? 'mpv-btn active' : 'mpv-btn'} disabled={running} onClick={() => setMaxPairs(n)}>{n}</button>
            ))}
          </div>
        </div>
        {running ? <button className="btn" onClick={stop}>Stop</button> : <button className="btn primary" onClick={run}>Run SPRT</button>}
      </div>

      {verdictBanner}

      {prog && (
        <div className="sprt-results">
          <LlrTrack track={prog.llrTrack} lower={prog.lower} upper={prog.upper} />
          <div className="sprt-readouts">
            <div className="sprt-stat"><span className="sprt-stat-label">LLR</span><span className="sprt-stat-val">{prog.llr.toFixed(2)}</span><span className="sprt-stat-sub">[{prog.lower.toFixed(2)}, {prog.upper.toFixed(2)}]</span></div>
            <div className="sprt-stat"><span className="sprt-stat-label">Elo (A − B)</span><span className="sprt-stat-val">{prog.elo >= 0 ? '+' : ''}{prog.elo.toFixed(1)}</span><span className="sprt-stat-sub">[{prog.eloLow.toFixed(0)}, {prog.eloHigh.toFixed(0)}] · 95%</span></div>
            <div className="sprt-stat"><span className="sprt-stat-label">LOS</span><span className="sprt-stat-val">{(prog.los * 100).toFixed(1)}%</span><span className="sprt-stat-sub">A stronger</span></div>
            <div className="sprt-stat"><span className="sprt-stat-label">norm. adv.</span><span className="sprt-stat-val">{prog.normAdvantage.toFixed(3)}</span><span className="sprt-stat-sub">σ / pair</span></div>
            <div className="sprt-stat"><span className="sprt-stat-label">draw rate</span><span className="sprt-stat-val">{(prog.drawRate * 100).toFixed(0)}%</span><span className="sprt-stat-sub">{prog.pairsDone} pairs</span></div>
          </div>
          <PentaBar penta={prog.tally.penta} />
        </div>
      )}
    </div>
  )
}

// ---- Round-robin tournament ----

const CROSS_GLYPH = (c: { wins: number; draws: number; losses: number }) => `+${c.wins} =${c.draws} −${c.losses}`

function EloBars({ standings }: { standings: Standing[] }) {
  if (standings.length === 0) return null
  const elos = standings.map((s) => s.elo)
  const errs = standings.map((s) => s.eloError)
  const lo = Math.min(...elos.map((e, i) => e - 1.96 * errs[i]), 0) - 10
  const hi = Math.max(...elos.map((e, i) => e + 1.96 * errs[i]), 0) + 10
  const span = hi - lo || 1
  const pct = (v: number) => ((v - lo) / span) * 100
  return (
    <div className="elo-bars">
      {standings.map((s) => {
        const c = pct(s.elo)
        const l = pct(s.elo - 1.96 * s.eloError)
        const h = pct(s.elo + 1.96 * s.eloError)
        return (
          <div key={s.index} className="elo-bar-row">
            <span className="elo-bar-label">{s.label}</span>
            <div className="elo-bar-track">
              <div className="elo-bar-zero" style={{ left: `${pct(0)}%` }} />
              <div className="elo-bar-ci" style={{ left: `${l}%`, width: `${Math.max(0.5, h - l)}%` }} />
              <div className="elo-bar-dot" style={{ left: `${c}%` }} />
            </div>
            <span className="elo-bar-val">{s.elo >= 0 ? '+' : ''}{s.elo.toFixed(0)}<span className="elo-bar-err"> ±{(1.96 * s.eloError).toFixed(0)}</span></span>
          </div>
        )
      })}
    </div>
  )
}

function LosMatrix({ cells, labels }: { cells: TourProgress['cells']; labels: string[] }) {
  const n = labels.length
  return (
    <div className="los-matrix" style={{ gridTemplateColumns: `auto repeat(${n}, 1fr)` }}>
      <div className="los-corner" />
      {labels.map((_, j) => <div key={j} className="los-head">{j + 1}</div>)}
      {labels.map((rl, i) => (
        <Fragment key={i}>
          <div className="los-rowhead" title={rl}>{i + 1}. {rl}</div>
          {labels.map((_, j) => {
            if (i === j) return <div key={j} className="los-cell self" />
            const los = losFromH2H(cells[i][j])
            const hue = los > 0.5 ? 140 : 8
            const strength = Math.abs(los - 0.5) * 2
            return <div key={j} className="los-cell" style={{ background: `hsla(${hue}, 65%, 45%, ${0.12 + strength * 0.7})` }} title={`P(${labels[i]} > ${labels[j]}) = ${(los * 100).toFixed(1)}%`}>{(los * 100).toFixed(0)}</div>
          })}
        </Fragment>
      ))}
    </div>
  )
}

const TOUR_PRESETS: EngineSpec[] = [
  makeSpec('ab', 2000, 'classical'),
  makeSpec('ab', 8000, 'classical'),
  makeSpec('ab', 30000, 'classical'),
  makeSpec('ab', 8000, 'nnue'),
  makeSpec('mcts', 2500, 'classical'),
  makeSpec('mcts', 8000, 'classical'),
]

function TournamentMode({ net }: { net: () => Promise<NnueBlob | null> }) {
  const [engines, setEngines] = useState<EngineSpec[]>(() => [TOUR_PRESETS[0], TOUR_PRESETS[1], TOUR_PRESETS[2], TOUR_PRESETS[4]])
  const [gpp, setGpp] = useState(8)
  const [prog, setProg] = useState<TourProgress | null>(null)
  const [running, setRunning] = useState(false)
  const workerRef = useRef<Worker | null>(null)
  useEffect(() => () => workerRef.current?.terminate(), [])

  const toggle = (s: EngineSpec) => {
    if (running) return
    const has = engines.some((e) => e.label === s.label)
    if (has) setEngines(engines.filter((e) => e.label !== s.label))
    else if (engines.length < 6) setEngines([...engines, s])
  }

  const run = useCallback(async () => {
    if (engines.length < 2) return
    const blob = engines.some((e) => e.eval === 'nnue') ? await net() : null
    let w: Worker
    try {
      w = new Worker(new URL('../engine/arena.worker.ts', import.meta.url), { type: 'module' })
    } catch {
      return
    }
    workerRef.current?.terminate()
    workerRef.current = w
    setProg(null)
    setRunning(true)
    w.onmessage = (e: MessageEvent<TourProgress>) => {
      setProg(e.data)
      if (e.data.done) setRunning(false)
    }
    w.postMessage({ type: 'tournament', engines, openings: ARENA_OPENINGS, gamesPerPairing: gpp, net: blob })
  }, [engines, gpp, net])

  const stop = useCallback(() => {
    workerRef.current?.postMessage({ type: 'cancel' })
    setRunning(false)
  }, [])

  const rankOf = (label: string) => {
    if (!prog) return 0
    const idx = prog.standings.findIndex((s) => s.label === label)
    return idx + 1
  }

  return (
    <div className="tour-mode">
      <div className="tour-pool">
        <div className="movetime-label">Field (pick 2–6)</div>
        <div className="tour-chips">
          {TOUR_PRESETS.map((s) => (
            <button key={s.label} className={engines.some((e) => e.label === s.label) ? 'tour-chip active' : 'tour-chip'} disabled={running} onClick={() => toggle(s)}>{s.label}</button>
          ))}
        </div>
      </div>
      <div className="tour-controls">
        <div className="sprt-param">
          <span className="movetime-label">Games / pairing</span>
          <div className="mpv-seg">
            {[4, 8, 16, 30].map((n) => (
              <button key={n} className={gpp === n ? 'mpv-btn active' : 'mpv-btn'} disabled={running} onClick={() => setGpp(n)}>{n}</button>
            ))}
          </div>
        </div>
        {running ? <button className="btn" onClick={stop}>Stop</button> : <button className="btn primary" onClick={run} disabled={engines.length < 2}>Run tournament</button>}
        {prog && <span className="tour-progress-text">{prog.gamesDone}/{prog.gamesTotal} games</span>}
      </div>

      {prog && prog.standings.length > 0 && (
        <>
          <table className="tour-standings">
            <thead><tr><th>#</th><th>Engine</th><th>Elo</th><th>±</th><th>Games</th><th>Score</th></tr></thead>
            <tbody>
              {prog.standings.map((s, r) => (
                <tr key={s.index}>
                  <td>{r + 1}</td>
                  <td className="tour-eng">{s.label}</td>
                  <td className="tour-elo">{s.elo >= 0 ? '+' : ''}{s.elo.toFixed(0)}</td>
                  <td className="tour-err">{(1.96 * s.eloError).toFixed(0)}</td>
                  <td>{s.played}</td>
                  <td>{s.played > 0 ? ((s.points / s.played) * 100).toFixed(1) : '0'}%</td>
                </tr>
              ))}
            </tbody>
          </table>

          <EloBars standings={prog.standings} />

          <div className="tour-grids">
            <div className="tour-grid-block">
              <div className="tour-grid-title">Crosstable (row vs column)</div>
              <div className="crosstable" style={{ gridTemplateColumns: `auto repeat(${prog.labels.length}, 1fr)` }}>
                <div className="cross-corner" />
                {prog.labels.map((l, j) => <div key={j} className="cross-head" title={l}>{rankOf(l)}</div>)}
                {prog.labels.map((rl, i) => (
                  <Fragment key={i}>
                    <div className="cross-rowhead" title={rl}>{rankOf(rl)}. {rl}</div>
                    {prog.labels.map((_, j) => (
                      <div key={j} className={`cross-cell ${i === j ? 'self' : ''}`}>{i === j ? '—' : CROSS_GLYPH(prog.cells[i][j])}</div>
                    ))}
                  </Fragment>
                ))}
              </div>
            </div>
            <div className="tour-grid-block">
              <div className="tour-grid-title">Likelihood of superiority</div>
              <LosMatrix cells={prog.cells} labels={prog.labels} />
            </div>
          </div>
        </>
      )}
    </div>
  )
}

function ArenaLab() {
  const [mode, setMode] = useState<'sprt' | 'tournament'>('sprt')
  const netRef = useRef<NnueBlob | null>(null)
  const netLoaded = useRef(false)
  const net = useCallback(async (): Promise<NnueBlob | null> => {
    if (netLoaded.current) return netRef.current
    const saved = await nnueLoad().catch(() => null)
    netRef.current = saved?.blob ?? defaultNnueBlob()
    netLoaded.current = true
    return netRef.current
  }, [])

  return (
    <div className="lab arena-lab">
      <div className="lab-intro">
        <p>
          <strong>The Arena.</strong> Strength-test the engine the way it is really done — not by staring at a single
          score, but with the sequential statistics of computer-chess development. Run an <strong>SPRT</strong> (Sequential
          Probability Ratio Test) between two configurations and it stops the instant it can tell whether a change is a gain,
          reading the <em>pentanomial</em> game-pair variance the way Fishtest and OpenBench do. Or run a full
          <strong> round-robin</strong> and rate every engine by a Bradley–Terry maximum-likelihood fit — the estimator
          BayesElo approximates — with a crosstable, Elo error bars, and a likelihood-of-superiority matrix. Every game is
          played in a Web Worker, so nothing blocks.
        </p>
      </div>

      <div className="mpv-seg arena-modeseg">
        <button className={mode === 'sprt' ? 'mpv-btn active' : 'mpv-btn'} onClick={() => setMode('sprt')}>SPRT match</button>
        <button className={mode === 'tournament' ? 'mpv-btn active' : 'mpv-btn'} onClick={() => setMode('tournament')}>Round-robin</button>
      </div>

      {mode === 'sprt' ? <SprtMode net={net} /> : <TournamentMode net={net} />}
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
        <button className={mode === 'bitboard' ? 'tab active' : 'tab'} onClick={() => setMode('bitboard')}>
          Bitboards
        </button>
        <button className={mode === 'checks' ? 'tab active' : 'tab'} onClick={() => setMode('checks')}>
          Self-tests
        </button>
      </div>
      {mode === 'perft' && <PerftLab />}
      {mode === 'bitboard' && <BitboardLab />}
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
