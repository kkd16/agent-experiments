import { useMemo, useRef, useState } from 'react'
import type { PointerEvent as ReactPointerEvent, ReactNode } from 'react'
import type { WArena, Player } from '../engine/games/quant/types'
import { cloneWArena } from '../engine/games/quant/types'
import { QUANT_EXAMPLES, DEFAULT_QUANT, findQuantExample } from '../engine/games/quant/examples'
import { randomWArena } from '../engine/games/quant/random'
import { meanPayoffValues } from '../engine/games/quant/meanpayoff'
import { solveEnergy, certifyEnergy } from '../engine/games/quant/energy'
import { parityToMeanPayoff, reductionWeights } from '../engine/games/quant/reduce'
import { ratStr, ratCmp, rat, type Rational } from '../engine/games/quant/rational'
import { GAME_EXAMPLES } from '../engine/games/examples'
import { solveParity } from '../engine/games/parity'
import { runQuantSelfTest } from '../engine/games/quant/selftest'
import './QuantView.css'

export type QuantTab = 'arena' | 'value' | 'reduce' | 'verify' | 'about'

const TABS: { id: QuantTab; label: string }[] = [
  { id: 'arena', label: 'Arena' },
  { id: 'value', label: 'Value' },
  { id: 'reduce', label: 'Parity ⟶ MP' },
  { id: 'verify', label: 'Verify' },
  { id: 'about', label: 'About' },
]

const R = 6.6
const WCLAMP = 9

interface Props {
  preset: string
  onPreset: (s: string) => void
  tab: QuantTab
  onTab: (t: QuantTab) => void
}

function baseArena(preset: string): WArena {
  if (preset.startsWith('random:')) {
    const [, seed, n] = preset.split(':')
    return randomWArena(Number(seed), { n: Number(n), maxOut: 2, maxWeight: 5 })
  }
  const ex = findQuantExample(preset)
  return cloneWArena(ex ? ex.arena : DEFAULT_QUANT.arena)
}

type EditMode = 'owner' | 'weight'

function valueClass(v: Rational): 'pos' | 'neg' | 'zero' {
  const c = ratCmp(v, rat(0))
  return c > 0 ? 'pos' : c < 0 ? 'neg' : 'zero'
}

