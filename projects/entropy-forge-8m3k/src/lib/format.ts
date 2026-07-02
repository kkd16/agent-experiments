// format.ts — small presentation helpers shared across pages.

/** Render a byte as a readable glyph: printable ASCII shown literally, else hex. */
export function byteGlyph(b: number): string {
  if (b === 32) return '␠' // visible space
  if (b === 10) return '⏎'
  if (b === 9) return '⇥'
  if (b >= 33 && b <= 126) return String.fromCharCode(b)
  return '·'
}

/** A short label for a byte value, e.g. 'A' or '0x0a'. */
export function byteLabel(b: number): string {
  if (b >= 33 && b <= 126) return String.fromCharCode(b)
  if (b === 32) return "'␠'"
  const names: Record<number, string> = { 10: '\\n', 13: '\\r', 9: '\\t', 0: '\\0' }
  return names[b] ?? '0x' + b.toString(16).padStart(2, '0')
}

export function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`
  return `${(n / 1024).toFixed(1)} KB`
}

export function fmtNum(n: number, digits = 2): string {
  return n.toLocaleString(undefined, { maximumFractionDigits: digits, minimumFractionDigits: digits })
}

export function pct(n: number, digits = 1): string {
  return `${(n * 100).toFixed(digits)}%`
}

/** A categorical color from the CSS series variables, cycling. */
export function seriesColor(i: number): string {
  return `var(--c${i % 7})`
}
