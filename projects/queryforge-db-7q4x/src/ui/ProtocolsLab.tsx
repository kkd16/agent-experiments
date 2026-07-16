// Protocols Lab — the concurrency-control head-to-head. Pick a schedule and watch
// the *same* interleaving run through four protocols at once — Strict 2PL, OCC,
// Basic T/O and MVCC — comparing how each one keeps the schedule serializable
// (block vs abort), who commits vs aborts, and which correctness properties each
// buys. A protocol-independent serializability oracle certifies every column.

import { useMemo, useState } from 'react'
import type { Scenario } from '../db/concurrency/scenarios'
import { SCENARIOS } from '../db/concurrency/scenarios'
import { ISOLATION_LEVELS, LEVEL_ABBR, type IsolationLevel, type Val } from '../db/concurrency/mvcc'
import { runAll, generateSchedule, runBenchmark, PROTOCOL_METAS } from '../db/protocols'
import type { ProtocolRunResult, ProtocolStep, TxnOutcome, ProtocolId } from '../db/protocols'

function fmtVal(v: Val): string {
  if (v === null) return '∅'
  if (typeof v === 'string') return `'${v}'`
  return String(v)
}

const FAMILY_LABEL: Record<string, string> = {
  pessimistic: 'pessimistic · locking',
  optimistic: 'optimistic · validation',
  timestamp: 'timestamp order',
  multiversion: 'multi-version',
}

export function ProtocolsLab() {
  const [scenarioId, setScenarioId] = useState(SCENARIOS[0].id)
  const [seed, setSeed] = useState(1)
  const [useRandom, setUseRandom] = useState(false)
  const [mvccLevel, setMvccLevel] = useState<IsolationLevel>('SERIALIZABLE')

  const scenario: Scenario = useMemo(
    () =>
      useRandom
        ? generateSchedule(seed, { txns: 3, keys: 3, opsPerTxn: 5, abortRate: 0.15 })
        : (SCENARIOS.find((s) => s.id === scenarioId) ?? SCENARIOS[0]),
    [useRandom, seed, scenarioId],
  )

  const results = useMemo(() => runAll(scenario, mvccLevel), [scenario, mvccLevel])

  return (
    <div className="pl-lab">
      <aside className="pl-aside">
        <h3 className="cc-aside-title">Schedules</h3>
        <p className="cc-aside-sub">One interleaving, four concurrency-control protocols side by side.</p>
        {SCENARIOS.map((s) => (
          <button
            key={s.id}
            className={`cc-scenario ${!useRandom && s.id === scenarioId ? 'active' : ''}`}
            onClick={() => {
              setUseRandom(false)
              setScenarioId(s.id)
            }}
          >
            <span className="cc-scenario-title">{s.title}</span>
            <span className="cc-scenario-tag">{s.tagline}</span>
          </button>
        ))}
        <button
          className={`cc-scenario pl-random ${useRandom ? 'active' : ''}`}
          onClick={() => {
            setUseRandom(true)
            setSeed((s) => (useRandom ? s + 1 : s))
          }}
        >
          <span className="cc-scenario-title">🎲 Random schedule {useRandom ? `#${seed}` : ''}</span>
          <span className="cc-scenario-tag">{useRandom ? 'click for a fresh interleaving' : 'fuzz the oracle live'}</span>
        </button>
      </aside>

      <div className="pl-main">
        <header className="cc-head">
          <h2 className="cc-title">{scenario.title}</h2>
          {scenario.blurb && <p className="cc-blurb">{scenario.blurb}</p>}
          {scenario.invariant && (
            <p className="cc-invariant">
              <span className="cc-inv-tag">invariant</span> {scenario.invariant}
            </p>
          )}
        </header>

        <ScheduleStrip scenario={scenario} />

        <div className="pl-mvcc-level">
          <span className="pl-mvcc-label">MVCC isolation:</span>
          {ISOLATION_LEVELS.map((lv) => (
            <button
              key={lv}
              className={`pl-lvl ${lv === mvccLevel ? 'active' : ''}`}
              onClick={() => setMvccLevel(lv)}
              title={lv}
            >
              {LEVEL_ABBR[lv]}
            </button>
          ))}
          <span className="pl-mvcc-hint">only the MVCC column re-runs — watch snapshot isolation admit anomalies below SERIALIZABLE</span>
        </div>

        <div className="pl-grid">
          {results.map((r) => (
            <ProtocolCard key={r.protocol} result={r} mvccLevel={mvccLevel} />
          ))}
        </div>

        {!useRandom && scenario.lesson && (
          <p className="cc-lesson">
            <span className="cc-lesson-tag">takeaway</span> {scenario.lesson}
          </p>
        )}
        <GuaranteeMatrix />
        <BenchPanel />
      </div>
    </div>
  )
}

const PROTO_COLOR: Record<ProtocolId, string> = {
  s2pl: 'var(--accent)',
  occ: 'var(--green)',
  to: 'var(--amber)',
  mvcc: 'var(--violet)',
}
const PROTO_SHORT: Record<ProtocolId, string> = { s2pl: 'S2PL', occ: 'OCC', to: 'T/O', mvcc: 'MVCC' }

