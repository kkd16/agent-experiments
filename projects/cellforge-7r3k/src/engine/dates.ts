// A self-contained serial-date system, shared by the date/time functions and the
// date number formats. A "serial" is a number of days since the epoch 1899-12-30
// (so 1900-01-01 = 2, matching the convention spreadsheets use); the fractional
// part is the time of day (0.5 = noon). All conversions go through UTC so they are
// timezone-independent and perfectly reproducible.

const EPOCH = Date.UTC(1899, 11, 30) // 1899-12-30 00:00:00 UTC
const DAY_MS = 86_400_000

export interface DateParts {
  year: number
  month: number // 1-12
  day: number // 1-31
  weekday: number // 0 = Sunday .. 6 = Saturday
}

export interface TimeParts {
  hour: number
  minute: number
  second: number
}

/** Calendar date -> serial day number (whole number). `month` is 1-based. */
export function dateToSerial(year: number, month: number, day: number): number {
  const ms = Date.UTC(year, month - 1, day)
  return Math.round((ms - EPOCH) / DAY_MS)
}

/** Time of day -> fraction of a day in [0, 1). */
export function timeToFraction(hour: number, minute: number, second: number): number {
  return (hour * 3600 + minute * 60 + second) / 86400
}

/** Serial -> its calendar parts (uses the integer day part). */
export function serialToDate(serial: number): DateParts {
  const whole = Math.floor(serial)
  const dt = new Date(EPOCH + whole * DAY_MS)
  return {
    year: dt.getUTCFullYear(),
    month: dt.getUTCMonth() + 1,
    day: dt.getUTCDate(),
    weekday: dt.getUTCDay(),
  }
}

/** Serial -> its time-of-day parts (uses the fractional part). */
export function serialToTime(serial: number): TimeParts {
  let secs = Math.round((serial - Math.floor(serial)) * 86400)
  if (secs >= 86400) secs -= 86400
  return { hour: Math.floor(secs / 3600), minute: Math.floor((secs % 3600) / 60), second: secs % 60 }
}

const pad2 = (n: number) => String(n).padStart(2, '0')

export function formatDate(serial: number): string {
  const d = serialToDate(serial)
  return `${d.year}-${pad2(d.month)}-${pad2(d.day)}`
}

export function formatTime(serial: number): string {
  const t = serialToTime(serial)
  return `${pad2(t.hour)}:${pad2(t.minute)}:${pad2(t.second)}`
}

export function formatDateTime(serial: number): string {
  return `${formatDate(serial)} ${formatTime(serial)}`
}

/** Today's date as a serial (local calendar day, normalized to UTC midnight). */
export function todaySerial(now = new Date()): number {
  return dateToSerial(now.getFullYear(), now.getMonth() + 1, now.getDate())
}

/** The current moment as a serial including the time-of-day fraction. */
export function nowSerial(now = new Date()): number {
  return todaySerial(now) + timeToFraction(now.getHours(), now.getMinutes(), now.getSeconds())
}

const MONTHS_LONG = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']
const MONTHS_SHORT = MONTHS_LONG.map((m) => m.slice(0, 3))
const DAYS_LONG = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']
const DAYS_SHORT = DAYS_LONG.map((d) => d.slice(0, 3))

/**
 * Render a serial through a date/time format pattern (yyyy, yy, mmmm, mmm, mm, m,
 * dddd, ddd, dd, d, hh, h, ss, s, mm/m as minutes, AM/PM). A left-to-right scanner:
 * letter runs become tokens and everything else is a literal separator copied as-is.
 * The classic month-vs-minute `m` ambiguity is resolved by context: an `m` run that
 * follows an hour token, or precedes a seconds token, is minutes; otherwise month.
 */
export function formatSerialPattern(serial: number, pattern: string): string {
  const d = serialToDate(serial)
  const tm = serialToTime(serial)
  const ampm = /am\/pm|a\/p/i.test(pattern)
  const h12 = tm.hour % 12 === 0 ? 12 : tm.hour % 12

  type Tok = { kind: 'run'; ch: string; len: number } | { kind: 'lit'; text: string }
  const toks: Tok[] = []
  let i = 0
  while (i < pattern.length) {
    const c = pattern[i].toLowerCase()
    if (c === 'a' && /^am\/pm/i.test(pattern.slice(i))) {
      toks.push({ kind: 'run', ch: 'ampm', len: 5 })
      i += 5
      continue
    }
    if ('ymdhs'.includes(c)) {
      let j = i
      while (j < pattern.length && pattern[j].toLowerCase() === c) j++
      toks.push({ kind: 'run', ch: c, len: j - i })
      i = j
      continue
    }
    toks.push({ kind: 'lit', text: pattern[i] })
    i++
  }

  let lastWasHour = false
  let out = ''
  for (let k = 0; k < toks.length; k++) {
    const tok = toks[k]
    if (tok.kind === 'lit') {
      out += tok.text
      continue
    }
    const len = tok.len
    if (tok.ch === 'h') {
      out += len >= 2 ? pad2(ampm ? h12 : tm.hour) : String(ampm ? h12 : tm.hour)
      lastWasHour = true
      continue
    }
    switch (tok.ch) {
      case 'y':
        out += len <= 2 ? pad2(d.year % 100) : String(d.year)
        break
      case 'd':
        out += len >= 4 ? DAYS_LONG[d.weekday] : len === 3 ? DAYS_SHORT[d.weekday] : len === 2 ? pad2(d.day) : String(d.day)
        break
      case 's':
        out += len >= 2 ? pad2(tm.second) : String(tm.second)
        break
      case 'ampm':
        out += tm.hour < 12 ? 'AM' : 'PM'
        break
      case 'm': {
        const nextRun = toks.slice(k + 1).find((x): x is Extract<Tok, { kind: 'run' }> => x.kind === 'run')
        const isMinute = lastWasHour || nextRun?.ch === 's'
        if (isMinute) out += len >= 2 ? pad2(tm.minute) : String(tm.minute)
        else if (len >= 4) out += MONTHS_LONG[d.month - 1]
        else if (len === 3) out += MONTHS_SHORT[d.month - 1]
        else if (len === 2) out += pad2(d.month)
        else out += String(d.month)
        break
      }
    }
    lastWasHour = false
  }
  return out
}

/** Add `months` whole months to a serial, clamping the day to the target month. */
export function addMonths(serial: number, months: number): number {
  const d = serialToDate(serial)
  const targetMonthIndex = d.month - 1 + months
  const year = d.year + Math.floor(targetMonthIndex / 12)
  const month = ((targetMonthIndex % 12) + 12) % 12 // 0-based
  const lastDay = new Date(Date.UTC(year, month + 1, 0)).getUTCDate()
  const day = Math.min(d.day, lastDay)
  return dateToSerial(year, month + 1, day)
}

/** Serial of the last day of the month `months` away. */
export function endOfMonth(serial: number, months: number): number {
  const d = serialToDate(serial)
  const targetMonthIndex = d.month - 1 + months
  const year = d.year + Math.floor(targetMonthIndex / 12)
  const month = ((targetMonthIndex % 12) + 12) % 12
  const lastDay = new Date(Date.UTC(year, month + 1, 0)).getUTCDate()
  return dateToSerial(year, month + 1, lastDay)
}
