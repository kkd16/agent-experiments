// Concurrency Lab — an interactive view over the MVCC engine. Pick a classic
// anomaly scenario and an isolation level; the lab runs the interleaved schedule
// and lets you scrub step-by-step through a transaction timeline, a live
// version-chain inspector, the lock table, the rw-antidependency graph, and a
// serializability verdict — watching anomalies appear and disappear as you raise
// the isolation level.

import { useEffect, useMemo, useRef, useState } from 'react'
import type { Scenario } from '../db/concurrency/scenarios'
import {
  ISOLATION_LEVELS,
  LEVEL_ABBR,
  type IsolationLevel,
  type Val,
} from '../db/concurrency/mvcc'
import { runScenario, type TraceStep, type WorldSnapshot } from '../db/concurrency/runner'
import { SCENARIOS, scenarioById } from '../db/concurrency/scenarios'

const LEVEL_BLURB: Record<IsolationLevel, string> = {
  'READ UNCOMMITTED': 'Reads see the latest write, committed or not — dirty reads are possible.',
  'READ COMMITTED': 'Each statement reads a fresh snapshot of committed data — no dirty reads, but the data can shift between statements.',
  'REPEATABLE READ': 'One snapshot is frozen at BEGIN (snapshot isolation); writers are first-updater-wins. Reads are stable, but write skew slips through.',
  'SERIALIZABLE': 'Snapshot isolation plus SSI: rw-antidependencies are tracked and a dangerous structure aborts a transaction, so every committed schedule is serializable.',
}

function fmtVal(v: Val): string {
  if (v === null) return '∅'
  if (typeof v === 'string') return `'${v}'`
  return String(v)
}

export function ConcurrencyLab() {
  const [scenarioId, setScenarioId] = useState(SCENARIOS[0].id)
  const [level, setLevel] = useState<IsolationLevel>('READ COMMITTED')
  const scenario = useMemo(() => scenarioById(scenarioId), [scenarioId])

  return (
    <div className="cc-lab">
      <aside className="cc-scenarios">
        <h3 className="cc-aside-title">Scenarios</h3>
        <p className="cc-aside-sub">Each is an interleaved schedule that threatens one invariant.</p>
        {SCENARIOS.map((s) => (
          <button
            key={s.id}
            className={`cc-scenario ${s.id === scenarioId ? 'active' : ''}`}
            onClick={() => setScenarioId(s.id)}
          >
            <span className="cc-scenario-title">{s.title}</span>
            <span className="cc-scenario-tag">{s.tagline}</span>
            <span className="cc-scenario-pills">
              {ISOLATION_LEVELS.map((lv) => (
                <span
                  key={lv}
                  className={`cc-mini-pill ${s.anomalyAt.includes(lv) ? 'bad' : 'good'}`}
                  title={`${lv}: ${s.anomalyAt.includes(lv) ? 'anomaly possible' : 'prevented'}`}
                >
                  {LEVEL_ABBR[lv]}
                </span>
              ))}
            </span>
          </button>
        ))}
      </aside>

      {/* Remount on scenario/level change so step state resets cleanly. */}
      <LabRun key={`${scenarioId}|${level}`} scenario={scenario} level={level} onLevel={setLevel} />
    </div>
  )
}

