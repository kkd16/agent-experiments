import { useEffect, useMemo, useRef, useState } from 'react'
import { timeActions, useAppState } from '../store/store'
import { clampNumber, formatDuration, hours, money, todayISO } from '../lib/format'
import { Button, Card, EmptyState, PageHeader, IconButton } from '../components/ui'
import { Icon } from '../components/Icon'

export function Time() {
  const { time, clients, settings } = useAppState()

  // Live timer state (ephemeral — not persisted until stopped).
  const [running, setRunning] = useState(false)
  const [startedAt, setStartedAt] = useState<number | null>(null)
  const [elapsed, setElapsed] = useState(0)
  const [clientId, setClientId] = useState<string>(clients[0]?.id ?? '')
  const [project, setProject] = useState('')
  const [description, setDescription] = useState('')
  const tickRef = useRef<number | null>(null)

  useEffect(() => {
    if (running && startedAt != null) {
      tickRef.current = window.setInterval(() => {
        setElapsed(Math.floor((Date.now() - startedAt) / 1000))
      }, 250)
      return () => {
        if (tickRef.current) window.clearInterval(tickRef.current)
      }
    }
  }, [running, startedAt])

  const activeClient = clients.find((c) => c.id === clientId)
  const liveRate = activeClient?.rate ?? 0

  function start() {
    setStartedAt(Date.now())
    setElapsed(0)
    setRunning(true)
  }
  function stop() {
    setRunning(false)
    if (elapsed > 0) {
      timeActions.add({
        clientId: clientId || null,
        project: project.trim(),
        description: description.trim(),
        seconds: elapsed,
        rate: liveRate,
        billable: true,
        date: todayISO(),
      })
    }
    setElapsed(0)
    setStartedAt(null)
    setProject('')
    setDescription('')
  }

  const sorted = useMemo(
    () => [...time].sort((a, b) => b.date.localeCompare(a.date)),
    [time],
  )

  const totals = useMemo(() => {
    let billableSec = 0
    let unbilledValue = 0
    let totalSec = 0
    for (const t of time) {
      totalSec += t.seconds
      if (t.billable) {
        billableSec += t.seconds
        if (!t.invoicedIn) unbilledValue += hours(t.seconds) * t.rate
      }
    }
    return { billableSec, unbilledValue, totalSec }
  }, [time])

  return (
    <div className="page">
      <PageHeader title="Time tracking" subtitle="Track billable hours and turn them into invoices." />

      <Card className={`timer-card ${running ? 'running' : ''}`}>
        <div className="timer-display">
          <span className="timer-time">{formatDuration(elapsed)}</span>
          {running && liveRate > 0 && (
            <span className="timer-earnings">
              {money(hours(elapsed) * liveRate, activeClient?.currency ?? settings.currency)}
            </span>
          )}
        </div>
        <div className="timer-fields">
          <select value={clientId} onChange={(e) => setClientId(e.target.value)}>
            <option value="">No client</option>
            {clients.map((c) => (
              <option key={c.id} value={c.id}>
                {c.company || c.name}
              </option>
            ))}
          </select>
          <input
            placeholder="Project"
            value={project}
            onChange={(e) => setProject(e.target.value)}
          />
          <input
            placeholder="What are you working on?"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
          />
        </div>
        {running ? (
          <Button variant="danger" icon="stop" onClick={stop}>
            Stop
          </Button>
        ) : (
          <Button variant="primary" icon="play" onClick={start}>
            Start
          </Button>
        )}
      </Card>

      <div className="time-totals">
        <Card className="mini-kpi">
          <span className="muted">Total tracked</span>
          <strong>{formatDuration(totals.totalSec)}</strong>
        </Card>
        <Card className="mini-kpi">
          <span className="muted">Billable</span>
          <strong>{formatDuration(totals.billableSec)}</strong>
        </Card>
        <Card className="mini-kpi">
          <span className="muted">Unbilled value</span>
          <strong>{money(totals.unbilledValue, settings.currency)}</strong>
        </Card>
      </div>

      <Card>
        <div className="card-head">
          <h3>Entries</h3>
          <Button
            variant="ghost"
            icon="plus"
            onClick={() => timeActions.add({ clientId: clientId || null, seconds: 3600 })}
          >
            Add manual entry
          </Button>
        </div>
        {sorted.length === 0 ? (
          <EmptyState
            icon="time"
            title="No time logged yet"
            message="Start the timer above or add a manual entry."
          />
        ) : (
          <table className="data-table time-table">
            <thead>
              <tr>
                <th>Date</th>
                <th>Client</th>
                <th>Project / description</th>
                <th className="num">Hours</th>
                <th className="num">Rate</th>
                <th>Billable</th>
                <th className="num">Value</th>
                <th aria-label="actions" />
              </tr>
            </thead>
            <tbody>
              {sorted.map((t) => (
                <tr key={t.id} className={t.invoicedIn ? 'billed' : ''}>
                  <td>
                    <input
                      type="date"
                      className="ghost-input"
                      value={t.date}
                      onChange={(e) => timeActions.patch(t.id, { date: e.target.value })}
                    />
                  </td>
                  <td>
                    <select
                      className="ghost-input"
                      value={t.clientId ?? ''}
                      onChange={(e) => timeActions.patch(t.id, { clientId: e.target.value || null })}
                    >
                      <option value="">No client</option>
                      {clients.map((c) => (
                        <option key={c.id} value={c.id}>
                          {c.company || c.name}
                        </option>
                      ))}
                    </select>
                  </td>
                  <td>
                    <input
                      className="ghost-input"
                      value={t.description || t.project}
                      placeholder="Description"
                      onChange={(e) => timeActions.patch(t.id, { description: e.target.value })}
                    />
                  </td>
                  <td className="num">
                    <input
                      type="number"
                      className="num-input"
                      value={Math.round(hours(t.seconds) * 100) / 100}
                      onChange={(e) =>
                        timeActions.patch(t.id, { seconds: Math.round(clampNumber(e.target.value) * 3600) })
                      }
                    />
                  </td>
                  <td className="num">
                    <input
                      type="number"
                      className="num-input"
                      value={t.rate}
                      onChange={(e) => timeActions.patch(t.id, { rate: clampNumber(e.target.value) })}
                    />
                  </td>
                  <td>
                    <input
                      type="checkbox"
                      checked={t.billable}
                      disabled={!!t.invoicedIn}
                      onChange={(e) => timeActions.patch(t.id, { billable: e.target.checked })}
                    />
                  </td>
                  <td className="num strong">
                    {t.billable ? money(hours(t.seconds) * t.rate, settings.currency) : '—'}
                    {t.invoicedIn && <span className="billed-tag">billed</span>}
                  </td>
                  <td>
                    <IconButton
                      icon="trash"
                      label="Delete entry"
                      onClick={() => timeActions.remove(t.id)}
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {sorted.some((t) => !t.invoicedIn && t.billable) && (
          <p className="muted small pad">
            <Icon name="invoices" size={13} /> Open an invoice for a client to pull their unbilled
            hours in automatically.
          </p>
        )}
      </Card>
    </div>
  )
}
