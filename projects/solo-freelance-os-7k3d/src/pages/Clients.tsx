import { useMemo, useState } from 'react'
import { clientActions, invoiceActions, useAppState } from '../store/store'
import { invoiceTotal } from '../lib/finance'
import { money, clampNumber } from '../lib/format'
import { CURRENCIES } from '../lib/format'
import { navigate } from '../lib/router'
import { Button, Card, EmptyState, Field, Modal, PageHeader, IconButton } from '../components/ui'
import type { Client } from '../types'

function blankDraft(currency: string): Partial<Client> {
  return { name: '', company: '', email: '', phone: '', address: '', rate: 100, currency, notes: '' }
}

export function Clients() {
  const { clients, invoices, settings } = useAppState()
  const [editing, setEditing] = useState<Client | null>(null)
  const [draft, setDraft] = useState<Partial<Client>>(blankDraft(settings.currency))
  const [open, setOpen] = useState(false)
  const [confirm, setConfirm] = useState<Client | null>(null)
  const [query, setQuery] = useState('')

  const stats = useMemo(() => {
    const map = new Map<string, { paid: number; outstanding: number; count: number }>()
    for (const inv of invoices) {
      if (!inv.clientId) continue
      const s = map.get(inv.clientId) ?? { paid: 0, outstanding: 0, count: 0 }
      s.count += 1
      const total = invoiceTotal(inv)
      if (inv.status === 'paid') s.paid += total
      else if (inv.status !== 'draft') s.outstanding += total
      map.set(inv.clientId, s)
    }
    return map
  }, [invoices])

  const filtered = clients.filter((c) => {
    const q = query.toLowerCase().trim()
    if (!q) return true
    return (
      c.name.toLowerCase().includes(q) ||
      c.company.toLowerCase().includes(q) ||
      c.email.toLowerCase().includes(q)
    )
  })

  function openNew() {
    setEditing(null)
    setDraft(blankDraft(settings.currency))
    setOpen(true)
  }
  function openEdit(c: Client) {
    setEditing(c)
    setDraft({ ...c })
    setOpen(true)
  }
  function save() {
    if (!draft.name?.trim()) return
    if (editing) clientActions.patch(editing.id, draft)
    else clientActions.create(draft)
    setOpen(false)
  }

  return (
    <div className="page">
      <PageHeader
        title="Clients"
        subtitle={`${clients.length} ${clients.length === 1 ? 'client' : 'clients'}`}
        actions={
          <Button variant="primary" icon="plus" onClick={openNew}>
            Add client
          </Button>
        }
      />

      {clients.length > 0 && (
        <div className="toolbar">
          <div className="search">
            <input
              placeholder="Search clients…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          </div>
        </div>
      )}

      {clients.length === 0 ? (
        <EmptyState
          icon="clients"
          title="No clients yet"
          message="Add the people and companies you work with to start invoicing and tracking time."
          action={
            <Button variant="primary" icon="plus" onClick={openNew}>
              Add your first client
            </Button>
          }
        />
      ) : (
        <div className="client-grid">
          {filtered.map((c) => {
            const s = stats.get(c.id)
            return (
              <Card key={c.id} className="client-card">
                <div className="client-top">
                  <div className="avatar">{(c.company || c.name || '?').slice(0, 1)}</div>
                  <div className="client-id">
                    <strong>{c.company || c.name}</strong>
                    <span className="muted">{c.company ? c.name : c.email}</span>
                  </div>
                  <div className="client-actions">
                    <IconButton icon="edit" label="Edit" onClick={() => openEdit(c)} />
                    <IconButton icon="trash" label="Delete" onClick={() => setConfirm(c)} />
                  </div>
                </div>
                <div className="client-meta">
                  {c.email && <span>{c.email}</span>}
                  {c.phone && <span>{c.phone}</span>}
                  <span>
                    {money(c.rate, c.currency)} <span className="muted">/ hr</span>
                  </span>
                </div>
                <div className="client-stats">
                  <div>
                    <span className="muted">Paid</span>
                    <strong>{money(s?.paid ?? 0, c.currency)}</strong>
                  </div>
                  <div>
                    <span className="muted">Outstanding</span>
                    <strong>{money(s?.outstanding ?? 0, c.currency)}</strong>
                  </div>
                  <div>
                    <span className="muted">Invoices</span>
                    <strong>{s?.count ?? 0}</strong>
                  </div>
                </div>
                <div className="client-foot">
                  <Button
                    variant="subtle"
                    icon="plus"
                    onClick={() => {
                      const inv = invoiceActions.create(c.id)
                      navigate(`/invoices/${inv.id}`)
                    }}
                  >
                    New invoice
                  </Button>
                </div>
              </Card>
            )
          })}
        </div>
      )}

      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title={editing ? 'Edit client' : 'Add client'}
        footer={
          <>
            <Button variant="ghost" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button variant="primary" icon="check" onClick={save}>
              {editing ? 'Save changes' : 'Add client'}
            </Button>
          </>
        }
      >
        <div className="form-grid">
          <Field label="Contact name">
            <input
              value={draft.name ?? ''}
              onChange={(e) => setDraft({ ...draft, name: e.target.value })}
              placeholder="Jane Doe"
            />
          </Field>
          <Field label="Company">
            <input
              value={draft.company ?? ''}
              onChange={(e) => setDraft({ ...draft, company: e.target.value })}
              placeholder="Acme Inc."
            />
          </Field>
          <Field label="Email">
            <input
              type="email"
              value={draft.email ?? ''}
              onChange={(e) => setDraft({ ...draft, email: e.target.value })}
              placeholder="jane@acme.com"
            />
          </Field>
          <Field label="Phone">
            <input
              value={draft.phone ?? ''}
              onChange={(e) => setDraft({ ...draft, phone: e.target.value })}
              placeholder="+1 …"
            />
          </Field>
          <Field label="Hourly rate">
            <input
              type="number"
              value={draft.rate ?? 0}
              onChange={(e) => setDraft({ ...draft, rate: clampNumber(e.target.value) })}
            />
          </Field>
          <Field label="Currency">
            <select
              value={draft.currency ?? settings.currency}
              onChange={(e) => setDraft({ ...draft, currency: e.target.value })}
            >
              {CURRENCIES.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Billing address">
            <textarea
              rows={2}
              value={draft.address ?? ''}
              onChange={(e) => setDraft({ ...draft, address: e.target.value })}
              placeholder="Street, City, ZIP"
            />
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

      <Modal
        open={!!confirm}
        onClose={() => setConfirm(null)}
        title="Delete client?"
        footer={
          <>
            <Button variant="ghost" onClick={() => setConfirm(null)}>
              Cancel
            </Button>
            <Button
              variant="danger"
              icon="trash"
              onClick={() => {
                if (confirm) clientActions.remove(confirm.id)
                setConfirm(null)
              }}
            >
              Delete
            </Button>
          </>
        }
      >
        <p>
          Delete <strong>{confirm?.company || confirm?.name}</strong>? Their invoices and time
          entries are kept but un-linked from this client.
        </p>
      </Modal>
    </div>
  )
}
