// deflateBits.ts — the bit-packing substrate DEFLATE actually uses, plus the
// canonical-Huffman machinery its Huffman codes obey.
//
// DEFLATE has an unusual, easy-to-get-wrong bit order (§3.1.1): plain data
// elements pack *least-significant bit first* into each byte, BUT Huffman codes
// pack *most-significant bit first*. The lab's own `bits.ts` is uniformly
// MSB-first, so DEFLATE needs its own reader/writer. Getting this exactly right is
// what lets our output feed the browser's native gunzip and vice-versa.

// ---- writer: LSB-first bit accumulation ----
export class DeflateWriter {
  private out: number[] = []
  private acc = 0
  private nbits = 0

  /** Write the low `count` bits of `value`, least-significant bit first. */
  bits(value: number, count: number): void {
    // Keep `acc` under a byte between calls; count ≤ 16 and nbits ≤ 7, so the
    // running accumulator never exceeds 23 bits — safe in a 32-bit int.
    this.acc |= (value & ((1 << count) - 1)) << this.nbits
    this.nbits += count
    while (this.nbits >= 8) {
      this.out.push(this.acc & 0xff)
      this.acc >>>= 8
      this.nbits -= 8
    }
  }

  /**
   * Write a Huffman code of `len` bits. Canonical codes are numbered MSB-first,
   * but the stream is LSB-first, so the code's bits must be reversed before they
   * go out — the single most common DEFLATE implementation bug.
   */
  huff(code: number, len: number): void {
    let rev = 0
    for (let i = 0; i < len; i++) rev = (rev << 1) | ((code >>> i) & 1)
    this.bits(rev, len)
  }

  /** Skip to the next byte boundary (stored blocks are byte-aligned). */
  align(): void {
    if (this.nbits > 0) {
      this.out.push(this.acc & 0xff)
      this.acc = 0
      this.nbits = 0
    }
  }

  get bitLength(): number {
    return this.out.length * 8 + this.nbits
  }

  finish(): Uint8Array {
    this.align()
    return Uint8Array.from(this.out)
  }
}

// ---- reader: LSB-first, the exact inverse ----
export class DeflateReader {
  private data: Uint8Array
  private byte = 0
  private bit = 0

  constructor(data: Uint8Array, byteOffset = 0) {
    this.data = data
    this.byte = byteOffset
  }

  /** Read `count` bits, least-significant bit first, as an unsigned integer. */
  bits(count: number): number {
    let v = 0
    for (let i = 0; i < count; i++) {
      const b = (this.data[this.byte] >>> this.bit) & 1
      this.bit++
      if (this.bit === 8) {
        this.bit = 0
        this.byte++
      }
      v |= b << i
    }
    return v >>> 0
  }

  /** Discard bits up to the next byte boundary. */
  align(): void {
    if (this.bit !== 0) {
      this.bit = 0
      this.byte++
    }
  }

  /** Copy `n` whole bytes verbatim (used by stored blocks after align()). */
  bytes(n: number): Uint8Array {
    const out = this.data.subarray(this.byte, this.byte + n)
    this.byte += n
    return out
  }

  get bytePos(): number {
    return this.byte
  }
  get atEnd(): boolean {
    return this.byte >= this.data.length
  }
}

// ---- canonical Huffman: lengths → codes, and a decode table ----
//
// RFC 1951 §3.2.2 fixes a *canonical* assignment: given only the bit-length of
// each symbol, both sides derive identical codes by (1) counting symbols per
// length, (2) giving each length a starting code so that shorter codes sort
// before longer ones, (3) handing consecutive codes to symbols in symbol order.
// So the dynamic header need only transmit lengths — the codes fall out.

export const MAX_BITS = 15

/** Canonical codes from a length-per-symbol array (0 = symbol unused). */
export function canonicalFromLengths(lengths: number[]): Uint16Array {
  const blCount = new Array(MAX_BITS + 1).fill(0)
  for (const l of lengths) if (l > 0) blCount[l]++
  const nextCode = new Array(MAX_BITS + 1).fill(0)
  let code = 0
  for (let bits = 1; bits <= MAX_BITS; bits++) {
    code = (code + blCount[bits - 1]) << 1
    nextCode[bits] = code
  }
  const codes = new Uint16Array(lengths.length)
  for (let sym = 0; sym < lengths.length; sym++) {
    const l = lengths[sym]
    if (l > 0) codes[sym] = nextCode[l]++
  }
  return codes
}

// A compact canonical decoder (the classic "count/symbol" tables from zlib's
// puff.c). `counts[len]` = how many codes are `len` bits; `symbols` lists the
// symbols sorted by (length, symbol). decode() walks one bit at a time, which is
// all a teaching decoder needs.
export interface HuffTree {
  counts: Int32Array
  symbols: Int32Array
}

export function buildDecoder(lengths: number[]): HuffTree {
  const counts = new Int32Array(MAX_BITS + 1)
  for (const l of lengths) counts[l]++
  counts[0] = 0
  const offsets = new Int32Array(MAX_BITS + 2)
  for (let len = 1; len <= MAX_BITS; len++) offsets[len + 1] = offsets[len] + counts[len]
  const symbols = new Int32Array(lengths.length)
  for (let sym = 0; sym < lengths.length; sym++) {
    if (lengths[sym] > 0) symbols[offsets[lengths[sym]]++] = sym
  }
  return { counts, symbols }
}

/** Decode one symbol from the reader using a HuffTree; throws on an invalid code. */
export function decodeSym(r: DeflateReader, tree: HuffTree): number {
  let code = 0
  let first = 0
  let index = 0
  for (let len = 1; len <= MAX_BITS; len++) {
    code |= r.bits(1)
    const count = tree.counts[len]
    if (code - first < count) return tree.symbols[index + (code - first)]
    index += count
    first = (first + count) << 1
    code <<= 1
  }
  throw new Error('invalid Huffman code (over-subscribed or corrupt stream)')
}
