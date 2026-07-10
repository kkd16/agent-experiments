import { useMemo, useState } from 'react'
import Graph from '../components/Graph'
import { Stat } from '../components/Stat'
import { parseTimedAutomaton } from '../engine/timed/parser'
import type { TimedAutomaton } from '../engine/timed/types'
import { maxConstants, showConstraint } from '../engine/timed/types'
import { buildRegionGraph, regionOf, regionSig } from '../engine/timed/regions'
import { buildZoneGraph } from '../engine/timed/reach'
import { describeZone } from '../engine/timed/dbm'
import {
  regionToGraph,
  timedToGraph,
  zoneToGraph,
  describeZoneState,
  showGuard,
} from '../engine/timed/diagram'
import { buildRegionMap } from '../engine/timed/regionmap'
import type { RegionPrim } from '../engine/timed/regionmap'
import { enabledEdges, initialConfig, maxDelay, step } from '../engine/timed/simulate'
import type { Config, Move } from '../engine/timed/simulate'
import { TIMED_EXAMPLES } from '../engine/timed/examples'
import { runSelfTest } from '../engine/timed/selftest'
import './LogicView.css'
import './PresburgerView.css'
import './TimedView.css'

export type TimedTab = 'automaton' | 'regions' | 'zones' | 'run' | 'verify' | 'about'

const TABS: { id: TimedTab; label: string }[] = [
  { id: 'automaton', label: 'Automaton' },
  { id: 'regions', label: 'Regions' },
  { id: 'zones', label: 'Zones' },
  { id: 'run', label: 'Run' },
  { id: 'verify', label: 'Verify' },
  { id: 'about', label: 'About' },
]

interface Props {
  source: string
  onSource: (s: string) => void
  input: string
  onInput: (s: string) => void
  tab: TimedTab
  onTab: (t: TimedTab) => void
}

export default function TimedView({ source, onSource, tab, onTab }: Props) {
  const parsed = useMemo(() => parseTimedAutomaton(source), [source])
  const ta = parsed.ok ? parsed.ta : null

  const region = useMemo(() => (ta ? buildRegionGraph(ta) : null), [ta])
  const zone = useMemo(() => (ta ? buildZoneGraph(ta) : null), [ta])

  const loadExample = (i: number) => onSource(TIMED_EXAMPLES[i].source)

  const parseError = !parsed.ok ? `line ${parsed.line}: ${parsed.message}` : null

  return (
    <div className="workspace logic-ws">
      <main className="viewer">
        <nav className="tabs">
          {TABS.map((t) => (
            <button key={t.id} className={`tab${tab === t.id ? ' active' : ''}`} onClick={() => onTab(t.id)}>
              {t.label}
            </button>
          ))}
        </nav>
        <div className="canvas">
          {tab === 'about' ? (
            <AboutTab />
          ) : tab === 'verify' ? (
            <VerifyTab />
          ) : !ta ? (
            <div className="empty">
              <div className="parse-error">
                <div className="err-msg">{parseError ?? 'define a timed automaton'}</div>
              </div>
            </div>
          ) : tab === 'automaton' ? (
            <AutomatonTab ta={ta} />
          ) : tab === 'regions' ? (
            <RegionsTab ta={ta} region={region!} />
          ) : tab === 'zones' ? (
            <ZonesTab ta={ta} zone={zone!} region={region!} />
          ) : (
            <RunTab ta={ta} />
          )}
        </div>
      </main>

      <aside className="rail">
        <section className="panel">
          <h2>Timed automaton</h2>
          <p className="panel-sub">
            Locations with dwell <b>invariants</b>, edges with clock <b>guards</b> and <b>resets</b>. Syntax:{' '}
            <code>clocks x, y</code> · <code>loc L inv x&lt;=5</code> · <code>A -&gt; B if x&gt;=2 do x act a</code>.
          </p>
          <textarea
            className="sim-input timed-src"
            value={source}
            spellCheck={false}
            onChange={(e) => onSource(e.target.value)}
            aria-label="timed automaton source"
            rows={10}
          />
          {parseError ? <div className="warn small">{parseError}</div> : null}
          <div className="formula-gallery">
            {TIMED_EXAMPLES.map((g, i) => (
              <button key={g.id} className="chip" title={g.note} onClick={() => loadExample(i)}>
                {g.name}
              </button>
            ))}
          </div>
        </section>

        {ta && region && zone && (
          <section className="panel">
            <h2>The finite quotient</h2>
            <p className="panel-sub">an infinite state space, collapsed twice over</p>
            <div className="statline">
              <Stat k="loc" v={ta.locations.length} title="control locations" />
              <Stat k="clk" v={ta.clocks.length} title="clocks" />
              <Stat k="reg" v={region.states.length} title="reachable region-automaton states (Alur–Dill)" />
              <Stat k="zone" v={zone.states.length} title="reachable symbolic zone states (DBM)" />
            </div>
            <p className="note small">
              {zone.states.length <= region.states.length
                ? `Zones compress ${region.states.length} regions into ${zone.states.length} symbolic states — the same reachable locations, far fewer nodes.`
                : `Regions and zones both explore the reachable space; here zones enumerate ${zone.states.length}.`}
            </p>
          </section>
        )}

        <section className="panel">
          <h2>Gallery</h2>
          <select
            className="examples"
            value=""
            onChange={(e) => e.target.value && loadExample(Number(e.target.value))}
            aria-label="load an example"
          >
            <option value="">load a machine ▾</option>
            {TIMED_EXAMPLES.map((g, i) => (
              <option key={g.id} value={i}>
                {g.name}
              </option>
            ))}
          </select>
          <p className="note small gallery-note">{TIMED_EXAMPLES.find((e) => e.source === source)?.note ?? 'Every machine here is a shareable link.'}</p>
        </section>
      </aside>
    </div>
  )
}

