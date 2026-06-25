// The Analyze board: load a game from PGN (or set up a FEN), step through it with
// full navigation, watch a multi-PV engine evaluate the current position live,
// and see the whole game's evaluation as a graph. The board is also interactive —
// make a move and it branches into your own analysis line.

import { useCallback, useEffect, useMemo, useState } from 'react'
import Board from './Board'
import EvalBar from './EvalBar'
import EvalGraph from './EvalGraph'
import PromotionPicker from './PromotionPicker'
import { useEngine } from '../hooks/useEngine'
import {
  Game,
  type Move,
  type Color,
  type MultiInfo,
  START_FEN,
  moveFrom,
  moveTo,
  moveToSan,
  parseFen,
  toFen,
  parsePgn,
  bookExplorer,
  buildAnnotatedPgn,
} from '../engine'
import {
  buildView,
  type BoardView,
  targetsFrom,
  isPromotionMove,
  pieceAt,
  pvToSan,
} from '../view'

// A fully-navigable game: the moves plus, per node, the resulting FEN and the
// position-key history (so the engine sees repetitions correctly).
interface NavGame {
  startFen: string
  moves: Move[]
  sans: string[]
  fens: string[] // length moves.length + 1; fens[0] = startFen
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

// White-POV centipawns, with mate scores pinned to the graph's clamp.
function whitePov(score: number, fen: string): number {
  const turn = fen.split(' ')[1]
  const wp = turn === 'w' ? score : -score
  if (wp > 90000) return 800
  if (wp < -90000) return -800
  return wp
}

const SAMPLES: { label: string; pgn: string }[] = [
  {
    label: 'Opera Game',
    pgn: `[Event "Paris Opera"] [Site "Paris"] [Date "1858.??.??"]
[White "Paul Morphy"] [Black "Allies"] [Result "1-0"]
1.e4 e5 2.Nf3 d6 3.d4 Bg4 4.dxe5 Bxf3 5.Qxf3 dxe5 6.Bc4 Nf6 7.Qb3 Qe7
8.Nc3 c6 9.Bg5 b5 10.Nxb5 cxb5 11.Bxb5+ Nbd7 12.O-O-O Rd8 13.Rxd7 Rxd7
14.Rd1 Qe6 15.Bxd7+ Nxd7 16.Qb8+ Nxb8 17.Rd8# 1-0`,
  },
  {
    label: 'Immortal Game',
    pgn: `[Event "London"] [Site "London"] [Date "1851.06.21"]
[White "Adolf Anderssen"] [Black "Lionel Kieseritzky"] [Result "1-0"]
1.e4 e5 2.f4 exf4 3.Bc4 Qh4+ 4.Kf1 b5 5.Bxb5 Nf6 6.Nf3 Qh6 7.d3 Nh5
8.Nh4 Qg5 9.Nf5 c6 10.g4 Nf6 11.Rg1 cxb5 12.h4 Qg6 13.h5 Qg5 14.Qf3 Ng8
15.Bxf4 Qf6 16.Nc3 Bc5 17.Nd5 Qxb2 18.Bd6 Bxg1 19.e5 Qxa1+ 20.Ke2 Na6
21.Nxg7+ Kd8 22.Qf6+ Nxf6 23.Be7# 1-0`,
  },
  {
    label: 'Evergreen',
    pgn: `[Event "Berlin"] [White "Adolf Anderssen"] [Black "Jean Dufresne"] [Result "1-0"]
1.e4 e5 2.Nf3 Nc6 3.Bc4 Bc5 4.b4 Bxb4 5.c3 Ba5 6.d4 exd4 7.O-O d3
8.Qb3 Qf6 9.e5 Qg6 10.Re1 Nge7 11.Ba3 b5 12.Qxb5 Rb8 13.Qa4 Bb6 14.Nbd2 Bb7
15.Ne4 Qf5 16.Bxd3 Qh5 17.Nf6+ gxf6 18.exf6 Rg8 19.Rad1 Qxf3 20.Rxe7+ Nxe7
21.Qxd7+ Kxd7 22.Bf5+ Ke8 23.Bd7+ Kf8 24.Bxe7# 1-0`,
  },
]

function validateFen(fen: string): boolean {
  try {
    const pos = parseFen(fen)
    return pos.kings[0] >= 0 && pos.kings[1] >= 0 && toFen(pos).split(' ')[0].length > 0
  } catch {
    return false
  }
}

export default function Analysis() {
  const engine = useEngine() // live multi-PV of the current node
  const annotator = useEngine() // background sweep for the eval graph

  const [nav, setNav] = useState<NavGame>(() => buildNav(START_FEN, []))
  const [ply, setPly] = useState(0)
  const [multiPv, setMultiPv] = useState(3)
  const [whiteOnBottom, setWhiteOnBottom] = useState(true)

  const [lines, setLines] = useState<MultiInfo | null>(null)
  const [busy, setBusy] = useState(false)
  const [evals, setEvals] = useState<(number | null)[]>([null])
  const [annotating, setAnnotating] = useState(false)

  const [selected, setSelected] = useState<number | null>(null)
  const [promo, setPromo] = useState<{ from: number; to: number; color: Color } | null>(null)
  const [pgnText, setPgnText] = useState('')
  const [fenText, setFenText] = useState('')
  const [msg, setMsg] = useState('')

  // Board view for the current node.
  const game = useMemo(() => gameAtPly(nav, ply), [nav, ply])
  const view: BoardView = useMemo(() => buildView(game), [game])
  const interactive = view.result === 'playing'

  const targets = useMemo(
    () => (selected !== null ? targetsFrom(view.legal, selected) : []),
    [selected, view.legal],
  )

  // Load a fresh game: reset navigation, evals and kick off the annotation sweep.
  const loadNav = useCallback(
    (next: NavGame, gotoPly = 0) => {
      engine.cancel()
      annotator.cancel()
      setNav(next)
      setPly(Math.max(0, Math.min(gotoPly, next.moves.length)))
      setSelected(null)
      setLines(null)
      setEvals(new Array(next.fens.length).fill(null))

      if (next.moves.length > 0) {
        setAnnotating(true)
        const items = next.fens.map((fen, i) => ({ fen, history: next.histories[i] }))
        annotator
          .evalGame(items, { maxDepth: 11, maxTime: 130 }, (i, score) => {
            setEvals((prev) => {
              const copy = prev.slice()
              copy[i] = whitePov(score, next.fens[i])
              return copy
            })
          })
          .then(() => setAnnotating(false))
      }
    },
    [engine, annotator],
  )

  // Live multi-PV analysis of the node we're looking at.
  useEffect(() => {
    const fen = nav.fens[ply]
    const history = nav.histories[ply]
    if (view.result !== 'playing') return // game over here — nothing to search
    let cancelled = false
    engine
      .analyze({ fen, history, maxDepth: 26, maxTime: 6000 }, multiPv, (info) => {
        if (!cancelled) {
          setBusy(true)
          setLines(info)
        }
      })
      .then((res) => {
        if (!cancelled) {
          setLines(res)
          setBusy(false)
        }
      })
    return () => {
      cancelled = true
      engine.cancel()
      setBusy(false)
    }
  }, [nav, ply, multiPv, engine, view.result])

  // Blunder detection from the annotated evals: a swing ≥ 200cp against the side
  // that just moved, at node i (relative to node i-1).
  const blunders = useMemo(() => {
    const set = new Set<number>()
    for (let i = 1; i < evals.length; i++) {
      const a = evals[i - 1]
      const b = evals[i]
      if (a === null || b === null) continue
      const moverWhite = nav.fens[i - 1].split(' ')[1] === 'w'
      const swing = moverWhite ? a - b : b - a
      if (swing >= 200) set.add(i)
    }
    return set
  }, [evals, nav])

  // --- Navigation ---
  const go = useCallback(
    (target: number) => {
      setSelected(null)
      setLines(null) // clear stale lines before the analysis effect re-runs
      setPly(Math.max(0, Math.min(target, nav.moves.length)))
    },
    [nav.moves.length],
  )

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

  // --- Interactive exploration: a move branches a new line from here ---
  const playUserMove = useCallback(
    (move: Move) => {
      const moves = nav.moves.slice(0, ply).concat(move)
      loadNav(buildNav(nav.startFen, moves, { result: '*' }), ply + 1)
    },
    [nav, ply, loadNav],
  )

  const tryMove = useCallback(
    (from: number, to: number) => {
      if (isPromotionMove(view.legal, from, to)) {
        setPromo({ from, to, color: view.turn })
        return
      }
      const m = game.findMove(from, to)
      if (m !== null) playUserMove(m)
      else setSelected(null)
    },
    [view.legal, view.turn, game, playUserMove],
  )

  const onSquareClick = useCallback(
    (sq: number) => {
      if (!interactive) return
      const piece = pieceAt(view.board, sq)
      if (selected === null) {
        if (piece && piece.color === view.turn) setSelected(sq)
        return
      }
      if (sq === selected) return setSelected(null)
      if (piece && piece.color === view.turn) return setSelected(sq)
      tryMove(selected, sq)
    },
    [interactive, view.board, view.turn, selected, tryMove],
  )

  const onDragStartSquare = useCallback(
    (sq: number) => {
      if (!interactive) return
      const piece = pieceAt(view.board, sq)
      if (piece && piece.color === view.turn) setSelected(sq)
    },
    [interactive, view.board, view.turn],
  )

  const onDropSquare = useCallback(
    (sq: number) => {
      if (!interactive || selected === null || sq === selected) return
      tryMove(selected, sq)
    },
    [interactive, selected, tryMove],
  )

  const onPromoSelect = useCallback(
    (type: number) => {
      if (!promo) return
      const m = game.findMove(promo.from, promo.to, type)
      if (m !== null) playUserMove(m)
      setPromo(null)
    },
    [promo, game, playUserMove],
  )

  // --- Importers ---
  const loadPgn = useCallback(() => {
    const games = parsePgn(pgnText)
    if (games.length === 0 || games[0].moves.length === 0) {
      setMsg(games[0]?.error ? `Parse error: ${games[0].error}` : 'No moves found in PGN.')
      return
    }
    const g = games[0]
    setMsg(g.error ? `Loaded ${g.moves.length} moves (stopped: ${g.error})` : `Loaded ${g.moves.length} moves.`)
    loadNav(
      buildNav(g.startFen, g.moves, {
        result: g.result,
        white: g.tags.White,
        black: g.tags.Black,
        event: g.tags.Event,
      }),
      0,
    )
  }, [pgnText, loadNav])

  const loadFen = useCallback(() => {
    const fen = fenText.trim()
    if (!fen || !validateFen(fen)) {
      setMsg('Invalid FEN.')
      return
    }
    setMsg('Position loaded.')
    loadNav(buildNav(fen, []), 0)
  }, [fenText, loadNav])

  const loadSample = useCallback(
    (pgn: string, label: string) => {
      const g = parsePgn(pgn)[0]
      setMsg(`${label}: ${g.moves.length} moves.`)
      loadNav(
        buildNav(g.startFen, g.moves, { result: g.result, white: g.tags.White, black: g.tags.Black }),
        0,
      )
    },
    [loadNav],
  )

  // Opening explorer: the book moves authored from the current position.
  const bookMoves = useMemo(() => bookExplorer(nav.fens[ply]), [nav.fens, ply])

  // Export an engine-annotated PGN (eval comments + ?!/?/?? glyphs) of the game.
  const exportAnnotated = useCallback(() => {
    if (nav.sans.length === 0) {
      setMsg('Nothing to annotate yet.')
      return
    }
    const pgn = buildAnnotatedPgn({
      startFen: nav.startFen,
      sans: nav.sans,
      fens: nav.fens,
      evals,
      result: nav.result,
      white: nav.white,
      black: nav.black,
      event: nav.event,
    })
    let copied = false
    try {
      navigator.clipboard?.writeText(pgn)
      copied = true
    } catch {
      /* clipboard unavailable (e.g. sandboxed preview) — fall back to download */
    }
    try {
      const blob = new Blob([pgn], { type: 'application/x-chess-pgn' })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = 'cortex-annotated.pgn'
      a.click()
      URL.revokeObjectURL(url)
    } catch {
      /* download blocked (e.g. sandboxed preview) — clipboard still works */
    }
    setMsg(copied ? 'Annotated PGN copied & downloaded.' : 'Annotated PGN downloaded.')
  }, [nav, evals])

  const arrow = lines && lines.lines[0]?.pv.length ? { from: moveFrom(lines.lines[0].pv[0]), to: moveTo(lines.lines[0].pv[0]) } : null

  const topScore = lines?.lines[0]?.score ?? 0
  const topMate = lines?.lines[0]?.mate ?? null

  const moveRows = useMemo(() => {
    const rows: { num: number; w?: { san: string; ply: number }; b?: { san: string; ply: number } }[] = []
    for (let i = 0; i < nav.sans.length; i += 2) {
      rows.push({
        num: Math.floor(i / 2) + 1,
        w: { san: nav.sans[i], ply: i + 1 },
        b: nav.sans[i + 1] ? { san: nav.sans[i + 1], ply: i + 2 } : undefined,
      })
    }
    return rows
  }, [nav.sans])

  const title =
    nav.white || nav.black ? `${nav.white ?? '?'} – ${nav.black ?? '?'}` : 'Set up a position'

  return (
    <div className="analyze">
      <section className="analyze-board">
        <div className="board-area">
          <EvalBar
            score={topScore}
            mate={topMate}
            turn={view.turn}
            whiteOnBottom={whiteOnBottom}
            hasEval={lines !== null}
          />
          <div className="board-stack">
            <Board
              view={view}
              whiteOnBottom={whiteOnBottom}
              selected={selected}
              targets={targets}
              arrow={arrow}
              interactive={interactive}
              onSquareClick={onSquareClick}
              onDragStartSquare={onDragStartSquare}
              onDropSquare={onDropSquare}
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
            Evaluation {annotating && <span className="annotating">· analysing…</span>}
          </div>
          <EvalGraph evals={evals} ply={ply} blunders={blunders} onJump={go} />
        </div>
      </section>

      <aside className="analyze-side">
        <div className="engine-panel">
          <div className="engine-head">
            <span className="engine-name">
              Cortex <span className={`pulse ${busy ? 'on' : ''}`} />
            </span>
            <span className="engine-score">
              {lines?.lines[0]
                ? lines.lines[0].mate !== null
                  ? `#${lines.lines[0].mate}`
                  : (topScore >= 0 ? '+' : '') + (topScore / 100).toFixed(2)
                : '—'}
            </span>
          </div>
          <div className="mpv-head">
            <span className="stat-k">{lines ? `depth ${lines.depth}` : 'idle'}</span>
            <div className="mpv-seg">
              {[1, 2, 3, 4].map((n) => (
                <button
                  key={n}
                  className={multiPv === n ? 'mpv-btn active' : 'mpv-btn'}
                  onClick={() => setMultiPv(n)}
                  title={`${n} line${n > 1 ? 's' : ''}`}
                >
                  {n}
                </button>
              ))}
            </div>
          </div>
          <div className="mpv-lines">
            {lines && lines.lines.length > 0 ? (
              lines.lines.map((l, idx) => (
                <button
                  key={idx}
                  className="mpv-line"
                  onClick={() => l.pv.length && playUserMove(l.pv[0])}
                  title="play this move"
                >
                  <span className={`mpv-score ${l.score >= 0 ? 'pos' : 'neg'}`}>
                    {l.mate !== null ? `#${l.mate}` : (l.score >= 0 ? '+' : '') + (l.score / 100).toFixed(2)}
                  </span>
                  <span className="mpv-pv">{pvToSan(nav.fens[ply], l.pv, 10)}</span>
                </button>
              ))
            ) : (
              <div className="mpv-empty">{view.result === 'playing' ? 'thinking…' : 'game over — no moves'}</div>
            )}
          </div>
        </div>

        <div className="panel">
          <div className="panel-title">
            Opening explorer
            {bookMoves.length > 0 && <span className="book-count">· {bookMoves.length} book move{bookMoves.length > 1 ? 's' : ''}</span>}
          </div>
          {bookMoves.length === 0 ? (
            <div className="book-empty">Out of book — the engine is on its own here.</div>
          ) : (
            <div className="book-list">
              {bookMoves.map((b) => (
                <button key={b.uci} className="book-row" onClick={() => playUserMove(b.move)} title="play this book move">
                  <span className="book-san">{b.san}</span>
                  <span className="book-bar">
                    <span className="book-fill" style={{ width: `${Math.max(4, b.pct)}%` }} />
                  </span>
                  <span className="book-pct">{b.pct}%</span>
                </button>
              ))}
            </div>
          )}
        </div>

        <div className="panel">
          <div className="panel-title">
            {title}
            {nav.sans.length > 0 && (
              <button className="btn small chip ana-export" onClick={exportAnnotated} title="Export an engine-annotated PGN">
                Annotate ⭢ PGN
              </button>
            )}
          </div>
          <div className="ana-movelist">
            {moveRows.length === 0 && <div className="movelist-empty">No moves — paste a PGN or set a FEN below.</div>}
            {moveRows.map((row) => (
              <div className="move-row" key={row.num}>
                <span className="move-num">{row.num}.</span>
                <span
                  className={`move-cell clickable ${ply === row.w?.ply ? 'current' : ''}`}
                  onClick={() => row.w && go(row.w.ply)}
                >
                  {row.w?.san}
                </span>
                <span
                  className={`move-cell clickable ${row.b && ply === row.b.ply ? 'current' : ''}`}
                  onClick={() => row.b && go(row.b.ply)}
                >
                  {row.b?.san ?? ''}
                </span>
              </div>
            ))}
          </div>
          {nav.result !== '*' && <div className="ana-result">Result: {nav.result}</div>}
        </div>

        <div className="panel">
          <div className="panel-title">Load a game</div>
          <div className="sample-row">
            {SAMPLES.map((s) => (
              <button key={s.label} className="btn small chip" onClick={() => loadSample(s.pgn, s.label)}>
                {s.label}
              </button>
            ))}
          </div>
          <textarea
            className="pgn-text"
            placeholder="paste PGN here…"
            value={pgnText}
            onChange={(e) => setPgnText(e.target.value)}
          />
          <div className="pgn-row">
            <button className="btn small" onClick={loadPgn} disabled={!pgnText.trim()}>Load PGN</button>
            <button className="btn small" onClick={() => { setNav(buildNav(START_FEN, [])); setPly(0); setEvals([null]); setLines(null); setMsg('') }}>Clear</button>
          </div>
          <input
            className="fen-input"
            placeholder="…or paste a FEN"
            value={fenText}
            onChange={(e) => setFenText(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') loadFen() }}
          />
          <button className="btn small" onClick={loadFen} disabled={!fenText.trim()}>Load FEN</button>
          {msg && <div className="ana-msg">{msg}</div>}
        </div>
      </aside>

      {promo && <PromotionPicker color={promo.color} onSelect={onPromoSelect} onCancel={() => setPromo(null)} />}
    </div>
  )
}
