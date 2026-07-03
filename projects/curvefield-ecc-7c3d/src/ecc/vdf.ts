// Verifiable Delay Functions (VDFs) — proof-of-sequential-time.
//
// A VDF is a function whose evaluation is *inherently sequential* — it takes a
// prescribed number of steps T that no amount of parallelism can shorten — yet
// whose output can be *verified* almost instantly. It is the time-analogue of a
// VRF: where a VRF makes randomness unpredictable-but-checkable, a VDF makes
// *elapsed sequential work* unforgeable-but-checkable. That is exactly what an
// unbiasable randomness beacon needs (Chia's consensus, Ethereum's planned
// RANDAO+VDF): a value nobody can compute early and nobody can bias, because
// producing it demonstrably took real wall-clock time.
//
// The canonical construction squares in a group of *unknown order*:
//
//     y = x^(2^T) mod N          (T sequential squarings — the delay)
//
// Squaring cannot be parallelised (each square needs the previous one) and,
// without knowing the group order, cannot be shortcut. Over an RSA modulus
// N = p·q the order of the group is φ(N) = (p−1)(q−1); anyone who knows the
// factorisation can jump straight to the answer via e = 2^T mod φ(N) — which is
// exactly why the modulus must be a number whose factorisation *nobody* knows
// (an RSA challenge modulus, or a class group of an imaginary quadratic order,
// which needs no trusted setup at all). This lab uses a modulus with a *known*
// factorisation on purpose: it lets us show both the honest slow grind and the
// trapdoor shortcut side by side, and it powers the time-lock puzzle.
//
// Two proof systems certify y = x^(2^T) without the verifier repeating the T
// squarings:
//   • Wesolowski (2019) — a *single* group element π. Verify is one exponentiation
//     by a ~128-bit Fiat–Shamir prime ℓ. O(1) proof, O(1) verify.
//   • Pietrzak (2019) — an interactive halving protocol made non-interactive by
//     Fiat–Shamir: log₂T group elements. Cheaper to prove, larger proof.
//
// Everything is native BigInt, zero dependencies, and cross-checked on the
// Self-Test page against the trapdoor evaluation and against forgery.

import { mod, modPow, modInv } from './field'
import { sha256, concat, utf8, bigToBytes, bytesToBig } from './sha256'

// ── The group ─────────────────────────────────────────────────────────────
// A fixed demo RSA modulus N = p·q, both p ≡ q ≡ 3 (mod 4) (a Blum integer), so
// squaring is a permutation on the quadratic residues and −1 is a non-residue.
// The factors are published here ONLY so the lab can demonstrate the trapdoor
// shortcut and lock time-capsules quickly; a real VDF modulus hides them.
export const RSA = {
  p: 0xd41e5f0a9b3c7e21f6a8d90b45e2c1739f80abcd6e5f4321a0b9c8d7e6f5a5e3n,
  q: 0xc0ffee1234567890fedcba0987654321a1b2c3d4e5f60718293a4b5c6d7e8ff3n,
  get N(): bigint {
    return this.p * this.q
  },
  get phi(): bigint {
    return (this.p - 1n) * (this.q - 1n)
  },
}

/** Byte length of the modulus, for fixed-width serialization in transcripts. */
function byteLen(N: bigint): number {
  return Math.ceil(N.toString(16).length / 2)
}

/** Number of bits in n (n ≥ 0). */
export function bitLength(n: bigint): number {
  return n <= 0n ? 0 : n.toString(2).length
}

// ── Landing in the group of quadratic residues QR_N ─────────────────────────
// Squaring any base lands in QR_N, a cyclic-ish subgroup with no element of
// order 2 other than the identity. Pietrzak's soundness is cleanest there (it
// rules out the ±1 low-order sabotage), so every statement in this module uses
// a QR generator x = seed² mod N.
export function toGenerator(seed: bigint, N: bigint): bigint {
  const s = mod(seed, N)
  return (s * s) % N
}

/** Map arbitrary bytes to a QR_N group element (for beacons / hash inputs). */
export function hashToGroup(bytes: Uint8Array, N: bigint): bigint {
  const h = bytesToBig(sha256(concat(utf8('curvefield/vdf/h2g'), bytes)))
  return toGenerator(mod(h, N) + 2n, N)
}

// ── The delay: y = x^(2^T) mod N by T sequential squarings ───────────────────
/** Honest evaluation — T squarings, the work no shortcut can avoid. */
export function evalVDF(x: bigint, T: number, N: bigint): bigint {
  let y = mod(x, N)
  for (let i = 0; i < T; i++) y = (y * y) % N
  return y
}

