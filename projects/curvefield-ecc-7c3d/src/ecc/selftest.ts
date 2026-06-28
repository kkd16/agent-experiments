// A live test suite the app runs in the browser. It pins the engine against
// published known-answer vectors (SHA-256, HMAC RFC 4231, the real 2G/3G/nG
// identities on secp256k1) and round-trips every signature scheme. Green here
// means the math is not merely self-consistent but matches the standards.

import { sha256, hmacSha256, bytesToHex, utf8, hexToBytes } from './sha256'
import { Curve } from './curve'
import {
  secp256k1,
  G,
  N,
  publicKey,
  ecdh,
  ecdsaSign,
  ecdsaVerify,
  schnorrSign,
  schnorrVerify,
  schnorrPubkey,
} from './secp256k1'
import { modSqrt, modInv } from './field'
import { babyStepGiantStep, bruteForce, pollardRho } from './dlog'

export interface TestCase {
  name: string
  group: string
  pass: boolean
  detail: string
}

const hex = (n: bigint, w = 64) => n.toString(16).padStart(w, '0')

export function runSelfTest(): TestCase[] {
  const t: TestCase[] = []
  const check = (group: string, name: string, pass: boolean, detail: string) =>
    t.push({ group, name, pass, detail })

  // ── 1. SHA-256 known-answer tests (FIPS 180-4) ──
  check(
    'SHA-256',
    'hash of ""',
    bytesToHex(sha256(utf8(''))) ===
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    'empty string → e3b0c442…',
  )
  check(
    'SHA-256',
    'hash of "abc"',
    bytesToHex(sha256(utf8('abc'))) ===
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    '"abc" → ba7816bf…',
  )
  check(
    'SHA-256',
    'two-block message',
    bytesToHex(sha256(utf8('abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq'))) ===
      '248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1',
    'NIST 56-byte vector',
  )

  // ── 2. HMAC-SHA256 (RFC 4231, test case 2) ──
  check(
    'HMAC-SHA256',
    'RFC 4231 #2',
    bytesToHex(hmacSha256(utf8('Jefe'), utf8('what do ya want for nothing?'))) ===
      '5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843',
    'key "Jefe" → 5bdcc146…',
  )

  // ── 3. Field arithmetic ──
  {
    const p = 1000003n
    const a = 123456n
    const inv = modInv(a, p)
    check('Field', 'modular inverse', (a * inv) % p === 1n, `${a}·${inv} ≡ 1 (mod ${p})`)
    const square = (777777n * 777777n) % p
    const r = modSqrt(square, p)
    check(
      'Field',
      'Tonelli–Shanks √',
      r !== null && (r * r) % p === square,
      r === null ? 'no root' : `recovered a root of ${square}`,
    )
  }

  // ── 4. secp256k1 scalar multiplication vs published constants ──
  {
    const twoG = secp256k1.multiply(2n, G)
    const threeG = secp256k1.multiply(3n, G)
    check(
      'secp256k1',
      '2·G x-coordinate',
      twoG !== null &&
        hex(twoG.x) === 'c6047f9441ed7d6d3045406e95c07cd85c778e4b8cef3ca7abac09b95c709ee5',
      'matches the canonical 2·G',
    )
    check(
      'secp256k1',
      '3·G x-coordinate',
      threeG !== null &&
        hex(threeG.x) === 'f9308a019258c31049344f85f89d5229b531c845836f99b08601f113bce036f9',
      'matches the canonical 3·G',
    )
    check(
      'secp256k1',
      'n·G = O (identity)',
      secp256k1.multiply(N, G) === null,
      'the group order annihilates G',
    )
    check(
      'secp256k1',
      'G is on the curve',
      secp256k1.isOnCurve(G) && secp256k1.isNonSingular(),
      'y² = x³ + 7 satisfied',
    )
  }

  // ── 5. ECDH symmetry ──
  {
    const dA = 0x1122334455667788990011223344556677889900112233445566778899001122n
    const dB = 0x99aabbccddeeff00998877665544332211abcdef0123456789fedcba98765432n
    const sA = ecdh(dA, publicKey(dB))
    const sB = ecdh(dB, publicKey(dA))
    check('ECDH', 'shared secret matches', sA === sB, `both sides derive ${hex(sA).slice(0, 16)}…`)
  }

  // ── 6. ECDSA round-trip + determinism + tamper detection ──
  {
    const d = 0xc0ffee0babe1234567890abcdef0fedcba98765432100123456789abcdeffeedn
    const Q = publicKey(d)
    const msg = utf8('Elliptic curves carry the weight of the modern internet.')
    const sig1 = ecdsaSign(d, msg)
    const sig2 = ecdsaSign(d, msg)
    check('ECDSA', 'sign → verify', ecdsaVerify(Q, msg, sig1), `r=${hex(sig1.r).slice(0, 12)}…`)
    check(
      'ECDSA',
      'RFC 6979 determinism',
      sig1.r === sig2.r && sig1.s === sig2.s,
      'same key+msg ⇒ identical signature',
    )
    check(
      'ECDSA',
      'low-s canonical form',
      sig1.s <= N / 2n,
      's ≤ n/2 (no malleable twin)',
    )
    const tampered = utf8('Elliptic curves carry the weight of the modern internet!')
    check('ECDSA', 'rejects tampered msg', !ecdsaVerify(Q, tampered, sig1), 'one byte flipped → invalid')
    check(
      'ECDSA',
      'rejects forged s',
      !ecdsaVerify(Q, msg, { r: sig1.r, s: (sig1.s + 1n) % N }),
      'altered s → invalid',
    )
  }

  // ── 7. BIP-340 Schnorr round-trip + tamper detection ──
  {
    const d = 0x0000000000000000000000000000000000000000000000000000000000000003n
    const px = schnorrPubkey(d)
    check(
      'Schnorr',
      'BIP-340 test-vector pubkey',
      hex(px) === 'f9308a019258c31049344f85f89d5229b531c845836f99b08601f113bce036f9',
      'sk=3 → x-only pubkey f9308a01…',
    )
    const msg = hexToBytes('0000000000000000000000000000000000000000000000000000000000000000')
    const sig = schnorrSign(d, msg)
    check('Schnorr', 'sign → verify', schnorrVerify(px, msg, sig), '64-byte signature verifies')
    const badMsg = hexToBytes('0000000000000000000000000000000000000000000000000000000000000001')
    check('Schnorr', 'rejects tampered msg', !schnorrVerify(px, badMsg, sig), 'changed msg → invalid')
    const badSig = sig.slice()
    badSig[63] ^= 0x01
    check('Schnorr', 'rejects mauled sig', !schnorrVerify(px, msg, badSig), 'flipped s-bit → invalid')
  }

  // ── 8. Discrete-log solvers agree on a toy curve ──
  {
    const toy = new Curve(2n, 2n, 17n) // y² = x³ + 2x + 2 over F_17, order 19 (cyclic)
    const base = toy.points().find((pt) => pt !== null && toy.pointOrder(pt) === 19n)!
    const order = toy.pointOrder(base)
    const k = 13n
    const target = toy.multiply(k, base)
    const bf = bruteForce(toy, base, target, order)
    const bsgs = babyStepGiantStep(toy, base, target, order)
    const rho = pollardRho(toy, base, target, order)
    check('ECDLP', 'brute force finds k', bf.k === k, `k=${bf.k} in ${bf.steps} steps`)
    check('ECDLP', 'BSGS finds k', bsgs.k === k, `k=${bsgs.k} in ${bsgs.steps} steps`)
    check('ECDLP', "Pollard's rho finds k", rho.k === k, `k=${rho.k} in ${rho.steps} steps`)
  }

  return t
}
