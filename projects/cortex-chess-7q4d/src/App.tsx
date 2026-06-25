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
  buildPgn,
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

export default function App() {
  const gameRef = useRef<Game>(new Game())
  const engine = useEngine()

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
  const [bookOn, setBookOn] = useState(true)
  const [analysisOn, setAnalysisOn] = useState(false)
  const [pgnMsg, setPgnMsg] = useState('')

  const lastSearchedFen = useRef('')
  const lastAnalyzedFen = useRef('')

  const sync = useCallback(() => {
    setView(buildView(gameRef.current))
  }, [])

  const humanControls = useCallback(
    (color: number) => engineSide !== (color === WHITE ? 'white' : 'black'),
    [engineSide],
  )

  const interactive =
    tab === 'play' && view.result === 'playing' && !thinking && humanControls(view.turn)

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
      .think({ fen: searchFen, history, maxDepth: level.maxDepth, maxTime: level.maxTime }, (i) => {
        setInfo(i)
        setPvSan(pvToSan(searchFen, i.pv))
      })
      .then((res) => {
        setThinking(false)
        // Bail if the position changed under us (undo / new game / FEN load).
        if (gameRef.current.fen() !== searchFen) return
        setInfo(res)
        setPvSan(pvToSan(searchFen, res.pv))
        if (res.pv.length > 0) {
          gameRef.current.apply(res.pv[0])
          sync()
        }
      })
  }, [view, engineSide, levelIndex, tab, engine, sync, bookOn])

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
      gameRef.current.apply(move)
      setSelected(null)
      setArrow(null)
      sync()
    },
    [sync, engine],
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
      gameRef.current.reset(START_FEN)
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
    [engine],
  )

  const undo = useCallback(() => {
    engine.cancel()
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
  }, [engine, engineSide])

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
    gameRef.current.reset(fen)
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
  }, [fenInput, engine])

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
              <div className="toggles">
                <label className="toggle">
                  <input type="checkbox" checked={bookOn} onChange={(e) => setBookOn(e.target.checked)} />
                  <span>Opening book</span>
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
          null-move + late-move reductions · tapered eval (mobility · king safety · pawn structure) · KPK bitbase ·
          opening book
        </span>
      </footer>
    </div>
  )
}
