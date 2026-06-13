// Pure financial calculations derived from app state. Keeping these pure (no React, no
// store access) makes them trivial to reason about and reuse across pages.

import type { AppState, Invoice, InvoiceItem } from '../types'
import { hours } from './format'

export function itemTotal(item: InvoiceItem): number {
  return item.quantity * item.unitPrice
}

export function invoiceSubtotal(inv: Invoice): number {
  return inv.items.reduce((sum, it) => sum + itemTotal(it), 0)
}

export function invoiceTax(inv: Invoice): number {
  const taxable = Math.max(0, invoiceSubtotal(inv) - inv.discount)
  return taxable * (inv.taxRate / 100)
}

export function invoiceTotal(inv: Invoice): number {
  return Math.max(0, invoiceSubtotal(inv) - inv.discount) + invoiceTax(inv)
}

/** An invoice is effectively overdue if it's been sent, isn't paid, and the due date passed. */
export function isOverdue(inv: Invoice, now = new Date()): boolean {
  if (inv.status === 'paid' || inv.status === 'draft') return false
  const due = new Date(inv.dueDate + 'T23:59:59')
  return due.getTime() < now.getTime()
}

/** How many recurring templates are due to generate at or before `today` (YYYY-MM-DD). */
export function recurringDueCount(state: AppState, today: string): number {
  return state.invoices.filter(
    (inv) => inv.recurring !== 'none' && inv.nextRun != null && inv.nextRun <= today,
  ).length
}

export function effectiveStatus(inv: Invoice, now = new Date()): Invoice['status'] {
  if (inv.status === 'sent' && isOverdue(inv, now)) return 'overdue'
  return inv.status
}

export interface Metrics {
  paidRevenue: number
  outstanding: number
  draftValue: number
  overdueValue: number
  expensesTotal: number
  netProfit: number
  unbilledValue: number
  unbilledSeconds: number
  thisMonthRevenue: number
  lastMonthRevenue: number
  revenueByMonth: { label: string; date: Date; value: number }[]
  statusMix: { status: Invoice['status']; count: number; value: number }[]
}

function monthKey(d: Date): string {
  return `${d.getFullYear()}-${d.getMonth()}`
}

export interface RangeReport {
  revenue: number
  expenses: number
  profit: number
  taxCollected: number
  paidInvoiceCount: number
  billableHours: number
  byClient: { id: string | null; name: string; revenue: number }[]
  byExpenseCategory: { category: string; amount: number }[]
}

function inRange(iso: string, from: string, to: string): boolean {
  return iso >= from && iso <= to
}

/**
 * Cash-basis report for [from, to] (inclusive, YYYY-MM-DD). Revenue counts invoices marked
 * paid within the window (by paid date, falling back to issue date).
 */
export function reportForRange(
  state: AppState,
  from: string,
  to: string,
): RangeReport {
  const { invoices, expenses, time, clients } = state
  const nameOf = (id: string | null) => {
    const c = clients.find((x) => x.id === id)
    return c ? c.company || c.name : 'No client'
  }

  let revenue = 0
  let taxCollected = 0
  let paidInvoiceCount = 0
  const clientTotals = new Map<string | null, number>()

  for (const inv of invoices) {
    if (inv.status !== 'paid') continue
    const when = (inv.paidAt ? inv.paidAt.slice(0, 10) : inv.issueDate)
    if (!inRange(when, from, to)) continue
    const total = invoiceTotal(inv)
    revenue += total
    taxCollected += invoiceTax(inv)
    paidInvoiceCount += 1
    clientTotals.set(inv.clientId, (clientTotals.get(inv.clientId) ?? 0) + total)
  }

  let expensesTotal = 0
  const catTotals = new Map<string, number>()
  for (const e of expenses) {
    if (!inRange(e.date, from, to)) continue
    expensesTotal += e.amount
    catTotals.set(e.category, (catTotals.get(e.category) ?? 0) + e.amount)
  }

  let billableSeconds = 0
  for (const t of time) {
    if (t.billable && inRange(t.date, from, to)) billableSeconds += t.seconds
  }

  return {
    revenue,
    expenses: expensesTotal,
    profit: revenue - expensesTotal,
    taxCollected,
    paidInvoiceCount,
    billableHours: Math.round((billableSeconds / 3600) * 100) / 100,
    byClient: [...clientTotals.entries()]
      .map(([id, rev]) => ({ id, name: nameOf(id), revenue: rev }))
      .sort((a, b) => b.revenue - a.revenue),
    byExpenseCategory: [...catTotals.entries()]
      .map(([category, amount]) => ({ category, amount }))
      .sort((a, b) => b.amount - a.amount),
  }
}

export function computeMetrics(state: AppState, monthsBack = 6, now = new Date()): Metrics {
  const { invoices, expenses, time } = state

  let paidRevenue = 0
  let outstanding = 0
  let draftValue = 0
  let overdueValue = 0

  const statusCounts: Record<Invoice['status'], { count: number; value: number }> = {
    draft: { count: 0, value: 0 },
    sent: { count: 0, value: 0 },
    paid: { count: 0, value: 0 },
    overdue: { count: 0, value: 0 },
  }

  for (const inv of invoices) {
    const total = invoiceTotal(inv)
    const status = effectiveStatus(inv, now)
    statusCounts[status].count += 1
    statusCounts[status].value += total

    if (inv.status === 'paid') paidRevenue += total
    else if (status === 'overdue') {
      outstanding += total
      overdueValue += total
    } else if (status === 'sent') outstanding += total
    else if (status === 'draft') draftValue += total
  }

  const expensesTotal = expenses.reduce((s, e) => s + e.amount, 0)

  // Revenue by month buckets (paid invoices, keyed by paid date or issue date).
  const buckets: { label: string; date: Date; key: string; value: number }[] = []
  for (let i = monthsBack - 1; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1)
    buckets.push({
      label: d.toLocaleDateString(undefined, { month: 'short', year: '2-digit' }),
      date: d,
      key: monthKey(d),
      value: 0,
    })
  }
  const bucketByKey = new Map(buckets.map((b) => [b.key, b]))

  let thisMonthRevenue = 0
  let lastMonthRevenue = 0
  const thisKey = monthKey(now)
  const lastKey = monthKey(new Date(now.getFullYear(), now.getMonth() - 1, 1))

  for (const inv of invoices) {
    if (inv.status !== 'paid') continue
    const when = inv.paidAt ? new Date(inv.paidAt) : new Date(inv.issueDate + 'T00:00:00')
    const k = monthKey(when)
    const bucket = bucketByKey.get(k)
    if (bucket) bucket.value += invoiceTotal(inv)
    if (k === thisKey) thisMonthRevenue += invoiceTotal(inv)
    if (k === lastKey) lastMonthRevenue += invoiceTotal(inv)
  }

  // Unbilled billable time.
  let unbilledSeconds = 0
  let unbilledValue = 0
  for (const t of time) {
    if (t.billable && !t.invoicedIn) {
      unbilledSeconds += t.seconds
      unbilledValue += hours(t.seconds) * t.rate
    }
  }

  return {
    paidRevenue,
    outstanding,
    draftValue,
    overdueValue,
    expensesTotal,
    netProfit: paidRevenue - expensesTotal,
    unbilledValue,
    unbilledSeconds,
    thisMonthRevenue,
    lastMonthRevenue,
    revenueByMonth: buckets.map(({ label, date, value }) => ({ label, date, value })),
    statusMix: (['paid', 'sent', 'overdue', 'draft'] as Invoice['status'][]).map((status) => ({
      status,
      count: statusCounts[status].count,
      value: statusCounts[status].value,
    })),
  }
}
