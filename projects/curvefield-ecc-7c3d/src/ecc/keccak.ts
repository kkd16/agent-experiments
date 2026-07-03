// Keccak-f[1600] and the SHA-3 / SHAKE family (FIPS 202), from scratch.
//
// The whole lattice stack in this lab — ML-KEM's matrix expansion, its noise
// PRF, and the three FO/KDF hashes — is built on Keccak, so it needs a real
// sponge. JavaScript has no 64-bit integer ALU, so each of the 25 lanes is a
// BigInt masked to 64 bits: clear and obviously correct, which matters more for
// a teaching engine than raw throughput. Validated in the self-test against the
// canonical FIPS 202 digests (SHA3-256/512 and the SHAKE XOFs of "", "abc").

const MASK64 = (1n << 64n) - 1n

// Iota round constants (24 rounds of Keccak-f[1600]).
const RC: bigint[] = [
  0x0000000000000001n, 0x0000000000008082n, 0x800000000000808an, 0x8000000080008000n,
  0x000000000000808bn, 0x0000000080000001n, 0x8000000080008081n, 0x8000000000008009n,
  0x000000000000008an, 0x0000000000000088n, 0x0000000080008009n, 0x000000008000000an,
  0x000000008000808bn, 0x800000000000008bn, 0x8000000000008089n, 0x8000000000008003n,
  0x8000000000008002n, 0x8000000000000080n, 0x000000000000800an, 0x800000008000000an,
  0x8000000080008081n, 0x8000000000008080n, 0x0000000080000001n, 0x8000000080008008n,
]

// ρ rotation offsets and the π lane permutation, generated from the canonical
// (x, y) ← (y, 2x+3y) walk so there is nothing to mistranscribe. Lane (x, y)
// lives at index x + 5y.
const RHO = new Array<number>(25).fill(0)
const PI_DST = new Array<number>(25).fill(0)
;(() => {
  let x = 1
  let y = 0
  for (let t = 0; t < 24; t++) {
    const src = x + 5 * y
    RHO[src] = ((((t + 1) * (t + 2)) / 2) % 64 + 64) % 64
    PI_DST[src] = y + 5 * ((2 * x + 3 * y) % 5)
    const nx = y
    const ny = (2 * x + 3 * y) % 5
    x = nx
    y = ny
  }
})()

const rotl = (v: bigint, n: number): bigint => {
  if (n === 0) return v & MASK64
  return ((v << BigInt(n)) | (v >> BigInt(64 - n))) & MASK64
}

/** The Keccak-f[1600] permutation, in place on 25 BigInt lanes. */
function keccakF(A: bigint[]): void {
  for (let round = 0; round < 24; round++) {
    // θ — parity of each column, diffused across the two neighbouring columns.
    const C = new Array<bigint>(5)
    for (let xx = 0; xx < 5; xx++) C[xx] = A[xx] ^ A[xx + 5] ^ A[xx + 10] ^ A[xx + 15] ^ A[xx + 20]
    const D = new Array<bigint>(5)
    for (let xx = 0; xx < 5; xx++) D[xx] = C[(xx + 4) % 5] ^ rotl(C[(xx + 1) % 5], 1)
    for (let xx = 0; xx < 5; xx++) for (let yy = 0; yy < 5; yy++) A[xx + 5 * yy] ^= D[xx]

    // ρ (per-lane rotation) followed by π (lane transposition), fused.
    const B = new Array<bigint>(25).fill(0n)
    for (let i = 0; i < 25; i++) B[PI_DST[i]] = rotl(A[i], RHO[i])

    // χ — the only non-linear step: a row-wise NOT-AND across three lanes.
    for (let yy = 0; yy < 5; yy++) {
      const r = 5 * yy
      for (let xx = 0; xx < 5; xx++) {
        A[r + xx] = B[r + xx] ^ ((~B[r + ((xx + 1) % 5)] & MASK64) & B[r + ((xx + 2) % 5)])
      }
    }

    // ι — break the round symmetry.
    A[0] ^= RC[round]
  }
}

/**
 * A Keccak sponge that can keep squeezing — the streaming form ML-KEM's matrix
 * rejection sampler leans on. `suffix` is the domain-separation/pad-start byte
 * (0x06 for SHA-3, 0x1f for SHAKE); the multi-rate pad10*1 is applied here. The
 * first rate block is available immediately after absorption (no extra
 * permutation), so we prime the output buffer lazily on the first `read`, then
 * extract-then-permute for every block after it.
 */
function makeSponge(rateBytes: number, input: Uint8Array, suffix: number): { read: (n: number) => Uint8Array } {
  const A = new Array<bigint>(25).fill(0n)
  const rateLanes = rateBytes >> 3
  const absorb = (blk: Uint8Array) => {
    for (let i = 0; i < rateLanes; i++) {
      let lane = 0n
      for (let b = 7; b >= 0; b--) lane = (lane << 8n) | BigInt(blk[i * 8 + b])
      A[i] ^= lane
    }
    keccakF(A)
  }
  let i = 0
  for (; i + rateBytes <= input.length; i += rateBytes) absorb(input.subarray(i, i + rateBytes))
  const last = new Uint8Array(rateBytes)
  last.set(input.subarray(i))
  last[input.length - i] = suffix
  last[rateBytes - 1] |= 0x80
  absorb(last)

  const block = new Uint8Array(rateBytes)
  let pos = rateBytes // force a refill on first read
  let primed = false
  const refill = () => {
    for (let l = 0; l < rateLanes; l++) {
      const lane = A[l]
      for (let b = 0; b < 8; b++) block[l * 8 + b] = Number((lane >> BigInt(8 * b)) & 0xffn)
    }
    pos = 0
    keccakF(A)
  }
  return {
    read(n: number): Uint8Array {
      if (!primed) {
        refill()
        primed = true
      }
      const out = new Uint8Array(n)
      for (let k = 0; k < n; k++) {
        if (pos >= rateBytes) refill()
        out[k] = block[pos++]
      }
      return out
    },
  }
}

function keccak(rateBytes: number, input: Uint8Array, suffix: number, outLen: number): Uint8Array {
  return makeSponge(rateBytes, input, suffix).read(outLen)
}

/** SHA3-256 (FIPS 202): 32-byte digest, rate 1088 bits. */
export function sha3_256(m: Uint8Array): Uint8Array {
  return keccak(136, m, 0x06, 32)
}

/** SHA3-512 (FIPS 202): 64-byte digest, rate 576 bits. */
export function sha3_512(m: Uint8Array): Uint8Array {
  return keccak(72, m, 0x06, 64)
}

/** SHAKE128 (FIPS 202) extendable-output function, `outLen` bytes. */
export function shake128(m: Uint8Array, outLen: number): Uint8Array {
  return keccak(168, m, 0x1f, outLen)
}

/** SHAKE256 (FIPS 202) extendable-output function, `outLen` bytes. */
export function shake256(m: Uint8Array, outLen: number): Uint8Array {
  return keccak(136, m, 0x1f, outLen)
}

/** A streaming SHAKE128 XOF — read arbitrarily many bytes on demand. */
export function shake128Xof(m: Uint8Array): { read: (n: number) => Uint8Array } {
  return makeSponge(168, m, 0x1f)
}
