// Turn a recorded logic-analyzer trace into CSV text. Kept pure (no DOM) so it
// can be unit-tested; the download itself lives in the Analyzer component.
import type { Probe, TraceSample } from './engine'

/** Quote a header cell if it contains a comma, quote or newline (RFC 4180). */
function csvCell(s: string): string {
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

/**
 * Build a CSV whose first column is `time` (seconds) and one further column per
 * probe, each cell a 0 or 1. Duplicate probe labels are disambiguated so the
 * header stays unique.
 */
export function traceToCsv(probes: Probe[], samples: TraceSample[]): string {
  const seen = new Map<string, number>()
  const headers = probes.map((p) => {
    const n = (seen.get(p.label) ?? 0) + 1
    seen.set(p.label, n)
    return csvCell(n === 1 ? p.label : `${p.label}_${n}`)
  })
  const lines = [['time', ...headers].join(',')]
  for (const s of samples) {
    lines.push([s.t.toFixed(4), ...s.v.map((b) => (b ? '1' : '0'))].join(','))
  }
  return lines.join('\n')
}
