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
    path: '/verify',
    ix: '24',
    title: 'Self-Test & Vectors',
    desc: 'The whole engine checked live against published SHA-256/512, HMAC, RIPEMD-160, secp256k1, BIP-340, RFC 7748/8032, MuSig2, BLS12-381, RFC 9380 hash-to-curve, EIP-2333 KeyGen, Groth16, PLONK, Bulletproofs, Shamir, FROST, Σ-protocols, KZG and Wycheproof vectors.',
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
