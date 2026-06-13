import { useAppState } from '../store/store'
import { itemTotal, totalsOf } from '../lib/finance'
import { formatDate, money } from '../lib/format'
import { navigate } from '../lib/router'
import { Button } from '../components/ui'
import { Icon } from '../components/Icon'

export function EstimatePrint({ id }: { id: string }) {
  const { estimates, clients, settings } = useAppState()
  const est = estimates.find((e) => e.id === id)

  if (!est) {
    return (
      <div className="print-shell">
        <p>Estimate not found.</p>
        <Button onClick={() => navigate('/estimates')}>Back</Button>
      </div>
    )
  }

  const client = clients.find((c) => c.id === est.clientId)
  const co = settings.company
  const { subtotal, tax, total } = totalsOf(est)

  return (
    <div className="print-shell">
      <div className="print-toolbar no-print">
        <button className="back" onClick={() => navigate(`/estimates/${est.id}`)}>
          <Icon name="arrow-left" size={16} /> Edit estimate
        </button>
        <div className="print-toolbar-right">
          <span className="muted small">Tip: choose “Save as PDF” in the print dialog.</span>
          <Button variant="primary" icon="print" onClick={() => window.print()}>
            Print / Save PDF
          </Button>
        </div>
      </div>

      <div className="paper">
        <div className="paper-top">
          <div className="paper-from">
            {co.logo ? (
              <img src={co.logo} alt={co.name} className="paper-logo" />
            ) : (
              <div className="paper-logo-text">{co.name || 'Your Company'}</div>
            )}
            <div className="paper-from-meta">
              {co.name && <strong>{co.name}</strong>}
              {co.address && co.address.split('\n').map((l, i) => <span key={i}>{l}</span>)}
              {co.email && <span>{co.email}</span>}
              {co.phone && <span>{co.phone}</span>}
              {co.website && <span>{co.website}</span>}
            </div>
          </div>
          <div className="paper-title">
            <h1>ESTIMATE</h1>
            <div className="paper-num">{est.number}</div>
            <span className={`paper-status badge badge-est-${est.status}`}>{est.status}</span>
          </div>
        </div>

        <div className="paper-parties">
          <div>
            <span className="paper-label">Prepared for</span>
            {client ? (
              <div className="paper-client">
                <strong>{client.company || client.name}</strong>
                {client.company && client.name && <span>{client.name}</span>}
                {client.address &&
                  client.address.split('\n').map((l, i) => <span key={i}>{l}</span>)}
                {client.email && <span>{client.email}</span>}
              </div>
            ) : (
              <div className="paper-client muted">No client selected</div>
            )}
          </div>
          <div className="paper-dates">
            <div>
              <span className="paper-label">Issue date</span>
              <span>{formatDate(est.issueDate)}</span>
            </div>
            <div>
              <span className="paper-label">Valid until</span>
              <span>{formatDate(est.expiryDate)}</span>
            </div>
            <div>
              <span className="paper-label">Estimated total</span>
              <span className="paper-due">{money(total, est.currency)}</span>
            </div>
          </div>
        </div>

        <table className="paper-table">
          <thead>
            <tr>
              <th>Description</th>
              <th className="num">Qty</th>
              <th className="num">Unit price</th>
              <th className="num">Amount</th>
            </tr>
          </thead>
          <tbody>
            {est.items.map((it) => (
              <tr key={it.id}>
                <td>{it.description || '—'}</td>
                <td className="num">{it.quantity}</td>
                <td className="num">{money(it.unitPrice, est.currency)}</td>
                <td className="num">{money(itemTotal(it), est.currency)}</td>
              </tr>
            ))}
          </tbody>
        </table>

        <div className="paper-summary">
          <div className="paper-summary-inner">
            <div className="summary-line">
              <span>Subtotal</span>
              <span>{money(subtotal, est.currency)}</span>
            </div>
            {est.discount > 0 && (
              <div className="summary-line">
                <span>Discount</span>
                <span>−{money(est.discount, est.currency)}</span>
              </div>
            )}
            {est.taxRate > 0 && (
              <div className="summary-line">
                <span>Tax ({est.taxRate}%)</span>
                <span>{money(tax, est.currency)}</span>
              </div>
            )}
            <div className="summary-total">
              <span>Estimated total</span>
              <strong>{money(total, est.currency)}</strong>
            </div>
          </div>
        </div>

        {est.notes && (
          <div className="paper-notes">
            <span className="paper-label">Notes</span>
            <p>{est.notes}</p>
          </div>
        )}

        <div className="paper-footer">This is an estimate, not an invoice — generated with Solo.</div>
      </div>
    </div>
  )
}
