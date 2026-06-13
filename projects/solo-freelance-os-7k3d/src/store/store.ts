// The single source of truth. A tiny localStorage-backed store with a pub/sub that plugs
// into React's useSyncExternalStore. No external state library needed.
//
// Design note: getSnapshot returns the *same* state reference until an action replaces it,
// which is exactly what useSyncExternalStore needs to avoid tearing / infinite loops. All
// mutations go through `update`, producing a new top-level object.

import { useSyncExternalStore } from 'react'
import type {
  AppState,
  Client,
  Expense,
  Invoice,
  InvoiceItem,
  Settings,
  TimeEntry,
} from '../types'
import { addDays, todayISO, uid } from '../lib/format'
import { invoiceTotal } from '../lib/finance'
import { seedState } from './seed'

const STORAGE_KEY = 'solo.workspace.v1'

function load(): AppState {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (raw) {
      const parsed = JSON.parse(raw) as AppState
      if (parsed && parsed.settings && Array.isArray(parsed.invoices)) return migrate(parsed)
    }
  } catch {
    // corrupt storage — fall through to a fresh seeded workspace
  }
  return seedState()
}

/** Forward-compatible reconciliation of older saved shapes. */
function migrate(state: AppState): AppState {
  return {
    version: 1,
    clients: state.clients ?? [],
    invoices: state.invoices ?? [],
    time: state.time ?? [],
    expenses: state.expenses ?? [],
    settings: { ...seedState().settings, ...state.settings },
  }
}

let state: AppState = load()
const listeners = new Set<() => void>()

function persist() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state))
  } catch {
    // storage full / disabled — app keeps working in-memory for the session
  }
}

