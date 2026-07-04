import { useMemo, useRef, useState } from 'react'
import type { PointerEvent as ReactPointerEvent, ReactNode } from 'react'
import type { Arena, Condition, Player } from '../engine/games/types'
import { effectivePriority, other } from '../engine/games/types'
import { GAME_EXAMPLES, DEFAULT_EXAMPLE, findExample } from '../engine/games/examples'
import { randomArena } from '../engine/games/random'
import { solveGame } from '../engine/games/solve'
import { jointNext, lasso, prescribedMove, lassoWinnerParity } from '../engine/games/simulate'
import { runGamesSelfTest } from '../engine/games/selftest'
import { Stat } from '../components/Stat'
import './GamesView.css'

export type GamesTab = 'arena' | 'solve' | 'play' | 'synth' | 'verify' | 'about'

const TABS: { id: GamesTab; label: string }[] = [
  { id: 'arena', label: 'Arena' },
  { id: 'solve', label: 'Solve' },
  { id: 'play', label: 'Play' },
  { id: 'synth', label: 'Synthesis' },
  { id: 'verify', label: 'Verify' },
  { id: 'about', label: 'About' },
]

const CONDS: { id: Condition; label: string }[] = [
  { id: 'reachability', label: 'Reachability' },
  { id: 'safety', label: 'Safety' },
  { id: 'buchi', label: 'Büchi' },
  { id: 'parity', label: 'Parity' },
]

const MAX_PRIORITY = 5

interface Props {
  preset: string
  onPreset: (s: string) => void
  condition: Condition
  onCondition: (c: Condition) => void
  tab: GamesTab
  onTab: (t: GamesTab) => void
}

function cloneArena(a: Arena): Arena {
  return {
    n: a.n,
    owner: a.owner.slice(),
    edges: a.edges.map((e) => e.slice()),
    priority: a.priority.slice(),
    accent: a.accent.slice(),
    labels: a.labels.slice(),
    pos: a.pos.map((p) => ({ ...p })),
  }
}

function baseArena(preset: string, cond: Condition): Arena {
  if (preset.startsWith('random:')) {
    const [, seed, n] = preset.split(':')
    return randomArena(Number(seed), cond, { n: Number(n), maxOut: 3, maxPriority: MAX_PRIORITY })
  }
  const ex = findExample(preset)
  return cloneArena(ex ? ex.arena : DEFAULT_EXAMPLE.arena)
}

/** What the coloured vertices mean for the current condition. */
function accentGlyph(cond: Condition): string {
  return cond === 'reachability' ? '⚑' : cond === 'safety' ? '☠' : cond === 'buchi' ? '✓' : ''
}
function accentWord(cond: Condition): string {
  return cond === 'reachability' ? 'target' : cond === 'safety' ? 'hazard' : cond === 'buchi' ? 'accepting' : ''
}

type EditMode = 'colour' | 'owner' | 'priority'

interface PlayState {
  path: number[]
  loopAt: number | null
  human: Player
}

const R = 6.2

