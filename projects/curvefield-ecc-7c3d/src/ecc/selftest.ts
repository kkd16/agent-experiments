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
import {
  RSA as VDF_RSA,
  toGenerator as vdfGen,
  evalVDF,
  evalTrapdoor,
  wesolowskiProve,
  wesolowskiProveStreaming,
  wesolowskiVerify,
  pietrzakProve,
  pietrzakVerify,
  isProbablePrime as vdfIsPrime,
  hashToPrime as vdfHashToPrime,
  bitLength as vdfBitLen,
  timeLock,
  timeUnlock,
  beaconChain,
  vdfCheckpoints,
} from './vdf'
import {
  reduce as cgReduce,
  compose as cgCompose,
  square as cgSquare,
  power as cgPower,
  identity as cgIdentity,
  inverse as cgInverse,
  isReduced as cgIsReduced,
  formEq as cgFormEq,
  discriminant as cgDisc,
  primeForm as cgPrimeForm,
  generateDiscriminant as cgGenDisc,
  type Form as CgForm,
} from './classgroup'
import {
  bbsKeygen,
  bbsSign,
  bbsVerify,
  bbsProofGen,
  bbsProofVerify,
  createGenerators as bbsGenerators,
  messagesToScalars as bbsMsgs,
  messageToScalar as bbsMsg,
  blindCommit as bbsBlindCommit,
  verifyBlindRequest as bbsVerifyBlindRequest,
  blindSign as bbsBlindSign,
} from './bbs'
import {
  CG,
  evalVDF as cgEval,
  wesolowskiProve as cgProve,
  wesolowskiProveStreaming as cgProveStreaming,
  wesolowskiVerify as cgVerify,
  beaconChain as cgBeacon,
} from './cgvdf'
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
import * as lookup from './lookup'
import {
  setup as novaSetup,
  stepR1CS as novaStepR1CS,
  stepAssign as novaStepAssign,
  stepEval as novaStepEval,
  strictInstance as novaStrictInstance,
  relaxedSatisfied as novaRelaxedSatisfied,
  foldProve as novaFoldProve,
  foldVerify as novaFoldVerify,
  crossTerm as novaCrossTerm,
  instanceEq as novaInstanceEq,
  ivcProve as novaIvcProve,
  ivcProveWith as novaIvcProveWith,
  ivcVerify as novaIvcVerify,
  NovaTranscript,
} from './nova'
import { mimcStep as novaMimcStep } from './nova_mimc'
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
import { pow as goldPow2, mul as goldMul } from './goldilocks'
import {
  productClaim as scProductClaim,
  productOracle as scProductOracle,
  sumcheckProve,
  sumcheckVerify,
  mleEval as mleEvalGkr,
} from './sumcheck'
import { exampleCircuit, evaluate as gkrEvaluate, gkrProve, gkrVerify } from './gkr'
import {
  matMul,
  matmulProve,
  matmulVerify,
  countTriangles,
  trianglesProve,
  trianglesVerify,
} from './sumcheck_apps'
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
  keyGenFromSeeds as slhKeyGen,
  signTrace as slhSignTrace,
  verify as slhVerify,
  encodePk as slhEncodePk,
  decodeSk as slhDecodeSk,
  KEYGEN_KAT as slhKeygenKat,
  SIGGEN_KAT as slhSiggenKat,
} from './slhdsa'
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
import { SBOX, INV_SBOX, encryptBlock, decryptBlock, ctr as aesCtr, traceEncrypt } from './aes'
import { gcmEncrypt, gcmDecrypt, gmac, computeJ0 } from './gcm'
import { cmac, cmacSubkeys } from './cmac'
import { gcmSivEncrypt, gcmSivDecrypt, deriveKeysPublic, polyvalDot } from './gcmsiv'
import { sivEncrypt, sivDecrypt, seal as aesSivSeal } from './aessiv'
import { ccmEncrypt, ccmDecrypt } from './ccm'
import { runSuiteRoundTrip } from './signal'
import { CHACHA20_POLY1305, AES_256_GCM } from './doubleratchet'
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
import {
  PARAM_SETS as MLDSA_SETS,
  keyGen as mldsaKeyGen,
  sign as mldsaSign,
  verify as mldsaVerify,
  signPreHash as mldsaSignPreHash,
  verifyPreHash as mldsaVerifyPreHash,
  sizes as mldsaSizes,
  ntt as mldsaNtt,
  invNtt as mldsaInvNtt,
  nttMul as mldsaNttMul,
  power2Round,
  decompose,
  makeHint,
  applyHint,
  highBits,
  sampleInBall,
  toSigned as mldsaToSigned,
  Q as MLDSA_Q,
  D as MLDSA_D,
} from './mldsa'
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
import { gmwCompute } from './gmw'
import {
  encrypt as elgEncrypt,
  decryptToPoint as elgDecrypt,
  addCipher as elgAdd,
  zeroCipher as elgZero,
  dlogSmall as elgDlog,
  proveEnc01,
  verifyEnc01,
  eq as elgEq,
} from './elgamal'
import {
  runDKG,
  castBallot,
  sealBallot,
  auditBallot,
  verifyBallot,
  aggregate as tallyAggregate,
  decryptShare,
  verifyDecryptionShare,
  combineShares,
  tally as runTally,
  verifyElection,
  plaintextCounts,
  stuffBallot,
  corruptShare as corruptDecShare,
} from './voting'
import { publicKey as elgPublicKey } from './secp256k1'

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

  // ── 32b. Lookup arguments: logUp (KZG SNARK) + Plookup + range/XOR tables ──
  {
    const LTAU = 0x1234_5678_9abc_def0_feed_face_dead_beefn

    // logUp: an honest lookup accepts, and the multiplicities are correct.
    {
      const table = [3n, 5n, 8n, 13n, 21n, 34n, 55n, 89n]
      const witness = [8n, 8n, 55n, 3n, 21n, 8n]
      const N = lookup.padToPow2(Math.max(table.length, witness.length))
      const inst = { table, N }
      const srs = lookup.logupSetup(N, LTAU)
      const { proof, aux } = lookup.logupProve(srs, inst, witness)
      const rep = lookup.logupReplay(aux)
      check('Lookup', 'logUp grand-sum closes to 0 (Σ aᵢ = 0)', rep.closes && rep.rowsOk, 'the log-derivative accumulator telescopes over H')
      const row8 = aux.tablePadded.findIndex((v) => v === 8n)
      check('Lookup', 'logUp multiplicity of 8 is 3', aux.multiplicities[row8] === 3n, '8 is looked up 3× → m₈ = 3')
      const res = lookup.logupVerify(srs, inst, proof)
      check('Lookup', 'logUp proof verifies (6 openings, one pairing)', res.ok && res.openingsOk && res.identityOk, res.detail)
    }

    // logUp: an out-of-table value is rejected.
    {
      const table = [3n, 5n, 8n, 13n, 21n]
      const witness = [8n, 999n, 3n] // 999 ∉ table
      const N = lookup.padToPow2(Math.max(table.length, witness.length))
      const inst = { table, N }
      const srs = lookup.logupSetup(N, LTAU)
      const { proof, aux } = lookup.logupProve(srs, inst, witness, { forceCheat: true })
      check('Lookup', 'logUp: an out-of-table value is unassignable', !aux.inTable, '999 has no matching table row')
      check('Lookup', 'logUp soundness: out-of-table proof is rejected', !lookup.logupVerify(srs, inst, proof).ok, 'the identity cannot close, so verify fails')
    }

    // logUp: a tampered opening breaks the pairing check.
    {
      const table = [1n, 2n, 4n, 8n, 16n, 32n]
      const witness = [4n, 16n, 1n, 8n]
      const N = lookup.padToPow2(Math.max(table.length, witness.length))
      const inst = { table, N }
      const srs = lookup.logupSetup(N, LTAU)
      const { proof } = lookup.logupProve(srs, inst, witness)
      const mauled = { ...proof, fz: (proof.fz + 1n) % BLS_SCALAR }
      check('Lookup', 'logUp soundness: a mauled opening is rejected', !lookup.logupVerify(srs, inst, mauled).ok, 'a wrong evaluation fails the KZG pairing')
    }

    // Range check via logUp: in-range accepts, out-of-range rejects.
    {
      const table = lookup.rangeTable(4) // {0,…,15}
      const N = lookup.padToPow2(table.length)
      const inst = { table, N }
      const srs = lookup.logupSetup(N, LTAU)
      const good = lookup.logupVerify(srs, inst, lookup.logupProve(srs, inst, [0n, 7n, 15n, 3n, 10n]).proof)
      check('Lookup', 'range check 0 ≤ x < 2⁴ accepts', good.ok, 'every value looks up into {0,…,15}')
      const badP = lookup.logupProve(srs, inst, [0n, 7n, 16n], { forceCheat: true }).proof
      check('Lookup', 'range check rejects 16 ∉ [0,16)', !lookup.logupVerify(srs, inst, badP).ok, 'the escaped value breaks the lookup')
    }

    // XOR table via a vector (multi-column) lookup.
    {
      const tableRows = lookup.xorTable(2) // (x,y,x⊕y), x,y ∈ {0,1,2,3}
      const gamma = 0x9e3779b97f4a7c15n
      const good = lookup.foldVectorLookup({ tableRows, witnessRows: [[1n, 2n, 3n], [3n, 3n, 0n], [2n, 1n, 3n]], gamma })
      const N = lookup.padToPow2(Math.max(good.table.length, good.witness.length))
      const inst = { table: good.table, N }
      const srs = lookup.logupSetup(N, LTAU)
      check('Lookup', 'XOR table accepts correct triples (1⊕2=3, …)', lookup.logupVerify(srs, inst, lookup.logupProve(srs, inst, good.witness).proof).ok, 'folded (a,b,a⊕b) rows are in the table')
      const bad = lookup.foldVectorLookup({ tableRows, witnessRows: [[1n, 2n, 2n]], gamma })
      const badP = lookup.logupProve(srs, inst, bad.witness, { forceCheat: true }).proof
      check('Lookup', 'XOR table rejects a wrong triple (1⊕2 ≠ 2)', !lookup.logupVerify(srs, inst, badP).ok, 'a bad bitwise result fails the lookup')
    }

    // Plookup: the original transparent multiset-equality identity.
    {
      const table = [3n, 5n, 8n, 13n, 21n, 34n]
      const good = lookup.plookupCheck([8n, 8n, 21n, 3n, 34n], table)
      check('Lookup', 'Plookup identity holds for f ⊆ t', good.equal, `sorted merge |s| = ${good.s.length}; LHS = RHS`)
      const bad = lookup.plookupCheck([8n, 7n, 3n], table) // 7 ∉ t
      check('Lookup', 'Plookup identity fails for f ⊄ t', !bad.equal, '7 ∉ t breaks the (1+β)ⁿ product equality')
    }
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

  // ── SLH-DSA (FIPS 205) — the standardised stateless hash-based signature ──
  // The real, standards-grade scheme (not the toy above): pinned byte-for-byte to
  // NIST's own ACVP known-answer vectors for the SHA-2 category-1 sets.
  {
    for (const kv of slhKeygenKat) {
      const { pk } = slhKeyGen(kv.params, hexToBytes(kv.skSeed), hexToBytes(kv.skPrf), hexToBytes(kv.pkSeed))
      check('SLH-DSA', `${kv.name} keyGen == NIST ACVP`, bytesToHex(slhEncodePk(pk)).toUpperCase() === kv.pk.toUpperCase(), `PK.root reproduces the standard's own vector`)
    }
    // sigGen: reproduce the deterministic signature and pin SHA-256(sig). The -128f
    // set is included live (~10⁵ hashes); -128s (~2·10⁶) is validated in the page.
    const fSig = slhSiggenKat.find((s) => s.name.endsWith('128f'))!
    {
      const sk = slhDecodeSk(fSig.params, hexToBytes(fSig.sk))
      const pk = { pkSeed: sk.pkSeed, pkRoot: sk.pkRoot }
      const { sig } = slhSignTrace(fSig.params, sk, hexToBytes(fSig.message), { ctx: hexToBytes(fSig.context), deterministic: true })
      check('SLH-DSA', `${fSig.name} sigGen == NIST ACVP`, bytesToHex(sha256(sig)) === fSig.sigSha256 && sig.length === fSig.params.sigBytes, `deterministic signature (${(sig.length / 1024).toFixed(1)} KB) hashes to the pinned digest`)
      check('SLH-DSA', `${fSig.name} verify accepts`, slhVerify(fSig.params, pk, hexToBytes(fSig.message), sig, hexToBytes(fSig.context)), 'the FORS pk climbs the hypertree to PK.root')
      const bad = sig.slice(); bad[fSig.params.n + 7] ^= 1
      check('SLH-DSA', `${fSig.name} verify rejects a mauled signature`, !slhVerify(fSig.params, pk, hexToBytes(fSig.message), bad, hexToBytes(fSig.context)), 'a flipped byte reaches a different root')
      check('SLH-DSA', `${fSig.name} verify rejects a wrong context`, !slhVerify(fSig.params, pk, hexToBytes(fSig.message), sig, utf8('x')), 'the context is bound into the message digest')
    }
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

  // ── AES + the authenticated modes (FIPS-197, NIST SP 800-38D, RFC 4493/8452) ──
  {
    const bhex = (b: Uint8Array) => bytesToHex(b)
    const hb = (s: string) => (s.length ? hexToBytes(s) : new Uint8Array(0))

    // The S-box is computed from the GF(2⁸) inverse + affine map, not tabled.
    check('AES', 'S-box S(0x00) = 0x63 (FIPS-197 fixed point)', SBOX[0x00] === 0x63 && SBOX[0x53] === 0xed, 'inversion in GF(2⁸) then the affine transform')
    check('AES', 'inverse S-box undoes the S-box on all 256 bytes', Array.from({ length: 256 }, (_, i) => i).every((i) => INV_SBOX[SBOX[i]] === i), 'a genuine permutation of the byte space')

    // FIPS-197 worked examples — all three key sizes, same 128-bit plaintext.
    const pt = hb('00112233445566778899aabbccddeeff')
    check('AES', 'AES-128 matches FIPS-197 Appendix C.1', bhex(encryptBlock(hb('000102030405060708090a0b0c0d0e0f'), pt)) === '69c4e0d86a7b0430d8cdb78070b4c55a', 'key 000102…0f → 69c4e0d8…')
    check('AES', 'AES-192 matches FIPS-197 Appendix C.2', bhex(encryptBlock(hb('000102030405060708090a0b0c0d0e0f1011121314151617'), pt)) === 'dda97ca4864cdfe06eaf70a0ec0d7191', '12-round schedule')
    check('AES', 'AES-256 matches FIPS-197 Appendix C.3', bhex(encryptBlock(hb('000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f'), pt)) === '8ea2b7ca516745bfeafc49904b496089', '14-round schedule')
    check('AES', 'decryption inverts the cipher', bhex(decryptBlock(hb('000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f'), hb('8ea2b7ca516745bfeafc49904b496089'))) === bhex(pt), 'the equivalent inverse cipher recovers the block')

    // The round-by-round trace, pinned to the FIPS-197 Appendix B example.
    const steps = traceEncrypt(hb('2b7e151628aed2a6abf7158809cf4f3c'), hb('3243f6a8885a308d313198a2e0370734'))
    const r1sb = steps.find((s) => s.round === 1 && s.op === 'subbytes')!
    const r1mc = steps.find((s) => s.round === 1 && s.op === 'mixcolumns')!
    check('AES', 'Appendix B round-1 SubBytes state', bhex(r1sb.state) === 'd42711aee0bf98f1b8b45de51e415230', 'the instrumented trace the lab animates')
    check('AES', 'Appendix B round-1 MixColumns state', bhex(r1mc.state) === '046681e5e0cb199a48f8d37a2806264c', 'diffusion across each column via GF(2⁸)')
    check('AES', 'final ciphertext matches FIPS-197 Appendix B', bhex(steps[steps.length - 1].state) === '3925841d02dc09fbdc118597196a0b32', 'end-to-end worked example')

    // AES-CTR turns the block cipher into a stream cipher (self-inverse).
    const ctrKey = hb('2b7e151628aed2a6abf7158809cf4f3c'), ctrIv = hb('f0f1f2f3f4f5f6f7f8f9fafbfcfdfeff')
    const ctrMsg = utf8('AES-CTR is a stream cipher built from a block cipher.')
    check('AES-CTR', 'encryption round-trips (self-inverse XOR)', bhex(aesCtr(ctrKey, ctrIv, aesCtr(ctrKey, ctrIv, ctrMsg))) === bhex(ctrMsg), 'E∘E = identity in counter mode')

    // AES-GCM — the NIST / McGrew–Viega test vectors (SP 800-38D).
    const zk = hb('00000000000000000000000000000000'), ziv = hb('000000000000000000000000')
    check('AES-GCM', 'GHASH key H = E_K(0) (test case 1)', bhex(encryptBlock(zk, new Uint8Array(16))) === '66e94bd4ef8a2c3b884cfa59ca342b2e', 'the universal-hash key is one AES call')
    const tc1 = gcmEncrypt(zk, ziv, hb(''), hb(''))
    check('AES-GCM', 'empty message, tag matches test case 1', bhex(tc1.tag) === '58e2fccefa7e3061367f1d57a4e7455a', 'GHASH of the length block only')
    const tc2 = gcmEncrypt(zk, ziv, hb('00000000000000000000000000000000'), hb(''))
    check('AES-GCM', 'test case 2 ciphertext + tag', bhex(tc2.ciphertext) === '0388dace60b6a392f328c2b971b2fe78' && bhex(tc2.tag) === 'ab6e47d42cec13bdf53a67b21257bddf', 'one zero block encrypted + authenticated')
    const K3 = hb('feffe9928665731c6d6a8f9467308308'), IV3 = hb('cafebabefacedbaddecaf888')
    const P3 = hb('d9313225f88406e5a55909c5aff5269a86a7a9531534f7da2e4c303d8a318a721c3c0c95956809532fcf0e2449a6b525b16aedf5aa0de657ba637b391aafd255')
    const tc3 = gcmEncrypt(K3, IV3, P3, hb(''))
    check('AES-GCM', 'test case 3: 4 blocks, 96-bit IV', bhex(tc3.ciphertext) === '42831ec2217774244b7221b784d0d49ce3aa212f2c02a4e035c17e2329aca12e21d514b25466931c7d8f6a5aac84aa051ba30b396a0aac973d58e091473f5985' && bhex(tc3.tag) === '4d5c2af327cd64a62cf35abd2ba6fab4', 'CTR keystream + GHASH over the ciphertext')
    const A4 = hb('feedfacedeadbeeffeedfacedeadbeefabaddad2')
    const P4 = hb('d9313225f88406e5a55909c5aff5269a86a7a9531534f7da2e4c303d8a318a721c3c0c95956809532fcf0e2449a6b525b16aedf5aa0de657ba637b39')
    const tc4 = gcmEncrypt(K3, IV3, P4, A4)
    check('AES-GCM', 'test case 4: with associated data', bhex(tc4.ciphertext) === '42831ec2217774244b7221b784d0d49ce3aa212f2c02a4e035c17e2329aca12e21d514b25466931c7d8f6a5aac84aa051ba30b396a0aac973d58e091' && bhex(tc4.tag) === '5bc94fbc3221a5db94fae95ae7121a47', 'the AAD is folded into GHASH but not encrypted')
    const tc5 = gcmEncrypt(K3, hb('cafebabefacedbad'), P4, A4)
    check('AES-GCM', 'test case 5: 64-bit IV exercises GHASH-based J0', bhex(tc5.tag) === '3612d2e79e3b0785561be14aaca2fccb', 'a non-96-bit nonce is itself hashed to form J0')
    check('AES-GCM', 'decrypt round-trips', bhex(gcmDecrypt(K3, IV3, tc4.ciphertext, tc4.tag, A4) ?? new Uint8Array(1)) === bhex(P4), 'verify-then-decrypt recovers the plaintext')
    check('AES-GCM', 'rejects a tampered ciphertext', (() => { const c = tc4.ciphertext.slice(); c[0] ^= 1; return gcmDecrypt(K3, IV3, c, tc4.tag, A4) === null })(), 'one flipped bit → the tag fails')
    check('AES-GCM', 'rejects tampered associated data', gcmDecrypt(K3, IV3, tc4.ciphertext, tc4.tag, hb('00')) === null, 'GHASH binds the AAD')
    check('AES-GMAC', 'GMAC = GCM tag over empty plaintext', bhex(gmac(K3, IV3, A4)) === bhex(gcmEncrypt(K3, IV3, hb(''), A4).tag), 'authentication-only mode')
    check('AES-GCM', 'J0 for a 96-bit IV is IV‖0³¹‖1', bhex(computeJ0(encryptBlock(zk, new Uint8Array(16)), ziv)) === '00000000000000000000000000000001', 'the counter pre-block')

    // AES-CMAC — RFC 4493 test vectors.
    const cmK = hb('2b7e151628aed2a6abf7158809cf4f3c')
    const sk = cmacSubkeys(cmK)
    check('AES-CMAC', 'subkeys K1,K2 match RFC 4493', bhex(sk.K1) === 'fbeed618357133667c85e08f7236a8de' && bhex(sk.K2) === 'f7ddac306ae266ccf90bc11ee46d513b', 'the GF(2¹²⁸) shift-and-XOR that closes CBC-MAC')
    check('AES-CMAC', 'MAC of the empty message', bhex(cmac(cmK, hb(''))) === 'bb1d6929e95937287fa37d129b756746', '10* padding, ⊕K2')
    check('AES-CMAC', 'MAC of one full block', bhex(cmac(cmK, hb('6bc1bee22e409f96e93d7e117393172a'))) === '070a16b46b4d4144f79bdd9dd04a287c', 'exact multiple, ⊕K1')
    check('AES-CMAC', 'MAC of a 40-byte message', bhex(cmac(cmK, hb('6bc1bee22e409f96e93d7e117393172aae2d8a571e03ac9c9eb76fac45af8e5130c81c46a35ce411'))) === 'dfa66747de9ae63030ca32611497c827', 'a partial final block, ⊕K2')

    // AES-GCM-SIV — nonce-misuse-resistant AEAD (RFC 8452).
    const sivK = hb('01000000000000000000000000000000'), sivN = hb('030000000000000000000000')
    const dk = deriveKeysPublic(sivK, sivN)
    check('AES-GCM-SIV', 'DeriveKeys auth key matches RFC 8452 C.1', bhex(dk.mak) === 'd9b360279694941ac5dbc6987ada7377', 'the nonce is hashed through AES to split the key')
    const sivEmpty = gcmSivEncrypt(sivK, sivN, hb(''), hb(''))
    check('AES-GCM-SIV', 'empty-message result matches RFC 8452 C.1', bhex(sivEmpty.tag) === 'dc20e2d83f25705bb49e439eca56de25', 'tag = AES_MEK(nonce), SIV counter unused')
    // The POLYVAL field: identity x¹²⁸ mod M, commutativity, distributivity.
    const e = (1n << 127n) | (1n << 126n) | (1n << 121n) | 1n
    const rnd = (s: number) => { let x = BigInt(s), v = 0n; for (let i = 0; i < 128; i++) { x = (x * 6364136223846793005n + 1n) & ((1n << 64n) - 1n); v |= ((x >> 33n) & 1n) << BigInt(i) } return v }
    const polyvalOk = Array.from({ length: 16 }, (_, i) => i + 1).every((i) => { const a = rnd(i), b = rnd(i + 99), c = rnd(i + 199); return polyvalDot(a, e) === a && polyvalDot(a, b) === polyvalDot(b, a) && polyvalDot(a ^ c, b) === (polyvalDot(a, b) ^ polyvalDot(c, b)) })
    check('AES-GCM-SIV', 'POLYVAL is a valid field multiply (dot·x⁻¹²⁸)', polyvalOk, 'identity, commutativity, distributivity over 𝔽₂¹²⁸')
    const sivMsg = utf8('nonce reuse should not be catastrophic here')
    const sivAad = hb('01020304')
    const siv1 = gcmSivEncrypt(sivK, sivN, sivMsg, sivAad)
    check('AES-GCM-SIV', 'AES-128 encrypt→decrypt round-trips', bhex(gcmSivDecrypt(sivK, sivN, siv1.ciphertext, siv1.tag, sivAad) ?? new Uint8Array(1)) === bhex(sivMsg), 'the synthetic-IV tag reseeds CTR')
    const siv2 = gcmSivEncrypt(sivK, sivN, sivMsg, sivAad)
    check('AES-GCM-SIV', 'deterministic under nonce reuse', bhex(siv1.tag) === bhex(siv2.tag) && bhex(siv1.ciphertext) === bhex(siv2.ciphertext), 'same inputs → same output (the minimum leakage)')
    check('AES-GCM-SIV', 'a different plaintext gives a different tag', bhex(gcmSivEncrypt(sivK, sivN, utf8('a different plaintext under the same nonce!!'), sivAad).tag) !== bhex(siv1.tag), 'no cross-plaintext keystream reuse')
    check('AES-GCM-SIV', 'rejects a tampered ciphertext', (() => { const c = siv1.ciphertext.slice(); c[0] ^= 1; return gcmSivDecrypt(sivK, sivN, c, siv1.tag, sivAad) === null })(), 'the SIV tag authenticates')
    const sivK256 = hb('0100000000000000000000000000000000000000000000000000000000000000')
    const siv256 = gcmSivEncrypt(sivK256, sivN, sivMsg, sivAad)
    check('AES-GCM-SIV', 'AES-256 variant round-trips', bhex(gcmSivDecrypt(sivK256, sivN, siv256.ciphertext, siv256.tag, sivAad) ?? new Uint8Array(1)) === bhex(sivMsg), 'DeriveKeys extends to a 32-byte encryption key')

    // AES-SIV — the CMAC-based deterministic AEAD (RFC 5297).
    const sivKey = hb('fffefdfcfbfaf9f8f7f6f5f4f3f2f1f0f0f1f2f3f4f5f6f7f8f9fafbfcfdfeff')
    const sivAd = hb('101112131415161718191a1b1c1d1e1f2021222324252627')
    const sivPt = hb('112233445566778899aabbccddee')
    const sr = sivEncrypt(sivKey, sivPt, [sivAd])
    check('AES-SIV', 'S2V synthetic IV matches RFC 5297 A.1', bhex(sr.v) === '85632d07c6e8f37f950acd320a2ecc93', 'the CMAC-based PRF over (AD, plaintext)')
    check('AES-SIV', 'CTR ciphertext matches RFC 5297 A.1', bhex(sr.ciphertext) === '40c02b9690c4dc04daef7f6afe5c', 'V (two bits masked) seeds the counter')
    check('AES-SIV', 'V ‖ C wire format matches RFC 5297 A.1', bhex(aesSivSeal(sivKey, sivPt, [sivAd])) === '85632d07c6e8f37f950acd320a2ecc9340c02b9690c4dc04daef7f6afe5c', 'the synthetic IV is prepended as the tag')
    check('AES-SIV', 'decrypt round-trips', bhex(sivDecrypt(sivKey, sr.v, sr.ciphertext, [sivAd]) ?? new Uint8Array(1)) === bhex(sivPt), 'recompute S2V and compare')
    check('AES-SIV', 'rejects a tampered ciphertext', (() => { const c = sr.ciphertext.slice(); c[0] ^= 1; return sivDecrypt(sivKey, sr.v, c, [sivAd]) === null })(), 'the synthetic IV no longer matches')
    check('AES-SIV', 'rejects altered associated data', sivDecrypt(sivKey, sr.v, sr.ciphertext, [hb('00')]) === null, 'S2V binds the AD vector')
    check('AES-SIV', 'deterministic (misuse-resistant)', bhex(sivEncrypt(sivKey, sivPt, [sivAd]).v) === bhex(sr.v), 'same inputs → same output, no nonce at all')

    // AES-CCM — Counter with CBC-MAC (RFC 3610, the WPA2 / BLE AEAD).
    const ccmKey = hb('c0c1c2c3c4c5c6c7c8c9cacbcccdcecf')
    const ccmNonce = hb('00000003020100a0a1a2a3a4a5')
    const ccmAad = hb('0001020304050607')
    const ccmPt = hb('08090a0b0c0d0e0f101112131415161718191a1b1c1d1e')
    const cc = ccmEncrypt(ccmKey, ccmNonce, ccmPt, ccmAad, 8)
    check('AES-CCM', 'ciphertext matches RFC 3610 vector #1', bhex(cc.ciphertext) === '588c979a61c663d2f066d0c2c0f989806d5f6b61dac384', 'CTR keystream over the 23-byte payload')
    check('AES-CCM', 'tag matches RFC 3610 vector #1', bhex(cc.tag) === '17e8d12cfdf926e0', 'CBC-MAC over B0 ‖ AAD ‖ payload, encrypted by S0')
    check('AES-CCM', 'decrypt round-trips', bhex(ccmDecrypt(ccmKey, ccmNonce, cc.ciphertext, cc.tag, ccmAad) ?? new Uint8Array(1)) === bhex(ccmPt), 'recompute the CBC-MAC and compare')
    check('AES-CCM', 'rejects a tampered ciphertext', (() => { const c = cc.ciphertext.slice(); c[0] ^= 1; return ccmDecrypt(ccmKey, ccmNonce, c, cc.tag, ccmAad) === null })(), 'the CBC-MAC no longer matches')

    // The Double Ratchet is cipher-agnostic — it runs over the new AES-256-GCM too.
    const rtChacha = runSuiteRoundTrip(CHACHA20_POLY1305)
    check('Ratchet', 'runs over ChaCha20-Poly1305 (Signal default)', rtChacha.ok && rtChacha.tamperRejected, 'the record layer, cipher-parameterised')
    const rtGcm = runSuiteRoundTrip(AES_256_GCM)
    check('Ratchet', 'runs over AES-256-GCM (TLS 1.3 cipher)', rtGcm.ok && rtGcm.tamperRejected, 'a full X3DH + ratchet conversation on the from-scratch AES-GCM')
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

  // ── ML-DSA (FIPS 204) — the from-scratch lattice signature ──
  {
    // The 256-point NTT over q = 8380417 inverts exactly, and its pointwise
    // product is a genuine negacyclic convolution mod X²⁵⁶+1.
    const f = new Int32Array(256)
    const g = new Int32Array(256)
    for (let i = 0; i < 256; i++) {
      f[i] = (i * 5779 + 11) % MLDSA_Q
      g[i] = (i * 104729 + 7) % MLDSA_Q
    }
    const back = mldsaInvNtt(mldsaNtt(f))
    let inverts = true
    for (let i = 0; i < 256; i++) inverts = inverts && (((back[i] % MLDSA_Q) + MLDSA_Q) % MLDSA_Q) === f[i]
    check('ML-DSA', 'NTT⁻¹(NTT(f)) = f', inverts, 'the full 256-point forward and inverse transforms are exact inverses')

    const acc = new Array<number>(512).fill(0)
    for (let i = 0; i < 256; i++) for (let j = 0; j < 256; j++) acc[i + j] = (acc[i + j] + f[i] * g[j]) % MLDSA_Q
    const conv = new Int32Array(256)
    for (let i = 0; i < 256; i++) conv[i] = (((acc[i] - (acc[i + 256] || 0)) % MLDSA_Q) + MLDSA_Q) % MLDSA_Q
    const viaNtt = mldsaInvNtt(mldsaNttMul(mldsaNtt(f), mldsaNtt(g)))
    let mulOk = true
    for (let i = 0; i < 256; i++) mulOk = mulOk && (((viaNtt[i] % MLDSA_Q) + MLDSA_Q) % MLDSA_Q) === conv[i]
    check('ML-DSA', 'base multiply = negacyclic convolution', mulOk, 'the pointwise NTT product matches the degree-256 schoolbook multiply')

    // Rounding identities: Power2Round reconstructs t, and the hint recovers the
    // high bits of r+z from r alone (the whole verifier trick).
    let p2Ok = true
    for (let t = 0; t < 4096; t++) {
      const v = (t * 2654435761) % MLDSA_Q
      const [r1, r0] = power2Round(v)
      if ((((r1 * (1 << MLDSA_D) + r0) % MLDSA_Q) + MLDSA_Q) % MLDSA_Q !== v) p2Ok = false
      if (Math.abs(r0) > (1 << (MLDSA_D - 1))) p2Ok = false
    }
    check('ML-DSA', 'Power2Round reconstructs t & bounds t0', p2Ok, 'r = r1·2¹³ + r0 with |r0| ≤ 2¹²')

    for (const g2 of [(MLDSA_Q - 1) / 88, (MLDSA_Q - 1) / 32]) {
      let hintOk = true
      for (let t = 0; t < 3000; t++) {
        const r = (t * 1442695041) % MLDSA_Q
        const z = ((t * 48271) % 200) - 100
        const want = highBits((((r + z) % MLDSA_Q) + MLDSA_Q) % MLDSA_Q, g2)
        const got = applyHint(makeHint(z, r, g2), r, g2)
        if (got !== want) hintOk = false
        // Decompose is a valid split too.
        const [d1, d0] = decompose(r, g2)
        if ((((d1 * 2 * g2 + d0) % MLDSA_Q) + MLDSA_Q) % MLDSA_Q !== r % MLDSA_Q) hintOk = false
      }
      check('ML-DSA', `UseHint(MakeHint) = HighBits(r+z)  γ2=${g2}`, hintOk, 'the one-bit hint recovers the discarded carry, and Decompose splits exactly')
    }

    // SampleInBall: exactly τ nonzero coefficients, every one ±1.
    const cseed = new Uint8Array(32)
    for (let i = 0; i < 32; i++) cseed[i] = (i * 73 + 19) & 0xff
    const cpoly = sampleInBall(cseed, 39)
    let nz = 0
    let allPm1 = true
    for (let i = 0; i < 256; i++) if (cpoly[i] !== 0) { nz++; const s = mldsaToSigned(cpoly[i]); if (s !== 1 && s !== -1) allPm1 = false }
    check('ML-DSA', 'SampleInBall yields τ signed units', nz === 39 && allPm1, `${nz} nonzero coefficients, each exactly ±1`)

    // Full KeyGen → Sign → Verify for every parameter set, plus the negatives.
    const dseed = (b: number) => {
      const a = new Uint8Array(32)
      for (let i = 0; i < 32; i++) a[i] = (i * 53 + b * 191 + 7) & 0xff
      return a
    }
    for (const p of MLDSA_SETS) {
      const { pk, sk } = mldsaKeyGen(p, dseed(1))
      const sz = mldsaSizes(p)
      const sizesOk = pk.length === sz.pk && sk.length === sz.sk
      check('ML-DSA', `${p.name} key byte-sizes match FIPS 204`, sizesOk, `pk ${pk.length} · sk ${sk.length} bytes`)

      const msg = utf8('curvefield ⇒ ML-DSA lattice signature')
      const sig = mldsaSign(p, sk, msg)
      check('ML-DSA', `${p.name} signature size matches FIPS 204`, sig.length === sz.sig, `σ ${sig.length} bytes`)
      check('ML-DSA', `${p.name} verify accepts a genuine signature`, mldsaVerify(p, pk, msg, sig), 'commitment recomputes and the challenge reproduces')

      const badMsg = utf8('curvefield ⇒ ML-DSA lattice signaturE')
      check('ML-DSA', `${p.name} rejects a tampered message`, !mldsaVerify(p, pk, badMsg, sig), 'one changed byte breaks the Fiat–Shamir binding')

      const badSig = sig.slice()
      badSig[p.lambda / 4 + 4] ^= 0x01
      check('ML-DSA', `${p.name} rejects a mauled signature`, !mldsaVerify(p, pk, msg, badSig), 'flipping a response byte fails verification')

      const other = mldsaKeyGen(p, dseed(2))
      check('ML-DSA', `${p.name} rejects a wrong public key`, !mldsaVerify(p, other.pk, msg, sig), 'a signature verifies only under its own key')

      const sig2 = mldsaSign(p, sk, msg)
      let same = sig.length === sig2.length
      for (let i = 0; i < sig.length && same; i++) same = sig[i] === sig2[i]
      check('ML-DSA', `${p.name} deterministic signing is reproducible`, same, 'rnd = 0 gives byte-for-byte identical signatures')

      const ctx = utf8('curvefield-app')
      const sigCtx = mldsaSign(p, sk, msg, { ctx })
      const ctxOk = mldsaVerify(p, pk, msg, sigCtx, { ctx }) && !mldsaVerify(p, pk, msg, sigCtx)
      check('ML-DSA', `${p.name} the context string binds`, ctxOk, 'a signature made under a context verifies only under that context')

      // Hedged (randomised rnd) signing: differs from deterministic yet verifies.
      const rndA = new Uint8Array(32)
      for (let i = 0; i < 32; i++) rndA[i] = (i * 29 + 13) & 0xff
      const sigHedged = mldsaSign(p, sk, msg, { rnd: rndA })
      let anyDiff = sigHedged.length !== sig.length
      for (let i = 0; i < sig.length; i++) if (sigHedged[i] !== sig[i]) anyDiff = true
      check('ML-DSA', `${p.name} hedged signing differs yet verifies`, anyDiff && mldsaVerify(p, pk, msg, sigHedged), 'a fresh rnd yields a different but equally valid signature')
    }

    // HashML-DSA (FIPS 204 §5.4) — the pre-hash variant, bound to its hash OID.
    const phKey = mldsaKeyGen(MLDSA_SETS[0], dseed(3))
    const phMsg = utf8('sign the digest, not the message')
    for (const phf of ['SHA-512', 'SHAKE-256'] as const) {
      const other = phf === 'SHA-512' ? 'SHAKE-256' : 'SHA-512'
      const psig = mldsaSignPreHash(MLDSA_SETS[0], phKey.sk, phMsg, phf)
      const bound =
        mldsaVerifyPreHash(MLDSA_SETS[0], phKey.pk, phMsg, psig, phf) &&
        !mldsaVerifyPreHash(MLDSA_SETS[0], phKey.pk, phMsg, psig, other) &&
        !mldsaVerify(MLDSA_SETS[0], phKey.pk, phMsg, psig)
      check('ML-DSA', `HashML-DSA (${phf}) binds to its hash OID`, bound, 'verifies only under the same pre-hash — not the other hash, not pure ML-DSA')
    }
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

  // ── 35. GMW — secret-sharing MPC (the other paradigm; AND via 1-of-4 OT) ──
  {
    // Every elementary gate on XOR shares.
    const gate = (type: 'AND' | 'XOR' | 'INV'): Circuit => {
      const bld = new CircuitBuilder()
      const x = bld.aliceInput()
      const y = bld.bobInput()
      const out = type === 'AND' ? bld.and(x, y) : type === 'XOR' ? bld.xor(x, y) : bld.inv(x)
      return bld.build([out])
    }
    for (const type of ['AND', 'XOR', 'INV'] as const) {
      const circ = gate(type)
      let ok = true
      for (let a = 0; a < 2; a++)
        for (let b = 0; b < 2; b++) {
          const r = gmwCompute(circ, [a], [b])
          if (r.outputBits[0] !== evalPlain(circ, [a], [b])[0] || !r.agrees) ok = false
        }
      check('MPC · GMW', `${type} gate on XOR shares`, ok, type === 'XOR' || type === 'INV' ? 'local, no interaction' : 'resolved by one 1-of-4 oblivious transfer')
    }
    // A 2-bit comparator, exhaustive (kept small — GMW runs a real OT per AND gate).
    let cmp = true
    for (let a = 0; a < 4; a++)
      for (let b = 0; b < 4; b++) {
        const r = gmwCompute(millionairesCircuit(2), toBits(a, 2), toBits(b, 2))
        if ((r.outputBits[0] === 1) !== a > b || !r.agrees) cmp = false
      }
    check('MPC · GMW', 'comparator exact on all 2-bit pairs', cmp, '16 GMW runs, each equals a > b (shares reconstructed by XOR)')
    // Cross-paradigm: GMW and garbled circuits must agree on the same statement.
    const gmwMil = gmwCompute(millionairesCircuit(6), toBits(40, 6), toBits(9, 6))
    const garbledMil = runMillionaires(40, 9, 6)
    check('MPC · GMW', 'GMW agrees with garbled circuits', gmwMil.agrees && gmwMil.outputBits[0] === garbledMil.outputBits[0], 'two different MPC mechanisms, one answer (Alice 40 > Bob 9)')
    const gmwSum = gmwCompute(sumCircuit(6), toBits(20, 6), toBits(19, 6))
    check('MPC · GMW', 'GMW private sum', gmwSum.agrees && gmwSum.outputBits.reduce((n, b, i) => n + (b << i), 0) === 39, '20 + 19 = 39 on secret shares')
  }

  // ── 54. Verifiable Delay Functions ──
  {
    const Nvdf = VDF_RSA.N
    const phi = VDF_RSA.phi
    // Trapdoor evaluation reproduces the honest T-squaring chain, several T.
    let evalOk = true
    for (const T of [1, 2, 8, 64, 257, 1024]) {
      const x = vdfGen(BigInt(T) + 12345n, Nvdf)
      if (evalVDF(x, T, Nvdf) !== evalTrapdoor(x, T, Nvdf, phi)) evalOk = false
    }
    check('VDF', 'y = x^(2^T): squaring chain = trapdoor shortcut', evalOk, 'honest T squarings and e = 2^T mod φ(N) agree for T ∈ {1..1024}')

    // Wesolowski: accepts an honest proof, rejects a forged π, a mauled y, wrong T.
    {
      const T = 1024
      const x = vdfGen(99n, Nvdf)
      const y = evalVDF(x, T, Nvdf)
      const pf = wesolowskiProve(x, T, Nvdf, y)
      check('VDF · Wesolowski', 'ℓ is a ~128-bit Fiat–Shamir prime', vdfIsPrime(pf.ell) && vdfBitLen(pf.ell) >= 120, `ℓ = ${pf.ell.toString(16).slice(0, 12)}… (${vdfBitLen(pf.ell)}-bit)`)
      check('VDF · Wesolowski', 'verify accepts (π^ℓ·x^r = y)', wesolowskiVerify(x, y, T, Nvdf, pf), 'one exponentiation certifies 1024 squarings')
      check('VDF · Wesolowski', 'rejects a forged π', !wesolowskiVerify(x, y, T, Nvdf, { ell: pf.ell, pi: (pf.pi + 1n) % Nvdf }), 'no valid opening without the work')
      check('VDF · Wesolowski', 'rejects a mauled output y', !wesolowskiVerify(x, (y + 1n) % Nvdf, T, Nvdf, pf), 'y is bound into ℓ')
      check('VDF · Wesolowski', 'rejects the wrong delay T', !wesolowskiVerify(x, y, T * 2, Nvdf, pf), 'T is bound into ℓ')
      // Streaming prover (O(1) memory, no 2^T integer) reproduces the reference π byte-for-byte.
      let streamOk = true
      for (const Ts of [1, 8, 257, 4096, 65536]) {
        const xs = vdfGen(BigInt(Ts) + 3n, Nvdf)
        const ref = wesolowskiProve(xs, Ts, Nvdf)
        const st = wesolowskiProveStreaming(xs, Ts, Nvdf)
        if (st.ell !== ref.ell || st.pi !== ref.pi) streamOk = false
      }
      check('VDF · Wesolowski', 'streaming prover = reference π (no 2^T integer)', streamOk, 'O(1)-memory quotient-bit accumulation matches ⌊2^T/ℓ⌋ for T up to 2^16')
    }

    // Pietrzak halving proof: right length, accepts, rejects a flipped midpoint.
    {
      const T = 1024 // 2^10
      const x = vdfGen(7n, Nvdf)
      const y = evalVDF(x, T, Nvdf)
      const pf = pietrzakProve(x, T, Nvdf, y)
      check('VDF · Pietrzak', 'proof is log₂T midpoints', pf.mus.length === 10, `${pf.mus.length} midpoints for T = 2^10`)
      check('VDF · Pietrzak', 'verify accepts the halving chain', pietrzakVerify(x, y, T, Nvdf, pf), 'every folded challenge re-derives; y = x² closes')
      const bad = { mus: pf.mus.map((m, i) => (i === 5 ? (m + 1n) % Nvdf : m)) }
      check('VDF · Pietrzak', 'rejects a flipped midpoint', !pietrzakVerify(x, y, T, Nvdf, bad), 'one bad μ breaks every level below it')
      check('VDF · Pietrzak', 'rejects a mauled output y', !pietrzakVerify(x, (y * 2n) % Nvdf, T, Nvdf, pf), 'the final y = x² check fails')
    }

    // hash-to-prime is deterministic and actually prime.
    {
      const seed = utf8('curvefield-vdf-selftest')
      const p1 = vdfHashToPrime(seed, 128)
      const p2 = vdfHashToPrime(seed, 128)
      check('VDF', 'hash-to-prime is deterministic & prime', p1 === p2 && vdfIsPrime(p1), `${p1.toString(16).slice(0, 12)}… is a repeatable 128-bit prime`)
    }

    // RSW time-lock puzzle: trapdoor lock, grind unlock, round-trips; wrong T fails.
    {
      const msg = utf8('Rivest–Shamir–Wagner, 1996 — open me in the future.')
      const T = 2048
      const puzzle = timeLock(msg, T, Nvdf, phi, 3n)
      const opened = timeUnlock(puzzle)
      check('VDF · time-lock', 'RSW lock (trapdoor) → grind unlock round-trips', bytesToHex(opened) === bytesToHex(msg), `${msg.length}-byte capsule recovered after ${T} squarings`)
      const wrong = timeUnlock({ ...puzzle, T: T - 1 })
      check('VDF · time-lock', 'the wrong work factor cannot open it', bytesToHex(wrong) !== bytesToHex(msg), 'one squaring short → wrong key → garbage')
    }

    // Delay beacon: every round carries a proof that verifies; chain evolves.
    {
      const chain = beaconChain(utf8('genesis'), 256, Nvdf, 4)
      const allVerify = chain.every((r) => r.verified)
      const distinct = new Set(chain.map((r) => r.output.toString())).size === 4
      check('VDF · beacon', 'each delayed round carries a valid proof', allVerify && distinct, '4 chained VDF outputs, each Wesolowski-verified and distinct')
    }

    // Continuous VDF: monotone checkpoints, each proof verifies, final = full eval.
    {
      const x = vdfGen(42n, Nvdf)
      const totalT = 4000
      const cps = vdfCheckpoints(x, totalT, 5, Nvdf)
      const monotone = cps.every((c, i) => i === 0 || c.T > cps[i - 1].T)
      const allVerify = cps.every((c) => c.verified && c.y === evalVDF(x, c.T, Nvdf))
      const finalOk = cps.length === 5 && cps[4].T === totalT && cps[4].y === evalVDF(x, totalT, Nvdf)
      check('VDF · continuous', 'checkpoints are monotone, each proof-carrying, final = full eval', monotone && allVerify && finalOk, '5 verifiable milestones up to T = 4000, each y = x^(2^T)')
    }
  }

  // ── 33. Class-group VDF — proof-of-sequential-time with no trusted setup ──
  {
    // Enumerate all reduced forms of a small discriminant and check the group
    // axioms on the FULL Cayley table — the strongest possible test of Gauss
    // composition. A wrong compose would break closure or associativity.
    const enumerate = (D: bigint): CgForm[] => {
      const out: CgForm[] = []
      const aMax = BigInt(Math.floor(Math.sqrt(Number(-D) / 3)))
      for (let a = 1n; a <= aMax; a++)
        for (let b = -a; b <= a; b++) {
          const num = b * b - D
          if (num % (4n * a) !== 0n) continue
          const c = num / (4n * a)
          if (c < a) continue
          const f = { a, b, c }
          if (cgIsReduced(f)) out.push(f)
        }
      return out
    }
    // Known class numbers: h(−23)=3, h(−47)=5, h(−71)=7, h(−199)=9, h(−3299)=27.
    for (const [D, h] of [[-23n, 3], [-47n, 5], [-71n, 7], [-199n, 9], [-3299n, 27]] as [bigint, number][]) {
      const forms = enumerate(D)
      const id = cgIdentity(D)
      const inSet = (f: CgForm) => forms.some((q) => cgFormEq(q, f))
      let axioms = forms.length === h && inSet(id)
      for (const f of forms)
        for (const g of forms) {
          const p = cgCompose(f, g, D)
          axioms = axioms && cgIsReduced(p) && inSet(p) && cgFormEq(p, cgCompose(g, f, D))
          axioms = axioms && cgFormEq(cgCompose(f, id, D), f)
          axioms = axioms && cgFormEq(cgCompose(f, cgInverse(f, D), D), id)
        }
      // associativity over all triples
      for (const f of forms) for (const g of forms) for (const w of forms) axioms = axioms && cgFormEq(cgCompose(cgCompose(f, g, D), w, D), cgCompose(f, cgCompose(g, w, D), D))
      check('VDF · class group', `h(${D}) = ${h}: Gauss composition is a group (full Cayley table)`, axioms, `closure · associativity · identity · inverses on all ${forms.length}² pairs`)
    }

    // The lab's default nothing-up-my-sleeve discriminant + generator.
    const D = CG.D
    const g = CG.g
    check('VDF · class group', 'Δ is a public 256-bit fundamental discriminant', D < 0n && (-D).toString(2).length === 256 && ((D % 4n) + 4n) % 4n === 1n && vdfIsPrime(-D), `Δ = −p, p a 256-bit prime, Δ ≡ 1 (mod 4) — hashed from a seed, no trusted setup`)
    check('VDF · class group', 'generator is a reduced form of discriminant Δ', cgDisc(g) === D && cgIsReduced(g), `g = (${g.a}, ${g.b}, …), b² − 4ac = Δ`)

    // Exponent law: g^i ∘ g^j = g^(i+j), and g^(2^T) = T squarings.
    let expOk = true
    for (let i = 0n; i < 8n; i++) for (let j = 0n; j < 8n; j++) expOk = expOk && cgFormEq(cgCompose(cgPower(g, i, D), cgPower(g, j, D), D), cgPower(g, i + j, D))
    check('VDF · class group', 'square-and-multiply respects the exponent law', expOk && cgFormEq(cgPower(g, 1n << 10n, D), cgEval(g, 10, D)), 'g^i ∘ g^j = g^(i+j), and g^(2¹⁰) equals 10 sequential squarings')

    // Wesolowski proof: roundtrip, streaming-prover equivalence, forgery reject.
    for (const T of [8, 256, 1024]) {
      const y = cgEval(g, T, D)
      const ref = cgProve(g, T, D, y)
      const st = cgProveStreaming(g, T, D, y)
      check('VDF · class group', `T = ${T}: streaming prover = reference π (no 2^T integer)`, cgFormEq(ref.pi, st.pi) && ref.ell === st.ell, 'O(1)-memory quotient-bit accumulation matches ⌊2^T/ℓ⌋')
      check('VDF · class group', `T = ${T}: Wesolowski verify accepts (π^ℓ ∘ g^r = y)`, cgVerify(g, y, T, D, ref), 'two class-group exponentiations certify all T squarings')
      check('VDF · class group', `T = ${T}: rejects a forged π`, !cgVerify(g, y, T, D, { ell: ref.ell, pi: cgCompose(ref.pi, g, D) }), 'no valid opening without the sequential work')
      check('VDF · class group', `T = ${T}: rejects a mauled output y`, !cgVerify(g, cgSquare(y, D), T, D, ref), 'y is bound into the Fiat–Shamir prime ℓ')
      check('VDF · class group', `T = ${T}: rejects the wrong delay T`, !cgVerify(g, y, T * 2, D, ref), 'T is bound into ℓ')
    }

    // Reduction keeps coordinates bounded by ~√|Δ| no matter how far we square.
    let big = g
    let bounded = true
    const bound = BigInt(Math.ceil(Math.sqrt(Number(-D) / 3)))
    for (let i = 0; i < 200; i++) {
      big = cgSquare(big, D)
      const a = big.a < 0n ? -big.a : big.a
      bounded = bounded && a <= bound && cgIsReduced(big)
    }
    check('VDF · class group', 'reduction bounds |a| ≤ √(|Δ|/3) through 200 squarings', bounded, 'form coordinates never blow up — constant per-step cost forever')

    // Delay-based randomness beacon, all rounds proof-carrying and distinct.
    const chain = cgBeacon(utf8('genesis'), 128, D, g, 3)
    const distinct = new Set(chain.map((r) => bytesToHex(r.beta))).size === 3
    check('VDF · class group', 'delay beacon: each round Wesolowski-verified & distinct', chain.every((r) => r.verified) && distinct, '3 chained class-group VDF outputs, no trusted setup anywhere')

    // Generality: a second, independently-hashed discriminant also verifies.
    const D2 = cgGenDisc(utf8('curvefield/class-group/selftest-alt'), 200)
    const g2 = cgPrimeForm(D2)
    const y2 = cgEval(g2, 300, D2)
    check('VDF · class group', 'a second, independent Δ verifies end-to-end', cgVerify(g2, y2, 300, D2, cgProve(g2, 300, D2, y2)) && cgFormEq(cgReduce(g2, D2), g2), '200-bit Δ, T = 300 — the construction is not tuned to one modulus')
  }

  // ── GKR & the sum-check protocol ──
  {
    // Sum-check on a product of two multilinear polynomials over a 4-var hypercube.
    const v = 4
    const n = 1 << v
    const A = Array.from({ length: n }, (_, i) => goldFp(BigInt(i * i * 7 + 3)))
    const B = Array.from({ length: n }, (_, i) => goldFp(BigInt(i * 13 + 5)))
    const claim = scProductClaim([A, B], v)
    const scProof = sumcheckProve(claim, new StarkTranscript('selftest/sumcheck'))
    let brute = 0n
    for (let i = 0; i < n; i++) brute = goldAdd(brute, goldMul(A[i], B[i]))
    check('GKR · sum-check', 'prover sum = brute-force Σ over the 2⁴ hypercube', scProof.claimedSum === brute, 'the claimed value is the true sum of A·B over 16 points')
    const scV = sumcheckVerify(v, 2, scProof.claimedSum, scProof.rounds, scProductOracle([A, B]), new StarkTranscript('selftest/sumcheck'))
    check('GKR · sum-check', 'verifier accepts the honest proof with one oracle call', scV.ok && scV.failedRound === -1, `4 round-checks + 1 MLE evaluation vs 16-term sum`)
    const scBad = sumcheckVerify(v, 2, goldFp(scProof.claimedSum + 1n), scProof.rounds, scProductOracle([A, B]), new StarkTranscript('selftest/sumcheck'))
    check('GKR · sum-check', 'verifier rejects a forged claimed sum (H+1)', !scBad.ok, `soundness: the first identity s₁(0)+s₁(1)=H fails`)
    // The multilinear extension reproduces the hypercube corners.
    const tbl = [3n, 5n, 8n, 13n]
    const mleOk = mleEvalGkr(tbl, [0n, 0n]) === 3n && mleEvalGkr(tbl, [1n, 0n]) === 5n && mleEvalGkr(tbl, [0n, 1n]) === 8n && mleEvalGkr(tbl, [1n, 1n]) === 13n
    check('GKR · sum-check', 'multilinear extension interpolates every hypercube corner', mleOk, 'MLE(table) agrees with the table on {0,1}²')

    // GKR on the lab's example two-layer circuit.
    const circ = exampleCircuit([2n, 3n, 4n, 5n, 6n, 7n, 8n, 9n])
    const gvals = gkrEvaluate(circ)
    const evalOk = gvals[0][0] === 15n && gvals[0][1] === 714n && gvals[0][2] === 21n && gvals[0][3] === 882n
    check('GKR · sum-check', 'example circuit evaluates to the expected output', evalOk, 'output = [15, 714, 21, 882] from 12 gates')
    const gp = gkrProve(circ)
    const gv = gkrVerify(circ, gp.output, gp)
    check('GKR · sum-check', 'GKR verifier certifies the output re-running zero gates', gv.ok && gv.checks > 0, `${gp.gateOps} prover gate-ops vs ${gv.checks} verifier algebraic checks`)
    const forged = gp.output.map((x, i) => (i === 0 ? goldFp(x + 1n) : x))
    const gvBad = gkrVerify(circ, forged, gp)
    check('GKR · sum-check', 'GKR verifier rejects a single forged output wire', !gvBad.ok, gvBad.reason)
    const circ2 = exampleCircuit([11n, 0n, 7n, 1n, 9n, 2n, 3n, 100n])
    const gp2 = gkrProve(circ2)
    check('GKR · sum-check', 'a second, independent input verifies end-to-end', gkrVerify(circ2, gp2.output, gp2).ok, 'the protocol is not tuned to one witness')

    // Verified matrix multiplication: C̃(r,s) = Σ_x Ã(r,x)·B̃(x,s).
    const mA = [1n, 2n, 3n, 4n, 5n, 6n, 7n, 8n, 9n, 10n, 11n, 12n, 13n, 14n, 15n, 16n]
    const mB = [2n, 0n, 1n, 3n, 1n, 1n, 0n, 2n, 4n, 2n, 5n, 1n, 0n, 3n, 2n, 1n]
    const mC = matMul(mA, mB, 4)
    check('GKR · sum-check', 'matrix product C = A·B computed over the field', mC[0] === 16n, 'C[0,0] = 1·2+2·1+3·4+4·0 = 16')
    const mp = matmulProve(mA, mB, 4)
    check('GKR · sum-check', 'sum-check certifies a 4×4 product from log-n interaction', matmulVerify(mA, mB, mp.C, 4, mp).ok, 'verifier never recomputes the 64 inner-product terms')
    const mBad = mp.C.map((v, i) => (i === 5 ? goldFp(v + 1n) : v))
    check('GKR · sum-check', 'matmul verifier rejects a single forged product entry', !matmulVerify(mA, mB, mBad, 4, mp).ok, 'a wrong C shifts (r,s) and the transcript diverges')

    // Triangle counting: (1/6)·Σ Ã(x,y)Ã(y,z)Ã(z,x).
    const N = 4
    const adj = new Array(N * N).fill(0)
    const edge = (a: number, b: number) => { adj[a * N + b] = 1; adj[b * N + a] = 1 }
    edge(0, 1); edge(1, 2); edge(0, 2); edge(2, 3)
    const triCount = countTriangles(adj, N)
    check('GKR · sum-check', 'brute-force triangle count on a 4-vertex graph', triCount === 1, 'one triangle {0,1,2}; the 2–3 edge closes none')
    const tp = trianglesProve(adj, N)
    check('GKR · sum-check', 'sum-check certifies the triangle count (Ã evaluated at 3 points)', trianglesVerify(adj, N, triCount, tp).ok, '6·1 = Σ over the 4³ vertex triples')
    check('GKR · sum-check', 'triangle verifier rejects an inflated count', !trianglesVerify(adj, N, triCount + 1, tp).ok, 'soundness of the counting argument')
  }

  // ── 39. Homomorphic e-voting (exponential ElGamal + DKG + threshold) ──
  {
    const VG = 'Homomorphic Voting'
    // ElGamal round-trip and additive homomorphism.
    const vsk = 987654321n
    const vpk = elgPublicKey(vsk)
    const ctA = elgEncrypt(vpk, 3n, 111n)
    const ctB = elgEncrypt(vpk, 5n, 222n)
    const M = elgDecrypt(vsk, elgAdd(ctA, ctB))
    check(VG, 'ElGamal is additively homomorphic', elgEq(M, secp256k1.multiply(8n, G)), 'Enc(3)⊕Enc(5) decrypts to 8·G')
    check(VG, 'bounded discrete log recovers the small plaintext', elgDlog(M, 50) === 8, 'BSGS finds m=8 in √-range steps')
    check(VG, 'discrete log reports an out-of-range plaintext as impossible', elgDlog(secp256k1.multiply(80n, G), 50) === null, 'malformed totals are caught, not silently wrapped')
    // homomorphic accumulate over a batch, starting from the identity ciphertext.
    let vacc = elgZero()
    let vsum = 0
    for (const x of [4, 0, 7, 2, 9]) { vacc = elgAdd(vacc, elgEncrypt(vpk, BigInt(x), BigInt(x * 17 + 1))); vsum += x }
    check(VG, 'a batch of ciphertexts tallies to the plaintext sum', elgDlog(elgDecrypt(vsk, vacc), 100) === vsum, 'the whole point of a homomorphic tally')

    // Disjunctive Chaum–Pedersen: a ciphertext encrypts a bit.
    for (const m of [0, 1] as const) {
      const r = 314159n + BigInt(m)
      const ct = elgEncrypt(vpk, BigInt(m), r)
      const pf = proveEnc01(vpk, m, r, ct.A, ct.B)
      check(VG, `ballot-validity proof accepts an encryption of ${m}`, verifyEnc01(vpk, ct.A, ct.B, pf), 'zero-knowledge OR-proof "it is a 0 or a 1"')
      check(VG, `ballot-validity proof rejects a tampered ciphertext (m=${m})`, !verifyEnc01(vpk, ct.A, secp256k1.add(ct.B, G), pf), 'Fiat–Shamir binds the proof to (A,B)')
    }
    // A voter who encrypts a "2" cannot produce a passing proof.
    const two = elgEncrypt(vpk, 2n, 999n)
    check(VG, 'ballot-validity proof rejects an encryption of 2 (no ballot stuffing)', !verifyEnc01(vpk, two.A, two.B, proveEnc01(vpk, 1, 999n, two.A, two.B)), 'the soundness of the disjunction')

    // Distributed key generation: PK = sk·G, every trustee key Feldman-consistent.
    const K = 3
    const election = runDKG(4, 3)
    check(VG, 'DKG public key equals sk·G for the implied threshold secret', elgEq(election.pk, secp256k1.multiply(election.sk, G)), 'sk = Σ trustee secrets, held by no one')
    check(VG, 'every dealt share passed its Feldman check', election.trustees.every((tr) => tr.dealtOk), 'a cheating dealer would be caught here')

    // A full election: cast, tally, and grade against the plaintext truth.
    const choices = [0, 1, 1, 2, 0, 1, 0, 2, 1, 1, 0, 2]
    const ballots = choices.map((c, i) => castBallot(election, `v${i}`, c, K))
    check(VG, 'every cast ballot self-certifies (bits + sum = 1)', ballots.every((b) => verifyBallot(election, b, K).ok), 'no secret needed to check a ballot')
    const quorum = [election.trustees[0], election.trustees[2], election.trustees[3]]
    const result = runTally(ballots, K, quorum)
    const truth = plaintextCounts(ballots, K)
    check(VG, 'the homomorphic tally reproduces the plaintext count', JSON.stringify(result.counts) === JSON.stringify(truth), `decrypted ${JSON.stringify(result.counts)} = ${JSON.stringify(truth)}, no ballot opened`)

    // Threshold guarantee: t decrypt, t−1 cannot.
    const agg0 = tallyAggregate(ballots, K)[0]
    const goodShare = decryptShare(quorum[0], agg0)
    check(VG, 'a decryption share carries a valid DLEQ proof', verifyDecryptionShare(quorum[0].vk, agg0, goodShare), 'log_G(Yᵢ) = log_A(Dᵢ) = skᵢ')
    check(VG, 'a corrupted decryption share is rejected', !verifyDecryptionShare(quorum[0].vk, agg0, corruptDecShare(goodShare)), 'a dishonest trustee is publicly caught')
    const twoShares = [election.trustees[0], election.trustees[1]].map((tr) => decryptShare(tr, agg0))
    check(VG, 'fewer than t trustees cannot recover the tally', elgDlog(combineShares(agg0, twoShares), ballots.length) !== truth[0], 'the t-of-n threshold, demonstrated')

    // Universal verifiability, and that tampering is caught.
    const qi = quorum.map((q) => q.index)
    check(VG, 'the universal verifier accepts an honest election', verifyElection(election, ballots, K, result, qi).ok, 're-checks DKG, ballots, aggregation, and decryption')
    const stuffed = ballots.slice(); stuffed[0] = stuffBallot(election, ballots[0])
    const stuffedResult = runTally(stuffed, K, quorum)
    check(VG, 'the universal verifier rejects a stuffed bulletin board', !verifyElection(election, stuffed, K, stuffedResult, qi).ok, 'ballot-stuffing breaks a bit-proof')

    // Cast-or-audit (Benaloh challenge): a spoiled ballot's revealed openings
    // reproduce it, and a client that swapped the vote is caught.
    const sealed = sealBallot(election, 'auditor', 2, K)
    check(VG, 'a spoiled ballot audits as cast-as-intended', auditBallot(election, sealed, K).ok, 'revealed randomness reproduces every ciphertext')
    const swapped = { ...sealed, ballot: { ...sealed.ballot, choice: 0 } }
    check(VG, 'auditing catches a client that encrypted a different vote', !auditBallot(election, swapped, K).ok, 'the ciphertexts no longer match the claimed choice')
  }

  // ── 40. BBS anonymous credentials (pairing multi-message sig + ZK disclosure) ──
  {
    const BG = 'BBS · anonymous credentials'
    seedRng(0xbb5)
    const key = bbsKeygen(0x1815_1210_dacen)
    const attrs = ['Ada Lovelace', '1815-12-10', 'UK-DL-8150', '2035-06-01', 'over21:true', 'London']
    const gens = bbsGenerators(attrs.length)
    const msgs = bbsMsgs(attrs)
    const header = utf8('gov.uk/dvla')
    const sig = bbsSign(key, header, msgs, gens)

    // Signature correctness.
    check(BG, 'issuer signature verifies over all attributes', bbsVerify(key.pk, sig, header, msgs, gens), 'e(A, PK + e·P₂) = e(B, P₂)')
    check(BG, 'signing is deterministic (e = H(sk, domain, msgs))', (() => { const s2 = bbsSign(key, header, msgs, gens); return g1.eq(sig.A, s2.A) && sig.e === s2.e })(), 'the presentation randomizes, not the signature')
    const badMsgs = msgs.map((m, i) => (i === 1 ? bbsMsg('1980-01-01') : m))
    check(BG, 'verify rejects a tampered attribute', !bbsVerify(key.pk, sig, header, badMsgs, gens), 'changing any mᵢ moves B off the pairing')
    check(BG, 'verify rejects the wrong public key', !bbsVerify(bbsKeygen(999n).pk, sig, header, msgs, gens), 'the signature binds to the issuer')
    check(BG, 'verify rejects a mauled e', !bbsVerify(key.pk, { A: sig.A, e: (sig.e + 1n) % BLS_R }, header, msgs, gens), 'e is fixed by the signature')

    // Selective disclosure: reveal only "over21" (index 4) and expiry (index 3).
    const disclosed = [3, 4]
    const ph = utf8('bar:session#7')
    const proof = bbsProofGen({ pk: key.pk }, sig, header, ph, msgs, disclosed, gens)
    const disMsgs = disclosed.map((i) => msgs[i])
    check(BG, 'selective-disclosure proof verifies (reveal 2 of 6)', bbsProofVerify(key.pk, proof, header, ph, disMsgs, gens), 'proves a valid credential while hiding 4 attributes')
    check(BG, 'the proof carries a blinded response per hidden attribute only', proof.mHat.length === 4 && proof.disclosed.length === 2, '4 undisclosed m̂ⱼ, 0 plaintext hidden values')

    // Soundness battery.
    const lie = disMsgs.map((m, i) => (i === 1 ? bbsMsg('over21:false') : m))
    check(BG, 'proof rejects a lied-about disclosed value', !bbsProofVerify(key.pk, proof, header, ph, lie, gens), 'Fiat–Shamir binds every disclosed value')
    check(BG, 'proof is bound to the presentation header (no replay)', !bbsProofVerify(key.pk, proof, header, utf8('bar:session#8'), disMsgs, gens), 'a new verifier session needs a fresh proof')
    check(BG, 'proof rejects the wrong issuer key', !bbsProofVerify(bbsKeygen(7n).pk, proof, header, ph, disMsgs, gens), 'the pairing e(Ā, PK) fails')
    check(BG, 'proof rejects a tampered Ā', !bbsProofVerify(key.pk, { ...proof, Abar: g1.add(proof.Abar, gens.P1) }, header, ph, disMsgs, gens), 'the randomized signature element is bound in')
    check(BG, 'proof rejects a tampered response scalar', !bbsProofVerify(key.pk, { ...proof, mHat: proof.mHat.map((x, i) => (i === 0 ? (x + 1n) % BLS_R : x)) }, header, ph, disMsgs, gens), 'the Σ-proof commitment no longer reproduces c')

    // Degenerate disclosures.
    const pk0 = bbsProofGen({ pk: key.pk }, sig, header, ph, msgs, [], gens)
    check(BG, 'zero-disclosure proof is a pure proof of possession', bbsProofVerify(key.pk, pk0, header, ph, [], gens) && pk0.mHat.length === 6, 'holds a credential, reveals nothing')
    const pkAll = bbsProofGen({ pk: key.pk }, sig, header, ph, msgs, [0, 1, 2, 3, 4, 5], gens)
    check(BG, 'full-disclosure proof verifies', bbsProofVerify(key.pk, pkAll, header, ph, msgs, gens), 'the same machinery covers reveal-everything')

    // Unlinkability: two presentations of the same credential are independent.
    seedRng(0xbb5 + 1)
    const a = bbsProofGen({ pk: key.pk }, sig, header, ph, msgs, disclosed, gens)
    seedRng(0xbb5 + 2)
    const b = bbsProofGen({ pk: key.pk }, sig, header, ph, msgs, disclosed, gens)
    const bothOk = bbsProofVerify(key.pk, a, header, ph, disMsgs, gens) && bbsProofVerify(key.pk, b, header, ph, disMsgs, gens)
    check(BG, 'two presentations both verify yet are unlinkable', bothOk && !g1.eq(a.Abar, b.Abar) && !g1.eq(a.D, b.D), 'a fresh randomizer r makes Ā uniformly random each time')

    // Blind issuance: the issuer signs attributes it never sees. Slot 4 is the
    // holder's link secret; slot 1 a private id — both hidden from the issuer.
    seedRng(0xb11d)
    const bGens = bbsGenerators(5)
    const linkSecret = bbsMsg('device-link-secret')
    const privId = bbsMsg('private-id-42')
    const req = bbsBlindCommit([{ index: 1, msg: privId }, { index: 4, msg: linkSecret }], bGens)
    check(BG, 'issuer accepts a well-formed blind commitment proof', bbsVerifyBlindRequest(req, bGens), 'the holder proves knowledge of the opening in ZK')
    check(BG, 'issuer rejects a tampered blind commitment', !bbsVerifyBlindRequest({ ...req, sHat: req.sHat.map((x, i) => (i === 0 ? (x + 1n) % BLS_R : x)) }, bGens), 'the Σ-proof of the opening fails')
    const issuerMsgs = [{ index: 0, msg: bbsMsg('Grace Hopper') }, { index: 2, msg: bbsMsg('class-B') }, { index: 3, msg: bbsMsg('2035-01-01') }]
    const bSig = bbsBlindSign(key, header, req, issuerMsgs, bGens)
    check(BG, 'blind issuance yields a signature over never-seen attributes', bSig !== null, 'the issuer completes A from the commitment U, blind to slots 1 & 4')
    const bFull = [bbsMsg('Grace Hopper'), privId, bbsMsg('class-B'), bbsMsg('2035-01-01'), linkSecret]
    check(BG, 'the blind-issued signature verifies as an ordinary BBS sig', bSig !== null && bbsVerify(key.pk, bSig, header, bFull, bGens), 'the hidden slots verify exactly like disclosed ones')
    seedRng(0xb11d + 9)
    const bProof = bSig !== null ? bbsProofGen({ pk: key.pk }, bSig, header, ph, bFull, [0, 3], bGens) : null
    check(BG, 'a blind-issued credential presents with selective disclosure', bProof !== null && bbsProofVerify(key.pk, bProof, header, ph, [bFull[0], bFull[3]], bGens) && bProof.mHat.length === 3, 'link secret + private id stay hidden through presentation')
    check(BG, 'the issuer refuses to blind-sign a bad commitment', bbsBlindSign(key, header, { ...req, U: bGens.P1 }, issuerMsgs, bGens) === null, 'no valid opening proof ⇒ no signature')
  }

  // ── Nova: a folding scheme for IVC (relaxed R1CS + Pedersen homomorphism) ──
  {
    const NV = 'Nova (folding IVC)'
    const cs = novaStepR1CS()
    const params = novaSetup(cs)

    // An ordinary step instance embeds as a relaxed instance with u=1, E=0.
    const s0 = novaStepAssign(3n)
    const st0 = novaStrictInstance(params, s0.x, s0.W)
    check(NV, 'strict step instance satisfies relaxed R1CS', novaRelaxedSatisfied(params, st0.U, st0.wit), 'u=1, E=0 ⇒ (A·Z)∘(B·Z) = C·Z')
    check(NV, 'F(z) = z³+z+5 computed in the circuit', s0.zOut === novaStepEval(3n) && s0.zOut === 35n, '3 ↦ 27+3+5 = 35')

    // A single fold of two satisfying instances yields a satisfying instance,
    // and the verifier re-derives the identical challenge and folded instance.
    const s1 = novaStepAssign(s0.zOut)
    const st1 = novaStrictInstance(params, s1.x, s1.W)
    const trP = new NovaTranscript('selftest')
    const fp = novaFoldProve(params, st0.U, st0.wit, st1.U, st1.wit, trP)
    check(NV, 'folded witness satisfies the folded instance', novaRelaxedSatisfied(params, fp.U, fp.wit), 'relaxed R1CS is closed under a random linear combination')
    const trV = new NovaTranscript('selftest')
    const fv = novaFoldVerify(st0.U, st1.U, fp.commT, trV)
    check(NV, 'verifier folds committed instances homomorphically', fv.r === fp.r && novaInstanceEq(fv.U, fp.U), 'same Fiat–Shamir r, same commE/commW/u/x — with no witness')

    // The cross-term identity, checked numerically at a random r: the folded
    // assignment satisfies with E = E₁ + r·T + r²·E₂.
    {
      const T = novaCrossTerm(cs, st0.U, st0.wit, st1.U, st1.wit)
      const r = 0x9e3779b97f4a7c15n
      const z1 = [st0.U.u, ...st0.U.x, ...st0.wit.W]
      const z2 = [st1.U.u, ...st1.U.x, ...st1.wit.W]
      const dot = (row: bigint[], zz: bigint[]) => row.reduce((acc, cc, k) => (acc + cc * zz[k]) % BLS_R, 0n)
      const zf = z1.map((v, k) => (((v + r * z2[k]) % BLS_R) + BLS_R) % BLS_R)
      const uf = (st0.U.u + r * st1.U.u) % BLS_R
      const Ef = st0.wit.E.map((e, k) => (((e + r * T[k] + r * r * st1.wit.E[k]) % BLS_R) + BLS_R) % BLS_R)
      let idOk = true
      for (let k = 0; k < cs.A.length; k++) {
        const lhs = (((dot(cs.A[k], zf) * dot(cs.B[k], zf)) % BLS_R) + BLS_R) % BLS_R
        const rhs = (((uf * dot(cs.C[k], zf) + Ef[k]) % BLS_R) + BLS_R) % BLS_R
        if (lhs !== rhs) idOk = false
      }
      check(NV, 'cross-term identity holds at a random challenge', idOk, 'T is exactly the degree-1 coefficient of the folded quadratic')
    }

    // End-to-end IVC: fold a 6-step chain into one relaxed instance.
    const proof = novaIvcProve(params, 5n, 6)
    const rep = novaIvcVerify(params, proof)
    let z = 5n
    for (let i = 0; i < 6; i++) z = novaStepEval(z)
    check(NV, 'IVC honest 6-step proof verifies', rep.ok, 'one relaxed check replaces 6·3 = 18 ordinary R1CS checks')
    check(NV, 'folded chain output = direct iteration', proof.zN === z, `z₆ = ${proof.zN.toString().slice(0, 12)}…`)

    // Soundness battery: every tamper is caught.
    {
      const bad = novaIvcProve(params, 5n, 5)
      bad.finalWit.W[0] = (bad.finalWit.W[0] + 1n) % BLS_R
      check(NV, 'tampered final witness is rejected', !novaIvcVerify(params, bad).ok, 'the commitment no longer opens / the relaxed check fails')
    }
    {
      const bad = novaIvcProve(params, 5n, 5)
      bad.commTs[2] = params.gW[0] // a bogus cross-term commitment
      check(NV, 'forged cross-term commitment is rejected', !novaIvcVerify(params, bad).ok, 'the verifier re-fold diverges from the prover')
    }
    {
      const bad = novaIvcProve(params, 5n, 5)
      bad.stepInstances[2].x[1] = (bad.stepInstances[2].x[1] + 1n) % BLS_R
      check(NV, 'broken public-IO chaining is rejected', !novaIvcVerify(params, bad).ok, 'z_out of step i must equal z_in of step i+1')
    }
    {
      const s = novaStepAssign(9n)
      const badW = [(s.W[0] + 1n) % BLS_R, s.W[1]] // wrong sym1 = z²
      const inst = novaStrictInstance(params, s.x, badW)
      check(NV, 'an unsatisfiable step is detected', !novaRelaxedSatisfied(params, inst.U, inst.wit), 'a bad intermediate wire fails its constraint')
    }

    // A second IVC application on the *same* generic folding core: a MiMC-style
    // arithmetic permutation folded into a sequential hash chain.
    {
      const mimc = novaMimcStep(6)
      const mparams = novaSetup(mimc.r1cs)
      const ms = mimc.assign(7n)
      const minst = novaStrictInstance(mparams, ms.x, ms.W)
      check(NV, 'MiMC step R1CS is satisfied by its witness', novaRelaxedSatisfied(mparams, minst.U, minst.wit), '6 rounds of x ↦ (x+c)³, 13 constraints')
      check(NV, 'MiMC circuit output = direct permutation', ms.zOut === mimc.eval(7n), 'the R1CS computes the permutation')
      const mproof = novaIvcProveWith(mparams, mimc, 3n, 8)
      const mrep = novaIvcVerify(mparams, mproof)
      let mz = 3n
      for (let i = 0; i < 8; i++) mz = mimc.eval(mz)
      check(NV, 'IVC folds an 8-step MiMC hash chain', mrep.ok, 'the generic folding core, a different circuit')
      check(NV, 'folded MiMC chain output = direct iteration', mproof.zN === mz, 'a sequential hash nobody can shortcut')
      const mbad = { ...mproof, finalWit: { E: [...mproof.finalWit.E], W: [...mproof.finalWit.W] } }
      mbad.finalWit.W[1] = (mbad.finalWit.W[1] + 1n) % BLS_R
      check(NV, 'a tampered MiMC witness is rejected', !novaIvcVerify(mparams, mbad).ok, 'the folded relaxed check still binds')
    }
  }

  return t
}

// A minimal deep clone for the STARK proof (structuredClone preserves bigint).
function structuredCloneProof<T>(p: T): T {
  return structuredClone(p)
}
