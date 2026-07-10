// Engineering-notation number formatting shared across panels.
export function fmtEng(x: number, unit = ''): string {
  if (!Number.isFinite(x)) return '—'
  const a = Math.abs(x)
  let s: string
  if (a === 0) s = '0'
  else if (a >= 1e9) s = (x / 1e9).toFixed(2) + 'G'
  else if (a >= 1e6) s = (x / 1e6).toFixed(2) + 'M'
  else if (a >= 1e3) s = (x / 1e3).toFixed(2) + 'k'
  else if (a >= 1) s = x.toFixed(2)
  else if (a >= 1e-3) s = (x * 1e3).toFixed(2) + 'm'
  else if (a >= 1e-6) s = (x * 1e6).toFixed(2) + 'µ'
  else s = x.toExponential(2)
  return unit ? `${s} ${unit}` : s
}
