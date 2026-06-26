import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import './App.css'
import Board from './components/Board'
import EvalBar from './components/EvalBar'
import MoveList from './components/MoveList'
import EnginePanel from './components/EnginePanel'
import PromotionPicker from './components/PromotionPicker'
import Lab from './components/Lab'
import Analysis from './components/Analysis'
import { useEngine } from './hooks/useEngine'
import {
  Game,
  type SearchInfo,
  type Color,
  WHITE,
  START_FEN,
  moveFrom,
  moveTo,
  movePromo,
  parseFen,
  toFen,
  bookMove,
  startFenForId,
  startFenForDfrc,
  randomStartId,
  idForBackRank,
  STANDARD_ID,
  buildPgn,
  allocateTime,
  formatClock,
  TIME_CONTROLS,
  nnueLoad,
  defaultNnueBlob,
  DEFAULT_NNUE_META,
  type NnueBlob,
  type NnueMeta,
} from './engine'
import {
  buildView,
  type BoardView,
  type EngineSide,
  LEVELS,
  targetsFrom,
  isPromotionMove,
  pieceAt,
  pvToSan,
} from './view'

type Tab = 'play' | 'analyze' | 'lab'

function statusText(view: BoardView): string {
  const sideName = view.turn === WHITE ? 'White' : 'Black'
  const otherName = view.turn === WHITE ? 'Black' : 'White'
  switch (view.result) {
    case 'checkmate':
      return `Checkmate — ${otherName} wins`
    case 'stalemate':
      return 'Draw — stalemate'
    case 'draw-fifty':
      return 'Draw — 50-move rule'
    case 'draw-repetition':
      return 'Draw — threefold repetition'
    case 'draw-material':
      return 'Draw — insufficient material'
    default:
      return view.checkSquare !== null ? `${sideName} to move — check!` : `${sideName} to move`
  }
}

function validateFen(fen: string): boolean {
  try {
    const pos = parseFen(fen)
    return pos.kings[0] >= 0 && pos.kings[1] >= 0 && toFen(pos).split(' ')[0].length > 0
  } catch {
    return false
  }
}

// Explicit "think time" presets — override the level's time budget so the engine
// thinks for a fixed amount per move. 0 = use the strength level's own budget.
const MOVE_TIMES: { label: string; ms: number }[] = [
  { label: 'Level default', ms: 0 },
  { label: '0.5s', ms: 500 },
  { label: '1s', ms: 1000 },
  { label: '2s', ms: 2000 },
  { label: '5s', ms: 5000 },
  { label: '10s', ms: 10000 },
]

