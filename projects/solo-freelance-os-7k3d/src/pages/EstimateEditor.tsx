import { useState } from 'react'
import { estimateActions, useAppState } from '../store/store'
import { totalsOf } from '../lib/finance'
import { CURRENCIES, clampNumber, formatDate, money } from '../lib/format'
import { navigate } from '../lib/router'
import { Button, Card, EstimateBadge, IconButton, Modal } from '../components/ui'
import { LineItems } from '../components/LineItems'
import { Icon } from '../components/Icon'
import type { EstimateStatus } from '../types'

const STATUS_FLOW: EstimateStatus[] = ['draft', 'sent', 'accepted', 'declined']

export function EstimateEditor({ id }: { id: string }) {
  const { estimates, invoices, clients } = useAppState()
  const est = estimates.find((e) => e.id === id)
  const [confirmDelete, setConfirmDelete] = useState(false)

  if (!est) {
    return (
      <div className="page">
        <Card className="pad">
          <p>That estimate no longer exists.</p>
          <Button variant="primary" onClick={() => navigate('/estimates')}>
            Back to estimates
          </Button>
        </Card>
      </div>
    )
  }

  const { subtotal, tax, total } = totalsOf(est)
  const set = (patch: Partial<typeof est>) => estimateActions.patch(est.id, patch)
  const linkedInvoice = est.convertedInvoiceId
    ? invoices.find((i) => i.id === est.convertedInvoiceId)
    : null

  return (
    <div className="page">
      <div className="editor-bar">
        <button className="back" onClick={() => navigate('/estimates')}>
          <Icon name="arrow-left" size={16} /> Estimates
        </button>
        <div className="editor-bar-right">
          <EstimateBadge status={est.status} />
          <Button icon="print" onClick={() => navigate(`/estimates/${est.id}/print`)}>
            Preview / PDF
          </Button>
          <IconButton icon="trash" label="Delete estimate" onClick={() => setConfirmDelete(true)} />
        </div>
      </div>

      <div className="editor-grid">
        <div className="editor-main">
          <Card>
            <div className="invoice-head-row">
              <div>
                <span className="muted">Estimate number</span>
                <input
                  className="big-input"
                  value={est.number}
                  onChange={(e) => set({ number: e.target.value })}
                />
              </div>
              <div className="field">
                <span className="field-label">Prepared for</span>
                <select
                  value={est.clientId ?? ''}
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
                  value={est.issueDate}
                  onChange={(e) => set({ issueDate: e.target.value })}
                />
              </label>
              <label className="field">
                <span className="field-label">Valid until</span>
                <input
                  type="date"
                  value={est.expiryDate}
                  onChange={(e) => set({ expiryDate: e.target.value })}
                />
              </label>
              <label className="field">
                <span className="field-label">Currency</span>
                <select value={est.currency} onChange={(e) => set({ currency: e.target.value })}>
                  {CURRENCIES.map((c) => (
                    <option key={c} value={c}>
                      {c}
                    </option>
                  ))}
                </select>
              </label>
            </div>
          </Card>

          <Card>
            <div className="card-head">
              <h3>Line items</h3>
            </div>
            <LineItems
              items={est.items}
              currency={est.currency}
              onPatch={(itemId, patch) => estimateActions.patchItem(est.id, itemId, patch)}
              onRemove={(itemId) => estimateActions.removeItem(est.id, itemId)}
              onAdd={() => estimateActions.addItem(est.id)}
            />
          </Card>

          <Card>
            <label className="field">
              <span className="field-label">Notes / terms</span>
              <textarea
                rows={3}
                value={est.notes}
                placeholder="Estimate valid for 30 days. 50% deposit to begin."
                onChange={(e) => set({ notes: e.target.value })}
              />
            </label>
          </Card>
        </div>

        <aside className="editor-side">
          <Card className="summary-card">
            <h3>Summary</h3>
            <div className="summary-line">
              <span>Subtotal</span>
              <span>{money(subtotal, est.currency)}</span>
            </div>
            <div className="summary-line input-line">
              <span>Discount</span>
              <input
                type="number"
                className="num-input"
                value={est.discount}
                onChange={(e) => set({ discount: clampNumber(e.target.value) })}
              />
            </div>
            <div className="summary-line input-line">
              <span>Tax (%)</span>
              <input
                type="number"
                className="num-input"
                value={est.taxRate}
                onChange={(e) => set({ taxRate: clampNumber(e.target.value) })}
              />
            </div>
            <div className="summary-line">
              <span>Tax amount</span>
              <span>{money(tax, est.currency)}</span>
            </div>
            <div className="summary-total">
              <span>Total</span>
              <strong>{money(total, est.currency)}</strong>
            </div>
          </Card>

          <Card className="status-control">
            <h3>Status</h3>
            <div className="seg">
              {STATUS_FLOW.map((s) => (
                <button
                  key={s}
                  className={`seg-btn ${est.status === s ? 'active' : ''}`}
                  onClick={() => set({ status: s })}
                >
                  {s}
                </button>
              ))}
            </div>

            {linkedInvoice ? (
              <Button
                variant="subtle"
                icon="invoices"
                onClick={() => navigate(`/invoices/${linkedInvoice.id}`)}
              >
                View invoice {linkedInvoice.number}
              </Button>
            ) : (
              <Button
                variant="primary"
                icon="check"
                onClick={() => {
                  const invId = estimateActions.convertToInvoice(est.id)
                  if (invId) navigate(`/invoices/${invId}`)
                }}
              >
                Accept &amp; convert to invoice
              </Button>
            )}
          </Card>
        </aside>
      </div>

      <Modal
        open={confirmDelete}
        onClose={() => setConfirmDelete(false)}
        title="Delete estimate?"
        footer={
          <>
            <Button variant="ghost" onClick={() => setConfirmDelete(false)}>
              Cancel
            </Button>
            <Button
              variant="danger"
              icon="trash"
              onClick={() => {
                estimateActions.remove(est.id)
                navigate('/estimates')
              }}
            >
              Delete
            </Button>
          </>
        }
      >
        <p>
          Permanently delete <strong>{est.number}</strong>? Any invoice already created from it is
          kept.
        </p>
      </Modal>

      {est.convertedInvoiceId && (
        <p className="muted small">
          Converted to invoice on {formatDate(est.issueDate)} — accepted.
        </p>
      )}
    </div>
  )
}
