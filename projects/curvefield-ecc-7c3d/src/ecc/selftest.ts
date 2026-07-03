// A live test suite the app runs in the browser. It pins the engine against
// published known-answer vectors (SHA-256, HMAC RFC 4231, the real 2G/3G/nG
// identities on secp256k1) and round-trips every signature scheme. Green here
// means the math is not merely self-consistent but matches the standards.

import { sha256, hmacSha256, bytesToHex, utf8, hexToBytes, concat } from './sha256'
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
import { Fp2 } from './fp2'
import { Fp6 } from './fp6'
import { finalExpCanonical } from './bls12381'
import { finalExpFast } from './bls_finalexp'
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
import { seedRng, randomBytes } from './rng'
import { expandMessageXmd, hashToCurveG1, hashToCurveG2 } from './hash2curve'
import { compressG1, compressG2, decompressG1, decompressG2, toBytesG1, toBytesG2 } from './blsenc'
import {
  keyGen,
  skToPk,
  sign as blsStdSign,
  verify as blsStdVerify,
  popProve,
  popVerify,
  aggregate as blsStdAggregate,
  aggregateVerify as blsStdAggregateVerify,
  ikmFromLabel,
} from './blssig'
import * as groth16 from './groth16'
import * as plonk from './plonk'
import * as bp from './bulletproofs'
import { commit as pedersenCommit } from './sigma'
import { randomScalar } from './rng'
import {
  P as GOLD_P,
  GENERATOR as GOLD_GEN,
  pow as goldPow,
  rootOfUnity as goldRoot,
  ntt as goldNtt,
  intt as goldIntt,
  cosetEval as goldCosetEval,
  fp as goldFp,
} from './goldilocks'
import { friProve, friVerify, type FriParams } from './fri'
import { Transcript as StarkTranscript } from './transcript'
import { starkProve, starkVerify, fibSquareOutput, type StarkConfig } from './stark'
import { add as goldAdd, P as GOLD_MOD } from './goldilocks'
import {
  permute as posPermute,
  permuteTrace as posTrace,
  compress as posCompress,
  hashTwoToOne as posHash2,
  sbox as posSbox,
  mdsInvertible as posMdsInvertible,
  ROUNDS as POS_ROUNDS,
} from './poseidon'
import { pow as goldPow2 } from './goldilocks'
import {
  poseidonStarkProve,
  poseidonStarkVerify,
  digestOf as posDigestOf,
  type PoseidonStarkConfig,
} from './poseidon_stark'
import { F as thF, PRF as thPRF, Hmsg as thHmsg, Adrs, ADRS_OTS } from './hashaddr'
import * as lamport from './lamport'
import {
  WOTS_W16,
  wotsParams,
  wotsKeypair,
  wotsSign as wotsSignFn,
  wotsVerify as wotsVerifyFn,
  chain as wotsChain,
} from './wots'
import { xmssKeygen, xmssSign, xmssVerify, type XmssParams } from './xmss'
import { sphincsKeygen, sphincsSign, sphincsVerify, SPHINCS_TOY } from './sphincs'
import {
  ecvrfKeygen,
  ecvrfProve,
  ecvrfVerify,
  proofToBytes,
  proofToHash,
  type Suite,
} from './ecvrf'
import {
  mulBase as ringMulBase,
  keyImage,
  sagSign,
  sagVerify,
  blsagSign,
  blsagVerify,
  imagesLinked,
  clsagSign,
  clsagVerify,
  stealthKeygen,
  stealthSend,
  stealthReceive,
  pubFromSecret,
} from './ring'
import { edEqual2, L25519 as RING_L } from './ed25519'
import { chacha20Block, chacha20, poly1305Mac, aeadEncrypt, aeadDecrypt } from './chacha20'
import { hkdf, hkdfExtract } from './hkdf'
import { xeddsaSign, xeddsaVerify } from './xeddsa'
import {
  createParticipant,
  publishBundle,
  beginInitiator,
  beginResponder,
  encryptText,
  decryptText,
  runOutOfOrderDemo,
  runForwardSecrecyDemo,
  runPostCompromiseDemo,
} from './signal'
import { x3dhInitiate, x3dhRespond, generateKeyPair as x25519Keypair } from './x3dh'
import { sha3_256, sha3_512, shake128, shake256 } from './keccak'
import {
  PARAM_SETS,
  keyGen as mlkemKeyGen,
  encaps as mlkemEncaps,
  decaps as mlkemDecaps,
  kemSizes,
  ntt as mlkemNtt,
  invNtt as mlkemInvNtt,
  nttMul as mlkemNttMul,
  Q as MLKEM_Q,
} from './mlkem'
import { hybridClientKeyGen, hybridServerRespond, hybridClientFinish } from './hybridkem'
import { obliviousTransfer, otOneOfN } from './ot'
import { garbleCircuit, publicTables, evaluateCircuit, inputLabel, type Label } from './garble'
import {
  CircuitBuilder,
  millionairesCircuit,
  equalityCircuit,
  sumCircuit,
  toBits,
  evalPlain,
  type Circuit,
} from './circuit'
import { runMillionaires, runEquality, runSum, runProduct, runAuction } from './twopc'

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

  // ── 24b. Bulletproofs: logarithmic range proofs + inner-product argument ──
  {
    seedRng(31337)
    // Independent NUMS generators.
    const gens = bp.generators(8)
    check('Bulletproofs', 'NUMS generators are on the curve', gens.gv.every((p) => secpCurve.isOnCurve(p)) && gens.hv.every((p) => secpCurve.isOnCurve(p)), '8+8 hash-to-curve generators')
    check('Bulletproofs', 'generators g·, h·, u are distinct', gens.gv[0]!.x !== gens.hv[0]!.x && gens.gv[0]!.x !== gens.u!.x, 'pairwise-unknown discrete logs')

    // The inner-product argument in isolation.
    const a = Array.from({ length: 8 }, () => randomScalar(N) || 1n)
    const b = Array.from({ length: 8 }, () => randomScalar(N) || 1n)
    const c = a.reduce((acc, x, i) => (acc + x * b[i]) % N, 0n)
    const msm = (s: bigint[], pts: typeof gens.gv) => s.reduce<ReturnType<typeof secpCurve.add>>((acc, si, i) => secpCurve.add(acc, secpCurve.multiply(si, pts[i])), null)
    const Pipa = secpCurve.add(secpCurve.add(msm(a, gens.gv), msm(b, gens.hv)), secpCurve.multiply(c, gens.u))
    const ip = bp.ipaProve(new bp.Transcript('selftest'), gens.gv, gens.hv, gens.u, a, b)
    check('Bulletproofs', 'inner-product argument verifies (n=8 → 3 rounds)', bp.ipaVerifyNaive(new bp.Transcript('selftest'), gens.gv, gens.hv, gens.u, Pipa, ip) && ip.L.length === 3, '⟨a,b⟩ proven in ⌈log₂ n⌉ rounds')
    check('Bulletproofs', 'naive and optimised IPA verifiers agree', bp.ipaVerifyFast(new bp.Transcript('selftest'), gens.gv, gens.hv, gens.u, Pipa, ip), 'recursive fold = single multi-exponentiation')
    check('Bulletproofs', 'IPA rejects a wrong commitment', !bp.ipaVerifyNaive(new bp.Transcript('selftest'), gens.gv, gens.hv, gens.u, secpCurve.add(Pipa, gens.u), ip), 'soundness of the argument')

    // A single 32-bit range proof.
    const gamma = randomScalar(N) || 1n
    const rp = bp.proveRange([1_000_000n], [gamma], 32)
    check('Bulletproofs', 'range proof verifies (v ∈ [0,2³²))', bp.verifyRange(rp), '17 elements, not 32 OR-proofs')
    check('Bulletproofs', 'fast verifier agrees with the transparent one', bp.verifyRange(rp, true), 's-vector multi-exp ≡ recursive replay')
    check('Bulletproofs', 'commitment V opens to (v, γ)', secpCurve.add(rp.V[0], secpCurve.negate(pedersenCommit(1_000_000n, gamma))) === null, 'V = v·G + γ·H')
    check('Bulletproofs', 'soundness: a tampered t̂ is rejected', !bp.verifyRange({ ...rp, tHat: (rp.tHat + 1n) % N }), 'mauling the inner product breaks the proof')
    check('Bulletproofs', 'soundness: a forged commitment is rejected', !bp.verifyRange({ ...rp, V: [secpCurve.add(rp.V[0], secpCurve.multiply(1n << 33n, G))] }), 'claiming a value ≥ 2ⁿ fails')

    // Aggregation: four 16-bit values in one proof.
    const vals = [40_000n, 12n, 65_535n, 1n]
    const gs = vals.map(() => randomScalar(N) || 1n)
    const agg = bp.proveRange(vals, gs, 16)
    check('Bulletproofs', 'aggregate proof (4×16-bit) verifies', bp.verifyRange(agg) && bp.verifyRange(agg, true), '64 bits proven in one 2·log₂(64)+4 = 16-element proof')
    const sz = bp.proofSize(16, 4)
    check('Bulletproofs', 'proof size is logarithmic', sz.points === 2 * Math.log2(64) + 4 && agg.ipa.L.length === Math.log2(64), `${sz.points} points + ${sz.scalars} scalars vs. ~64 for the linear form`)

    // Wire (de)serialization round-trip.
    const wire = bp.serializeRangeProof(agg)
    const reparsed = bp.deserializeRangeProof(wire)
    check('Bulletproofs', 'proof serializes to its compact wire form', wire.length === bp.serializedSize(16, 4), `${wire.length} bytes = 33·points + 32·scalars`)
    check('Bulletproofs', 'deserialized proof still verifies', bp.verifyRange(reparsed) && bp.serializeRangeProof(reparsed).length === wire.length, 'round-trip is loss-free and re-verifies')

    // Confidential transaction: amounts hidden, balance + non-negativity proven.
    const inB = [randomScalar(N) || 1n, randomScalar(N) || 1n]
    const tx = bp.buildConfidentialTx([100n, 50n], inB, [90n, 55n], 5n, 16)
    const tv = bp.verifyConfidentialTx(tx)
    check('Bulletproofs', 'confidential tx: balance + range verify', tv.ok, 'Σin = Σout + fee, every output ∈ [0,2ⁿ)')
    const stolen = { ...tx, outputs: tx.outputs.map((o, i) => (i === 0 ? secpCurve.add(o, secpCurve.multiply(7n, G)) : o)) }
    check('Bulletproofs', 'confidential tx: inflating an output is caught', !bp.verifyConfidentialTx(stolen).ok, 'minting money breaks the kernel-excess balance')
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

  // ── 25b. Optimized final exponentiation (the pairing hot path) ──
  {
    const f = Fp12.of(
      Fp6.of(Fp2.of(2n, 3n), Fp2.of(5n, 7n), Fp2.of(11n, 13n)),
      Fp6.of(Fp2.of(17n, 19n), Fp2.of(23n, 29n), Fp2.of(31n, 37n)),
    )
    const fast = finalExpFast(f)
    const canon = finalExpCanonical(f)
    check(
      'Final Exp',
      'fast addition-chain lands in G_T (eᵣ = 1)',
      !Fp12.isOne(fast) && Fp12.isOne(Fp12.pow(fast, BLS_R)),
      'Hayashida–Aranha chain output is an exact r-th root of unity',
    )
    check(
      'Final Exp',
      'fast = canonical³ (a fixed, pairing-preserving cube)',
      Fp12.eq(fast, Fp12.pow(canon, 3n)),
      'every pairing *equality* is preserved; ≈17× fewer F_p¹² muls',
    )
  }

  // ── 26. RFC 9380 hash-to-curve (constant-shape, the standard BLS map) ──
  {
    const dstX = utf8('QUUX-V01-CS02-with-expander-SHA256-128')
    check(
      'Hash-to-Curve',
      'expand_message_xmd (RFC 9380 K.1)',
      bytesToHex(expandMessageXmd(utf8('abc'), dstX, 0x20)) ===
        'd8ccab23b5985ccea865c6c97b6e5b8350e794e603b4b97902f53a8a0d605615',
      '"abc" → d8ccab23… (32 uniform bytes from SHA-256)',
    )
    check(
      'Hash-to-Curve',
      'expand_message_xmd long output (128 bytes)',
      bytesToHex(expandMessageXmd(utf8('abc'), dstX, 0x80)) ===
        'abba86a6129e366fc877aab32fc4ffc70120d8996c88aee2fe4b32d6c7b6437a647e6c3163d40b76a73cf6a5674ef1d8' +
          '90f95b664ee0afa5359a5c4e07985635bbecbac65d747d3d2da7ec2b8221b17b0ca9dc8a1ac1c07ea6a1e60583e2cb00' +
          '058e77b7b72a298425cd1b941ad4ec65e8afc50303a22c0f99b0509b4c895f40',
      'multi-block b_0/b_i chain matches the RFC',
    )
    const dst1 = utf8('QUUX-V01-CS02-with-BLS12381G1_XMD:SHA-256_SSWU_RO_')
    const p1 = hashToCurveG1(utf8('abc'), dst1)
    check(
      'Hash-to-Curve',
      'hash_to_curve 𝔾₁ "abc" (RFC 9380 J.9.1)',
      p1 !== null &&
        p1.x ===
          0x03567bc5ef9c690c2ab2ecdf6a96ef1c139cc0b2f284dca0a9a7943388a49a3aee664ba5379a7655d3c68900be2f6903n &&
        p1.y ===
          0x0b9c15f3fe6e5cf4211f346271d7b01c8f3b28be689c8429c85b67af215533311f0b8dfaaa154fa6b88176c229f2885dn,
      'SSWU on E′ → 11-isogeny → cofactor clear, bit-for-bit',
    )
    check(
      'Hash-to-Curve',
      '𝔾₁ image is on-curve and in the r-torsion',
      g1.isOnCurve(p1) && g1.mulRaw(BLS_R, p1) === null,
      'the map always lands in the prime-order subgroup',
    )
    const dst2 = utf8('QUUX-V01-CS02-with-BLS12381G2_XMD:SHA-256_SSWU_RO_')
    const p2 = hashToCurveG2(utf8('abc'), dst2)
    check(
      'Hash-to-Curve',
      'hash_to_curve 𝔾₂ "abc" (RFC 9380 J.10.1)',
      p2 !== null &&
        p2.x.a ===
          0x02c2d18e033b960562aae3cab37a27ce00d80ccd5ba4b7fe0e7a210245129dbec7780ccc7954725f4168aff2787776e6n &&
        p2.x.b ===
          0x0139cddbccdc5e91b9623efd38c49f81a6f83f175e80b06fc374de9eb4b41dfe4ca3a230ed250fbe3a2acf73a41177fd8n,
      'SSWU on E2′ → 3-isogeny → cofactor clear matches the RFC',
    )
    check(
      'Hash-to-Curve',
      '𝔾₂ image is on-curve and in the r-torsion',
      g2.isOnCurve(p2) && g2.mul(BLS_R, p2) === null,
      'large-cofactor clearing puts it in 𝔾₂',
    )
  }

  // ── 27. ZCash / Ethereum BLS12-381 point serialization ──
  {
    check(
      'BLS Serialization',
      'compressed 𝔾₁ generator (canonical 48 bytes)',
      bytesToHex(compressG1(G1_GEN)) ===
        '97f1d3a73197d7942695638c4fa9ac0fc3688c4f9774b905a14e3a3f171bac586c55e83ff97a1aeffb3af00adb22c6bb',
      'flag bits + x-only encoding match the ZCash spec',
    )
    check(
      'BLS Serialization',
      'compressed 𝔾₂ generator (canonical 96 bytes)',
      bytesToHex(compressG2(G2_GEN)) ===
        '93e02b6052719f607dacd3a088274f65596bd0d09920b61ab5da61bbdc7f5049334cf11213945d57e5ac7d055d042b7e' +
          '024aa2b2f08f0a91260805272dc51051c6e47ad4fa403b02b4510b647ae3d1770bac0326a805bbefd48056c8c121bdb8',
      'F_{p²} packed imaginary-part-first (c₁‖c₀)',
    )
    const P1 = g1.mul(0x1234567n, G1_GEN)
    const P2 = g2.mul(0x89abcden, G2_GEN)
    check(
      'BLS Serialization',
      '𝔾₁ compress → decompress round-trip (y recovered from sign bit)',
      g1.eq(decompressG1(compressG1(P1)), P1) && g1.eq(decompressG1(toBytesG1(P1)), P1),
      'both compressed (48B) and uncompressed (96B) forms',
    )
    check(
      'BLS Serialization',
      '𝔾₂ compress → decompress round-trip',
      g2.eq(decompressG2(compressG2(P2)), P2) && g2.eq(decompressG2(toBytesG2(P2)), P2),
      'lexicographic (c₁,c₀) sign bit picks the right root',
    )
    check(
      'BLS Serialization',
      'point at infinity round-trips',
      decompressG1(compressG1(null)) === null && decompressG2(compressG2(null)) === null,
      'the infinity flag is canonical',
    )
  }

  // ── 28. BLS signatures, the IRTF standard scheme (HKDF KeyGen + PoP) ──
  {
    // EIP-2333 / draft-irtf-cfrg-bls-signature KeyGen test vector (seed → master SK).
    const eipSeed = hexToBytes(
      'c55257c360c07c72029aebc1b53c05ed0362ada38ead3e3e9efa3708e53495531f09a6987599d18264c1e1c92f2cf141630c7a3c4ab7c81b2f001698e7463b04',
    )
    check(
      'BLS Signatures',
      'HKDF KeyGen vs EIP-2333 master SK',
      keyGen(eipSeed) ===
        6083874454709270928345386274498605044986640685124978867557563392430687146096n,
      'salted HKDF_mod_r reproduces the published key',
    )
    // Wire-format signature vector (sk = 0x11, "minimal-signature-size" NUL suite).
    const sk = 0x11n
    const pk = skToPk(sk)
    check(
      'BLS Signatures',
      'public key wire bytes (sk=0x11)',
      bytesToHex(compressG2(pk)) ===
        'ad05ceb0be53d2624a796a7a033aec59d9463c18d672c451ec4f2e679daef882cab7d8dd88789065156a1340ca9d4265' +
          '0ef786ebdcda12e142a32f091307f2fedf52f6c36beb278b0007a03ad81bf9fee3710a04928e43e541d02c9be44722e8',
      'pk = sk·G₂, ZCash-compressed',
    )
    const sigStd = blsStdSign(sk, utf8('hello curvefield'))
    check(
      'BLS Signatures',
      'signature wire bytes match a conformant library',
      bytesToHex(compressG1(sigStd)) ===
        '8582bb4950c64d3a36ead3136e82484e99320696480f04b51475f5175f7913d951910f6804ca6c30fa3106bd81298793',
      'σ = sk·H(m) with the ciphersuite DST',
    )
    check(
      'BLS Signatures',
      'verify accepts, rejects tamper',
      blsStdVerify(pk, utf8('hello curvefield'), sigStd) &&
        !blsStdVerify(pk, utf8('hello curvefield!'), sigStd),
      'e(σ,G₂)=e(H(m),pk); one byte flipped → invalid',
    )
    // Proof of possession closes the rogue-key hole.
    const pop = popProve(sk)
    check(
      'BLS Signatures',
      'proof-of-possession verifies (and rejects a foreign key)',
      popVerify(pk, pop) && !popVerify(skToPk(0x12n), pop),
      'a self-signature over the public key, under a distinct DST',
    )
    // Aggregate over distinct messages, the safe basic-scheme path.
    const sks = ['alice', 'bob', 'carol'].map((l) => keyGen(ikmFromLabel(l)))
    const pks = sks.map(skToPk)
    const msgs = ['vote:A', 'vote:B', 'vote:C'].map(utf8)
    const agg = blsStdAggregate(sks.map((s, i) => blsStdSign(s, msgs[i])))
    check(
      'BLS Signatures',
      'aggregate (distinct msgs) verifies; duplicate msg rejected',
      blsStdAggregateVerify(pks, msgs, agg) &&
        !blsStdAggregateVerify(pks, [utf8('vote:A'), utf8('vote:B'), utf8('vote:A')], agg),
      '3 signatures → one 48-byte 𝔾₁ element, one pairing product',
    )
  }

  // ── 29. Groth16 zk-SNARK over the from-scratch pairing ──
  {
    const sys = groth16.cubeCircuit()
    const { witness, out } = groth16.cubeWitness(3n)
    check(
      'Groth16',
      'R1CS → QAP divisibility for an honest witness',
      groth16.r1csSatisfied(sys, witness) &&
        groth16.qapWitnessPolys(groth16.r1csToQap(sys), witness).remainderZero,
      'x³+x+5=35: A(x)B(x)−C(x) is divisible by the target t(x)',
    )
    const st = groth16.setup(sys, 0xc0ffeen)
    const proof = groth16.prove(st, sys, witness, 0xbeefn)
    check(
      'Groth16',
      'verify accepts the honest proof (3 elements, 1 pairing eq)',
      groth16.verify(st.vk, [1n, out], proof),
      'e(A,B)=e(α₁,β₂)·e(Σaᵢ·ICᵢ,γ₂)·e(C,δ₂)',
    )
    check(
      'Groth16',
      'soundness: wrong public input is rejected',
      !groth16.verify(st.vk, [1n, (out + 1n) % BLS_SCALAR], proof),
      'claiming out=36 for a proof of out=35 fails the pairing',
    )
    check(
      'Groth16',
      'soundness: a tampered proof is rejected',
      !groth16.verify(st.vk, [1n, out], { ...proof, C: st.pk.alpha1 }),
      'mauling C breaks the equation',
    )
    const w2 = groth16.cubeWitness(4n)
    const proof2 = groth16.prove(st, sys, w2.witness, 0x1234n)
    check(
      'Groth16',
      'zero-knowledge: a fresh secret (x=4) yields a valid, distinct proof',
      groth16.verify(st.vk, [1n, w2.out], proof2) && !groth16.verify(st.vk, [1n, out], proof2),
      'the proof reveals only the public output, never x',
    )
  }

  // ── 30. PLONK universal zk-SNARK (same statement, universal KZG setup) ──
  {
    // Domain: a primitive n-th root of unity has order exactly n; Z_H vanishes on H.
    const w8 = plonk.rootOfUnity(8)
    check(
      'PLONK',
      'primitive 8th root of unity (order exactly 8)',
      plonk.domain(8).length === 8 && plonk.evalVanishing(8, w8) === 0n && w8 !== 1n,
      'ω⁸ = 1, ω⁴ ≠ 1 in F_r; Z_H(ω) = 0',
    )
    // Lagrange closed form agrees with interpolation.
    const zTest = 0x9999n
    const L2closed = plonk.lagrangeEval(8, 2, zTest)
    const L2poly = polyEval(plonk.lagrangeBasis(8, 2), zTest, BLS_SCALAR)
    check('PLONK', 'Lagrange L_i(ζ) closed form = interpolation', L2closed === L2poly, 'ℓ₂(ζ) two ways')

    const circuit = plonk.cubeCircuit()
    const { witness, out } = plonk.cubeWitness(3n)
    check(
      'PLONK',
      'witness satisfies every gate + copy constraint',
      plonk.circuitSatisfied(circuit, witness) && out === 35n,
      'x³+x+5 = 35 across selector gates and wiring',
    )
    const pp = plonk.preprocess(circuit, 0xc0ffeen)
    const { proof, trace } = plonk.prove(pp, circuit, witness, 0xbeefn)
    check(
      'PLONK',
      'grand product returns to 1 (permutation argument)',
      trace.grandProductClosed,
      'z(ωⁿ) = z(ω⁰) = 1 ⇒ every copy constraint holds',
    )
    check(
      'PLONK',
      'quotient divides exactly (remainder 0)',
      trace.quotientRemainderZero,
      'gate + α·perm + α²·boundary is divisible by Z_H',
    )
    const ok = plonk.verify(pp, [out], proof)
    check(
      'PLONK',
      'honest proof accepts (identity + two KZG pairings)',
      ok.accepted && ok.identityHolds && ok.openingZeta && ok.openingZetaOmega,
      'LHS = t(ζ)·Z_H(ζ), both batched openings verify',
    )
    check(
      'PLONK',
      'soundness: wrong public input rejected',
      !plonk.verify(pp, [(out + 1n) % BLS_SCALAR], proof).accepted,
      'claiming out=36 breaks the scalar identity at ζ',
    )
    check(
      'PLONK',
      'soundness: a mauled evaluation is rejected',
      !plonk.verify(pp, [out], { ...proof, aBar: (proof.aBar + 1n) % BLS_SCALAR }).accepted,
      'a(ζ) inconsistent with [a]₁ fails the batched opening',
    )
    // A forged witness for a different secret must not verify against out=35.
    const w4 = plonk.cubeWitness(4n)
    const p4 = plonk.prove(pp, circuit, w4.witness, 0xabcdn).proof
    check(
      'PLONK',
      'zero-knowledge: x=4 proof valid for its own out, invalid for x=3’s',
      plonk.verify(pp, [w4.out], p4).accepted && !plonk.verify(pp, [out], p4).accepted,
      'the proof reveals only out, never x',
    )
  }

  // ── 33. Goldilocks field 𝔽_p, p = 2^64 − 2^32 + 1 (the STARK field) ──
  {
    const primes = [2n, 3n, 5n, 17n, 257n, 65537n] // distinct prime factors of p − 1
    check(
      'Goldilocks',
      'generator 7 has full order p − 1',
      primes.every((q) => goldPow(GOLD_GEN, (GOLD_P - 1n) / q) !== 1n) && goldPow(GOLD_GEN, GOLD_P - 1n) === 1n,
      'g^((p−1)/q) ≠ 1 for every prime q | p−1 (so ⟨g⟩ = 𝔽_p^×)',
    )
    const w = goldRoot(1024)
    check(
      'Goldilocks',
      'primitive 1024-th root of unity',
      goldPow(w, 1024n) === 1n && goldPow(w, 512n) !== 1n,
      'ω^1024 = 1 but ω^512 ≠ 1 — the 2-adic subgroup the NTT needs',
    )
    const coeffs = [3n, 1n, 4n, 1n, 5n, 9n, 2n, 6n]
    const roundTrip = goldIntt(goldNtt(coeffs))
    check(
      'Goldilocks',
      'NTT ∘ INTT is the identity',
      coeffs.every((c, i) => goldFp(c) === roundTrip[i]),
      'interpolation and evaluation on ⟨ω_8⟩ invert exactly',
    )
  }

  // ── 34. FRI low-degree proximity test ──
  {
    const TSIZE = 64,
      BLOWUP = 8,
      N = TSIZE * BLOWUP
    const params: FriParams = { size: N, offset: GOLD_GEN, degreeBound: TSIZE, numQueries: 24 }
    const lowDeg = Array.from({ length: TSIZE }, (_, i) => BigInt((i * 2654435761 + 7) % 1_000_000_007))
    const codeword = goldCosetEval(lowDeg, GOLD_GEN, N)
    const { proof: friProof } = friProve(codeword, params, new StarkTranscript('kat'))
    check(
      'FRI',
      'honest degree < N/8 codeword accepts',
      friVerify(friProof, params, new StarkTranscript('kat')).ok,
      'log₂(N/blowup) random folds collapse it to a constant',
    )
    const highDeg = Array.from({ length: N }, (_, i) => BigInt((i * 1103515245 + 12345) % 2147483647))
    const { proof: badProof } = friProve(highDeg, params, new StarkTranscript('kat'))
    check(
      'FRI',
      'full-degree (random) codeword rejected',
      !friVerify(badProof, params, new StarkTranscript('kat')).ok,
      'a codeword far from any low-degree polynomial fails the fold checks',
    )
    const tampered = { ...friProof, finalConst: goldAdd(friProof.finalConst, 1n) }
    check(
      'FRI',
      'tampered final constant rejected',
      !friVerify(tampered, params, new StarkTranscript('kat')).ok,
      'query folds no longer land on the claimed constant',
    )
  }

  // ── 35. STARK — a transparent, hash-only, post-quantum proof ──
  {
    const cfg: StarkConfig = { traceLen: 16, blowup: 8, numQueries: 20 }
    const out = fibSquareOutput(16)
    check(
      'STARK',
      'Fibonacci-square output a₁₅ is the pinned value',
      out === 735957447973472791n,
      'a₀=a₁=1, a_{n+2}=a_n²+a_{n+1}², run 16 steps over Goldilocks',
    )
    const { proof: stProof } = starkProve(cfg)
    check(
      'STARK',
      'honest execution proof verifies',
      starkVerify(out, cfg, stProof).ok,
      'AIR → LDE → composition → DEEP → FRI, checked with only a hash',
    )
    check(
      'STARK',
      'soundness: a false claimed output is rejected',
      !starkVerify(goldAdd(out, 1n), cfg, stProof).ok,
      'the constraint identity at ζ no longer binds',
    )
    const forged = starkProve(cfg, { corruptRow: 7 }).proof
    check(
      'STARK',
      'soundness: a forged intermediate step is rejected',
      !starkVerify(out, cfg, forged).ok,
      'one wrong row makes the composition non-low-degree; FRI catches it',
    )
    const mauled = structuredCloneProof(stProof)
    mauled.ood.Az = goldAdd(mauled.ood.Az, 1n)
    check(
      'STARK',
      'soundness: a mauled out-of-domain value is rejected',
      !starkVerify(out, cfg, mauled).ok,
      'DEEP quotient at ζ stops being a polynomial',
    )
  }

  // ── 36. Poseidon — an arithmetic hash + a STARK proving its preimage ──
  {
    // The x^7 S-box must be a bijection (gcd(7, p−1) = 1) and match plain pow.
    check(
      'Poseidon',
      'S-box x⁷ agrees with pow(x, 7)',
      posSbox(123456789n) === goldPow2(123456789n, 7n) && posSbox(2n) === 128n,
      'the round non-linearity is the smallest permutation power over Goldilocks',
    )
    check(
      'Poseidon',
      'MDS diffusion matrix is invertible',
      posMdsInvertible(),
      'a Cauchy matrix M[i][j]=1/(xᵢ−yⱼ) is MDS, so the mix layer is a bijection',
    )
    // Permutation determinism + a pinned known-answer.
    check(
      'Poseidon',
      'permutation pinned KAT permute(1..8)[0]',
      posPermute([1n, 2n, 3n, 4n, 5n, 6n, 7n, 8n])[0] === 7517557254607333542n,
      'fixed input → fixed output over 30 rounds (4 full · 22 partial · 4 full)',
    )
    // permuteTrace's last row equals a direct permute (the trace the STARK uses).
    const posTr = posTrace([1n, 2n, 3n, 4n, 5n, 6n, 7n, 8n])
    const posLast = posPermute([1n, 2n, 3n, 4n, 5n, 6n, 7n, 8n])
    check(
      'Poseidon',
      `trace has ${POS_ROUNDS + 1} rows, last = permute`,
      posTr.length === POS_ROUNDS + 1 && posLast.every((v, i) => v === posTr[posTr.length - 1][i]),
      'one row per intermediate state — exactly the STARK execution trace',
    )
    check(
      'Poseidon',
      'compression pinned KAT compress([1,2,3,4])',
      posCompress([1n, 2n, 3n, 4n]).join(',') ===
        '3457105896106100785,6884924267685363494,15415893254428231705,14712388735000733596',
      'permute([m‖0]) truncated to the rate — a 256→256-bit zk-friendly hash',
    )
    check(
      'Poseidon',
      '2-to-1 compression pinned KAT hashTwoToOne(3,5)',
      posHash2(3n, 5n) === 4900053281390009859n,
      'the Merkle-tree compressor',
    )

    // The STARK proving knowledge of a Poseidon preimage (light params for speed).
    const posCfg: PoseidonStarkConfig = { blowup: 4, degreeBound: 256, numQueries: 12 }
    const posPre = [111n, 222n, 333n, 444n]
    const posDigest = posDigestOf(posPre)
    const { proof: posProof } = poseidonStarkProve(posPre, posCfg)
    check(
      'Poseidon',
      'preimage-knowledge STARK verifies',
      poseidonStarkVerify(posDigest, posCfg, posProof).ok,
      'a width-8, degree-7-constraint AIR proven with DEEP + FRI — no trusted setup, only a hash',
    )
    const posWrong = posDigest.slice()
    posWrong[0] = (posWrong[0] + 1n) % GOLD_MOD
    check(
      'Poseidon',
      'STARK rejects a wrong claimed digest',
      !poseidonStarkVerify(posWrong, posCfg, posProof).ok,
      'the proof commits to its own digest; a different claim mismatches',
    )
    const posForgeD = posDigest.slice()
    posForgeD[0] = (posForgeD[0] + 1n) % GOLD_MOD
    const posForgeProof = poseidonStarkProve(posPre, posCfg, { forgeDigest: posForgeD }).proof
    check(
      'Poseidon',
      'STARK soundness: lying about the statement is rejected',
      !poseidonStarkVerify(posForgeD, posCfg, posForgeProof).ok,
      'a false digest makes the output-boundary quotient non-polynomial; FRI catches it',
    )
    const posCorrupt = poseidonStarkProve(posPre, posCfg, { corruptRow: 15 }).proof
    check(
      'Poseidon',
      'STARK soundness: a fudged round is rejected',
      !poseidonStarkVerify(posDigest, posCfg, posCorrupt).ok,
      'one wrong state breaks a transition constraint — the composition stops being low degree',
    )
    const posMauled = structuredClone(posProof)
    posMauled.ood.cols[0] = (posMauled.ood.cols[0] + 1n) % GOLD_MOD
    check(
      'Poseidon',
      'STARK soundness: a mauled out-of-domain value is rejected',
      !poseidonStarkVerify(posDigest, posCfg, posMauled).ok,
      'the DEEP quotient at ζ stops reproducing the committed codeword',
    )
  }

  // ── 26. Post-quantum hash-based signatures (RFC 8391 / SPHINCS⁺) ──
  {
    seedRng(0xc0ffee)

    // Tweakable-hash substrate: the four hashes are SHA-256 with distinct
    // one-word type prefixes, so they behave as independent functions. Anchor
    // them to the KAT-pinned SHA-256 already checked above.
    const key = new Uint8Array(32).fill(0x11)
    const m1 = new Uint8Array(32).fill(0x22)
    check(
      'HashSig',
      'F/PRF domain separation',
      bytesToHex(thF(key, m1)) !== bytesToHex(thPRF(key, m1)),
      'F = SHA256(0‖·), PRF = SHA256(3‖·) — same inputs, different digests',
    )
    check(
      'HashSig',
      'ADRS round-trips through 32 bytes',
      new Adrs().setType(ADRS_OTS).setOts(5).setChain(9).setHash(3).toBytes().length === 32,
      'the RFC 8391 hash-function address is eight big-endian words',
    )
    check(
      'HashSig',
      'H_msg keyed by 3n bytes',
      thHmsg(new Uint8Array(96).fill(7), utf8('m')).length === 32,
      'the randomized message digest keys on r ‖ root ‖ idx',
    )

    // Lamport OTS: round-trip, tamper rejection, and the one-time break —
    // reusing a key a handful of times leaks the whole secret and enables
    // universal forgery.
    const lk = lamport.keygen()
    const lm = utf8('lamport once')
    const lsig = lamport.sign(lk, lm)
    check('HashSig', 'Lamport OTS verifies', lamport.verify(lk.pk, lm, lsig), 'reveal one preimage per digest bit')
    check('HashSig', 'Lamport rejects a tampered message', !lamport.verify(lk.pk, utf8('lamport twice'), lsig), 'a flipped bit selects an unrevealed preimage')
    const forger = lamport.newForger()
    for (let i = 0; i < 24; i++) {
      const mm = utf8('reuse-' + i)
      lamport.observe(forger, mm, lamport.sign(lk, mm))
    }
    const target = utf8('forge-this-message')
    const forged = lamport.forge(forger, target)
    check(
      'HashSig',
      'Lamport: reuse leaks the key → universal forgery',
      lamport.leaked(forger) === lamport.sizes.bits * 2 && !!forged && lamport.verify(lk.pk, target, forged),
      'after ~16 reuses all 512 secrets leak; a forger signs any message',
    )

    // WOTS+ : the RFC 8391 lengths, a round-trip, the chain composition law,
    // and the checksum that stops a forger walking a chain forward.
    const wp = WOTS_W16
    check('HashSig', 'WOTS⁺ lengths (w=16 ⇒ len=67)', wp.len1 === 64 && wp.len2 === 3 && wp.len === 67, 'len₁=⌈8n/lg w⌉, len₂ from the checksum bound')
    const wSk = randomBytes(32)
    const wSeed = randomBytes(32)
    const { adrs: wAdrs, pk: wPk } = wotsKeypair(wSk, wSeed, wp)
    const wMsg = randomBytes(32)
    const wSig = wotsSignFn(wMsg, wSk, wSeed, wAdrs.clone(), wp)
    check('HashSig', 'WOTS⁺ signature verifies', wotsVerifyFn(wMsg, wSig, wPk, wSeed, wAdrs.clone(), wp), 'each chain finished to its top lands on the public key')
    check('HashSig', 'WOTS⁺ rejects a different message', !wotsVerifyFn(randomBytes(32), wSig, wPk, wSeed, wAdrs.clone(), wp), 'the checksum makes forward-walking a chain infeasible')
    const cx = randomBytes(32)
    const cA = wotsChain(cx, 0, 5, wSeed, wAdrs.clone().setChain(2), wp.w)
    const cAB = wotsChain(cA, 5, 4, wSeed, wAdrs.clone().setChain(2), wp.w)
    const cComposed = wotsChain(cx, 0, 9, wSeed, wAdrs.clone().setChain(2), wp.w)
    check('HashSig', 'WOTS⁺ chain composition law', bytesToHex(cAB) === bytesToHex(cComposed), 'chain(·,0,a) then (·,a,b) = chain(·,0,a+b)')
    {
      const pp = wotsParams(4)
      const s = randomBytes(32)
      const sd = randomBytes(32)
      const kp = wotsKeypair(s, sd, pp)
      const mm = randomBytes(32)
      const sg = wotsSignFn(mm, s, sd, kp.adrs.clone(), pp)
      check('HashSig', `WOTS⁺ round-trips at w=4 (len=${pp.len})`, wotsVerifyFn(mm, sg, kp.pk, sd, kp.adrs.clone(), pp), 'the w/size tradeoff, same security')
    }

    // XMSS : a Merkle tree of 2^h WOTS⁺ keys behind one reusable root. Two leaves
    // sign two messages; a tampered auth path fails; the key exhausts and refuses
    // to reuse a leaf.
    const xParams: XmssParams = { h: 2, wots: WOTS_W16 }
    const { pk: xpk, sk: xsk } = xmssKeygen(randomBytes(32), randomBytes(32), randomBytes(32), xParams)
    const xm1 = utf8('xmss leaf 0')
    const xm2 = utf8('xmss leaf 1')
    const xs1 = xmssSign(xsk, xm1)
    check('HashSig', 'XMSS signature verifies', xmssVerify(xpk, xm1, xs1), 'a WOTS⁺ sig + an O(h) auth path to the published root')
    check('HashSig', 'XMSS state advances (idx 0 → 1)', xsk.idx === 1, 'the leaf counter must move — reuse is a break')
    const xs2 = xmssSign(xsk, xm2)
    check('HashSig', 'XMSS second leaf verifies', xmssVerify(xpk, xm2, xs2) && xs2.idx === 1, 'each signature burns a distinct one-time key')
    const xBad = { ...xs1, auth: xs1.auth.map((a, i) => (i === 0 ? a.map((b) => b ^ 1) : a)) }
    check('HashSig', 'XMSS rejects a tampered auth path', !xmssVerify(xpk, xm1, xBad), 're-hashing the path no longer reaches the root')
    const { sk: xskE } = xmssKeygen(randomBytes(32), randomBytes(32), randomBytes(32), xParams)
    let signed = 0
    try {
      for (let i = 0; i < 20; i++) {
        xmssSign(xskE, utf8('m' + i))
        signed++
      }
    } catch {
      /* exhausted */
    }
    check('HashSig', 'XMSS exhausts at 2^h one-time keys', signed === 1 << xParams.h, `all ${1 << xParams.h} leaves used, then signing throws`)

    // SPHINCS⁺ : the stateless scheme. FORS few-time signature under a hypertree.
    // No counter — the same key signs any number of messages, each verifying,
    // and every mauling (FORS path, hypertree WOTS⁺, randomiser) is caught.
    const { pk: spk, sk: ssk } = sphincsKeygen(randomBytes(32), randomBytes(32), randomBytes(32), SPHINCS_TOY)
    const sm = utf8('SPHINCS+ — stateless, hash-only, post-quantum')
    const ssig = sphincsSign(ssk, sm)
    check('HashSig', 'SPHINCS⁺ signature verifies', sphincsVerify(spk, sm, ssig), 'FORS pk climbs the d-layer hypertree to PK.root')
    check('HashSig', 'SPHINCS⁺ rejects a tampered message', !sphincsVerify(spk, utf8('different message'), ssig), 'the digest selects a different FORS/leaf address')
    const sm2 = utf8('a different message, same key, no state')
    const sAllOk = sphincsVerify(spk, sm2, sphincsSign(ssk, sm2))
    check('HashSig', 'SPHINCS⁺ signs another message with no state', sAllOk, 'no counter to lose — the leaf is pseudo-random from R')
    const sBadFors = structuredClone(ssig)
    sBadFors.fors[0].auth[0][0] ^= 1
    check('HashSig', 'SPHINCS⁺ rejects a mauled FORS path', !sphincsVerify(spk, sm, sBadFors), 'the FORS root, hence the FORS pk, changes')
    const sBadHt = structuredClone(ssig)
    sBadHt.ht[0].wots[0][0] ^= 1
    check('HashSig', 'SPHINCS⁺ rejects a mauled hypertree sig', !sphincsVerify(spk, sm, sBadHt), 'the recovered subtree root no longer chains to PK.root')
  }

  // ── ECVRF (RFC 9381) — the official Edwards25519 test vectors ──
  // Byte-for-byte against Appendix B.3 (TAI) and B.4 (ELL2). SK/PK/α are the
  // RFC 8032 §7.1 examples; π (proof) is the standard's own value.
  {
    const vectors: {
      sk: string
      pk: string
      alpha: string
      tai: string
      ell2: string
    }[] = [
      {
        sk: '9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60',
        pk: 'd75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a',
        alpha: '',
        tai: '8657106690b5526245a92b003bb079ccd1a92130477671f6fc01ad16f26f723f26f8a57ccaed74ee1b190bed1f479d9727d2d0f9b005a6e456a35d4fb0daab1268a1b0db10836d9826a528ca76567805',
        ell2: '7d9c633ffeee27349264cf5c667579fc583b4bda63ab71d001f89c10003ab46f14adf9a3cd8b8412d9038531e865c341cafa73589b023d14311c331a9ad15ff2fb37831e00f0acaa6d73bc9997b06501',
      },
      {
        sk: '4ccd089b28ff96da9db6c346ec114e0f5b8a319f35aba624da8cf6ed4fb8a6fb',
        pk: '3d4017c3e843895a92b70aa74d1b7ebc9c982ccf2ec4968cc0cd55f12af4660c',
        alpha: '72',
        tai: 'f3141cd382dc42909d19ec5110469e4feae18300e94f304590abdced48aed5933bf0864a62558b3ed7f2fea45c92a465301b3bbf5e3e54ddf2d935be3b67926da3ef39226bbc355bdc9850112c8f4b02',
        ell2: '47b327393ff2dd81336f8a2ef10339112401253b3c714eeda879f12c509072ef055b48372bb82efbdce8e10c8cb9a2f9d60e93908f93df1623ad78a86a028d6bc064dbfc75a6a57379ef855dc6733801',
      },
      {
        sk: 'c5aa8df43f9f837bedb7442f31dcb7b166d38535076f094b85ce3a2e0b4458f7',
        pk: 'fc51cd8e6218a1a38da47ed00230f0580816ed13ba3303ac5deb911548908025',
        alpha: 'af82',
        tai: '9bc0f79119cc5604bf02d23b4caede71393cedfbb191434dd016d30177ccbf8096bb474e53895c362d8628ee9f9ea3c0e52c7a5c691b6c18c9979866568add7a2d41b00b05081ed0f58ee5e31b3a970e',
        ell2: '926e895d308f5e328e7aa159c06eddbe56d06846abf5d98c2512235eaa57fdce35b46edfc655bc828d44ad09d1150f31374e7ef73027e14760d42e77341fe05467bb286cc2c9d7fde29120a0b2320d04',
      },
    ]
    for (const suite of ['TAI', 'ELL2'] as Suite[]) {
      for (const v of vectors) {
        const seed = hexToBytes(v.sk)
        const alpha = hexToBytes(v.alpha)
        const label = `α = ${v.alpha === '' ? '(empty)' : '0x' + v.alpha}`
        const pk = bytesToHex(ecvrfKeygen(seed))
        check('ECVRF', `${suite} public key, ${label}`, pk === v.pk, `Y = x·B = ${pk.slice(0, 16)}…`)
        const pi = ecvrfProve(suite, seed, alpha)
        const piHex = bytesToHex(proofToBytes(pi))
        const want = suite === 'TAI' ? v.tai : v.ell2
        check(
          'ECVRF',
          `${suite} proof π matches RFC 9381, ${label}`,
          piHex === want,
          `π = ${piHex.slice(0, 20)}… (80 bytes)`,
        )
        check(
          'ECVRF',
          `${suite} verify accepts, ${label}`,
          ecvrfVerify(suite, hexToBytes(v.pk), alpha, pi),
          'c′ recomputed from π equals c',
        )
        // Tampering: flip one bit of the response scalar → verify must fail.
        const mauled = { ...pi, s: pi.s ^ 1n }
        check(
          'ECVRF',
          `${suite} verify rejects a mauled proof, ${label}`,
          !ecvrfVerify(suite, hexToBytes(v.pk), alpha, mauled),
          'a one-bit change in s breaks the challenge equation',
        )
        // β is deterministic and 64 bytes; a different α gives a different β.
        const beta = proofToHash(suite, pi)
        const betaOther = proofToHash(suite, ecvrfProve(suite, seed, concat(alpha, utf8('!'))))
        check(
          'ECVRF',
          `${suite} β is deterministic & unique, ${label}`,
          beta.length === 64 && bytesToHex(beta) !== bytesToHex(betaOther),
          `β = ${bytesToHex(beta).slice(0, 16)}…`,
        )
      }
    }
  }

  // ── Linkable ring signatures & stealth addresses (Monero-style) ──
  {
    const q = RING_L
    // SAG — unlinkable ring signature.
    const sagSecrets = Array.from({ length: 5 }, () => randomScalar(q))
    const sagRing = sagSecrets.map(ringMulBase)
    const sagMsg = utf8('one of us signed this')
    const sag = sagSign(sagMsg, sagRing, sagSecrets[2], 2)
    check('RingSig', 'SAG ring signature verifies', sagVerify(sagMsg, sagRing, sag), '“1-of-n” with no signer revealed')
    check('RingSig', 'SAG rejects a tampered message', !sagVerify(utf8('forged'), sagRing, sag), 'every c_i changes')

    // bLSAG — linkable, with a key image.
    const secrets = Array.from({ length: 6 }, () => randomScalar(q))
    const ring = secrets.map(ringMulBase)
    const msg = utf8('spend output #1')
    let everyPosition = true
    for (let i = 0; i < ring.length; i++) {
      const s = blsagSign(msg, ring, secrets[i], i)
      if (!blsagVerify(msg, ring, s)) everyPosition = false
    }
    check('RingSig', 'bLSAG verifies from every ring position', everyPosition, 'anonymity: the index π is hidden')
    const sig1 = blsagSign(msg, ring, secrets[3], 3)
    const sig2 = blsagSign(utf8('spend again, same key'), ring, secrets[3], 3)
    check('RingSig', 'bLSAG key image = x·Hp(P)', edEqual2(sig1.image, keyImage(secrets[3], ring[3])), 'deterministic in the secret')
    check('RingSig', 'bLSAG links two signatures by the same key', imagesLinked(sig1.image, sig2.image), 'double-spend detection')
    const sigOther = blsagSign(msg, ring, secrets[4], 4)
    check('RingSig', 'bLSAG does not link distinct keys', !imagesLinked(sig1.image, sigOther.image), 'unrelated images stay unlinked')
    check('RingSig', 'bLSAG rejects a swapped key image', !blsagVerify(msg, ring, { ...sig1, image: sigOther.image }), 'the R-side equation fails')

    // CLSAG — concise LSAG over (output key, commitment).
    const p = Array.from({ length: 8 }, () => randomScalar(q))
    const z = Array.from({ length: 8 }, () => randomScalar(q))
    const ringP = p.map(ringMulBase)
    const ringC = z.map(ringMulBase)
    const cmsg = utf8('confidential transfer')
    const clsag = clsagSign(cmsg, ringP, ringC, p[5], z[5], 5)
    check('RingSig', 'CLSAG verifies', clsagVerify(cmsg, ringP, ringC, clsag), 'one scalar per member — “concise”')
    check('RingSig', 'CLSAG rejects a mauled response', !clsagVerify(cmsg, ringP, ringC, { ...clsag, s: clsag.s.map((v, i) => (i === 1 ? v + 1n : v)) }), 'aggregate challenge no longer closes')
    const ringC2 = Array.from({ length: 8 }, () => randomScalar(q)).map(ringMulBase)
    const clsag2 = clsagSign(utf8('a later spend'), ringP, ringC2, p[5], randomScalar(q), 5)
    check('RingSig', 'CLSAG links via the spend-key image I', imagesLinked(clsag.I, clsag2.I), 'I = p·Hp(P) is independent of the amount')

    // Stealth addresses + a full private payment.
    const recip = stealthKeygen()
    const { R, P } = stealthSend(recip.A, recip.Bs, 0)
    const recovered = stealthReceive(recip, R, 0)
    check('RingSig', 'stealth: recipient recovers the one-time key', edEqual2(P, recovered.P), 'x·B = P from the ECDH shared secret')
    check('RingSig', 'stealth: recovered secret opens P', edEqual2(pubFromSecret(recovered.x), P), 'x = H(a·R) + b')
    check('RingSig', 'stealth: a stranger cannot recover P', !edEqual2(stealthReceive(stealthKeygen(), R, 0).P, P), 'needs the recipient’s view key a')
    const decoys = Array.from({ length: 10 }, () => ringMulBase(randomScalar(q)))
    const payRing = [...decoys.slice(0, 4), P, ...decoys.slice(4)]
    const pay = blsagSign(utf8('pay 1 coin'), payRing, recovered.x, 4)
    check('RingSig', 'private payment: ring sig over the stealth output verifies', blsagVerify(utf8('pay 1 coin'), payRing, pay), 'spend a stealth coin among 10 decoys')
  }

  // ── Sealed: the secure channel (ChaCha20-Poly1305, HKDF, X3DH, Double Ratchet) ──
  {
    const bhex = (b: Uint8Array) => bytesToHex(b)
    const range = (n: number, s = 0) => Uint8Array.from({ length: n }, (_, i) => s + i)

    // ChaCha20 block function — RFC 8439 §2.3.2.
    const ccBlock = chacha20Block(range(32), 1, hexToBytes('000000090000004a00000000'))
    check(
      'ChaCha20',
      'block function matches RFC 8439 §2.3.2',
      bhex(ccBlock) ===
        '10f1e7e4d13b5915500fdd1fa32071c4c7d1f4c733c0680304' +
        '22aa9ac3d46c4ed2826446079faa0914c2d705d98b02a2b5129c' +
        'd1de164eb9cbd083e8a2503c4e',
      'the 20-round ARX permutation, keystream block',
    )
    // ChaCha20 encryption — RFC 8439 §2.4.2 (first 16 ciphertext bytes).
    const ccMsg = utf8("Ladies and Gentlemen of the class of '99: If I could offer you only one tip for the future, sunscreen would be it.")
    const ccCt = chacha20(range(32), 1, hexToBytes('000000000000004a00000000'), ccMsg)
    check('ChaCha20', 'stream encryption matches RFC 8439 §2.4.2', bhex(ccCt).startsWith('6e2e359a2568f98041ba0728dd0d6981'), 'counter-mode keystream XOR')

    // Poly1305 — RFC 8439 §2.5.2.
    const polyKey = hexToBytes('85d6be7857556d337f4452fe42d506a80103808afb0db2fd4abff6af4149f51b')
    const polyTag = poly1305Mac(polyKey, utf8('Cryptographic Forum Research Group'))
    check('Poly1305', 'MAC matches RFC 8439 §2.5.2', bhex(polyTag) === 'a8061dc1305136c6c22b8baf0c0127a9', 'a single polynomial mod 2¹³⁰−5')

    // AEAD_CHACHA20_POLY1305 — RFC 8439 §2.8.2 + authentication.
    const aeadKey = range(32, 0x80)
    const aeadNonce = hexToBytes('070000004041424344454647')
    const aeadAad = hexToBytes('50515253c0c1c2c3c4c5c6c7')
    const aead = aeadEncrypt(aeadKey, aeadNonce, ccMsg, aeadAad)
    check('AEAD', 'ChaCha20-Poly1305 tag matches RFC 8439 §2.8.2', bhex(aead.tag) === '1ae10b594f09e26a7e902ecbd0600691', 'tag covers AAD ‖ ciphertext ‖ lengths')
    check('AEAD', 'decrypt round-trips', (() => { const p = aeadDecrypt(aeadKey, aeadNonce, aead.ciphertext, aead.tag, aeadAad); return !!p && bhex(p) === bhex(ccMsg) })(), 'seal → open recovers the plaintext')
    check('AEAD', 'rejects a tampered ciphertext', (() => { const c = aead.ciphertext.slice(); c[0] ^= 1; return aeadDecrypt(aeadKey, aeadNonce, c, aead.tag, aeadAad) === null })(), 'one flipped bit → authentication fails')
    check('AEAD', 'rejects tampered associated data', aeadDecrypt(aeadKey, aeadNonce, aead.ciphertext, aead.tag, hexToBytes('00')) === null, 'the AD is bound into the tag')

    // HKDF-SHA256 — RFC 5869 test case 1 and 3.
    const prk = hkdfExtract(hexToBytes('000102030405060708090a0b0c'), hexToBytes('0b'.repeat(22)))
    check('HKDF', 'extract PRK matches RFC 5869 case 1', bhex(prk) === '077709362c2e32df0ddc3f0dc47bba6390b6c73bb50f9c3122ec844ad7c2b3e5', 'PRK = HMAC(salt, IKM)')
    const okm1 = hkdf(hexToBytes('0b'.repeat(22)), hexToBytes('000102030405060708090a0b0c'), hexToBytes('f0f1f2f3f4f5f6f7f8f9'), 42)
    check('HKDF', 'expand OKM matches RFC 5869 case 1', bhex(okm1) === '3cb25f25faacd57a90434f64d0362f2a2d2d0a90cf1a5a4c5db02d56ecc4c5bf34007208d5b887185865', '42-byte output keying material')
    const okm3 = hkdf(hexToBytes('0b'.repeat(22)), new Uint8Array(0), new Uint8Array(0), 42)
    check('HKDF', 'expand with empty salt/info matches RFC 5869 case 3', bhex(okm3) === '8da4e775a563c18f715f802a063c5a31b8a11f5c5ee1879ec3454e5f3c738d2d9d201395faa4b61a96c8', 'zero-filled default salt')

    // XEdDSA — an X25519 key signs its prekey (Signal).
    const xk = x25519Keypair()
    const xmsg = utf8('signed prekey')
    const xsig = xeddsaSign(xk.priv, xmsg)
    check('XEdDSA', 'X25519 key signs and verifies', xeddsaVerify(xk.pub, xmsg, xsig), 'Montgomery→Edwards, Ed25519 equation')
    check('XEdDSA', 'rejects a tampered message', !xeddsaVerify(xk.pub, utf8('other'), xsig), 'the challenge no longer closes')
    check('XEdDSA', 'rejects the wrong key', !xeddsaVerify(x25519Keypair().pub, xmsg, xsig), 'signature is bound to the signer')

    // X3DH — the extended triple Diffie–Hellman agreement.
    const alice = createParticipant('Alice')
    const bob = createParticipant('Bob')
    const eph = x25519Keypair()
    const bundle = publishBundle(bob, 0)
    const init = x3dhInitiate(alice.identity, eph, bundle)
    const resp = x3dhRespond(bob.identity, bob.signedPreKey, bob.oneTimePreKeys[0], init.message)
    check('X3DH', 'initiator and responder derive the same secret', bhex(init.result.sharedSecret) === bhex(resp.sharedSecret), '3–4 DHs → one HKDF root secret')
    check('X3DH', 'associated data agrees', bhex(init.result.associatedData) === bhex(resp.associatedData), 'AD = IK_A ‖ IK_B, bound into every message')
    check('X3DH', 'rejects a forged signed-prekey signature', (() => { const bad = { ...bundle, signedPreKeySignature: bundle.signedPreKeySignature.slice() }; bad.signedPreKeySignature[3] ^= 1; try { x3dhInitiate(alice.identity, x25519Keypair(), bad); return false } catch { return true } })(), 'a tampered bundle yields no session')

    // Double Ratchet — a full end-to-end conversation.
    {
      const A = createParticipant('Alice')
      const B = createParticipant('Bob')
      const { session: aS, initial } = beginInitiator(A, publishBundle(B, 0))
      const bS = beginResponder(B, 0, initial)
      const m1 = encryptText(aS, 'hi bob')
      check('Ratchet', 'A→B first message decrypts', decryptText(bS, m1) === 'hi bob', 'root key bootstrapped from the X3DH secret')
      const r1 = encryptText(bS, 'hi alice')
      check('Ratchet', 'B→A reply turns the DH ratchet', decryptText(aS, r1) === 'hi alice', 'a new ephemeral reseeds the root')
      const m2 = encryptText(aS, 'new sending chain')
      check('Ratchet', 'A→B on the new chain decrypts', decryptText(bS, m2) === 'new sending chain', 'the symmetric ratchet clicks per message')
      const bad = encryptText(aS, 'secret'); bad.ciphertext[0] ^= 1
      check('Ratchet', 'rejects a tampered ratchet message', decryptText(bS, bad) === null, 'AEAD binds the header as AD')
    }
    check('Ratchet', 'out-of-order delivery still decrypts (3,1,2)', runOutOfOrderDemo().ok, 'skipped message keys are stashed until they arrive')
    check('Ratchet', 'forward secrecy: a used key is deleted', runForwardSecrecyDemo().ok, 'replaying a delivered message fails')
    check('Ratchet', 'post-compromise security: a stolen state heals out', runPostCompromiseDemo().ok, 'one round trip locks the thief back out')
  }

  // ── SHA-3 / SHAKE known-answer tests (FIPS 202) ──
  {
    check('SHA-3', 'SHA3-256("")', bytesToHex(sha3_256(utf8(''))) === 'a7ffc6f8bf1ed76651c14756a061d662f580ff4de43b49fa82d80a4b80f8434a', 'empty → a7ffc6f8…')
    check('SHA-3', 'SHA3-256("abc")', bytesToHex(sha3_256(utf8('abc'))) === '3a985da74fe225b2045c172d6bd390bd855f086e3e9d525b46bfe24511431532', '"abc" → 3a985da7…')
    check('SHA-3', 'SHA3-512("")', bytesToHex(sha3_512(utf8(''))) === 'a69f73cca23a9ac5c8b567dc185a756e97c982164fe25859e0d1dcc1475c80a615b2123af1f5f94c11e3e9402c3ac558f500199d95b6d3e301758586281dcd26', 'empty → a69f73cc…')
    check('SHA-3', 'SHAKE128("", 32)', bytesToHex(shake128(utf8(''), 32)) === '7f9c2ba4e88f827d616045507605853ed73b8093f6efbc88eb1a6eacfa66ef26', 'the XOF absorbs and squeezes correctly')
    check('SHA-3', 'SHAKE256("", 32)', bytesToHex(shake256(utf8(''), 32)) === '46b9dd2b0ba88d13233b3feb743eeb243fcd52ea62b81b82b50c27646ed5762f', 'a second rate, same sponge')
  }

  // ── ML-KEM (FIPS 203) — the from-scratch lattice KEM ──
  {
    // The NTT inverts exactly, and its base multiply is a genuine negacyclic
    // convolution mod X²⁵⁶+1 — the property the whole scheme's speed rests on.
    const f = new Int16Array(256)
    const g = new Int16Array(256)
    for (let i = 0; i < 256; i++) {
      f[i] = (i * 37 + 11) % MLKEM_Q
      g[i] = (i * 101 + 7) % MLKEM_Q
    }
    const back = mlkemInvNtt(mlkemNtt(f))
    let inverts = true
    for (let i = 0; i < 256; i++) inverts = inverts && ((back[i] % MLKEM_Q) + MLKEM_Q) % MLKEM_Q === f[i]
    check('ML-KEM', 'NTT⁻¹(NTT(f)) = f', inverts, 'the forward and inverse transforms are exact inverses')

    // Schoolbook negacyclic convolution to pin nttMul against.
    const conv = new Int16Array(256)
    const acc = new Array<number>(512).fill(0)
    for (let i = 0; i < 256; i++) for (let j = 0; j < 256; j++) acc[i + j] = (acc[i + j] + f[i] * g[j]) % MLKEM_Q
    for (let i = 0; i < 256; i++) conv[i] = (((acc[i] - (acc[i + 256] || 0)) % MLKEM_Q) + MLKEM_Q) % MLKEM_Q
    const viaNtt = mlkemInvNtt(mlkemNttMul(mlkemNtt(f), mlkemNtt(g)))
    let mulOk = true
    for (let i = 0; i < 256; i++) mulOk = mulOk && ((viaNtt[i] % MLKEM_Q) + MLKEM_Q) % MLKEM_Q === conv[i]
    check('ML-KEM', 'base multiply = negacyclic convolution', mulOk, 'the pointwise NTT product matches the degree-256 schoolbook multiply')

    const seed = (b: number) => {
      const a = new Uint8Array(32)
      for (let i = 0; i < 32; i++) a[i] = (i * 61 + b * 97 + 3) & 0xff
      return a
    }
    for (const p of PARAM_SETS) {
      const { ek, dk } = mlkemKeyGen(p, seed(1), seed(2))
      const enc = mlkemEncaps(p, ek, seed(3))
      const dec = mlkemDecaps(p, dk, enc.ciphertext)
      const agree = bytesToHex(dec.sharedSecret) === bytesToHex(enc.sharedSecret) && !dec.rejected
      check('ML-KEM', `${p.name} round-trips`, agree, 'KeyGen→Encaps→Decaps derive the same 32-byte shared secret')

      const sz = kemSizes(p)
      const sizesOk = ek.length === sz.ek && dk.length === sz.dk && enc.ciphertext.length === sz.ct
      check('ML-KEM', `${p.name} byte-sizes match FIPS 203`, sizesOk, `ek ${ek.length} · dk ${dk.length} · ct ${enc.ciphertext.length} bytes`)

      // Implicit rejection: a mauled ciphertext must not reproduce K.
      const bad = enc.ciphertext.slice()
      bad[9] ^= 0x01
      const rej = mlkemDecaps(p, dk, bad)
      const rejectedCleanly = rej.rejected && bytesToHex(rej.sharedSecret) !== bytesToHex(enc.sharedSecret)
      check('ML-KEM', `${p.name} implicit rejection`, rejectedCleanly, 'FO re-encryption catches the tamper and returns the pseudorandom fallback')
    }

    // Hybrid X25519MLKEM768 — the TLS 1.3 handshake, both halves from scratch.
    const hd = (b: number) => {
      const a = new Uint8Array(32)
      for (let i = 0; i < 32; i++) a[i] = (i * 41 + b * 131 + 5) & 0xff
      return a
    }
    const client = hybridClientKeyGen(hd(1), hd(2), hd(3))
    const server = hybridServerRespond(client.clientShare, hd(4), hd(5))
    const finish = hybridClientFinish(client, server.serverShare)
    check('Hybrid KEM', 'X25519MLKEM768 both sides agree', bytesToHex(server.sessionKey) === bytesToHex(finish.sessionKey), 'concat(ss_mlkem ‖ ss_x25519) → the same 32-byte session key')
    check('Hybrid KEM', 'combined secret is 64 bytes', server.sharedSecret.length === 64, '32-byte ML-KEM secret ‖ 32-byte X25519 secret')
    const badServer = server.serverShare.slice()
    badServer[server.serverShare.length - 3] ^= 1 // maul the server's X25519 public
    const brokenX = hybridClientFinish(client, badServer)
    check('Hybrid KEM', 'a broken X25519 half breaks agreement', bytesToHex(brokenX.sessionKey) !== bytesToHex(server.sessionKey), 'both primitives must succeed — the security is the AND of the two')
  }

  // ── 34. Secure two-party computation (OT + Yao's garbled circuits) ──
  {
    // Oblivious transfer: the receiver opens exactly the chosen branch, and the
    // other ciphertext is not the plaintext (the sender's pad is unrecoverable).
    for (const c of [0, 1] as const) {
      const m0 = utf8('branch-zero-message!')
      const m1 = utf8('branch-one-message!!')
      const r = obliviousTransfer(m0, m1, c)
      check('MPC · OT', `choice c=${c} opens the chosen message`, bytesToHex(r.received) === bytesToHex(c === 0 ? m0 : m1), 'Chou–Orlandi 1-of-2 OT on Ed25519')
    }
    {
      const m0 = utf8('AAAAAAAAAAAAAAAA')
      const m1 = utf8('BBBBBBBBBBBBBBBB')
      const r = obliviousTransfer(m0, m1, 0)
      check('MPC · OT', 'the unchosen ciphertext hides its message', bytesToHex(r.e1) !== bytesToHex(m1), 'e₁ is a one-time pad under a key the receiver never learns')
    }
    {
      // 1-of-N OT (built from ⌈log₂N⌉ base OTs): every index opens its own message.
      const msgs = Array.from({ length: 5 }, (_, j) => utf8(`option-${j}-payload`))
      let ok = true
      for (let c = 0; c < msgs.length; c++) {
        if (bytesToHex(otOneOfN(msgs, c).received) !== bytesToHex(msgs[c])) ok = false
      }
      check('MPC · OT', '1-of-N OT opens exactly the chosen index', ok, '1-of-5 OT from ⌈log₂5⌉ = 3 base 1-of-2 OTs')
    }

    // Garble + evaluate every truth row of each elementary gate.
    const gateCircuit = (type: 'AND' | 'XOR' | 'INV'): Circuit => {
      const bld = new CircuitBuilder()
      const x = bld.aliceInput()
      const y = bld.bobInput()
      const out = type === 'AND' ? bld.and(x, y) : type === 'XOR' ? bld.xor(x, y) : bld.inv(x)
      return bld.build([out])
    }
    const garbleEval = (circ: Circuit, ab: number[], bb: number[]): number[] => {
      const gc = garbleCircuit(circ)
      const active: Label[] = new Array(circ.numWires)
      circ.aliceInputs.forEach((w, i) => (active[w] = inputLabel(gc, w, ab[i])))
      circ.bobInputs.forEach((w, i) => (active[w] = inputLabel(gc, w, bb[i])))
      return evaluateCircuit(circ, publicTables(gc), active).bits
    }
    for (const type of ['AND', 'XOR', 'INV'] as const) {
      const circ = gateCircuit(type)
      let ok = true
      for (let a = 0; a < 2; a++)
        for (let b = 0; b < 2; b++) {
          if (garbleEval(circ, [a], [b])[0] !== evalPlain(circ, [a], [b])[0]) ok = false
        }
      check('MPC · Garble', `${type} gate garbles to its truth table`, ok, 'free-XOR / half-gate garbling decodes correctly')
    }

    // Whole circuits, exhaustive over all 4-bit input pairs, vs the plaintext.
    const exhaustive = (mk: (bits: number) => Circuit): boolean => {
      const bits = 4
      const lim = 1 << bits
      for (let a = 0; a < lim; a++)
        for (let b = 0; b < lim; b++) {
          const circ = mk(bits)
          const out = garbleEval(circ, toBits(a, bits), toBits(b, bits))
          const exp = evalPlain(circ, toBits(a, bits), toBits(b, bits))
          if (out.length !== exp.length || out.some((v, i) => v !== exp[i])) return false
        }
      return true
    }
    check('MPC · Garble', 'comparator circuit exact on all 4-bit pairs', exhaustive(millionairesCircuit), '256 garble→evaluate runs, each equals a > b')
    check('MPC · Garble', 'equality circuit exact on all 4-bit pairs', exhaustive(equalityCircuit), '256 runs, each equals a == b')
    check('MPC · Garble', 'adder circuit exact on all 4-bit pairs', exhaustive(sumCircuit), '256 runs, each equals a + b')

    // Full end-to-end protocol (OT + garbling) on representative inputs.
    const mBob = runMillionaires(96, 140, 8)
    check('MPC · 2PC', "Millionaires': Bob (140) richer than Alice (96)", !mBob.aliceRicher && mBob.agrees, 'the secure output matches the plaintext comparison')
    const mAlice = runMillionaires(200, 50, 8)
    check('MPC · 2PC', "Millionaires': Alice (200) richer than Bob (50)", mAlice.aliceRicher && mAlice.agrees, 'output = 1 iff Alice > Bob')
    const eq = runEquality(0xab, 0xab, 8)
    check('MPC · 2PC', 'private equality detects a match', eq.equal && eq.agrees, 'a == b learned without revealing a or b')
    const eqNo = runEquality(0xab, 0xac, 8)
    check('MPC · 2PC', 'private equality detects a mismatch', !eqNo.equal && eqNo.agrees, 'a ≠ b, output 0')
    const sum = runSum(100, 55, 8)
    check('MPC · 2PC', 'private sum reveals only a + b', sum.sum === 155 && sum.agrees, '100 + 55 = 155 via a garbled adder')
    const prod = runProduct(9, 7, 6)
    check('MPC · 2PC', 'private product reveals only a · b', prod.product === 63 && prod.agrees, '9 · 7 = 63 via a garbled multiplier')
    const auc = runAuction(150, 90, 8)
    check('MPC · 2PC', 'sealed-bid auction: winner + second price', auc.aliceWins && auc.price === 90 && auc.agrees, 'Alice (150) beats Bob (90); price = the lower bid, 90 — bids never revealed')
    const aucTie = runAuction(70, 70, 8)
    check('MPC · 2PC', 'sealed-bid auction resolves a tie', !aucTie.aliceWins && aucTie.price === 70 && aucTie.agrees, 'equal bids → not strictly higher, price = 70')
  }

  return t
}

// A minimal deep clone for the STARK proof (structuredClone preserves bigint).
function structuredCloneProof<T>(p: T): T {
  return structuredClone(p)
}
