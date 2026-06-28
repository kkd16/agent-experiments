// RFC 9380 — Hashing to Elliptic Curves, the constant-shape, standards-grade map
// that replaces the old try-and-increment `hashToG1`. This is the construction
// Ethereum's consensus layer and every modern BLS deployment actually uses, and
// it is the part of a pairing stack that production code gets wrong most often.
//
// The pipeline, end to end (RFC 9380 §3):
//
//     msg ──expand_message_xmd──▶ uniform bytes ──hash_to_field──▶ u₀,u₁ ∈ F
//        ──map_to_curve (SSWU + isogeny)──▶ Q₀,Q₁ on E ──add──▶ R
//        ──clear_cofactor──▶ P ∈ 𝔾  (the prime-order subgroup)
//
// BLS12-381's 𝔾₁ and 𝔾₂ curves have A = 0, so the Simplified SWU map can't run
// on them directly (SSWU needs A·B ≠ 0). RFC 9380 §8.8 instead maps onto an
// *isogenous* curve E′ that does have A,B ≠ 0, then pushes the result back along
// an 11-isogeny (𝔾₁) or 3-isogeny (𝔾₂). All of the large constant tables below
// are those isogeny coefficients and the SSWU parameters, transcribed verbatim
// from RFC 9380 Appendix E and §8.8. Everything is plain BigInt — no libraries.
//
// Verified against the RFC 9380 Appendix J test vectors in selftest.ts.

import { mod, modPow, modSqrt } from './field'
import { BLS_P, Fp2 } from './fp2'
import { concat, sha256 } from './sha256'
import type { G1, G2 } from './bls12381'
import { g1, g2 } from './bls12381'

const P = BLS_P

// ── 5.3.1 expand_message_xmd with SHA-256 ────────────────────────────────────

const SHA256_B = 32 // hash output length
const SHA256_S = 64 // hash block length

function i2osp(n: number, len: number): Uint8Array {
  const out = new Uint8Array(len)
  let v = n
  for (let i = len - 1; i >= 0; i--) {
    out[i] = v & 0xff
    v = Math.floor(v / 256)
  }
  return out
}

function strxor(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length)
  for (let i = 0; i < a.length; i++) out[i] = a[i] ^ b[i]
  return out
}

/**
 * expand_message_xmd (RFC 9380 §5.3.1): stretch (msg, DST) into `lenInBytes`
 * uniformly-random bytes with a Merkle–Damgård hash. The MD-strengthening
 * Z_pad / b_0 / b_i chain is exactly the RFC's, so the output is bit-identical
 * to the published K.1 vectors.
 */
export function expandMessageXmd(
  msg: Uint8Array,
  dst: Uint8Array,
  lenInBytes: number,
): Uint8Array {
  // Oversize DSTs are re-hashed (RFC 9380 §5.3.3); our suite DSTs are short.
  let DST = dst
  if (DST.length > 255) {
    DST = sha256(concat(new TextEncoder().encode('H2C-OVERSIZE-DST-'), DST))
  }
  const ell = Math.ceil(lenInBytes / SHA256_B)
  if (ell > 255 || lenInBytes > 65535) throw new Error('expandMessageXmd: invalid length')
  const dstPrime = concat(DST, i2osp(DST.length, 1))
  const zPad = new Uint8Array(SHA256_S)
  const b0 = sha256(concat(zPad, msg, i2osp(lenInBytes, 2), i2osp(0, 1), dstPrime))
  const b: Uint8Array[] = []
  b[0] = sha256(concat(b0, i2osp(1, 1), dstPrime))
  for (let i = 1; i < ell; i++) {
    b[i] = sha256(concat(strxor(b0, b[i - 1]), i2osp(i + 1, 1), dstPrime))
  }
  return concat(...b).slice(0, lenInBytes)
}