function LabRun({
  scenario,
  level,
  onLevel,
}: {
  scenario: Scenario
  level: IsolationLevel
  onLevel: (lv: IsolationLevel) => void
}) {
  const result = useMemo(() => runScenario(scenario, level), [scenario, level])
  const steps = result.steps
  const lastStep = Math.max(0, steps.length - 1)
  const [step, setStep] = useState(lastStep)
  const [playing, setPlaying] = useState(false)

  // Playback timer.
  const timer = useRef<number | null>(null)
  useEffect(() => {
    if (!playing) return
    timer.current = window.setInterval(() => {
      setStep((s) => {
        if (s >= lastStep) {
          setPlaying(false)
          return s
        }
        return s + 1
      })
    }, 850)
    return () => {
      if (timer.current !== null) window.clearInterval(timer.current)
    }
  }, [playing, lastStep])

  const cur = steps[Math.min(step, lastStep)]
  const world: WorldSnapshot | undefined = cur?.world
  const txnOrder = useMemo(() => orderedTxns(steps), [steps])

  const play = () => {
    if (step >= lastStep) setStep(0)
    setPlaying(true)
  }

  return (
      <div className="cc-main">
        <header className="cc-head">
          <h2 className="cc-title">{scenario.title}</h2>
          <p className="cc-blurb">{scenario.blurb}</p>
          {scenario.invariant && (
            <p className="cc-invariant">
              <span className="cc-inv-tag">invariant</span> {scenario.invariant}
            </p>
          )}
        </header>

        <div className="cc-levels">
          {ISOLATION_LEVELS.map((lv) => (
            <button
              key={lv}
              className={`cc-level ${lv === level ? 'active' : ''} ${scenario.anomalyAt.includes(lv) ? 'anomaly' : 'safe'}`}
              onClick={() => onLevel(lv)}
            >
              <span className="cc-level-abbr">{LEVEL_ABBR[lv]}</span>
              <span className="cc-level-name">{lv}</span>
            </button>
          ))}
        </div>
        <p className="cc-level-blurb">{LEVEL_BLURB[level]}</p>

        <div className={`cc-verdict ${result.verdictKind}`}>
          <span className="cc-verdict-mark">
            {result.verdictKind === 'serializable' ? '✓' : result.verdictKind === 'aborted' ? '⊘' : '✕'}
          </span>
          <span className="cc-verdict-text">{result.verdict}</span>
        </div>

        <div className="cc-playback">
          <button className="btn ghost" onClick={() => { setPlaying(false); setStep(0) }} title="To start">⏮</button>
          <button className="btn ghost" onClick={() => { setPlaying(false); setStep((s) => Math.max(0, s - 1)) }} title="Previous">◀</button>
          <button className="btn" onClick={() => (playing ? setPlaying(false) : play())}>
            {playing ? '⏸ Pause' : '▶ Play'}
          </button>
          <button className="btn ghost" onClick={() => { setPlaying(false); setStep((s) => Math.min(lastStep, s + 1)) }} title="Next">▶</button>
          <button className="btn ghost" onClick={() => { setPlaying(false); setStep(lastStep) }} title="To end">⏭</button>
          <input
            className="cc-scrub"
            type="range"
            min={0}
            max={lastStep}
            value={Math.min(step, lastStep)}
            onChange={(e) => { setPlaying(false); setStep(Number(e.target.value)) }}
          />
          <span className="cc-step-counter">step {Math.min(step, lastStep) + 1} / {steps.length}</span>
        </div>

        {cur && (
          <div className={`cc-narration ${cur.status}`}>
            <span className="cc-narr-step">#{cur.seq + 1}</span>
            <span className="cc-narr-txn">{cur.t}</span>
            <span className="cc-narr-op">{cur.op}</span>
            <span className="cc-narr-detail">{cur.detail}</span>
          </div>
        )}

        <div className="cc-columns">
          <section className="cc-panel cc-timeline-panel">
            <h3 className="cc-panel-title">Schedule timeline</h3>
            <Timeline steps={steps} txnOrder={txnOrder} current={Math.min(step, lastStep)} onPick={(i) => { setPlaying(false); setStep(i) }} />
          </section>

          <div className="cc-rightcol">
            <section className="cc-panel">
              <h3 className="cc-panel-title">Version chains <span className="cc-panel-hint">(xmin · xmax)</span></h3>
              {world && world.rows.length > 0 ? (
                <div className="cc-rows">
                  {world.rows.map((row) => (
                    <div key={row.key} className="cc-row">
                      <span className="cc-row-key">{row.key}</span>
                      <div className="cc-versions">
                        {row.versions.map((v, i) => (
                          <span
                            key={i}
                            className={`cc-version ${v.current ? 'current' : ''} ${v.deleted ? 'tomb' : ''}`}
                            title={`created by ${v.xmin}, ${v.xmax === '—' ? 'live' : `deleted by ${v.xmax}`}`}
                          >
                            <span className="cc-ver-val">{v.deleted ? '⌫ deleted' : fmtVal(v.value)}</span>
                            <span className="cc-ver-meta">{v.xmin}→{v.xmax}</span>
                          </span>
                        ))}
                      </div>
                    </div>
                  ))}
                </div>
              ) : (
                <p className="cc-empty">no rows yet</p>
              )}
            </section>

            <section className="cc-panel">
              <h3 className="cc-panel-title">Locks &amp; conflicts</h3>
              <div className="cc-locks">
                {world && world.locks.length > 0 ? (
                  world.locks.map((l) => (
                    <span key={l.key} className="cc-lock">🔒 {l.key} <em>held by {l.holder}</em></span>
                  ))
                ) : (
                  <span className="cc-empty">no write locks held</span>
                )}
              </div>
              <ConflictGraph txns={txnOrder} world={world} />
            </section>
          </div>
        </div>

        <section className="cc-panel">
          <h3 className="cc-panel-title">Final committed state</h3>
          <div className="cc-final">
            {result.finalRows.length ? (
              result.finalRows.map((r) => (
                <span key={r.key} className="cc-final-cell">
                  <span className="cc-final-key">{r.key}</span>
                  <span className="cc-final-val">{fmtVal(r.value)}</span>
                </span>
              ))
            ) : (
              <span className="cc-empty">empty</span>
            )}
          </div>
          {result.aborts.length > 0 && (
            <div className="cc-aborts">
              {result.aborts.map((a, i) => (
                <span key={i} className="cc-abort">⊘ {a.t} aborted — {a.reason}</span>
              ))}
            </div>
          )}
        </section>

        <p className="cc-lesson"><span className="cc-lesson-tag">takeaway</span> {scenario.lesson}</p>
      </div>
  )
}