// ─────────────────────────────── Automaton tab ───────────────────────────────

function AutomatonTab({ ta }: { ta: TimedAutomaton }) {
  const g = useMemo(() => timedToGraph(ta), [ta])
  const max = useMemo(() => maxConstants(ta), [ta])
  return (
    <div className="automaton-wrap">
      <div className="graph-frame tall">
        <Graph graph={g} fitKey={`ta-${ta.locations.length}-${ta.edges.length}`} exportName="timed-automaton" />
      </div>
      <div className="timed-legend">
        <span className="legend-title">clocks:</span>
        {ta.clocks.map((c, i) => (
          <span key={c} className="track-key">
            <span className="track-var">{c}</span> <span className="track-pos">M={max[i]}</span>
          </span>
        ))}
        <span className="legend-note">
          node sub-label = invariant · edge = <code>[guard] action {'{'}resets{'}'}</code>
        </span>
      </div>
    </div>
  )
}

// ──────────────────────────────── Regions tab ────────────────────────────────

function RegionsTab({ ta, region }: { ta: TimedAutomaton; region: ReturnType<typeof buildRegionGraph> }) {
  const g = useMemo(() => regionToGraph(region), [region])
  const twoClocks = ta.clocks.length === 2
  const [loc, setLoc] = useState<string>(ta.initial)
  const selLoc = ta.locations.some((l) => l.name === loc) ? loc : ta.initial

  return (
    <div className="regions-wrap pad-scroll">
      {twoClocks ? (
        <div className="region-map-block">
          <div className="rm-head">
            <h3 className="sec-h">Region partition of the clock plane</h3>
            <label className="rm-loc">
              at location{' '}
              <select value={selLoc} onChange={(e) => setLoc(e.target.value)}>
                {ta.locations.map((l) => (
                  <option key={l.name} value={l.name}>
                    {l.name}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <p className="note small">
            Highlighted cells are the regions reachable at <b>{selLoc}</b>: filled triangles (fractional order strict),
            diagonal/grid segments (a fraction pinned or two fractions tied), and corner dots (both integer). Grey cells
            are unreachable there. Beyond each clock’s max the exact value stops mattering — those regions live off-grid.
          </p>
          <RegionPartition ta={ta} region={region} loc={selLoc} />
        </div>
      ) : (
        <p className="note">
          The clock-plane picture is drawn for two clocks; this machine has {ta.clocks.length}. The region automaton
          below is the finite quotient in full generality.
        </p>
      )}

      <h3 className="sec-h">The region automaton</h3>
      <p className="note small">
        {region.states.length} reachable region-states. <b>τ</b>-edges are delay (time-successor regions inside the
        invariant); labelled edges are discrete moves. This graph is a finite ordinary automaton whose reachable
        locations are exactly the timed automaton’s.
      </p>
      <div className="graph-frame tall">
        <Graph graph={g} fitKey={`rg-${region.states.length}`} exportName="region-automaton" />
      </div>
    </div>
  )
}

function RegionPartition({
  ta,
  region,
  loc,
}: {
  ta: TimedAutomaton
  region: ReturnType<typeof buildRegionGraph>
  loc: string
}) {
  const max = useMemo(() => maxConstants(ta), [ta])
  const map = useMemo(() => buildRegionMap(ta.clocks, max), [ta.clocks, max])
  const reachSigs = useMemo(() => {
    const s = new Set<string>()
    for (const st of region.states) if (st.loc === loc) s.add(regionSig(st.region))
    return s
  }, [region, loc])

  const isReach = (rep: [number, number]) => reachSigs.has(regionSig(regionOf(rep, max)))

  const S = 46 // px per unit
  const pad = 26
  const W = map.mx * S + pad * 2
  const H = map.my * S + pad * 2
  const px = (x: number) => pad + x * S
  const py = (y: number) => H - pad - y * S

  const tris = map.prims.filter((p): p is Extract<RegionPrim, { kind: 'tri' }> => p.kind === 'tri')
  const segs = map.prims.filter((p): p is Extract<RegionPrim, { kind: 'seg' }> => p.kind === 'seg')
  const pts = map.prims.filter((p): p is Extract<RegionPrim, { kind: 'pt' }> => p.kind === 'pt')

  const reachTotal = useMemo(() => {
    const s = new Set<string>()
    for (const st of region.states) if (st.loc === loc) s.add(regionSig(st.region))
    return s.size
  }, [region, loc])
  const shown = useMemo(() => {
    const s = new Set<string>()
    for (const p of map.prims) {
      const sig = regionSig(regionOf(p.rep, max))
      if (reachSigs.has(sig)) s.add(sig)
    }
    return s.size
  }, [map, reachSigs, max])

  return (
    <div className="region-partition">
      <svg viewBox={`0 0 ${W} ${H}`} className="rp-svg" role="img" aria-label="region partition">
        {tris.map((t, i) => {
          const r = isReach(t.rep)
          return (
            <polygon
              key={`t${i}`}
              points={t.pts.map(([x, y]) => `${px(x)},${py(y)}`).join(' ')}
              className={`rp-tri${r ? ' reach' : ''}`}
            >
              <title>{r ? 'reachable' : 'unreachable'} region</title>
            </polygon>
          )
        })}
        {segs.map((s, i) => {
          const r = isReach(s.rep)
          return (
            <line
              key={`s${i}`}
              x1={px(s.a[0])}
              y1={py(s.a[1])}
              x2={px(s.b[0])}
              y2={py(s.b[1])}
              className={`rp-seg${r ? ' reach' : ''}`}
            />
          )
        })}
        {pts.map((p, i) => {
          const r = isReach(p.rep)
          return <circle key={`p${i}`} cx={px(p.p[0])} cy={py(p.p[1])} r={r ? 3.4 : 2} className={`rp-pt${r ? ' reach' : ''}`} />
        })}
        {/* axes */}
        <line x1={px(0)} y1={py(0)} x2={px(map.mx)} y2={py(0)} className="rp-axis" />
        <line x1={px(0)} y1={py(0)} x2={px(0)} y2={py(map.my)} className="rp-axis" />
        <text x={px(map.mx)} y={py(0) + 16} className="rp-axis-label" textAnchor="end">
          {ta.clocks[0]}
        </text>
        <text x={px(0) - 6} y={py(map.my) + 4} className="rp-axis-label" textAnchor="end">
          {ta.clocks[1]}
        </text>
      </svg>
      <div className="note small rp-count">
        {reachTotal} reachable region{reachTotal === 1 ? '' : 's'} at <b>{loc}</b>
        {reachTotal > shown ? ` · ${reachTotal - shown} off-grid (a clock past its max)` : ''}
      </div>
    </div>
  )
}

// ───────────────────────────────── Zones tab ─────────────────────────────────

function ZonesTab({
  ta,
  zone,
  region,
}: {
  ta: TimedAutomaton
  zone: ReturnType<typeof buildZoneGraph>
  region: ReturnType<typeof buildRegionGraph>
}) {
  const g = useMemo(() => zoneToGraph(zone), [zone])
  const [sel, setSel] = useState<number>(0)
  const selState = zone.states[Math.min(sel, zone.states.length - 1)]

  return (
    <div className="zones-wrap pad-scroll">
      <div className="zones-head">
        <h3 className="sec-h">Symbolic reachability with zones (DBMs)</h3>
        <div className="statline">
          <Stat k="zones" v={zone.states.length} title="reachable symbolic states" />
          <Stat k="regions" v={region.states.length} title="reachable region states — the coarser quotient" />
        </div>
      </div>
      <p className="note small">
        Each node is a <b>(location, zone)</b> pair; a zone is a convex set of valuations stored as a Difference Bound
        Matrix. One symbolic step intersects the guard, resets, lets time elapse under the invariant, then extrapolates
        (Extra<sub>M</sub>) so only finitely many zones ever appear. The reachable locations match the region automaton
        exactly — proven live in <b>Verify</b>.
      </p>
      <div className="graph-frame">
        <Graph graph={g} fitKey={`zg-${zone.states.length}`} exportName="zone-graph" />
      </div>

      <h3 className="sec-h">Zone inspector</h3>
      <div className="zone-inspect">
        <div className="zone-list">
          {zone.states.map((s, i) => (
            <button
              key={i}
              className={`zone-row${i === sel ? ' active' : ''}`}
              onClick={() => setSel(i)}
              title={describeZoneState(zone, i, ta.clocks)}
            >
              <span className="zone-id">z{i}</span>
              <span className="zone-loc">{s.loc}</span>
            </button>
          ))}
        </div>
        {selState && (
          <div className="zone-detail">
            <div className="zone-detail-h">
              z{Math.min(sel, zone.states.length - 1)} · location <b>{selState.loc}</b>
            </div>
            <ul className="zone-cons">
              {describeZone(selState.zone, ta.clocks).map((c, i) => (
                <li key={i}>{c}</li>
              ))}
              {describeZone(selState.zone, ta.clocks).length === 0 && <li>true (unconstrained)</li>}
            </ul>
          </div>
        )}
      </div>
    </div>
  )
}

// ────────────────────────────────── Run tab ──────────────────────────────────

function RunTab({ ta }: { ta: TimedAutomaton }) {
  const [moves, setMoves] = useState<Move[]>([])
  const [delta, setDelta] = useState<number>(1)

  const trace = useMemo(() => {
    let cfg: Config = initialConfig(ta)
    const cfgs: Config[] = [cfg]
    for (const mv of moves) {
      const r = step(ta, cfg, mv)
      if (!r.ok) break
      cfg = r.config
      cfgs.push(cfg)
    }
    return cfgs
  }, [ta, moves])

  const cfg = trace[trace.length - 1]
  const enabled = useMemo(() => enabledEdges(ta, cfg), [ta, cfg])
  const md = maxDelay(ta, cfg)
  const doMove = (m: Move) => setMoves((ms) => [...ms, m])
  const reset = () => setMoves([])

  return (
    <div className="run-wrap pad-scroll">
      <h3 className="sec-h">Concrete timed run</h3>
      <p className="note small">
        The ground-truth operational semantics: <b>delay</b> advances every clock together (legal only while the
        invariant holds), then an <b>action</b> takes an enabled edge — guard satisfied now, its resets applied, target
        invariant respected. This is what the region and zone abstractions are validated against.
      </p>

      <div className="run-state">
        <div className="run-loc">
          <span className="run-loc-label">location</span>
          <span className="run-loc-name">{cfg.loc}</span>
        </div>
        <div className="run-clocks">
          {ta.clocks.map((c, i) => (
            <span key={c} className="clock-chip">
              <span className="clock-name">{c}</span>
              <span className="clock-val">{fmt(cfg.val[i])}</span>
            </span>
          ))}
        </div>
      </div>

      <div className="run-controls">
        <div className="delay-row">
          <span className="ctrl-label">delay</span>
          <input
            type="number"
            className="delay-num"
            min={0}
            step={0.5}
            value={delta}
            onChange={(e) => setDelta(Math.max(0, Number(e.target.value) || 0))}
          />
          <button
            className="run-btn delay-btn"
            disabled={md !== Infinity && delta > md + 1e-9}
            onClick={() => doMove({ kind: 'delay', delta })}
          >
            wait {fmt(delta)}
          </button>
          <span className="note small">
            max legal delay here: {md === Infinity ? '∞' : fmt(md)}{' '}
            {md !== Infinity && <em>(invariant {showConstraint(locInv(ta, cfg.loc))})</em>}
          </span>
        </div>
        <div className="action-row">
          <span className="ctrl-label">actions</span>
          {enabled.length === 0 && <span className="note small">no enabled edge — {md === 0 ? 'deadlocked' : 'wait first, or deadlock'}</span>}
          {enabled.map((ei) => {
            const e = ta.edges[ei]
            return (
              <button key={ei} className="run-btn act-btn" onClick={() => doMove({ kind: 'action', edge: ei })}>
                {e.action || 'ε'} → {e.to}
                {e.guard.length ? <span className="act-guard"> [{showGuard(e.guard)}]</span> : null}
                {e.resets.length ? <span className="act-reset"> {'{'}
                  {e.resets.join(',')}
                  {'}'}</span> : null}
              </button>
            )
          })}
        </div>
        <button className="run-btn reset-btn" onClick={reset}>
          reset run
        </button>
      </div>

      <h3 className="sec-h">Trace</h3>
      <div className="run-trace">
        {trace.map((c, i) => (
          <div key={i} className="trace-step">
            <span className="trace-n">{i}</span>
            <span className="trace-loc">{c.loc}</span>
            <span className="trace-vals">
              {ta.clocks.map((cl, j) => `${cl}=${fmt(c.val[j])}`).join('  ')}
            </span>
            {i < moves.length && (
              <span className="trace-move">{moves[i].kind === 'delay' ? `wait ${fmt((moves[i] as { delta: number }).delta)}` : `↦ ${ta.edges[(moves[i] as { edge: number }).edge].action || 'ε'}`}</span>
            )}
          </div>
        ))}
      </div>
    </div>
  )
}

function locInv(ta: TimedAutomaton, loc: string) {
  return ta.locations.find((l) => l.name === loc)?.invariant ?? []
}

function fmt(x: number): string {
  if (Number.isInteger(x)) return String(x)
  return x.toFixed(2).replace(/0+$/, '').replace(/\.$/, '')
}

// ──────────────────────────────── Verify tab ─────────────────────────────────

function VerifyTab() {
  const report = useMemo(() => runSelfTest(), [])
  return (
    <div className="pad-scroll timed-verify">
      <h3 className="sec-h">Verification suite</h3>
      <p className="note">
        Two reachability engines — Alur &amp; Dill’s finite <b>region automaton</b> and the DBM <b>zone</b> fixpoint with
        maximal-bound extrapolation — were written independently and share <b>no code</b>. The headline test is therefore
        a genuine differential proof: on every gallery machine and hundreds of random ones, the set of reachable control
        locations they compute is <b>identical</b>. Around it sit the DBM algebra (canonical form, emptiness, monotone
        operations), the region time-successor checked against concrete delay, a three-way{' '}
        <code>concrete ⊆ region ⊆ zone</code> soundness cross-check, a known-answer battery, and parser round-trips.
      </p>
      <div className={`verify-summary ${report.ok ? 'ok' : 'bad'}`}>
        {report.passed} / {report.total} checks passed
      </div>
      <ul className="verify-list">
        {report.results.map((r, i) => (
          <li key={i} className={r.pass ? 'pass' : 'fail'}>
            <span className="verify-mark">{r.pass ? '✓' : '✗'}</span>
            <span className="verify-name">{r.name}</span>
            <span className="verify-detail muted">{r.detail}</span>
          </li>
        ))}
      </ul>
    </div>
  )
}

// ───────────────────────────────── About tab ─────────────────────────────────

function AboutTab() {
  return (
    <div className="pad-scroll about">
      <h3 className="sec-h">Timed automata — where a clock is a real number</h3>
      <p className="note">
        A <b>timed automaton</b> (Alur &amp; Dill, 1990) is a finite automaton with a handful of real-valued{' '}
        <b>clocks</b> that all advance at rate 1 as time passes. An edge may <b>guard</b> on a clock
        (<code>x ≥ 2</code>), <b>reset</b> clocks to 0, and a location may carry an <b>invariant</b>
        (<code>x ≤ 5</code>) that forbids lingering. It is the standard model of real-time systems — protocols,
        schedulers, circuits — and the theory behind the tool <b>UPPAAL</b>.
      </p>
      <h4 className="sub-h">The problem, and the theorem</h4>
      <p className="note">
        The state is a location <em>plus</em> a clock valuation in ℝ<sup>n</sup><sub>≥0</sub> — an <b>infinite</b>,
        indeed uncountable, state space. Yet reachability is decidable. Alur &amp; Dill’s insight: two valuations that
        agree on the integer part of every clock (up to the largest constant it is ever compared to) and on the{' '}
        <b>order of their fractional parts</b> can never be told apart by any guard, now or in the future, and stay
        equivalent as time elapses. That equivalence has <b>finitely many classes</b> — the <b>regions</b> — so the
        quotient is an ordinary finite automaton. This mode builds it and draws it (the two-clock partition of the
        plane is the picture from the original paper).
      </p>
      <h4 className="sub-h">Regions vs zones</h4>
      <p className="note">
        Regions are finite but there are exponentially many. Real tools instead explore <b>zones</b>: convex unions of
        regions carried as <b>Difference Bound Matrices</b>, where delay, reset, guard intersection and inclusion are
        small matrix operations and the canonical (tightest) form is all-pairs shortest paths. To keep the search
        finite, zones are <b>extrapolated</b> to a coarser one once a clock passes its maximal constant. This mode runs
        both and — because they were built independently — grades them against each other, live, in the <b>Verify</b>
        tab: same reachable locations, every time.
      </p>
      <h4 className="sub-h">What you can do here</h4>
      <ul className="about-list">
        <li>
          <b>Automaton.</b> Edit or load a machine; see it drawn with invariants and guarded, resetting edges.
        </li>
        <li>
          <b>Regions.</b> The finite region automaton, and — for two clocks — the classic region partition of the clock
          plane with the regions reachable at a chosen location lit up.
        </li>
        <li>
          <b>Zones.</b> The symbolic zone graph and a DBM inspector, showing how few symbolic states cover the same
          reachable space.
        </li>
        <li>
          <b>Run.</b> Drive a concrete timed run — wait, then take an enabled edge — and watch the clocks and the
          invariant’s deadline.
        </li>
      </ul>
    </div>
  )
}