// ── 5.2 hash_to_field ────────────────────────────────────────────────────────
//
// L = ceil((ceil(log2 p) + k) / 8) with k = 128-bit security. For BLS12-381,
// ceil(log2 p) = 381 ⇒ L = ceil(509/8) = 64.

const K_SEC = 128
const L_BYTES = Math.ceil((P.toString(2).length + K_SEC) / 8) // = 64

function os2ip(b: Uint8Array): bigint {
  let n = 0n
  for (const x of b) n = (n << 8n) | BigInt(x)
  return n
}

/** hash_to_field for F_p (m = 1): returns `count` base-field elements. */
export function hashToFieldFp(msg: Uint8Array, dst: Uint8Array, count: number): bigint[] {
  const bytes = expandMessageXmd(msg, dst, count * L_BYTES)
  const out: bigint[] = []
  for (let i = 0; i < count; i++) {
    out.push(mod(os2ip(bytes.subarray(i * L_BYTES, i * L_BYTES + L_BYTES)), P))
  }
  return out
}

/** hash_to_field for F_{p²} (m = 2): returns `count` extension-field elements. */
export function hashToFieldFp2(msg: Uint8Array, dst: Uint8Array, count: number): Fp2[] {
  const bytes = expandMessageXmd(msg, dst, count * 2 * L_BYTES)
  const out: Fp2[] = []
  for (let i = 0; i < count; i++) {
    const off = i * 2 * L_BYTES
    const e0 = mod(os2ip(bytes.subarray(off, off + L_BYTES)), P)
    const e1 = mod(os2ip(bytes.subarray(off + L_BYTES, off + 2 * L_BYTES)), P)
    out.push(Fp2.of(e0, e1))
  }
  return out
}

// ── A tiny field interface so the SSWU map runs once and serves F_p and F_{p²} ─

interface FieldOps<T> {
  ZERO: T
  ONE: T
  fromBig(n: bigint): T
  add(a: T, b: T): T
  sub(a: T, b: T): T
  neg(a: T): T
  mul(a: T, b: T): T
  sqr(a: T): T
  inv(a: T): T
  pow(a: T, e: bigint): T
  eql(a: T, b: T): boolean
  isZero(a: T): boolean
  /** sgn0 per RFC 9380 §4.1: a parity bit used to pin the root's sign. */
  sgn0(a: T): number
  /** Square root, or null if `a` is a non-residue. */
  sqrt(a: T): T | null
  isSquare(a: T): boolean
}

const FpOps: FieldOps<bigint> = {
  ZERO: 0n,
  ONE: 1n,
  fromBig: (n) => mod(n, P),
  add: (a, b) => mod(a + b, P),
  sub: (a, b) => mod(a - b, P),
  neg: (a) => mod(-a, P),
  mul: (a, b) => mod(a * b, P),
  sqr: (a) => mod(a * a, P),
  inv: (a) => modPow(a, P - 2n, P),
  pow: (a, e) => modPow(a, e, P),
  eql: (a, b) => a === b,
  isZero: (a) => a === 0n,
  sgn0: (a) => Number(a & 1n),
  sqrt: (a) => modSqrt(a, P),
  isSquare: (a) => a === 0n || modPow(a, (P - 1n) / 2n, P) === 1n,
}

const Fp2Ops: FieldOps<Fp2> = {
  ZERO: Fp2.ZERO,
  ONE: Fp2.ONE,
  fromBig: (n) => Fp2.fromFp(n),
  add: Fp2.add,
  sub: Fp2.sub,
  neg: Fp2.neg,
  mul: Fp2.mul,
  sqr: Fp2.sqr,
  inv: Fp2.inv,
  pow: (a, e) => {
    let base = a
    let exp = e
    let res = Fp2.ONE
    while (exp > 0n) {
      if (exp & 1n) res = Fp2.mul(res, base)
      base = Fp2.sqr(base)
      exp >>= 1n
    }
    return res
  },
  eql: Fp2.eq,
  isZero: Fp2.isZero,
  // sgn0_m_eq_2: sign_0 OR (zero_0 AND sign_1).
  sgn0: (a) => {
    const s0 = Number(a.a & 1n)
    const z0 = a.a === 0n ? 1 : 0
    const s1 = Number(a.b & 1n)
    return s0 | (z0 & s1)
  },
  sqrt: fp2Sqrt,
  isSquare: (a) => {
    // a is a square in F_{p²} iff a^((p²−1)/2) ∈ {0,1}.
    const e = (P * P - 1n) / 2n
    const r = Fp2Ops.pow(a, e)
    return Fp2.isZero(a) || Fp2.eq(r, Fp2.ONE)
  },
}

