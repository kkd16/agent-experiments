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
- `bulletproofs.ts` — **Bulletproofs** (Bünz et al. 2018): a Fiat–Shamir transcript, NUMS
  generator vectors, the **inner-product argument** (prover + a transparent recursive verifier
  *and* an optimized single-multi-exponentiation verifier via the s-vector, pinned to agree), and
  **aggregated logarithmic range proofs** — proving m values in [0,2ⁿ) in only 2·⌈log₂(nm)⌉+O(1)
  group elements. Plus a full **confidential transaction**: a homomorphic kernel-excess balance
  proof (Σin = Σout + fee) wrapped around one aggregated range proof — the Monero/Mimblewimble
  structure, with an inflation attack shown to break it.
- `plonk.ts` — **PLONK** (Gabizon–Williamson–Ciobotaru 2019), a *universal* zk-SNARK on the same
  BLS12-381 pairing + KZG: a multiplicative evaluation domain H = ⟨ω⟩ (roots of unity found live in
  F_r's 2³²-smooth subgroup), selector-gate arithmetization
  (q_L·a+q_R·b+q_O·c+q_M·a·b+q_C+PI = 0), a copy-constraint **permutation argument** over the three
  cosets H, k₁·H, k₂·H, the **grand-product** accumulator z(X), the split quotient
  t_lo/mid/hi, a Fiat–Shamir transcript, and a fully **blinded** 5-round prover. Verified
  *transparently*: every polynomial is opened at ζ (and z at ζ·ω) with two batched KZG proofs and
  the verifier re-checks gate + α·perm + α²·boundary = t(ζ)·Z_H(ζ) as a scalar identity. Same
  x³+x+5 statement as Groth16, so the two systems sit side by side.
- `selftest.ts` — known-answer vectors + round-trips, run live on the Self-Test page
  (now **131/131** checks across 32 subsystems).

UI is a hash-routed React app (`src/pages/`, `src/ui/`) — twenty-three labs plus an overview.

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
- [x] BLS hash-to-curve via the RFC 9380 SSWU map (current hash-to-G1 is try-and-increment) —
      `hash2curve.ts`: `expand_message_xmd`, `hash_to_field`, the Simplified SWU map with the
      11-isogeny (𝔾₁) / 3-isogeny (𝔾₂), sgn0, an F_{p²} sqrt, and h_eff cofactor clearing.
      Matches the **RFC 9380 Appendix J** 𝔾₁/𝔾₂ test vectors bit-for-bit.
- [x] BLS12-381 G2 point compression + the optimized (frobenius) final exponentiation —
      `blsenc.ts` (ZCash/Eth 48/96/192-byte codecs, imaginary-first, lexicographic sign bit) and
      `bls_finalexp.ts` (a Frobenius map with load-time-derived constants + the Hayashida–Aranha
      addition-chain final exp, ≈17× fewer F_p¹² muls, proven = e(·)³ in the self-test).

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

### Session 6 plan — standards-grade BLS & a real zk-SNARK

The pairing stack was a teaching prototype (try-and-increment hashing, no wire format, a slow
final exp). This session makes it **production-shaped** and standards-conformant, then uses it to
build the marquee primitive of modern ZK — a Groth16 zk-SNARK — entirely on the lab's own
from-scratch BLS12-381. Every piece is pinned to a *published* test vector, not just internal
consistency.

- [x] **`hash2curve.ts`** — **RFC 9380** hash-to-curve. `expand_message_xmd` (SHA-256),
      `hash_to_field` for F_p and F_{p²}, the **Simplified SWU** map onto the isogenous curves,
      the **11-isogeny** (𝔾₁) and **3-isogeny** (𝔾₂) back to E, a constant `sgn0`, an F_{p²}
      square root, and h_eff cofactor clearing. Pinned to the **RFC 9380 Appendix J** 𝔾₁/𝔾₂ RO
      vectors and the K.1 `expand_message_xmd` vectors.
- [x] **`blsenc.ts`** — the **ZCash / Ethereum** point serialization: 𝔾₁ in 48 bytes, 𝔾₂ in 96,
      with the compression/infinity/sign flag bits, F_{p²} packed imaginary-part-first, and the
      lexicographic sign rule. Pinned to the canonical compressed generators; full round-trips.
- [x] **`blssig.ts`** — BLS signatures, the **IRTF draft** "minimal-signature-size" scheme:
      **HKDF KeyGen** (matches the **EIP-2333** master-SK vector), CoreSign/CoreVerify with the
      ciphersuite DST, aggregate + distinct-message AggregateVerify, **proof-of-possession**, and
      FastAggregateVerify. Signature wire bytes match a conformant library.
- [x] **`bls_finalexp.ts`** — the optimized **final exponentiation** (Frobenius + Hayashida–Aranha
      addition chain). Frobenius constants derived at load time from ξ; proven equal to e(·)³ —
      a fixed, pairing-preserving cube — so every pairing equality still holds, ≈17× faster.
- [x] **`groth16.ts`** — a complete **Groth16 zk-SNARK**: R1CS → QAP (Lagrange interpolation),
      a transparent trusted setup, a 3-element proof (A,C ∈ 𝔾₁, B ∈ 𝔾₂), and one-pairing-equation
      verification — all on the from-scratch pairing. Honest proofs accept; wrong public input,
      tampered proof, and forged witness all reject. A worked x³+x+5 circuit.
- [x] Two new lab pages (**Hash-to-Curve**, **Groth16 SNARK**) and **+24 self-test checks** across
      five new subsystems (Final Exp, Hash-to-Curve, BLS Serialization, BLS Signatures, Groth16).
- [x] **PLONK / universal SRS** as a second proof system reusing KZG — `plonk.ts`: roots-of-unity
      domain, selector-gate + permutation-argument arithmetization, grand-product z(X), a blinded
      5-round Fiat–Shamir prover, and a transparent KZG-batched verifier. Same x³+x+5 statement as
      Groth16 (Session 8). New **PLONK** lab; self-test 122 → **131/131**.
- [ ] **BLS hash-to-curve fuzzer** — random messages cross-checked against on-curve + in-subgroup.
- [ ] **Aggregate-verify performance**: a multi-Miller-loop product cached across signatures.
- [ ] **G2 subgroup check** via the ψ endomorphism (faster than the full r·P test).

### Session 7 plan — Bulletproofs: from linear to logarithmic

The Σ-protocol range proof in `sigma.ts` is honest but *linear*: one OR-proof per bit, so a 64-bit
amount costs hundreds of group elements. This session ships the primitive that fixed that — and
that real confidential-transaction systems (Monero, Mimblewimble) actually deploy — entirely from
scratch on secp256k1, pinned by round-trip + soundness + dual-verifier checks.

- [x] **`bulletproofs.ts` — Fiat–Shamir transcript.** A domain-separated running-hash transcript
      (absorb points/scalars, squeeze non-zero F_n challenges, ratchet) so the interactive protocol
      collapses to one offline-checkable object; prover and verifier walk it in lock-step.
- [x] **NUMS generator vectors.** Independent `gv`, `hv` (+ `u`) with pairwise-unknown discrete
      logs from domain-separated try-and-increment hash-to-curve, built once and cached/extended.
- [x] **The inner-product argument.** Prove P = ⟨a,gv⟩ + ⟨b,hv⟩ + ⟨a,b⟩·u in ⌈log₂ n⌉ rounds by
      folding the vectors under each challenge (one L, one R per round). Two verifiers — a
      transparent recursive replay **and** an optimized single multi-exponentiation via the s-vector
      sᵢ = Π xⱼ^{±1} — and the self-test pins them to agree.
- [x] **Aggregated range proofs.** Encode "v ∈ [0,2ⁿ)" as the polynomial identity
      t(X) = ⟨l(X), r(X)⟩ over the bit-vectors; commit to t₁,t₂; prove t̂ via the IPA. Aggregates
      **m values into one proof** of size 2·⌈log₂(nm)⌉+4 points — a 64-bit proof in 16 elements
      (≈20× smaller than the linear form), verified by the δ(y,z) commitment check + the IPA.
- [x] **Confidential transaction.** A homomorphic **kernel-excess** balance proof (E = Σin − Σout
      − fee·G proven to be Δr·H by a Schnorr PoK with base H) wrapped around one aggregated range
      proof over the outputs — amounts stay hidden, money is conserved and non-negative. An
      output-inflation attack is shown to break the balance.
- [x] New **Bulletproofs** lab page: O(log) vs O(n) size comparison, an interactive range proof
      (transparent ≡ optimized verifier, mauled-t̂ soundness), the folding argument drawn round by
      round, and the confidential-transaction demo with a live attack toggle. Wired into nav +
      Overview (cards renumbered, Self-Test → 23).
- [x] **+16 self-test checks** (generators, IPA round-trip, dual-verifier agreement, range
      round-trip + soundness, 4×16-bit aggregation, logarithmic-size assertion, confidential-tx
      balance + inflation rejection, wire round-trip); suite grew 106 → **122/122** across 26 subsystems.
- [ ] **Vector-Pedersen / weighted inner product** (WIP) for the tighter BP+ (Bulletproofs+) proof.
- [ ] **Batch range-proof verification** — fold many proofs' multi-exponentiations into one.
- [ ] **arithmetic-circuit Bulletproof** (the general R1CS/constraint form, not just ranges).
- [x] **proof (de)serialization** — compact fixed-layout wire form (33·points + 32·scalars + a
      2-byte header), with an exact-size formula and a loss-free, re-verifying round-trip test (a
      64-bit proof is **723 bytes** on the wire); the real byte length is surfaced in the UI.

### Session 8 plan — PLONK, a universal SNARK

Groth16 (Session 6) gave the smallest possible proof, but at the cost of a *circuit-specific*
ceremony. This session builds its universal counterpart on the machinery already here — the KZG
commitments (Session 5) and the BLS12-381 pairing (Session 3) — so the *same* powers-of-τ prove any
circuit. Every piece from scratch, validated in Node against its own algebraic identities and given
a guided lab.

- [x] **`plonk.ts` — the domain & arithmetization.** A multiplicative domain H = ⟨ω⟩ with ω a
      primitive n-th root of unity found live in F_r's 2³²-smooth subgroup; the vanishing
      polynomial Z_H = Xⁿ−1; closed-form Lagrange evaluations. Selector-gate encoding
      (q_L,q_R,q_O,q_M,q_C) with a public-input polynomial PI(X), and a copy-constraint
      **permutation** σ over the 3n wire cells, interpolated into S_σ1/2/3 on the disjoint cosets
      H, k₁·H, k₂·H.
- [x] **The grand-product argument.** z(X) accumulates ∏ (wire+β·id+γ)/(wire+β·σ+γ) across the
      rows; it returns to 1 after a full loop iff every copy constraint holds (checked live).
- [x] **A blinded 5-round prover.** Fiat–Shamir transcript (β,γ,α,ζ,v); witness polys a,b,c and z
      blinded by multiples of Z_H; the quotient t = (gate + α·perm + α²·boundary)/Z_H split into
      t_lo/mid/hi with the standard cross-term blinders; two **batched KZG openings** (at ζ, and z
      at ζ·ω).
- [x] **A transparent verifier.** Re-derives every challenge, evaluates the public selectors and
      PI at ζ, and re-checks gate + α·(perm₁−perm₂) + α²·(z̄−1)·L₁(ζ) = t(ζ)·Z_H(ζ) as a scalar
      identity, then confirms the two openings by pairing. Honest proofs accept; a wrong public
      input, a tampered commitment, a mauled evaluation, and a forged witness all reject.
- [x] New **PLONK** lab page (the 5 rounds, the gate table, the σ-cycles, the grand-product
      accumulator drawn cell by cell, the transparent identity broken into its terms, and a
      PLONK-vs-Groth16 comparison), wired into nav + Overview (cards renumbered, Self-Test → 24).
- [x] **+9 self-test checks** (roots of unity, Lagrange closed form, witness satisfaction, grand
      product closes, quotient divides, honest accept, wrong-input/mauled-eval/forged-witness
      reject); suite grew 122 → **131/131**.
- [ ] **Custom & lookup gates (plookup)** — range/XOR tables to shrink bit-heavy circuits.
- [ ] **Recursive/aggregate PLONK** — verify one proof inside another's circuit.
- [ ] **KZG linearisation** — fold the ζ-openings into one linearisation polynomial (production
      PLONK's proof-size optimisation) as a second, terser verifier alongside the transparent one.

## Session log

- 2026-07-02 (claude): **PLONK — a universal zk-SNARK, from scratch.** One new engine module,
  `plonk.ts`, built on the existing KZG commitments and BLS12-381 pairing — a *universal* setup
  (the same powers-of-τ prove any circuit), in deliberate contrast to Groth16's circuit-specific
  ceremony. (1) A multiplicative **evaluation domain** H = ⟨ω⟩: ω a primitive n-th root of unity
  located at run time in F_r's 2³²-smooth subgroup, with Z_H = Xⁿ−1 and closed-form Lagrange
  evaluations pinned to the interpolated ones. (2) A **selector-gate arithmetization**
  (q_L·a+q_R·b+q_O·c+q_M·a·b+q_C+PI = 0) plus a **copy-constraint permutation** σ over the 3n wire
  cells, interpolated into S_σ1/2/3 on the disjoint cosets H, k₁·H, k₂·H. (3) The **grand-product**
  polynomial z(X) that certifies the wiring — it accumulates ∏(wire+β·id+γ)/(wire+β·σ+γ) and returns
  to 1 exactly when every copy constraint holds. (4) A **blinded 5-round Fiat–Shamir prover**
  (challenges β,γ,α,ζ,v; a,b,c,z blinded by Z_H multiples; the split quotient t_lo/mid/hi with the
  standard cross-term blinders; two batched KZG openings at ζ and ζ·ω). (5) A **transparent
  verifier** that re-checks gate + α·(perm₁−perm₂) + α²·(z̄−1)·L₁(ζ) = t(ζ)·Z_H(ζ) as a scalar
  identity among the opened values and confirms both openings by pairing — keeping every term of the
  argument visible rather than folding it into a linearisation. Proves the *same* x³+x+5 statement as
  the Groth16 lab. The whole module was validated in Node first (25 checks: honest accept, grand
  product closes, quotient divides, and wrong-public-input / tampered-commitment / mauled-evaluation
  / forged-witness all reject), then wired into a new **PLONK** lab page (the 5 rounds, the gate
  table, the σ-cycles, the grand-product accumulator drawn cell by cell, the transparent identity
  broken into its three terms with live lie/tamper toggles, and a PLONK-vs-Groth16 comparison).
  Nav + Overview updated (cards renumbered, Self-Test → 24). A headless-Chromium render check
  confirmed the route paints, the proof builds live, the verifier accepts, and the lie toggle flips
  it to a clean reject — zero app JS errors. Self-test grew 122 → **131/131** (+9 PLONK checks). No
  new dependencies — still zero crypto deps. Lint + build green via verify-project.mjs.

- 2026-06-28 (claude): **Bulletproofs — logarithmic range proofs, from scratch.** One new engine
  module, `bulletproofs.ts`, built in three layers on the existing Pedersen commitments. (1) A
  domain-separated **Fiat–Shamir transcript** (absorb/squeeze/ratchet) and **NUMS generator
  vectors** from try-and-increment hash-to-curve, cached and extended on demand. (2) The
  **inner-product argument** — proving P = ⟨a,gv⟩+⟨b,hv⟩+⟨a,b⟩·u by folding the witness in half each
  round (one L,R per round) — with **two** verifiers, a transparent recursive replay and an
  optimized single multi-exponentiation via the s-vector, pinned to agree. (3) **Aggregated range
  proofs**: the t(X)=⟨l(X),r(X)⟩ polynomial encoding of the bit constraints, the δ(y,z) commitment
  check, and the IPA proving t̂ — m values in one 2·⌈log₂(nm)⌉+4-element proof (a 64-bit proof is
  **721 B vs 14,561 B linear, ~20× smaller**, in 6 rounds). Plus a full **confidential transaction**:
  a homomorphic kernel-excess balance proof around one aggregated range proof (the
  Monero/Mimblewimble structure), with an output-inflation attack shown to break it. The proof also
  (de)serializes to a compact fixed-layout wire form (a 64-bit proof is literally **723 bytes**),
  with a loss-free, re-verifying round-trip. A new
  **Bulletproofs** lab page visualizes the O(log)-vs-O(n) size gap, an interactive range proof (both
  verifiers + mauled-t̂ soundness), the folding rounds drawn, and the confidential-tx demo with a
  live attack toggle; wired into nav + Overview (Self-Test renumbered to 23). Self-test grew
  106 → **122/122** across 26 subsystems (+16 Bulletproofs checks: generators, IPA round-trip,
  dual-verifier agreement, range round-trip + two soundness checks, 4×16-bit aggregation,
  logarithmic-size assertion, confidential-tx balance + inflation rejection). Validated end-to-end in
  Node via a strip-types harness and a headless-Chromium render check (all panels paint, verdicts
  green, the 64-bit proof shows 20.2× smaller, zero app JS errors). No new dependencies — still zero
  crypto deps. Lint + build green via `verify-project.mjs`.

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
- 2026-06-28 (claude): **standards-grade BLS + a from-scratch Groth16 zk-SNARK** — five new engine
  modules, each pinned to a *published* test vector before any UI. (1) `hash2curve.ts`: the full
  **RFC 9380** hash-to-curve — `expand_message_xmd`, `hash_to_field` over F_p and F_{p²}, the
  **Simplified SWU** map, the **11-isogeny** (𝔾₁) and **3-isogeny** (𝔾₂), `sgn0`, an F_{p²} square
  root, and h_eff cofactor clearing — reproducing the **RFC 9380 Appendix J** 𝔾₁/𝔾₂ RO vectors and
  the K.1 expander vectors bit-for-bit (replacing the old try-and-increment hash). (2) `blsenc.ts`:
  the **ZCash/Ethereum** wire codecs (48/96/192 bytes, compression/infinity/sign flags, F_{p²}
  imaginary-first, lexicographic sign bit), matching the canonical compressed generators with full
  round-trips. (3) `blssig.ts`: BLS signatures in the **IRTF draft** minimal-signature-size scheme —
  **HKDF KeyGen** that reproduces the **EIP-2333** master-SK vector, CoreSign/Verify, aggregate +
  distinct-message AggregateVerify, **proof-of-possession**, FastAggregateVerify — with signature
  wire bytes matching a conformant library. (4) `bls_finalexp.ts`: the optimized **final
  exponentiation** (a Frobenius map with constants derived at load time from ξ, plus the
  Hayashida–Aranha addition chain), proven equal to **e(·)³** — a fixed, pairing-preserving cube —
  so it drops straight into the hot path (≈17× fewer F_p¹² muls; the self-test runtime fell even as
  it grew). (5) `groth16.ts`: a complete **Groth16 zk-SNARK** on the from-scratch pairing — R1CS →
  QAP via Lagrange interpolation, a transparent trusted setup, a three-element proof, and
  single-pairing-equation verification (honest proofs accept; wrong public input, tampered proof and
  forged witness all reject) over a worked x³+x+5 circuit. Two new lab pages (**Hash-to-Curve**,
  **Groth16 SNARK**); self-test grew 82 → **106/106** across **30 subsystems**. Every module verified
  in Node against the published vectors (the RFC 9380 / EIP-2333 outputs were generated from a trusted
  reference, then hand-transcribed into from-scratch code — no runtime dependency added, still zero
  crypto deps), and a headless-Chromium render check confirmed both new routes paint all-green with
  zero app JS errors. Lint + build green via verify-project.mjs.
