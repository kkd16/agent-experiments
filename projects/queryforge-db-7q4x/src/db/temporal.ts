// First-class temporal values: DATE, TIME, TIMESTAMP and INTERVAL.
//
// The rest of the engine keeps a deliberately small, JS-native value space so
// the whole database stays serializable to localStorage. Temporal values join
// that space as *plain tagged objects* (no class instances), discriminated by a
// `t` field — they survive `JSON.stringify`/`parse` round-trips untouched, so a
// table full of dates persists and reloads with no special-casing.
//
//   DATE      -> { t:'date', days }            whole days since 1970-01-01 (UTC, proleptic Gregorian)
//   TIME      -> { t:'time', ms }              milliseconds since midnight, in [0, 86_400_000)
//   TIMESTAMP -> { t:'timestamp', ms }         milliseconds since the Unix epoch (UTC)
//   INTERVAL  -> { t:'interval', months, days, ms }   a calendar-aware duration
//
// Everything here works in UTC: there are no time zones, so a given literal
// always denotes the same instant regardless of where the page is loaded.

export interface DateValue {
  t: 'date'
  days: number
}
export interface TimeValue {
  t: 'time'
  ms: number
}
export interface TimestampValue {
  t: 'timestamp'
  ms: number
}
export interface IntervalValue {
  t: 'interval'
  months: number
  days: number
  ms: number
}

export type Temporal = DateValue | TimeValue | TimestampValue | IntervalValue
export type TemporalKind = Temporal['t']

export const MS_PER_DAY = 86_400_000
const MS_PER_HOUR = 3_600_000
const MS_PER_MIN = 60_000
const MS_PER_SEC = 1_000

/** Runtime guard: is this value one of our tagged temporal objects? */
export function isTemporal(v: unknown): v is Temporal {
  return (
    typeof v === 'object' &&
    v !== null &&
    typeof (v as { t?: unknown }).t === 'string' &&
    ((v as Temporal).t === 'date' ||
      (v as Temporal).t === 'time' ||
      (v as Temporal).t === 'timestamp' ||
      (v as Temporal).t === 'interval')
  )
}

// --- constructors -----------------------------------------------------------
export const mkDate = (days: number): DateValue => ({ t: 'date', days: Math.trunc(days) })
export const mkTime = (ms: number): TimeValue => ({ t: 'time', ms: ((Math.round(ms) % MS_PER_DAY) + MS_PER_DAY) % MS_PER_DAY })
export const mkTimestamp = (ms: number): TimestampValue => ({ t: 'timestamp', ms: Math.round(ms) })
export const mkInterval = (months: number, days: number, ms: number): IntervalValue => ({
  t: 'interval',
  months: Math.trunc(months),
  days: Math.trunc(days),
  ms: Math.round(ms),
})

// --- scalar projection (for ordering, hashing, histograms) ------------------
// A single number that totally orders values *within* a kind, and lets DATE and
// TIMESTAMP compare against each other (both as epoch-ms).
export function temporalScalar(v: Temporal): number {
  switch (v.t) {
    case 'date':
      return v.days * MS_PER_DAY
    case 'time':
      return v.ms
    case 'timestamp':
      return v.ms
    case 'interval':
      // Postgres-style canonical ordering: 30-day months, 24-hour days.
      return (v.months * 30 + v.days) * MS_PER_DAY + v.ms
  }
}

/** A small rank so distinct kinds get a deterministic (if arbitrary) order. */
function kindRank(k: TemporalKind): number {
  return k === 'date' ? 0 : k === 'timestamp' ? 1 : k === 'time' ? 2 : 3
}

/**
 * Compare two temporal values. DATE and TIMESTAMP are mutually comparable (the
 * DATE is read as UTC midnight); every other cross-kind pair is *not* ordered by
 * value, so we return null and let the caller fall back to a total order.
 */
export function compareTemporal(a: Temporal, b: Temporal): number | null {
  if (a.t === b.t) {
    const x = temporalScalar(a)
    const y = temporalScalar(b)
    return x < y ? -1 : x > y ? 1 : 0
  }
  const dateTs =
    (a.t === 'date' && b.t === 'timestamp') || (a.t === 'timestamp' && b.t === 'date')
  if (dateTs) {
    const x = a.t === 'date' ? a.days * MS_PER_DAY : (a as TimestampValue).ms
    const y = b.t === 'date' ? b.days * MS_PER_DAY : (b as TimestampValue).ms
    return x < y ? -1 : x > y ? 1 : 0
  }
  return null
}

