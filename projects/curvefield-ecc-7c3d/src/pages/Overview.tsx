import { useSelfTest } from '../hooks/useSelfTest'
import { N, P } from '../ecc/secp256k1'

const LABS = [
  {
    path: '/real',
    ix: '01',
    title: 'The Group Law over ℝ',
    desc: 'Drag two points on a real cubic and watch chord-and-tangent addition build P + Q geometrically.',
  },
  {
    path: '/field',
    ix: '02',
    title: 'Curves over a Finite Field',
    desc: 'The same algebra over 𝔽ₚ: a scatter of points, cyclic subgroups, point orders, and the Hasse bound.',
  },
  {
    path: '/scalar',
    ix: '03',
    title: 'Scalar Multiplication',
    desc: 'Double-and-add, bit by bit. See why k·G is easy forward and a pseudo-random scramble to invert.',
  },
  {
    path: '/secp',
    ix: '04',
    title: 'secp256k1 Cryptosystem',
    desc: 'Real 256-bit keys, ECDH, deterministic ECDSA (RFC 6979), and BIP-340 Schnorr — signed and verified live.',
  },
  {
    path: '/encode',
    ix: '05',
    title: 'Encodings & Addresses',
    desc: 'SEC point compression, strict DER, Base58Check, Bech32/Bech32m, WIF, and Bitcoin P2PKH / P2WPKH addresses — built from scratch (RIPEMD-160 and all).',
  },
  {
    path: '/musig',
    ix: '06',
    title: 'MuSig2 Aggregation',
    desc: 'n signers fold into one aggregate key and one 64-byte BIP-340 signature, with rogue-key-resistant coefficients — the heart of Taproot multisig.',
  },
  {
    path: '/ed25519',
    ix: '07',
    title: 'Curve25519 · X25519 & Ed25519',
    desc: 'A second backend: the Montgomery ladder (RFC 7748) for key exchange and twisted-Edwards EdDSA (RFC 8032) for signatures, with SHA-512.',
  },
  {
    path: '/bls',
    ix: '08',
    title: 'BLS12-381 & the Pairing',
    desc: 'A hand-written optimal-ate pairing over an F_p² ⊂ F_p⁶ ⊂ F_p¹² tower — bilinearity checked live, then BLS signature aggregation and the rogue-key attack on it.',
  },
  {
    path: '/adaptor',
    ix: '09',
    title: 'Schnorr Adaptor Signatures',
    desc: 'Scriptless scripts: a pre-signature locked to a point T, completed only by knowing t — and a full atomic swap where claiming one leg leaks the secret that unlocks the other.',
  },
  {
    path: '/bip32',
    ix: '10',
    title: 'BIP-32 HD Wallets',
    desc: 'One seed, a whole tree of keys. Additive child derivation via HMAC-SHA512, hardened vs. watch-only (xpub) derivation, checked against the BIP-32 vectors.',
  },
  {
    path: '/attacks',
    ix: '11',
    title: 'Breaking the ECDLP',
    desc: 'Brute force vs. baby-step giant-step vs. Pollard’s rho, with step counts that show √n beating n.',
  },
  {
    path: '/rho',
    ix: '12',
    title: "Pollard's ρ, Drawn",
    desc: 'The named shape, animated: a random walk that runs into itself, splitting into tail and cycle, and the collision that leaks the key.',
  },
  {
    path: '/pohlig',
    ix: '13',
    title: 'Pohlig–Hellman',
    desc: 'Why the order must be prime: a smooth order shatters the discrete log into tiny per-prime pieces, glued back with the CRT.',
  },
  {
    path: '/invalid',
    ix: '14',
    title: 'The Invalid-Curve Attack',
    desc: 'One missing on-curve check recovers a full private key: feed a verifier small-order points on weak twins, read d mod ℓ from each reply, and CRT them together.',
  },
  {
    path: '/edge',
    ix: '15',
    title: 'Wycheproof Edge Cases',
    desc: 'An adversarial battery against the ECDSA verifier — zero scalars, malleable twins, off-curve keys, non-canonical DER — each rejected on cue.',
  },
  {
    path: '/shamir',
    ix: '16',
    title: 'Shamir Secret Sharing',
    desc: 'Hide a secret as a polynomial’s constant term, hand out points, recover it from any t of them — with Feldman VSS commitments that catch a cheating dealer.',
  },
  {
    path: '/frost',
    ix: '17',
    title: 'FROST Threshold Schnorr',
    desc: 'A shared key no one holds whole: any t-of-n signers produce one 64-byte BIP-340 signature, with binding factors that defeat the Drijvers/ROS forgery.',
  },
  {
    path: '/zk',
    ix: '18',
    title: 'Zero-Knowledge Σ-Protocols',
    desc: 'Pedersen commitments, a Schnorr proof of knowledge, Chaum–Pedersen DLEQ, and a bit-decomposition range proof — Fiat–Shamir making each non-interactive.',
  },
  {
    path: '/kzg',
    ix: '19',
    title: 'KZG Polynomial Commitments',
    desc: 'Commit to a whole polynomial in one group element and prove any evaluation with a constant-size pairing check — the scheme under PLONK and EIP-4844.',
  },
  {
    path: '/h2c',
    ix: '20',
    title: 'Hash-to-Curve (RFC 9380)',
    desc: 'Turn any message into a curve point the standard way: expand_message_xmd, the Simplified SWU map with the 11-/3-isogenies and cofactor clearing — pinned to the RFC’s own G1/G2 vectors — then a real BLS signature on it.',
  },
  {
    path: '/groth16',
    ix: '21',
    title: 'Groth16 zk-SNARK',
    desc: 'Prove you know x with x³+x+5 = out, revealing only out. R1CS → QAP → trusted setup → a three-element proof checked by one pairing equation, all on the lab’s own BLS12-381.',
  },
  {
    path: '/bulletproofs',
    ix: '22',
    title: 'Bulletproofs',
    desc: 'The log-size range proof: recast the bit constraints as one inner-product relation and fold the witness in half each round. A 64-bit amount in ~16 elements instead of hundreds — with aggregation and a full confidential transaction.',
  },
  {
    path: '/plonk',
    ix: '23',
    title: 'PLONK — a Universal SNARK',
    desc: 'The same x³+x+5 statement as Groth16, proved with a universal setup: selector gates, a permutation argument for the wiring, a grand-product polynomial, and a transparent KZG-batched verifier — all on the lab’s own BLS12-381.',
  },
  {
    path: '/stark',
    ix: '25',
    title: 'STARK — Transparent & Post-Quantum',
    desc: 'The one proof system here that needs no curve and no trusted setup — just a hash. Prove an execution over the Goldilocks field with an NTT, Merkle commitments, DEEP out-of-domain sampling and a FRI low-degree test, then watch a forged step get rejected live.',
  },
  {
    path: '/nova',
    ix: '40',
    title: 'Nova — a Folding Scheme for IVC',
    desc: 'Prove a function was applied N times without an N-sized proof. Each step emits an ordinary R1CS instance; Nova folds it into a running accumulator with one linear combination — relaxed R1CS closed under a random fold, the cross-term T, and a homomorphic Pedersen commitment on 𝔾₁. One relaxed check certifies the whole chain; every tamper is rejected live. No trusted setup, no pairings, no FFTs.',
  },
  {
    path: '/poseidon',
    ix: '26',
    title: 'Poseidon — a Hash You Can Prove',
    desc: 'An algebraic hash over the Goldilocks field — add a constant, raise to the 7ᵗʰ power, multiply by an MDS matrix — so its whole computation is already low-degree constraints. Then a from-scratch STARK proves "I know a preimage m with Poseidon(m) = d" without revealing m, with the forged-statement and fudged-round provers both rejected live.',
  },
  {
    path: '/pqsig',
    ix: '27',
    title: 'Post-Quantum Hash-Based Signatures',
    desc: 'The one signature family here that survives a quantum computer — resting on nothing but a hash. One idea, a hash chain, carried from a pencil-and-paper Lamport OTS through Winternitz (WOTS⁺) and a reusable Merkle key (XMSS, RFC 8391) all the way to the stateless scheme NIST standardised as SLH-DSA (SPHINCS⁺, FIPS 205).',
  },
  {
    path: '/mlkem',
    ix: '28',
    title: 'ML-KEM — Post-Quantum Lattice KEM',
    desc: 'The key-exchange that outlives Shor. ML-KEM (FIPS 203, the standardised CRYSTALS-Kyber) rests on Module-LWE — a noisy t = A·s + e over Z₃₃₂₉[X]/(X²⁵⁶+1) — not a discrete log, so no quantum computer is known to break it. From-scratch Keccak, the negacyclic NTT, centered-binomial noise, and the Fujisaki–Okamoto transform for all three parameter sets, wired into the real TLS 1.3 X25519MLKEM768 hybrid handshake.',
  },
  {
    path: '/mldsa',
    ix: '32',
    title: 'ML-DSA — Post-Quantum Lattice Signature',
    desc: 'The signature that outlives Shor — the companion to ML-KEM. ML-DSA (FIPS 204, the standardised CRYSTALS-Dilithium) is a Fiat–Shamir-with-aborts scheme over Z₈₃₈₀₄₁₇[X]/(X²⁵⁶+1): commit to HighBits(A·y), answer a τ-sparse ±1 challenge with z = y + c·s1, and reject-and-retry until z leaks nothing about the secret. A full 256-point NTT, Power2Round/Decompose, the MakeHint/UseHint carry recovery, and byte-exact packing for all three parameter sets — with the abort loop laid bare.',
  },
  {
    path: '/slhdsa',
    ix: '34',
    title: 'SLH-DSA — the hash-only PQ signature',
    desc: "The conservative post-quantum signature, standardised as SLH-DSA (FIPS 205, the standardised SPHINCS⁺). Where ML-DSA trusts a lattice, this trusts nothing but a hash — the same assumption the STARK already makes. Built from scratch on the lab's own SHA-256: WOTS⁺ one-time chains under a d-layer XMSS hypertree and a stateless FORS few-time signature, with the byte-exact ADRSc address compression and MGF1 digest — reproducing NIST's own ACVP keyGen and sigGen vectors byte-for-byte for -128f and -128s.",
  },
  {
    path: '/vrf',
    ix: '29',
    title: 'ECVRF — Verifiable Random Functions',
    desc: 'A public-key function whose output is unpredictable yet publicly verifiable — the randomness beacon behind Algorand and Chainlink. Both Edwards25519 ciphersuites of RFC 9381 (try-and-increment and Elligator2), from scratch and pinned byte-for-byte to the standard’s vectors, driving a verifiable leader-election lottery.',
  },
  {
    path: '/vdf',
    ix: '31',
    title: 'Verifiable Delay Functions',
    desc: 'Proof of sequential time — the delay analogue of the VRF. y = x^(2^T) mod N takes T squarings no parallel machine can shorten, yet verifies in a heartbeat: both the succinct Wesolowski proof and the log-size Pietrzak halving proof, from scratch in an RSA group. Plus a Rivest–Shamir–Wagner time-lock puzzle (encrypt to the future) and an unbiasable delay beacon — the RANDAO+VDF / Chia proof-of-time shape.',
  },
  {
    path: '/cgvdf',
    ix: '33',
    title: 'Class-Group VDF — no trusted setup',
    desc: 'The VDF next door has a trapdoor: whoever made N = p·q knows φ(N) and can skip the delay. This one removes it by squaring in the class group of an imaginary quadratic order Cl(Δ) — a group of genuinely unknown order (h(Δ) ≈ √|Δ|, as hard as factoring to compute) whose discriminant is just a public seed hash, so no one holds a shortcut and no ceremony is trusted. Binary quadratic forms + Gauss composition built from scratch, then the full Wesolowski proof over them — the engine under Chia’s consensus.',
  },
  {
    path: '/ring',
    ix: '30',
    title: 'Linkable Ring Signatures & Stealth Addresses',
    desc: 'The cryptography that hides a sender yet still forbids double-spends — Monero’s core. bLSAG and the concise CLSAG built on key images I = x·Hₚ(P), plus CryptoNote stealth one-time keys, assembled into a complete private payment with a ring of decoys.',
  },
  {
    path: '/sealed',
    ix: '24',
    title: 'Sealed · End-to-End Encrypted Messaging',
    desc: 'The whole lab, assembled into the Signal protocol — the E2EE behind WhatsApp and Signal. X3DH agrees a secret with an offline recipient; the Double Ratchet then gives every message forward secrecy and heals the session after a key compromise, over a from-scratch ChaCha20-Poly1305. A live Alice⇄Bob chat you can tamper with, reorder, and compromise.',
  },
  {
    path: '/aesgcm',
    ix: '35',
    title: 'AES & the Authenticated Modes',
    desc: "The symmetric standard the internet actually runs on, from the GF(2⁸) field up. AES (FIPS-197) with a computed S-box and a scrubbable round-by-round trace, then the modes that ride it: AES-GCM (TLS 1.3's default AEAD, with the GHASH accumulator drawn), AES-GCM-SIV (RFC 8452, nonce-misuse-resistant — shown breaking GCM and surviving on the same screen), AES-SIV (RFC 5297, the CMAC-based deterministic AEAD), and AES-CMAC (RFC 4493). Pinned byte-for-byte to the FIPS/NIST/RFC vectors and wired into the Sealed channel as a second cipher suite.",
  },
  {
    path: '/mpc',
    ix: '25',
    title: 'Secure Two-Party Computation',
    desc: "Compute a function of two secrets and reveal only the answer. Yao's protocol built from scratch: a Chou–Orlandi oblivious transfer on this lab's Ed25519 group (with a 1-of-N variant), then garbled circuits with free-XOR and half-gates (an AND costs the proven-minimal two ciphertexts; XOR and NOT are free). Run the original Millionaires' Problem — who is richer, without disclosing wealth — plus private equality, sum, product, and a sealed-bid second-price auction, with a live single-byte-tamper integrity demo. Then see the same circuits computed a second way, by the GMW secret-sharing protocol, and agree.",
  },
  {
    path: '/verify',
    ix: '31',
    title: 'Self-Test & Vectors',
    desc: 'The whole engine checked live against published SHA-256/512, SHA-3 / SHAKE (FIPS 202), HMAC, RIPEMD-160, secp256k1, BIP-340, RFC 7748/8032, MuSig2, BLS12-381, RFC 9380 hash-to-curve, EIP-2333 KeyGen, Groth16, PLONK, Bulletproofs, STARK/FRI, Shamir, FROST, Σ-protocols, KZG, RFC 9381 ECVRF, linkable ring signatures, RFC 8391 XMSS / SPHINCS⁺, ML-KEM (FIPS 203) round-trips at the standard byte-sizes, ML-DSA (FIPS 204) sign/verify round-trips at the standard byte-sizes with the rounding/hint identities pinned, RFC 8439 ChaCha20-Poly1305, AES (FIPS-197, all three key sizes + the Appendix B round trace), AES-GCM (NIST SP 800-38D test cases), AES-GCM-SIV (RFC 8452), AES-SIV (RFC 5297), AES-CMAC (RFC 4493), RFC 5869 HKDF, X3DH / Double Ratchet (over both ChaCha20-Poly1305 and AES-256-GCM), secure two-party computation (oblivious transfer + garbled circuits, exhaustive over all 4-bit input pairs, plus GMW secret-sharing cross-checked to agree), and Wycheproof vectors.',
  },
]

