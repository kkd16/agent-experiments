// Pinned known-answer vectors for the SHA-3 sponge and ML-KEM, plus a resumable
// runner for the C2SP CCTV "accumulated" test.
//
// The headline claim — that this from-scratch ML-KEM is correct byte-for-byte,
// not merely self-consistent — rests on two published anchors:
//
//  • the FIPS 202 SHA-3 / SHAKE digests, and
//  • the C2SP CCTV accumulated hash: 10,000 randomised KeyGen/Encaps/Decaps
//    rounds (with implicit rejection) whose running SHAKE-128 tag must equal a
//    single community-published 32-byte constant, one per parameter set.
//
// The CCTV vectors follow FIPS 203 *ipd* (they hash the seed d alone). This lab
// ships FIPS 203 *final* by default (it hashes d‖k); the two differ only by that
// one domain-separation byte, so the accumulated test drives the engine in the
// `ipd` variant to line up with the published constants.

import { sha3_256, sha3_512, shake128, shake256, Keccak, shake128Stream } from './keccak'
import {
  keyGenInternal,
  encapsInternal,
  decapsInternal,
  sizes,
  ML_KEM_512,
  type Params,
  type Variant,
} from './mlkem'

const hex = (b: Uint8Array): string => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('')
const unhex = (s: string): Uint8Array => Uint8Array.from(s.match(/../g)!.map((h) => parseInt(h, 16)))
const utf8 = (s: string): Uint8Array => new TextEncoder().encode(s)

// ── FIPS 202 known-answer digests ────────────────────────────────────────────

export interface VectorCheck {
  name: string
  got: string
  want: string
  pass: boolean
}

const KECCAK_KATS: { name: string; run: () => string; want: string }[] = [
  { name: 'SHA3-256("")', run: () => hex(sha3_256(new Uint8Array(0))), want: 'a7ffc6f8bf1ed76651c14756a061d662f580ff4de43b49fa82d80a4b80f8434a' },
  { name: 'SHA3-256("abc")', run: () => hex(sha3_256(utf8('abc'))), want: '3a985da74fe225b2045c172d6bd390bd855f086e3e9d525b46bfe24511431532' },
  { name: 'SHA3-512("abc")', run: () => hex(sha3_512(utf8('abc'))), want: 'b751850b1a57168a5693cd924b6b096e08f621827444f70d884f5d0240d2712e10e116e9192af3c91a7ec57647e3934057340b4cf408d5a56592f8274eec53f0' },
  { name: 'SHAKE128("",32)', run: () => hex(shake128(new Uint8Array(0), 32)), want: '7f9c2ba4e88f827d616045507605853ed73b8093f6efbc88eb1a6eacfa66ef26' },
  { name: 'SHAKE256("",32)', run: () => hex(shake256(new Uint8Array(0), 32)), want: '46b9dd2b0ba88d13233b3feb743eeb243fcd52ea62b81b82b50c27646ed5762f' },
]

export function checkKeccak(): VectorCheck[] {
  return KECCAK_KATS.map(({ name, run, want }) => {
    const got = run()
    return { name, got, want, pass: got === want }
  })
}

// ── ML-KEM-512 single known-answer test (C2SP CCTV intermediate, ipd) ─────────

export const KAT_512 = {
  d: 'e1e3206875e67d7e81353774fe9025035b9b41a4a9f6ec00b91c600442fd717d',
  z: 'c6f5785a6f2b42e843228be53eb768d64c6f9d4355ae95f083e51ed57c437310',
  m: 'a741ec2002be6f4fa76037b7f0644f833fa823e630401a39d3240c6e82a430bb',
  rho: 'b1720e4ed5ac0add457f573a041465bcbd7ca4e1d7d53eaadeda511962a36eb0',
  ekPrefix: 'f29c866c361d910341f296c64b46c2a2e30b1535a5c0602593415d156b43036b',
  ctPrefix: '96c7855b455b6dbb607be569d4cbc46665f645eaf96b54c617bc9b4485ddee95',
  K: '62a8c220b01793ecd183dea9762c5602211e0aab001cbc892d0a95693ab17cc1',
}

export interface KatResult {
  rhoOk: boolean
  ekOk: boolean
  ctOk: boolean
  kOk: boolean
  encapsDecapsOk: boolean
  ek: Uint8Array
  ct: Uint8Array
  K: Uint8Array
}