/** Total order for sorting/index keys (deterministic even across kinds). */
export function orderTemporal(a: Temporal, b: Temporal): number {
  const c = compareTemporal(a, b)
  if (c !== null) return c
  const ra = kindRank(a.t)
  const rb = kindRank(b.t)
  if (ra !== rb) return ra - rb
  const x = temporalScalar(a)
  const y = temporalScalar(b)
  return x < y ? -1 : x > y ? 1 : 0
}

/** Stable hash fragment for joins / GROUP BY / DISTINCT. */
export function hashTemporal(v: Temporal): string {
  return v.t === 'interval' ? `iv:${v.months}/${v.days}/${v.ms}` : `${v.t}:${temporalScalar(v)}`
}

// --- formatting -------------------------------------------------------------
function pad(n: number, w = 2): string {
  return String(Math.abs(Math.trunc(n))).padStart(w, '0')
}
function ymd(days: number): string {
  const d = new Date(days * MS_PER_DAY)
  return `${pad(d.getUTCFullYear(), 4)}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`
}
function hms(ms: number): string {
  const a = Math.abs(ms)
  const h = Math.floor(a / MS_PER_HOUR)
  const m = Math.floor(a / MS_PER_MIN) % 60
  const s = Math.floor(a / MS_PER_SEC) % 60
  const frac = a % 1000
  const base = `${pad(h)}:${pad(m)}:${pad(s)}`
  return frac ? `${base}.${pad(frac, 3)}` : base
}

export function formatTemporal(v: Temporal): string {
  switch (v.t) {
    case 'date':
      return ymd(v.days)
    case 'time':
      return hms(v.ms)
    case 'timestamp': {
      const day = Math.floor(v.ms / MS_PER_DAY)
      const rest = v.ms - day * MS_PER_DAY
      return `${ymd(day)} ${hms(rest)}`
    }
    case 'interval':
      return formatInterval(v)
  }
}

function formatInterval(v: IntervalValue): string {
  const years = Math.trunc(v.months / 12)
  const mons = v.months % 12
  const parts: string[] = []
  const plural = (n: number, unit: string) => `${n} ${unit}${Math.abs(n) === 1 ? '' : 's'}`
  if (years !== 0) parts.push(plural(years, 'year'))
  if (mons !== 0) parts.push(plural(mons, 'mon'))
  if (v.days !== 0) parts.push(plural(v.days, 'day'))
  if (v.ms !== 0 || parts.length === 0) parts.push(`${v.ms < 0 ? '-' : ''}${hms(v.ms)}`)
  return parts.join(' ')
}

// --- parsing ----------------------------------------------------------------
const DATE_RE = /^(\d{4,})-(\d{2})-(\d{2})$/
const TIME_RE = /^(\d{1,2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?$/
const TS_RE = /^(\d{4,})-(\d{2})-(\d{2})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?)?Z?$/

function fracMs(frac: string | undefined): number {
  if (!frac) return 0
  return Number((frac + '000').slice(0, 3))
}

export function parseDate(s: string): DateValue | null {
  const m = DATE_RE.exec(s.trim())
  if (!m) return null
  const ms = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]))
  if (Number.isNaN(ms)) return null
  return mkDate(Math.floor(ms / MS_PER_DAY))
}

export function parseTime(s: string): TimeValue | null {
  const m = TIME_RE.exec(s.trim())
  if (!m) return null
  const ms = Number(m[1]) * MS_PER_HOUR + Number(m[2]) * MS_PER_MIN + Number(m[3] ?? 0) * MS_PER_SEC + fracMs(m[4])
  return { t: 'time', ms }
}

export function parseTimestamp(s: string): TimestampValue | null {
  const m = TS_RE.exec(s.trim())
  if (!m) return null
  const ms = Date.UTC(
    Number(m[1]),
    Number(m[2]) - 1,
    Number(m[3]),
    Number(m[4] ?? 0),
    Number(m[5] ?? 0),
    Number(m[6] ?? 0),
    fracMs(m[7]),
  )
  if (Number.isNaN(ms)) return null
  return mkTimestamp(ms)
}