export function Overview() {
  const { tests: test, ready } = useSelfTest()
  const passed = test.filter((t) => t.pass).length

  return (
    <main className="page">
      <section className="hero">
        <div>
          <div className="eyebrow" style={{ color: 'var(--accent)', letterSpacing: '0.14em' }}>
            ELLIPTIC-CURVE CRYPTOGRAPHY, FROM SCRATCH
          </div>
          <h1>The geometry behind a signature.</h1>
          <p className="lead">
            A single idea — adding points on a cubic curve — scales from a picture you can draw by
            hand to the 256-bit math that secures Bitcoin, TLS, and SSH. Curvefield builds that idea
            up layer by layer, with a cryptographic engine written here, in the browser, and checked
            against the standards.
          </p>
          <div className="btn-row" style={{ marginTop: '1.2rem' }}>
            <a className="btn" href="#/real" style={{ textDecoration: 'none' }}>
              Start with the geometry →
            </a>
            <a className="btn ghost" href="#/secp" style={{ textDecoration: 'none' }}>
              Jump to real signatures
            </a>
          </div>
        </div>
        <div className="plotwrap" style={{ padding: '1rem' }}>
          <HeroCurve />
        </div>
      </section>

      <div className="statline" style={{ marginBottom: '2rem' }}>
        <div className="stat">
          <b>{ready ? `${passed}/${test.length}` : '…'}</b>
          <span>vectors passing</span>
        </div>
        <div className="stat">
          <b>256-bit</b>
          <span>secp256k1 keys</span>
        </div>
        <div className="stat">
          <b>~2¹²⁸</b>
          <span>work to break one key</span>
        </div>
        <div className="stat">
          <b>0</b>
          <span>crypto dependencies</span>
        </div>
      </div>

      <div className="grid cols-3">
        {LABS.map((l) => (
          <a key={l.path} className="cardlink" href={'#' + l.path}>
            <div className="ix">{l.ix}</div>
            <h3>{l.title}</h3>
            <p>{l.desc}</p>
          </a>
        ))}
      </div>

      <section className="panel" style={{ marginTop: '1.6rem' }}>
        <h2>Why one curve secures the internet</h2>
        <p style={{ color: 'var(--ink-dim)', maxWidth: '74ch' }}>
          On the curve <code>y² = x³ + 7</code> over a 256-bit prime field, the points form a cyclic
          group of prime order <code className="mono">{trunc(N)}</code>. Given a secret integer{' '}
          <em>d</em>, computing the public point <em>d·G</em> takes a few hundred additions. Going
          the other way — recovering <em>d</em> from <em>d·G</em> — is the elliptic-curve discrete
          logarithm problem, for which the best known attacks still need on the order of{' '}
          <code className="mono">2¹²⁸</code> steps. That gap, between a cheap forward map and an
          astronomically expensive inverse, is the whole game. Everything in this lab is a different
          view of it.
        </p>
        <div className="kv" style={{ marginTop: '0.8rem' }}>
          <dt>field prime p</dt>
          <dd>{trunc(P)}</dd>
          <dt>group order n</dt>
          <dd>{trunc(N)}</dd>
        </div>
      </section>
    </main>
  )
}