/** Square root in F_{p²} via the norm method (p ≡ 3 mod 4). Returns null if none. */
export function fp2Sqrt(a: Fp2): Fp2 | null {
  if (Fp2.isZero(a)) return Fp2.ZERO
  // For x = a + b·u, write candidate via the standard complex-field algorithm:
  // λ = (a² + b²)^((p+1)/4); then test. We use the generic Tonelli-style route:
  // first confirm a is a square, then solve x² = a by the formula.
  if (!Fp2Ops.isSquare(a)) return null
  // (p+1)/4 root of the norm n = a₀² + a₁².
  const norm = mod(a.a * a.a + a.b * a.b, P)
  let lambda = modSqrt(norm, P)
  if (lambda === null) return null
  // x₀ = sqrt((a₀ + λ)/2). If non-residue, use λ → −λ.
  const inv2 = modPow(2n, P - 2n, P)
  let x0sq = mod((a.a + lambda) * inv2, P)
  let x0 = modSqrt(x0sq, P)
  if (x0 === null) {
    lambda = mod(-lambda, P)
    x0sq = mod((a.a + lambda) * inv2, P)
    x0 = modSqrt(x0sq, P)
    if (x0 === null) return null
  }
  // x₁ = a₁ / (2·x₀).  (x₀ ≠ 0 because a is a nonzero square.)
  if (x0 === 0n) {
    // a₀ = ±λ and a₁ = 0: pure-imaginary or real root.
    const r = modSqrt(a.a, P)
    if (r !== null) return Fp2.of(r, 0n)
    const ri = modSqrt(mod(-a.a, P), P)
    if (ri !== null) return Fp2.of(0n, ri)
    return null
  }
  const x1 = mod(a.b * modPow(mod(2n * x0, P), P - 2n, P), P)
  const cand = Fp2.of(x0, x1)
  return Fp2.eq(Fp2.sqr(cand), a) ? cand : null
}

// ── 6.6.2 Simplified SWU, the straight-line form (RFC 9380 Appendix F.2) ──────
//
// sqrt_ratio(u, v) returns (is_square(u/v), √(u/v)) or (false, √(Z·u/v)).

function sqrtRatio<T>(F: FieldOps<T>, Z: T, u: T, v: T): { isValid: boolean; value: T } {
  const r = F.mul(u, F.inv(v))
  const y1 = F.sqrt(r)
  if (y1 !== null) return { isValid: true, value: y1 }
  const y2 = F.sqrt(F.mul(Z, r))
  // Z is a non-residue, so Z·r is a square exactly when r is not.
  if (y2 === null) throw new Error('sqrtRatio: neither r nor Z·r is square')
  return { isValid: false, value: y2 }
}