const IV_UNITS: Record<string, 'months' | 'days' | 'ms'> = {
  year: 'months', years: 'months', yr: 'months', yrs: 'months', y: 'months',
  month: 'months', months: 'months', mon: 'months', mons: 'months',
  week: 'days', weeks: 'days', w: 'days',
  day: 'days', days: 'days', d: 'days',
  hour: 'ms', hours: 'ms', hr: 'ms', hrs: 'ms', h: 'ms',
  minute: 'ms', minutes: 'ms', min: 'ms', mins: 'ms', m: 'ms',
  second: 'ms', seconds: 'ms', sec: 'ms', secs: 'ms', s: 'ms',
  millisecond: 'ms', milliseconds: 'ms', ms: 'ms', msec: 'ms', msecs: 'ms',
}
const IV_SCALE: Record<string, number> = {
  year: 12, years: 12, yr: 12, yrs: 12, y: 12,
  week: 7, weeks: 7, w: 7,
  hour: MS_PER_HOUR, hours: MS_PER_HOUR, hr: MS_PER_HOUR, hrs: MS_PER_HOUR, h: MS_PER_HOUR,
  minute: MS_PER_MIN, minutes: MS_PER_MIN, min: MS_PER_MIN, mins: MS_PER_MIN, m: MS_PER_MIN,
  second: MS_PER_SEC, seconds: MS_PER_SEC, sec: MS_PER_SEC, secs: MS_PER_SEC, s: MS_PER_SEC,
}

/**
 * Parse an INTERVAL literal. Accepts a sequence of `<number> <unit>` phrases
 * (`'1 year 2 months'`, `'90 minutes'`, `'-3 days'`) and/or a trailing clock
 * segment (`'1 day 04:05:06'`, `'12:30'`). Units cover year…millisecond plus
 * weeks; weeks fold into days and sub-day units into milliseconds.
 */
export function parseInterval(s: string): IntervalValue | null {
  let months = 0
  let days = 0
  let ms = 0
  let matched = false
  const text = s.trim().toLowerCase()
  if (text === '') return null

  // `<number> <unit>` phrases.
  const phrase = /(-?\d+(?:\.\d+)?)\s*([a-z]+)/g
  let mm: RegExpExecArray | null
  while ((mm = phrase.exec(text)) !== null) {
    const n = Number(mm[1])
    const unit = mm[2]
    const field = IV_UNITS[unit]
    if (!field) return null
    const scaled = n * (IV_SCALE[unit] ?? 1)
    if (field === 'months') months += scaled
    else if (field === 'days') days += scaled
    else ms += scaled
    matched = true
  }

  // A trailing `HH:MM[:SS[.fff]]` clock segment (optionally signed).
  const clock = /(^|\s)(-?)(\d{1,3}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?(?=\s|$)/.exec(text)
  if (clock) {
    const sign = clock[2] === '-' ? -1 : 1
    ms += sign * (Number(clock[3]) * MS_PER_HOUR + Number(clock[4]) * MS_PER_MIN + Number(clock[5] ?? 0) * MS_PER_SEC + fracMs(clock[6]))
    matched = true
  }
  if (!matched) return null
  return mkInterval(months, days, Math.round(ms))
}

// --- conversions ------------------------------------------------------------
export function dateToTimestamp(d: DateValue): TimestampValue {
  return mkTimestamp(d.days * MS_PER_DAY)
}
export function timestampToDate(ts: TimestampValue): DateValue {
  return mkDate(Math.floor(ts.ms / MS_PER_DAY))
}

/** Try to read any value as a given temporal kind (for comparisons / coercion). */
export function asTemporalKind(kind: TemporalKind, v: unknown): Temporal | null {
  if (isTemporal(v)) {
    if (v.t === kind) return v
    if (kind === 'timestamp' && v.t === 'date') return dateToTimestamp(v)
    if (kind === 'date' && v.t === 'timestamp') return timestampToDate(v)
    return null
  }
  if (typeof v === 'string') {
    switch (kind) {
      case 'date':
        return parseDate(v)
      case 'time':
        return parseTime(v)
      case 'timestamp':
        return parseTimestamp(v)
      case 'interval':
        return parseInterval(v)
    }
  }
  if (typeof v === 'number') {
    if (kind === 'date') return mkDate(v)
    if (kind === 'timestamp') return mkTimestamp(v)
    if (kind === 'time') return mkTime(v)
  }
  return null
}

// --- calendar arithmetic ----------------------------------------------------
function daysInMonth(year: number, month0: number): number {
  return new Date(Date.UTC(year, month0 + 1, 0)).getUTCDate()
}

/** Add a (possibly negative) whole number of months to an epoch-ms instant,
 *  clamping the day-of-month (Jan 31 + 1 month → Feb 28). */
function addMonths(ms: number, months: number): number {
  const d = new Date(ms)
  let y = d.getUTCFullYear()
  let m = d.getUTCMonth() + months
  y += Math.floor(m / 12)
  m = ((m % 12) + 12) % 12
  const day = Math.min(d.getUTCDate(), daysInMonth(y, m))
  return Date.UTC(y, m, day, d.getUTCHours(), d.getUTCMinutes(), d.getUTCSeconds(), d.getUTCMilliseconds())
}

/** Apply an interval to an epoch-ms instant: months (calendar) then days then ms. */
export function applyIntervalMs(ms: number, iv: IntervalValue, sign: 1 | -1): number {
  let out = addMonths(ms, sign * iv.months)
  out += sign * iv.days * MS_PER_DAY
  out += sign * iv.ms
  return out
}

export function scaleInterval(iv: IntervalValue, factor: number): IntervalValue {
  let months = iv.months * factor
  let days = iv.days * factor
  let ms = iv.ms * factor
  // Cascade fractional larger units down (Postgres semantics: 30-day months).
  const fracM = months - Math.trunc(months)
  months = Math.trunc(months)
  days += fracM * 30
  const fracD = days - Math.trunc(days)
  days = Math.trunc(days)
  ms += fracD * MS_PER_DAY
  return mkInterval(months, days, ms)
}

export function addIntervals(a: IntervalValue, b: IntervalValue, sign: 1 | -1): IntervalValue {
  return mkInterval(a.months + sign * b.months, a.days + sign * b.days, a.ms + sign * b.ms)
}

/** A timestamp/time difference as an interval of whole days + leftover time. */
export function msDiffToInterval(deltaMs: number): IntervalValue {
  const days = Math.trunc(deltaMs / MS_PER_DAY)
  const ms = deltaMs - days * MS_PER_DAY
  return mkInterval(0, days, ms)
}

// --- field extraction & truncation -----------------------------------------
function dayOfYear(d: Date): number {
  return Math.floor((d.getTime() - Date.UTC(d.getUTCFullYear(), 0, 1)) / MS_PER_DAY) + 1
}
// ISO-8601 week number (weeks start Monday; week 1 holds the first Thursday).
function isoWeek(d: Date): number {
  const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()))
  const day = (t.getUTCDay() + 6) % 7
  t.setUTCDate(t.getUTCDate() - day + 3)
  const firstThu = new Date(Date.UTC(t.getUTCFullYear(), 0, 4))
  const fday = (firstThu.getUTCDay() + 6) % 7
  firstThu.setUTCDate(firstThu.getUTCDate() - fday + 3)
  return 1 + Math.round((t.getTime() - firstThu.getTime()) / (7 * MS_PER_DAY))
}

