// Cortex Trainer — the Train tab. A tactics trainer driven entirely by the
// hand-verified puzzle library in `engine/puzzles.ts` (every mate proven forced
// by an in-repo solver). You play the side to move; the trainer plays the forced
// defence for you. A wrong first move "misses" the puzzle (Lichess-style) and you
// can keep trying, reveal the solution, or move on. Your Glicko-lite rating, your
// streak and which puzzles you've seen persist to localStorage (sandbox-safe).

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import Board from './Board'
import {
  Game,
  WHITE,
  type Color,
  PUZZLES,
  THEMES,
  DEFAULT_RATING,
  updateRating,
  puzzlesWithTheme,
  dailyPuzzle,
  pickByRating,
  puzzleSelftest,
  uciToMove,
  uciFrom,
  uciTo,
  sideToMove,
  type Puzzle,
  type Theme,
  type Rating,
} from '../engine'
import {
  buildView,
  type BoardView,
  targetsFrom,
  isPromotionMove,
  pieceAt,
} from '../view'

type Phase = 'solving' | 'solved' | 'shown'
type Feedback = { tone: 'neutral' | 'good' | 'bad' | 'win'; text: string }

// ---- persisted progress -------------------------------------------------
interface Progress {
  rating: Rating
  solved: number
  failed: number
  streak: number
  bestStreak: number
  solvedIds: string[]
  daily?: { date: string; result: 'solved' | 'failed' }
}
const STORE_KEY = 'cortex-trainer-v1'
const FRESH: Progress = {
  rating: { ...DEFAULT_RATING },
  solved: 0,
  failed: 0,
  streak: 0,
  bestStreak: 0,
  solvedIds: [],
}

function loadProgress(): Progress {
  try {
    const raw = localStorage.getItem(STORE_KEY)
    if (!raw) return { ...FRESH }
    const p = JSON.parse(raw) as Progress
    return {
      ...FRESH,
      ...p,
      rating: { ...DEFAULT_RATING, ...(p.rating ?? {}) },
      solvedIds: Array.isArray(p.solvedIds) ? p.solvedIds : [],
    }
  } catch {
    return { ...FRESH }
  }
}
function saveProgress(p: Progress): void {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(p))
  } catch {
    /* sandbox / private mode — progress just won't persist */
  }
}

function todayIso(): string {
  try {
    return new Date().toISOString().slice(0, 10)
  } catch {
    return '2026-01-01'
  }
}

const SELFTEST = puzzleSelftest()

function objective(p: Puzzle): string {
  if (p.kind === 'mate') return `Mate in ${p.mateIn}`
  return 'Find the winning move'
}