/** The contention-sweep benchmark, computed lazily when opened. */
function BenchPanel() {
  const [open, setOpen] = useState(false)
  const bench = useMemo(() => (open ? runBenchmark({ seeds: 120 }) : null), [open])
  return (
    <section className="pl-matrix">
      <div className="pl-bench-head">
        <h3 className="cc-panel-title">Contention benchmark</h3>
        <button className="pl-lvl" onClick={() => setOpen((o) => !o)}>
          {open ? 'hide' : 'run ▸'}
        </button>
      </div>
      <p className="pl-matrix-note" style={{ marginTop: 0 }}>
        The same {bench?.config.seeds ?? 120} random schedules run through every protocol as the shared key
        space shrinks (fewer keys ⇒ more transactions fighting over the same rows). Watch the commit rate
        fall — and <i>how</i> each protocol pays: locking blocks and occasionally deadlocks, OCC and T/O burn
        work on aborts.
      </p>
      {bench && (
        <div className="pl-bench">
          <div className="pl-bench-legend">
            {(['s2pl', 'occ', 'to', 'mvcc'] as ProtocolId[]).map((id) => (
              <span key={id} className="pl-bench-key">
                <span className="pl-bench-swatch" style={{ background: PROTO_COLOR[id] }} /> {PROTO_SHORT[id]}
              </span>
            ))}
          </div>
          {bench.points.map((p) => (
            <div key={p.keys} className="pl-bench-row">
              <span className="pl-bench-label">
                {p.keys} key{p.keys === 1 ? '' : 's'}
                <em>{p.keys === 1 ? ' · hottest' : p.keys >= 8 ? ' · coolest' : ''}</em>
              </span>
              <div className="pl-bench-bars">
                {p.stats.map((s) => (
                  <div key={s.protocol} className="pl-bench-bar-wrap" title={`${PROTO_SHORT[s.protocol]}: ${(s.commitRate * 100).toFixed(0)}% commit · ${(s.abortRate * 100).toFixed(0)}% abort${s.deadlocks ? ` · ${s.deadlocks} deadlocks` : ''}${s.validationFails ? ` · ${s.validationFails} valid.fails` : ''}${s.cascades ? ` · ${s.cascades} cascades` : ''}`}>
                    <div className="pl-bench-bar-track">
                      <div
                        className="pl-bench-bar-fill"
                        style={{ height: `${Math.round(s.commitRate * 100)}%`, background: PROTO_COLOR[s.protocol] }}
                      />
                    </div>
                    <span className="pl-bench-pct">{Math.round(s.commitRate * 100)}</span>
                  </div>
                ))}
              </div>
            </div>
          ))}
          <p className="pl-bench-axis">bar height = % of transactions that commit · hover for the abort breakdown</p>
        </div>
      )}
    </section>
  )
}

/** The raw schedule as a compact per-transaction lane strip. */
function ScheduleStrip({ scenario }: { scenario: Scenario }) {
  const txns: string[] = []
  for (const op of scenario.ops) if (!txns.includes(op.t)) txns.push(op.t)
  return (
    <div className="pl-schedule">
      <span className="pl-schedule-title">schedule</span>
      <div className="pl-schedule-ops">
        {scenario.ops.map((op, i) => (
          <span key={i} className={`pl-op txn-${txns.indexOf(op.t) % 6}`}>
            <span className="pl-op-t">{op.t}</span>
            <span className="pl-op-k">
              {op.kind === 'begin'
                ? 'begin'
                : op.kind === 'commit'
                  ? 'commit'
                  : op.kind === 'abort'
                    ? 'abort'
                    : op.kind === 'read'
                      ? `r(${op.key})`
                      : op.kind === 'readWhere'
                        ? `r*(${op.pred?.label})`
                        : op.kind === 'delete'
                          ? `del(${op.key})`
                          : `w(${op.key}=${fmtVal(op.value ?? null)})`}
            </span>
          </span>
        ))}
      </div>
    </div>
  )
}

