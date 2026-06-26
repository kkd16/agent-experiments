// Cortex Coach — the Review tab. Paste a PGN (or pick a sample), run a full
// engine review, and get a chess.com/lichess-style report: per-player accuracy,
// ACPL and an estimated rating; a classification-coloured move list; the biggest
// "key moments"; a navigable board with a best-move arrow; and a coach note for
// the move you're looking at. The model lives in `engine/review.ts`; this is the
// presentation + the worker-driven sweep.

import { useCallback, useEffect, useMemo, useState } from 'react'
import Board from './Board'
import EvalBar from './EvalBar'
import EvalGraph from './EvalGraph'
import { useEngine } from '../hooks/useEngine'
import {
  Game,
  type Move,
  type Color,
  WHITE,
  moveFrom,
  moveTo,
  moveToSan,
  parsePgn,
  reviewGame,
  classGlyph,
  classLabel,
  type GameReview,
  type MoveClass,
  type MoveReview,
  type PlayerSummary,
} from '../engine'
import { buildView, type BoardView } from '../view'

interface NavGame {
  startFen: string
  moves: Move[]
  sans: string[]
  fens: string[]
  histories: bigint[][]
  result: string
  white?: string
  black?: string
  event?: string
}

function buildNav(startFen: string, moves: Move[], meta: Partial<NavGame> = {}): NavGame {
  const g = new Game(startFen)
  const fens = [g.fen()]
  const histories: bigint[][] = [g.keyHistory()]
  const sans: string[] = []
  for (const m of moves) {
    sans.push(moveToSan(g.pos, m, g.legalMoves()))
    g.apply(m)
    fens.push(g.fen())
    histories.push(g.keyHistory())
  }
  return { startFen, moves, sans, fens, histories, result: meta.result ?? '*', ...meta }
}

function gameAtPly(nav: NavGame, ply: number): Game {
  const g = new Game(nav.startFen)
  for (let i = 0; i < ply; i++) g.apply(nav.moves[i])
  return g
}

function clampPov(wp: number): number {
  return Math.max(-800, Math.min(800, wp))
}

const SAMPLES: { label: string; pgn: string }[] = [
  {
    label: 'Opera Game',
    pgn: `[White "Paul Morphy"] [Black "Allies"] [Result "1-0"]
1.e4 e5 2.Nf3 d6 3.d4 Bg4 4.dxe5 Bxf3 5.Qxf3 dxe5 6.Bc4 Nf6 7.Qb3 Qe7
8.Nc3 c6 9.Bg5 b5 10.Nxb5 cxb5 11.Bxb5+ Nbd7 12.O-O-O Rd8 13.Rxd7 Rxd7
14.Rd1 Qe6 15.Bxd7+ Nxd7 16.Qb8+ Nxb8 17.Rd8# 1-0`,
  },
  {
    label: 'Immortal Game',
    pgn: `[White "Adolf Anderssen"] [Black "Lionel Kieseritzky"] [Result "1-0"]
1.e4 e5 2.f4 exf4 3.Bc4 Qh4+ 4.Kf1 b5 5.Bxb5 Nf6 6.Nf3 Qh6 7.d3 Nh5
8.Nh4 Qg5 9.Nf5 c6 10.g4 Nf6 11.Rg1 cxb5 12.h4 Qg6 13.h5 Qg5 14.Qf3 Ng8
15.Bxf4 Qf6 16.Nc3 Bc5 17.Nd5 Qxb2 18.Bd6 Bxg1 19.e5 Qxa1+ 20.Ke2 Na6
21.Nxg7+ Kd8 22.Qf6+ Nxf6 23.Be7# 1-0`,
  },
  {
    label: 'Kasparov–Topalov',
    pgn: `[White "Garry Kasparov"] [Black "Veselin Topalov"] [Result "1-0"]
1.e4 d6 2.d4 Nf6 3.Nc3 g6 4.Be3 Bg7 5.Qd2 c6 6.f3 b5 7.Nge2 Nbd7 8.Bh6 Bxh6
9.Qxh6 Bb7 10.a3 e5 11.O-O-O Qe7 12.Kb1 a6 13.Nc1 O-O-O 14.Nb3 exd4 15.Rxd4 c5
16.Rd1 Nb6 17.g3 Kb8 18.Na5 Ba8 19.Bh3 d5 20.Qf4+ Ka7 21.Rhe1 d4 22.Nd5 Nbxd5
23.exd5 Qd6 24.Rxd4 cxd4 25.Re7+ Kb6 26.Qxd4+ Kxa5 27.b4+ Ka4 28.Qc3 Qxd5
29.Ra7 Bb7 30.Rxb7 Qc4 31.Qxf6 Kxa3 32.Qxa6+ Kxb4 33.c3+ Kxc3 34.Qa1+ Kd2
35.Qb2+ Kd1 36.Bf1 Rd2 37.Rd7 Rxd7 38.Bxc4 bxc4 39.Qxh8 Rd3 40.Qa8 c3 41.Qa4+ Ke1
42.f4 f5 43.Kc1 Rd2 44.Qa7 1-0`,
  },
]

