// The Proof Lab panel — the house style. It runs the real engine in a worker, checks the
// invariants (determinism, mesh, hydrology, climate, the circulation physics, the Ages), and
// lays the results out as a green/red board with the measured numbers. A synchronous fallback
// covers environments without workers.

import { useEffect, useRef, useState } from 'react'
import type { ReactElement } from 'react'
import type { ProofReport } from '../core/proofs'
import { runProofs } from '../core/proofs'

interface Props {
  onClose: () => void
}

export default function ProofLab({ onClose }: Props): ReactElement {
  const [report, setReport] = useState<ProofReport | null>(null)
  const [error, setError] = useState<string | null>(null)
  const startedRef = useRef(false)

  useEffect(() => {
    if (startedRef.current) return
    startedRef.current = true
    let cancelled = false
    let resolved = false
    let worker: Worker | null = null

    const runSync = (): void => {
      // Defer so the "running…" state paints before the (blocking) work begins.
      setTimeout(() => {
        if (cancelled || resolved) return
        try {
          const r = runProofs()
          if (!cancelled) {
            resolved = true
            setReport(r)
          }
        } catch (err) {
          if (!cancelled) setError(String(err))
        }
      }, 30)
    }

    let wd = 0
    try {
      worker = new Worker(new URL('../core/proofs.worker.ts', import.meta.url), { type: 'module' })
      worker.onmessage = (e: MessageEvent<{ report?: ProofReport; error?: string }>) => {
        if (cancelled) return
        resolved = true
        if (e.data.report) setReport(e.data.report)
        else if (e.data.error) setError(e.data.error)
      }
      worker.onerror = () => {
        if (!cancelled && !resolved) runSync()
      }
      worker.postMessage({ run: true })
      // Watchdog: if the worker is silently blocked, fall back to sync.
      wd = window.setTimeout(() => {
        if (!cancelled && !resolved) runSync()
      }, 6000)
    } catch {
      runSync()
    }

    return () => {
      cancelled = true
      if (wd) clearTimeout(wd)
      worker?.terminate()
    }
  }, [])

  const allPass = report ? report.passed === report.total : false

  return (
    <div className="prooflab">
      <div className="proof-head">
        <div>
          <span className="proof-title">Proof Lab</span>
          <span className="proof-sub">every invariant, checked live on the real engine</span>
        </div>
        <button className="insp-close" onClick={onClose} aria-label="Close proof lab">
          ×
        </button>
      </div>

      <div className="proof-status">
        {!report && !error && <span className="proof-running">running the battery…</span>}
        {error && <span className="proof-err">error: {error}</span>}
        {report && (
          <span className={`proof-score ${allPass ? 'ok' : 'bad'}`}>
            {report.passed} / {report.total} checks passed
            <span className="proof-ms"> · {Math.round(report.ms)} ms</span>
          </span>
        )}
      </div>

      <div className="proof-body">
        {report &&
          report.sections.map((s) => (
            <div key={s.title} className="proof-section">
              <div className="proof-section-title">{s.title}</div>
              {s.checks.map((c) => (
                <div key={c.name} className={`proof-check ${c.pass ? 'pass' : 'fail'}`}>
                  <span className="proof-mark">{c.pass ? '✓' : '✕'}</span>
                  <span className="proof-name">{c.name}</span>
                  <span className="proof-detail">{c.detail}</span>
                </div>
              ))}
            </div>
          ))}
      </div>
    </div>
  )
}
