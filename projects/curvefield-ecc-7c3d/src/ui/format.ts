// Small formatting helpers shared across the lab pages.

/** Lowercase hex of a bigint, optionally zero-padded to `width` hex digits. */
export function hex(n: bigint, width = 0): string {
  const s = (n < 0n ? -n : n).toString(16)
  return (n < 0n ? '-0x' : '0x') + (width ? s.padStart(width, '0') : s)
}

/** Shorten a long hex/string for compact display: 0xabcd…ef01. */
export function ellipsize(s: string, head = 10, tail = 6): string {
  if (s.length <= head + tail + 1) return s
  return `${s.slice(0, head)}…${s.slice(-tail)}`
}

/** Group a hex string into space-separated bytes for readability. */
export function spaceHex(s: string): string {
  const clean = s.replace(/^0x/, '')
  return (clean.match(/.{1,2}/g) ?? []).join(' ')
}
