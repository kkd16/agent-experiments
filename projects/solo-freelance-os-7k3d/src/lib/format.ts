// Small formatting + id helpers shared across the app. No dependencies.

export const CURRENCIES = [
  'USD',
  'EUR',
  'GBP',
  'CAD',
  'AUD',
  'JPY',
  'CHF',
  'INR',
  'SEK',
  'NZD',
  'SGD',
  'BRL',
] as const

const symbolCache = new Map<string, Intl.NumberFormat>()

function formatter(currency: string): Intl.NumberFormat {
  let f = symbolCache.get(currency)
  if (!f) {
    f = new Intl.NumberFormat(undefined, {
      style: 'currency',
      currency,
      maximumFractionDigits: 2,
    })
    symbolCache.set(currency, f)
  }
  return f
}

export function money(amount: number, currency = 'USD'): string {
  if (!Number.isFinite(amount)) amount = 0
  try {
    return formatter(currency).format(amount)
  } catch {
    return `${currency} ${amount.toFixed(2)}`
  }
}

/** Compact money for tight spaces, e.g. $12.4k. */
export function moneyShort(amount: number, currency = 'USD'): string {
  const abs = Math.abs(amount)
  if (abs >= 1000) {
    try {
      return new Intl.NumberFormat(undefined, {
        style: 'currency',
        currency,
        notation: 'compact',
        maximumFractionDigits: 1,
      }).format(amount)
    } catch {
      return money(amount, currency)
    }
  }
  return money(amount, currency)
}

export function uid(prefix = ''): string {
  const rand = Math.random().toString(36).slice(2, 9)
  return `${prefix}${Date.now().toString(36)}${rand}`
}

export function todayISO(): string {
  return new Date().toISOString().slice(0, 10)
}

export function addDays(iso: string, days: number): string {
  const d = new Date(iso + 'T00:00:00')
  d.setDate(d.getDate() + days)
  return d.toISOString().slice(0, 10)
}

export function formatDate(iso: string): string {
  if (!iso) return '—'
  const d = new Date(iso + (iso.length === 10 ? 'T00:00:00' : ''))
  if (Number.isNaN(d.getTime())) return iso
  return d.toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  })
}

/** "Jun 2026" style label for a Date. */
export function monthLabel(d: Date): string {
  return d.toLocaleDateString(undefined, { month: 'short', year: '2-digit' })
}

export function formatDuration(seconds: number): string {
  const h = Math.floor(seconds / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  const s = Math.floor(seconds % 60)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${pad(h)}:${pad(m)}:${pad(s)}`
}

/** Decimal hours, e.g. 1.5h, used in billing math. */
export function hours(seconds: number): number {
  return seconds / 3600
}

export function clampNumber(value: string, fallback = 0): number {
  const n = Number(value)
  return Number.isFinite(n) ? n : fallback
}
