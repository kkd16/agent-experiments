// Recovery Lab — an interactive view over the ARIES write-ahead-logging engine.
// Pick a crash scenario; the lab plays its workload against a live database, pulls
// the plug at the crash, then runs the three recovery passes — letting you scrub
// step-by-step through the durable log, the disk/buffer page images (with their
// pageLSNs), the rebuilt transaction & dirty-page tables, and a correctness verdict
// that compares what ARIES recovered against the one provably-correct outcome.

import { useEffect, useMemo, useRef, useState } from 'react'
import { fmtCell, type LogRecord } from '../db/recovery/wal'
import { runScenario, type RecStep, type RecWorld, type Phase } from '../db/recovery/runner'
import { REC_SCENARIOS, recScenarioById, type Highlight, type RecScenario } from '../db/recovery/scenarios'

const PHASES: { id: Phase; label: string }[] = [
  { id: 'run', label: 'Normal operation' },
  { id: 'crash', label: 'Crash' },
  { id: 'analysis', label: 'Analysis' },
  { id: 'redo', label: 'Redo' },
  { id: 'undo', label: 'Undo' },
  { id: 'done', label: 'Recovered' },
]

const HIGHLIGHT_LABEL: Record<Highlight, string> = {
  redo: 'REDO',
  undo: 'UNDO',
  both: 'REDO + UNDO',
  checkpoint: 'CHECKPOINT',
  idempotence: 'RESTARTABLE',
}

const TYPE_ABBR: Record<LogRecord['type'], string> = {
  begin: 'BEGIN',
  update: 'UPD',
  commit: 'COMMIT',
  abort: 'ABORT',
  clr: 'CLR',
  end: 'END',
  begin_checkpoint: 'BEGIN-CKPT',
  end_checkpoint: 'END-CKPT',
}

export function RecoveryLab() {
  const [scenarioId, setScenarioId] = useState(REC_SCENARIOS[0].id)
  const scenario = useMemo(() => recScenarioById(scenarioId), [scenarioId])

  return (
    <div className="cc-lab">
      <aside className="cc-scenarios">
        <h3 className="cc-aside-title">Crash scenarios</h3>
        <p className="cc-aside-sub">Each runs a workload, crashes, then recovers with ARIES.</p>
        {REC_SCENARIOS.map((s) => (
          <button
            key={s.id}
            className={`cc-scenario ${s.id === scenarioId ? 'active' : ''}`}
            onClick={() => setScenarioId(s.id)}
          >
            <span className="cc-scenario-title">{s.title}</span>
            <span className="cc-scenario-tag">{s.tagline}</span>
            <span className="cc-scenario-pills">
              <span className={`rl-badge ${s.highlight}`}>{HIGHLIGHT_LABEL[s.highlight]}</span>
            </span>
          </button>
        ))}
      </aside>

      {/* Remount on scenario change so step state resets cleanly. */}
      <LabRun key={scenarioId} scenario={scenario} />
    </div>
  )
}

function LabRun({ scenario }: { scenario: RecScenario }) {
  const result = useMemo(() => runScenario(scenario), [scenario])
  const steps = result.steps
  const lastStep = Math.max(0, steps.length - 1)
  const [step, setStep] = useState(0)
  const [playing, setPlaying] = useState(false)

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
    }, 950)
    return () => {
      if (timer.current !== null) window.clearInterval(timer.current)
    }
  }, [playing, lastStep])

  const cur = steps[Math.min(step, lastStep)]
  const world: RecWorld = cur.world

  const play = () => {
    if (step >= lastStep) setStep(0)
    setPlaying(true)
  }

  return (
    <div className="cc-main">
      <header className="cc-head">
        <h2 className="cc-title">{scenario.title}</h2>
        <p className="cc-blurb">{scenario.blurb}</p>
      </header>

      <PhaseRail current={world.phase} />

      <div className={`cc-verdict ${result.verdictKind === 'consistent' ? 'serializable' : 'anomaly'}`}>
        <span className="cc-verdict-mark">{result.verdictKind === 'consistent' ? '✓' : '✕'}</span>
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

      <div className={`cc-narration ${narrClass(cur)}`}>
        <span className="cc-narr-step">#{cur.seq + 1}</span>
        <span className={`rl-phase-tag ${cur.phase}`}>{cur.phase}</span>
        <span className="cc-narr-op">{cur.title}</span>
        <span className="cc-narr-detail">{cur.detail}</span>
      </div>

      <div className="rl-grid">
        <section className="cc-panel rl-log-panel">
          <h3 className="cc-panel-title">
            Write-ahead log <span className="cc-panel-hint">(durable · volatile · recovery-written)</span>
          </h3>
          <LogView world={world} />
        </section>

        <div className="rl-rightcol">
          <section className="cc-panel">
            <h3 className="cc-panel-title">
              Pages <span className="cc-panel-hint">(disk · buffer · pageLSN)</span>
            </h3>
            <PageView world={world} />
          </section>

          <section className="cc-panel">
            <h3 className="cc-panel-title">Transaction table</h3>
            <TxnTableView world={world} />
          </section>

          <section className="cc-panel">
            <h3 className="cc-panel-title">
              Dirty-page table {world.redoLsn ? <span className="cc-panel-hint">RedoLSN = {world.redoLsn}</span> : null}
            </h3>
            <DptView world={world} />
          </section>
        </div>
      </div>

      <section className="cc-panel">
        <h3 className="cc-panel-title">Recovered state vs. the one correct outcome</h3>
        <div className="rl-truth">
          {result.truth.map((t) => {
            const got = result.recovered.find((r) => r.page === t.page)
            const ok = got && got.value === t.value
            return (
              <span key={t.page} className={`rl-truth-cell ${ok ? 'ok' : 'bad'}`}>
                <span className="rl-truth-key">{t.page}</span>
                <span className="rl-truth-val">{fmtCell(t.value)}</span>
                {!ok && <span className="rl-truth-got">got {got ? fmtCell(got.value) : '∅'}</span>}
              </span>
            )
          })}
          <span className="rl-truth-meta">
            winners {result.winners.length ? result.winners.join(', ') : '—'} · losers{' '}
            {result.losers.length ? result.losers.join(', ') : '—'}
          </span>
        </div>
      </section>

      <p className="cc-lesson"><span className="cc-lesson-tag">takeaway</span> {scenario.lesson}</p>
    </div>
  )
}