function trunc(n: bigint): string {
  const s = '0x' + n.toString(16)
  return s.length > 26 ? `${s.slice(0, 14)}…${s.slice(-8)}` : s
}

// A small decorative real-curve sketch for the hero.
function HeroCurve() {
  const W = 420
  const H = 300
  const a = -1
  const b = 1.4
  const sx = (x: number) => 40 + ((x + 2.5) / 5.5) * (W - 70)
  const sy = (y: number) => H / 2 - y * 42
  const pts: string[] = []
  for (let x = -2.5; x <= 3; x += 0.02) {
    const r = x * x * x + a * x + b
    if (r >= 0) pts.push(`${sx(x)},${sy(Math.sqrt(r))}`)
  }
  const lower: string[] = []
  for (let x = 3; x >= -2.5; x -= 0.02) {
    const r = x * x * x + a * x + b
    if (r >= 0) lower.push(`${sx(x)},${sy(-Math.sqrt(r))}`)
  }
  return (
    <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label="elliptic curve sketch">
      <defs>
        <linearGradient id="hg" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#5eead4" />
          <stop offset="1" stopColor="#a78bfa" />
        </linearGradient>
      </defs>
      <line x1="20" y1={H / 2} x2={W - 12} y2={H / 2} stroke="#233149" />
      <line x1={sx(0)} y1="12" x2={sx(0)} y2={H - 12} stroke="#233149" />
      <polyline points={[...pts, ...lower].join(' ')} fill="none" stroke="url(#hg)" strokeWidth="2.4" />
      <text x={W - 60} y={H / 2 - 8} fill="#64769a" fontSize="12" fontFamily="monospace">
        y² = x³ − x + 1.4
      </text>
    </svg>
  )
}
