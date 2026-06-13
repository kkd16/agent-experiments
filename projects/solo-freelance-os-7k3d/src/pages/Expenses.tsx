import { useMemo, useState } from 'react'
import { expenseActions, useAppState } from '../store/store'
import { clampNumber, formatDate, money, todayISO } from '../lib/format'
import { Button, Card, EmptyState, Field, Modal, PageHeader, IconButton } from '../components/ui'
import type { Expense, ExpenseCategory } from '../types'

const CATEGORIES: ExpenseCategory[] = [
  'Software',
  'Hardware',
  'Travel',
  'Meals',
  'Marketing',
  'Office',
  'Fees',
  'Other',
]

function blank(): Partial<Expense> {
  return {
    date: todayISO(),
    vendor: '',
    category: 'Software',
    amount: 0,
    clientId: null,
    billable: false,
    notes: '',
  }
}

export function Expenses() {
  const { expenses, clients, settings } = useAppState()
  const cur = settings.currency
  const [open, setOpen] = useState(false)
  const [editing, setEditing] = useState<Expense | null>(null)
  const [draft, setDraft] = useState<Partial<Expense>>(blank())

  const sorted = useMemo(
    () => [...expenses].sort((a, b) => b.date.localeCompare(a.date)),
    [expenses],
  )

  const byCategory = useMemo(() => {
    const map = new Map<string, number>()
    for (const e of expenses) map.set(e.category, (map.get(e.category) ?? 0) + e.amount)
    return [...map.entries()].sort((a, b) => b[1] - a[1])
  }, [expenses])

  const total = expenses.reduce((s, e) => s + e.amount, 0)
  const billable = expenses.filter((e) => e.billable).reduce((s, e) => s + e.amount, 0)
  const maxCat = Math.max(1, ...byCategory.map((c) => c[1]))

  function openNew() {
    setEditing(null)
    setDraft(blank())
    setOpen(true)
  }
  function openEdit(e: Expense) {
    setEditing(e)
    setDraft({ ...e })
    setOpen(true)
  }
  function save() {
    if (editing) expenseActions.patch(editing.id, draft)
    else expenseActions.add(draft)
    setOpen(false)
  }

  const clientName = (id: string | null) =>
    clients.find((c) => c.id === id)?.company || clients.find((c) => c.id === id)?.name || '—'

  return (
    <div className="page">
      <PageHeader
        title="Expenses"
        subtitle="Track spending and flag what's billable to clients."
        actions={
          <Button variant="primary" icon="plus" onClick={openNew}>
            Add expense
          </Button>
        }
      />

      <div className="time-totals">
        <Card className="mini-kpi">
          <span className="muted">Total expenses</span>
          <strong>{money(total, cur)}</strong>
        </Card>
        <Card className="mini-kpi">
          <span className="muted">Billable to clients</span>
          <strong>{money(billable, cur)}</strong>
        </Card>
        <Card className="mini-kpi">
          <span className="muted">Entries</span>
          <strong>{expenses.length}</strong>
        </Card>
      </div>

      {expenses.length === 0 ? (
        <EmptyState
          icon="expenses"
          title="No expenses yet"
          message="Log business costs to track profit and reclaim billable expenses."
          action={
            <Button variant="primary" icon="plus" onClick={openNew}>
              Add expense
            </Button>
          }
        />
      ) : (
        <div className="dash-grid">
          <Card className="table-card">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Date</th>
                  <th>Vendor</th>
                  <th>Category</th>
                  <th>Client</th>
                  <th>Billable</th>
                  <th className="num">Amount</th>
                  <th aria-label="actions" />
                </tr>
              </thead>
              <tbody>
                {sorted.map((e) => (
                  <tr key={e.id} onClick={() => openEdit(e)}>
                    <td className="muted">{formatDate(e.date)}</td>
                    <td>{e.vendor || '—'}</td>
                    <td>
                      <span className="cat-pill">{e.category}</span>
                    </td>
                    <td className="muted">{e.clientId ? clientName(e.clientId) : '—'}</td>
                    <td>{e.billable ? '✓' : ''}</td>
                    <td className="num strong">{money(e.amount, cur)}</td>
                    <td className="row-actions" onClick={(ev) => ev.stopPropagation()}>
                      <IconButton
                        icon="trash"
                        label="Delete"
                        onClick={() => expenseActions.remove(e.id)}
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Card>

          <Card>
            <div className="card-head">
              <h3>By category</h3>
            </div>
            <ul className="bar-list">
              {byCategory.map(([cat, val]) => (
                <li key={cat}>
                  <div className="bar-list-head">
                    <span>{cat}</span>
                    <strong>{money(val, cur)}</strong>
                  </div>
                  <div className="bar-track">
                    <div className="bar-fill" style={{ width: `${(val / maxCat) * 100}%` }} />
                  </div>
                </li>
              ))}
            </ul>
          </Card>
        </div>
      )}

      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title={editing ? 'Edit expense' : 'Add expense'}
        footer={
          <>
            <Button variant="ghost" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button variant="primary" icon="check" onClick={save}>
              {editing ? 'Save' : 'Add expense'}
            </Button>
          </>
        }
      >
        <div className="form-grid">
          <Field label="Date">
            <input
              type="date"
              value={draft.date ?? todayISO()}
              onChange={(e) => setDraft({ ...draft, date: e.target.value })}
            />
          </Field>
          <Field label="Amount">
            <input
              type="number"
              value={draft.amount ?? 0}
              onChange={(e) => setDraft({ ...draft, amount: clampNumber(e.target.value) })}
            />
          </Field>
          <Field label="Vendor">
            <input
              value={draft.vendor ?? ''}
              onChange={(e) => setDraft({ ...draft, vendor: e.target.value })}
              placeholder="e.g. Adobe"
            />
          </Field>
          <Field label="Category">
            <select
              value={draft.category ?? 'Software'}
              onChange={(e) => setDraft({ ...draft, category: e.target.value as ExpenseCategory })}
            >
              {CATEGORIES.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Client (optional)">
            <select
              value={draft.clientId ?? ''}
              onChange={(e) => setDraft({ ...draft, clientId: e.target.value || null })}
            >
              <option value="">— None —</option>
              {clients.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.company || c.name}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Billable to client">
            <label className="checkbox-row">
              <input
                type="checkbox"
                checked={draft.billable ?? false}
                onChange={(e) => setDraft({ ...draft, billable: e.target.checked })}
              />
              <span>Rebill this expense to the client</span>
            </label>
          </Field>
          <Field label="Notes">
            <textarea
              rows={2}
              value={draft.notes ?? ''}
              onChange={(e) => setDraft({ ...draft, notes: e.target.value })}
            />
          </Field>
        </div>
      </Modal>
    </div>
  )
}