/** EXTRACT(field FROM temporal). Returns a number, or null for an unknown field. */
export function extractField(field: string, v: Temporal): number | null {
  const f = field.toLowerCase()
  if (v.t === 'interval') {
    switch (f) {
      case 'year': case 'years': return Math.trunc(v.months / 12)
      case 'month': case 'months': return v.months % 12
      case 'day': case 'days': return v.days
      case 'hour': case 'hours': return Math.trunc(v.ms / MS_PER_HOUR)
      case 'minute': case 'minutes': return Math.trunc(v.ms / MS_PER_MIN) % 60
      case 'second': case 'seconds': return (v.ms % MS_PER_MIN) / 1000
      case 'epoch': return temporalScalar(v) / 1000
      default: return null
    }
  }
  if (v.t === 'time') {
    switch (f) {
      case 'hour': case 'hours': return Math.trunc(v.ms / MS_PER_HOUR)
      case 'minute': case 'minutes': return Math.trunc(v.ms / MS_PER_MIN) % 60
      case 'second': case 'seconds': return (v.ms % MS_PER_MIN) / 1000
      case 'epoch': return v.ms / 1000
      default: return null
    }
  }
  const epochMs = v.t === 'date' ? v.days * MS_PER_DAY : v.ms
  const d = new Date(epochMs)
  switch (f) {
    case 'year': case 'years': case 'yyyy': case 'y': return d.getUTCFullYear()
    case 'month': case 'months': case 'mon': case 'mm': return d.getUTCMonth() + 1
    case 'day': case 'days': case 'dd': case 'd': return d.getUTCDate()
    case 'hour': case 'hours': case 'hh': return d.getUTCHours()
    case 'minute': case 'minutes': case 'mi': return d.getUTCMinutes()
    case 'second': case 'seconds': case 'ss': return d.getUTCSeconds() + d.getUTCMilliseconds() / 1000
    case 'millisecond': case 'milliseconds': return d.getUTCSeconds() * 1000 + d.getUTCMilliseconds()
    case 'dow': case 'weekday': return d.getUTCDay()
    case 'isodow': return ((d.getUTCDay() + 6) % 7) + 1
    case 'doy': return dayOfYear(d)
    case 'week': return isoWeek(d)
    case 'quarter': return Math.floor(d.getUTCMonth() / 3) + 1
    case 'decade': return Math.floor(d.getUTCFullYear() / 10)
    case 'century': return Math.floor((d.getUTCFullYear() - 1) / 100) + 1
    case 'epoch': return epochMs / 1000
    default: return null
  }
}

