# Curvefield — journal

An interactive **elliptic-curve cryptography lab**. One idea — adding points on a cubic
curve — carried from a picture you can draw by hand all the way to the 256-bit math that
secures Bitcoin and TLS. Every key, signature, and curve is computed live in the browser by
a from-scratch engine with **zero crypto dependencies**.

## Architecture

Pure-TypeScript engine under `src/ecc/`, all on native `BigInt`:

- `field.ts` — F_p arithmetic: modInv (extended Euclid), modPow, Legendre symbol,
  Tonelli–Shanks square roots.
- `curve.ts` — generic short-Weierstrass curve `y² = x³ + ax + b` over F_p: the full group
  law, scalar multiplication (double-and-add), point enumeration, point order, subgroups.
- `real.ts` — the same group law over ℝ for the geometric chord-and-tangent visualization.
- `sha256.ts` — hand-written SHA-256 + HMAC-SHA256 (synchronous, so it works in the
  sandboxed catalog thumbnail with no crypto.subtle), plus hex/byte/bigint helpers.
- `secp256k1.ts` — the real curve: keygen, ECDH, **RFC 6979** deterministic ECDSA (low-s),
  and **BIP-340** Schnorr (tagged hashes, x-only keys).
- `dlog.ts` — discrete-log solvers: brute force, baby-step giant-step, Pollard's rho
  (with restart-on-degeneracy), and an instrumented single-step rho walk that exposes the
  ρ-shaped tail+cycle for visualization.
