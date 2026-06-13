import { useState } from 'react'
import { invoiceActions, useAppState } from '../store/store'
import {
  effectiveStatus,
  invoiceSubtotal,
  invoiceTax,
  invoiceTotal,
  itemTotal,
} from '../lib/finance'
import { CURRENCIES, clampNumber, formatDate, formatDuration, hours, money } from '../lib/format'
import { navigate } from '../lib/router'
import { Button, Card, IconButton, Modal, StatusBadge } from '../components/ui'
import { Icon } from '../components/Icon'
import type { InvoiceStatus } from '../types'

const STATUS_FLOW: InvoiceStatus[] = ['draft', 'sent', 'paid']

export function InvoiceEditor({ id }: { id: string }) {
  const { invoices, clients, time } = useAppState()
  const inv = invoices.find((i) => i.id === id)
  const [confirmDelete, setConfirmDelete] = useState(false)

  if (!inv) {
    return (
      <div className="page">
        <Card className="pad">
          <p>That invoice no longer exists.</p>
          <Button variant="primary" onClick={() => navigate('/invoices')}>
            Back to invoices
          </Button>
        </Card>
      </div>
    )
  }

  const status = effectiveStatus(inv)
  const subtotal = invoiceSubtotal(inv)
  const tax = invoiceTax(inv)
  const total = invoiceTotal(inv)

  const unbilled = inv.clientId
    ? time.filter((t) => t.clientId === inv.clientId && t.billable && !t.invoicedIn)
    : []
  const unbilledSeconds = unbilled.reduce((s, t) => s + t.seconds, 0)
  const unbilledValue = unbilled.reduce((s, t) => s + hours(t.seconds) * t.rate, 0)

  const set = (patch: Partial<typeof inv>) => invoiceActions.patch(inv.id, patch)

  return (
    <div className="page">
      <div className="editor-bar">
        <button className="back" onClick={() => navigate('/invoices')}>
          <Icon name="arrow-left" size={16} /> Invoices
        </button>
        <div className="editor-bar-right">
          <StatusBadge status={status} />
          <Button icon="print" onClick={() => navigate(`/invoices/${inv.id}/print`)}>
            Preview / PDF
          </Button>
          <Button
            icon="copy"
            onClick={() => {
              const copy = invoiceActions.duplicate(inv.id)
              if (copy) navigate(`/invoices/${copy.id}`)
            }}
          >
            Duplicate
          </Button>
          <IconButton icon="trash" label="Delete invoice" onClick={() => setConfirmDelete(true)} />
        </div>
      </div>

      <div className="editor-grid">
        <div className="editor-main">
          <Card>
            <div className="invoice-head-row">
              <div>
                <span className="muted">Invoice number</span>
                <input
                  className="big-input"
                  value={inv.number}
                  onChange={(e) => set({ number: e.target.value })}
                />
              </div>
              <div className="field">
                <span className="field-label">Bill to</span>
                <select
                  value={inv.clientId ?? ''}
                  onChange={(e) => set({ clientId: e.target.value || null })}
                >
                  <option value="">— Select client —</option>
                  {clients.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.company || c.name}
                    </option>
                  ))}
                </select>
              </div>
            </div>

            <div className="date-row">
              <label className="field">
                <span className="field-label">Issue date</span>
                <input
                  type="date"
                  value={inv.issueDate}
                  onChange={(e) => set({ issueDate: e.target.value })}
                />
              </label>
              <label className="field">
                <span className="field-label">Due date</span>
                <input
                  type="date"
                  value={inv.dueDate}
                  onChange={(e) => set({ dueDate: e.target.value })}
                />
              </label>
              <label className="field">
                <span className="field-label">Currency</span>
                <select value={inv.currency} onChange={(e) => set({ currency: e.target.value })}>
                  {CURRENCIES.map((c) => (
                    <option key={c} value={c}>
                      {c}
                    </option>
                  ))}
                </select>
              </label>
            </div>
          </Card>

          {unbilled.length > 0 && (
            <Card className="bill-time-banner">
              <div>
                <strong>{unbilled.length} unbilled time entries</strong>
                <span className="muted">
                  {' '}
                  · {formatDuration(unbilledSeconds)} · {money(unbilledValue, inv.currency)}
                </span>
              </div>
              <Button
                variant="primary"
                icon="plus"
                onClick={() => invoiceActions.billTime(inv.id, inv.clientId as string)}
              >
                Add to invoice
              </Button>
            </Card>
          )}

          <Card>
            <div className="card-head">
              <h3>Line items</h3>
            </div>
            <table className="items-table">
              <thead>
                <tr>
                  <th>Description</th>
                  <th className="num qty">Qty</th>
                  <th className="num price">Unit price</th>
                  <th className="num">Amount</th>
                  <th aria-label="remove" />
                </tr>
              </thead>
              <tbody>
                {inv.items.map((it) => (
                  <tr key={it.id}>
                    <td>
                      <input
                        value={it.description}
                        placeholder="Describe the work…"
                        onChange={(e) =>
                          invoiceActions.patchItem(inv.id, it.id, { description: e.target.value })
                        }
                      />
                    </td>
                    <td className="num">
                      <input
                        type="number"
                        className="num-input"
                        value={it.quantity}
                        onChange={(e) =>
                          invoiceActions.patchItem(inv.id, it.id, {
                            quantity: clampNumber(e.target.value),
                          })
                        }
                      />
                    </td>
                    <td className="num">
                      <input
                        type="number"
                        className="num-input"
                        value={it.unitPrice}
                        onChange={(e) =>
                          invoiceActions.patchItem(inv.id, it.id, {
                            unitPrice: clampNumber(e.target.value),
                          })
                        }
                      />
                    </td>
                    <td className="num strong">{money(itemTotal(it), inv.currency)}</td>
                    <td>
                      <IconButton
                        icon="x"
                        label="Remove line"
                        onClick={() => invoiceActions.removeItem(inv.id, it.id)}
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <Button variant="ghost" icon="plus" onClick={() => invoiceActions.addItem(inv.id)}>
              Add line item
            </Button>
          </Card>

          <Card>
            <label className="field">
              <span className="field-label">Notes / payment terms</span>
              <textarea
                rows={3}
                value={inv.notes}
                placeholder="Thanks for your business! Payment due within 14 days."
                onChange={(e) => set({ notes: e.target.value })}
              />
            </label>
            <label className="field" style={{ marginTop: 14 }}>
              <span className="field-label">Pay online link (optional)</span>
              <input
                value={inv.paymentLink ?? ''}
                placeholder="https://buy.stripe.com/…  or  https://paypal.me/you"
                onChange={(e) => set({ paymentLink: e.target.value })}
              />
              <span className="field-hint">
                Shown as a “Pay this invoice” button on the PDF / preview.
              </span>
            </label>
          </Card>
        </div>

        <aside className="editor-side">
          <Card className="summary-card">
            <h3>Summary</h3>
            <div className="summary-line">
              <span>Subtotal</span>
              <span>{money(subtotal, inv.currency)}</span>
            </div>
            <div className="summary-line input-line">
              <span>Discount</span>
              <input
                type="number"
                className="num-input"
                value={inv.discount}
                onChange={(e) => set({ discount: clampNumber(e.target.value) })}
              />
            </div>
            <div className="summary-line input-line">
              <span>Tax (%)</span>
              <input
                type="number"
                className="num-input"
                value={inv.taxRate}
                onChange={(e) => set({ taxRate: clampNumber(e.target.value) })}
              />
            </div>
            <div className="summary-line">
              <span>Tax amount</span>
              <span>{money(tax, inv.currency)}</span>
            </div>
            <div className="summary-total">
              <span>Total</span>
              <strong>{money(total, inv.currency)}</strong>
            </div>
          </Card>

          <Card className="status-control">
            <h3>Status</h3>
            <div className="seg">
              {STATUS_FLOW.map((s) => (
                <button
                  key={s}
                  className={`seg-btn ${inv.status === s ? 'active' : ''}`}
                  onClick={() => set({ status: s })}
                >
                  {s}
                </button>
              ))}
            </div>
            {inv.status === 'draft' && (
              <Button variant="primary" icon="send" onClick={() => set({ status: 'sent' })}>
                Mark as sent
              </Button>
            )}
            {(inv.status === 'sent' || status === 'overdue') && (
              <Button variant="primary" icon="check" onClick={() => set({ status: 'paid' })}>
                Mark as paid
              </Button>
            )}
            {inv.status === 'paid' && inv.paidAt && (
              <p className="muted small">
                Paid on {new Date(inv.paidAt).toLocaleDateString()}.
              </p>
            )}
          </Card>

          <Card className="status-control">
            <h3>Recurring</h3>
            <div className="seg">
              {(['none', 'weekly', 'monthly'] as const).map((r) => (
                <button
                  key={r}
                  className={`seg-btn ${inv.recurring === r ? 'active' : ''}`}
                  onClick={() => invoiceActions.setRecurring(inv.id, r)}
                >
                  {r === 'none' ? 'Off' : r}
                </button>
              ))}
            </div>
            {inv.recurring !== 'none' && inv.nextRun ? (
              <p className="muted small">
                Generates a new draft {inv.recurring}, next on{' '}
                <strong>{formatDate(inv.nextRun)}</strong>.
              </p>
            ) : (
              <p className="muted small">Turn this invoice into an auto-generating retainer.</p>
            )}
          </Card>
        </aside>
      </div>

      <Modal
        open={confirmDelete}
        onClose={() => setConfirmDelete(false)}
        title="Delete invoice?"
        footer={
          <>
            <Button variant="ghost" onClick={() => setConfirmDelete(false)}>
              Cancel
            </Button>
            <Button
              variant="danger"
              icon="trash"
              onClick={() => {
                invoiceActions.remove(inv.id)
                navigate('/invoices')
              }}
            >
              Delete
            </Button>
          </>
        }
      >
        <p>
          Permanently delete <strong>{inv.number}</strong>? Any time entries billed to it are
          released back to unbilled.
        </p>
      </Modal>
    </div>
  )
}