const TRUNC_ORDER = ['millennium', 'century', 'decade', 'year', 'quarter', 'month', 'week', 'day', 'hour', 'minute', 'second']

/** DATE_TRUNC(unit, ts): zero every field finer than `unit`. */
export function truncTimestamp(unit: string, v: DateValue | TimestampValue): Temporal {
  const u = unit.toLowerCase()
  if (!TRUNC_ORDER.includes(u)) return v
  const epochMs = v.t === 'date' ? v.days * MS_PER_DAY : v.ms
  const d = new Date(epochMs)
  let y = d.getUTCFullYear()
  let mon = d.getUTCMonth()
  let day = d.getUTCDate()
  let h = d.getUTCHours()
  let mi = d.getUTCMinutes()
  let s = d.getUTCSeconds()
  switch (u) {
    case 'millennium': y = Math.floor((y - 1) / 1000) * 1000 + 1; mon = 0; day = 1; h = mi = s = 0; break
    case 'century': y = Math.floor((y - 1) / 100) * 100 + 1; mon = 0; day = 1; h = mi = s = 0; break
    case 'decade': y = Math.floor(y / 10) * 10; mon = 0; day = 1; h = mi = s = 0; break
    case 'year': mon = 0; day = 1; h = mi = s = 0; break
    case 'quarter': mon = Math.floor(mon / 3) * 3; day = 1; h = mi = s = 0; break
    case 'month': day = 1; h = mi = s = 0; break
    case 'week': {
      // Truncate to the Monday at or before the date.
      const back = (d.getUTCDay() + 6) % 7
      const base = Date.UTC(y, mon, day) - back * MS_PER_DAY
      return v.t === 'date' ? mkDate(Math.floor(base / MS_PER_DAY)) : mkTimestamp(base)
    }
    case 'day': h = mi = s = 0; break
    case 'hour': mi = s = 0; break
    case 'minute': s = 0; break
    case 'second': break
  }
  const out = Date.UTC(y, mon, day, h, mi, s)
  return v.t === 'date' ? mkDate(Math.floor(out / MS_PER_DAY)) : mkTimestamp(out)
}

/** AGE(end, start): a calendar interval of whole years/months/days/time. */
export function ageInterval(end: TimestampValue | DateValue, start: TimestampValue | DateValue): IntervalValue {
  const e = new Date(end.t === 'date' ? end.days * MS_PER_DAY : end.ms)
  const s = new Date(start.t === 'date' ? start.days * MS_PER_DAY : start.ms)
  let ms = e.getUTCMilliseconds() - s.getUTCMilliseconds()
  let sec = e.getUTCSeconds() - s.getUTCSeconds()
  let min = e.getUTCMinutes() - s.getUTCMinutes()
  let hr = e.getUTCHours() - s.getUTCHours()
  let day = e.getUTCDate() - s.getUTCDate()
  let mon = e.getUTCMonth() - s.getUTCMonth()
  let yr = e.getUTCFullYear() - s.getUTCFullYear()
  if (ms < 0) { ms += 1000; sec-- }
  if (sec < 0) { sec += 60; min-- }
  if (min < 0) { min += 60; hr-- }
  if (hr < 0) { hr += 24; day-- }
  if (day < 0) { day += daysInMonth(s.getUTCFullYear(), s.getUTCMonth()); mon-- }
  if (mon < 0) { mon += 12; yr-- }
  return mkInterval(yr * 12 + mon, day, hr * MS_PER_HOUR + min * MS_PER_MIN + sec * MS_PER_SEC + ms)
}

// --- TO_CHAR: Postgres-style template formatting ----------------------------
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']
const MONTHS_ABBR = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']
const DAYS_ABBR = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