/**
 * Trapdoor evaluation — the same y in O(log T) using the group order.
 * e = 2^T mod φ(N), then y = x^e. Only the party who knows the factorisation
 * can do this; its existence is the whole reason the modulus must be opaque.
 */
export function evalTrapdoor(x: bigint, T: number, N: bigint, phi: bigint): bigint {
  const e = modPow(2n, BigInt(T), phi)
  return modPow(mod(x, N), e, N)
}

// ── Fiat–Shamir: hashing group elements to a challenge ───────────────────────
function fsBytes(N: bigint, label: string, ...vals: bigint[]): Uint8Array {
  const L = byteLen(N)
  const parts = [utf8('curvefield/vdf/' + label)]
  for (const v of vals) parts.push(bigToBytes(mod(v, N), L))
  return sha256(concat(...parts))
}

// A 128-bit non-zero challenge scalar (Pietrzak's r_i, and the beacon mix).
function challengeScalar(N: bigint, ...vals: bigint[]): bigint {
  const h = bytesToBig(fsBytes(N, 'chal', ...vals))
  return (h & ((1n << 128n) - 1n)) + 1n
}

// ── Deterministic hash-to-prime (for Wesolowski's ℓ) ─────────────────────────
const SMALL_PRIMES = [2n, 3n, 5n, 7n, 11n, 13n, 17n, 19n, 23n, 29n, 31n, 37n]

/** Miller–Rabin with a fixed strong-witness set (deterministic, so Fiat–Shamir
 * agrees on ℓ). The first 12 primes are a proven witness set well past 3·10²⁴,
 * far beyond the ~128-bit ℓ used here. */
export function isProbablePrime(n: bigint): boolean {
  if (n < 2n) return false
  for (const p of SMALL_PRIMES) {
    if (n % p === 0n) return n === p
  }
  let d = n - 1n
  let r = 0n
  while (d % 2n === 0n) {
    d /= 2n
    r++
  }
  for (const a of SMALL_PRIMES) {
    let x = modPow(a, d, n)
    if (x === 1n || x === n - 1n) continue
    let composite = true
    for (let i = 1n; i < r; i++) {
      x = (x * x) % n
      if (x === n - 1n) {
        composite = false
        break
      }
    }
    if (composite) return false
  }
  return true
}

/**
 * Hash a transcript to a prime of `bits` bits. We seed a counter-mode hash, set
 * the top and bottom bits (odd, full width), and step upward to the next prime.
 * Deterministic in its inputs, so prover and verifier derive the same ℓ.
 */
export function hashToPrime(seed: Uint8Array, bits = 128): bigint {
  const bytesNeeded = Math.ceil(bits / 8)
  for (let ctr = 0; ctr < 1 << 20; ctr++) {
    const blocks: Uint8Array[] = []
    for (let i = 0; blocks.reduce((n, b) => n + b.length, 0) < bytesNeeded; i++) {
      blocks.push(sha256(concat(seed, bigToBytes(BigInt(ctr), 4), bigToBytes(BigInt(i), 4))))
    }
    let cand = bytesToBig(concat(...blocks)) & ((1n << BigInt(bits)) - 1n)
    cand |= 1n | (1n << BigInt(bits - 1)) // odd, top bit set
    // walk up to the next prime; cap the walk so a bad block just tries again
    for (let step = 0; step < 4096; step++, cand += 2n) {
      if (isProbablePrime(cand)) return cand
    }
  }
  throw new Error('hashToPrime: exhausted counter')
}

// ── Wesolowski proof (succinct, O(1)) ────────────────────────────────────────
export interface WesolowskiProof {
  ell: bigint // the Fiat–Shamir prime challenge
  pi: bigint // π = x^⌊2^T/ℓ⌋ mod N
}

/** ℓ = Hprime(N ‖ x ‖ y ‖ T): a ~128-bit prime the prover cannot choose. */
export function wesolowskiChallenge(N: bigint, x: bigint, y: bigint, T: number, bits = 128): bigint {
  const seed = fsBytes(N, 'wesolowski/' + T, x, y)
  return hashToPrime(seed, bits)
}

/**
 * Prove y = x^(2^T). q = ⌊2^T/ℓ⌋, r = 2^T mod ℓ, so 2^T = qℓ + r and
 * π = x^q. The verifier then checks π^ℓ · x^r = x^(qℓ+r) = y.
 * Forming 2^T as a big integer is fine for the demo's bounded T.
 */
export function wesolowskiProve(x: bigint, T: number, N: bigint, y?: bigint): WesolowskiProof {
  const Y = y ?? evalVDF(x, T, N)
  const ell = wesolowskiChallenge(N, x, Y, T)
  const twoT = 1n << BigInt(T)
  const q = twoT / ell
  const pi = modPow(mod(x, N), q, N)
  return { ell, pi }
}