export default function GamesView({ preset, onPreset, condition, onCondition, tab, onTab }: Props) {
  // The (editable) arena is derived from the preset + condition, and re-seeded whenever they change.
  const [arena, setArena] = useState<Arena>(() => baseArena(preset, condition))
  const key = `${preset}|${condition}`
  const [lastKey, setLastKey] = useState(key)
  const [edit, setEdit] = useState<EditMode>('colour')
  const [play, setPlay] = useState<PlayState>({ path: [0], loopAt: null, human: 0 })
  if (key !== lastKey) {
    setLastKey(key)
    const fresh = baseArena(preset, condition)
    setArena(fresh)
    setPlay({ path: [0], loopAt: null, human: 0 })
    if (edit === 'colour' && condition === 'parity') setEdit('priority')
  }

  const solved = useMemo(() => solveGame(arena, condition), [arena, condition])
  const { solution, certificate } = solved

  const w0 = solution.winner.filter((w) => w === 0).length
  const w1 = arena.n - w0
  const example = findExample(preset)

  // ---- editing -----------------------------------------------------------
  const applyEdit = (v: number) => {
    setArena((a) => {
      const b = cloneArena(a)
      if (edit === 'owner') b.owner[v] = other(b.owner[v])
      else if (edit === 'priority') b.priority[v] = (b.priority[v] + 1) % (MAX_PRIORITY + 1)
      else b.accent[v] = !b.accent[v]
      return b
    })
  }

  // ---- play --------------------------------------------------------------
  const current = play.path[play.path.length - 1]
  const legal = useMemo(() => {
    if (arena.owner[current] !== play.human || play.loopAt !== null) return new Set<number>()
    return new Set(arena.edges[current])
  }, [arena, current, play])

  const advanceAuto = (path: number[]): PlayState => {
    // Let the opponent (and any forced steps) move until it is the human's turn or a loop appears.
    const p = path.slice()
    for (let guard = 0; guard < 400; guard++) {
      const cur = p[p.length - 1]
      const seen = p.indexOf(cur)
      if (seen !== p.length - 1) return { path: p, loopAt: seen, human: play.human }
      if (arena.owner[cur] === play.human) return { path: p, loopAt: null, human: play.human }
      const mv = prescribedMove(arena, solution, cur)
      p.push(mv ?? jointNext(arena, solution, cur))
    }
    return { path: p, loopAt: null, human: play.human }
  }

  const stepTo = (v: number) => {
    if (!legal.has(v)) {
      setPlay({ path: [v], loopAt: null, human: play.human }) // clicking elsewhere re-roots the play
      return
    }
    const path = [...play.path, v]
    const seen = path.indexOf(v)
    if (seen !== path.length - 1) setPlay({ path, loopAt: seen, human: play.human })
    else setPlay(advanceAuto(path))
  }

  const autoPlay = () => {
    const l = lasso((v) => jointNext(arena, solution, v), current)
    const path = [...l.prefix, ...l.loop]
    setPlay({ path, loopAt: l.prefix.length, human: play.human })
  }

  const resetPlay = (start = 0) => setPlay({ path: [start], loopAt: null, human: play.human })
  const setHuman = (h: Player) => setPlay({ path: [current], loopAt: null, human: h })

  // ---- node click routing ------------------------------------------------
  const onNode = (v: number) => {
    if (tab === 'arena') applyEdit(v)
    else if (tab === 'play') stepTo(v)
  }

  // Highlight sets for the canvas.
  const pathEdges = new Set<string>()
  for (let i = 0; i + 1 < play.path.length; i++) pathEdges.add(`${play.path[i]}->${play.path[i + 1]}`)
  const showRegions = tab === 'solve' || tab === 'play' || tab === 'synth'
  const showStrat = tab === 'solve' || tab === 'synth'

  const randomize = () => {
    const seed = (Math.floor(Math.abs(Math.sin(arena.n * 999 + w0 * 31 + Date.now())) * 1e6) % 99991) + 1
    onPreset(`random:${seed}:${Math.min(12, Math.max(5, arena.n))}`)
  }
  const resize = (n: number) => {
    const seed = preset.startsWith('random:') ? Number(preset.split(':')[1]) : 7
    onPreset(`random:${seed}:${n}`)
  }

  return (
    <div className="workspace games-ws">
      <main className="viewer">
        <nav className="tabs">
          {TABS.map((t) => (
            <button key={t.id} className={`tab${tab === t.id ? ' active' : ''}`} onClick={() => onTab(t.id)}>
              {t.label}
            </button>
          ))}
        </nav>
        <div className="canvas games-canvas">
          {tab === 'verify' ? (
            <VerifyTab />
          ) : tab === 'about' ? (
            <AboutTab />
          ) : (
            <ArenaCanvas
              arena={arena}
              condition={condition}
              winner={showRegions ? solution.winner : null}
              strat={showStrat ? solution : null}
              current={tab === 'play' ? current : null}
              legal={tab === 'play' ? legal : null}
              pathEdges={pathEdges}
              onNode={onNode}
              onMove={(v, x, y) =>
                setArena((a) => {
                  const b = cloneArena(a)
                  b.pos[v] = { x, y }
                  return b
                })
              }
            />
          )}
        </div>
        {tab === 'play' && <PlayBar arena={arena} condition={condition} play={play} onAuto={autoPlay} onReset={() => resetPlay(current)} onHuman={setHuman} />}
      </main>

      <aside className="rail">
        {(tab === 'arena' || tab === 'solve' || tab === 'play' || tab === 'synth') && (
          <section className="panel">
            <h2>Game</h2>
            <p className="panel-sub">{example ? example.blurb : 'A random arena — drag nodes to arrange; solve, play, or synthesise.'}</p>
            <div className="cond-row">
              {CONDS.map((c) => (
                <button
                  key={c.id}
                  className={`chip${condition === c.id ? ' on' : ''}`}
                  onClick={() => onCondition(c.id)}
                  title={`Player 0 wins by ${c.id}`}
                >
                  {c.label}
                </button>
              ))}
            </div>
            <div className="example-gallery">
              {GAME_EXAMPLES.map((e) => (
                <button
                  key={e.id}
                  className={`chip${preset === e.id ? ' on' : ''}`}
                  onClick={() => {
                    onPreset(e.id)
                    onCondition(e.condition)
                  }}
                  title={e.name}
                >
                  {e.name}
                </button>
              ))}
            </div>
            <div className="rand-row">
              <button className="chip" onClick={randomize}>🎲 random</button>
              <label className="size-label">
                size
                <input
                  type="range"
                  min={4}
                  max={14}
                  value={Math.min(14, Math.max(4, arena.n))}
                  onChange={(e) => resize(Number(e.target.value))}
                />
                <span className="mono">{arena.n}</span>
              </label>
            </div>
          </section>
        )}

        {tab === 'arena' && (
          <section className="panel">
            <h2>Edit</h2>
            <p className="panel-sub">
              Click a node to apply the current edit. Player 0 (Even) is a ◯ circle; Player 1 (Odd) is a ▢ square.
            </p>
            <div className="cond-row">
              {(condition === 'parity' ? (['priority', 'owner'] as EditMode[]) : (['colour', 'owner'] as EditMode[])).map((m) => (
                <button key={m} className={`chip${edit === m ? ' on' : ''}`} onClick={() => setEdit(m)}>
                  {m === 'colour' ? `colour ${accentGlyph(condition)}` : m === 'owner' ? 'owner ◯▢' : 'priority ⓝ'}
                </button>
              ))}
            </div>
            {condition !== 'parity' && (
              <p className="panel-sub small">
                Coloured nodes are the <b>{accentWord(condition)}</b> set {accentGlyph(condition)}.
              </p>
            )}
          </section>
        )}

        {(tab === 'solve' || tab === 'play' || tab === 'synth') && (
          <section className="panel">
            <h2>Winning regions</h2>
            <div className="stat-line">
              <Stat k="W₀" v={w0} title="vertices won by Player 0 (Even)" />
              <Stat k="W₁" v={w1} title="vertices won by Player 1 (Odd)" />
            </div>
            <div className="legend">
              <span className="leg"><i className="sw p0" /> Player 0 wins</span>
              <span className="leg"><i className="sw p1" /> Player 1 wins</span>
            </div>
            <div className={`cert ${certificate.ok ? 'ok' : 'bad'}`}>
              <b>{certificate.ok ? '✓ proven' : '✗ unproven'}</b> {certificate.reason}
            </div>
            <p className="panel-sub small">
              Bold arrows are each player’s positional winning strategy — one fixed move per owned vertex in its region.
            </p>
          </section>
        )}

        {tab === 'synth' && <SynthPanel arena={arena} solution={solution} condition={condition} />}
      </aside>
    </div>
  )
}