function ProtocolCard({ result, mvccLevel }: { result: ProtocolRunResult; mvccLevel: IsolationLevel }) {
  const m = result.meta
  const ok = result.serializable
  return (
    <section className={`pl-card ${ok ? 'ser' : 'nonser'}`}>
      <header className="pl-card-head">
        <div className="pl-card-titles">
          <span className="pl-card-name">{m.name}</span>
          <span className="pl-card-family">
            {FAMILY_LABEL[m.family]}
            {m.id === 'mvcc' ? ` · ${LEVEL_ABBR[mvccLevel]}` : ''}
          </span>
        </div>
        <span className="pl-short">{m.short}</span>
      </header>

      <p className="pl-tagline">{m.tagline}</p>

      <div className={`pl-verdict ${ok ? 'ser' : 'nonser'}`}>
        <span className="pl-verdict-mark">{ok ? '✓' : '✕'}</span>
        <span className="pl-verdict-text">
          {ok ? 'conflict-serializable' : 'NOT serializable'}
          {ok && result.order ? <em className="pl-serial"> ≡ {result.order.join(' → ') || '∅'}</em> : null}
          {!ok && result.cycle ? (
            <em className="pl-serial"> cycle {result.cycle.join(' → ')} → {result.cycle[0]}</em>
          ) : null}
        </span>
      </div>

      <div className="pl-metrics">
        <Metric label="committed" v={result.metrics.committed} tone="good" />
        <Metric label="aborts" v={result.metrics.aborts} tone={result.metrics.aborts ? 'warn' : 'mute'} />
        {m.conflictReaction === 'block' && (
          <Metric label="blocks" v={result.metrics.blocks} tone={result.metrics.blocks ? 'info' : 'mute'} />
        )}
        {result.metrics.deadlocks > 0 && <Metric label="deadlocks" v={result.metrics.deadlocks} tone="bad" />}
        {result.metrics.validationFails > 0 && (
          <Metric label="valid.fail" v={result.metrics.validationFails} tone="warn" />
        )}
      </div>

      <div className="pl-outcomes">
        {result.outcomes.map((o) => (
          <OutcomePill key={o.label} o={o} />
        ))}
      </div>

      <Trace steps={result.steps} />

      <div className="pl-final">
        <span className="pl-final-title">final</span>
        {result.committedRows.length ? (
          result.committedRows.map((r) => (
            <span key={r.key} className="pl-final-cell">
              {r.key}=<b>{fmtVal(r.value)}</b>
            </span>
          ))
        ) : (
          <span className="pl-empty">empty</span>
        )}
      </div>

      <div className="pl-guarantees">
        <Guar ok={m.guarantees.serializable} label="serializable" />
        <Guar ok={m.guarantees.recoverable} label="recoverable" />
        <Guar ok={m.guarantees.cascadeless} label="cascadeless" />
        <Guar ok={m.guarantees.deadlockFree} label="deadlock-free" />
      </div>
    </section>
  )
}

function Metric({ label, v, tone }: { label: string; v: number; tone: string }) {
  return (
    <span className={`pl-metric ${tone}`}>
      <b>{v}</b> {label}
    </span>
  )
}

function OutcomePill({ o }: { o: TxnOutcome }) {
  return (
    <span className={`pl-outcome ${o.status}`} title={o.reason ?? o.status}>
      {o.label}
      <span className="pl-outcome-mark">{o.status === 'committed' ? '✓' : o.status === 'aborted' ? '⊘' : '…'}</span>
    </span>
  )
}

function Guar({ ok, label }: { ok: boolean; label: string }) {
  return <span className={`pl-guar ${ok ? 'yes' : 'no'}`}>{ok ? '✓' : '✕'} {label}</span>
}

/** A compact vertical trace of every step, colour-coded by status. */
function Trace({ steps }: { steps: ProtocolStep[] }) {
  return (
    <div className="pl-trace">
      {steps.map((s) => (
        <div key={s.seq} className={`pl-tstep ${s.status}`} title={s.detail}>
          <span className="pl-tstep-t">{s.t}</span>
          <span className="pl-tstep-op">{s.op}</span>
          <span className="pl-tstep-status">
            {s.status === 'blocked'
              ? `⏳ ${s.blockedOn ?? ''}`
              : s.status === 'aborted'
                ? '⊘'
                : s.status === 'committed'
                  ? '✓'
                  : s.status === 'ok' && s.readValue !== undefined
                    ? `= ${fmtVal(s.readValue)}`
                    : ''}
          </span>
        </div>
      ))}
    </div>
  )
}

function GuaranteeMatrix() {
  return (
    <section className="pl-matrix">
      <h3 className="cc-panel-title">The four protocols at a glance</h3>
      <div className="pl-matrix-grid">
        <div className="pl-matrix-row head">
          <span>protocol</span>
          <span>family</span>
          <span>conflict → </span>
          <span>serializable</span>
          <span>recoverable</span>
          <span>cascadeless</span>
          <span>deadlock-free</span>
        </div>
        {PROTOCOL_METAS.map((m) => (
          <div key={m.id} className="pl-matrix-row">
            <span className="pl-matrix-name">{m.short}</span>
            <span>{FAMILY_LABEL[m.family]}</span>
            <span className={m.conflictReaction === 'block' ? 'pl-block' : 'pl-abort'}>{m.conflictReaction}</span>
            <Cell ok={m.guarantees.serializable} />
            <Cell ok={m.guarantees.recoverable} />
            <Cell ok={m.guarantees.cascadeless} />
            <Cell ok={m.guarantees.deadlockFree} />
          </div>
        ))}
      </div>
      <p className="pl-matrix-note">
        Every protocol here admits only <b>conflict-serializable</b> committed histories — verified live by an
        independent precedence-graph oracle — yet they differ sharply in <i>how</i>: locking blocks (and can
        deadlock), optimistic and timestamp ordering abort. Basic T/O is the outlier that gives up recoverability,
        so it must cascade-abort when a dirty read’s writer rolls back.
      </p>
    </section>
  )
}

function Cell({ ok }: { ok: boolean }) {
  return <span className={ok ? 'pl-cell-yes' : 'pl-cell-no'}>{ok ? '✓' : '✕'}</span>
}