- `ripemd160.ts` — hand-written RIPEMD-160 (the second half of Bitcoin's HASH160).
- `sha512.ts` — hand-written SHA-512 on 64-bit BigInt words (Ed25519's internal hash).
- `encoding.ts` — the serialization layer: SEC point compression/decompression, strict DER
  (BIP-66), Base58/Base58Check, Bech32/Bech32m (BIP-173/350), WIF, and P2PKH/P2WPKH/P2TR
  addresses.
- `pohlig.ts` — Pohlig–Hellman: trial-division factorization, per-prime-power lifting,
  CRT recombination, and a smooth-order weak-curve generator.
- `musig.ts` — MuSig2 (BIP-327-style) key + nonce aggregation, partial signing, and
  per-partial verification; the aggregate is an ordinary BIP-340 signature.
- `ed25519.ts` — Curve25519 backend: X25519 Montgomery ladder (RFC 7748) and Ed25519
  twisted-Edwards EdDSA (RFC 8032), point compression/decompression included.
- `wycheproof.ts` — an adversarial ECDSA-verifier battery (zero scalars, malleable twins,
  off-curve keys, non-canonical DER, …) computed live.
- `rng.ts` — CSPRNG with a seeded xorshift fallback so thumbnails never throw.
- `fp2.ts` / `fp6.ts` / `fp12.ts` — the BLS12-381 extension-field tower
  (F_p² = F_p[u]/(u²+1) ⊂ F_p⁶ = F_p²[v]/(v³−ξ), ξ = 1+u ⊂ F_p¹² = F_p⁶[w]/(w²−v)).
- `bls12381.ts` — G1/G2 groups, the sextic untwist into F_p¹², a from-scratch optimal-ate
  Miller loop + split final exponentiation, try-and-increment hash-to-G1, and BLS sign /
  aggregate / verify (distinct-message pairing product and fast common-message).
- `adaptor.ts` — Schnorr adaptor (pre-)signatures: pre-sign / adapt / extract, and a full
  scriptless-script atomic swap run end to end.
- `bip32.ts` — BIP-32 HD wallets: master-from-seed, CKDpriv/CKDpub, xprv/xpub serialization,
  on a from-scratch HMAC-SHA512 (in `sha512.ts`); checked against the BIP-32 vectors.
- `invalid.ts` — the invalid-curve attack: a broken oracle, small-order points on weak curves,
  and CRT key recovery, with the on-curve check shown to defeat it.
- `selftest.ts` — known-answer vectors + round-trips, run live on the Self-Test page
  (now **59/59** checks across 20 subsystems).

UI is a hash-routed React app (`src/pages/`, `src/ui/`) — sixteen labs plus an overview.

## Ideas / backlog

- [x] F_p field arithmetic with Tonelli–Shanks square roots
- [x] Generic short-Weierstrass curve + group law + scalar mult + subgroups
- [x] Real-number group law with draggable chord-and-tangent construction
- [x] From-scratch SHA-256 + HMAC-SHA256, validated against FIPS/RFC vectors
- [x] secp256k1 keygen + ECDH
- [x] RFC 6979 deterministic ECDSA (sign/verify, low-s canonical)
- [x] BIP-340 Schnorr (sign/verify, tagged hashes, x-only keys)
- [x] Discrete-log attacks: brute force, BSGS, Pollard's rho + scaling comparison
- [x] Live self-test page wired to known-answer vectors (now **43 checks**, 16 subsystems)
- [x] Overview, Group-Law, Finite-Field, Scalar-Mult, secp256k1, Attacks, Self-Test pages
- [x] Point compression/decompression playground with DER + WIF encoding (Encodings lab:
      SEC, strict DER, Base58Check, Bech32/Bech32m, WIF, P2PKH/P2WPKH/P2TR)
- [x] Pollard's rho animated as a colliding ρ-shaped walk (play/step animator, tail+cycle
      layout, live collision→key arithmetic)
- [x] Pohlig–Hellman attack on a deliberately smooth-order curve (factor → per-subgroup
      BSGS → CRT, with cost vs √n contrast)
- [x] MuSig-style key/signature aggregation demo (MuSig2, n signers, rogue-key contrast,
      per-partial verification — aggregate verifies as plain BIP-340)
- [x] Curve25519 / Edwards-form curve as a second backend (X25519 RFC 7748 + Ed25519
      RFC 8032, with from-scratch SHA-512)
- [x] Wycheproof edge-case vectors for ECDSA verification (17-case adversarial battery +
      dedicated Edge Cases lab)
- [x] RIPEMD-160 + SHA-512 from scratch, validated against OpenSSL / FIPS vectors

### Next ideas

- [x] Pairing-friendly curve (BLS12-381) + BLS signature aggregation as a third backend —
      a hand-written F_p² ⊂ F_p⁶ ⊂ F_p¹² tower (`fp2/fp6/fp12.ts`), an optimal-ate Miller
      loop with the sextic untwist ψ(x,y) = (x·w⁻², y·w⁻³) and a split final exponentiation,
      BLS sign / aggregate / verify (distinct-message pairing **product** and fast
      common-message), plus a live bilinearity check and a rogue-key forgery. New **BLS
      Pairing** lab; self-test now **48/48** across 17 subsystems.
- [x] Schnorr **adaptor signatures** / scriptless-script atomic swap demo — `adaptor.ts`:
      pre-sign locked to T = t·G, adapt with t, extract t = s − ŝ, and a full two-leg atomic
      swap run end to end. New **Adaptor Sigs** lab with a guided stepper.
- [x] BIP-32 HD key derivation — `bip32.ts` on a new from-scratch **HMAC-SHA512**: master from
      seed, CKDpriv/CKDpub, xprv/xpub serialization, hardened vs. watch-only derivation,
      validated against the **BIP-32 test vectors**. New **HD Wallets** lab.
- [x] Invalid-curve attack lab — `invalid.ts`: a broken oracle that skips the on-curve check is
      fed small-order points on weak curves y² = x³ + ax + b′; each reply leaks d mod ℓ, and the
      CRT recovers the whole key. New **Invalid Curve** lab; the on-curve check defeats it.
- [ ] Pollard's rho **with distinguished points** + parallel (van Oorschot–Wiener) collision search
- [ ] Side-channel demo: timing leak from a naive (branchy) scalar mult vs the Montgomery ladder
- [ ] BLS hash-to-curve via the RFC 9380 SSWU map (current hash-to-G1 is try-and-increment)
- [ ] BLS12-381 G2 point compression + the optimized (frobenius) final exponentiation

### Session 5 plan — a zero-knowledge & threshold-cryptography suite

The engine already has every primitive these protocols stand on (a field, the secp256k1
group, BIP-340 Schnorr, and a working BLS12-381 pairing). This session turns those
primitives into the modern building blocks of applied ZK and threshold signing — each
written from scratch, validated in Node against its own algebraic identities, and given a
guided lab page.

- [x] **`polynomial.ts`** — a modulus-generic polynomial algebra over any prime field
      (Horner eval, add/sub/scale/mul, Euclidean long division, Lagrange interpolation, the
      vanishing polynomial ∏(X−xᵢ), formal derivative). The shared substrate under Shamir and
      KZG, decoupled from any curve so it can be unit-tested on its own.
- [x] **`shamir.ts`** — **Shamir secret sharing** over the secp256k1 scalar field F_n: split a
      secret into a random degree-(t−1) polynomial, hand out shares (i, f(i)), and reconstruct
      f(0) by Lagrange interpolation from *any* t of them. On top of it **Feldman VSS**: publish
      curve commitments Cⱼ = aⱼ·G so every holder can verify yᵢ·G ?= Σⱼ Cⱼ·iʲ without learning
      the secret — catching a cheating dealer. New **Secret Sharing** lab.
- [x] **`frost.ts`** — **FROST** threshold Schnorr (Komlo–Goldberg, RFC 9591 shape), trusted-
      dealer variant: per-signer two-nonce commitments, the binding factors ρᵢ that stop the
      Drijvers/ROS forgery, a group nonce R, Lagrange-weighted partial signatures, and an
      aggregate that verifies under the **unmodified BIP-340 `schnorrVerify`** — a t-of-n
      multisig indistinguishable from a single signer. Includes per-partial verification and a
      "(t−1) signers cannot" negative. New **FROST** lab.
- [x] **`sigma.ts`** — the **Σ-protocol** toolkit, all made non-interactive with Fiat–Shamir:
      a NUMS second generator H (unknown-dlog, hash-to-curve), **Pedersen commitments**
      Com(m,r)=m·G+r·H, a **Schnorr proof of knowledge** of a discrete log, **Chaum–Pedersen**
      equality of two discrete logs, a **1-of-2 OR-proof** (prove a commitment opens to 0 or 1
      without revealing which), and — as a capstone — a **bit-decomposition range proof** that a
      committed value lies in [0, 2ⁿ) built purely from those OR-proofs. New **Zero-Knowledge**
      lab.
- [x] **`kzg.ts`** — **KZG polynomial commitments** (Kate–Zaverucha–Goldberg) on the existing
      BLS12-381 pairing: a powers-of-τ structured reference string, a constant-size commitment
      C = f(τ)·G₁, an evaluation proof via the quotient (f(X)−y)/(X−z), and pairing verification
      e(C−[y]₁, [1]₂) = e(W, [τ]₂−[z]₂) — the polynomial-commitment scheme under PLONK and EIP-4844.
      Adds the additive **homomorphism**, a **batch/multi-point** opening, and a **soundness**
      demo (a forged proof for the wrong value fails the pairing). New **KZG** lab.
- [x] Extend the live **Self-Test** with known-answer + round-trip checks for all five
      subsystems and renumber the lab cards on the Overview.

## Session log

- 2026-06-28 (claude): created from template. Built the full ECC engine (field, curve, real,
  sha256/hmac, secp256k1 with RFC 6979 ECDSA + BIP-340 Schnorr, dlog attacks) and verified it
  in Node against published vectors — 23/23 checks pass, including the canonical 2·G / 3·G /
  n·G secp256k1 identities and a BIP-340 test-vector pubkey. Built seven interactive pages with
  a dark lab UI. Lint + build green via verify-project.mjs.
- 2026-06-28 (claude): major expansion — cleared the entire original backlog and roughly
  doubled the engine. Added from-scratch **RIPEMD-160** and **SHA-512**; a full **encoding
  layer** (SEC compression, strict-DER, Base58Check, Bech32/Bech32m, WIF, P2PKH/P2WPKH/P2TR),
  all checked against Bitcoin-wiki / BIP-173 vectors; **Pohlig–Hellman** with a smooth-curve
  generator; **MuSig2** aggregation that produces a real BIP-340 signature; a **Curve25519**
  backend (**X25519** RFC 7748 + **Ed25519** RFC 8032, exact test-vector matches); a
  single-step **Pollard's ρ** walk visualizer; and a **Wycheproof-style** ECDSA-verifier
  battery. Six new lab pages wired into the nav and Overview. Self-test grew 23 → **43/43**.
  Every primitive validated in Node against published vectors before wiring the UI; lint +
  build green via verify-project.mjs.
- 2026-06-28 (claude): added **pairing-based cryptography** — a from-scratch **BLS12-381**
  engine. Built the extension-field tower `fp2.ts` / `fp6.ts` / `fp12.ts` (F_p²=F_p[u]/(u²+1),
  F_p⁶=F_p²[v]/(v³−ξ) with ξ=1+u, F_p¹²=F_p⁶[w]/(w²−v)) and `bls12381.ts`: G1 over F_p, G2 over
  the sextic twist E'/F_p², the untwist ψ(x,y)=(x·w⁻², y·w⁻³) onto y²=x³+4, an **optimal-ate
  Miller loop** driven by the BLS seed, and a **final exponentiation** split as
  (p⁶−1)·(p²+1)·(Φ₁₂(p)/r) with the easy part done by conjugate-and-invert. On top: try-and-
  increment hash-to-G1 with cofactor clearing, BLS keygen/sign, signature **aggregation**, a
  distinct-message pairing-**product** verifier and a fast common-message verifier, and the
  **rogue-key forgery** against the latter. The whole thing was debugged in Node against field
  axioms + pairing **bilinearity** e(aP,bQ)=e(P,Q)^ab and non-degeneracy (the untwist initially
  mapped to the wrong curve b'=4(1+u)² — fixed by untwisting with w⁻² instead of w²). New **BLS
  Pairing** lab page; the self-test (now run off the initial paint, since a pairing is ~170 ms
  of BigInt) grew 43 → **48/48** across 17 subsystems. Lint + build green via verify-project.mjs.
- 2026-06-28 (claude): three more advanced labs, each validated in Node before wiring.
  (1) **Schnorr adaptor signatures** (`adaptor.ts`): pre-sign locked to an adaptor point T,
  adapt with the secret t, extract t = s − ŝ, and a complete two-leg **atomic swap** where
  Alice claiming her leg leaks the secret Bob needs for his — a guided stepper UI.
  (2) **BIP-32 HD wallets** (`bip32.ts`) on a new from-scratch **HMAC-SHA512** (added to
  `sha512.ts`): master-from-seed, CKDpriv/CKDpub, xprv/xpub Base58 serialization, hardened vs.
  watch-only derivation — matched **byte-for-byte against the BIP-32 test vectors** (master,
  m/0', m/0'/1 xprv+xpub). (3) **Invalid-curve attack** (`invalid.ts`): because the Weierstrass
  addition law ignores b, a verifier that skips the on-curve check computes d·Q on the
  attacker's curve; sending small-order points on weak curves leaks d mod ℓ, and the CRT
  rebuilds the key (recovered key reproduces Q in 4 oracle queries) — with the one-line on-curve
  fix shown to defeat it. Three new lab pages (Adaptor Sigs, HD Wallets, Invalid Curve) wired
  into the nav and Overview; lab cards renumbered 01–16. Self-test grew 48 → **59/59** across 20
  subsystems. A browser smoke test (headless Chromium) confirmed every route renders with zero
  JS errors. Lint + build green via verify-project.mjs.
- 2026-06-28 (claude): **a zero-knowledge & threshold-cryptography suite** — five new
  from-scratch engine modules, each validated in Node against its own algebraic identities
  before any UI. (1) `polynomial.ts`: a modulus-generic polynomial algebra (Horner eval, Euclidean
  long division, Lagrange interpolation, vanishing polynomial, derivative) — the shared substrate
  for the two below. (2) `shamir.ts`: **Shamir secret sharing** over 𝔽ₙ with **Feldman VSS**
  commitments (every honest share verifies, a corrupted one is caught, any t-of-n quorum recovers
  the secret while t−1 cannot). (3) `frost.ts`: **FROST** threshold Schnorr (trusted-dealer,
  RFC 9591 shape) — two-nonce commitments, binding factors ρᵢ that defeat the Drijvers/ROS forgery,
  Lagrange-weighted partials, and an aggregate that verifies under the **unmodified BIP-340
  `schnorrVerify`** (the MuSig2 gx/gr parity trick reused); different quorums all sign, under-
  threshold sets fail. (4) `sigma.ts`: the **Σ-protocol** toolkit, Fiat–Shamir non-interactive — a
  NUMS generator H via hash-to-curve, Pedersen commitments, a Schnorr proof of knowledge, a
  Chaum–Pedersen DLEQ, a 1-of-2 OR-proof (bit), and a **bit-decomposition range proof** that a
  committed value lies in [0, 2ⁿ). (5) `kzg.ts`: **KZG polynomial commitments** on the existing
  BLS12-381 pairing — a powers-of-τ SRS, constant-size commitment C = f(τ)·G₁, an evaluation proof
  via the quotient (f−y)/(X−z), pairing verification e(C−[y],[1]) = e(W,[τ]−[z]), the additive
  homomorphism, and a real **batch verification** that folds many openings into one multi-pairing
  by a random linear combination; soundness shown by a forged value failing the check. Four new lab
  pages (Secret Sharing, FROST, Zero-Knowledge, KZG) wired into the nav + Overview, cards renumbered
  01–20, KZG's pairing checks deferred off the paint like the self-test. Self-test grew 59 →
  **82/82** across **25 subsystems** (added Polynomial, Shamir, FROST, Sigma, KZG known-answer +
  round-trip + soundness checks). Every module verified in Node via a strip-types harness, and a
  headless-Chromium render check confirmed all four new routes paint with all-green verdict tags
  and zero app JS errors. No new dependencies — still zero crypto deps. Lint + build green via
  verify-project.mjs.