/**
 * Streaming prover — the same π = x^⌊2^T/ℓ⌋ in O(1) memory, WITHOUT ever forming
 * the T-bit integer 2^T. This is the trick that makes Wesolowski practical for
 * the huge T a real VDF uses. Track rᵢ = 2^i mod ℓ; the i-th quotient bit is
 * bᵢ = ⌊2·rᵢ₋₁/ℓ⌋ ∈ {0,1}, and π accumulates as π ← π²·x^(bᵢ). One can show the
 * final exponent telescopes to exactly ⌊2^T/ℓ⌋ (proof: eₜ = Σbᵢ2^(T−i) = Q_T).
 * Two O(T) passes (one to get y for ℓ, one to build π), constant extra space.
 */
export function wesolowskiProveStreaming(x: bigint, T: number, N: bigint, y?: bigint): WesolowskiProof {
  const base = mod(x, N)
  const Y = y ?? evalVDF(base, T, N)
  const ell = wesolowskiChallenge(N, base, Y, T)
  let pi = 1n
  let r = 1n
  for (let i = 0; i < T; i++) {
    const rp = r << 1n
    const bit = rp >= ell
    r = bit ? rp - ell : rp
    pi = (pi * pi) % N
    if (bit) pi = (pi * base) % N
  }
  return { ell, pi }
}

/** Verify with a single exponentiation by ℓ (plus r = 2^T mod ℓ, computed fast). */
export function wesolowskiVerify(x: bigint, y: bigint, T: number, N: bigint, proof: WesolowskiProof): boolean {
  const ell = wesolowskiChallenge(N, x, y, T)
  if (ell !== proof.ell) return false // ℓ is bound to (x,y,T); a mismatch is a forgery
  const r = modPow(2n, BigInt(T), ell)
  const lhs = (modPow(proof.pi, ell, N) * modPow(mod(x, N), r, N)) % N
  return lhs === mod(y, N)
}

// ── Pietrzak proof (halving, O(log T)) ───────────────────────────────────────
// Requires T to be a power of two. The proof is the list of "midpoints" μ.
export interface PietrzakProof {
  mus: bigint[]
}

export function isPowerOfTwo(T: number): boolean {
  return T >= 1 && (T & (T - 1)) === 0
}

/**
 * Interactive halving, Fiat–Shamir'd. At each level with statement (x, y, T):
 *   μ = x^(2^(T/2));  r = H(x,y,μ);  x' = x^r·μ,  y' = μ^r·y,  T' = T/2.
 * If y = x^(2^T) then y' = x'^(2^(T/2)), so the halved statement is again true.
 * Recurse to T=1 and check y = x².
 */
export function pietrzakProve(x: bigint, T: number, N: bigint, y?: bigint): PietrzakProof {
  if (!isPowerOfTwo(T)) throw new Error('Pietrzak requires T a power of two')
  const mus: bigint[] = []
  let xi = mod(x, N)
  let yi = y ?? evalVDF(x, T, N)
  let Ti = T
  while (Ti > 1) {
    const half = Ti / 2
    const mu = evalVDF(xi, half, N)
    mus.push(mu)
    const r = challengeScalar(N, xi, yi, mu, BigInt(Ti))
    xi = (modPow(xi, r, N) * mu) % N
    yi = (modPow(mu, r, N) * yi) % N
    Ti = half
  }
  return { mus }
}

/** Re-derive every challenge and check the final y = x² at T = 1. */
export function pietrzakVerify(x: bigint, y: bigint, T: number, N: bigint, proof: PietrzakProof): boolean {
  if (!isPowerOfTwo(T)) return false
  let xi = mod(x, N)
  let yi = mod(y, N)
  let Ti = T
  let idx = 0
  while (Ti > 1) {
    const mu = proof.mus[idx++]
    if (mu === undefined) return false
    if (mu <= 1n || mu >= N) return false // reject trivial / out-of-range midpoints
    const r = challengeScalar(N, xi, yi, mu, BigInt(Ti))
    xi = (modPow(xi, r, N) * mu) % N
    yi = (modPow(mu, r, N) * yi) % N
    Ti = Ti / 2
  }
  return yi === (xi * xi) % N
}

// ── Application 1: RSW time-lock puzzle (encrypt to the future) ───────────────
// Rivest–Shamir–Wagner (1996, the LCS35 "time capsule"): lock a message so it
// can only be opened after T sequential squarings. The creator, who knows φ,
// jumps to the key instantly; the solver must grind. Same squaring chain as the
// VDF, in reverse role — here the delay *is* the security.
export interface TimeLockPuzzle {
  N: bigint
  a: bigint // base
  T: number
  ct: Uint8Array // message ⊕ keystream(a^(2^T))
}