export default function App() {
  const gameRef = useRef<Game>(new Game())
  const engine = useEngine()
  const ponderEngine = useEngine() // thinks on the opponent's clock

  const [view, setView] = useState<BoardView>(() => buildView(new Game()))
  const [whiteOnBottom, setWhiteOnBottom] = useState(true)
  const [engineSide, setEngineSide] = useState<EngineSide>('black')
  const [levelIndex, setLevelIndex] = useState(1)
  const [tab, setTab] = useState<Tab>('play')

  const [selected, setSelected] = useState<number | null>(null)
  const [promo, setPromo] = useState<{ from: number; to: number; color: Color } | null>(null)
  const [info, setInfo] = useState<SearchInfo | null>(null)
  const [pvSan, setPvSan] = useState('')
  const [thinking, setThinking] = useState(false)
  const [analyzing, setAnalyzing] = useState(false)
  const [arrow, setArrow] = useState<{ from: number; to: number } | null>(null)
  const [fenInput, setFenInput] = useState('')
  const [copied, setCopied] = useState(false)
  // Chess960 / Fischer-random: the current game's Scharnagl SP-ID, or null for
  // ordinary chess (-1 means a 960 position whose id we can't recover, e.g. one
  // loaded mid-game from a FEN).
  const [spId, setSpId] = useState<number | null>(null)
  const [dfrc, setDfrc] = useState(false)
  const [idInput, setIdInput] = useState('')
  const [bookOn, setBookOn] = useState(true)
  const [analysisOn, setAnalysisOn] = useState(false)
  const [ponderOn, setPonderOn] = useState(false)
  const [ponderHit, setPonderHit] = useState(false)
  const [moveTimeIdx, setMoveTimeIdx] = useState(0)
  const [pgnMsg, setPgnMsg] = useState('')
  // NNUE evaluation: a trained net (from the Lab, persisted to IndexedDB) can
  // replace the classical eval in play. `nnueBlob` is the loaded net, `nnueOn`
  // whether it's active.
  const [nnueBlob, setNnueBlob] = useState<NnueBlob | null>(null)
  const [nnueMeta, setNnueMeta] = useState<NnueMeta | null>(null)
  const [nnueOn, setNnueOn] = useState(false)
  // True when the active net is the shipped default (no net trained in the Lab yet).
  const [nnueIsDefault, setNnueIsDefault] = useState(true)
  // UCI-style time control. When active, the engine manages its own clock
  // (base + increment) and decides how long to think per move. `engineClockRef`
  // is the authoritative value (read inside the search effect without retriggering
  // it); `engineClockMs`/`lastBudget` mirror it for display.
  const [tcIdx, setTcIdx] = useState(0)
  const engineClockRef = useRef(0)
  const [engineClockMs, setEngineClockMs] = useState(0)
  const [lastBudget, setLastBudget] = useState(0)

  // Refresh the saved NNUE whenever the Play tab is shown (the user may have just
  // trained and saved one in the Lab).
  useEffect(() => {
    if (tab !== 'play') return
    nnueLoad().then((r) => {
      if (r) {
        // A net the user trained in the Lab wins over the shipped default.
        setNnueBlob(r.blob)
        setNnueMeta(r.meta)
        setNnueIsDefault(false)
      } else {
        // Ship a pre-trained default so "NNUE" works on a fresh load — no training
        // required. (Lazily decoded once, then memoised by React state.)
        setNnueBlob((prev) => prev ?? defaultNnueBlob())
        setNnueMeta(DEFAULT_NNUE_META)
        setNnueIsDefault(true)
      }
    })
  }, [tab])

  // Install (or remove) the NNUE evaluation on both the play and ponder engines.
  useEffect(() => {
    const blob = nnueOn ? nnueBlob : null
    engine.setNnue(blob)
    ponderEngine.setNnue(blob)
  }, [nnueOn, nnueBlob, engine, ponderEngine])

  const lastSearchedFen = useRef('')
  const lastAnalyzedFen = useRef('')
  // Pondering: after the engine moves, it searches the position arising from its
  // *predicted* reply. If the human then plays that reply, the precomputed result
  // is used instantly (a "ponder hit").
  const ponderRef = useRef<{ reply: number; fen: string } | null>(null)
  const ponderResultRef = useRef<{ fen: string; info: SearchInfo } | null>(null)
  const ponderingFen = useRef('')

  const sync = useCallback(() => {
    setView(buildView(gameRef.current))
  }, [])

  // Reset the engine's clock to the chosen time control's base time.
  const resetClock = useCallback((idx: number) => {
    const tc = TIME_CONTROLS[idx].tc
    engineClockRef.current = tc ? tc.baseMs : 0
    setEngineClockMs(tc ? tc.baseMs : 0)
    setLastBudget(0)
  }, [])

  // Deduct the time a move consumed from the engine clock and add the increment.
  const chargeEngineClock = useCallback((elapsedMs: number) => {
    const tc = TIME_CONTROLS[tcIdx].tc
    if (!tc) return
    engineClockRef.current = Math.max(0, engineClockRef.current - elapsedMs) + tc.incMs
    setEngineClockMs(engineClockRef.current)
  }, [tcIdx])

  const humanControls = useCallback(
    (color: number) => engineSide !== (color === WHITE ? 'white' : 'black'),
    [engineSide],
  )

  const interactive =
    tab === 'play' && view.result === 'playing' && !thinking && humanControls(view.turn)

  const clearPonder = useCallback(() => {
    ponderEngine.cancel()
    ponderRef.current = null
    ponderResultRef.current = null
    ponderingFen.current = ''
    setPonderHit(false)
  }, [ponderEngine])

  // Engine auto-move when it is the engine's turn.
  useEffect(() => {
    if (tab !== 'play') return
    if (view.result !== 'playing') return
    const sideToMove: EngineSide = view.turn === WHITE ? 'white' : 'black'
    if (engineSide !== sideToMove) return
    if (lastSearchedFen.current === view.fen) return

    lastSearchedFen.current = view.fen
    const searchFen = view.fen
    const level = LEVELS[levelIndex]
    const history = gameRef.current.keyHistory()
    // Time budget. A time control (clock + increment) takes top precedence and
    // manages time per move; otherwise an explicit movetime overrides the level's
    // budget (lifting the depth cap so the clock, not depth, bounds the search);
    // otherwise the strength level's own budget applies.
    const tc = TIME_CONTROLS[tcIdx].tc
    const moveTime = MOVE_TIMES[moveTimeIdx].ms
    let maxTime: number
    let maxDepth: number
    let softTime: number | undefined
    if (tc) {
      const b = allocateTime(engineClockRef.current, tc.incMs)
      maxTime = b.hardMs
      softTime = b.softMs
      maxDepth = 30
      setLastBudget(b.hardMs)
    } else {
      maxTime = moveTime > 0 ? moveTime : level.maxTime
      maxDepth = moveTime > 0 ? 30 : level.maxDepth
    }

    // --- Ponder hit: the human played the move we predicted, so the position is
    // already searched. Play the precomputed move instantly. ---
    const pondered = ponderResultRef.current
    if (pondered && pondered.fen === searchFen && pondered.info.pv.length > 0) {
      const pv0 = pondered.info.pv[0]
      const legal = gameRef.current.findMove(moveFrom(pv0), moveTo(pv0), movePromo(pv0))
      ponderResultRef.current = null
      ponderRef.current = null
      if (legal !== null) {
        setInfo(pondered.info)
        setPvSan(pvToSan(searchFen, pondered.info.pv))
        setArrow(null)
        setPonderHit(true)
        const id = setTimeout(() => {
          setPonderHit(false)
          if (gameRef.current.fen() !== searchFen) return
          chargeEngineClock(0) // instant move — credit the increment
          gameRef.current.apply(legal)
          sync()
        }, 250)
        return () => clearTimeout(id)
      }
    }

    // Opening book: play a weighted book move instantly (with a brief pause so it
    // reads as a move, not a glitch) instead of searching.
    if (bookOn) {
      const bm = bookMove(searchFen)
      if (bm !== null) {
        const legal = gameRef.current.findMove(moveFrom(bm), moveTo(bm), movePromo(bm))
        if (legal !== null) {
          setThinking(true)
          setInfo(null)
          setPvSan('Book move')
          setArrow(null)
          const id = setTimeout(() => {
            setThinking(false)
            if (gameRef.current.fen() !== searchFen) return
            chargeEngineClock(0) // book move is instant — credit the increment
            gameRef.current.apply(legal)
            sync()
          }, 350)
          return () => clearTimeout(id)
        }
      }
    }

    setThinking(true)
    setInfo(null)
    setPvSan('')
    setArrow(null)

    engine
      .think({ fen: searchFen, history, maxDepth, maxTime, softTime }, (i) => {
        setInfo(i)
        setPvSan(pvToSan(searchFen, i.pv))
      })
      .then((res) => {
        setThinking(false)
        if (tc) chargeEngineClock(res.timeMs)
        // Bail if the position changed under us (undo / new game / FEN load).
        if (gameRef.current.fen() !== searchFen) return
        setInfo(res)
        setPvSan(pvToSan(searchFen, res.pv))
        if (res.pv.length > 0) {
          gameRef.current.apply(res.pv[0])
          sync()
          // Set up pondering: predict the human's reply (the 2nd PV move) and
          // remember the position it leads to, so the ponder effect can pre-search.
          ponderResultRef.current = null
          ponderingFen.current = ''
          if (ponderOn && res.pv.length > 1) {
            const reply = res.pv[1]
            const predicted = gameRef.current.findMove(moveFrom(reply), moveTo(reply), movePromo(reply))
            if (predicted !== null) {
              const clone = gameRef.current.clone()
              clone.apply(predicted)
              ponderRef.current = { reply: predicted, fen: clone.fen() }
            } else ponderRef.current = null
          } else ponderRef.current = null
        }
      })
  }, [view, engineSide, levelIndex, tab, engine, sync, bookOn, moveTimeIdx, ponderOn, tcIdx, chargeEngineClock])

  // Background analysis: while it's the human's move and analysis is on, run the
  // engine to show a live evaluation and the best line — without playing a move.
  useEffect(() => {
    if (tab !== 'play' || !analysisOn) return
    if (view.result !== 'playing') return
    if (!humanControls(view.turn)) return
    if (thinking) return
    if (lastAnalyzedFen.current === view.fen) return

    lastAnalyzedFen.current = view.fen
    const searchFen = view.fen
    const history = gameRef.current.keyHistory()
    setAnalyzing(true)
    engine
      .think({ fen: searchFen, history, maxDepth: 22, maxTime: 4000 }, (i) => {
        if (gameRef.current.fen() !== searchFen) return
        setInfo(i)
        setPvSan(pvToSan(searchFen, i.pv))
        if (i.pv.length > 0) setArrow({ from: moveFrom(i.pv[0]), to: moveTo(i.pv[0]) })
      })
      .then((res) => {
        setAnalyzing(false)
        if (gameRef.current.fen() !== searchFen) return
        setInfo(res)
        setPvSan(pvToSan(searchFen, res.pv))
        if (res.pv.length > 0) setArrow({ from: moveFrom(res.pv[0]), to: moveTo(res.pv[0]) })
      })
  }, [view, analysisOn, tab, thinking, engine, humanControls])

  // Pondering: on the human's clock, pre-search the position arising from the
  // engine's predicted reply. Runs on a second worker so it never competes with
  // the live board, and stays silent (it analyses a *future* position).
  useEffect(() => {
    if (tab !== 'play' || !ponderOn) return
    if (view.result !== 'playing') return
    if (!humanControls(view.turn)) return
    if (thinking) return
    const pr = ponderRef.current
    if (!pr) return
    if (ponderingFen.current === pr.fen || ponderResultRef.current?.fen === pr.fen) return

    ponderingFen.current = pr.fen
    const predFen = pr.fen
    const clone = gameRef.current.clone()
    const predicted = clone.findMove(moveFrom(pr.reply), moveTo(pr.reply), movePromo(pr.reply))
    if (predicted === null) return
    clone.apply(predicted)
    const level = LEVELS[levelIndex]
    const moveTime = MOVE_TIMES[moveTimeIdx].ms
    const maxTime = moveTime > 0 ? moveTime : level.maxTime
    const maxDepth = moveTime > 0 ? 30 : level.maxDepth
    ponderEngine
      .think({ fen: predFen, history: clone.keyHistory(), maxDepth, maxTime }, () => {})
      .then((res) => {
        if (ponderRef.current && ponderRef.current.fen === predFen) {
          ponderResultRef.current = { fen: predFen, info: res }
        }
      })
  }, [view, ponderOn, tab, thinking, ponderEngine, humanControls, levelIndex, moveTimeIdx])

  const targets = useMemo(
    () => (selected !== null ? targetsFrom(view.legal, selected) : []),
    [selected, view.legal],
  )

  const doMove = useCallback(
    (move: number) => {
      // Stop any background analysis of the position we're leaving.
      engine.cancel()
      setAnalyzing(false)
      lastAnalyzedFen.current = ''
      // Ponder bookkeeping: if the human played the move we predicted, keep the
      // precomputed result for an instant reply; otherwise discard it.
      if (!ponderRef.current || ponderRef.current.reply !== move) clearPonder()
      else ponderEngine.cancel()
      gameRef.current.apply(move)
      setSelected(null)
      setArrow(null)
      sync()
    },
    [sync, engine, ponderEngine, clearPonder],
  )

  const tryMove = useCallback(
    (from: number, to: number) => {
      if (isPromotionMove(view.legal, from, to)) {
        setPromo({ from, to, color: view.turn })
        return
      }
      const m = gameRef.current.findMove(from, to)
      if (m !== null) doMove(m)
      else setSelected(null)
    },
    [view.legal, view.turn, doMove],
  )

  const onSquareClick = useCallback(
    (sq: number) => {
      if (!interactive) return
      const piece = pieceAt(view.board, sq)
      if (selected === null) {
        if (piece && piece.color === view.turn) setSelected(sq)
        return
      }
      if (sq === selected) {
        setSelected(null)
        return
      }
      if (piece && piece.color === view.turn) {
        setSelected(sq)
        return
      }
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
      if (!interactive || selected === null) return
      if (sq === selected) return
      tryMove(selected, sq)
    },
    [interactive, selected, tryMove],
  )

  const onPromoSelect = useCallback(
    (type: number) => {
      if (!promo) return
      const m = gameRef.current.findMove(promo.from, promo.to, type)
      if (m !== null) doMove(m)
      setPromo(null)
    },
    [promo, doMove],
  )

  const newGame = useCallback(
    (side?: EngineSide) => {
      engine.cancel()
      clearPonder()
      gameRef.current.reset(START_FEN)
      setSpId(null)
      setDfrc(false)
      resetClock(tcIdx)
      lastSearchedFen.current = ''
      lastAnalyzedFen.current = ''
      setSelected(null)
      setArrow(null)
      setInfo(null)
      setPvSan('')
      setThinking(false)
      setAnalyzing(false)
      setPgnMsg('')
      if (side) {
        setEngineSide(side)
        setWhiteOnBottom(side !== 'white')
      }
      setView(buildView(gameRef.current))
    },
    [engine, clearPonder, resetClock, tcIdx],
  )

  // Start a Chess960 game. With no argument a random one of the 960 positions is
  // rolled; otherwise the given Scharnagl SP-ID (0–959) is used.
  const newGame960 = useCallback(
    (id?: number) => {
      const chosen = id === undefined ? randomStartId() : ((id % 960) + 960) % 960
      engine.cancel()
      clearPonder()
      gameRef.current.reset(startFenForId(chosen))
      setSpId(chosen)
      setDfrc(false)
      resetClock(tcIdx)
      lastSearchedFen.current = ''
      lastAnalyzedFen.current = ''
      setSelected(null)
      setArrow(null)
      setInfo(null)
      setPvSan('')
      setThinking(false)
      setAnalyzing(false)
      setPgnMsg('')
      setView(buildView(gameRef.current))
    },
    [engine, clearPonder, resetClock, tcIdx],
  )

  // Start a Double Fischer Random game — white and black get independent random
  // back ranks (so the position is no longer mirror-symmetric).
  const newGameDfrc = useCallback(() => {
    engine.cancel()
    clearPonder()
    gameRef.current.reset(startFenForDfrc(randomStartId(), randomStartId()))
    setSpId(-1)
    setDfrc(true)
    resetClock(tcIdx)
    lastSearchedFen.current = ''
    lastAnalyzedFen.current = ''
    setSelected(null)
    setArrow(null)
    setInfo(null)
    setPvSan('')
    setThinking(false)
    setAnalyzing(false)
    setPgnMsg('')
    setView(buildView(gameRef.current))
  }, [engine, clearPonder, resetClock, tcIdx])

  const undo = useCallback(() => {
    engine.cancel()
    clearPonder()
    setThinking(false)
    const g = gameRef.current
    if (g.history.length === 0) return
    g.undo()
    if (engineSide !== 'none') {
      const humanSide: EngineSide = engineSide === 'white' ? 'black' : 'white'
      while (g.history.length > 0 && (g.turn === WHITE ? 'white' : 'black') !== humanSide) g.undo()
    }
    lastSearchedFen.current = g.fen()
    lastAnalyzedFen.current = ''
    setSelected(null)
    setArrow(null)
    setInfo(null)
    setPvSan('')
    setAnalyzing(false)
    setView(buildView(g))
  }, [engine, engineSide, clearPonder])

  const hint = useCallback(() => {
    if (thinking || view.result !== 'playing') return
    const searchFen = view.fen
    const history = gameRef.current.keyHistory()
    setThinking(true)
    setArrow(null)
    engine
      .think({ fen: searchFen, history, maxDepth: 12, maxTime: 800 }, (i) => {
        setInfo(i)
        setPvSan(pvToSan(searchFen, i.pv))
      })
      .then((res) => {
        setThinking(false)
        setInfo(res)
        setPvSan(pvToSan(searchFen, res.pv))
        if (res.pv.length > 0) setArrow({ from: moveFrom(res.pv[0]), to: moveTo(res.pv[0]) })
      })
  }, [thinking, view.result, view.fen, engine])

  const loadFen = useCallback(() => {
    const fen = fenInput.trim()
    if (!fen || !validateFen(fen)) return
    engine.cancel()
    clearPonder()
    gameRef.current.reset(fen)
    // Flag the variant: if the loaded position uses 960 castling, try to recover
    // its SP-ID from the white back rank (only meaningful for a full start rank).
    if (gameRef.current.pos.chess960) {
      const ranks = fen.split(/\s+/)[0].split('/')
      const whiteRank = ranks[7] ?? ''
      const blackRank = (ranks[0] ?? '').toUpperCase()
      const recovered = /^[A-Z]{8}$/.test(whiteRank) ? idForBackRank(whiteRank) : -1
      setSpId(recovered >= 0 ? recovered : -1)
      // A different black back rank means a Double-Fischer-Random position.
      setDfrc(/^[A-Z]{8}$/.test(blackRank) && blackRank !== whiteRank)
    } else {
      setSpId(null)
      setDfrc(false)
    }
    lastSearchedFen.current = ''
    lastAnalyzedFen.current = ''
    setSelected(null)
    setArrow(null)
    setInfo(null)
    setPvSan('')
    setThinking(false)
    setAnalyzing(false)
    setPgnMsg('')
    setFenInput('')
    setView(buildView(gameRef.current))
  }, [fenInput, engine, clearPonder])

  const copyFen = useCallback(() => {
    try {
      navigator.clipboard?.writeText(view.fen)
      setCopied(true)
      setTimeout(() => setCopied(false), 1200)
    } catch {
      /* clipboard unavailable (sandbox) */
    }
  }, [view.fen])

  const level = LEVELS[levelIndex]

  const makePgn = useCallback((): string => {
    const engineName = `Cortex (${LEVELS[levelIndex].name})`
    const white = engineSide === 'white' ? engineName : 'Human'
    const black = engineSide === 'black' ? engineName : engineSide === 'white' ? 'Human' : 'Human'
    const d = new Date()
    const date = `${d.getFullYear()}.${String(d.getMonth() + 1).padStart(2, '0')}.${String(d.getDate()).padStart(2, '0')}`
    return buildPgn(gameRef.current, { white, black, date })
  }, [engineSide, levelIndex])

  const copyPgn = useCallback(() => {
    try {
      navigator.clipboard?.writeText(makePgn())
      setPgnMsg('Copied!')
      setTimeout(() => setPgnMsg(''), 1400)
    } catch {
      setPgnMsg('unavailable')
      setTimeout(() => setPgnMsg(''), 1400)
    }
  }, [makePgn])

  const downloadPgn = useCallback(() => {
    try {
      const blob = new Blob([makePgn()], { type: 'application/x-chess-pgn' })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = 'cortex-chess.pgn'
      document.body.appendChild(a)
      a.click()
      document.body.removeChild(a)
      URL.revokeObjectURL(url)
    } catch {
      setPgnMsg('unavailable')
      setTimeout(() => setPgnMsg(''), 1400)
    }
  }, [makePgn])

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <span className="brand-mark">♞</span>
          <div>
            <h1>Cortex Chess</h1>
            <p className="tagline">a chess engine, built from scratch in TypeScript</p>
          </div>
        </div>
        <nav className="tabs">
          <button className={tab === 'play' ? 'tab active' : 'tab'} onClick={() => setTab('play')}>
            Play
          </button>
          <button className={tab === 'analyze' ? 'tab active' : 'tab'} onClick={() => setTab('analyze')}>
            Analyze
          </button>
          <button className={tab === 'lab' ? 'tab active' : 'tab'} onClick={() => setTab('lab')}>
            Engine Lab
          </button>
        </nav>
      </header>

      {tab === 'play' ? (
        <main className="layout">
          <section className="board-area">
            <EvalBar
              score={info?.score ?? 0}
              mate={info?.mate ?? null}
              turn={view.turn}
              whiteOnBottom={whiteOnBottom}
              hasEval={info !== null}
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
              <div className={`status ${view.result !== 'playing' ? 'over' : ''}`}>{statusText(view)}</div>
            </div>
          </section>

          <aside className="sidebar">
            <EnginePanel info={info} pvSan={pvSan} thinking={thinking || analyzing} />

            <div className="panel">
              <div className="panel-title">Opponent</div>
              <div className="seg">
                {(['white', 'black', 'none'] as EngineSide[]).map((s) => (
                  <button
                    key={s}
                    className={engineSide === s ? 'seg-btn active' : 'seg-btn'}
                    onClick={() => {
                      setEngineSide(s)
                      lastSearchedFen.current = ''
                      if (s !== 'none') setWhiteOnBottom(s !== 'white')
                    }}
                  >
                    {s === 'white' ? 'Plays White' : s === 'black' ? 'Plays Black' : 'Off'}
                  </button>
                ))}
              </div>
              <div className="panel-title">
                Strength: <span className="lvl-name">{level.name}</span>
              </div>
              <input
                type="range"
                min={0}
                max={LEVELS.length - 1}
                value={levelIndex}
                onChange={(e) => setLevelIndex(Number(e.target.value))}
                className="slider"
              />
              <div className="lvl-blurb">{level.blurb}</div>
              <div className="movetime-row">
                <span className="movetime-label">Think time</span>
                <select
                  className="movetime-select"
                  value={moveTimeIdx}
                  onChange={(e) => setMoveTimeIdx(Number(e.target.value))}
                  disabled={tcIdx !== 0}
                >
                  {MOVE_TIMES.map((t, i) => (
                    <option key={t.label} value={i}>
                      {t.label}
                    </option>
                  ))}
                </select>
              </div>
              <div className="movetime-row">
                <span className="movetime-label">Time control</span>
                <select
                  className="movetime-select"
                  value={tcIdx}
                  onChange={(e) => {
                    const idx = Number(e.target.value)
                    setTcIdx(idx)
                    resetClock(idx)
                  }}
                >
                  {TIME_CONTROLS.map((t, i) => (
                    <option key={t.label} value={i}>
                      {t.label}
                    </option>
                  ))}
                </select>
              </div>
              {tcIdx !== 0 && (
                <div className="clock-row">
                  <span className="clock-label">Engine clock</span>
                  <span className={`clock-time${engineClockMs < 10000 ? ' low' : ''}`}>{formatClock(engineClockMs)}</span>
                  {lastBudget > 0 && <span className="clock-budget">allotting {(lastBudget / 1000).toFixed(1)}s/move</span>}
                </div>
              )}
              <div className="toggles">
                <label className="toggle">
                  <input type="checkbox" checked={bookOn} onChange={(e) => setBookOn(e.target.checked)} />
                  <span>Opening book</span>
                </label>
                <label
                  className={`toggle${nnueBlob ? '' : ' disabled'}`}
                  title={
                    nnueIsDefault
                      ? `Shipped pre-trained net (R²=${nnueMeta?.r2.toFixed(2)}) — train your own in the Lab → NNUE tab`
                      : `Your trained net: R²=${nnueMeta?.r2.toFixed(2)}`
                  }
                >
                  <input
                    type="checkbox"
                    checked={nnueOn}
                    disabled={!nnueBlob}
                    onChange={(e) => setNnueOn(e.target.checked)}
                  />
                  <span>
                    NNUE eval{nnueMeta ? ` (${nnueIsDefault ? 'shipped' : 'yours'} · R²=${nnueMeta.r2.toFixed(2)})` : ''}
                  </span>
                </label>
                <label className="toggle">
                  <input
                    type="checkbox"
                    checked={analysisOn}
                    onChange={(e) => {
                      const on = e.target.checked
                      setAnalysisOn(on)
                      if (!on) {
                        engine.cancel()
                        setAnalyzing(false)
                      }
                    }}
                  />
                  <span>Analyze my moves</span>
                </label>
                <label className="toggle">
                  <input
                    type="checkbox"
                    checked={ponderOn}
                    onChange={(e) => {
                      const on = e.target.checked
                      setPonderOn(on)
                      if (!on) clearPonder()
                    }}
                  />
                  <span>Ponder {ponderHit && <span className="ponder-hit">⚡ hit</span>}</span>
                </label>
              </div>
            </div>

            <div className="panel controls">
              <button className="btn" onClick={() => newGame()}>
                New Game
              </button>
              <button className="btn" onClick={undo} disabled={view.historySan.length === 0}>
                Take Back
              </button>
              <button className="btn" onClick={hint} disabled={thinking || view.result !== 'playing'}>
                Hint
              </button>
              <button className="btn" onClick={() => setWhiteOnBottom((v) => !v)}>
                Flip Board
              </button>
            </div>

            <div className="panel">
              <div className="panel-title">
                Chess960
                {spId !== null && (
                  <span className="badge-960">
                    {dfrc ? 'Double Fischer Random' : spId >= 0 ? `Fischer Random · #${spId}` : 'Fischer Random'}
                  </span>
                )}
              </div>
              <p className="panel-note">
                Fischer Random — the back rank is shuffled into one of 960 set-ups (king between the rooks, bishops on
                opposite colours). Castling still works: drop the king on its g/c square or click your own rook.
              </p>
              <div className="controls-960">
                <button className="btn small" onClick={() => newGame960()}>
                  Random 960
                </button>
                <input
                  className="id-input"
                  inputMode="numeric"
                  placeholder="0–959"
                  value={idInput}
                  onChange={(e) => setIdInput(e.target.value.replace(/[^0-9]/g, '').slice(0, 3))}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && idInput !== '') newGame960(Number(idInput))
                  }}
                />
                <button className="btn small" onClick={() => newGame960(Number(idInput))} disabled={idInput === ''}>
                  Start #
                </button>
                <button className="btn small" onClick={() => newGame960(STANDARD_ID)} title="The standard set-up is SP-ID 518">
                  #518 (standard)
                </button>
                <button className="btn small" onClick={newGameDfrc} title="Double Fischer Random — each side gets its own random back rank">
                  Random DFRC
                </button>
              </div>
            </div>

            <div className="panel">
              <div className="panel-title">Moves</div>
              <MoveList sans={view.historySan} />
              <div className="pgn-row">
                <button className="btn small" onClick={copyPgn} disabled={view.historySan.length === 0}>
                  {pgnMsg || 'Copy PGN'}
                </button>
                <button className="btn small" onClick={downloadPgn} disabled={view.historySan.length === 0}>
                  Download PGN
                </button>
              </div>
            </div>

            <div className="panel">
              <div className="panel-title">Position (FEN)</div>
              <div className="fen-current" title={view.fen}>
                {view.fen}
              </div>
              <button className="btn small" onClick={copyFen}>
                {copied ? 'Copied!' : 'Copy FEN'}
              </button>
              <input
                className="fen-input"
                placeholder="paste a FEN to load…"
                value={fenInput}
                onChange={(e) => setFenInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') loadFen()
                }}
              />
              <button className="btn small" onClick={loadFen} disabled={!fenInput.trim()}>
                Load FEN
              </button>
            </div>
          </aside>
        </main>
      ) : tab === 'analyze' ? (
        <main className="analyze-layout">
          <Analysis />
        </main>
      ) : (
        <main className="lab-layout">
          <Lab />
        </main>
      )}

      {promo && <PromotionPicker color={promo.color} onSelect={onPromoSelect} onCancel={() => setPromo(null)} />}

      <footer className="footer">
        <span>
          0x88 board · iterative deepening + PVS · aspiration windows · transposition table · quiescence · SEE ·
          null-move + late-move reductions · internal iterative reduction · countermoves + history · tapered eval
          (mobility · king safety · pawn structure) · KPK / KRK / KQK / <strong>KBNvK</strong> tablebases · opening book +
          explorer · multi-PV analysis · PGN import + annotated export · pondering · EPD suites
        </span>
      </footer>
    </div>
  )
}