const ORDER: MoveClass[] = [
  'brilliant',
  'great',
  'best',
  'excellent',
  'good',
  'book',
  'inaccuracy',
  'mistake',
  'blunder',
  'missed-win',
  'forced',
]

type Depth = { label: string; maxDepth: number; maxTime: number }
const DEPTHS: Depth[] = [
  { label: 'Fast', maxDepth: 12, maxTime: 180 },
  { label: 'Balanced', maxDepth: 14, maxTime: 350 },
  { label: 'Deep', maxDepth: 18, maxTime: 800 },
]

function Scoreboard({ name, color, s }: { name: string; color: Color; s: PlayerSummary }) {
  return (
    <div className={`rv-score ${color === WHITE ? 'white' : 'black'}`}>
      <div className="rv-score-head">
        <span className="rv-disc" />
        <span className="rv-name" title={name}>{name}</span>
      </div>
      <div className="rv-acc">{s.accuracy.toFixed(1)}<span className="rv-pct">%</span></div>
      <div className="rv-acc-label">accuracy</div>
      <div className="rv-metrics">
        <span title="average centipawn loss">ACPL {s.acpl.toFixed(0)}</span>
        <span title="rough performance estimate from ACPL">≈ {s.estElo} Elo</span>
      </div>
      <div className="rv-tally">
        {ORDER.filter((k) => s.counts[k] > 0).map((k) => (
          <span key={k} className={`rv-chip cls-${k}`} title={classLabel(k)}>
            {classGlyph(k)} {s.counts[k]}
          </span>
        ))}
      </div>
    </div>
  )
}

