import { useMemo } from 'react'
import { useAppState, invoiceActions } from '../store/store'
import { computeMetrics, effectiveStatus, invoiceTotal } from '../lib/finance'
import { formatDate, money, formatDuration } from '../lib/format'
import { navigate } from '../lib/router'
import { PageHeader, Card, Button, StatusBadge } from '../components/ui'
import { BarChart, DonutChart } from '../components/Charts'
import { Icon } from '../components/Icon'
import type { IconName } from '../components/Icon'

function KPI({
  label,
  value,
  icon,
  tone = 'default',
  sub,
}: {
  label: string
  value: string
  icon: IconName
  tone?: 'default' | 'ok' | 'warn' | 'danger'
  sub?: string
}) {
  return (
    <Card className={`kpi kpi-${tone}`}>
      <div className="kpi-icon">
        <Icon name={icon} size={18} />
      </div>
      <div className="kpi-body">
        <span className="kpi-label">{label}</span>
        <strong className="kpi-value">{value}</strong>
        {sub && <span className="kpi-sub">{sub}</span>}
      </div>
    </Card>
  )
}

export function Dashboard() {
  const state = useAppState()
  const { settings, invoices, clients } = state
  const cur = settings.currency
  const m = useMemo(() => computeMetrics(state), [state])

  const momChange =
    m.lastMonthRevenue > 0
      ? Math.round(((m.thisMonthRevenue - m.lastMonthRevenue) / m.lastMonthRevenue) * 100)
      : null

  const clientName = (id: string | null) =>
    clients.find((c) => c.id === id)?.company ||
    clients.find((c) => c.id === id)?.name ||
    'No client'

  const recent = [...invoices]
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .slice(0, 6)

  // Top clients by paid revenue.
  const topClients = useMemo(() => {
    const totals = new Map<string, number>()
    for (const inv of invoices) {
      if (inv.status === 'paid' && inv.clientId) {
        totals.set(inv.clientId, (totals.get(inv.clientId) ?? 0) + invoiceTotal(inv))
      }
    }
    return [...totals.entries()]
      .map(([id, value]) => {
        const c = clients.find((x) => x.id === id)
        return { id, value, name: c?.company || c?.name || 'No client' }
      })
      .sort((a, b) => b.value - a.value)
      .slice(0, 4)
  }, [invoices, clients])

  const maxTop = Math.max(1, ...topClients.map((t) => t.value))

  return (
    <div className="page">
      <PageHeader
        title="Dashboard"
        subtitle="A live view of your freelance business."
        actions={
          <Button
            variant="primary"
            icon="plus"
            onClick={() => {
              const inv = invoiceActions.create()
              navigate(`/invoices/${inv.id}`)
            }}
          >
            New invoice
          </Button>
        }
      />

      <div className="kpi-grid">
        <KPI
          label="Paid revenue"
          value={money(m.paidRevenue, cur)}
          icon="check"
          tone="ok"
          sub="All time"
        />
        <KPI
          label="Outstanding"
          value={money(m.outstanding, cur)}
          icon="send"
          tone={m.overdueValue > 0 ? 'warn' : 'default'}
          sub={m.overdueValue > 0 ? `${money(m.overdueValue, cur)} overdue` : 'Awaiting payment'}
        />
        <KPI
          label="Net profit"
          value={money(m.netProfit, cur)}
          icon="dashboard"
          tone={m.netProfit >= 0 ? 'default' : 'danger'}
          sub={`${money(m.expensesTotal, cur)} expenses`}
        />
        <KPI
          label="Unbilled time"
          value={money(m.unbilledValue, cur)}
          icon="time"
          sub={`${formatDuration(m.unbilledSeconds)} tracked`}
        />
      </div>

      <div className="dash-grid">
        <Card className="chart-card">
          <div className="card-head">
            <div>
              <h3>Revenue</h3>
              <span className="muted">Paid invoices, last 6 months</span>
            </div>
            <div className="this-month">
              <strong>{money(m.thisMonthRevenue, cur)}</strong>
              <span className={momChange == null ? 'muted' : momChange >= 0 ? 'up' : 'down'}>
                {momChange == null
                  ? 'this month'
                  : `${momChange >= 0 ? '▲' : '▼'} ${Math.abs(momChange)}% vs last month`}
              </span>
            </div>
          </div>
          <BarChart data={m.revenueByMonth} currency={cur} />
        </Card>

        <Card className="status-card">
          <div className="card-head">
            <h3>Invoice status</h3>
          </div>
          <div className="status-row">
            <DonutChart
              segments={m.statusMix.map((s) => ({ key: s.status, label: s.status, value: s.count }))}
            />
            <ul className="legend">
              {m.statusMix.map((s) => (
                <li key={s.status}>
                  <span className={`dot dot-${s.status}`} />
                  <span className="legend-label">{s.status}</span>
                  <span className="legend-value">{money(s.value, cur)}</span>
                </li>
              ))}
            </ul>
          </div>
        </Card>
      </div>

      <div className="dash-grid">
        <Card>
          <div className="card-head">
            <h3>Recent invoices</h3>
            <Button variant="ghost" onClick={() => navigate('/invoices')}>
              View all
            </Button>
          </div>
          {recent.length === 0 ? (
            <p className="muted pad">No invoices yet — create your first one.</p>
          ) : (
            <table className="mini-table">
              <tbody>
                {recent.map((inv) => (
                  <tr key={inv.id} onClick={() => navigate(`/invoices/${inv.id}`)}>
                    <td className="mono">{inv.number}</td>
                    <td>{clientName(inv.clientId)}</td>
                    <td className="muted">{formatDate(inv.issueDate)}</td>
                    <td>
                      <StatusBadge status={effectiveStatus(inv)} />
                    </td>
                    <td className="num strong">{money(invoiceTotal(inv), inv.currency)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Card>

        <Card>
          <div className="card-head">
            <h3>Top clients</h3>
            <Button variant="ghost" onClick={() => navigate('/clients')}>
              Manage
            </Button>
          </div>
          {topClients.length === 0 ? (
            <p className="muted pad">No paid invoices yet.</p>
          ) : (
            <ul className="bar-list">
              {topClients.map((t) => (
                <li key={t.id}>
                  <div className="bar-list-head">
                    <span>{t.name}</span>
                    <strong>{money(t.value, cur)}</strong>
                  </div>
                  <div className="bar-track">
                    <div className="bar-fill" style={{ width: `${(t.value / maxTop) * 100}%` }} />
                  </div>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>

      {m.unbilledValue > 0 && (
        <Card className="nudge">
          <div>
            <strong>You have {money(m.unbilledValue, cur)} of unbilled time.</strong>
            <span className="muted"> Turn tracked hours into a paid invoice.</span>
          </div>
          <Button
            variant="primary"
            icon="invoices"
            onClick={() => {
              const inv = invoiceActions.create()
              navigate(`/invoices/${inv.id}`)
            }}
          >
            Create invoice
          </Button>
        </Card>
      )}
    </div>
  )
}
