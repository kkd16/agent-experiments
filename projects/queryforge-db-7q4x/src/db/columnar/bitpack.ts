// A genuine, byte-level bit-packer — the substrate every numeric column
// encoding in the column store rides on. Given a run of non-negative integers
// that each fit in `width` bits, `packBits` writes them **LSB-first** into a
// tight `Uint8Array` (⌈n·width/8⌉ bytes, no per-value byte alignment waste);
// `unpackBits` reads them straight back. This is exactly how Parquet/ORC store
// dictionary codes and frame-of-reference residuals: the whole compression win
// of "these values only span 9 bits, don't spend 32 on each" is realised here.
//
// Widths up to 53 are supported (JS integers are exact to 2^53), so we pack a
// bit at a time using float arithmetic rather than 32-bit bit-ops — correct
// past the 32-bit boundary a naive `<<` would silently corrupt. For the small
// group sizes a column store uses (≤ a few thousand rows) this is plenty fast,
// and it is the honest, verifiable artifact: a real bitstream, not a JS array
// pretending to be bytes.

/** Number of bits needed to represent every integer in `[0, maxValue]`.
 *  `bitsFor(0) === 0` (a column of all-equal values needs no residual bits at
 *  all — the value lives in the frame-of-reference base). */
export function bitsFor(maxValue: number): number {
  if (maxValue <= 0) return 0
  let w = 0
  let m = maxValue
  while (m > 0) {
    m = Math.floor(m / 2)
    w++
  }
  return w
}

/** ZigZag-map a signed integer to a non-negative one (so deltas that can go
 *  negative still bit-pack): 0,-1,1,-2,2,… → 0,1,2,3,4,… */
export function zigzag(n: number): number {
  return n < 0 ? -2 * n - 1 : 2 * n
}

/** Inverse of {@link zigzag}. */
export function unzigzag(z: number): number {
  return z % 2 === 0 ? z / 2 : -(z + 1) / 2
}

/** Pack `values` (each in `[0, 2^width)`) LSB-first into a tight byte array. */
export function packBits(values: number[], width: number): Uint8Array {
  if (width === 0) return new Uint8Array(0) // every value is 0 — nothing to store
  const totalBits = values.length * width
  const bytes = new Uint8Array((totalBits + 7) >> 3)
  let bitPos = 0
  for (const v of values) {
    let val = v
    for (let b = 0; b < width; b++) {
      if (val % 2 === 1) {
        bytes[bitPos >> 3] |= 1 << (bitPos & 7)
      }
      val = Math.floor(val / 2)
      bitPos++
    }
  }
  return bytes
}

/** Read `count` `width`-bit values back out of a {@link packBits} stream. */
export function unpackBits(bytes: Uint8Array, width: number, count: number): number[] {
  const out = new Array<number>(count)
  if (width === 0) {
    out.fill(0)
    return out
  }
  let bitPos = 0
  for (let i = 0; i < count; i++) {
    let val = 0
    let scale = 1
    for (let b = 0; b < width; b++) {
      if ((bytes[bitPos >> 3] >> (bitPos & 7)) & 1) val += scale
      scale *= 2
      bitPos++
    }
    out[i] = val
  }
  return out
}

/** Random-access read of the `i`-th `width`-bit value (no full unpack). This is
 *  what makes **late materialization** cheap: a projected column is decoded only
 *  at the row offsets that survived the predicate, never the whole chunk. */
export function readAt(bytes: Uint8Array, width: number, i: number): number {
  if (width === 0) return 0
  let bitPos = i * width
  let val = 0
  let scale = 1
  for (let b = 0; b < width; b++) {
    if ((bytes[bitPos >> 3] >> (bitPos & 7)) & 1) val += scale
    scale *= 2
    bitPos++
  }
  return val
}