function mapToCurveSswu<T>(
  F: FieldOps<T>,
  A: T,
  B: T,
  Z: T,
  u: T,
): { x: T; y: T } {
  // RFC 9380 §6.6.2 straight-line algorithm.
  let tv1 = F.sqr(u)
  tv1 = F.mul(Z, tv1)
  let tv2 = F.sqr(tv1)
  tv2 = F.add(tv2, tv1)
  let tv3 = F.add(tv2, F.ONE)
  tv3 = F.mul(B, tv3)
  let tv4 = F.isZero(tv2) ? Z : F.neg(tv2)
  tv4 = F.mul(A, tv4)
  tv2 = F.sqr(tv3)
  let tv6 = F.sqr(tv4)
  let tv5 = F.mul(A, tv6)
  tv2 = F.add(tv2, tv5)
  tv2 = F.mul(tv2, tv3)
  tv6 = F.mul(tv6, tv4)
  tv5 = F.mul(B, tv6)
  tv2 = F.add(tv2, tv5)
  let x = F.mul(tv1, tv3)
  const { isValid, value } = sqrtRatio(F, Z, tv2, tv6)
  let y = F.mul(tv1, u)
  y = F.mul(y, value)
  x = isValid ? tv3 : x
  y = isValid ? value : y
  const e1 = F.sgn0(u) === F.sgn0(y)
  y = e1 ? y : F.neg(y)
  x = F.mul(x, F.inv(tv4))
  return { x, y }
}

// ── isogeny maps (rational-function evaluation, RFC 9380 §6.6.3) ──────────────

function evalIso<T>(F: FieldOps<T>, coeffs: T[], x: T): T {
  // Σ coeffs[i]·xⁱ by Horner from the top coefficient down.
  let acc = F.ZERO
  for (let i = coeffs.length - 1; i >= 0; i--) acc = F.add(F.mul(acc, x), coeffs[i])
  return acc
}

function applyIso<T>(
  F: FieldOps<T>,
  iso: [T[], T[], T[], T[]],
  x: T,
  y: T,
): { x: T; y: T } | null {
  const [xn, xd, yn, yd] = iso
  const xdv = evalIso(F, xd, x)
  const ydv = evalIso(F, yd, x)
  if (F.isZero(xdv) || F.isZero(ydv)) return null // exceptional: identity
  const nx = F.mul(evalIso(F, xn, x), F.inv(xdv))
  const ny = F.mul(y, F.mul(evalIso(F, yn, x), F.inv(ydv)))
  return { x: nx, y: ny }
}

// ── 𝔾₁: SSWU on E′ then the 11-isogeny to E : y² = x³ + 4 ─────────────────────

const G1_A = 0x144698a3b8e9433d693a02c96d4982b0ea985383ee66a8d8e8981aefd881ac98936f8da0e0f97f5cf428082d584c1dn
const G1_B = 0x12e2908d11688030018b12e8753eee3b2016c1f0f24f4070a0b9c14fcef35ef55a23215a316ceaa5d1cc48e98e172be0n
const G1_Z = 11n

