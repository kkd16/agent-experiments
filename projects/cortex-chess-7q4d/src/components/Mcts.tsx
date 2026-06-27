// The MCTS Lab: Cortex's *second* brain. Where the Play/Analyze board runs the
// classical alpha-beta searcher, this tab runs the from-scratch AlphaZero-style
// PUCT Monte-Carlo Tree Search (engine/mcts.ts) and lays its thinking bare —
// the live visit distribution over the root moves (the real "policy" a value-net
// search produces), the value, the principal variation, and a head-to-head
// agreement check against the alpha-beta engine at the same node budget.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import Board from './Board'
import EvalBar from './EvalBar'
import PromotionPicker from './PromotionPicker'
import { useEngine } from '../hooks/useEngine'
import {
  Game,
  type Move,
  type Color,
  type MctsOptions,
  type MctsResult,
  type PolicyKind,
  type ValueSource,
  type SearchInfo,
  MCTS_DEFAULTS,
  START_FEN,
  moveFrom,
  moveTo,
  moveToSan,
  parseFen,
  toFen,
} from '../engine'
import {
  buildView,
  type BoardView,
  targetsFrom,
  isPromotionMove,
  pieceAt,
} from '../view'

function gameAt(startFen: string, moves: Move[], ply: number): Game {
  const g = new Game(startFen)
  for (let i = 0; i < ply && i < moves.length; i++) g.apply(moves[i])
  return g
}

function validateFen(fen: string): boolean {
  try {
    const pos = parseFen(fen)
    return pos.kings[0] >= 0 && pos.kings[1] >= 0 && toFen(pos).split(' ')[0].length > 0
  } catch {
    return false
  }
}

// Win-probability (0..100) from a value-style score in [-1,1].
function winPct(q: number): number {
  return Math.round(((q + 1) / 2) * 100)
}

const NODE_PRESETS = [800, 2000, 4000, 8000, 16000, 40000]

const POSITIONS: { label: string; fen: string }[] = [
  { label: 'Start', fen: START_FEN },
  { label: 'Italian', fen: 'r1bqkbnr/pppp1ppp/2n5/4p3/2B1P3/5N2/PPPP1PPP/RNBQK2R b KQkq - 4 3' },
  { label: 'Tactic', fen: 'r1bqk2r/pppp1ppp/2n2n2/2b1p3/2B1P3/3P1N2/PPP2PPP/RNBQK2R w KQkq - 0 5' },
  { label: 'Mate in 2', fen: 'r5rk/5p1p/5R2/4B3/8/8/7P/7K w - - 0 1' },
  { label: 'KRK endgame', fen: '8/8/8/4k3/8/8/4K3/4R3 w - - 0 1' },
  { label: 'Endgame', fen: '8/5k2/8/8/8/3K4/4P3/8 w - - 0 1' },
]