// ---------------------------------------------------------------------------
// The arena canvas
// ---------------------------------------------------------------------------

interface CanvasProps {
  arena: Arena
  condition: Condition
  winner: Player[] | null
  strat: { strat0: number[]; strat1: number[] } | null
  current: number | null
  legal: Set<number> | null
  pathEdges: Set<string>
  onNode: (v: number) => void
  onMove: (v: number, x: number, y: number) => void
}

function ArenaCanvas({ arena, condition, winner, strat, current, legal, pathEdges, onNode, onMove }: CanvasProps) {
  const svgRef = useRef<SVGSVGElement | null>(null)
  const drag = useRef<{ v: number; moved: boolean } | null>(null)

  const toSvg = (e: ReactPointerEvent): { x: number; y: number } => {
    const svg = svgRef.current
    if (!svg) return { x: 0, y: 0 }
    const r = svg.getBoundingClientRect()
    return { x: ((e.clientX - r.left) / r.width) * 100, y: ((e.clientY - r.top) / r.height) * 100 }
  }

  const down = (e: ReactPointerEvent, v: number) => {
    ;(e.target as Element).setPointerCapture?.(e.pointerId)
    drag.current = { v, moved: false }
  }
  const move = (e: ReactPointerEvent) => {
    if (!drag.current) return
    const p = toSvg(e)
    drag.current.moved = true
    onMove(drag.current.v, Math.max(4, Math.min(96, p.x)), Math.max(6, Math.min(94, p.y)))
  }
  const up = (v: number) => {
    if (drag.current && !drag.current.moved) onNode(v)
    drag.current = null
  }

  const pos = arena.pos
  const isStrat = (u: number, v: number): 0 | 1 | null => {
    if (!strat) return null
    if (arena.owner[u] === 0 && strat.strat0[u] === v) return 0
    if (arena.owner[u] === 1 && strat.strat1[u] === v) return 1
    return null
  }

  const edgeEls: ReactNode[] = []
  for (let u = 0; u < arena.n; u++) {
    for (const v of arena.edges[u]) {
      const onPath = pathEdges.has(`${u}->${v}`)
      const s = isStrat(u, v)
      const cls = onPath ? 'e-path' : s === 0 ? 'e-p0' : s === 1 ? 'e-p1' : 'e-plain'
      const marker = onPath ? 'arrow-path' : s === 0 ? 'arrow-p0' : s === 1 ? 'arrow-p1' : 'arrow'
      if (u === v) {
        edgeEls.push(<SelfLoop key={`${u}->${v}`} p={pos[u]} cls={cls} marker={marker} />)
      } else {
        const twoWay = arena.edges[v].includes(u)
        edgeEls.push(
          <EdgeArc key={`${u}->${v}`} a={pos[u]} b={pos[v]} curve={twoWay ? 3.4 : 0} cls={cls} marker={marker} />,
        )
      }
    }
  }

  return (
    <svg ref={svgRef} className="arena-svg" viewBox="0 0 100 100" preserveAspectRatio="xMidYMid meet" onPointerMove={move}>
      <defs>
        {[
          ['arrow', 'var(--muted)'],
          ['arrow-p0', 'var(--accent)'],
          ['arrow-p1', 'var(--bad)'],
          ['arrow-path', 'var(--warn)'],
        ].map(([id, color]) => (
          <marker key={id} id={id} viewBox="0 0 10 10" refX="8.5" refY="5" markerWidth="5.5" markerHeight="5.5" orient="auto-start-reverse">
            <path d="M0,1 L9,5 L0,9 z" fill={color} />
          </marker>
        ))}
      </defs>
      <g>{edgeEls}</g>
      <g>
        {Array.from({ length: arena.n }, (_, v) => {
          const p = pos[v]
          const win = winner ? winner[v] : null
          const pr = effectivePriority(arena, condition, v)
          const fill = win === 0 ? 'var(--p0-fill)' : win === 1 ? 'var(--p1-fill)' : 'var(--node)'
          const isCur = current === v
          const isLegal = legal ? legal.has(v) : false
          const label = arena.labels[v]
          const glyph = condition !== 'parity' && arena.accent[v] ? accentGlyph(condition) : ''
          return (
            <g
              key={v}
              className={`node${isCur ? ' cur' : ''}${isLegal ? ' legal' : ''}`}
              transform={`translate(${p.x} ${p.y})`}
              onPointerDown={(e) => down(e, v)}
              onPointerUp={() => up(v)}
            >
              {arena.owner[v] === 0 ? (
                <circle r={R} fill={fill} stroke="var(--node-stroke)" strokeWidth={0.6} />
              ) : (
                <rect x={-R} y={-R} width={R * 2} height={R * 2} rx={1.4} fill={fill} stroke="var(--node-stroke)" strokeWidth={0.6} />
              )}
              {condition === 'parity' ? (
                <text className="pri" y={1.6} textAnchor="middle">{pr}</text>
              ) : glyph ? (
                <text className="pri" y={1.9} textAnchor="middle">{glyph}</text>
              ) : null}
              <text className="lbl" y={-R - 1.6} textAnchor="middle">{label}</text>
            </g>
          )
        })}
      </g>
    </svg>
  )
}