const G1_ISO: [bigint[], bigint[], bigint[], bigint[]] = [
  // xNum
  [
    0x11a05f2b1e833340b809101dd99815856b303e88a2d7005ff2627b56cdb4e2c85610c2d5f2e62d6eaeac1662734649b7n,
    0x17294ed3e943ab2f0588bab22147a81c7c17e75b2f6a8417f565e33c70d1e86b4838f2a6f318c356e834eef1b3cb83bbn,
    0x0d54005db97678ec1d1048c5d10a9a1bce032473295983e56878e501ec68e25c958c3e3d2a09729fe0179f9dac9edcb0n,
    0x1778e7166fcc6db74e0609d307e55412d7f5e4656a8dbf25f1b33289f1b330835336e25ce3107193c5b388641d9b6861n,
    0x0e99726a3199f4436642b4b3e4118e5499db995a1257fb3f086eeb65982fac18985a286f301e77c451154ce9ac8895d9n,
    0x1630c3250d7313ff01d1201bf7a74ab5db3cb17dd952799b9ed3ab9097e68f90a0870d2dcae73d19cd13c1c66f652983n,
    0x0d6ed6553fe44d296a3726c38ae652bfb11586264f0f8ce19008e218f9c86b2a8da25128c1052ecaddd7f225a139ed84n,
    0x17b81e7701abdbe2e8743884d1117e53356de5ab275b4db1a682c62ef0f2753339b7c8f8c8f475af9ccb5618e3f0c88en,
    0x080d3cf1f9a78fc47b90b33563be990dc43b756ce79f5574a2c596c928c5d1de4fa295f296b74e956d71986a8497e317n,
    0x169b1f8e1bcfa7c42e0c37515d138f22dd2ecb803a0c5c99676314baf4bb1b7fa3190b2edc0327797f241067be390c9en,
    0x10321da079ce07e272d8ec09d2565b0dfa7dccdde6787f96d50af36003b14866f69b771f8c285decca67df3f1605fb7bn,
    0x06e08c248e260e70bd1e962381edee3d31d79d7e22c837bc23c0bf1bc24c6b68c24b1b80b64d391fa9c8ba2e8ba2d229n,
  ],
  // xDen
  [
    0x08ca8d548cff19ae18b2e62f4bd3fa6f01d5ef4ba35b48ba9c9588617fc8ac62b558d681be343df8993cf9fa40d21b1cn,
    0x12561a5deb559c4348b4711298e536367041e8ca0cf0800c0126c2588c48bf5713daa8846cb026e9e5c8276ec82b3bffn,
    0x0b2962fe57a3225e8137e629bff2991f6f89416f5a718cd1fca64e00b11aceacd6a3d0967c94fedcfcc239ba5cb83e19n,
    0x03425581a58ae2fec83aafef7c40eb545b08243f16b1655154cca8abc28d6fd04976d5243eecf5c4130de8938dc62cd8n,
    0x13a8e162022914a80a6f1d5f43e7a07dffdfc759a12062bb8d6b44e833b306da9bd29ba81f35781d539d395b3532a21en,
    0x0e7355f8e4e667b955390f7f0506c6e9395735e9ce9cad4d0a43bcef24b8982f7400d24bc4228f11c02df9a29f6304a5n,
    0x0772caacf16936190f3e0c63e0596721570f5799af53a1894e2e073062aede9cea73b3538f0de06cec2574496ee84a3an,
    0x14a7ac2a9d64a8b230b3f5b074cf01996e7f63c21bca68a81996e1cdf9822c580fa5b9489d11e2d311f7d99bbdcc5a5en,
    0x0a10ecf6ada54f825e920b3dafc7a3cce07f8d1d7161366b74100da67f39883503826692abba43704776ec3a79a1d641n,
    0x095fc13ab9e92ad4476d6e3eb3a56680f682b4ee96f7d03776df533978f31c1593174e4b4b7865002d6384d168ecdd0an,
    0x000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000001n,
  ],
  // yNum
  [
    0x090d97c81ba24ee0259d1f094980dcfa11ad138e48a869522b52af6c956543d3cd0c7aee9b3ba3c2be9845719707bb33n,
    0x134996a104ee5811d51036d776fb46831223e96c254f383d0f906343eb67ad34d6c56711962fa8bfe097e75a2e41c696n,
    0x00cc786baa966e66f4a384c86a3b49942552e2d658a31ce2c344be4b91400da7d26d521628b00523b8dfe240c72de1f6n,
    0x01f86376e8981c217898751ad8746757d42aa7b90eeb791c09e4a3ec03251cf9de405aba9ec61deca6355c77b0e5f4cbn,
    0x08cc03fdefe0ff135caf4fe2a21529c4195536fbe3ce50b879833fd221351adc2ee7f8dc099040a841b6daecf2e8fedbn,
    0x16603fca40634b6a2211e11db8f0a6a074a7d0d4afadb7bd76505c3d3ad5544e203f6326c95a807299b23ab13633a5f0n,
    0x04ab0b9bcfac1bbcb2c977d027796b3ce75bb8ca2be184cb5231413c4d634f3747a87ac2460f415ec961f8855fe9d6f2n,
    0x0987c8d5333ab86fde9926bd2ca6c674170a05bfe3bdd81ffd038da6c26c842642f64550fedfe935a15e4ca31870fb29n,
    0x09fc4018bd96684be88c9e221e4da1bb8f3abd16679dc26c1e8b6e6a1f20cabe69d65201c78607a360370e577bdba587n,
    0x0e1bba7a1186bdb5223abde7ada14a23c42a0ca7915af6fe06985e7ed1e4d43b9b3f7055dd4eba6f2bafaaebca731c30n,
    0x19713e47937cd1be0dfd0b8f1d43fb93cd2fcbcb6caf493fd1183e416389e61031bf3a5cce3fbafce813711ad011c132n,
    0x18b46a908f36f6deb918c143fed2edcc523559b8aaf0c2462e6bfe7f911f643249d9cdf41b44d606ce07c8a4d0074d8en,
    0x0b182cac101b9399d155096004f53f447aa7b12a3426b08ec02710e807b4633f06c851c1919211f20d4c04f00b971ef8n,
    0x0245a394ad1eca9b72fc00ae7be315dc757b3b080d4c158013e6632d3c40659cc6cf90ad1c232a6442d9d3f5db980133n,
    0x05c129645e44cf1102a159f748c4a3fc5e673d81d7e86568d9ab0f5d396a7ce46ba1049b6579afb7866b1e715475224bn,
    0x15e6be4e990f03ce4ea50b3b42df2eb5cb181d8f84965a3957add4fa95af01b2b665027efec01c7704b456be69c8b604n,
  ],
  // yDen
  [
    0x16112c4c3a9c98b252181140fad0eae9601a6de578980be6eec3232b5be72e7a07f3688ef60c206d01479253b03663c1n,
    0x1962d75c2381201e1a0cbd6c43c348b885c84ff731c4d59ca4a10356f453e01f78a4260763529e3532f6102c2e49a03dn,
    0x058df3306640da276faaae7d6e8eb15778c4855551ae7f310c35a5dd279cd2eca6757cd636f96f891e2538b53dbf67f2n,
    0x16b7d288798e5395f20d23bf89edb4d1d115c5dbddbcd30e123da489e726af41727364f2c28297ada8d26d98445f5416n,
    0x0be0e079545f43e4b00cc912f8228ddcc6d19c9f0f69bbb0542eda0fc9dec916a20b15dc0fd2ededda39142311a5001dn,
    0x08d9e5297186db2d9fb266eaac783182b70152c65550d881c5ecd87b6f0f5a6449f38db9dfa9cce202c6477faaf9b7acn,
    0x166007c08a99db2fc3ba8734ace9824b5eecfdfa8d0cf8ef5dd365bc400a0051d5fa9c01a58b1fb93d1a1399126a775cn,
    0x16a3ef08be3ea7ea03bcddfabba6ff6ee5a4375efa1f4fd7feb34fd206357132b920f5b00801dee460ee415a15812ed9n,
    0x1866c8ed336c61231a1be54fd1d74cc4f9fb0ce4c6af5920abc5750c4bf39b4852cfe2f7bb9248836b233d9d55535d4an,
    0x167a55cda70a6e1cea820597d94a84903216f763e13d87bb5308592e7ea7d4fbc7385ea3d529b35e346ef48bb8913f55n,
    0x04d2f259eea405bd48f010a01ad2911d9c6dd039bb61a6290e591b36e636a5c871a5c29f4f83060400f8b49cba8f6aa8n,
    0x0accbb67481d033ff5852c1e48c50c477f94ff8aefce42d28c0f9a88cea7913516f968986f7ebbea9684b529e2561092n,
    0x0ad6b9514c767fe3c3613144b45f1496543346d98adf02267d5ceef9a00d9b8693000763e3b90ac11e99b138573345ccn,
    0x02660400eb2e4f3b628bdd0d53cd76f2bf565b94e72927c1cb748df27942480e420517bd8714cc80d1fadc1326ed06f7n,
    0x0e0fa1d816ddc03e6b24255e0d7819c171c40f65e273b853324efcd6356caa205ca2f570f13497804415473a1d634b8fn,
    0x000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000001n,
  ],
]

