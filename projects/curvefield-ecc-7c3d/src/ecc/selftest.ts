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
import { ripemd160 } from './ripemd160'
import { sha512 } from './sha512'
import {
  wifEncode,
  wifDecode,
  p2pkhAddress,
  segwitAddress,
  pointCompress,
  pointDecode,
  derEncode,
  derDecode,
} from './encoding'
import { pohligHellman, findSmoothCurve } from './pohlig'
import { musigSign, verifyPartial } from './musig'
import { x25519, x25519Public, ed25519Public, ed25519Sign, ed25519Verify } from './ed25519'
import { runEdgeCases } from './wycheproof'
import {
  G1_GEN,
  G2_GEN,
  R as BLS_R,
  g1,
  g2,
  pairing,
  blsKeygen,
  blsSign,
  blsVerify,
  aggregateSigs,
  blsAggregateVerifyDistinct,
} from './bls12381'
import { Fp12 } from './fp12'
import {
  adaptorPoint,
  pubkey as adaptorPubkey,
  preSign,
  preVerify,
  adapt,
  verifyFull,
  extract,
  runAtomicSwap,
} from './adaptor'
import { masterFromSeed, derivePath, deriveChildPub, xprv, xpub } from './bip32'
import {
  makeBrokenOracle,
  makeSafeOracle,
  invalidCurveAttack,
  targetPubkey,
  targetCurve,
  targetG,
} from './invalid'
import { evaluate as polyEval, divmod as polyDivmod, mul as polyMul } from './polynomial'
import { split as shamirSplit, reconstruct as shamirReconstruct, verifyShare, corruptShare } from './shamir'
import { keygen as frostKeygen, commitNonces, sign as frostSign, verifyPartial as frostVerifyPartial } from './frost'
import { provePoK, verifyPoK, proveDleq, verifyDleq, proveBit, verifyBit, proveRange, verifyRange, hashToCurve, H as PedersenH } from './sigma'
import { setup as kzgSetup, commit as kzgCommit, open as kzgOpen, verify as kzgVerify, batchVerify as kzgBatchVerify } from './kzg'
import { secp256k1 as secpCurve } from './secp256k1'
import { R as BLS_SCALAR } from './bls12381'
import { seedRng } from './rng'

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

  // ── 9. RIPEMD-160 + SHA-512 (the address & Ed25519 hashes) ──
  check(
    'RIPEMD-160',
    'reference "abc" digest',
    bytesToHex(ripemd160(utf8('abc'))) === '8eb208f7e05d987a9b044a8e98c6b087f15a0bfc',
    '"abc" → 8eb208f7… (matches OpenSSL)',
  )
  check(
    'RIPEMD-160',
    'empty-string digest',
    bytesToHex(ripemd160(utf8(''))) === '9c1185a5c5e9fc54612808977ee8f548b2258d31',
    '"" → 9c1185a5…',
  )
  check(
    'SHA-512',
    'FIPS 180-4 "abc"',
    bytesToHex(sha512(utf8('abc'))) ===
      'ddaf35a193617abacc417349ae20413112e6fa4e89a97ea20a9eeee64b55d39a' +
        '2192992a274fc1a836ba3c23a3feebbd454d4423643ce80e2a9ac94fa54ca49f',
    '"abc" → ddaf35a1…',
  )

  // ── 10. Encodings: WIF, addresses, SEC compression, strict DER ──
  {
    const d = 0x0c28fca386c7a227600b2fe50b7cae11ec86d3bf1fbe471be89827e19d72aa1dn
    check(
      'Encoding',
      'WIF (Bitcoin wiki vector)',
      wifEncode(d, false) === '5HueCGU8rMjxEXxiPuD5BDku4MkFqeZyd4dZ1jvhTVqvbTLvyTJ',
      'uncompressed WIF 5HueCGU8…',
    )
    check(
      'Encoding',
      'WIF round-trip',
      wifDecode(wifEncode(d, true)).d === d,
      'compressed WIF decodes back to d',
    )
    const pub = hexToBytes(
      '0450863ad64a87ae8a2fe83c1af1a8403cb53f53e486d8511dad8a04887e5b235' +
        '22cd470243453a299fa9e77237716103abc11a1df38855ed6f2ee187e9c582ba6',
    )
    check(
      'Encoding',
      'P2PKH address vector',
      p2pkhAddress(pub) === '16UwLL9Risc3QfPqBUvKofHmBQ7wMtjvM',
      'canonical Bitcoin-wiki address',
    )
    check(
      'Encoding',
      'Bech32 P2WPKH (BIP-173)',
      segwitAddress('bc', 0, hexToBytes('751e76e8199196d454941c45d1b3a323f1433bd6')) ===
        'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4',
      'witness-v0 program → bc1qw508…',
    )
    const Q = publicKey(0x1234567890abcdefn)
    check(
      'Encoding',
      'SEC compress → decompress',
      (() => {
        const back = pointDecode(pointCompress(Q))
        return back !== null && Q !== null && back.x === Q.x && back.y === Q.y
      })(),
      'recovers y from x and parity',
    )
    const sig = ecdsaSign(d, utf8('der'))
    const round = derDecode(derEncode(sig))
    check('Encoding', 'strict DER round-trip', round.r === sig.r && round.s === sig.s, 'r,s survive DER')
    let derRejected = false
    try {
      derDecode(new Uint8Array([...derEncode(sig), 0x00]))
    } catch {
      derRejected = true
    }
    check('Encoding', 'strict DER rejects trailing byte', derRejected, 'BIP-66 canonical-form check')
  }

  // ── 11. Pohlig–Hellman recovers k on a smooth-order curve ──
  {
    const weak = findSmoothCurve(13n, 800, 8000)
    if (weak) {
      const k = 491n % weak.order
      const target = weak.curve.multiply(k, weak.G)
      const res = pohligHellman(weak.curve, weak.G, target, weak.order)
      check(
        'Pohlig–Hellman',
        'CRT recovers k on smooth order',
        res.k === k,
        `order ${weak.order} = ${weak.factors.map((f) => f.prime + '^' + f.exp).join('·')} → k=${res.k}`,
      )
    } else {
      check('Pohlig–Hellman', 'smooth curve found', false, 'no smooth curve in range')
    }
  }

  // ── 12. MuSig2: aggregate signature verifies under BIP-340 ──
  {
    const secrets = [0xa11ce0n, 0xb0bn, 0xca201n]
    const msg = utf8('three signers, one signature')
    const res = musigSign(secrets, msg)
    check(
      'MuSig2',
      'aggregate verifies under BIP-340',
      schnorrVerify(res.keyagg.xonly, msg, res.sig),
      `${secrets.length} keys → one 64-byte sig`,
    )
    check(
      'MuSig2',
      'every partial signature checks',
      secrets.every((_, i) => verifyPartial(res, i, msg)),
      'no rogue partial can hide',
    )
    const mauled = res.sig.slice()
    mauled[63] ^= 0x01
    check('MuSig2', 'rejects mauled aggregate', !schnorrVerify(res.keyagg.xonly, msg, mauled), 'flipped bit → invalid')
  }

  // ── 13. Curve25519: X25519 (RFC 7748) + Ed25519 (RFC 8032) ──
  {
    const k = hexToBytes('a546e36bf0527c9d3b16154b82465edd62144c0ac1fc5a18506a2244ba449ac4')
    const u = hexToBytes('e6db6867583030db3594c1a424b15f7c726624ec26b3353b10a903a6d0ab1c4c')
    check(
      'X25519',
      'RFC 7748 test vector',
      bytesToHex(x25519(k, u)) ===
        'c3da55379de9c6908e94ea4df28d084f32eccf03491c71f754b4075577a28552',
      'ladder output matches the RFC',
    )
    const aPriv = hexToBytes('77076d0a7318a57d3c16c17251b26645df4c2f87ebc0992ab177fba51db92c2a')
    const bPriv = hexToBytes('5dab087e624a8a4b79e17f8b83800ee66f3bb1292618b6fd1c2f8b27ff88e0eb')
    check(
      'X25519',
      'ECDH shared secret matches',
      bytesToHex(x25519(aPriv, x25519Public(bPriv))) ===
        bytesToHex(x25519(bPriv, x25519Public(aPriv))),
      'both sides derive 4a5d9d5b…',
    )
    const seed = hexToBytes('4ccd089b28ff96da9db6c346ec114e0f5b8a319f35aba624da8cf6ed4fb8a6fb')
    check(
      'Ed25519',
      'RFC 8032 public key',
      bytesToHex(ed25519Public(seed)) ===
        '3d4017c3e843895a92b70aa74d1b7ebc9c982ccf2ec4968cc0cd55f12af4660c',
      'seed → A = 3d4017c3…',
    )
    const edSig = ed25519Sign(seed, hexToBytes('72'))
    check(
      'Ed25519',
      'RFC 8032 signature',
      bytesToHex(edSig) ===
        '92a009a9f0d4cab8720e820b5f642540a2b27b5416503f8fb3762223ebdb69da' +
          '085ac1e43e15996e458f3613d0f11d8c387b2eaeb4302aeeb00d291612bb0c00',
      'deterministic 64-byte signature',
    )
    check(
      'Ed25519',
      'verify + reject tamper',
      ed25519Verify(ed25519Public(seed), hexToBytes('72'), edSig) &&
        !ed25519Verify(ed25519Public(seed), hexToBytes('73'), edSig),
      'accepts honest, rejects altered',
    )
  }

  // ── 14. Wycheproof-style ECDSA verifier battery ──
  {
    const edge = runEdgeCases()
    const failed = edge.filter((c) => !c.pass)
    check(
      'Wycheproof',
      `verifier battery (${edge.length} cases)`,
      failed.length === 0,
      failed.length === 0
        ? 'every adversarial input handled correctly'
        : `failing: ${failed.map((f) => f.name).join(', ')}`,
    )
  }

  // ── 15. BLS12-381: pairing bilinearity + signature aggregation ──
  {
    check(
      'BLS12-381',
      'generators in r-torsion',
      g1.mulRaw(BLS_R, G1_GEN) === null && g2.mul(BLS_R, G2_GEN) === null,
      'r·G₁ = r·G₂ = O on the published generators',
    )
    const e = pairing(G1_GEN, G2_GEN)
    check(
      'BLS12-381',
      'pairing non-degenerate, e^r = 1',
      !Fp12.isOne(e) && Fp12.isOne(Fp12.pow(e, BLS_R)),
      'e(G₁,G₂) ≠ 1 and has exact order r (lands in G_T)',
    )
    const a = 9n
    const b = 7n
    const lhs = pairing(g1.mul(a, G1_GEN), g2.mul(b, G2_GEN))
    const rhs = Fp12.pow(e, a * b)
    check(
      'BLS12-381',
      'bilinearity e(aP,bQ)=e(P,Q)^ab',
      Fp12.eq(lhs, rhs),
      'two independent routes to the same G_T element',
    )
    const key = blsKeygen(0xc0ffeen)
    const msg = utf8('BLS over a hand-written pairing')
    const sig = blsSign(key.sk, msg)
    check(
      'BLS12-381',
      'sign → verify, reject tamper',
      blsVerify(key.pk, msg, sig) && !blsVerify(key.pk, utf8('tampered'), sig),
      'e(σ,G₂)=e(H(m),pk); altered message fails',
    )
    const ks = [3n, 14n, 159n].map((s) => blsKeygen(s * 26535n))
    const msgs = ['a', 'b', 'c'].map(utf8)
    const agg = aggregateSigs(ks.map((k, i) => blsSign(k.sk, msgs[i])))
    check(
      'BLS12-381',
      'aggregate (distinct msgs) verifies',
      blsAggregateVerifyDistinct(ks.map((k) => k.pk), msgs, agg),
      '3 signatures → one 96-byte element, one pairing product',
    )
  }

  // ── 16. Schnorr adaptor signatures + atomic swap ──
  {
    const d = 0xa5ec5e7n
    const tSecret = 0xfeed1234n
    const T = adaptorPoint(tSecret)
    const P = adaptorPubkey(d)
    const msg = utf8('adaptor pre-signature')
    const pre = preSign(d, msg, T, 0x1357n)
    check(
      'Adaptor',
      'pre-signature verifies (no secret needed)',
      preVerify(P, msg, pre),
      'ŝ·G = R + e·P holds before adapting',
    )
    const sig = adapt(pre, tSecret)
    check(
      'Adaptor',
      'adapt → full Schnorr signature',
      verifyFull(P, msg, sig) && sig.s !== pre.shat,
      's = ŝ + t verifies as an ordinary signature',
    )
    check(
      'Adaptor',
      'extract recovers the secret t',
      extract(pre, sig) === tSecret,
      't = s − ŝ leaks once both are public',
    )
    const swap = runAtomicSwap(0x5ec7n, 0xa11ce0n, 0xb0b00n, utf8('A→B'), utf8('B→A'), 0x111n, 0x222n)
    check(
      'Adaptor',
      'end-to-end atomic swap settles',
      swap.atomic,
      'one secret links both legs; claiming one reveals it',
    )
  }

  // ── 17. BIP-32 HD wallets vs the published test vectors (vector 1) ──
  {
    const seed = hexToBytes('000102030405060708090a0b0c0d0e0f')
    const master = masterFromSeed(seed)
    check(
      'BIP-32',
      'master xprv (vector 1)',
      xprv(master) ===
        'xprv9s21ZrQH143K3QTDL4LXw2F7HEK3wJUD2nW2nRk4stbPy6cq3jPPqjiChkVvvNKmPGJxWUtg6LnF5kejMRNNU3TGtRBeJgk33yuGBxrMPHi',
      'HMAC-SHA512 master → xprv9s21Z…',
    )
    const steps = derivePath(seed, "m/0'/1")
    check(
      'BIP-32',
      "m/0'/1 xprv (hardened then normal)",
      xprv(steps[2].node) ===
        'xprv9wTYmMFdV23N2TdNG573QoEsfRrWKQgWeibmLntzniatZvR9BmLnvSxqu53Kw1UmYPxLgboyZQaXwTCg8MSY3H2EU4pWcQDnRnrVA1xe8fs',
      'CKDpriv chain matches the spec',
    )
    check(
      'BIP-32',
      "m/0'/1 xpub (vector 1)",
      xpub(steps[2].node) ===
        'xpub6ASuArnXKPbfEwhqN6e3mwBcDTgzisQN1wXN9BJcM47sSikHjJf3UFHKkNAWbWMiGj7Wf5uMash7SyYq527Hqck2AxYysAA7xmALppuCkwQ',
      'serialized extended public key matches',
    )
    const pubParent = { ...steps[1].node, priv: null }
    check(
      'BIP-32',
      'watch-only CKDpub = CKDpriv',
      xpub(deriveChildPub(pubParent, 1)) === xpub(steps[2].node),
      'xpub-only derivation reproduces the public child',
    )
  }

  // ── 18. Invalid-curve attack recovers a private key from a broken oracle ──
  {
    const d = 0x1f3dn % 10039n
    const attack = invalidCurveAttack(makeBrokenOracle(d))
    const recovered = attack.recovered
    const pub = targetPubkey(d)
    check(
      'Invalid-Curve',
      'recovers d from off-curve queries',
      recovered === d && attack.pinned,
      `${attack.queries} oracle queries, primes ${attack.hits.map((h) => h.prime).join('·')} → d=${recovered}`,
    )
    check(
      'Invalid-Curve',
      'recovered key reproduces the public key',
      recovered !== null &&
        (() => {
          const Q = targetCurve.multiply(recovered, targetG)
          return Q !== null && pub !== null && Q.x === pub.x && Q.y === pub.y
        })(),
      'full key compromise confirmed against Q = d·G',
    )
    const safe = makeSafeOracle(d)
    check(
      'Invalid-Curve',
      'on-curve check defeats the attack',
      attack.hits.every((h) => safe(h.point) === 'rejected'),
      'every malicious point is rejected before scalar mult',
    )
  }

  // ── 21. Polynomial algebra (the substrate under Shamir + KZG) ──
  {
    const m = N
    const a = [3n, 1n, 4n, 1n, 5n]
    const b = [2n, 7n, 1n]
    const prod = polyMul(a, b, m)
    const { q, r } = polyDivmod(prod, b, m)
    check(
      'Polynomial',
      'multiply then divide is exact',
      r.length === 0 && q.length === a.length && q.every((c, i) => c === a[i]),
      '(a·b)/b = a with zero remainder over F_n',
    )
    // Division with remainder satisfies p = q·d + r.
    const p2 = [5n, 4n, 3n, 2n, 1n]
    const d2 = [1n, 1n]
    const { q: q2, r: r2 } = polyDivmod(p2, d2, m)
    const recon = (() => {
      const t1 = polyMul(q2, d2, m)
      const out: bigint[] = []
      for (let i = 0; i < Math.max(t1.length, r2.length); i++)
        out.push(((((t1[i] ?? 0n) + (r2[i] ?? 0n)) % m) + m) % m)
      while (out.length && out[out.length - 1] === 0n) out.pop()
      return out
    })()
    check(
      'Polynomial',
      'Euclidean identity p = q·d + r',
      recon.length === p2.length && recon.every((c, i) => c === p2[i]),
      'long division reconstructs the dividend',
    )
  }

  // ── 22. Shamir secret sharing + Feldman VSS ──
  {
    seedRng(1234)
    const secret = 0xdecaf_c0ffeen
    const sharing = shamirSplit(secret, 3, 5)
    const fromFirst3 = shamirReconstruct(sharing.shares.slice(0, 3))
    const fromLast3 = shamirReconstruct(sharing.shares.slice(2, 5))
    check(
      'Shamir',
      'any 3-of-5 subset recovers the secret',
      fromFirst3 === sharing.secret && fromLast3 === sharing.secret,
      `two disjoint quorums both yield ${hex(sharing.secret).slice(0, 14)}…`,
    )
    const tooFew = shamirReconstruct(sharing.shares.slice(0, 2))
    check('Shamir', '2 shares do not recover it', tooFew !== sharing.secret, 'below threshold ⇒ wrong value')
    check(
      'Shamir',
      'Feldman VSS verifies every honest share',
      sharing.shares.every((s) => verifyShare(s, sharing.commitments)),
      'yᵢ·G = Σⱼ Cⱼ·iʲ for all i',
    )
    const bad = corruptShare(sharing.shares[0])
    check('Shamir', 'Feldman VSS catches a corrupted share', !verifyShare(bad, sharing.commitments), 'tampered share rejected')
  }

  // ── 23. FROST threshold Schnorr ──
  {
    seedRng(99)
    const keys = frostKeygen(3, 5)
    const pick = [0, 2, 4]
    const signers = pick.map((i) => ({ commit: commitNonces(keys.shares[i].i), share: keys.shares[i] }))
    const msg = utf8('frost threshold message')
    const sig = frostSign(keys, signers, msg)
    check(
      'FROST',
      '3-of-5 aggregate verifies under BIP-340',
      schnorrVerify(keys.groupPubXonly, msg, sig.sig),
      'unmodified Schnorr verify accepts the threshold signature',
    )
    check(
      'FROST',
      'every partial signature verifies',
      sig.partials.every((p, k) => frostVerifyPartial(keys, sig, signers[k], p)),
      'zᵢ·G = gr·(Dᵢ+ρᵢ·Eᵢ) + c·λᵢ·gx·Xᵢ',
    )
    check('FROST', 'rejects a tampered message', !schnorrVerify(keys.groupPubXonly, utf8('other'), sig.sig), 'changed msg → invalid')
    // A second, different quorum produces another valid signature under the same key.
    const pick2 = [1, 2, 3]
    const signers2 = pick2.map((i) => ({ commit: commitNonces(keys.shares[i].i), share: keys.shares[i] }))
    const sig2 = frostSign(keys, signers2, msg)
    check('FROST', 'a different quorum also verifies', schnorrVerify(keys.groupPubXonly, msg, sig2.sig), 'threshold property: any t suffice')
    // Under threshold: a 2-of-5 set fails.
    const few = [0, 1].map((i) => ({ commit: commitNonces(keys.shares[i].i), share: keys.shares[i] }))
    const sigFew = frostSign(keys, few, msg)
    check('FROST', 'fewer than t signers cannot sign', !schnorrVerify(keys.groupPubXonly, msg, sigFew.sig), 'under-threshold signature is invalid')
  }

  // ── 24. Zero-knowledge Σ-protocols ──
  {
    seedRng(2024)
    check('Sigma', 'Pedersen base H is on the curve', secpCurve.isOnCurve(PedersenH), 'NUMS second generator lifted by hash-to-curve')
    const pok = provePoK(0xa11ce_5ec_e7n)
    check('Sigma', 'Schnorr PoK verifies', verifyPoK(pok.P, pok.proof), 's·G = T + c·P')
    check('Sigma', 'Schnorr PoK rejects a different statement', !verifyPoK(secpCurve.multiply(3n, pok.P), pok.proof), 'proof is bound to its P')
    const base2 = hashToCurve('selftest/dleq')
    const dl = proveDleq(0x1337n, base2)
    check('Sigma', 'Chaum–Pedersen DLEQ verifies', verifyDleq(dl.P, dl.Q, base2, dl.proof), 'log_G P = log_H₂ Q proven')
    check('Sigma', 'DLEQ rejects a false equality', !verifyDleq(dl.P, secpCurve.add(dl.Q, base2), base2, dl.proof), 'mismatched Q rejected')
    check('Sigma', 'bit OR-proof (0) verifies', verifyBit(proveBit(0, 0x55n)), 'commitment to 0 proven a bit')
    check('Sigma', 'bit OR-proof (1) verifies', verifyBit(proveBit(1, 0x66n)), 'commitment to 1 proven a bit')
    const rp = proveRange(0b1011010n, 8)
    check('Sigma', 'range proof verifies (v ∈ [0,2⁸))', verifyRange(rp), '8 bit-proofs + V = Σ 2ⁱ·Bᵢ')
  }

  // ── 25. KZG polynomial commitments (BLS12-381 pairing) ──
  {
    const srs = kzgSetup(6, 0x9f3c2a1b77e4d5c6n)
    const f = [3n, 1n, 4n, 1n, 5n, 9n]
    const C = kzgCommit(srs, f)
    const op = kzgOpen(srs, f, 11n)
    check('KZG', 'claimed value equals f(z)', op.y === polyEval(f, 11n, BLS_SCALAR), 'y = f(z) over F_r')
    check('KZG', 'opening verifies by pairing', kzgVerify(srs, C, op), 'e(C−[y],[1]) = e(W,[τ]−[z])')
    check('KZG', 'soundness: a forged value is rejected', !kzgVerify(srs, C, { ...op, y: (op.y + 1n) % BLS_SCALAR }), 'wrong y fails the pairing check')
    const batch = kzgBatchVerify(srs, [
      { C, op },
      { C, op: kzgOpen(srs, f, 17n) },
    ])
    check('KZG', 'batch verification (one multi-pairing)', batch, 'two openings folded into a single pairing equation')
  }

  return t
}