export default function Mcts() {
  const search = useEngine() // runs the MCTS
  const ab = useEngine() // the alpha-beta comparison engine

  const [startFen, setStartFen] = useState(START_FEN)
  const [moves, setMoves] = useState<Move[]>([])
  const [ply, setPly] = useState(0)
  const [whiteOnBottom, setWhiteOnBottom] = useState(true)

  // Search knobs.
  const [nodes, setNodes] = useState(4000)
  const [cpuct, setCpuct] = useState(MCTS_DEFAULTS.cpuct)
  const [policy, setPolicy] = useState<PolicyKind>('eval1')
  const [evalSource, setEvalSource] = useState<ValueSource>('classical')
  const [temperature, setTemperature] = useState(0)
  const [dirichlet, setDirichlet] = useState(0)

  // Search state.
  const [result, setResult] = useState<MctsResult | null>(null)
  const [running, setRunning] = useState(false)
  const [selfPlay, setSelfPlay] = useState(false)
  const selfPlayRef = useRef(false)
  const seedRef = useRef(0x5eed)

  // Alpha-beta comparison.
  const [abResult, setAbResult] = useState<SearchInfo | null>(null)
  const [abRunning, setAbRunning] = useState(false)

  const [selected, setSelected] = useState<number | null>(null)
  const [promo, setPromo] = useState<{ from: number; to: number; color: Color } | null>(null)
  const [fenText, setFenText] = useState('')
  const [msg, setMsg] = useState('')

  const game = useMemo(() => gameAt(startFen, moves, ply), [startFen, moves, ply])
  const view: BoardView = useMemo(() => buildView(game), [game])
  const interactive = view.result === 'playing' && !running && !selfPlay

  const targets = useMemo(
    () => (selected !== null ? targetsFrom(view.legal, selected) : []),
    [selected, view.legal],
  )

  // SAN for each move, computed in the current position (for the visit chart + PV).
  const sanOf = useCallback(
    (m: Move) => {
      try {
        return moveToSan(game.pos, m, view.legal)
      } catch {
        return '—'
      }
    },
    [game, view.legal],
  )

  // The principal variation rendered as SAN (replayed from the current position).
  const pvSan = useMemo(() => {
    if (!result || result.pv.length === 0) return ''
    const g = new Game(game.fen())
    const parts: string[] = []
    for (let i = 0; i < result.pv.length && i < 16; i++) {
      const m = result.pv[i]
      const legal = g.legalMoves()
      if (!legal.includes(m)) break
      let prefix = ''
      if (g.turn === 0) prefix = `${g.pos.fullmove}.`
      else if (i === 0) prefix = `${g.pos.fullmove}…`
      parts.push(prefix + moveToSan(g.pos, m, legal))
      g.apply(m)
    }
    return parts.join(' ')
  }, [result, game])

  const resetSearch = useCallback(() => {
    search.cancel()
    ab.cancel()
    setResult(null)
    setAbResult(null)
    setRunning(false)
    setAbRunning(false)
  }, [search, ab])

  // Navigate / set up a position. Always clears stale search output.
  const goTo = useCallback(
    (target: number) => {
      resetSearch()
      setSelected(null)
      setPly(Math.max(0, Math.min(target, moves.length)))
    },
    [moves.length, resetSearch],
  )

  const loadPosition = useCallback(
    (fen: string, note = '') => {
      if (!validateFen(fen)) {
        setMsg('Invalid FEN.')
        return
      }
      resetSearch()
      setStartFen(fen)
      setMoves([])
      setPly(0)
      setSelected(null)
      setMsg(note)
    },
    [resetSearch],
  )

  // Run one MCTS search on an explicit game position. Returns the final result.
  const runSearchOn = useCallback(
    async (g: Game): Promise<MctsResult | null> => {
      if (g.result() !== 'playing') return null
      search.cancel()
      setRunning(true)
      setResult(null)
      seedRef.current = (seedRef.current * 1664525 + 1013904223) >>> 0
      const opt: MctsOptions = {
        ...MCTS_DEFAULTS,
        maxNodes: nodes,
        maxTime: 0,
        cpuct,
        policy,
        evalSource,
        temperature,
        dirichlet,
        dirichletAlpha: 0.3,
        seed: seedRef.current,
      }
      const res = await search.mcts(g.fen(), opt, (r) => setResult(r))
      setResult(res)
      setRunning(false)
      return res
    },
    [search, nodes, cpuct, policy, evalSource, temperature, dirichlet],
  )

  const runSearch = useCallback(() => runSearchOn(game), [runSearchOn, game])

  // Run the alpha-beta engine at the *same* node budget for a fair comparison.
  const runAb = useCallback(async () => {
    if (view.result !== 'playing') return
    ab.cancel()
    setAbRunning(true)
    setAbResult(null)
    const res = await ab.think(
      { fen: game.fen(), history: game.keyHistory(), maxDepth: 64, maxTime: 0, maxNodes: nodes },
      (i) => setAbResult(i),
    )
    setAbResult(res)
    setAbRunning(false)
  }, [view.result, ab, game, nodes])

  // Play the engine's chosen move on the board (advancing the line).
  const playMove = useCallback(
    (m: Move) => {
      const legal = game.findMove(moveFrom(m), moveTo(m), (m >> 14) & 7)
      if (legal === null) return
      const next = moves.slice(0, ply).concat(legal)
      resetSearch()
      setSelected(null)
      setMoves(next)
      setPly(ply + 1)
    },
    [game, moves, ply, resetSearch],
  )

  // Stop any in-flight search and the self-play loop.
  const stop = useCallback(() => {
    selfPlayRef.current = false
    setSelfPlay(false)
    resetSearch()
  }, [resetSearch])

  // Self-play: search the current position, play the best move, repeat. Driven by
  // a local working game (no stale closures) that mirrors its line into the
  // navigable state for display; `selfPlayRef` is the live on/off switch.
  const startSelfPlay = useCallback(() => {
    if (selfPlayRef.current) return
    const base = game.fen()
    const g = new Game(base)
    selfPlayRef.current = true
    setSelfPlay(true)
    setStartFen(base)
    setMoves([])
    setPly(0)
    const step = async () => {
      if (!selfPlayRef.current) return
      if (g.result() !== 'playing') {
        selfPlayRef.current = false
        setSelfPlay(false)
        return
      }
      const res = await runSearchOn(g)
      if (!selfPlayRef.current || !res || res.bestMove === null) {
        selfPlayRef.current = false
        setSelfPlay(false)
        return
      }
      const legal = g.findMove(moveFrom(res.bestMove), moveTo(res.bestMove), (res.bestMove >> 14) & 7)
      if (legal === null) {
        selfPlayRef.current = false
        setSelfPlay(false)
        return
      }
      g.apply(legal)
      setMoves((prev) => prev.concat(legal))
      setPly((prev) => prev + 1)
      setTimeout(() => void step(), 400)
    }
    void step()
  }, [game, runSearchOn])

  const toggleSelfPlay = useCallback(() => {
    if (selfPlayRef.current) stop()
    else startSelfPlay()
  }, [stop, startSelfPlay])

  // --- Interactive board: a click/drag move advances the analysis line ---
  const tryMove = useCallback(
    (from: number, to: number) => {
      if (isPromotionMove(view.legal, from, to)) {
        setPromo({ from, to, color: view.turn })
        return
      }
      const m = game.findMove(from, to)
      if (m !== null) playMove(m)
      else setSelected(null)
    },
    [view.legal, view.turn, game, playMove],
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
      if (m !== null) playMove(m)
      setPromo(null)
    },
    [promo, game, playMove],
  )

  const loadFen = useCallback(() => {
    const fen = fenText.trim()
    if (!fen) return
    loadPosition(fen, validateFen(fen) ? 'Position loaded.' : '')
    setFenText('')
  }, [fenText, loadPosition])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return
      if (e.key === 'ArrowLeft') goTo(ply - 1)
      else if (e.key === 'ArrowRight') goTo(ply + 1)
      else if (e.key === 'f') setWhiteOnBottom((v) => !v)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [goTo, ply])

  // Tear down workers on unmount.
  useEffect(() => () => { search.cancel(); ab.cancel() }, [search, ab])

  const best = result?.bestMove ?? null
  const arrow = best !== null ? { from: moveFrom(best), to: moveTo(best) } : null
  const maxVisits = result && result.children.length > 0 ? Math.max(1, result.children[0].visits) : 1
  const agree = best !== null && abResult && abResult.pv.length > 0 && abResult.pv[0] === best

  return (
    <div className="mcts">
      <section className="mcts-board">
        <div className="board-area">
          <EvalBar
            score={result?.scoreCp ?? 0}
            mate={result?.mate ?? null}
            turn={view.turn}
            whiteOnBottom={whiteOnBottom}
            hasEval={result !== null}
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
              <button className="btn nav" onClick={() => goTo(0)} disabled={ply === 0} title="Start">⏮</button>
              <button className="btn nav" onClick={() => goTo(ply - 1)} disabled={ply === 0} title="Previous (←)">◀</button>
              <span className="nav-counter">{ply} ply</span>
              <button className="btn nav" onClick={() => goTo(ply + 1)} disabled={ply >= moves.length} title="Next (→)">▶</button>
              <button className="btn nav" onClick={() => setWhiteOnBottom((v) => !v)} title="Flip (f)">⇅</button>
            </div>
            <div className={`status ${view.result !== 'playing' ? 'over' : ''}`}>
              {view.result === 'playing'
                ? `${view.turn === 0 ? 'White' : 'Black'} to move${view.checkSquare !== null ? ' — check!' : ''}`
                : view.result === 'checkmate'
                  ? 'Checkmate'
                  : 'Game over — draw'}
            </div>
          </div>
        </div>

        <div className="mcts-intro">
          <h2>PUCT Monte-Carlo Tree Search</h2>
          <p>
            A second, independent search engine — the paradigm behind AlphaZero & Leela — built from scratch on
            Cortex's own board and evaluation. Each <em>simulation</em> walks from the root to a leaf by the
            <strong> PUCT</strong> rule <code>Q + c·P·√ΣN/(1+N)</code>, reads the leaf's <strong>value</strong> from the
            static eval (no random rollouts), and backs it up. The bars below are the <strong>visit distribution</strong>
            it converges to — the real policy a value-net search emits. An <strong>MCTS-Solver</strong> layer grafts exact
            win/loss/draw proofs onto the statistics, so forced mates are found and reported precisely.
          </p>
        </div>
      </section>

      <aside className="mcts-side">
        <div className="panel mcts-run">
          <div className="mcts-runrow">
            {running ? (
              <button className="btn primary" onClick={stop}>Stop</button>
            ) : (
              <button className="btn primary" onClick={() => runSearch()} disabled={view.result !== 'playing'}>
                ▶ Search
              </button>
            )}
            <button
              className={selfPlay ? 'btn active' : 'btn'}
              onClick={toggleSelfPlay}
              disabled={view.result !== 'playing' && !selfPlay}
              title="Search, play the best move, and repeat — the tree self-playing"
            >
              {selfPlay ? '■ Self-play' : '⟳ Self-play'}
            </button>
            {best !== null && (
              <button className="btn" onClick={() => playMove(best)} disabled={running || selfPlay} title="Play the searched move">
                Play {sanOf(best)}
              </button>
            )}
          </div>

          <div className="mcts-readout">
            <div className="mcts-stat">
              <span className="k">eval</span>
              <span className="v">
                {result
                  ? result.mate !== null
                    ? `#${result.mate}`
                    : `${result.scoreCp >= 0 ? '+' : ''}${(result.scoreCp / 100).toFixed(2)}`
                  : '—'}
              </span>
            </div>
            <div className="mcts-stat"><span className="k">best</span><span className="v">{best !== null ? sanOf(best) : '—'}</span></div>
            <div className="mcts-stat"><span className="k">sims</span><span className="v">{result?.nodes.toLocaleString() ?? '—'}</span></div>
            <div className="mcts-stat"><span className="k">sims/s</span><span className="v">{result ? result.nps.toLocaleString() : '—'}</span></div>
            <div className="mcts-stat"><span className="k">depth</span><span className="v">{result?.treeDepth ?? '—'}</span></div>
            <div className="mcts-stat"><span className="k">win%</span><span className="v">{result ? winPct(result.rootValue) : '—'}</span></div>
          </div>
          {pvSan && <div className="mcts-pv"><span className="pv-k">PV</span> {pvSan}</div>}
        </div>

        <div className="panel">
          <div className="panel-title">Root visit distribution {result && <span className="dim">· {result.children.length} moves</span>}</div>
          <div className="mcts-bars">
            {result && result.children.length > 0 ? (
              result.children.slice(0, 12).map((s) => {
                const isBest = s.move === best
                return (
                  <button
                    key={s.move}
                    className={`mcts-bar-row${isBest ? ' best' : ''}`}
                    onClick={() => playMove(s.move)}
                    disabled={running || selfPlay}
                    title={`visits ${s.visits} · Q ${(s.q).toFixed(3)} · prior ${(s.prior * 100).toFixed(1)}%`}
                  >
                    <span className="mb-san">{sanOf(s.move)}</span>
                    <span className="mb-track">
                      <span className="mb-fill" style={{ width: `${Math.max(2, (s.visits / maxVisits) * 100)}%` }} />
                      <span className="mb-prior" style={{ width: `${Math.max(1, s.prior * 100)}%` }} title="prior policy" />
                    </span>
                    <span className="mb-n">{s.visits}</span>
                    <span className="mb-q">{winPct(s.q)}%</span>
                  </button>
                )
              })
            ) : (
              <div className="mcts-empty">{running ? 'searching…' : 'Press Search to grow the tree.'}</div>
            )}
          </div>
          {result && result.children.length > 0 && (
            <div className="mcts-legend">
              <span><span className="swatch visits" /> visits (the policy)</span>
              <span><span className="swatch prior" /> prior</span>
              <span>win% = the move's mean value Q</span>
            </div>
          )}
        </div>

        <div className="panel">
          <div className="panel-title">Search parameters</div>
          <label className="mcts-ctl">
            <span>Simulations <b>{nodes.toLocaleString()}</b></span>
            <input type="range" min={0} max={NODE_PRESETS.length - 1} value={NODE_PRESETS.indexOf(nodes) < 0 ? 2 : NODE_PRESETS.indexOf(nodes)} onChange={(e) => setNodes(NODE_PRESETS[Number(e.target.value)])} className="slider" />
          </label>
          <label className="mcts-ctl">
            <span>c_puct (exploration) <b>{cpuct.toFixed(1)}</b></span>
            <input type="range" min={0.5} max={4} step={0.1} value={cpuct} onChange={(e) => setCpuct(Number(e.target.value))} className="slider" />
          </label>
          <label className="mcts-ctl">
            <span>Temperature <b>{temperature.toFixed(1)}</b> <span className="dim">(move pick)</span></span>
            <input type="range" min={0} max={1.5} step={0.1} value={temperature} onChange={(e) => setTemperature(Number(e.target.value))} className="slider" />
          </label>
          <label className="mcts-ctl">
            <span>Dirichlet noise ε <b>{dirichlet.toFixed(2)}</b> <span className="dim">(root)</span></span>
            <input type="range" min={0} max={0.5} step={0.05} value={dirichlet} onChange={(e) => setDirichlet(Number(e.target.value))} className="slider" />
          </label>
          <div className="mcts-segrow">
            <span className="mcts-seglbl">Policy</span>
            <div className="seg">
              <button className={policy === 'eval1' ? 'seg-btn active' : 'seg-btn'} onClick={() => setPolicy('eval1')} title="Softmax of the evaluator's 1-ply scores">1-ply eval</button>
              <button className={policy === 'heuristic' ? 'seg-btn active' : 'seg-btn'} onClick={() => setPolicy('heuristic')} title="Cheap hand-crafted move features">heuristic</button>
            </div>
          </div>
          <div className="mcts-segrow">
            <span className="mcts-seglbl">Value</span>
            <div className="seg">
              <button className={evalSource === 'classical' ? 'seg-btn active' : 'seg-btn'} onClick={() => setEvalSource('classical')}>classical</button>
              <button className={evalSource === 'nnue' ? 'seg-btn active' : 'seg-btn'} onClick={() => setEvalSource('nnue')} title="The NNUE net if one is installed, else classical">NNUE</button>
            </div>
          </div>
        </div>

        <div className="panel">
          <div className="panel-title">Alpha-beta head-to-head <span className="dim">· same node budget</span></div>
          <p className="panel-note">Run Cortex's classical searcher to the same {nodes.toLocaleString()} nodes and see whether the two paradigms pick the same move.</p>
          <button className="btn small" onClick={runAb} disabled={abRunning || view.result !== 'playing'}>
            {abRunning ? 'searching…' : 'Run alpha-beta'}
          </button>
          {abResult && (
            <div className="mcts-ab">
              <div className="ab-line">
                <span className="ab-k">α-β best</span>
                <span className="ab-v">{abResult.pv.length > 0 ? sanOf(abResult.pv[0]) : '—'}</span>
                <span className="ab-score">{abResult.mate !== null ? `#${abResult.mate}` : `${abResult.score >= 0 ? '+' : ''}${(abResult.score / 100).toFixed(2)}`}</span>
                <span className="ab-meta">d{abResult.depth} · {abResult.nodes.toLocaleString()}n</span>
              </div>
              {best !== null && (
                <div className={`ab-verdict ${agree ? 'agree' : 'differ'}`}>
                  {agree ? '✓ both engines agree' : `≠ MCTS plays ${sanOf(best)}, α-β plays ${abResult.pv.length ? sanOf(abResult.pv[0]) : '—'}`}
                </div>
              )}
            </div>
          )}
        </div>

        <div className="panel">
          <div className="panel-title">Position</div>
          <div className="mcts-posrow">
            {POSITIONS.map((p) => (
              <button key={p.label} className="btn small chip" onClick={() => loadPosition(p.fen, p.label)}>{p.label}</button>
            ))}
          </div>
          <input
            className="fen-input"
            placeholder="paste a FEN…"
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