/** Reproduce the CCTV ML-KEM-512 intermediate vector end to end (ipd variant). */
export function runKat512(): KatResult {
  const d = unhex(KAT_512.d)
  const z = unhex(KAT_512.z)
  const m = unhex(KAT_512.m)
  const g = sha3_512(d)
  const { ek, dk } = keyGenInternal(d, z, ML_KEM_512, 'ipd')
  const enc = encapsInternal(ek, m, ML_KEM_512)
  const dec = decapsInternal(dk, enc.c, ML_KEM_512)
  return {
    rhoOk: hex(g.slice(0, 32)) === KAT_512.rho,
    ekOk: hex(ek.slice(0, 32)) === KAT_512.ekPrefix,
    ctOk: hex(enc.c.slice(0, 32)) === KAT_512.ctPrefix,
    kOk: hex(enc.K) === KAT_512.K,
    encapsDecapsOk: hex(dec.K) === hex(enc.K) && dec.valid,
    ek,
    ct: enc.c,
    K: enc.K,
  }
}

// ── the CCTV accumulated test (10,000 rounds), as a resumable runner ──────────

/** Published SHAKE-128 tags for the full 10,000-round accumulated test (ipd). */
export const ACC_EXPECTED_10K: Record<string, string> = {
  'ML-KEM-512': '845913ea5a308b803c764a9ed8e9d814ca1fd9c82ba43c7b1e64b79c7a6ec8e4',
  'ML-KEM-768': 'f7db260e1137a742e05fe0db9525012812b004d29040a5b606aad3d134b548d3',
  'ML-KEM-1024': '47ac888fe61544efc0518f46094b4f8a600965fc89822acb06dc7169d24f3543',
}

/**
 * Regression tags for a short 64-round prefix — computed by the same engine that
 * matches the published 10,000-round constants, so the always-on self-test can
 * exercise the whole accumulator quickly while the full run stays a page button.
 */
export const ACC_EXPECTED_64: Record<string, string> = {
  'ML-KEM-512': '96799106cec6bea164edc6c0894f49cd8ea78fdbc723f7d0da6d66340b9c9ae9',
  'ML-KEM-768': 'e80a56dd4e2b44c45aeded6646f858609ed44ae4d88b7534bfec2a916fbacce2',
  'ML-KEM-1024': '4207d08d1ba580f9e44b3de64b6a068047d7bd5ba94d2b7449d880f4dcbd7997',
}

export interface AccProgress {
  done: boolean
  i: number
  total: number
}

/**
 * Drives the CCTV accumulated test one chunk at a time so a long run (up to
 * 100 ms/round × 10k for ML-KEM-1024) can yield to the browser between chunks.
 * Each round draws d, z, m and a random ciphertext from one empty-seeded SHAKE-128
 * stream, runs the full KEM, and folds ek, dk, ct, the encaps secret and the
 * implicit-rejection secret into a running SHAKE-128 tag.
 */
export class AccumulatedRun {
  readonly total: number
  readonly params: Params
  private readonly variant: Variant
  private readonly ctSize: number
  private readonly rng: { read: (n: number) => Uint8Array }
  private readonly acc: Keccak
  private i = 0
  private roundtripOk = true

  constructor(params: Params, total: number, variant: Variant = 'ipd') {
    this.params = params
    this.total = total
    this.variant = variant
    this.ctSize = sizes(params).ct
    this.rng = shake128Stream(new Uint8Array(0))
    this.acc = new Keccak(168, 0x1f)
  }

  /** Run up to `n` more rounds; returns progress. */
  step(n: number): AccProgress {
    const end = Math.min(this.i + n, this.total)
    for (; this.i < end; this.i++) {
      const d = this.rng.read(32)
      const z = this.rng.read(32)
      const m = this.rng.read(32)
      const ctRand = this.rng.read(this.ctSize)
      const { ek, dk } = keyGenInternal(d, z, this.params, this.variant)
      const enc = encapsInternal(ek, m, this.params)
      const back = decapsInternal(dk, enc.c, this.params)
      if (hex(back.K) !== hex(enc.K)) this.roundtripOk = false
      const bad = decapsInternal(dk, ctRand, this.params)
      this.acc.absorb(ek)
      this.acc.absorb(dk)
      this.acc.absorb(enc.c)
      this.acc.absorb(enc.K)
      this.acc.absorb(bad.K)
    }
    return { done: this.i >= this.total, i: this.i, total: this.total }
  }

  /** The 32-byte tag (must only be read once the run is done). */
  digest(): string {
    return hex(this.acc.squeeze(32))
  }

  get decapsConsistent(): boolean {
    return this.roundtripOk
  }
}

/** Run a whole accumulated test synchronously (used by the self-test at 64). */
export function runAccumulated(params: Params, total: number, variant: Variant = 'ipd'): string {
  const run = new AccumulatedRun(params, total, variant)
  let p = run.step(total)
  while (!p.done) p = run.step(total)
  return run.digest()
}