function update(producer: (draft: AppState) => AppState): void {
  state = producer(state)
  persist()
  listeners.forEach((l) => l())
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

function getSnapshot(): AppState {
  return state
}

/** Stable empty server snapshot (SSR never runs here, but the API wants it). */
export function useAppState(): AppState {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
}

// ── Theme + accent applied to the document root ────────────────────────────
export function applyTheme(settings: Settings): void {
  const root = document.documentElement
  root.dataset.theme = settings.theme
  root.style.setProperty('--accent', settings.accent)
}

// ── Settings ───────────────────────────────────────────────────────────────
export const settingsActions = {
  patch(patch: Partial<Settings>) {
    update((s) => ({ ...s, settings: { ...s.settings, ...patch } }))
    applyTheme(state.settings)
  },
  patchCompany(patch: Partial<Settings['company']>) {
    update((s) => ({
      ...s,
      settings: { ...s.settings, company: { ...s.settings.company, ...patch } },
    }))
  },
  toggleTheme() {
    settingsActions.patch({ theme: state.settings.theme === 'light' ? 'dark' : 'light' })
  },
}

// ── Clients ──────────────────────────────────────────────────────────────────
export const clientActions = {
  create(partial: Partial<Client> = {}): Client {
    const client: Client = {
      id: uid('cl_'),
      name: partial.name ?? 'New client',
      company: partial.company ?? '',
      email: partial.email ?? '',
      phone: partial.phone ?? '',
      address: partial.address ?? '',
      rate: partial.rate ?? 100,
      currency: partial.currency ?? state.settings.currency,
      notes: partial.notes ?? '',
      createdAt: todayISO(),
    }
    update((s) => ({ ...s, clients: [client, ...s.clients] }))
    return client
  },
  patch(id: string, patch: Partial<Client>) {
    update((s) => ({
      ...s,
      clients: s.clients.map((c) => (c.id === id ? { ...c, ...patch } : c)),
    }))
  },
  remove(id: string) {
    update((s) => ({
      ...s,
      clients: s.clients.filter((c) => c.id !== id),
      invoices: s.invoices.map((inv) => (inv.clientId === id ? { ...inv, clientId: null } : inv)),
      time: s.time.map((t) => (t.clientId === id ? { ...t, clientId: null } : t)),
      expenses: s.expenses.map((e) => (e.clientId === id ? { ...e, clientId: null } : e)),
    }))
  },
}

// ── Invoices ─────────────────────────────────────────────────────────────────
function nextInvoiceNumber(s: AppState): { number: string; seq: number } {
  const seq = s.settings.invoiceSeq + 1
  return { number: `${s.settings.invoicePrefix}${String(seq).padStart(4, '0')}`, seq }
}

export const invoiceActions = {
  create(clientId: string | null = null): Invoice {
    const { number, seq } = nextInvoiceNumber(state)
    const today = todayISO()
    const invoice: Invoice = {
      id: uid('inv_'),
      number,
      clientId,
      status: 'draft',
      issueDate: today,
      dueDate: addDays(today, 14),
      items: [{ id: uid('it_'), description: '', quantity: 1, unitPrice: 0 }],
      taxRate: state.settings.taxRate,
      discount: 0,
      currency: state.settings.currency,
      notes: '',
      paidAt: null,
      createdAt: today,
    }
    update((s) => ({
      ...s,
      invoices: [invoice, ...s.invoices],
      settings: { ...s.settings, invoiceSeq: seq },
    }))
    return invoice
  },
  patch(id: string, patch: Partial<Invoice>) {
    update((s) => ({
      ...s,
      invoices: s.invoices.map((inv) => {
        if (inv.id !== id) return inv
        const next = { ...inv, ...patch }
        // Keep paidAt consistent with status transitions.
        if (patch.status === 'paid' && !next.paidAt) next.paidAt = new Date().toISOString()
        if (patch.status && patch.status !== 'paid') next.paidAt = null
        return next
      }),
    }))
  },
  remove(id: string) {
    update((s) => ({
      ...s,
      invoices: s.invoices.filter((inv) => inv.id !== id),
      // Release any time entries that were billed to this invoice.
      time: s.time.map((t) => (t.invoicedIn === id ? { ...t, invoicedIn: null } : t)),
    }))
  },
  duplicate(id: string): Invoice | null {
    const src = state.invoices.find((i) => i.id === id)
    if (!src) return null
    const { number, seq } = nextInvoiceNumber(state)
    const today = todayISO()
    const copy: Invoice = {
      ...src,
      id: uid('inv_'),
      number,
      status: 'draft',
      issueDate: today,
      dueDate: addDays(today, 14),
      paidAt: null,
      createdAt: today,
      items: src.items.map((it) => ({ ...it, id: uid('it_') })),
    }
    update((s) => ({
      ...s,
      invoices: [copy, ...s.invoices],
      settings: { ...s.settings, invoiceSeq: seq },
    }))
    return copy
  },
  addItem(invoiceId: string, item?: Partial<InvoiceItem>) {
    const newItem: InvoiceItem = {
      id: uid('it_'),
      description: item?.description ?? '',
      quantity: item?.quantity ?? 1,
      unitPrice: item?.unitPrice ?? 0,
    }
    update((s) => ({
      ...s,
      invoices: s.invoices.map((inv) =>
        inv.id === invoiceId ? { ...inv, items: [...inv.items, newItem] } : inv,
      ),
    }))
  },
  patchItem(invoiceId: string, itemId: string, patch: Partial<InvoiceItem>) {
    update((s) => ({
      ...s,
      invoices: s.invoices.map((inv) =>
        inv.id === invoiceId
          ? { ...inv, items: inv.items.map((it) => (it.id === itemId ? { ...it, ...patch } : it)) }
          : inv,
      ),
    }))
  },
  removeItem(invoiceId: string, itemId: string) {
    update((s) => ({
      ...s,
      invoices: s.invoices.map((inv) =>
        inv.id === invoiceId
          ? { ...inv, items: inv.items.filter((it) => it.id !== itemId) }
          : inv,
      ),
    }))
  },
  /** Pull all unbilled billable time for a client onto an invoice as grouped line items. */
  billTime(invoiceId: string, clientId: string) {
    const entries = state.time.filter(
      (t) => t.clientId === clientId && t.billable && !t.invoicedIn,
    )
    if (entries.length === 0) return
    // Group by project so the invoice reads cleanly.
    const byProject = new Map<string, { seconds: number; rate: number }>()
    for (const e of entries) {
      const key = e.project || 'Consulting'
      const acc = byProject.get(key) ?? { seconds: 0, rate: e.rate }
      acc.seconds += e.seconds
      acc.rate = e.rate
      byProject.set(key, acc)
    }
    const newItems: InvoiceItem[] = [...byProject.entries()].map(([project, v]) => ({
      id: uid('it_'),
      description: `${project} (time)`,
      quantity: Math.round((v.seconds / 3600) * 100) / 100,
      unitPrice: v.rate,
    }))
    const ids = new Set(entries.map((e) => e.id))
    update((s) => ({
      ...s,
      invoices: s.invoices.map((inv) =>
        inv.id === invoiceId ? { ...inv, items: [...inv.items, ...newItems] } : inv,
      ),
      time: s.time.map((t) => (ids.has(t.id) ? { ...t, invoicedIn: invoiceId } : t)),
    }))
  },
}

// ── Time tracking ─────────────────────────────────────────────────────────────
export const timeActions = {
  add(partial: Partial<TimeEntry> = {}): TimeEntry {
    const clientId = partial.clientId ?? null
    const client = clientId ? state.clients.find((c) => c.id === clientId) : null
    const entry: TimeEntry = {
      id: uid('tm_'),
      clientId,
      project: partial.project ?? '',
      description: partial.description ?? '',
      date: partial.date ?? todayISO(),
      seconds: partial.seconds ?? 0,
      rate: partial.rate ?? client?.rate ?? state.clients[0]?.rate ?? 100,
      billable: partial.billable ?? true,
      invoicedIn: null,
    }
    update((s) => ({ ...s, time: [entry, ...s.time] }))
    return entry
  },
  patch(id: string, patch: Partial<TimeEntry>) {
    update((s) => ({
      ...s,
      time: s.time.map((t) => (t.id === id ? { ...t, ...patch } : t)),
    }))
  },
  remove(id: string) {
    update((s) => ({ ...s, time: s.time.filter((t) => t.id !== id) }))
  },
}

// ── Expenses ──────────────────────────────────────────────────────────────────
export const expenseActions = {
  add(partial: Partial<Expense> = {}): Expense {
    const expense: Expense = {
      id: uid('ex_'),
      date: partial.date ?? todayISO(),
      vendor: partial.vendor ?? '',
      category: partial.category ?? 'Software',
      amount: partial.amount ?? 0,
      clientId: partial.clientId ?? null,
      billable: partial.billable ?? false,
      notes: partial.notes ?? '',
    }
    update((s) => ({ ...s, expenses: [expense, ...s.expenses] }))
    return expense
  },
  patch(id: string, patch: Partial<Expense>) {
    update((s) => ({
      ...s,
      expenses: s.expenses.map((e) => (e.id === id ? { ...e, ...patch } : e)),
    }))
  },
  remove(id: string) {
    update((s) => ({ ...s, expenses: s.expenses.filter((e) => e.id !== id) }))
  },
}

// ── Workspace-level (export / import / reset) ──────────────────────────────────
export const workspaceActions = {
  exportJSON(): string {
    return JSON.stringify(state, null, 2)
  },
  importJSON(json: string): boolean {
    try {
      const parsed = JSON.parse(json) as AppState
      if (!parsed.settings || !Array.isArray(parsed.invoices)) return false
      update(() => migrate(parsed))
      applyTheme(state.settings)
      return true
    } catch {
      return false
    }
  },
  reset() {
    update(() => seedState())
    applyTheme(state.settings)
  },
  clear() {
    update(() => ({
      version: 1,
      clients: [],
      invoices: [],
      time: [],
      expenses: [],
      settings: state.settings,
    }))
  },
}

export function getState(): AppState {
  return state
}

// Apply the saved theme immediately at module load so there's no unstyled flash before
// React's first effect runs.
applyTheme(state.settings)

/** Live total used in a few places that need the freshest value outside React. */
export function liveInvoiceTotal(id: string): number {
  const inv = state.invoices.find((i) => i.id === id)
  return inv ? invoiceTotal(inv) : 0
}
