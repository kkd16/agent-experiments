import { useMemo } from 'react'
import { estimateActions, useAppState } from '../store/store'
import { totalsOf } from '../lib/finance'
import { formatDate, money } from '../lib/format'
import { navigate } from '../lib/router'
import { Button, Card, EmptyState, PageHeader, EstimateBadge, IconButton } from '../components/ui'

export function Estimates() {
  const { estimates, clients } = useAppState()

  const clientName = (id: string | null) => {
    const c = clients.find((x) => x.id === id)
    return c ? c.company || c.name : 'No client'
  }

  const rows = useMemo(
    () => [...estimates].sort((a, b) => b.issueDate.localeCompare(a.issueDate)),
    [estimates],
  )

  return (
    <div className="page">
      <PageHeader
        title="Estimates"
        subtitle="Send quotes, win the work, convert to an invoice in one click."
        actions={
          <Button
            variant="primary"
            icon="plus"
            onClick={() => {
              const est = estimateActions.create()
              navigate(`/estimates/${est.id}`)
            }}
          >
            New estimate
          </Button>
        }
      />

      {estimates.length === 0 ? (
        <EmptyState
          icon="estimates"
          title="No estimates yet"
          message="Quote a project before you bill it. Accepted estimates convert straight into invoices."
          action={
            <Button
              variant="primary"
              icon="plus"
              onClick={() => {
                const est = estimateActions.create()
                navigate(`/estimates/${est.id}`)
              }}
            >
              Create estimate
            </Button>
          }
        />
      ) : (
        <Card className="table-card">
          <table className="data-table">
            <thead>
              <tr>
                <th>Estimate</th>
                <th>Client</th>
                <th>Issued</th>
                <th>Valid until</th>
                <th>Status</th>
                <th className="num">Amount</th>
                <th aria-label="actions" />
              </tr>
            </thead>
            <tbody>
              {rows.map((est) => (
                <tr key={est.id} onClick={() => navigate(`/estimates/${est.id}`)}>
                  <td className="mono">{est.number}</td>
                  <td>{clientName(est.clientId)}</td>
                  <td className="muted">{formatDate(est.issueDate)}</td>
                  <td className="muted">{formatDate(est.expiryDate)}</td>
                  <td>
                    <EstimateBadge status={est.status} />
                  </td>
                  <td className="num strong">{money(totalsOf(est).total, est.currency)}</td>
                  <td className="row-actions" onClick={(e) => e.stopPropagation()}>
                    <IconButton
                      icon="print"
                      label="View / PDF"
                      onClick={() => navigate(`/estimates/${est.id}/print`)}
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}
    </div>
  )
}
