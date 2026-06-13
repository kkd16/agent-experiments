import { useMemo, useState } from 'react'
import { invoiceActions, useAppState } from '../store/store'
import { effectiveStatus, invoiceTotal, recurringDueCount } from '../lib/finance'
import { formatDate, money, todayISO } from '../lib/format'
import { navigate } from '../lib/router'
import { Button, Card, EmptyState, PageHeader, StatusBadge, IconButton } from '../components/ui'
import type { InvoiceStatus } from '../types'

const FILTERS: { key: InvoiceStatus | 'all'; label: string }[] = [
  { key: 'all', label: 'All' },
  { key: 'draft', label: 'Draft' },
  { key: 'sent', label: 'Sent' },
  { key: 'overdue', label: 'Overdue' },
  { key: 'paid', label: 'Paid' },
]

export function Invoices() {
  const state = useAppState()
  const { invoices, clients } = state
  const [filter, setFilter] = useState<InvoiceStatus | 'all'>('all')
  const dueRecurring = recurringDueCount(state, todayISO())

  const clientName = (id: string | null) => {
    const c = clients.find((x) => x.id === id)
    return c ? c.company || c.name : 'No client'
  }

  const rows = useMemo(() => {
    return [...invoices]
      .map((inv) => ({ inv, status: effectiveStatus(inv), total: invoiceTotal(inv) }))
      .filter((r) => filter === 'all' || r.status === filter)
      .sort((a, b) => b.inv.issueDate.localeCompare(a.inv.issueDate))
  }, [invoices, filter])

  const counts = useMemo(() => {
    const c: Record<string, number> = { all: invoices.length }
    for (const inv of invoices) {
      const s = effectiveStatus(inv)
      c[s] = (c[s] ?? 0) + 1
    }
    return c
  }, [invoices])

  return (
    <div className="page">
      <PageHeader
        title="Invoices"
        subtitle="Create, send, and track payment."
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

      {dueRecurring > 0 && (
        <Card className="nudge">
          <div>
            <strong>
              {dueRecurring} recurring {dueRecurring === 1 ? 'invoice is' : 'invoices are'} due to
              generate.
            </strong>
            <span className="muted"> New drafts will be created from your retainer templates.</span>
          </div>
          <Button
            variant="primary"
            icon="copy"
            onClick={() => invoiceActions.runRecurring()}
          >
            Generate now
          </Button>
        </Card>
      )}

      {invoices.length === 0 ? (
        <EmptyState
          icon="invoices"
          title="No invoices yet"
          message="Create a professional invoice in seconds and export it as a PDF."
          action={
            <Button
              variant="primary"
              icon="plus"
              onClick={() => {
                const inv = invoiceActions.create()
                navigate(`/invoices/${inv.id}`)
              }}
            >
              Create invoice
            </Button>
          }
        />
      ) : (
        <>
          <div className="tabs">
            {FILTERS.map((f) => (
              <button
                key={f.key}
                className={`tab ${filter === f.key ? 'active' : ''}`}
                onClick={() => setFilter(f.key)}
              >
                {f.label}
                <span className="tab-count">{counts[f.key] ?? 0}</span>
              </button>
            ))}
          </div>

          <Card className="table-card">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Invoice</th>
                  <th>Client</th>
                  <th>Issued</th>
                  <th>Due</th>
                  <th>Status</th>
                  <th className="num">Amount</th>
                  <th aria-label="actions" />
                </tr>
              </thead>
              <tbody>
                {rows.map(({ inv, status, total }) => (
                  <tr key={inv.id} onClick={() => navigate(`/invoices/${inv.id}`)}>
                    <td className="mono">
                      {inv.number}
                      {inv.recurring !== 'none' && (
                        <span className="recur-tag" title={`Recurring ${inv.recurring}`}>
                          ↻ {inv.recurring}
                        </span>
                      )}
                    </td>
                    <td>{clientName(inv.clientId)}</td>
                    <td className="muted">{formatDate(inv.issueDate)}</td>
                    <td className="muted">{formatDate(inv.dueDate)}</td>
                    <td>
                      <StatusBadge status={status} />
                    </td>
                    <td className="num strong">{money(total, inv.currency)}</td>
                    <td className="row-actions" onClick={(e) => e.stopPropagation()}>
                      <IconButton
                        icon="print"
                        label="View / PDF"
                        onClick={() => navigate(`/invoices/${inv.id}/print`)}
                      />
                      <IconButton
                        icon="copy"
                        label="Duplicate"
                        onClick={() => {
                          const copy = invoiceActions.duplicate(inv.id)
                          if (copy) navigate(`/invoices/${copy.id}`)
                        }}
                      />
                    </td>
                  </tr>
                ))}
                {rows.length === 0 && (
                  <tr className="no-hover">
                    <td colSpan={7} className="muted pad center">
                      No {filter} invoices.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </Card>
        </>
      )}
    </div>
  )
}