export default function QuantView({ preset, onPreset, tab, onTab }: Props) {
  const [arena, setArena] = useState<WArena>(() => baseArena(preset))
  const [lastKey, setLastKey] = useState(preset)
  const [edit, setEdit] = useState<EditMode>('weight')
  if (preset !== lastKey) {
    setLastKey(preset)
    setArena(baseArena(preset))
  }

  const solved = useMemo(() => {
    const values = meanPayoffValues(arena).value
    const energy = solveEnergy(arena)
    const cert = certifyEnergy(arena, energy)
    return { values, energy, cert }
  }, [arena])

  const example = findQuantExample(preset)
  const showSolved = tab === 'value'

  const w0 = solved.energy.win0.filter(Boolean).length
  const w1 = arena.n - w0

  // ---- editing -----------------------------------------------------------
  const onNode = (v: number) => {
    if (tab !== 'arena' || edit !== 'owner') return
    setArena((a) => {
      const b = cloneWArena(a)
      b.owner[v] = (1 - b.owner[v]) as Player
      return b
    })
  }
  const onWeight = (u: number, idx: number, delta: number) => {
    if (tab !== 'arena' || edit !== 'weight') return
    setArena((a) => {
      const b = cloneWArena(a)
      const w = Math.max(-WCLAMP, Math.min(WCLAMP, b.out[u][idx].w + delta))
      b.out[u][idx] = { ...b.out[u][idx], w }
      return b
    })
  }

  const randomize = () => {
    const seed = (Math.floor(Math.abs(Math.sin(arena.n * 911 + w0 * 41 + Date.now())) * 1e6) % 99991) + 1
    onPreset(`random:${seed}:${Math.min(9, Math.max(4, arena.n))}`)
  }
  const resize = (n: number) => {
    const seed = preset.startsWith('random:') ? Number(preset.split(':')[1]) : 7
    onPreset(`random:${seed}:${n}`)
  }

  return (
    <div className="workspace games-ws quant-ws">
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
          ) : tab === 'reduce' ? (
            <ReduceTab />
          ) : (
            <WCanvas
              arena={arena}
              values={showSolved ? solved.values : null}
              strat0={showSolved ? solved.energy.strat0 : null}
              editing={tab === 'arena' ? edit : null}
              onNode={onNode}
              onWeight={onWeight}
              onMove={(v, x, y) =>
                setArena((a) => {
                  const b = cloneWArena(a)
                  b.pos[v] = { x, y }
                  return b
                })
              }
            />
          )}
        </div>
      </main>

      <aside className="rail">
        {(tab === 'arena' || tab === 'value') && (
          <section className="panel">
            <h2>Quantitative game</h2>
            <p className="panel-sub">
              {example ? example.blurb : 'A random weighted arena — Max (◯) maximises the long-run average edge weight, Min (▢) minimises it.'}
            </p>
            <div className="example-gallery">
              {QUANT_EXAMPLES.map((e) => (
                <button key={e.id} className={`chip${preset === e.id ? ' on' : ''}`} onClick={() => onPreset(e.id)} title={e.name}>
                  {e.name}
                </button>
              ))}
            </div>
            <div className="rand-row">
              <button className="chip" onClick={randomize}>🎲 random</button>
              <label className="size-label">
                size
                <input type="range" min={3} max={9} value={Math.min(9, Math.max(3, arena.n))} onChange={(e) => resize(Number(e.target.value))} />
                <span className="mono">{arena.n}</span>
              </label>
            </div>
          </section>
        )}

        {tab === 'arena' && (
          <section className="panel">
            <h2>Edit</h2>
            <p className="panel-sub">
              Max (Even) is a ◯ circle; Min (Odd) is a ▢ square. In <b>weight</b> mode, click an edge’s number to
              +1 (Shift-click to −1). In <b>owner</b> mode, click a node to flip who moves there.
            </p>
            <div className="cond-row">
              {(['weight', 'owner'] as EditMode[]).map((m) => (
                <button key={m} className={`chip${edit === m ? ' on' : ''}`} onClick={() => setEdit(m)}>
                  {m === 'weight' ? 'weight ±' : 'owner ◯▢'}
                </button>
              ))}
            </div>
          </section>
        )}

        {tab === 'value' && (
          <section className="panel">
            <h2>Mean-payoff value</h2>
            <div className="stat-line">
              <span className="stat" title="vertices with ν ≥ 0 (Max keeps energy ≥ 0)"><span className="stat-k">ν≥0</span><span className="stat-v">{w0}</span></span>
              <span className="stat" title="vertices with ν < 0"><span className="stat-k">ν&lt;0</span><span className="stat-v">{w1}</span></span>
            </div>
            <div className="legend">
              <span className="leg"><i className="sw pos" /> ν &gt; 0 (Max profits)</span>
              <span className="leg"><i className="sw neg" /> ν &lt; 0 (Min profits)</span>
              <span className="leg"><i className="sw zero" /> ν = 0 (a wash)</span>
            </div>
            <table className="val-table">
              <thead><tr><th>v</th><th>ν(v)</th><th>credit</th></tr></thead>
              <tbody>
                {Array.from({ length: arena.n }, (_, v) => (
                  <tr key={v}>
                    <td className="mono">{arena.labels[v]}</td>
                    <td className={`mono val ${valueClass(solved.values[v])}`}>{ratStr(solved.values[v])}</td>
                    <td className="mono">{solved.energy.win0[v] ? solved.energy.credit[v] : '⊤'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <div className={`cert ${solved.cert.ok ? 'ok' : 'bad'}`}>
              <b>{solved.cert.ok ? '✓ proven' : '✗ unproven'}</b> {solved.cert.reason}
            </div>
            <p className="panel-sub small">
              Bold arrows are Max’s energy strategy — one fixed move per owned vertex that keeps the cumulative weight
              ≥ 0 on the ν ≥ 0 region. The <b>credit</b> is the least starting energy that strategy needs; ⊤ means no
              finite credit suffices (ν &lt; 0).
            </p>
          </section>
        )}
      </aside>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Weighted arena canvas
// ---------------------------------------------------------------------------

interface CanvasProps {
  arena: WArena
  values: Rational[] | null
  strat0: number[] | null
  editing: EditMode | null
  onNode: (v: number) => void
  onWeight: (u: number, idx: number, delta: number) => void
  onMove: (v: number, x: number, y: number) => void
}

function WCanvas({ arena, values, strat0, editing, onNode, onWeight, onMove }: CanvasProps) {
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
    onMove(drag.current.v, Math.max(5, Math.min(95, p.x)), Math.max(7, Math.min(93, p.y)))
  }
  const up = (v: number) => {
    if (drag.current && !drag.current.moved) onNode(v)
    drag.current = null
  }

  const pos = arena.pos
  const isStrat = (u: number, v: number): boolean => strat0 !== null && arena.owner[u] === 0 && strat0[u] === v

  const edgeEls: ReactNode[] = []
  const pillEls: ReactNode[] = []
  for (let u = 0; u < arena.n; u++) {
    arena.out[u].forEach((e, idx) => {
      const v = e.to
      const strat = isStrat(u, v)
      const cls = strat ? 'e-p0' : 'e-plain'
      const marker = strat ? 'arrow-p0' : 'arrow'
      const twoWay = u !== v && arena.out[v].some((x) => x.to === u)
      const geo =
        u === v
          ? selfLoopGeo(pos[u])
          : edgeGeo(pos[u], pos[v], twoWay ? 3.6 : 0)
      edgeEls.push(<path key={`e${u}-${idx}`} className={`edge ${cls}`} d={geo.d} markerEnd={`url(#${marker})`} fill="none" />)
      const wsign = e.w > 0 ? `+${e.w}` : String(e.w)
      pillEls.push(
        <g
          key={`p${u}-${idx}`}
          className={`wpill${editing === 'weight' ? ' editable' : ''} ${e.w > 0 ? 'wp' : e.w < 0 ? 'wn' : 'wz'}`}
          transform={`translate(${geo.mx} ${geo.my})`}
          onPointerDown={(ev) => {
            if (editing !== 'weight') return
            ev.stopPropagation()
            onWeight(u, idx, ev.shiftKey ? -1 : 1)
          }}
        >
          <rect x={-4.4} y={-3} width={8.8} height={6} rx={2} />
          <text textAnchor="middle" y={2}>{wsign}</text>
        </g>,
      )
    })
  }

  return (
    <svg ref={svgRef} className="arena-svg" viewBox="0 0 100 100" preserveAspectRatio="xMidYMid meet" onPointerMove={move}>
      <defs>
        {[
          ['arrow', 'var(--muted)'],
          ['arrow-p0', 'var(--accent)'],
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
          const vc = values ? valueClass(values[v]) : null
          const fill = vc === 'pos' ? 'var(--p0-fill)' : vc === 'neg' ? 'var(--p1-fill)' : vc === 'zero' ? 'var(--node)' : 'var(--node)'
          return (
            <g key={v} className="node" transform={`translate(${p.x} ${p.y})`} onPointerDown={(e) => down(e, v)} onPointerUp={() => up(v)}>
              {arena.owner[v] === 0 ? (
                <circle r={R} fill={fill} stroke="var(--node-stroke)" strokeWidth={0.6} />
              ) : (
                <rect x={-R} y={-R} width={R * 2} height={R * 2} rx={1.5} fill={fill} stroke="var(--node-stroke)" strokeWidth={0.6} />
              )}
              {values ? <text className="nval" y={1.9} textAnchor="middle">{ratStr(values[v])}</text> : null}
              <text className="lbl" y={-R - 1.6} textAnchor="middle">{arena.labels[v]}</text>
            </g>
          )
        })}
      </g>
      <g>{pillEls}</g>
    </svg>
  )
}

interface Geo { d: string; mx: number; my: number }

function edgeGeo(a: { x: number; y: number }, b: { x: number; y: number }, curve: number): Geo {
  const dx = b.x - a.x
  const dy = b.y - a.y
  const len = Math.hypot(dx, dy) || 1
  const ux = dx / len
  const uy = dy / len
  const px = -uy * curve
  const py = ux * curve
  const sx = a.x + ux * R
  const sy = a.y + uy * R
  const ex = b.x - ux * (R + 1.5)
  const ey = b.y - uy * (R + 1.5)
  const cx = (a.x + b.x) / 2 + px
  const cy = (a.y + b.y) / 2 + py
  const d = curve ? `M${sx},${sy} Q${cx},${cy} ${ex},${ey}` : `M${sx},${sy} L${ex},${ey}`
  // Place the pill at t = 0.36 along the arc (nearer the source), so a two-way pair separates toward
  // its own endpoint instead of piling up at the shared midpoint.
  const t = 0.36
  const mt = 1 - t
  const mx = curve ? mt * mt * sx + 2 * mt * t * cx + t * t * ex : sx + (ex - sx) * t
  const my = curve ? mt * mt * sy + 2 * mt * t * cy + t * t * ey : sy + (ey - sy) * t
  return { d, mx, my }
}

function selfLoopGeo(p: { x: number; y: number }): Geo {
  const d = `M${p.x - 2},${p.y - R} C${p.x - 10},${p.y - R - 11} ${p.x + 10},${p.y - R - 11} ${p.x + 2},${p.y - R}`
  return { d, mx: p.x, my: p.y - R - 7.5 }
}

// ---------------------------------------------------------------------------
// Parity ⟶ mean-payoff reduction tab
// ---------------------------------------------------------------------------

const PARITY_PRESETS = GAME_EXAMPLES.filter((e) => e.condition === 'parity')

function ReduceTab() {
  const [id, setId] = useState(PARITY_PRESETS[0].id)
  const ex = PARITY_PRESETS.find((e) => e.id === id) ?? PARITY_PRESETS[0]
  const par = ex.arena

  const data = useMemo(() => {
    const mp = parityToMeanPayoff(par)
    const weights = reductionWeights(par)
    const values = meanPayoffValues(mp).value
    const parWinner = solveParity(par).winner
    let agree = 0
    const rows = Array.from({ length: par.n }, (_, v) => {
      const evenWinsMp = ratCmp(values[v], rat(0)) > 0
      const evenWinsPar = parWinner[v] === 0
      const match = evenWinsMp === evenWinsPar
      if (match) agree++
      return { v, priority: par.priority[v], weight: weights[v], parity: evenWinsPar, mp: evenWinsMp, match }
    })
    return { rows, agree, mp, values }
  }, [par])

  return (
    <div className="reduce-pane about-pane">
      <h2>Parity is a special case of mean-payoff</h2>
      <p>
        Give the vertex of priority <i>p</i> the weight (−1)<sup>p</sup>·n<sup>p</sup>. On any cycle the highest
        priority present dominates the sum — every lower priority together is smaller than a single top term — so the
        cycle’s <b>mean takes the sign of its top priority’s parity</b>. Player Even therefore wins the parity game
        exactly where the mean-payoff value ν is positive. Owners are preserved (Even = Max, Odd = Min), so the two
        games have the <b>same winning regions</b> — checked here against the qualitative mode’s Zielonka solver.
      </p>
      <div className="cond-row" style={{ marginBottom: 10 }}>
        {PARITY_PRESETS.map((e) => (
          <button key={e.id} className={`chip${id === e.id ? ' on' : ''}`} onClick={() => setId(e.id)}>{e.name}</button>
        ))}
      </div>
      <table className="val-table wide">
        <thead>
          <tr><th>v</th><th>priority p</th><th>weight (−n)ᵖ</th><th>ν(v)</th><th>parity winner</th><th>sign(ν)</th><th></th></tr>
        </thead>
        <tbody>
          {data.rows.map((r) => (
            <tr key={r.v}>
              <td className="mono">{par.labels[r.v]}</td>
              <td className="mono">{r.priority}</td>
              <td className="mono">{r.weight > 0 ? `+${r.weight}` : r.weight}</td>
              <td className={`mono val ${valueClass(data.values[r.v])}`}>{ratStr(data.values[r.v])}</td>
              <td className="mono">{r.parity ? 'Even' : 'Odd'}</td>
              <td className="mono">{r.mp ? 'ν > 0' : 'ν < 0'}</td>
              <td className="mono">{r.match ? '✓' : '✗'}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className={`cert ${data.agree === par.n ? 'ok' : 'bad'}`} style={{ maxWidth: 520 }}>
        <b>{data.agree === par.n ? '✓ identical' : '✗ mismatch'}</b> the mean-payoff reduction agrees with Zielonka on{' '}
        {data.agree}/{par.n} vertices.
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Verify + About
// ---------------------------------------------------------------------------

function VerifyTab() {
  const [res, setRes] = useState<ReturnType<typeof runQuantSelfTest> | null>(null)
  return (
    <div className="verify-pane">
      <div className="verify-head">
        <h2>Proof harness</h2>
        <button className="chip on" onClick={() => setRes(runQuantSelfTest())}>run all checks</button>
      </div>
      <p className="panel-sub">
        The value is proven three independent ways: <b>Zwick–Paterson</b> value iteration vs a brute-force{' '}
        <b>oracle</b> that enumerates strategy pairs, a structurally-unrelated <b>energy</b> fixpoint agreeing on the
        sign, and an independent <b>certificate</b> that pins the strategies and inspects the cycles. The headline:
        the <b>parity → mean-payoff reduction</b> reproduces Zielonka’s winning regions exactly.
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
      <h2>Quantitative games — mean-payoff & energy</h2>
      <p>
        The qualitative Games mode asks a yes/no question: does Player 0 win? A <b>quantitative</b> game asks{' '}
        <i>by how much</i>. Every edge now carries an integer weight, and the payoff of an infinite play is its{' '}
        <b>long-run average</b> weight — Max (◯) pulls it up, Min (▢) pushes it down. The value ν(v) is the average
        the two optimal strategies settle into from v.
      </p>
      <h3>Positional determinacy</h3>
      <p>
        Ehrenfeucht &amp; Mycielski (1979) proved mean-payoff games have a value that <b>both players secure with a
        single memoryless strategy</b>, and that the liminf and limsup averages coincide under optimal play. So the
        value is exactly computable — and it is always a rational number whose denominator is at most the number of
        vertices, which is why this lab reports it as an <b>exact fraction</b>, never a float.
      </p>
      <h3>Two solvers, one answer</h3>
      <p>
        <b>Zwick–Paterson</b> value iteration plays the finite k-step game; once k exceeds 4·n³·W the average
        fₖ(v)/k pins down ν(v) exactly (round to the nearest small-denominator rational). Independently, the{' '}
        <b>energy</b> fixpoint (Brim–Chatterjee–Doyen–Gimbert–Raskin) computes the least starting “battery” Max needs
        to keep the running sum ≥ 0 forever — finite iff ν(v) ≥ 0. The two never disagree on the sign.
      </p>
      <h3>Why parity lives downstairs</h3>
      <p>
        Weight priority <i>p</i> by (−1)<sup>p</sup>·n<sup>p</sup> and a parity game becomes a mean-payoff game with
        the <b>same</b> winning regions: on every cycle the top priority dominates the sum, so the mean’s sign is its
        parity. The <b>Parity ⟶ MP</b> tab runs that reduction on the qualitative mode’s own arenas and checks it
        against Zielonka’s solver, tying the quantitative world back to the qualitative one.
      </p>
      <h3>Why you can trust it</h3>
      <p>
        The <b>Verify</b> tab pits value iteration against a brute-force referee that enumerates every memoryless
        strategy pair, confirms the energy fixpoint agrees on the sign, checks an independent cycle-mean certificate
        (which it also shows has teeth by rejecting a corrupted answer), reproduces the parity reduction, and confirms
        the structural laws a value must obey — shift-invariance ν(w+c)=ν(w)+c and scale-invariance ν(λw)=λν(w).
      </p>
    </div>
  )
}
