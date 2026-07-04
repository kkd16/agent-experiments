// reedSolomon.ts — Reed–Solomon codes over GF(256), from scratch.
//
// RS is the workhorse of the physical world: it protects QR codes, CDs, DVDs,
// Blu-ray, DVB broadcast, RAID-6 and the data beamed back from Voyager. It is a
// (n, k) code over GF(2^8): a message of k bytes becomes a codeword of n ≤ 255
// bytes by appending 2t = n−k PARITY bytes, and it corrects any t = (n−k)/2 byte
// errors — OR up to 2t byte ERASURES (errors at known positions) — OR a mix.
// Crucially it counts errors in *symbols* (bytes), so a long contiguous BURST
// that trashes many adjacent bits costs only a few symbols — which is exactly
// why it guards media that fail in scratches and dropouts.
//
// The machinery, all in the field GF(256) (primitive poly 0x11D, generator α=2):
//   • ENCODE — build g(x) = ∏_{i=0}^{2t−1}(x − αⁱ); the codeword is the message
//     shifted up by x^{2t} plus its remainder mod g, so g divides every codeword.
//   • SYNDROMES — evaluate the received word at α⁰..α^{2t−1}; all-zero ⇔ clean.
//   • BERLEKAMP–MASSEY — synthesise the shortest error-locator polynomial Λ(x)
//     consistent with the syndromes (folding in known erasures first).
//   • CHIEN SEARCH — find Λ's roots to locate the error positions.
//   • FORNEY — solve for the error magnitudes via the evaluator Ω(x).
//
// The implementation follows the well-known "Reed–Solomon for coders" formulation
// (highest-degree-first coefficients, first-consecutive-root fcr = 0). It is
// exercised exhaustively by the Self-test page: every error pattern up to t, and
// every erasure/error mix within the 2t budget, decodes back to the message.

import { GF256 } from './galois.ts'

const gf = GF256

// ---- polynomial helpers (highest degree first), all over GF(256) ----

function polyMul(p: number[], q: number[]): number[] {
  const out = new Array(p.length + q.length - 1).fill(0)
  for (let i = 0; i < p.length; i++) {
    if (p[i] === 0) continue
    for (let j = 0; j < q.length; j++) out[i + j] ^= gf.mul(p[i], q[j])
  }
  return out
}

function polyAdd(p: number[], q: number[]): number[] {
  const n = Math.max(p.length, q.length)
  const r = new Array(n).fill(0)
  for (let i = 0; i < p.length; i++) r[i + (n - p.length)] = p[i]
  for (let i = 0; i < q.length; i++) r[i + (n - q.length)] ^= q[i]
  return r
}

function polyScale(p: number[], s: number): number[] {
  return p.map((c) => gf.mul(c, s))
}

function polyEval(p: number[], x: number): number {
  let y = p[0]
  for (let i = 1; i < p.length; i++) y = gf.mul(y, x) ^ p[i]
  return y
}

// ---- generator polynomial and systematic encode ----

/** g(x) = ∏_{i=0}^{nsym−1} (x − α^i). Monic, degree nsym. */
export function generatorPoly(nsym: number): number[] {
  let g = [1]
  for (let i = 0; i < nsym; i++) g = polyMul(g, [1, gf.pow(2, i)])
  return g
}

/**
 * Systematic RS encode: append nsym parity bytes to the message. The codeword is
 * message‖parity where parity = (message·x^{nsym}) mod g(x), so g | codeword.
 */
export function rsEncode(msg: number[], nsym: number): number[] {
  const gen = generatorPoly(nsym)
  const out = new Array(msg.length + nsym).fill(0)
  for (let i = 0; i < msg.length; i++) out[i] = msg[i]
  // Synthetic division by the monic generator; the trailing nsym bytes become
  // the remainder = parity.
  for (let i = 0; i < msg.length; i++) {
    const coef = out[i]
    if (coef !== 0) {
      for (let j = 1; j < gen.length; j++) out[i + j] ^= gf.mul(gen[j], coef)
    }
  }
  // Restore the message bytes (the division clobbered the first k of `out`).
  for (let i = 0; i < msg.length; i++) out[i] = msg[i]
  return out
}

// ---- decode: syndromes → BM → Chien → Forney ----

/** Syndromes S_i = C(α^i) for i=0..nsym−1, returned with a leading 0 pad (S[0]=0)
 * so the Forney-syndrome and errata math index cleanly. */
export function calcSyndromes(codeword: number[], nsym: number): number[] {
  const synd = [0]
  for (let i = 0; i < nsym; i++) synd.push(polyEval(codeword, gf.pow(2, i)))
  return synd
}

