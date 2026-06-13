import { useMemo, useState } from 'react'
import { useAppState } from '../store/store'
import { invoiceTotal, invoiceTax, reportForRange } from '../lib/finance'
import { formatDate, money, todayISO } from '../lib/format'
import { toCSV, downloadText } from '../lib/csv'
import { Button, Card, Field, PageHeader } from '../components/ui'

function startOfYear(): string {
  return `${new Date().getFullYear()}-01-01`
}
function monthsAgo(n: number): string {
  const d = new Date()
  d.setMonth(d.getMonth() - n)
  return d.toISOString().slice(0, 10)
}

const PRESETS: { label: string; from: () => string; to: () => string }[] = [
  { label: 'This year', from: startOfYear, to: todayISO },
  { label: 'Last 12 months', from: () => monthsAgo(12), to: todayISO },
  { label: 'Last 3 months', from: () => monthsAgo(3), to: todayISO },
  { label: 'This month', from: () => todayISO().slice(0, 8) + '01', to: todayISO },
]

export function Reports() {
  const state = useAppState()
  const cur = state.settings.currency
  const [from, setFrom] = useState(startOfYear())
  const [to, setTo] = useState(todayISO())

  const report = useMemo(() => reportForRange(state, from, to), [state, from, to])
  const maxClient = Math.max(1, ...report.byClient.map((c) => c.revenue))
  const maxCat = Math.max(1, ...report.byExpenseCategory.map((c) => c.amount))

  function exportPL() {
    const rows: (string | number)[][] = [
      ['Revenue (paid invoices)', report.revenue.toFixed(2)],
      ['Expenses', report.expenses.toFixed(2)],
      ['Net profit', report.profit.toFixed(2)],
      ['Tax collected', report.taxCollected.toFixed(2)],
      ['Paid invoices', report.paidInvoiceCount],
      ['Billable hours', report.billableHours],
    ]
    downloadText(`solo-pl-${from}_to_${to}.csv`, toCSV(['Metric', 'Value'], rows))
  }

  function exportInvoices() {
    const within = state.invoices
      .filter((inv) => {
        const when = inv.paidAt ? inv.paidAt.slice(0, 10) : inv.issueDate
        return when >= from && when <= to
      })
      .sort((a, b) => a.issueDate.localeCompare(b.issueDate))
    const clientName = (id: string | null) => {
      const c = state.clients.find((x) => x.id === id)
      return c ? c.company || c.name : ''
    }
    const rows = within.map((inv) => [
      inv.number,
      clientName(inv.clientId),
      inv.status,
      inv.issueDate,
      inv.dueDate,
      inv.paidAt ? inv.paidAt.slice(0, 10) : '',
      inv.currency,
      invoiceTax(inv).toFixed(2),
      invoiceTotal(inv).toFixed(2),
    ])
    downloadText(
      `solo-invoices-${from}_to_${to}.csv`,
      toCSV(
        ['Number', 'Client', 'Status', 'Issued', 'Due', 'Paid on', 'Currency', 'Tax', 'Total'],
        rows,
      ),
    )
  }

  function exportExpenses() {
    const within = state.expenses
      .filter((e) => e.date >= from && e.date <= to)
      .sort((a, b) => a.date.localeCompare(b.date))
    const clientName = (id: string | null) => {
      const c = state.clients.find((x) => x.id === id)
      return c ? c.company || c.name : ''
    }
    const rows = within.map((e) => [
      e.date,
      e.vendor,
      e.category,
      clientName(e.clientId),
      e.billable ? 'yes' : 'no',
      e.amount.toFixed(2),
    ])
    downloadText(
      `solo-expenses-${from}_to_${to}.csv`,
      toCSV(['Date', 'Vendor', 'Category', 'Client', 'Billable', 'Amount'], rows),
    )
  }

  return (
    <div className="page">
      <PageHeader
        title="Reports"
        subtitle="Profit & loss, tax summary, and accountant-ready CSV exports."
      />

      <Card className="report-controls">
        <div className="presets">
          {PRESETS.map((p) => {
            const active = from === p.from() && to === p.to()
            return (
              <button
                key={p.label}
                className={`chip ${active ? 'active' : ''}`}
                onClick={() => {
                  setFrom(p.from())
                  setTo(p.to())
                }}
              >
                {p.label}
              </button>
            )
          })}
        </div>
        <div className="range-fields">
          <Field label="From">
            <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
          </Field>
          <Field label="To">
            <input type="date" value={to} onChange={(e) => setTo(e.target.value)} />
          </Field>
        </div>
      </Card>

      <p className="muted small">
        Cash basis · {formatDate(from)} – {formatDate(to)}
      </p>

      <div className="kpi-grid">
        <Card className="kpi kpi-ok">
          <div className="kpi-body">
            <span className="kpi-label">Revenue</span>
            <strong className="kpi-value">{money(report.revenue, cur)}</strong>
            <span className="kpi-sub">{report.paidInvoiceCount} paid invoices</span>
          </div>
        </Card>
        <Card className="kpi">
          <div className="kpi-body">
            <span className="kpi-label">Expenses</span>
            <strong className="kpi-value">{money(report.expenses, cur)}</strong>
            <span className="kpi-sub">in range</span>
          </div>
        </Card>
        <Card className={`kpi ${report.profit >= 0 ? 'kpi-ok' : 'kpi-danger'}`}>
          <div className="kpi-body">
            <span className="kpi-label">Net profit</span>
            <strong className="kpi-value">{money(report.profit, cur)}</strong>
            <span className="kpi-sub">
              {report.revenue > 0
                ? `${Math.round((report.profit / report.revenue) * 100)}% margin`
                : '—'}
            </span>
          </div>
        </Card>
        <Card className="kpi kpi-warn">
          <div className="kpi-body">
            <span className="kpi-label">Tax collected</span>
            <strong className="kpi-value">{money(report.taxCollected, cur)}</strong>
            <span className="kpi-sub">{report.billableHours}h billable</span>
          </div>
        </Card>
      </div>

      <div className="dash-grid">
        <Card>
          <div className="card-head">
            <h3>Revenue by client</h3>
          </div>
          {report.byClient.length === 0 ? (
            <p className="muted pad">No paid revenue in this range.</p>
          ) : (
            <ul className="bar-list">
              {report.byClient.map((c) => (
                <li key={c.id ?? 'none'}>
                  <div className="bar-list-head">
                    <span>{c.name}</span>
                    <strong>{money(c.revenue, cur)}</strong>
                  </div>
                  <div className="bar-track">
                    <div
                      className="bar-fill"
                      style={{ width: `${(c.revenue / maxClient) * 100}%` }}
                    />
                  </div>
                </li>
              ))}
            </ul>
          )}
        </Card>

        <Card>
          <div className="card-head">
            <h3>Expenses by category</h3>
          </div>
          {report.byExpenseCategory.length === 0 ? (
            <p className="muted pad">No expenses in this range.</p>
          ) : (
            <ul className="bar-list">
              {report.byExpenseCategory.map((c) => (
                <li key={c.category}>
                  <div className="bar-list-head">
                    <span>{c.category}</span>
                    <strong>{money(c.amount, cur)}</strong>
                  </div>
                  <div className="bar-track">
                    <div
                      className="bar-fill expense-fill"
                      style={{ width: `${(c.amount / maxCat) * 100}%` }}
                    />
                  </div>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>

      <Card>
        <div className="card-head">
          <h3>Export</h3>
          <span className="muted small">CSV files for your accountant or spreadsheet</span>
        </div>
        <div className="data-actions">
          <Button icon="download" onClick={exportPL}>
            Profit &amp; loss summary
          </Button>
          <Button icon="download" onClick={exportInvoices}>
            Invoices CSV
          </Button>
          <Button icon="download" onClick={exportExpenses}>
            Expenses CSV
          </Button>
        </div>
      </Card>
    </div>
  )
}