/** map_to_curve for 𝔾₁: SSWU on E′, then the 11-isogeny back to y² = x³ + 4. */
export function mapToCurveG1(u: bigint): G1 {
  const { x, y } = mapToCurveSswu(FpOps, G1_A, G1_B, G1_Z, u)
  const iso = applyIso(FpOps, G1_ISO, x, y)
  return iso === null ? null : { x: iso.x, y: iso.y }
}

// ── 𝔾₂: SSWU on E2′ then the 3-isogeny to E2 : y² = x³ + 4(1+u) ───────────────

const G2_A = Fp2.of(0n, 240n)
const G2_B = Fp2.of(1012n, 1012n)
const G2_Z = Fp2.of(mod(-2n, P), mod(-1n, P))

const f2 = (a: bigint, b: bigint): Fp2 => Fp2.of(a, b)

const G2_ISO: [Fp2[], Fp2[], Fp2[], Fp2[]] = [
  // xNum
  [
    f2(
      0x5c759507e8e333ebb5b7a9a47d7ed8532c52d39fd3a042a88b58423c50ae15d5c2638e343d9c71c6238aaaaaaaa97d6n,
      0x5c759507e8e333ebb5b7a9a47d7ed8532c52d39fd3a042a88b58423c50ae15d5c2638e343d9c71c6238aaaaaaaa97d6n,
    ),
    f2(
      0x0n,
      0x11560bf17baa99bc32126fced787c88f984f87adf7ae0c7f9a208c6b4f20a4181472aaa9cb8d555526a9ffffffffc71an,
    ),
    f2(
      0x11560bf17baa99bc32126fced787c88f984f87adf7ae0c7f9a208c6b4f20a4181472aaa9cb8d555526a9ffffffffc71en,
      0x8ab05f8bdd54cde190937e76bc3e447cc27c3d6fbd7063fcd104635a790520c0a395554e5c6aaaa9354ffffffffe38dn,
    ),
    f2(
      0x171d6541fa38ccfaed6dea691f5fb614cb14b4e7f4e810aa22d6108f142b85757098e38d0f671c7188e2aaaaaaaa5ed1n,
      0x0n,
    ),
  ],
  // xDen
  [
    f2(
      0x0n,
      0x1a0111ea397fe69a4b1ba7b6434bacd764774b84f38512bf6730d2a0f6b0f6241eabfffeb153ffffb9feffffffffaa63n,
    ),
    f2(
      0xcn,
      0x1a0111ea397fe69a4b1ba7b6434bacd764774b84f38512bf6730d2a0f6b0f6241eabfffeb153ffffb9feffffffffaa9fn,
    ),
    f2(0x1n, 0x0n),
  ],
  // yNum
  [
    f2(
      0x1530477c7ab4113b59a4c18b076d11930f7da5d4a07f649bf54439d87d27e500fc8c25ebf8c92f6812cfc71c71c6d706n,
      0x1530477c7ab4113b59a4c18b076d11930f7da5d4a07f649bf54439d87d27e500fc8c25ebf8c92f6812cfc71c71c6d706n,
    ),
    f2(
      0x0n,
      0x5c759507e8e333ebb5b7a9a47d7ed8532c52d39fd3a042a88b58423c50ae15d5c2638e343d9c71c6238aaaaaaaa97ben,
    ),
    f2(
      0x11560bf17baa99bc32126fced787c88f984f87adf7ae0c7f9a208c6b4f20a4181472aaa9cb8d555526a9ffffffffc71cn,
      0x8ab05f8bdd54cde190937e76bc3e447cc27c3d6fbd7063fcd104635a790520c0a395554e5c6aaaa9354ffffffffe38fn,
    ),
    f2(
      0x124c9ad43b6cf79bfbf7043de3811ad0761b0f37a1e26286b0e977c69aa274524e79097a56dc4bd9e1b371c71c718b10n,
      0x0n,
    ),
  ],
  // yDen
  [
    f2(
      0x1a0111ea397fe69a4b1ba7b6434bacd764774b84f38512bf6730d2a0f6b0f6241eabfffeb153ffffb9feffffffffa8fbn,
      0x1a0111ea397fe69a4b1ba7b6434bacd764774b84f38512bf6730d2a0f6b0f6241eabfffeb153ffffb9feffffffffa8fbn,
    ),
    f2(
      0x0n,
      0x1a0111ea397fe69a4b1ba7b6434bacd764774b84f38512bf6730d2a0f6b0f6241eabfffeb153ffffb9feffffffffa9d3n,
    ),
    f2(
      0x12n,
      0x1a0111ea397fe69a4b1ba7b6434bacd764774b84f38512bf6730d2a0f6b0f6241eabfffeb153ffffb9feffffffffaa99n,
    ),
    f2(0x1n, 0x0n),
  ],
]