// First-appearance order of transaction labels across the trace.
function orderedTxns(steps: TraceStep[]): string[] {
  const seen: string[] = []
  for (const s of steps) if (!seen.includes(s.t)) seen.push(s.t)
  return seen
}

function Timeline({
  steps,
  txnOrder,
  current,
  onPick,
}: {
  steps: TraceStep[]
  txnOrder: string[]
  current: number
  onPick: (i: number) => void
}) {
  return (
    <div className="cc-timeline" style={{ gridTemplateColumns: `2.4rem repeat(${txnOrder.length}, 1fr)` }}>
      <div className="cc-tl-corner" />
      {txnOrder.map((t) => (
        <div key={t} className="cc-tl-head">{t}</div>
      ))}
      {steps.map((s, i) => (
        <Row key={i} s={s} index={i} txnOrder={txnOrder} active={i === current} onPick={onPick} />
      ))}
    </div>
  )
}

function Row({
  s,
  index,
  txnOrder,
  active,
  onPick,
}: {
  s: TraceStep
  index: number
  txnOrder: string[]
  active: boolean
  onPick: (i: number) => void
}) {
  return (
    <>
      <button className={`cc-tl-num ${active ? 'active' : ''}`} onClick={() => onPick(index)}>
        {s.seq + 1}
      </button>
      {txnOrder.map((t) => (
        <button
          key={t}
          className={`cc-tl-cell ${t === s.t ? `filled ${s.status}` : ''} ${active && t === s.t ? 'active' : ''}`}
          onClick={() => onPick(index)}
        >
          {t === s.t ? (
            <>
              <span className="cc-cell-op">{s.op}</span>
              {s.status === 'blocked' && <span className="cc-cell-flag">⏳ {s.blockedOn}</span>}
              {s.status === 'aborted' && <span className="cc-cell-flag abort">⊘</span>}
              {s.status === 'committed' && <span className="cc-cell-flag ok">✓</span>}
              {(s.readValue !== undefined || s.found === false) && s.op.startsWith('read(') && (
                <span className="cc-cell-read">→ {s.found ? fmtVal(s.readValue ?? null) : '∅'}</span>
              )}
              {s.rows && <span className="cc-cell-read">→ {s.rows.length} row(s)</span>}
            </>
          ) : null}
        </button>
      ))}
    </>
  )
}

// A small SVG of the rw-antidependency graph for the current world.
function ConflictGraph({ txns, world }: { txns: string[]; world: WorldSnapshot | undefined }) {
  const edges = world?.rwEdges ?? []
  if (edges.length === 0) return <p className="cc-empty">no rw-antidependencies yet</p>
  const n = txns.length
  const W = Math.max(240, n * 96)
  const H = 110
  const pos = (i: number) => ({
    x: n === 1 ? W / 2 : 40 + (i * (W - 80)) / (n - 1),
    y: H / 2,
  })
  const idx = (t: string) => txns.indexOf(t)
  const hasBack = (from: string, to: string) => edges.some((e) => e.from === to && e.to === from)

  return (
    <svg className="cc-graph" viewBox={`0 0 ${W} ${H}`} width="100%" height={H}>
      <defs>
        <marker id="cc-arrow" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto">
          <path d="M0,0 L7,3 L0,6 Z" fill="var(--amber)" />
        </marker>
      </defs>
      {edges.map((e, i) => {
        const a = pos(idx(e.from))
        const b = pos(idx(e.to))
        const bend = hasBack(e.from, e.to) ? (idx(e.from) < idx(e.to) ? -26 : 26) : -16
        const mx = (a.x + b.x) / 2
        const my = (a.y + b.y) / 2 + bend
        // shorten endpoints so the arrow doesn't dive under the node circle
        const shorten = (p: { x: number; y: number }, c: { x: number; y: number }) => {
          const dx = c.x - p.x, dy = c.y - p.y
          const len = Math.hypot(dx, dy) || 1
          return { x: p.x + (dx / len) * 20, y: p.y + (dy / len) * 20 }
        }
        const start = shorten(a, { x: mx, y: my })
        const end = shorten(b, { x: mx, y: my })
        return (
          <path
            key={i}
            d={`M ${start.x} ${start.y} Q ${mx} ${my} ${end.x} ${end.y}`}
            fill="none"
            stroke="var(--amber)"
            strokeWidth="1.6"
            markerEnd="url(#cc-arrow)"
            opacity="0.85"
          />
        )
      })}
      {txns.map((t, i) => {
        const p = pos(i)
        const aborted = world?.txns.find((x) => x.label === t)?.status === 'aborted'
        return (
          <g key={t}>
            <circle cx={p.x} cy={p.y} r="16" fill={aborted ? 'var(--bg)' : 'var(--bg-2)'} stroke={aborted ? 'var(--red)' : 'var(--accent)'} strokeWidth="1.6" />
            <text x={p.x} y={p.y + 4} textAnchor="middle" fontSize="11" fill="var(--txt)" fontFamily="var(--mono)">{t}</text>
          </g>
        )
      })}
    </svg>
  )
}