export default function Trainer() {
  const [progress, setProgress] = useState<Progress>(() => loadProgress())
  const [theme, setTheme] = useState<Theme | 'all'>('all')
  const seenRef = useRef<Set<string>>(new Set())

  const [puzzle, setPuzzle] = useState<Puzzle>(() => {
    const start = pickByRating(loadProgress().rating.rating, PUZZLES, new Set())
    return start ?? PUZZLES[0]
  })

  const gameRef = useRef<Game>(new Game(puzzle.fen))
  const [view, setView] = useState<BoardView>(() => buildView(new Game(puzzle.fen)))
  const [step, setStep] = useState(0) // index of the next expected solver move in line
  const [phase, setPhase] = useState<Phase>('solving')
  const [feedback, setFeedback] = useState<Feedback>({ tone: 'neutral', text: 'Your move.' })
  const [selected, setSelected] = useState<number | null>(null)
  const [arrow, setArrow] = useState<{ from: number; to: number } | null>(null)
  const [animating, setAnimating] = useState(false)
  const [hintLevel, setHintLevel] = useState(0)
  const [isDaily, setIsDaily] = useState(false)
  const [missed, setMissed] = useState(false) // did the solver err at least once?

  const resolvedRef = useRef(false) // rating applied for this puzzle?
  const tokenRef = useRef(0) // invalidates pending timeouts on puzzle change

  const solverColor: Color = sideToMove(puzzle.fen) === 'w' ? 0 : 1
  const whiteOnBottom = solverColor === WHITE

  // Load a puzzle and reset the board/flow.
  const loadPuzzle = useCallback((p: Puzzle, daily = false) => {
    tokenRef.current++
    gameRef.current = new Game(p.fen)
    resolvedRef.current = false
    setMissed(false)
    seenRef.current.add(p.id)
    setPuzzle(p)
    setIsDaily(daily)
    setStep(0)
    setPhase('solving')
    setSelected(null)
    setArrow(null)
    setAnimating(false)
    setHintLevel(0)
    setView(buildView(gameRef.current))
    setFeedback({
      tone: 'neutral',
      text: `${sideToMove(p.fen) === 'w' ? 'White' : 'Black'} to play — ${objective(p).toLowerCase()}.`,
    })
  }, [])

  const persist = useCallback((next: Progress) => {
    setProgress(next)
    saveProgress(next)
  }, [])

  // Apply the rating/streak outcome for this puzzle exactly once.
  const resolve = useCallback(
    (score: 0 | 1) => {
      if (resolvedRef.current) return
      resolvedRef.current = true
      setProgress((prev) => {
        const rating = updateRating(prev.rating, puzzle.rating, score)
        const solvedIds = score === 1 && !prev.solvedIds.includes(puzzle.id) ? [...prev.solvedIds, puzzle.id] : prev.solvedIds
        const streak = score === 1 ? prev.streak + 1 : 0
        const next: Progress = {
          ...prev,
          rating,
          solved: prev.solved + (score === 1 ? 1 : 0),
          failed: prev.failed + (score === 0 ? 1 : 0),
          streak,
          bestStreak: Math.max(prev.bestStreak, streak),
          solvedIds,
          daily: isDaily ? { date: todayIso(), result: score === 1 ? 'solved' : 'failed' } : prev.daily,
        }
        saveProgress(next)
        return next
      })
    },
    [puzzle, isDaily],
  )

  // Move from the canonical line, applied as the auto-played defence.
  const playDefence = useCallback((atStep: number) => {
    const myToken = tokenRef.current
    setAnimating(true)
    window.setTimeout(() => {
      if (myToken !== tokenRef.current) return
      const uci = puzzle.line[atStep]
      const m = uciToMove(gameRef.current, uci)
      if (m !== null) {
        gameRef.current.apply(m)
        setView(buildView(gameRef.current))
        setStep(atStep + 1)
      }
      setAnimating(false)
      setFeedback({ tone: 'good', text: 'Good — now finish it.' })
    }, 480)
  }, [puzzle])

  // The user attempts a solver move (already known legal).
  const attempt = useCallback(
    (move: number, uci: string) => {
      if (phase !== 'solving' || animating) return
      // Which moves are accepted at this ply?
      const accepted =
        step === 0
          ? puzzle.mateIn <= 1 || puzzle.kind === 'win'
            ? puzzle.keys
            : [puzzle.line[0]]
          : [puzzle.line[step]]

      if (!accepted.includes(uci)) {
        // A miss. Score the puzzle 0 once, but let the solver keep trying.
        if (!resolvedRef.current) {
          setMissed(true)
          resolve(0)
        }
        setSelected(null)
        setFeedback({ tone: 'bad', text: 'Not the move — try again, or reveal the solution.' })
        return
      }

      // Correct. Apply the user's move.
      gameRef.current.apply(move)
      setSelected(null)
      setArrow(null)
      const nextStep = step + 1
      setStep(nextStep)
      setView(buildView(gameRef.current))

      if (nextStep >= puzzle.line.length) {
        // Solved the whole line.
        if (!resolvedRef.current) resolve(1)
        setPhase('solved')
        setFeedback({
          tone: 'win',
          text:
            puzzle.kind === 'mate'
              ? missed
                ? 'Checkmate — solved after a miss.'
                : 'Checkmate! Puzzle solved.'
              : missed
                ? 'Correct — solved after a miss.'
                : 'Correct! Puzzle solved.',
        })
        return
      }
      // Otherwise the defence replies from the canonical line.
      playDefence(nextStep)
    },
    [phase, animating, step, puzzle, resolve, playDefence, missed],
  )

  // ---- board interaction (mirror of the Play tab, scoped to the trainer) ----
  const interactive = phase === 'solving' && !animating && view.turn === solverColor

  const tryUserMove = useCallback(
    (from: number, to: number) => {
      // Promotions: the trainer's lines never under-promote, so queen is correct.
      const promo = isPromotionMove(view.legal, from, to) ? 5 : 0
      const m = gameRef.current.findMove(from, to, promo)
      if (m === null) {
        setSelected(null)
        return
      }
      const uci = squaresToUci(from, to, promo)
      attempt(m, uci)
    },
    [view.legal, attempt],
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
      tryUserMove(selected, sq)
    },
    [interactive, view.board, view.turn, selected, tryUserMove],
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
      tryUserMove(selected, sq)
    },
    [interactive, selected, tryUserMove],
  )

  const targets = useMemo(
    () => (selected !== null ? targetsFrom(view.legal, selected) : []),
    [selected, view.legal],
  )

  // ---- controls ----
  const expectedSolverUci = step < puzzle.line.length ? (step === 0 ? puzzle.line[0] : puzzle.line[step]) : null

  const hint = useCallback(() => {
    if (phase !== 'solving' || animating || expectedSolverUci === null) return
    if (hintLevel === 0) {
      // Level 1: light up the piece to move.
      setSelected(uciFrom(expectedSolverUci))
      setHintLevel(1)
      setFeedback({ tone: 'neutral', text: 'Hint: this is the piece to move.' })
    } else {
      // Level 2: draw the full move as an arrow.
      setArrow({ from: uciFrom(expectedSolverUci), to: uciTo(expectedSolverUci) })
      setHintLevel(2)
      setFeedback({ tone: 'neutral', text: 'Hint: play the highlighted move.' })
    }
  }, [phase, animating, expectedSolverUci, hintLevel])

  const showSolution = useCallback(() => {
    if (phase === 'solved') return
    if (!resolvedRef.current) resolve(0)
    tokenRef.current++
    const myToken = tokenRef.current
    // Replay from the start and animate the whole canonical line.
    gameRef.current = new Game(puzzle.fen)
    setView(buildView(gameRef.current))
    setSelected(null)
    setArrow(null)
    setStep(0)
    setPhase('shown')
    setFeedback({ tone: 'neutral', text: 'Solution:' })
    const playFrom = (i: number) => {
      if (myToken !== tokenRef.current) return
      if (i >= puzzle.line.length) {
        setFeedback({ tone: 'neutral', text: `Solution — ${objective(puzzle).toLowerCase()}.` })
        return
      }
      const m = uciToMove(gameRef.current, puzzle.line[i])
      if (m !== null) {
        gameRef.current.apply(m)
        setView(buildView(gameRef.current))
        if (i === 0) setArrow({ from: uciFrom(puzzle.line[0]), to: uciTo(puzzle.line[0]) })
      }
      window.setTimeout(() => playFrom(i + 1), 620)
    }
    window.setTimeout(() => playFrom(0), 350)
  }, [phase, puzzle, resolve])

  const retry = useCallback(() => loadPuzzle(puzzle, isDaily), [loadPuzzle, puzzle, isDaily])

  const pool = useMemo(() => puzzlesWithTheme(theme), [theme])

  const nextPuzzle = useCallback(() => {
    const next = pickByRating(progress.rating.rating, pool, seenRef.current)
    if (next) loadPuzzle(next)
  }, [progress.rating.rating, pool, loadPuzzle])

  const startDaily = useCallback(() => {
    loadPuzzle(dailyPuzzle(todayIso()), true)
  }, [loadPuzzle])

  // When the theme filter changes, jump to a fresh puzzle within it.
  const changeTheme = useCallback(
    (t: Theme | 'all') => {
      setTheme(t)
      const next = pickByRating(progress.rating.rating, puzzlesWithTheme(t), seenRef.current)
      if (next) loadPuzzle(next)
    },
    [progress.rating.rating, loadPuzzle],
  )

  const resetProgress = useCallback(() => {
    seenRef.current = new Set()
    persist({ ...FRESH, rating: { ...DEFAULT_RATING } })
  }, [persist])

  // Seed the "seen" set with the opening puzzle so Next doesn't repeat it.
  useEffect(() => {
    seenRef.current.add(puzzle.id)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Keyboard shortcuts: h hint, n next, s show solution, r retry.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement) return
      if (e.key === 'h') hint()
      else if (e.key === 'n') nextPuzzle()
      else if (e.key === 's') showSolution()
      else if (e.key === 'r') retry()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [hint, nextPuzzle, showSolution, retry])

  const dailyDoneToday = progress.daily?.date === todayIso()
  const solvedThis = progress.solvedIds.includes(puzzle.id)
  const themeInfo = (k: Theme) => THEMES.find((t) => t.key === k)

  return (
    <div className="trainer">
      <section className="board-area">
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
          <div className={`trainer-feedback ${feedback.tone}`}>
            <span className="tf-icon" aria-hidden>
              {feedback.tone === 'win' ? '✔' : feedback.tone === 'good' ? '→' : feedback.tone === 'bad' ? '✕' : '•'}
            </span>
            <span>{feedback.text}</span>
          </div>
        </div>
      </section>

      <aside className="trainer-side">
        <div className="panel">
          <div className="trainer-head">
            <div>
              <div className="trainer-title">{puzzle.title}</div>
              <div className="trainer-obj">
                {objective(puzzle)} · {sideToMove(puzzle.fen) === 'w' ? 'White' : 'Black'} to move
              </div>
            </div>
            <div className="trainer-rating-badge" title="This puzzle's difficulty rating">
              {puzzle.rating}
              {solvedThis && <span className="trainer-solved-tick" title="You've solved this before">✓</span>}
            </div>
          </div>
          <div className="trainer-themes">
            {puzzle.themes.map((t) => (
              <span key={t} className="chip" title={themeInfo(t)?.blurb}>
                {themeInfo(t)?.label ?? t}
              </span>
            ))}
          </div>
          {(phase !== 'solving' || missed) && <div className="trainer-motif">{puzzle.motif}</div>}
          {(phase !== 'solving') && puzzle.source && <div className="trainer-source">{puzzle.source}</div>}
        </div>

        <div className="panel trainer-controls">
          <button className="btn" onClick={hint} disabled={phase !== 'solving' || animating}>
            {hintLevel === 0 ? 'Hint' : hintLevel === 1 ? 'Show move' : 'Hint'}
          </button>
          <button className="btn" onClick={showSolution} disabled={phase === 'solved'}>
            Solution
          </button>
          <button className="btn" onClick={retry}>
            Retry
          </button>
          <button className="btn primary" onClick={nextPuzzle}>
            Next ▸
          </button>
        </div>

        <div className="panel">
          <div className="panel-title">Your rating</div>
          <div className="trainer-stats">
            <div className="stat big">
              <div className="stat-num">{progress.rating.rating}</div>
              <div className="stat-lbl">±{progress.rating.rd} rating</div>
            </div>
            <div className="stat">
              <div className="stat-num">{progress.streak}</div>
              <div className="stat-lbl">streak</div>
            </div>
            <div className="stat">
              <div className="stat-num">{progress.bestStreak}</div>
              <div className="stat-lbl">best</div>
            </div>
            <div className="stat">
              <div className="stat-num">{progress.solved}</div>
              <div className="stat-lbl">solved</div>
            </div>
            <div className="stat">
              <div className="stat-num">{progress.failed}</div>
              <div className="stat-lbl">missed</div>
            </div>
          </div>
          <div className="trainer-progress-row">
            <span>{progress.solvedIds.length}/{PUZZLES.length} unique solved</span>
            <button className="linkbtn" onClick={resetProgress}>reset</button>
          </div>
        </div>

        <div className="panel">
          <div className="panel-title">Daily puzzle</div>
          <p className="panel-note">
            A deterministic puzzle of the day — everyone gets the same one on {todayIso()}.
          </p>
          <button className="btn small" onClick={startDaily} disabled={isDaily}>
            {dailyDoneToday ? `Today: ${progress.daily?.result === 'solved' ? 'solved ✓' : 'missed'} — replay` : 'Play today’s puzzle'}
          </button>
        </div>

        <div className="panel">
          <div className="panel-title">Themes</div>
          <div className="trainer-theme-filter">
            <button className={theme === 'all' ? 'chip sel' : 'chip'} onClick={() => changeTheme('all')}>
              All ({PUZZLES.length})
            </button>
            {THEMES.filter((t) => puzzlesWithTheme(t.key).length > 0).map((t) => (
              <button
                key={t.key}
                className={theme === t.key ? 'chip sel' : 'chip'}
                title={t.blurb}
                onClick={() => changeTheme(t.key)}
              >
                {t.label} ({puzzlesWithTheme(t.key).length})
              </button>
            ))}
          </div>
        </div>

        <div className="panel trainer-foot">
          <span title="Every mate is proven forced by an in-repo solver; the shipped data is re-checked at runtime.">
            {SELFTEST.ok
              ? `✓ ${SELFTEST.total} puzzles verified sound`
              : `⚠ ${SELFTEST.failures.length} puzzle(s) failed self-check`}
          </span>
          <span className="trainer-kbd">keys: h hint · n next · s solution · r retry</span>
        </div>
      </aside>
    </div>
  )
}

const FILES = 'abcdefgh'
function squaresToUci(from: number, to: number, promo: number): string {
  const name = (s: number) => FILES[s & 7] + ((s >> 4) + 1)
  const pc = promo ? 'nbrq'[promo - 2] : ''
  return name(from) + name(to) + pc
}