// Patterns are tried in this order (longest / most-specific first) so that, e.g.,
// `YYYY` wins over `YY` and `Month` over `Mon`.
const TO_CHAR_PATTERNS: [string, (d: Date) => string][] = [
  ['HH24', (d) => pad(d.getUTCHours())],
  ['HH12', (d) => pad(((d.getUTCHours() + 11) % 12) + 1)],
  ['YYYY', (d) => pad(d.getUTCFullYear(), 4)],
  ['MONTH', (d) => MONTHS[d.getUTCMonth()].toUpperCase()],
  ['Month', (d) => MONTHS[d.getUTCMonth()]],
  ['month', (d) => MONTHS[d.getUTCMonth()].toLowerCase()],
  ['DDD', (d) => pad(dayOfYear(d), 3)],
  ['DAY', (d) => DAYS[d.getUTCDay()].toUpperCase()],
  ['Day', (d) => DAYS[d.getUTCDay()]],
  ['day', (d) => DAYS[d.getUTCDay()].toLowerCase()],
  ['DY', (d) => DAYS_ABBR[d.getUTCDay()].toUpperCase()],
  ['Dy', (d) => DAYS_ABBR[d.getUTCDay()]],
  ['dy', (d) => DAYS_ABBR[d.getUTCDay()].toLowerCase()],
  ['MON', (d) => MONTHS_ABBR[d.getUTCMonth()].toUpperCase()],
  ['Mon', (d) => MONTHS_ABBR[d.getUTCMonth()]],
  ['mon', (d) => MONTHS_ABBR[d.getUTCMonth()].toLowerCase()],
  ['YYY', (d) => pad(d.getUTCFullYear() % 1000, 3)],
  ['AM', (d) => (d.getUTCHours() < 12 ? 'AM' : 'PM')],
  ['PM', (d) => (d.getUTCHours() < 12 ? 'AM' : 'PM')],
  ['am', (d) => (d.getUTCHours() < 12 ? 'am' : 'pm')],
  ['pm', (d) => (d.getUTCHours() < 12 ? 'am' : 'pm')],
  ['MS', (d) => pad(d.getUTCMilliseconds(), 3)],
  ['YY', (d) => pad(d.getUTCFullYear() % 100)],
  ['MM', (d) => pad(d.getUTCMonth() + 1)],
  ['DD', (d) => pad(d.getUTCDate())],
  ['HH', (d) => pad(((d.getUTCHours() + 11) % 12) + 1)],
  ['MI', (d) => pad(d.getUTCMinutes())],
  ['SS', (d) => pad(d.getUTCSeconds())],
  ['IW', (d) => pad(isoWeek(d))],
  ['WW', (d) => pad(Math.ceil(dayOfYear(d) / 7))],
  ['Q', (d) => String(Math.floor(d.getUTCMonth() / 3) + 1)],
  ['D', (d) => String(d.getUTCDay() + 1)],
  ['W', (d) => String(Math.floor((d.getUTCDate() - 1) / 7) + 1)],
  ['Y', (d) => String(d.getUTCFullYear() % 10)],
]

/** TO_CHAR(temporal, template) — Postgres-style date/time formatting. Text in
 *  double quotes is emitted literally; unmatched characters pass through. */
export function toChar(template: string, v: Temporal): string {
  if (v.t === 'interval') return formatInterval(v)
  const epochMs = v.t === 'date' ? v.days * MS_PER_DAY : v.ms
  const d = new Date(epochMs)
  let out = ''
  let i = 0
  while (i < template.length) {
    if (template[i] === '"') {
      i++
      while (i < template.length && template[i] !== '"') out += template[i++]
      i++
      continue
    }
    let matched = false
    for (const [pat, fn] of TO_CHAR_PATTERNS) {
      if (template.startsWith(pat, i)) {
        out += fn(d)
        i += pat.length
        matched = true
        break
      }
    }
    if (!matched) out += template[i++]
  }
  return out
}

export function makeDate(y: number, m: number, d: number): DateValue {
  return mkDate(Math.floor(Date.UTC(y, m - 1, d) / MS_PER_DAY))
}
export function makeTime(h: number, mi: number, s: number): TimeValue {
  return { t: 'time', ms: h * MS_PER_HOUR + mi * MS_PER_MIN + Math.round(s * MS_PER_SEC) }
}
export function makeTimestamp(y: number, mo: number, d: number, h: number, mi: number, s: number): TimestampValue {
  return mkTimestamp(Date.UTC(y, mo - 1, d, h, mi, Math.trunc(s), Math.round((s % 1) * 1000)))
}