/** A SHA-256 counter-mode keystream from the group element b. */
function keystream(b: bigint, N: bigint, len: number): Uint8Array {
  const out = new Uint8Array(len)
  const seed = bigToBytes(mod(b, N), byteLen(N))
  for (let i = 0, off = 0; off < len; i++) {
    const block = sha256(concat(utf8('curvefield/vdf/rsw-key'), seed, bigToBytes(BigInt(i), 4)))
    for (let j = 0; j < block.length && off < len; j++, off++) out[off] = block[j]
  }
  return out
}

/** Lock a message using the trapdoor (fast): key = a^(2^T) via 2^T mod φ. */
export function timeLock(message: Uint8Array, T: number, N: bigint, phi: bigint, a = 3n): TimeLockPuzzle {
  const b = evalTrapdoor(a, T, N, phi)
  const ks = keystream(b, N, message.length)
  const ct = new Uint8Array(message.length)
  for (let i = 0; i < message.length; i++) ct[i] = message[i] ^ ks[i]
  return { N, a: mod(a, N), T, ct }
}

/** Decrypt a puzzle given the recovered group element b = a^(2^T). Lets a UI
 * that grinds the squarings itself reveal the message without redoing the work. */
export function openWith(puzzle: TimeLockPuzzle, b: bigint): Uint8Array {
  const ks = keystream(b, puzzle.N, puzzle.ct.length)
  const msg = new Uint8Array(puzzle.ct.length)
  for (let i = 0; i < puzzle.ct.length; i++) msg[i] = puzzle.ct[i] ^ ks[i]
  return msg
}

/** Open a puzzle by grinding: recover b = a^(2^T) with T squarings, then XOR. */
export function timeUnlock(puzzle: TimeLockPuzzle): Uint8Array {
  return openWith(puzzle, evalVDF(puzzle.a, puzzle.T, puzzle.N))
}

// ── Application 2: a delay-based randomness beacon ───────────────────────────
// Chain VDF outputs: βᵢ₊₁ = SHA256(VDF(βᵢ)). Each round's value is unpredictable
// until someone spends T sequential steps, and unbiasable — a would-be
// manipulator cannot try many seeds and pick a favourable output, because each
// candidate costs the full delay. This is the RANDAO+VDF beacon shape.
export interface BeaconRound {
  input: bigint // xᵢ, the QR generator for this round
  output: bigint // yᵢ = xᵢ^(2^T)
  beta: Uint8Array // βᵢ = SHA256(yᵢ)
  proof: WesolowskiProof
  verified: boolean
}

export function beaconChain(seed: Uint8Array, T: number, N: bigint, rounds: number): BeaconRound[] {
  const out: BeaconRound[] = []
  let current = sha256(concat(utf8('curvefield/vdf/beacon-seed'), seed))
  for (let i = 0; i < rounds; i++) {
    const input = hashToGroup(current, N)
    const output = evalVDF(input, T, N)
    const proof = wesolowskiProve(input, T, N, output)
    const verified = wesolowskiVerify(input, output, T, N, proof)
    const beta = sha256(concat(utf8('curvefield/vdf/beacon-out'), bigToBytes(output, byteLen(N))))
    out.push({ input, output, beta, proof, verified })
    current = beta
  }
  return out
}

// ── Application 3: a checkpointed / continuous VDF ───────────────────────────
// A plain VDF only proves the FULL delay at the very end. A continuous VDF emits
// verifiable milestones along the way: at each checkpoint T_j it publishes
// y_j = x^(2^(T_j)) with its own Wesolowski proof against the SAME input x. A
// light client watching the chain confirms progress in real time — "the
// evaluator really has done T_j steps" — without redoing any squaring, and the
// checkpoints are monotone (each y_j is y_{j-1} squared the intervening steps).
export interface Checkpoint {
  T: number // cumulative squarings at this milestone
  y: bigint // x^(2^T)
  proof: WesolowskiProof
  verified: boolean
}

export function vdfCheckpoints(x: bigint, totalT: number, k: number, N: bigint): Checkpoint[] {
  const base = mod(x, N)
  const out: Checkpoint[] = []
  let y = base
  let done = 0
  for (let j = 1; j <= k; j++) {
    const target = Math.round((totalT * j) / k)
    for (; done < target; done++) y = (y * y) % N
    // stream the proof so no giant 2^T integer is ever formed, even for large T
    const proof = wesolowskiProveStreaming(base, target, N, y)
    out.push({ T: target, y, proof, verified: wesolowskiVerify(base, y, target, N, proof) })
  }
  return out
}

// A couple of tiny helpers the UI leans on.
export { mod, modInv }