function EdgeArc({ a, b, curve, cls, marker }: { a: { x: number; y: number }; b: { x: number; y: number }; curve: number; cls: string; marker: string }) {
  const dx = b.x - a.x
  const dy = b.y - a.y
  const len = Math.hypot(dx, dy) || 1
  const ux = dx / len
  const uy = dy / len
  // Perpendicular offset for two-way edges so the pair doesn't overlap.
  const px = -uy * curve
  const py = ux * curve
  const sx = a.x + ux * R
  const sy = a.y + uy * R
  const ex = b.x - ux * (R + 1.5)
  const ey = b.y - uy * (R + 1.5)
  const mx = (a.x + b.x) / 2 + px
  const my = (a.y + b.y) / 2 + py
  const d = curve ? `M${sx},${sy} Q${mx},${my} ${ex},${ey}` : `M${sx},${sy} L${ex},${ey}`
  return <path className={`edge ${cls}`} d={d} markerEnd={`url(#${marker})`} />
}

function SelfLoop({ p, cls, marker }: { p: { x: number; y: number }; cls: string; marker: string }) {
  const d = `M${p.x - 2},${p.y - R} C${p.x - 9},${p.y - R - 9} ${p.x + 9},${p.y - R - 9} ${p.x + 2},${p.y - R}`
  return <path className={`edge ${cls}`} d={d} markerEnd={`url(#${marker})`} fill="none" />
}