/** map_to_curve for 𝔾₂: SSWU on E2′, then the 3-isogeny back to y² = x³ + 4(1+u). */
export function mapToCurveG2(u: Fp2): G2 {
  const { x, y } = mapToCurveSswu(Fp2Ops, G2_A, G2_B, G2_Z, u)
  const iso = applyIso(Fp2Ops, G2_ISO, x, y)
  return iso === null ? null : { x: iso.x, y: iso.y }
}

// ── cofactor clearing (RFC 9380 §8.8) ─────────────────────────────────────────

/** h_eff for 𝔾₁ = 1 − x (the BLS seed). Multiplying lands R in the r-torsion. */
const H_EFF_G1 = 0xd201000000010001n
/** h_eff for 𝔾₂ (RFC 9380 §8.8.2). */
const H_EFF_G2 =
  0xbc69f08f2ee75b3584c6a0ea91b352888e2a8e9145ad7689986ff031508ffe1329c2f178731db956d82bf015d1212b02ec0ec69d7477c1ae954cbc06689f6a359894c0adebbf6b4e8020005aaa95551n

// ── 3. the full hash-to-curve and encode-to-curve maps ───────────────────────

/** RFC 9380 hash_to_curve for 𝔾₁ (RO suite): two field elements, summed, cleared. */
export function hashToCurveG1(msg: Uint8Array, dst: Uint8Array): G1 {
  const [u0, u1] = hashToFieldFp(msg, dst, 2)
  const q0 = mapToCurveG1(u0)
  const q1 = mapToCurveG1(u1)
  return g1.mulRaw(H_EFF_G1, g1.add(q0, q1))
}

/** RFC 9380 encode_to_curve for 𝔾₁ (NU suite): one field element, cleared. */
export function encodeToCurveG1(msg: Uint8Array, dst: Uint8Array): G1 {
  const [u0] = hashToFieldFp(msg, dst, 1)
  return g1.mulRaw(H_EFF_G1, mapToCurveG1(u0))
}

/** RFC 9380 hash_to_curve for 𝔾₂ (RO suite). */
export function hashToCurveG2(msg: Uint8Array, dst: Uint8Array): G2 {
  const [u0, u1] = hashToFieldFp2(msg, dst, 2)
  const q0 = mapToCurveG2(u0)
  const q1 = mapToCurveG2(u1)
  return g2.mul(H_EFF_G2, g2.add(q0, q1))
}

/** RFC 9380 encode_to_curve for 𝔾₂ (NU suite). */
export function encodeToCurveG2(msg: Uint8Array, dst: Uint8Array): G2 {
  const [u0] = hashToFieldFp2(msg, dst, 1)
  return g2.mul(H_EFF_G2, mapToCurveG2(u0))
}

export { L_BYTES }