function narrClass(step: RecStep): string {
  if (step.phase === 'crash') return 'aborted'
  if (step.phase === 'done') return 'committed'
  if (step.title.startsWith('redo ') || step.title.startsWith('undo ')) return 'ok'
  return 'begin'
}

function PhaseRail({ current }: { current: Phase }) {
  const reached = (id: Phase) => PHASES.findIndex((p) => p.id === id) <= PHASES.findIndex((p) => p.id === current)
  return (
    <div className="rl-rail">
      {PHASES.map((p, i) => (
        <div key={p.id} className="rl-rail-item">
          <span className={`rl-rail-dot ${p.id === current ? 'active' : reached(p.id) ? 'done' : ''} ${p.id}`}>
            {i + 1}
          </span>
          <span className={`rl-rail-label ${p.id === current ? 'active' : ''}`}>{p.label}</span>
        </div>
      ))}
    </div>
  )
}

function LogView({ world }: { world: RecWorld }) {
  if (world.log.length === 0) return <p className="cc-empty">the log is empty</p>
  return (
    <div className="rl-log">
      <div className="rl-log-head">
        <span>LSN</span>
        <span>type</span>
        <span>txn</span>
        <span>page</span>
        <span>before → after</span>
        <span>prev / undoNext</span>
      </div>
      {world.log.map((row) => {
        const r = row.rec
        const ba =
          r.type === 'update' || r.type === 'clr' ? `${fmtCell(r.before)} → ${fmtCell(r.after)}` : ''
        const links =
          r.type === 'clr'
            ? `prev ${r.prevLsn || '—'} · undoNext ${r.undoNextLsn || 'done'}`
            : 'prevLsn' in r && r.prevLsn
              ? `prev ${r.prevLsn}`
              : ''
        const cls = [
          'rl-log-row',
          row.generated ? 'generated' : row.durable ? 'durable' : 'volatile',
          world.highlightLsn === r.lsn ? 'current' : '',
          r.type,
        ].join(' ')
        return (
          <div key={r.lsn} className={cls}>
            <span className="rl-log-lsn">{r.lsn}</span>
            <span className={`rl-log-type ${r.type}`}>{TYPE_ABBR[r.type]}</span>
            <span className="rl-log-txn">{r.txn || '—'}</span>
            <span className="rl-log-page">{r.type === 'update' || r.type === 'clr' ? r.page : ''}</span>
            <span className="rl-log-ba">{ba}</span>
            <span className="rl-log-links">{links}</span>
          </div>
        )
      })}
    </div>
  )
}

function PageView({ world }: { world: RecWorld }) {
  if (world.pages.length === 0) return <p className="cc-empty">no pages</p>
  const showBuffer = world.pages.some((p) => p.buffer)
  return (
    <div className="rl-pages">
      {world.pages.map((p) => {
        const stolen = p.buffer && p.dirty && p.disk.pageLSN === p.buffer.pageLSN
        return (
          <div key={p.page} className={`rl-page ${p.dirty ? 'dirty' : ''}`}>
            <span className="rl-page-id">{p.page}</span>
            <span className="rl-page-slot">
              <span className="rl-page-label">disk</span>
              <span className="rl-page-val">{fmtCell(p.disk.value)}</span>
              <span className="rl-page-lsn">pLSN {p.disk.pageLSN}</span>
            </span>
            {showBuffer && (
              <span className="rl-page-slot buffer">
                <span className="rl-page-label">buf</span>
                {p.buffer ? (
                  <>
                    <span className="rl-page-val">{fmtCell(p.buffer.value)}</span>
                    <span className="rl-page-lsn">pLSN {p.buffer.pageLSN}</span>
                  </>
                ) : (
                  <span className="rl-page-val muted">—</span>
                )}
              </span>
            )}
            {p.dirty && <span className="rl-chip dirty">dirty</span>}
            {stolen && <span className="rl-chip steal">stolen</span>}
          </div>
        )
      })}
    </div>
  )
}

function TxnTableView({ world }: { world: RecWorld }) {
  if (world.txnTable.length === 0) return <p className="cc-empty">no live transactions</p>
  return (
    <div className="rl-tt">
      {world.txnTable.map((t) => (
        <div key={t.txn} className={`rl-tt-row ${t.status}`}>
          <span className="rl-tt-txn">{t.txn}</span>
          <span className={`rl-tt-status ${t.status}`}>{t.status}</span>
          <span className="rl-tt-lsn">last {t.lastLsn}</span>
          {t.loser && <span className="rl-chip loser">loser</span>}
          {t.status === 'committed' && <span className="rl-chip winner">winner</span>}
        </div>
      ))}
    </div>
  )
}

function DptView({ world }: { world: RecWorld }) {
  if (world.dpt.length === 0) return <p className="cc-empty">no dirty pages</p>
  return (
    <div className="rl-dpt">
      {world.dpt.map((d) => (
        <span key={d.page} className="rl-dpt-cell">
          <span className="rl-dpt-page">{d.page}</span>
          <span className="rl-dpt-lsn">recLSN {d.recLsn}</span>
        </span>
      ))}
    </div>
  )
}