export default function Review() {
  const engine = useEngine()

  const [nav, setNav] = useState<NavGame>(() => buildNav(new Game().fen(), []))
  const [ply, setPly] = useState(0)
  const [whiteOnBottom, setWhiteOnBottom] = useState(true)
  const [report, setReport] = useState<GameReview | null>(null)
  const [running, setRunning] = useState(false)
  const [progress, setProgress] = useState(0)
  const [depthIdx, setDepthIdx] = useState(1)

  const [pgnText, setPgnText] = useState('')
  const [msg, setMsg] = useState('')

  const game = useMemo(() => gameAtPly(nav, ply), [nav, ply])
  const view: BoardView = useMemo(() => buildView(game), [game])

  // The move that *led to* the current position, and the best continuation *from*
  // the current position (drawn as an arrow).
  const playedReview: MoveReview | null = report && ply > 0 ? report.moves[ply - 1] : null
  const nextReview: MoveReview | null = report && ply < nav.moves.length ? report.moves[ply] : null
  const arrow =
    nextReview && nextReview.bestMove !== null
      ? { from: moveFrom(nextReview.bestMove), to: moveTo(nextReview.bestMove) }
      : null

  // White-POV eval series for the graph. `cpAfter`/`cpBefore` are from the moving
  // player's POV, so convert by the mover's colour.
  const evals = useMemo<(number | null)[]>(() => {
    if (!report) return new Array(nav.fens.length).fill(null)
    const arr: (number | null)[] = new Array(nav.fens.length).fill(null)
    for (let i = 0; i < report.moves.length; i++) {
      const m = report.moves[i]
      arr[i + 1] = clampPov(m.color === WHITE ? m.cpAfter : -m.cpAfter)
    }
    const m0 = report.moves[0]
    if (m0) arr[0] = clampPov(m0.color === WHITE ? m0.cpBefore : -m0.cpBefore)
    return arr
  }, [report, nav.fens])

  const blunders = useMemo(() => {
    const set = new Set<number>()
    if (!report) return set
    report.moves.forEach((m, i) => {
      if (m.klass === 'blunder' || m.klass === 'mistake' || m.klass === 'missed-win') set.add(i + 1)
    })
    return set
  }, [report])

  const go = useCallback((target: number) => setPly(Math.max(0, Math.min(target, nav.moves.length))), [nav.moves.length])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLTextAreaElement || e.target instanceof HTMLInputElement) return
      if (e.key === 'ArrowLeft') go(ply - 1)
      else if (e.key === 'ArrowRight') go(ply + 1)
      else if (e.key === 'Home') go(0)
      else if (e.key === 'End') go(nav.moves.length)
      else if (e.key === 'f') setWhiteOnBottom((v) => !v)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [go, ply, nav.moves.length])

  const loadGame = useCallback((next: NavGame) => {
    engine.cancel()
    setRunning(false)
    setReport(null)
    setProgress(0)
    setNav(next)
    setPly(0)
    if (next.white) setWhiteOnBottom(true)
  }, [engine])

  const loadPgn = useCallback(() => {
    const games = parsePgn(pgnText)
    if (games.length === 0 || games[0].moves.length === 0) {
      setMsg(games[0]?.error ? `Parse error: ${games[0].error}` : 'No moves found in PGN.')
      return
    }
    const g = games[0]
    setMsg(g.error ? `Loaded ${g.moves.length} moves (stopped: ${g.error})` : `Loaded ${g.moves.length} moves — hit Review.`)
    loadGame(buildNav(g.startFen, g.moves, { result: g.result, white: g.tags.White, black: g.tags.Black, event: g.tags.Event }))
  }, [pgnText, loadGame])

  const loadSample = useCallback((pgn: string, label: string) => {
    const g = parsePgn(pgn)[0]
    setMsg(`${label}: ${g.moves.length} moves — hit Review.`)
    loadGame(buildNav(g.startFen, g.moves, { result: g.result, white: g.tags.White, black: g.tags.Black }))
  }, [loadGame])

  const runReview = useCallback(async () => {
    if (nav.moves.length === 0 || running) return
    setRunning(true)
    setReport(null)
    setProgress(0)
    const items = nav.fens.map((fen, i) => ({ fen, history: nav.histories[i] }))
    const d = DEPTHS[depthIdx]
    try {
      const nodes = await engine.reviewGame(items, { maxDepth: d.maxDepth, maxTime: d.maxTime }, (done, total) =>
        setProgress(total > 0 ? done / total : 0),
      )
      const rep = reviewGame({ startFen: nav.startFen, moves: nav.moves, nodes })
      setReport(rep)
      setMsg('')
    } finally {
      setRunning(false)
    }
  }, [nav, engine, depthIdx, running])

  const noop = useCallback(() => {}, [])

  const title = nav.white || nav.black ? `${nav.white ?? '?'} – ${nav.black ?? '?'}` : 'No game loaded'

  // Move rows for the classified list.
  const moveRows = useMemo(() => {
    const rows: { num: number; w?: MoveReview; b?: MoveReview }[] = []
    const mv = report?.moves ?? null
    for (let i = 0; i < nav.sans.length; i += 2) {
      rows.push({
        num: Math.floor(i / 2) + 1,
        w: mv ? mv[i] : ({ index: i, san: nav.sans[i] } as MoveReview),
        b: nav.sans[i + 1] ? (mv ? mv[i + 1] : ({ index: i + 1, san: nav.sans[i + 1] } as MoveReview)) : undefined,
      })
    }
    return rows
  }, [report, nav.sans])

  const cell = (m: MoveReview | undefined) => {
    if (!m) return <span className="rv-move-cell empty" />
    const active = ply === m.index + 1
    return (
      <button
        className={`rv-move-cell clickable ${report ? 'cls-' + m.klass : ''} ${active ? 'current' : ''}`}
        onClick={() => go(m.index + 1)}
        title={report ? `${classLabel(m.klass)} · ${m.accuracy.toFixed(0)}%` : undefined}
      >
        <span className="rv-move-san">{m.san}</span>
        {report && <span className="rv-move-glyph">{classGlyph(m.klass)}</span>}
      </button>
    )
  }

  return (
    <div className="review">
      <section className="rv-board-col">
        <div className="board-area">
          <EvalBar
            score={playedReview ? playedReview.cpAfter : 0}
            mate={null}
            turn={playedReview ? playedReview.color : view.turn}
            whiteOnBottom={whiteOnBottom}
            hasEval={!!report && !!playedReview}
          />
          <div className="board-stack">
            <Board
              view={view}
              whiteOnBottom={whiteOnBottom}
              selected={null}
              targets={[]}
              arrow={arrow}
              interactive={false}
              onSquareClick={noop}
              onDragStartSquare={noop}
              onDropSquare={noop}
            />
            <div className="nav-bar">
              <button className="btn nav" onClick={() => go(0)} disabled={ply === 0} title="Start (Home)">⏮</button>
              <button className="btn nav" onClick={() => go(ply - 1)} disabled={ply === 0} title="Previous (←)">◀</button>
              <span className="nav-counter">{ply} / {nav.moves.length}</span>
              <button className="btn nav" onClick={() => go(ply + 1)} disabled={ply >= nav.moves.length} title="Next (→)">▶</button>
              <button className="btn nav" onClick={() => go(nav.moves.length)} disabled={ply >= nav.moves.length} title="End (End)">⏭</button>
              <button className="btn nav" onClick={() => setWhiteOnBottom((v) => !v)} title="Flip (f)">⇅</button>
            </div>
          </div>
        </div>

        <div className="graph-panel">
          <div className="panel-title">
            Game evaluation
            {running && <span className="annotating"> · reviewing {(progress * 100).toFixed(0)}%</span>}
          </div>
          <EvalGraph evals={evals} ply={ply} blunders={blunders} onJump={go} />
        </div>

        {/* Coach card for the move just played. */}
        <div className={`rv-coach ${playedReview ? 'cls-' + playedReview.klass : ''}`}>
          {playedReview ? (
            <>
              <div className="rv-coach-head">
                <span className="rv-coach-glyph">{classGlyph(playedReview.klass)}</span>
                <span className="rv-coach-class">{classLabel(playedReview.klass)}</span>
                <span className="rv-coach-move">
                  {Math.floor(playedReview.index / 2) + 1}{playedReview.color === WHITE ? '.' : '…'} {playedReview.san}
                </span>
                <span className="rv-coach-acc">{playedReview.accuracy.toFixed(0)}%</span>
              </div>
              <div className="rv-coach-text">{playedReview.coach}</div>
              {playedReview.bestLineSan && !playedReview.isBest && (
                <div className="rv-coach-line"><span className="rv-coach-k">Best line</span> {playedReview.bestLineSan}</div>
              )}
            </>
          ) : (
            <div className="rv-coach-text muted">
              {report ? 'Step through the game — each move gets a coach note here.' : 'Load a game and hit Review to get a full coach report.'}
            </div>
          )}
        </div>
      </section>

      <aside className="rv-side">
        {report ? (
          <div className="panel rv-scores">
            <Scoreboard name={nav.white ?? 'White'} color={WHITE} s={report.white} />
            <Scoreboard name={nav.black ?? 'Black'} color={1 as Color} s={report.black} />
          </div>
        ) : (
          <div className="panel rv-run-panel">
            <div className="panel-title">{title}</div>
            <p className="panel-note">
              {nav.moves.length > 0
                ? `${nav.moves.length} moves ready. Run a full engine review for per-move accuracy, blunder detection and a coach note on every move.`
                : 'Load a PGN below (or pick a sample), then run the review.'}
            </p>
            <div className="rv-depth-row">
              <span className="movetime-label">Depth</span>
              <div className="mpv-seg">
                {DEPTHS.map((d, i) => (
                  <button key={d.label} className={depthIdx === i ? 'mpv-btn active' : 'mpv-btn'} onClick={() => setDepthIdx(i)}>
                    {d.label}
                  </button>
                ))}
              </div>
            </div>
            <button className="btn rv-run" onClick={runReview} disabled={nav.moves.length === 0 || running}>
              {running ? `Reviewing… ${(progress * 100).toFixed(0)}%` : 'Review game'}
            </button>
            {running && (
              <div className="rv-progress"><span className="rv-progress-fill" style={{ width: `${progress * 100}%` }} /></div>
            )}
          </div>
        )}

        {report && report.keyMoments.length > 0 && (
          <div className="panel">
            <div className="panel-title">Key moments</div>
            <div className="rv-key">
              {report.keyMoments.map((idx) => {
                const m = report.moves[idx]
                return (
                  <button key={idx} className={`rv-key-row cls-${m.klass}`} onClick={() => go(idx + 1)}>
                    <span className="rv-key-glyph">{classGlyph(m.klass)}</span>
                    <span className="rv-key-move">
                      {Math.floor(m.index / 2) + 1}{m.color === WHITE ? '.' : '…'} {m.san}
                    </span>
                    <span className="rv-key-label">{classLabel(m.klass)}</span>
                  </button>
                )
              })}
            </div>
          </div>
        )}

        <div className="panel">
          <div className="panel-title">
            {report ? title : 'Moves'}
            {report && <button className="btn small chip" onClick={() => { setReport(null); setProgress(0) }}>Re-review</button>}
          </div>
          <div className="rv-movelist">
            {moveRows.length === 0 && <div className="movelist-empty">No game loaded.</div>}
            {moveRows.map((row) => (
              <div className="rv-move-row" key={row.num}>
                <span className="rv-move-num">{row.num}.</span>
                {cell(row.w)}
                {cell(row.b)}
              </div>
            ))}
          </div>
          {nav.result !== '*' && <div className="ana-result">Result: {nav.result}</div>}
        </div>

        <div className="panel">
          <div className="panel-title">Load a game</div>
          <div className="sample-row">
            {SAMPLES.map((s) => (
              <button key={s.label} className="btn small chip" onClick={() => loadSample(s.pgn, s.label)}>{s.label}</button>
            ))}
          </div>
          <textarea className="pgn-text" placeholder="paste PGN here…" value={pgnText} onChange={(e) => setPgnText(e.target.value)} />
          <div className="pgn-row">
            <button className="btn small" onClick={loadPgn} disabled={!pgnText.trim()}>Load PGN</button>
          </div>
          {msg && <div className="ana-msg">{msg}</div>}
        </div>
      </aside>
    </div>
  )
}