/** Are all syndromes zero (⇒ no detectable error)? */
export function syndromesClean(synd: number[]): boolean {
  for (const s of synd) if (s !== 0) return false
  return true
}

/** Errata locator ∏(1 − α^{p}·x) from a list of coefficient positions. */
function errataLocator(positions: number[]): number[] {
  let eLoc = [1]
  for (const p of positions) eLoc = polyMul(eLoc, polyAdd([1], [gf.pow(2, p), 0]))
  return eLoc
}

/** Error evaluator Ω(x) = (S(x)·Λ(x)) mod x^{nsym+1}. */
function errorEvaluator(synd: number[], errLoc: number[], nsym: number): number[] {
  const prod = polyMul(synd, errLoc)
  // Keep the low nsym+1 coefficients (mod x^{nsym+1}) — the last nsym+1 entries.
  return prod.slice(prod.length - (nsym + 1))
}

/**
 * Berlekamp–Massey: synthesise the shortest LFSR (error locator Λ) consistent
 * with the syndrome sequence. `eraseLoc`/`eraseCount` seed it with the known
 * erasure locator so the same routine handles errors-and-erasures.
 */
export function findErrorLocator(
  synd: number[],
  nsym: number,
  eraseLoc: number[] | null,
  eraseCount: number,
): number[] {
  let errLoc = eraseLoc ? eraseLoc.slice() : [1]
  let oldLoc = eraseLoc ? eraseLoc.slice() : [1]
  const syndShift = synd.length > nsym ? synd.length - nsym : 0
  for (let i = 0; i < nsym - eraseCount; i++) {
    const K = eraseLoc ? eraseCount + i + syndShift : i + syndShift
    let delta = synd[K]
    for (let j = 1; j < errLoc.length; j++) {
      delta ^= gf.mul(errLoc[errLoc.length - 1 - j], synd[K - j])
    }
    oldLoc = [...oldLoc, 0]
    if (delta !== 0) {
      if (oldLoc.length > errLoc.length) {
        const newLoc = polyScale(oldLoc, delta)
        oldLoc = polyScale(errLoc, gf.inv(delta))
        errLoc = newLoc
      }
      errLoc = polyAdd(errLoc, polyScale(oldLoc, delta))
    }
  }
  // Drop leading zeros.
  let start = 0
  while (start < errLoc.length - 1 && errLoc[start] === 0) start++
  return errLoc.slice(start)
}

/** Chien search: roots of Λ locate the errors. Returns coefficient positions
 * (n−1−i) for each i where Λ(α^i)=0. Throws if the count disagrees with deg Λ. */
export function findErrors(errLoc: number[], nmess: number): number[] {
  const errs = errLoc.length - 1
  const positions: number[] = []
  for (let i = 0; i < nmess; i++) {
    if (polyEval(errLoc, gf.pow(2, i)) === 0) positions.push(nmess - 1 - i)
  }
  if (positions.length !== errs) {
    throw new RsError(`located ${positions.length} of ${errs} error positions — too corrupted`)
  }
  return positions
}

/** Forney syndromes: fold the known erasures out of the syndromes so BM sees a
 * pure error-locating problem of the reduced degree. */
function forneySyndromes(synd: number[], erasePos: number[], nmess: number): number[] {
  const erasePosRev = erasePos.map((p) => nmess - 1 - p)
  const fsynd = synd.slice(1)
  for (let i = 0; i < erasePos.length; i++) {
    const x = gf.pow(2, erasePosRev[i])
    for (let j = 0; j < fsynd.length - 1; j++) {
      fsynd[j] = gf.mul(fsynd[j], x) ^ fsynd[j + 1]
    }
  }
  return fsynd
}

/** Forney algorithm: given the located errata positions, compute magnitudes and
 * apply the correction. */
function correctErrata(codeword: number[], synd: number[], errPos: number[]): number[] {
  const msg = codeword.slice()
  const coefPos = errPos.map((p) => msg.length - 1 - p)
  const eLoc = errataLocator(coefPos)
  // Ω from the reversed syndromes, then reverse back (matches the reference).
  const syndRev = synd.slice().reverse()
  const evalRev = errorEvaluator(syndRev, eLoc, eLoc.length - 1)
  const errEval = evalRev.slice().reverse()

  // Error positions as field elements X_i = α^{coefPos} (= α^{−(255−cp)}).
  const X = coefPos.map((cp) => gf.pow(2, cp))

  const E = new Array(msg.length).fill(0)
  for (let i = 0; i < X.length; i++) {
    const Xi = X[i]
    const XiInv = gf.inv(Xi)
    // Λ'(X_i^{-1}) via the product form (avoids a formal derivative).
    let denom = 1
    for (let j = 0; j < X.length; j++) {
      if (j !== i) denom = gf.mul(denom, 1 ^ gf.mul(XiInv, X[j]))
    }
    let y = polyEval(errEval.slice().reverse(), XiInv)
    // fcr = 0 ⇒ multiply by X_i^{1−fcr} = X_i.
    y = gf.mul(gf.pow(Xi, 1), y)
    if (denom === 0) throw new RsError('Forney denominator zero — decode failed')
    E[errPos[i]] = gf.div(y, denom)
  }
  return polyAdd(msg, E)
}

