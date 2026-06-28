// Edge-case vectors for ECDSA verification, in the spirit of Google's Project
// Wycheproof. A signature scheme is only as safe as its *verifier*: history is
// full of libraries that signed correctly but accepted malformed, malleable, or
// outright forged signatures. Each case below feeds the verifier something
// adversarial and asserts the one correct answer — accept the legitimate, reject
// everything else. They run live on the Self-Test page, so the claim "our
// verifier is strict" is something you can watch being checked, not just trust.

import { type Point } from './curve'
import { secp256k1, ecdsaSign, ecdsaVerify, publicKey, N, type EcdsaSig } from './secp256k1'
import { derDecode, derEncode } from './encoding'
import { utf8 } from './sha256'

export interface EdgeCase {
  name: string
  detail: string
  expected: 'accept' | 'reject'
  actual: 'accept' | 'reject'
  pass: boolean
}

// A fixed key + message so every variant is reproducible.
const D = 0x0c0ffee123456789abcdef00fedcba9876543210123456789abcdef0011223344n
const Q: Point = publicKey(D)
const MSG = utf8('Wycheproof-style ECDSA verification battery')

export function runEdgeCases(): EdgeCase[] {
  const cases: EdgeCase[] = []
  const add = (
    name: string,
    detail: string,
    expected: 'accept' | 'reject',
    run: () => boolean,
  ) => {
    let actual: 'accept' | 'reject'
    try {
      actual = run() ? 'accept' : 'reject'
    } catch {
      actual = 'reject' // a thrown parse/range error is a rejection
    }
    cases.push({ name, detail, expected, actual, pass: actual === expected })
  }

  // A genuine, canonical (low-s) signature to base the mutations on.
  const good = ecdsaSign(D, MSG)

  add('valid signature', 'the honest low-s signature must verify', 'accept', () =>
    ecdsaVerify(Q, MSG, good),
  )

  add('tampered message', 'one extra byte in the message → reject', 'reject', () =>
    ecdsaVerify(Q, utf8('Wycheproof-style ECDSA verification battery!'), good),
  )

  add('r = 0', 'a zero r is out of range [1, n)', 'reject', () =>
    ecdsaVerify(Q, MSG, { r: 0n, s: good.s }),
  )
  add('s = 0', 'a zero s is out of range [1, n)', 'reject', () =>
    ecdsaVerify(Q, MSG, { r: good.r, s: 0n }),
  )
  add('r = n', 'r must be strictly below the group order', 'reject', () =>
    ecdsaVerify(Q, MSG, { r: N, s: good.s }),
  )
  add('s = n', 's must be strictly below the group order', 'reject', () =>
    ecdsaVerify(Q, MSG, { r: good.r, s: N }),
  )
  add('r = n + r', 'r reduced past the order must not be re-accepted', 'reject', () =>
    ecdsaVerify(Q, MSG, { r: good.r + N, s: good.s }),
  )

  // The malleable high-s twin: s' = n − s is *mathematically* a valid ECDSA
  // signature (ECDSA does not fix s's sign). A bare verifier accepts it; this is
  // why Bitcoin layers a low-s *policy* on top — covered in the next case.
  const highS: EcdsaSig = { r: good.r, s: mod(N - good.s, N) }
  add(
    'high-s twin (raw ECDSA)',
    'mathematically valid — bare ECDSA accepts both s and n−s',
    'accept',
    () => ecdsaVerify(Q, MSG, highS),
  )
  add(
    'high-s twin (low-s policy)',
    'BIP-62/146 reject s > n/2 to kill malleability',
    'reject',
    () => ecdsaVerify(Q, MSG, highS) && highS.s <= N / 2n,
  )

  add('point at infinity as key', 'O is not a valid public key', 'reject', () =>
    ecdsaVerify(null, MSG, good),
  )

  // A point with a valid x but the wrong y — not on the curve.
  const offCurve: Point = Q ? { x: Q.x, y: mod(Q.y + 1n, secp256k1.p) } : null
  add('public key not on curve', 'verifier must check the key lies on E', 'reject', () =>
    ecdsaVerify(offCurve, MSG, good),
  )

  add('forged s+1', 'incrementing s breaks the equation', 'reject', () =>
    ecdsaVerify(Q, MSG, { r: good.r, s: mod(good.s + 1n, N) }),
  )

  add('wrong key', 'a different public key must not verify', 'reject', () =>
    ecdsaVerify(publicKey(D + 1n), MSG, good),
  )

  // ── DER-layer strictness ──
  const der = derEncode(good)
  add('strict DER roundtrip', 'canonical DER decodes and verifies', 'accept', () =>
    ecdsaVerify(Q, MSG, derDecode(der)),
  )
  add('DER with trailing byte', 'extra byte after SEQUENCE → reject', 'reject', () =>
    ecdsaVerify(Q, MSG, derDecode(new Uint8Array([...der, 0x00]))),
  )
  add('DER non-minimal r', 'a superfluous 0x00 in r is not canonical', 'reject', () => {
    const body = der.slice(2)
    const rlen = body[1]
    const rBytes = body.slice(2, 2 + rlen)
    const sPart = body.slice(2 + rlen)
    const rPad = new Uint8Array([0x02, rlen + 1, 0x00, ...rBytes])
    const nb = new Uint8Array([...rPad, ...sPart])
    return ecdsaVerify(Q, MSG, derDecode(new Uint8Array([0x30, nb.length, ...nb])))
  })
  add('DER wrong length byte', 'declared length must match the body', 'reject', () => {
    const bad = new Uint8Array(der)
    bad[1] = (bad[1] + 1) & 0xff
    return ecdsaVerify(Q, MSG, derDecode(bad))
  })

  return cases
}

// Local mod to avoid importing the whole field module surface.
function mod(a: bigint, m: bigint): bigint {
  const r = a % m
  return r < 0n ? r + m : r
}
