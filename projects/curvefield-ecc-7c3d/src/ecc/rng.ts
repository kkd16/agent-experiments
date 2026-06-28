// Randomness, defensively. The catalog renders project thumbnails in a sandboxed
// iframe where crypto.getRandomValues may be unavailable; we wrap it in try/catch
// and fall back to a seeded xorshift so the UI never throws on load. The seeded
// path is clearly labelled in the UI and never presented as cryptographic.

let seed = 0x9e3779b9 >>> 0

/** Seed the deterministic fallback PRNG (for reproducible demos). */
export function seedRng(s: number): void {
  seed = (s >>> 0) || 1
}

function xorshift32(): number {
  seed ^= seed << 13
  seed ^= seed >>> 17
  seed ^= seed << 5
  seed >>>= 0
  return seed
}

/** Fill `out` with random bytes, preferring the platform CSPRNG. */
export function randomBytes(len: number): Uint8Array {
  const out = new Uint8Array(len)
  try {
    const g = globalThis as unknown as { crypto?: Crypto }
    if (g.crypto && typeof g.crypto.getRandomValues === 'function') {
      g.crypto.getRandomValues(out)
      return out
    }
  } catch {
    // fall through to the seeded path
  }
  for (let i = 0; i < len; i++) out[i] = xorshift32() & 0xff
  return out
}

/** True iff the platform CSPRNG is available (so the UI can flag weak randomness). */
export function hasSecureRandom(): boolean {
  try {
    const g = globalThis as unknown as { crypto?: Crypto }
    return !!(g.crypto && typeof g.crypto.getRandomValues === 'function')
  } catch {
    return false
  }
}

/** A uniform scalar in [1, max), rejection-sampled to avoid modulo bias. */
export function randomScalar(max: bigint): bigint {
  const byteLen = (max.toString(16).length + 1) >> 1
  for (let tries = 0; tries < 1000; tries++) {
    let n = 0n
    for (const b of randomBytes(byteLen)) n = (n << 8n) | BigInt(b)
    n %= max
    if (n >= 1n) return n
  }
  return 1n
}
