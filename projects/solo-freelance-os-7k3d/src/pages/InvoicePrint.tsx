import { useAppState } from '../store/store'
import { invoiceSubtotal, invoiceTax, invoiceTotal, itemTotal, effectiveStatus } from '../lib/finance'
import { formatDate, money } from '../lib/format'
import { navigate } from '../lib/router'
import { Button } from '../components/ui'
import { Icon } from '../components/Icon'

export function InvoicePrint({ id }: { id: string }) {
  const { invoices, clients, settings } = useAppState()
  const inv = invoices.find((i) => i.id === id)

  if (!inv) {
    return (
      <div className="print-shell">
        <p>Invoice not found.</p>
        <Button onClick={() => navigate('/invoices')}>Back</Button>
      </div>
    )
  }

  const client = clients.find((c) => c.id === inv.clientId)
  const co = settings.company
  const subtotal = invoiceSubtotal(inv)
  const tax = invoiceTax(inv)
  const total = invoiceTotal(inv)
  const status = effectiveStatus(inv)

  return (
    <div className="print-shell">
      <div className="print-toolbar no-print">
        <button className="back" onClick={() => navigate(`/invoices/${inv.id}`)}>
          <Icon name="arrow-left" size={16} /> Edit invoice
        </button>
        <div className="print-toolbar-right">
          <span className="muted small">Tip: choose “Save as PDF” in the print dialog.</span>
          <Button variant="primary" icon="print" onClick={() => window.print()}>
            Print / Save PDF
          </Button>
        </div>
      </div>

      <div className="paper" id="invoice-paper">
        <div className="paper-top">
          <div className="paper-from">
            {co.logo ? (
              <img src={co.logo} alt={co.name} className="paper-logo" />
            ) : (
              <div className="paper-logo-text">{co.name || 'Your Company'}</div>
            )}
            <div className="paper-from-meta">
              {co.name && <strong>{co.name}</strong>}
              {co.address &&
                co.address.split('\n').map((l, i) => <span key={i}>{l}</span>)}
              {co.email && <span>{co.email}</span>}
              {co.phone && <span>{co.phone}</span>}
              {co.website && <span>{co.website}</span>}
            </div>
          </div>
          <div className="paper-title">
            <h1>INVOICE</h1>
            <div className="paper-num">{inv.number}</div>
            <span className={`paper-status badge badge-${status}`}>{status}</span>
          </div>
        </div>

        <div className="paper-parties">
          <div>
            <span className="paper-label">Billed to</span>
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
              <span>{formatDate(inv.issueDate)}</span>
            </div>
            <div>
              <span className="paper-label">Due date</span>
              <span>{formatDate(inv.dueDate)}</span>
            </div>
            <div>
              <span className="paper-label">Amount due</span>
              <span className="paper-due">{money(total, inv.currency)}</span>
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
            {inv.items.map((it) => (
              <tr key={it.id}>
                <td>{it.description || '—'}</td>
                <td className="num">{it.quantity}</td>
                <td className="num">{money(it.unitPrice, inv.currency)}</td>
                <td className="num">{money(itemTotal(it), inv.currency)}</td>
              </tr>
            ))}
          </tbody>
        </table>

        <div className="paper-summary">
          <div className="paper-summary-inner">
            <div className="summary-line">
              <span>Subtotal</span>
              <span>{money(subtotal, inv.currency)}</span>
            </div>
            {inv.discount > 0 && (
              <div className="summary-line">
                <span>Discount</span>
                <span>−{money(inv.discount, inv.currency)}</span>
              </div>
            )}
            {inv.taxRate > 0 && (
              <div className="summary-line">
                <span>Tax ({inv.taxRate}%)</span>
                <span>{money(tax, inv.currency)}</span>
              </div>
            )}
            <div className="summary-total">
              <span>Total due</span>
              <strong>{money(total, inv.currency)}</strong>
            </div>
          </div>
        </div>

        {inv.paymentLink && status !== 'paid' && (
          <div className="paper-pay">
            <a className="paper-pay-btn" href={inv.paymentLink} target="_blank" rel="noreferrer">
              <Icon name="link" size={16} /> Pay this invoice online
            </a>
            <span className="paper-pay-url">{inv.paymentLink}</span>
          </div>
        )}

        {inv.notes && (
          <div className="paper-notes">
            <span className="paper-label">Notes</span>
            <p>{inv.notes}</p>
          </div>
        )}

        <div className="paper-footer">
          Thank you for your business — generated with Solo.
        </div>
      </div>
    </div>
  )
}