// ---------------------------------------------------------------------------
// Play bar, synthesis, verify, about
// ---------------------------------------------------------------------------

function PlayBar({ arena, condition, play, onAuto, onReset, onHuman }: { arena: Arena; condition: Condition; play: PlayState; onAuto: () => void; onReset: () => void; onHuman: (p: Player) => void }) {
  const current = play.path[play.path.length - 1]
  const yourTurn = arena.owner[current] === play.human && play.loopAt === null
  let verdict = ''
  if (play.loopAt !== null) {
    const loop = play.path.slice(play.loopAt)
    if (condition === 'reachability') verdict = play.path.some((v) => arena.accent[v]) ? 'Player 0 reached the target ✓' : 'the play loops forever without reaching the target — Player 1 wins'
    else if (condition === 'safety') verdict = play.path.some((v) => arena.accent[v]) ? 'the play hit the hazard — Player 1 wins' : 'the play loops safely forever — Player 0 wins'
    else {
      const w = lassoWinnerParity(arena.priority.map((_, v) => effectivePriority(arena, condition, v)), loop)
      const top = Math.max(...loop.map((v) => effectivePriority(arena, condition, v)))
      verdict = `loop’s top priority is ${top} (${top % 2 === 0 ? 'even' : 'odd'}) → Player ${w} wins`
    }
  }
  return (
    <div className="play-bar">
      <div className="play-controls">
        <span className="who">You play:</span>
        <button className={`chip${play.human === 0 ? ' on' : ''}`} onClick={() => onHuman(0)} disabled={play.human === 0}>Player 0 ◯</button>
        <button className={`chip${play.human === 1 ? ' on' : ''}`} onClick={() => onHuman(1)} disabled={play.human === 1}>Player 1 ▢</button>
        <button className="chip" onClick={onAuto} title="both players follow their optimal strategy">▶ optimal</button>
        <button className="chip" onClick={onReset}>↺ reset</button>
      </div>
      <div className="trace">
        {play.path.map((v, i) => (
          <span key={i} className={`tok o${arena.owner[v]}${play.loopAt !== null && i >= play.loopAt ? ' loop' : ''}`}>{arena.labels[v]}</span>
        ))}
      </div>
      <div className={`play-status ${play.loopAt !== null ? 'done' : ''}`}>
        {play.loopAt !== null ? verdict : yourTurn ? 'your move — click a highlighted successor' : `Player ${arena.owner[current]} to move (auto)`}
      </div>
    </div>
  )
}