export class RsError extends Error {}

export interface RsDecodeResult {
  message: number[] // recovered k message bytes
  parity: number[] // recovered nsym parity bytes
  corrected: number[] // full corrected codeword
  errorPositions: number[] // positions the decoder repaired
  erasurePositions: number[]
  syndromes: number[] // the initial syndromes (with leading 0 stripped)
  errorLocator: number[] // Λ(x) found by Berlekamp–Massey
  ok: boolean
}

/**
 * Full errors-and-erasures RS decode. `erasePos` are known-bad positions (they
 * cost 1 of the 2t budget each; unknown errors cost 2). Throws RsError when the
 * corruption exceeds the correction guarantee.
 */
export function rsDecode(received: number[], nsym: number, erasePos: number[] = []): RsDecodeResult {
  if (received.length > 255) throw new RsError('codeword too long for GF(256)')
  const msgOut = received.slice()
  for (const e of erasePos) msgOut[e] = 0
  if (erasePos.length > nsym) throw new RsError('too many erasures')

  const synd = calcSyndromes(msgOut, nsym)
  const bareSynd = synd.slice(1)
  if (syndromesClean(synd)) {
    return {
      message: msgOut.slice(0, msgOut.length - nsym),
      parity: msgOut.slice(msgOut.length - nsym),
      corrected: msgOut,
      errorPositions: [],
      erasurePositions: erasePos.slice(),
      syndromes: bareSynd,
      errorLocator: [1],
      ok: true,
    }
  }

  const fsynd = forneySyndromes(synd, erasePos, msgOut.length)
  const errLoc = findErrorLocator(fsynd, nsym, null, erasePos.length)
  const errPos = findErrors(errLoc.slice().reverse(), msgOut.length)
  const allPos = [...erasePos, ...errPos]

  // Guard the correction budget: 2·errors + erasures ≤ 2t.
  if (errPos.length * 2 + erasePos.length > nsym) {
    throw new RsError('too many errors/erasures to correct')
  }

  const corrected = correctErrata(msgOut, synd, allPos)
  // Verify: a correct decode leaves all syndromes zero.
  const check = calcSyndromes(corrected, nsym)
  if (!syndromesClean(check)) throw new RsError('decode did not converge (uncorrectable)')

  return {
    message: corrected.slice(0, corrected.length - nsym),
    parity: corrected.slice(corrected.length - nsym),
    corrected,
    errorPositions: errPos.slice().sort((a, b) => a - b),
    erasurePositions: erasePos.slice(),
    syndromes: bareSynd,
    errorLocator: errLoc,
    ok: true,
  }
}

export interface RsCode {
  n: number
  k: number
  nsym: number
  t: number
}

/** Describe an (n,k) RS code. */
export function rsCode(n: number, k: number): RsCode {
  return { n, k, nsym: n - k, t: Math.floor((n - k) / 2) }
}

// A few standard configurations, including QR-code error-correction levels for a
// version-1 (26-byte) symbol — the real parameters printed millions of times a day.
export const RS_PRESETS: { id: string; label: string; n: number; k: number; note: string }[] = [
  { id: 'qr-l', label: 'QR v1-L', n: 26, k: 19, note: 'QR code, ~7% recovery — corrects 3 bytes' },
  { id: 'qr-m', label: 'QR v1-M', n: 26, k: 16, note: 'QR code, ~15% recovery — corrects 5 bytes' },
  { id: 'qr-q', label: 'QR v1-Q', n: 26, k: 13, note: 'QR code, ~25% recovery — corrects 6 bytes' },
  { id: 'qr-h', label: 'QR v1-H', n: 26, k: 9, note: 'QR code, ~30% recovery — corrects 8 bytes' },
  { id: 'cd', label: 'CIRC-like', n: 32, k: 28, note: 'CD outer code shape — corrects 2 bytes' },
  { id: 'rs255', label: 'RS(255,223)', n: 255, k: 223, note: 'Voyager/CCSDS deep-space — corrects 16 bytes' },
]
