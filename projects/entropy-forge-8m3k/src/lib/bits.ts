// bits.ts — MSB-first bit I/O over a growable byte buffer.
//
// Every codec in this lab ultimately produces bytes; these two classes are the
// substrate. BitWriter packs bits into bytes most-significant-bit first (the
// convention DEFLATE's Huffman streams do NOT use, but the one that is easiest
// to reason about and to render as a bit string). BitReader is its exact
// inverse. Round-tripping any sequence of writeBit/writeBits through the
// matching reads reproduces it bit-for-bit — the invariant every codec relies on.

export class BitWriter {
  private bytes: number[] = []
  private cur = 0 // accumulator for the byte in progress
  private nbits = 0 // number of bits currently in `cur` (0..7)
  private total = 0 // total bits written, for exact accounting

  /** Append a single bit (0 or 1). */
  writeBit(bit: number): void {
    this.cur = (this.cur << 1) | (bit & 1)
    this.nbits++
    this.total++
    if (this.nbits === 8) {
      this.bytes.push(this.cur)
      this.cur = 0
      this.nbits = 0
    }
  }

  /** Append the low `count` bits of `value`, MSB first. */
  writeBits(value: number, count: number): void {
    for (let i = count - 1; i >= 0; i--) {
      this.writeBit((value >>> i) & 1)
    }
  }

  /** Total number of bits written so far (before padding). */
  get bitLength(): number {
    return this.total
  }

  /** Finalize: pad the final partial byte with zeros and return the bytes. */
  finish(): Uint8Array {
    if (this.nbits > 0) {
      this.cur = this.cur << (8 - this.nbits)
      this.bytes.push(this.cur)
      this.cur = 0
      this.nbits = 0
    }
    return Uint8Array.from(this.bytes)
  }

  /** Render everything written so far as a '0'/'1' string (for visualisation). */
  toBitString(): string {
    let s = ''
    for (const b of this.bytes) s += b.toString(2).padStart(8, '0')
    if (this.nbits > 0) {
      s += (this.cur & ((1 << this.nbits) - 1)).toString(2).padStart(this.nbits, '0')
    }
    return s
  }
}

export class BitReader {
  private pos = 0 // bit position
  private data: Uint8Array

  constructor(data: Uint8Array) {
    this.data = data
  }

  /** Read one bit; reads past the end return 0 (streams are self-terminating). */
  readBit(): number {
    const byteIndex = this.pos >>> 3
    if (byteIndex >= this.data.length) {
      this.pos++
      return 0
    }
    const bitIndex = 7 - (this.pos & 7)
    this.pos++
    return (this.data[byteIndex] >>> bitIndex) & 1
  }

  /** Read `count` bits MSB-first into an unsigned integer. */
  readBits(count: number): number {
    let v = 0
    for (let i = 0; i < count; i++) v = (v << 1) | this.readBit()
    return v >>> 0
  }

  get bitPos(): number {
    return this.pos
  }

  get exhausted(): boolean {
    return this.pos >= this.data.length * 8
  }
}

/** Convert a JS string to bytes via UTF-8. */
export function strToBytes(s: string): Uint8Array {
  return new TextEncoder().encode(s)
}

/** Convert bytes back to a string via UTF-8. */
export function bytesToStr(b: Uint8Array): string {
  return new TextDecoder().decode(b)
}

/** Compare two byte arrays for exact equality. */
export function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false
  return true
}