function SynthPanel({ arena, solution, condition }: { arena: Arena; solution: { winner: Player[]; strat0: number[] }; condition: Condition }) {
  const rows: { v: number; to: number }[] = []
  for (let v = 0; v < arena.n; v++) {
    if (arena.owner[v] === 0 && solution.winner[v] === 0 && solution.strat0[v] >= 0) rows.push({ v, to: solution.strat0[v] })
  }
  return (
    <section className="panel">
      <h2>Synthesised controller</h2>
      <p className="panel-sub small">
        Player 0’s memoryless winning strategy <b>is</b> a controller: in every state it wins, the reaction is a single
        fixed move. For a {condition === 'buchi' ? 'Büchi liveness' : condition} objective this table is a provably
        correct reactive program — the essence of Church’s synthesis problem.
      </p>
      {rows.length === 0 ? (
        <p className="panel-sub small">Player 0 controls no vertex in its winning region for this game.</p>
      ) : (
        <table className="ctrl">
          <thead><tr><th>state</th><th>→ move</th></tr></thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.v}><td className="mono">{arena.labels[r.v]}</td><td className="mono">{arena.labels[r.to]}</td></tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  )
}

function VerifyTab() {
  const [res, setRes] = useState<ReturnType<typeof runGamesSelfTest> | null>(null)
  return (
    <div className="verify-pane">
      <div className="verify-head">
        <h2>Proof harness</h2>
        <button className="chip on" onClick={() => setRes(runGamesSelfTest())}>run all checks</button>
      </div>
      <p className="panel-sub">
        Every solver here is checked three independent ways: a complete <b>memoryless-strategy certificate</b>
        (pin each winner’s strategy, prove no opponent cycle survives), a brute-force <b>oracle</b> on small arenas
        (the rules, nothing else), and structural <b>cross-checks</b> between conditions. Nothing is trusted.
      </p>
      {res && (
        <>
          <div className={`verify-banner ${res.ok ? 'ok' : 'bad'}`}>
            {res.ok ? '✓' : '✗'} {res.passed}/{res.total} checks passed
          </div>
          <ul className="verify-list">
            {res.results.map((r, i) => (
              <li key={i} className={r.pass ? 'ok' : 'bad'}>
                <span className="v-ic">{r.pass ? '✓' : '✗'}</span>
                <span className="v-name">{r.name}</span>
                <span className="v-detail">{r.detail}</span>
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  )
}

function AboutTab() {
  return (
    <div className="about-pane">
      <h2>Infinite games on graphs</h2>
      <p>
        A token sits on a vertex of a finite graph. Each vertex belongs to one of two players; its owner picks an
        outgoing edge; the token moves; forever. The resulting infinite path is a <b>play</b>, and a{' '}
        <b>winning condition</b> decides who won it. These games are the computational core of reactive-system
        synthesis, of automata over infinite words, and of the modal µ-calculus — so they sit one floor above this
        app’s LTL and CTL model checkers, which they generalise.
      </p>
      <h3>The four conditions</h3>
      <ul>
        <li><b>Reachability</b> — Player 0 wins iff the play reaches a target. Solved by one <i>attractor</i>: the states from which Player 0 can force arrival.</li>
        <li><b>Safety</b> — the dual: Player 0 wins iff the play never touches a hazard. Its region is the complement of Player 1’s attractor to the hazard.</li>
        <li><b>Büchi</b> — a liveness condition: an accepting state must recur <i>infinitely often</i>. Solved by a fixpoint that repeatedly peels off the region Player 1 can trap the play in.</li>
        <li><b>Parity</b> — each vertex has a priority; Player 0 wins iff the highest priority seen infinitely often is even. Parity subsumes the others and is inter-reducible with µ-calculus model checking.</li>
      </ul>
      <h3>How they’re solved</h3>
      <p>
        Everything is built from the <b>attractor</b> — the least fixpoint of "I can force you one step closer".
        Parity games are solved by <b>McNaughton–Zielonka</b> recursion: split off the top priority’s attractor,
        recurse, and stitch the two half-answers together. A deep theorem guarantees every parity game is{' '}
        <b>positionally determined</b>: each vertex is won by exactly one player, who wins with a single memoryless
        strategy — one fixed move per vertex.
      </p>
      <h3>Why you can trust it</h3>
      <p>
        Positional determinacy also makes the answer <b>cheap to verify</b>. Pin each player to its returned
        strategy; the opponent now controls all branching, so "can the opponent still win?" becomes a plain graph
        question about reachable cycles of the wrong parity. If neither player’s region admits such a cycle and the
        two regions cover every vertex, the partition is provably exact. The <b>Verify</b> tab runs that certificate
        against a thousand random arenas, cross-checks it against a brute-force referee on small ones, confirms the
        certificate rejects a deliberately corrupted answer, and makes <b>two structurally-independent parity
        algorithms</b> — Zielonka's recursion and Jurdziński's small progress measures — agree on every arena.
      </p>
      <h3>Synthesis</h3>
      <p>
        Player 0’s winning strategy is not just a proof — it is a <b>program</b>. Read as a lookup table from state to
        move, it is a provably correct controller realising the objective against every adversarial environment. That
        is exactly Church’s synthesis problem, and the <b>Synthesis</b> tab shows the controller a solved game yields.
      </p>
    </div>
  )
}
