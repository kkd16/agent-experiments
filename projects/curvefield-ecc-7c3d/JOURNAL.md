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
- `goldilocks.ts` — the **STARK field** `p = 2⁶⁴ − 2³² + 1` (a 2³²-smooth power-of-two subgroup): field
  ops, a verified generator + roots of unity, a batch inverse, an in-place iterative **NTT/INTT**, and
  coset evaluation for the low-degree extension. The one field here not chosen to host a curve, but to
  host a fast Fourier transform.
- `merkle.ts` — a binary **Merkle tree** over rows of field elements on the lab's own SHA-256
  (authentication paths + verify). A STARK's *only* cryptographic assumption is this hash.
- `transcript.ts` — a running SHA-256 **Fiat–Shamir** transcript (field/int challenges) threaded
  through the STARK + FRI so prover and verifier agree on every coin.
- `fri.ts` — the **FRI** low-degree proximity test: commit each layer by Merkle root, fold in half with
  a transcript β, and re-open random positions to check each fold, collapsing a degree-<T claim to a
  constant. The engine that makes a STARK a proof.
- `stark.ts` — a from-scratch **STARK**: the AIR → LDE → constraint-quotient → **DEEP** out-of-domain →
  FRI pipeline, proving the Fibonacci-square execution `a_{n+2}=a_n²+a_{n+1}²` to a public output. No
  pairing, no trusted setup — transparent and plausibly post-quantum. A false output or a forged
  intermediate step is rejected live.
- `poseidon.ts` — an **algebraic hash** over Goldilocks: the Hades-strategy Poseidon permutation
  (R_F=8 full + R_P=22 partial rounds), an **x⁷ S-box** (7 is the smallest exponent coprime to p−1, so
  x↦x⁷ is a bijection), a **Cauchy MDS** diffusion matrix (Cauchy ⇒ MDS), and nothing-up-my-sleeve
  round constants from the lab's own SHA-256. A sponge `hash`, a 2-to-1 Merkle compressor, a
  256→256-bit `compress`, and a `permuteTrace` emitting one state per row. Unlike the bit-hashes here,
  its whole computation is already low-degree polynomial identities — so a STARK can prove it.
- `poseidon_stark.ts` — a from-scratch **STARK proving knowledge of a Poseidon preimage**: a genuine
  multi-column AIR (width 8, degree-7 constraints) where the round map becomes eight transition
  constraints (round constants + full/partial selector as public polynomials), and the sponge IV and
  public digest become boundary constraints. Proves *"I know m with Poseidon(m)=d"* via the same
  AIR → LDE → composition → DEEP → FRI pipeline as `stark.ts`, revealing nothing about m; a lying
  statement, a fudged round, and a mauled OOD value are all rejected live.
- `nova.ts` — a from-scratch **Nova folding scheme for IVC** (Kothapalli–Setty–Tzialla 2022), the
  modern engine of *incrementally verifiable computation*. **Relaxed R1CS** `(A·Z)∘(B·Z) = u·(C·Z)+E`
  — the shape closed under a random fold `Z = Z₁ + r·Z₂` so the quadratic's cross terms collapse into
  one computable term `T`; a **non-hiding Pedersen commitment** on the lab's BLS12-381 𝔾₁ (NUMS
  generators from hash-to-curve, additively homomorphic) so the verifier folds *committed* instances
  with a couple of curve additions and a scalar mul per commitment, never touching a witness; the
  **NIFS** prover/verifier (`crossTerm`/`foldProve`/`foldVerify`) and a Fiat–Shamir `NovaTranscript`
  over (𝔽_r, 𝔾₁); the canonical Nova step `z ↦ z³ + z + 5` as an R1CS; and an **IVC driver** that folds
  an N-step chain into ONE relaxed instance so a single relaxed-R1CS satisfaction check replaces N
  ordinary ones. No trusted setup, no pairings, no FFTs. Verified in `selftest.ts`: the cross-term
  identity holds at a random challenge, honest chains accept, and a corrupted witness, a forged
  cross-term, broken chaining, and an unsatisfiable step are each rejected.
- `nova_mimc.ts` — a **second IVC application on the same generic folding core**: a MiMC-style
  arithmetic permutation (Albrecht et al. 2016), R rounds of `x ↦ (x + cᵣ)³` — an S-box that is a
  permutation of 𝔽_r and costs just two multiplications per round — chained into a **sequential hash
  chain / verifiable-delay skeleton** `z_{i+1} = MiMC(z_i)`. `mimcR1CS` builds the `2R+1`-constraint
  step (nothing-up-my-sleeve round constants from the lab's own SHA-256), `mimcAssign` its witness,
  and `mimcStep(rounds)` packages it as a `StepFn` the IVC driver folds exactly like the cubic —
  proving the whole chain ran, with one final check, on a circuit the folding core never had to know
  about.
- `ecvrf.ts` — a from-scratch **ECVRF (RFC 9381)** verifiable random function on Edwards25519. Both
  standardised ciphersuites: `TAI` (try-and-increment hash-to-curve) and `ELL2` (the constant-time
  Elligator2 map + `expand_message_xmd`). `prove` produces β together with an 80-byte Fiat–Shamir
  proof π that `Γ = x·H` for the same `x` behind `Y = x·B`; `verify` re-derives H and checks the
  challenge closes; `proof_to_hash` extracts the 64-byte output β. Pinned **byte-for-byte** to the
  RFC's own Appendix B.3/B.4 test vectors (SK/PK/α from RFC 8032 §7.1). Reuses this lab's Ed25519
  group + SHA-512; exposes the Elligator2 hash-to-point that the ring module also uses.
- `ring.ts` — **linkable ring signatures & stealth addresses** (Monero's core), on the Ed25519 group.
  `SAG` (unlinkable AOS ring signature), `bLSAG` (Back's linkable SAG with a key image `I = x·Hₚ(P)`),
  and `CLSAG` (the concise scheme that folds an output-key ring and an amount-commitment ring into one
  aggregate LSAG via coefficients μ_P, μ_C — a single response scalar per member). Plus CryptoNote
  `stealth` one-time output keys (`P = H(r·A)·B + B_spend`, spent with `x = H(a·R) + b`). The linking
  image lets a ledger reject a double-spend without learning the signer. Hash-to-point is `ecvrf.ts`'s
  Elligator2 map; correctness/anonymity/linkability all checked live.
- `keccak.ts` — from-scratch **Keccak-f[1600]** and the **SHA-3 / SHAKE** family (FIPS 202): the
  θ/ρ/π/χ/ι permutation on 25 BigInt lanes (ρ offsets and π map generated from the canonical
  (x,y)←(y,2x+3y) walk so nothing is transcribed by hand), a streaming sponge, and `sha3_256`,
  `sha3_512`, `shake128`, `shake256`, plus a `shake128Xof` squeeze-stream. The lab's first non-SHA-2
  hash — everything lattice rests on it. Pinned to the FIPS 202 digests of `""`/`"abc"`.
- `mlkem.ts` — **ML-KEM** (FIPS 203, the standardised **CRYSTALS-Kyber**): the lab's first *lattice*
  scheme, resting on **Module-LWE** rather than a discrete log, so it survives Shor. The negacyclic
  **number-theoretic transform** over `Z₃₃₂₉[X]/(X²⁵⁶+1)` (zeta/gamma tables from bit-reversed powers
  of 17, base multiply pinned to a schoolbook convolution), centered-binomial noise, `Compress`/
  `Decompress` ciphertext coding, `ByteEncode`/`ByteDecode`, uniform matrix rejection sampling from a
  SHAKE128 XOF, the **K-PKE** IND-CPA core, and the **Fujisaki–Okamoto** transform (re-encrypt +
  implicit rejection) that lifts it to IND-CCA2. All three parameter sets (512/768/1024) with the
  exact FIPS 203 key/ciphertext byte-sizes.
- `hybridkem.ts` — **X25519MLKEM768**, the hybrid handshake TLS 1.3 actually deploys (IANA 0x11ec,
  default in Chrome / OpenSSL 3.5): a classical X25519 ECDH and an ML-KEM-768 encapsulation run side
  by side, their secrets concatenated `ss_mlkem ‖ ss_x25519`, so the session survives a break of
  either primitive. Both halves are the lab's own from-scratch code.
- `ot.ts` — **Oblivious transfer**, the atom of secure computation. The **Chou–Orlandi "simplest OT"**
  (Asiacrypt 2015) 1-of-2 on this lab's Ed25519 prime-order group: the sender publishes `S = y·B`, the
  receiver replies `R = x·B + c·S` for a private choice bit `c`, and the branch keys `H(y·(R − j·S))`
  agree with the receiver's `H(x·S)` only at `j = c` — so the sender never learns `c` and the receiver
  can open only the chosen ciphertext (a transcript-bound one-time pad). Plus a **batched** form (one
  reusable setup `S`, one OT per input bit) for the garbled-circuit evaluator, and a **1-of-N** OT built
  from ⌈log₂N⌉ base OTs (Naor–Pinkas bit-decomposition — the receiver learns only its chosen index).
- `circuit.ts` — a **boolean-circuit** builder and gadget library. Only `{AND, XOR, INV}` gates (the
  basis garbling is cheap on); everything else — OR, MUX, full/ripple adders, an MSB→LSB comparator, an
  equality test, and a schoolbook multiplier — compiles down to them. Named circuits for the demos
  (Millionaires' `a > b`, equality, sum, product, and a sealed-bid **second-price auction**) plus a
  plaintext reference evaluator for cross-checks.
- `garble.ts` — **Yao's garbled circuits** with the two headline optimizations: **free-XOR**
  (Kolesnikov–Schneider '08 — a global offset Δ makes XOR and NOT cost *zero* ciphertext) and
  **half-gates** (Zahur–Rosulek–Evans '15 — an AND costs exactly two 128-bit ciphertexts, the proven
  minimum), with **point-and-permute** select bits. Garble → evaluate → decode over 128-bit labels
  derived from the lab's own SHA-256. The half-gate formulas are verified from the inside (every gate's
  truth table, and whole circuits exhaustively) rather than transcribed on faith.
- `twopc.ts` — the whole **secure two-party computation** protocol assembled: Alice garbles and sends
  the encrypted tables + her own input labels; Bob fetches his input labels by **oblivious transfer**
  (learning nothing else, Alice learning none of his bits); Bob evaluates and decodes. Runs Yao's
  original **Millionaires' Problem** — who is richer, revealing nothing else — plus private equality,
  sum, product, and a sealed-bid **second-price auction** (learn the winner and price, not the bids),
  each with a transcript (OT count, AND count, garbled-table bytes) for auditing.
- `gmw.ts` — **GMW**, the *other* MPC paradigm: secret-sharing instead of garbling. Every wire value is
  kept XOR-shared between the two parties; XOR and NOT gates are purely local, and each AND gate is
  resolved by a single **1-of-4 oblivious transfer** (Bob tabulates `r ⊕ ((xᴬ⊕xᴮ)∧(yᴬ⊕yᴮ))` over
  Alice's four possible shares; she selects her row, so `cᴬ ⊕ cᴮ = x∧y`). Runs the *same* `circuit.ts`
  circuits as the garbled path and must reconstruct the identical output — the interaction-vs-table
  trade-off at the heart of practical MPC, shown side by side.
- `vdf.ts` — **Verifiable Delay Functions** in an RSA group: `y = x^(2^T) mod N` by T sequential
  squarings, the succinct **Wesolowski** proof (hash-to-prime ℓ, `π = x^⌊2^T/ℓ⌋`, streaming O(1)-memory
  prover) and the log-size **Pietrzak** halving proof, plus an RSW time-lock puzzle, a delay beacon, and
  continuous proof-carrying checkpoints.
- `classgroup.ts` — the **class group of an imaginary quadratic order** `Cl(Δ)`, from scratch on
  `BigInt`: binary quadratic forms `(a,b,c)` with `Δ = b² − 4ac < 0`, **Gauss reduction** (the ρ
  operator, coordinates bounded by `√(|Δ|/3)`), **Gauss composition** (Cohen Alg. 5.4.7), squaring,
  inverse, the principal form, `g^e` by square-and-multiply, trustless discriminant generation
  (`Δ = −p`, `p ≡ 3 mod 4`, hashed from a public seed), and a canonical prime-form generator. A group of
  genuinely **unknown order with no trusted setup** — validated against the group axioms on the full
  Cayley table of small discriminants and the known class numbers.
- `cgvdf.ts` — the **class-group VDF**: the Wesolowski proof-of-sequential-time over `Cl(Δ)` (the engine
  under Chia's consensus). `y = g^(2^T)` by T class-group squarings, `π = g^⌊2^T/ℓ⌋` verified by
  `π^ℓ ∘ g^r = y`, a streaming prover, and a no-trusted-setup delay beacon. Same shape as `vdf.ts` but
  with the trapdoor removed, because nobody knows `h(Δ)`.
- `sumcheck.ts` — the **sum-check protocol** from scratch over the Goldilocks field: multilinear
  extensions (a 2ⁿ table + `mleEval` by successive variable-folding), the `ẽq` Lagrange-basis
  polynomial, univariate round messages as evaluations at `0…deg` with Lagrange reconstruction, and a
  generic prover/verifier (`sumcheckProve`/`sumcheckVerify`) driven by a Fiat–Shamir `Transcript`, plus a
  product-of-multilinears helper. The verifier collapses an exponential `Σ_{x∈{0,1}ⁿ} g(x)` to one oracle
  evaluation and `n·deg` field work.
- `gkr.ts` — the **Goldwasser–Kalai–Rothblum** doubly-efficient interactive proof: a layered arithmetic
  circuit, its `evaluate`, the `addᵢ`/`mulᵢ` wiring-predicate MLEs (materialised as tables for the prover,
  summed from the sparse gate list for the verifier), and `gkrProve`/`gkrVerify` that reduce each layer's
  claim to the next by one sum-check fused with the **two-claim line-restriction** trick, bottoming out at
  the public input's MLE. The verifier certifies the whole circuit re-executing **zero** gates.
- `sumcheck_apps.ts` — the two canonical sum-check applications: **verified matrix multiplication**
  (`C̃(r,s) = Σ_x Ã(r,x)·B̃(x,s)`, Thaler §4.4 — check `C = A·B` from `O(log n)` interaction) and
  **triangle counting** (`Σ Ã(x,y)Ã(y,z)Ã(z,x) = 6·#triangles`, the adjacency MLE touched at three
  points), each with a live soundness demo.
- `elgamal.ts` — **exponential ElGamal** over secp256k1: the additively-homomorphic public-key
  encryption under every verifiable-voting system. Messages live in the *exponent* (`M = m·G`), so
  ciphertexts **add** — `Enc(m₁) ⊕ Enc(m₂) = Enc(m₁+m₂)` — letting a bulletin board tally encrypted
  ballots and decrypt only the *total*. Includes a **bounded baby-step giant-step** discrete log to
  recover a small tally from `m·G` (and to report an impossible total as `null`, not a silent wrap),
  and the ballot-validity NIZK: a **disjunctive Chaum–Pedersen** proof (CDS OR-transform, Fiat–Shamir)
  that a ciphertext encrypts **0 or 1** — the "no ballot-stuffing" guarantee — with its own domain tag.
- `voting.ts` — the **Helios / Belenios** end-to-end-verifiable election, assembled from the lab's own
  parts. A **Pedersen (joint-Feldman) DKG** splits the decryption key t-of-n across trustees so no
  authority can decrypt (reuses `shamir.ts`); each **1-of-k ballot** is k encrypted bits with a 0/1
  proof each *and* a Chaum–Pedersen proof the bits sum to exactly one; the **homomorphic tally**
  aggregates ciphertexts candidate-by-candidate; **threshold decryption** has each trustee publish a
  partial `Dᵢ = skᵢ·A` with a **DLEQ proof** (`sigma.ts`) and any t combine by *Lagrange in the
  exponent*. `verifyElection()` is the **universal verifier** — re-derives trustee keys from the public
  commitments, re-checks every ballot and decryption proof, recomputes the aggregate, and confirms each
  count explains its plaintext point, **trusting no one and touching no secret**. Tamper helpers drive
  the live soundness demos (ballot-stuffing, a dishonest trustee).
- `selftest.ts` — known-answer vectors + round-trips, run live on the Self-Test page
  (now **395/395** checks across 63 subsystems — added the Homomorphic Voting group: ElGamal
  homomorphism + bounded dlog, ballot-validity accept/reject incl. an encryption-of-2, DKG key
  consistency, a full 12-voter election matching the plaintext count, the t-of-n threshold, decryption
  DLEQ accept/reject, universal-verifier accept vs a stuffed board, and the Benaloh cast-or-audit
  challenge accepting an honest spoil vs catching a vote-swapping client).

UI is a hash-routed React app (`src/pages/`, `src/ui/`) — thirty-two labs plus an overview (the Secure-2PC
lab carries both the garbled-circuit and the GMW secret-sharing paradigms; the newest lab is
**Ballot — verifiable e-voting**).

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

### STARK — a transparent, hash-only, post-quantum proof (the odd one out)

The three existing proof systems all rest on an elliptic curve (and two on a trusted setup). A
STARK rests on **nothing but a collision-resistant hash** — no pairing, no toxic waste, no
discrete-log assumption — so it is transparent and plausibly post-quantum. Built as a fifth,
curve-free pillar of the ZK shelf.

- [x] **Goldilocks field** `p = 2⁶⁴ − 2³² + 1` (`goldilocks.ts`): add/sub/mul/inv/pow, a verified
      multiplicative **generator** (g=7, checked against the prime factorisation of p−1 =
      2³²·3·5·17·257·65537), primitive **roots of unity** for every power-of-two order up to 2³², a
      **batch inverse** (Montgomery's trick), an in-place iterative radix-2 **NTT/INTT**, and a
      **coset evaluation** for the low-degree extension.
- [x] **Merkle commitments** (`merkle.ts`): a binary tree over rows of field elements hashed with the
      lab's own SHA-256, authentication paths + verify — the *only* cryptographic assumption a STARK
      makes.
- [x] **Fiat–Shamir transcript** (`transcript.ts`): a running SHA-256 sponge threaded through the
      whole proof (constraint coefficients, the out-of-domain point, every FRI fold challenge and
      query index), turning the interactive protocol non-interactive.
- [x] **FRI low-degree test** (`fri.ts`): the random-fold prover + verifier over a Goldilocks coset
      domain — commit each layer by Merkle root, fold in half with a transcript challenge, and re-open
      a few random positions to check every fold is locally consistent, collapsing a degree-<T claim to
      a single constant. Honest low-degree codewords accept; a full-degree (random) codeword and any
      tampered layer/constant reject.
- [x] **STARK prover/verifier with DEEP-ALI** (`stark.ts`): the AIR → LDE → constraint-quotient →
      DEEP → FRI pipeline for a real execution — the **Fibonacci-square** recurrence
      `a_{n+2}=a_n²+a_{n+1}²` run for T steps to a public output. Two-column trace, linear + quadratic
      transition constraints and three boundary constraints, a random-combination composition
      polynomial, an **out-of-domain** point ζ whose constraint identity binds the trace to the
      committed CP, and a DEEP polynomial fed to FRI. Verified in the browser in milliseconds.
- [x] **Soundness, demonstrated live**: a false claimed output is rejected (the identity at ζ stops
      binding), and a **forged intermediate step** is rejected (a constraint quotient stops being a
      polynomial, so the composition is no longer low-degree and FRI catches it). Both mauled-proof
      paths (bad Merkle openings, mauled OOD values, tampered FRI codeword) reject.
- [x] New **STARK** lab page (Lab 25): the statement + trace table, the arithmetization/commitment
      roots, the constraint table, the DEEP out-of-domain values, a **FRI folding visualisation**
      (domain shrinking to a constant), the three-part verdict, a proof-size stat line, and the two
      soundness demos — wired into nav + Overview (Self-Test → 26).
- [x] **+11 self-test checks** (Goldilocks generator/root-of-unity/NTT round-trip; FRI
      honest-accept/random-reject/tamper-reject; STARK pinned-output/honest-verify/false-output-reject/
      forged-step-reject/mauled-OOD-reject); suite grew 131 → **142/142** across 35 subsystems.
### Post-quantum hash-based signatures (planned 2026-07-02, RFC 8391 / SPHINCS⁺)

The STARK proved the lab's *proofs* can rest on nothing but a collision-resistant hash. This
brings the same hash-only, plausibly-post-quantum assumption to **signing** — the one corner of
the lab that was still 100 % discrete-log / pairing. One idea (a hash chain) carried, exactly like
the group law was, from a signature you could verify with pencil and paper up to a **stateless**
scheme with the same shape as NIST's SLH-DSA (FIPS 205). No new dependencies: every byte flows
through the lab's own SHA-256, so the *only* assumption is the one the STARK already makes.

- [x] **Tweakable-hash substrate** (`hashaddr.ts`) — the RFC 8391 §2.5/§5.1 primitives on the lab's
      SHA-256: `toByte`, the 32-byte **ADRS** address (OTS / L-tree / hash-tree types with their
      field setters), and the four domain-separated hashes `F`/`H`/`H_msg`/`PRF` (`SHA256(toByte(t,32)
      ‖ KEY ‖ M)`), plus `PRF_keygen`. Standards-conformant by construction — SHA-256 is the only
      trust root, and it is already KAT-pinned to FIPS 180-4.
- [x] **Lamport OTS** (`lamport.ts`) — the pencil-and-paper starting point: a secret of `2·8n`
      random preimages, a public key of their hashes, sign one message by revealing the preimage
      selected by each message-digest bit. Signs **exactly once**; a second signature under one key
      leaks halves and is forgeable — demonstrated. The "draw it by hand" of the PQ world.
- [x] **WOTS⁺** (`wots.ts`, RFC 8391 §3) — the Winternitz collapse: `base_w`, the bitmasked hash
      `chain`, the length-2 **checksum** that stops a forger walking a chain forward, keygen-from-seed
      (`PRF_keygen`), `sign`, and `pkFromSig` (verify by finishing every chain to its top). `w`
      trades signature size against hash work (`len = ⌈8n/lg w⌉ + len₂`); the lab exposes the curve.
- [x] **XMSS** (`xmss.ts`, RFC 8391 §4) — a **Merkle tree of WOTS⁺ keys** turns 2^h one-time keys
      into one reusable public key: `RAND_HASH`, the **L-tree** that crushes `len` WOTS⁺ pk elements
      into a leaf, `treeHash`/authentication-path, stateful `sign` (a leaf index that must advance —
      **reuse is refused**), and `rootFromSig` verify. The Merkle root *is* the public key; a
      signature is a WOTS⁺ sig + an O(h) auth path.
- [x] **SPHINCS⁺ / SLH-DSA-shape stateless scheme** (`sphincs.ts`, FIPS 205 shape) — remove the
      state: a **FORS** few-time signature (`k` Merkle trees of `2^a` leaves, message-selected leaf
      per tree) signed by a **hypertree** (`d` layers of XMSS, each layer's root WOTS⁺-signed by the
      layer above). `H_msg` maps (R, PK, M) → a FORS index + tree/leaf address; a random `R = PRF_msg`
      makes it stateless. Scaled-down toy params in the lab, real FIPS-205 param names documented.
- [x] **`PQSignatures` lab page** — Lamport → WOTS⁺ → XMSS → SPHINCS⁺ in one pedagogical arc: live
      sign/verify with all-green verdict tags, a key/signature **size table** (bytes, and the famous
      "small keys, big signatures" tradeoff), a `w`/`h`/`d` control surface, the XMSS **authentication
      path** drawn to its root, the **one-time-key exhaustion** guard shown refusing reuse, and three
      **forgery demos** (Lamport double-sign, a walked WOTS⁺ chain caught by the checksum, a tampered
      auth path). Wired into nav + Overview; cards renumbered.
- [x] **Self-test battery** — SHA-anchored tweakable-hash KATs, the WOTS⁺ chain composition law
      (`chain(x,0,a)` then `chain(·,a,b) = chain(x,0,a+b)`), Lamport/WOTS⁺/XMSS/SPHINCS⁺ round-trips,
      forgery rejection for each, and the XMSS state-advance / no-reuse invariant.
- [x] **A Rescue/Poseidon algebraic hash** over Goldilocks and a STARK that proves a hash preimage
      (constraints over an arithmetic-friendly permutation instead of a toy recurrence) — `poseidon.ts`
      (x⁷ S-box, Cauchy MDS, NUMS SHA-256 constants, sponge + 2-to-1 compression) and
      `poseidon_stark.ts` (a width-8, degree-7 AIR proving *"I know m with Poseidon(m)=d"* via DEEP+FRI).
      New **Poseidon** lab (Lab 26); self-test 163 → **174/174**.
- [ ] **DEEP with two OOD points + a grinding/proof-of-work nonce** for tighter soundness at fewer
      queries, and a proof-size vs. security slider in the lab.
- [ ] **Batch/Merkle-cap FRI** and a Blake-style hash to shrink the query openings.

### Session 9 plan — an arithmetic hash and a STARK that proves you know a preimage

Every earlier STARK statement was a *toy* recurrence chosen for trivial constraints. Every earlier
hash was a *bit* function (SHA-256/512, RIPEMD-160) that a proof system loathes. This session builds
the missing bridge: an **arithmetic** hash whose entire computation is already low-degree polynomial
identities, and a STARK that proves knowledge of its **preimage** — closing the loop the whole ZK
shelf has been building toward (a STARK's only assumption is a hash; now it proves a preimage of one).

- [x] **`poseidon.ts`** — a Poseidon permutation over the Goldilocks STARK field: the Hades layout
      (R_F=8 full + R_P=22 partial rounds, laid out 4·full · 22·partial · 4·full), an **x⁷ S-box**
      (7 is the smallest exponent coprime to p−1, so x↦x⁷ is a bijection — the Plonky2/Risc0 choice),
      a **Cauchy MDS** diffusion matrix M[i][j]=1/(xᵢ−yⱼ) (Cauchy ⇒ MDS ⇒ the mix layer is a
      bijection), and **nothing-up-my-sleeve round constants** derived from the lab's *own* SHA-256, so
      there is nowhere to hide a trapdoor. On top: a sponge `hash`, a 2-to-1 Merkle `hashTwoToOne`, a
      `compress` (a 256→256-bit fixed-input hash), and a `permuteTrace` that emits one row per state.
- [x] **`poseidon_stark.ts`** — a genuine **multi-column AIR** (width t=8, unlike the two-column fib
      STARK): the trace is 32 rows × 8 lanes, one row per permutation state; eight **transition
      constraints** (one per lane) encode `colⱼ(g·x)=Σₖ MDS[j][k]·Yₖ`, with the round constants and the
      full/partial selector interpolated as **public polynomials** the verifier evaluates at ζ; and
      **boundary constraints** pin the capacity IV to 0 (row 0) and the rate lanes to the public digest
      (output row). The x⁷ S-box makes these ≈degree-248 constraints — an order of magnitude past the
      fib STARK's degree-2 ones — so the FRI degree bound (256) and LDE blowup are larger. Same
      AIR→LDE→composition→DEEP→FRI pipeline; a ~500 ms prove / ~175 ms verify at the default params.
- [x] **Soundness, three ways.** A prover who **lies about the statement** (claims a digest that is not
      the real hash) is rejected — the output-boundary quotient stops vanishing. A prover who **fudges
      one interior round** is rejected — a transition quotient stops being a polynomial, so the
      composition is no longer low degree and FRI catches it. A **mauled out-of-domain value** is
      rejected — the DEEP quotient at ζ no longer reproduces the committed codeword.
- [x] New **Poseidon** lab page (Lab 26): the construction (t/α/rounds/MDS stat line + a full/partial
      round-schedule strip), an editable secret preimage with its public digest, the permutation drawn
      round by round (the very table the STARK lays out as a trace), the arithmetization + commitment
      roots, the constraint table, the DEEP out-of-domain openings, the FRI folding visualisation, the
      verification verdict + proof-size stat line, and the two soundness demos. Wired into nav +
      Overview (cards renumbered 01–28: Poseidon 26, PQ Signatures 27, Self-Test 28).
- [x] **+11 self-test checks** (S-box=pow bijection, MDS invertibility, permutation + compression +
      2-to-1 pinned KATs, trace-length/consistency, and the preimage STARK's honest-accept +
      wrong-digest/forged-statement/fudged-round/mauled-OOD rejects); suite grew 163 → **174/174**
      across **37 subsystems**.

### Session 10 plan — verifiable randomness & anonymity (ECVRF + linkable ring signatures)

The shelf has signatures (ECDSA, Schnorr, BLS, EdDSA), threshold signing (FROST), and a deep ZK stack
(Bulletproofs, Groth16, PLONK, STARK). Two pillars of modern applied crypto were still missing: a way
to draw **public, unbiasable randomness** (VRFs — the beacon behind Algorand/Chainlink/Cardano and
DNSSEC's NSEC5), and a way to **sign anonymously yet catch double-spends** (linkable ring signatures —
Monero's core). This session adds both, each anchored to the strongest possible check: ECVRF to the
RFC's own byte-level vectors, ring signatures to their defining security properties.

- [x] **`ecvrf.ts` — ECVRF on Edwards25519 (RFC 9381), both ciphersuites.** `TAI` (try-and-increment
      hash-to-curve) and `ELL2` (constant-time Elligator2 + `expand_message_xmd(SHA-512, L=48)`).
      `prove` / `verify` / `proof_to_hash`, the §5.4.3 challenge (cLen=16), §5.4.2 nonce derivation,
      and the 80-byte proof `Γ‖c‖s`. Ported byte-exactly from Leo Reyzin's (an RFC co-author) reference.
- [x] **Pin the official RFC 9381 vectors.** All six Edwards25519 examples (Appendix B.3 TAI + B.4
      ELL2; SK/PK/α from RFC 8032 §7.1) reproduce the standard's **π byte-for-byte**, `verify` accepts,
      and a one-bit maul is rejected — checked live in the Self-Test (+30 checks).
- [x] **`ring.ts` — linkable ring signatures + stealth addresses.** `SAG` (unlinkable AOS), `bLSAG`
      (key image `I = x·Hₚ(P)`, links repeat-spends), `CLSAG` (aggregate output+commitment rings, one
      scalar per member via μ_P/μ_C), and CryptoNote `stealth` one-time keys — assembled into a full
      private payment. Property-checked live: correctness from every ring position, anonymity, key-image
      linkability vs non-linkability, tamper rejection, and stealth recover-vs-stranger (+14 checks).
- [x] **Two new lab pages.** `/vrf` (Lab 28): ciphersuite toggle, keygen, prove (β, Γ, c, s, π),
      verify with a live tamper switch, an RFC-vector loader that lights up when π matches, and a
      **verifiable leader-election lottery** (each player's β → a ticket; smallest wins; every draw
      publicly re-verifiable). `/ring` (Lab 29): the ring + signer picker, bLSAG/CLSAG sign+verify with
      a tamper switch, a **double-spend table** (same key → linked, other key → unlinked), and a
      four-step **stealth private-payment** flow. Both Node-verified before UI and headless-Chromium
      render-checked (all verdicts green, zero app JS errors).
- [x] Self-test grew 174 → **218/218** across **39 subsystems** (+30 ECVRF, +14 RingSig). Nav +
      Overview updated (cards renumbered: ECVRF 28, Ring Sigs 29, Self-Test 30). No new dependencies —
      still zero crypto deps.

Open follow-ups (next sessions):

- [ ] **ECVRF-P256-SHA256 (TAI + SSWU)** — add RFC 9381's NIST-P-256 ciphersuites once a P-256 curve
      lands in the lab, with their Appendix B.1/B.2 vectors.
- [ ] **VRF batch verification** and a multi-epoch beacon that chains β_{i+1} = VRF(sk, β_i).
- [ ] **ECVRF "full uniqueness" / key-validation mode** (the RFC's `validate_key` and cofactor checks)
      surfaced as a toggle, with a small-order-key attack demo that it defeats.
- [ ] **MLSAG** (the pre-CLSAG multi-input matrix ring signature) for the historical arc, and a
      **CLSAG over multiple real inputs** (a realistic multi-in/multi-out transaction).
- [ ] **Ring CT balance**: wire the CLSAG commitment ring to the lab's Pedersen/Bulletproofs range
      proofs so a whole confidential transaction (amounts hidden, balance proven, signer hidden,
      double-spend prevented) runs end to end.
- [ ] **bLSAG↔CLSAG size/《cost》comparison** panel (bytes and scalar-mult counts vs ring size).
- [ ] **Sub-address derivation** (Monero's `Hs(a‖i‖j)` scheme) on top of the stealth-address lab.
- [ ] **Fujisaki–Suzuki / traceable ring signatures** as an alternative linkability flavour.

### Session 11 plan — Sealed: the secure channel (X3DH + Double Ratchet, the Signal protocol)

Every lab here so far answers *authenticity* ("who signed this?") or *soundness* ("is this statement
true?"). Not one of them keeps a message **secret** — the engine had signatures, proofs, and key
agreement, but no *confidentiality* and no secure-channel protocol. That is the one missing dimension
of applied crypto, and it happens to be the most recognizable: the **Signal protocol** — the exact
end-to-end encryption behind WhatsApp, Signal, and Messenger's secret conversations. This session
composes the lab's existing X25519 + HKDF/HMAC-SHA256 with a from-scratch AEAD into a real secure
channel, anchored to the strongest checks available: RFC 8439 and RFC 5869 byte-level vectors for the
primitives, and the protocol's own security properties (forward secrecy, post-compromise security,
out-of-order delivery) for the composition.

- [x] **`chacha20.ts` — ChaCha20-Poly1305 AEAD (RFC 8439), from scratch.** The 20-round ARX block
      function (Uint32 quarter-rounds), counter-mode stream encryption, the Poly1305 one-time
      Wegman–Carter MAC (a single polynomial mod 2¹³⁰−5 on BigInt), and `AEAD_CHACHA20_POLY1305` with
      the §2.8 length-framed MAC-data and a constant-time tag compare. `seal`/`open` convenience wrappers.
      The lab's first symmetric cipher — the piece that actually hides a message.
- [x] **Pin the RFC 8439 vectors.** The §2.3.2 keystream block, §2.4.2 stream ciphertext, §2.5.2
      Poly1305 tag, and §2.8.2 AEAD tag all reproduce **byte-for-byte**; decrypt round-trips and a
      one-bit maul of the ciphertext / tag / associated data is rejected (checked live in Self-Test).
- [x] **`hkdf.ts` — HKDF-SHA256 (RFC 5869) as a first-class module.** Extract + expand + the combined
      one-shot, on the lab's own HMAC-SHA256. Pinned to RFC 5869 test cases 1 and 3 (including the
      zero-filled default salt). The KDF that turns a raw DH secret into namespaced sub-keys.
- [x] **`xeddsa.ts` — XEdDSA (Signal), from scratch.** The trick that lets a single X25519 (Montgomery)
      identity key *sign*: convert the key pair to the birationally equivalent twisted-Edwards pair,
      pin the public key's sign bit to 0 (so the verifier can rebuild it from just the u-coordinate),
      and sign with ordinary Ed25519 maths. The verifier reuses the lab's `ed25519Verify` unchanged —
      an XEdDSA signature *is* a valid Ed25519 signature under the derived key. Sign→verify, and
      tamper/wrong-key rejection, checked live.
- [x] **`x3dh.ts` — Extended Triple Diffie–Hellman (Signal), from scratch.** Prekey bundles (identity
      key, XEdDSA-signed prekey, one-time prekey), the initiator's 3–4 DH mix (`DH1=IK_A·SPK_B`,
      `DH2=EK_A·IK_B`, `DH3=EK_A·SPK_B`, `DH4=EK_A·OPK_B`), the curve25519 `F ‖ …` domain prefix, and
      `SK = HKDF(...)`. The responder recomputes the identical secret from his private keys. A tampered
      signed-prekey signature yields **no session** (verified before the DHs run).
- [x] **`doubleratchet.ts` — the Double Ratchet (Signal), from scratch.** The root KDF (`KDF_RK` via
      HKDF), the symmetric-key chain (`KDF_CK` via HMAC with 0x01/0x02 constants), per-message keys →
      (ChaCha20 key ‖ nonce), the **DH ratchet** (a fresh ephemeral reseeds the root on every direction
      change), and a **skipped-message-key store** (bounded by `MAX_SKIP`) for out-of-order and dropped
      messages. Headers are authenticated as AEAD associated data. `initAlice`/`initBob` bootstrap from
      the X3DH secret; `cloneState` snapshots for the UI.
- [x] **`signal.ts` — the full session + three demonstrations.** Participant/bundle creation, the
      initiator/responder handshakes, `encryptText`/`decryptText`, and three self-contained scenarios
      the UI and the Self-Test both replay: **out-of-order** delivery (3,1,2 still decrypts),
      **forward secrecy** (a used key is deleted — replaying a delivered message fails), and
      **post-compromise security** (a stolen full state reads the next message but is locked back out
      one round trip later, once a fresh ratchet key it never saw reseeds the root).
- [x] **`SealedPage.tsx` (Lab 24) — a live Alice⇄Bob encrypted chat.** The X3DH handshake laid out
      (Bob's bundle with a live prekey-signature verdict, Alice's ephemeral, the four DHs, the derived
      root secret), a conversation you drive (each bubble shows plaintext, header, ciphertext bytes,
      a "↻ DH ratchet" marker when the direction turns, and a decrypt/rejected verdict), a **forge**
      toggle that flips a ciphertext bit and shows the AEAD reject it, a **live ratchet-state** panel
      for both sides (root key, chain keys, Ns/Nr/PN, stashed skipped keys), and one-click runners for
      the three guarantees. Node-verified before UI and headless-render checked.
- [x] Self-test grew 218 → **241/241** (+23: ChaCha20 / Poly1305 / AEAD / HKDF / XEdDSA / X3DH /
      Ratchet). Nav + Overview + footer updated (Sealed slots into the free index 24, between PLONK and
      STARK). No new dependencies — still **zero crypto deps**.

Open follow-ups (next sessions):

- [ ] **Sesame / multi-device sessions** — one identity, several device sessions, and the
      session-management layer that fans a message out to each.
- [ ] **Header encryption** (the Double Ratchet's HE variant) — encrypt the header with a separate
      key chain so the ratchet public key and counters are hidden from a network observer.
- [ ] **Sealed sender** — Signal's metadata-hiding envelope (an ephemeral-key certificate so the
      server never learns the sender), on top of this channel.
- [ ] **A group protocol** — a sender-keys / MLS-style tree so N participants share a ratcheting group
      key, not just a pair.
- [ ] **AES-GCM as a second AEAD** (a from-scratch GF(2¹²⁸) GHASH) so the message layer is
      cipher-agile, with the NIST GCM test vectors.
- [ ] **A network-timeline view** — a draggable message queue so you can hold, reorder, and drop
      messages by hand and watch the skip store fill and drain.
- [ ] **Deniability demo** — show that either party could have forged the transcript (the shared-key
      symmetry that gives the protocol its off-the-record deniability).

### Session 12 plan — ML-KEM: the post-quantum lattice KEM (FIPS 203 / Kyber)

Every scheme in the lab so far dies to Shor: ECDH, ECDSA, Schnorr, the BLS pairing, the SNARKs —
all discrete-log or factoring, all quantum-broken. The one post-quantum family here, the hash-based
signatures (Lamport / WOTS⁺ / XMSS / SPHINCS⁺), only *signs*; nothing establishes a **secret key**
that a quantum adversary can't recover. This session adds the missing half: **ML-KEM**, NIST's
standardised lattice key-encapsulation mechanism, on the hard problem of Module-LWE. It's also the
lab's first scheme with no elliptic curve at all — a genuinely different rock to stand on.

Shipped:

- [x] **Keccak / SHA-3 (FIPS 202) from scratch** (`keccak.ts`) — Keccak-f[1600] (θ/ρ/π/χ/ι on 25
      BigInt lanes, ρ/π generated from the canonical lane walk), a streaming sponge, and
      SHA3-256/512 + SHAKE128/256 + a SHAKE128 XOF stream. Pinned to the FIPS 202 `""`/`"abc"` digests.
- [x] **The number-theoretic transform** over `Z₃₃₂₉[X]/(X²⁵⁶+1)` — forward/inverse NTT (Cooley–Tukey
      butterflies over bit-reversed powers of ζ=17), plus the degree-2 base multiply. Pinned two ways:
      `NTT⁻¹(NTT(f)) = f`, and the base multiply reproduces a schoolbook **negacyclic** convolution.
- [x] **Sampling & coding** — uniform matrix rejection sampling from a SHAKE128 XOF (`SampleNTT`),
      centered-binomial noise (`SamplePolyCBD_η`), `Compress`/`Decompress`, `ByteEncode`/`ByteDecode`.
- [x] **K-PKE** (the IND-CPA core: `t = A·s + e`, decrypt by cancelling `A·s` and rounding) and the
      **Fujisaki–Okamoto** transform (re-derive randomness from the message, re-encrypt, **implicit
      rejection** on mismatch) that lifts it to **IND-CCA2**.
- [x] **All three parameter sets** (ML-KEM-512/768/1024) with the **exact** FIPS 203 key/ciphertext
      byte-sizes (ek 800/1184/1568, ct 768/1088/1568, dk 1632/2400/3168), verified by full round-trips
      and by catching a mauled ciphertext (implicit rejection returns `J(z ‖ c)`, never the real key).
- [x] **X25519MLKEM768 hybrid handshake** (`hybridkem.ts`) — the exact TLS 1.3 construction, both
      halves from scratch: `concat(ss_mlkem, ss_x25519)`, breaking only if *both* primitives fall.
- [x] **A new lab page** (`MlKemPage.tsx`, route `/mlkem`) — parameter-set switch, the short-secret
      centered-binomial histogram, KeyGen / Encaps / Decaps walked byte by byte, a live
      implicit-rejection toggle, a size-comparison panel vs X25519, and the hybrid-handshake flow.
- [x] **Self-test** grew by 19 checks across 3 new groups (SHA-3, ML-KEM, Hybrid KEM) → **260/260**.

Next ideas (open):

- [x] **ML-DSA (FIPS 204, Dilithium)** — the lattice *signature* to pair with the KEM: power2round,
      decompose/high-bits/low-bits, the rejection-sampling signing loop, and the hint mechanism.
      *Shipped in Session 15 — see the plan block and session-log entry below.*
- [ ] **An official FIPS 203 ACVP known-answer vector** baked in for byte-level interop (currently the
      engine is pinned by round-trip + exact standard sizes + SHA-3 KATs, not an external ML-KEM KAT).
- [ ] **Decapsulation-failure probability** panel — dial the noise up and watch δ climb; the reason
      the parameters are what they are.
- [ ] **A Montgomery/Barrett-reduced NTT** and a constant-time compare, with a timing-leak demo,
      mirroring the side-channel story the ECDLP labs tell.
- [ ] **ML-KEM inside the Sealed channel** — replace (or hybridise) the X3DH root key with an ML-KEM
      encapsulation, giving the Signal lab a post-quantum handshake (the PQXDH direction Signal shipped).

### Session 13 plan — Secure two-party computation (oblivious transfer + Yao's garbled circuits)

Every module so far protects a *value* — a signature you can't forge, a ciphertext you can't read, a
proof that reveals nothing. None of them lets two mutually-distrustful parties **compute together on
inputs they never share**. That whole pillar — secure multiparty computation — was missing. This
session builds it from the ground up, the classic Yao two-party stack, on the lab's own Ed25519 group
and SHA-256, and pins it against a plaintext oracle before any UI.

- [x] **`ot.ts` — oblivious transfer.** The **Chou–Orlandi "simplest OT"** 1-of-2 on the Ed25519
      prime-order subgroup: sender `S = y·B`; receiver `R = x·B + c·S`; branch keys
      `k_j = H(S, R, y·R − j·y·S)` that equal the receiver's `H(x·S)` only at `j = c`. Messages are
      one-time-padded with a counter-mode SHA-256 stream keyed on a transcript-bound point, so the
      sender learns nothing about `c` and the receiver can open only its chosen branch. Plus a batched
      variant (shared setup `S`, one instance per bit) for the garbler.
- [x] **`circuit.ts` — a boolean-circuit compiler.** A tiny SSA-style builder over `{AND, XOR, INV}`,
      with derived OR / XNOR / MUX and gadgets: full adder, ripple-carry adder, an MSB→LSB unsigned
      comparator, an equality test, and a schoolbook multiplier. Named circuits (Millionaires', sum,
      equality, product) and a plaintext reference evaluator + bit↔int helpers for cross-checking.
- [x] **`garble.ts` — Yao's garbled circuits, modern.** Free-XOR (global offset Δ, lsb = 1) makes
      XOR/NOT free; half-gates (ZRE'15) make AND cost exactly two ciphertexts; point-and-permute picks
      the row from the label's colour bit. `garbleCircuit → evaluateCircuit → decode` over 128-bit
      labels from the lab's SHA-256, with the half-gate generator/evaluator formulas derived and then
      **verified from the inside** (every gate truth table; whole circuits exhaustively).
- [x] **`twopc.ts` — the full protocol.** Garble → send tables + Alice's labels → OT for each of Bob's
      input bits → evaluate → decode, wrapped as `runMillionaires` / `runEquality` / `runSum` /
      `runProduct`, each returning a transcript (OT count, AND count, garbled-table bytes) and an
      agreement flag against the plaintext computation.
- [x] **1-of-N oblivious transfer** (`otOneOfN`) — the Naor–Pinkas bit-decomposition: a key pair per
      index bit, each message padded by the XOR of the keys its bits select, and ⌈log₂N⌉ base 1-of-2 OTs
      that hand the receiver exactly its chosen index's keys. Self-verified exhaustively for N∈{2,3,4,5,8}.
- [x] **Sealed-bid second-price (Vickrey) auction** (`auctionCircuit` / `runAuction`) — a garbled
      comparator + per-bit multiplexer that reveals the winner and the price paid (min of the two bids)
      while hiding the bids themselves; the incentive-compatible auction as a 2PC.
- [x] **`MpcPage.tsx` — a new lab (`/mpc`).** Five live panels: an OT demo (pick two messages + a
      choice bit, watch only the chosen one open); the Millionaires' Problem on sliders with a full
      transcript; a garbled-gate anatomy view with a single-byte-tamper integrity demo; the same
      protocol swapped onto equality / sum / product; and the sealed-bid auction.
- [x] **+18 self-test checks** across three new groups (Oblivious Transfer, Garbled Circuits, 2PC) →
      **278/278** over 52 subsystems — OT branch correctness (incl. 1-of-N), every elementary gate's
      truth table, all three demo circuits garbled exactly over **all 4-bit input pairs**, full
      end-to-end 2PC runs, and the auction (win + tie).
- [x] **Verified in Node** via vite-lib bundle harnesses (17 + 7 assertions incl. exhaustive garble
      correctness, full 2PC over every 4-bit pair, 1-of-N OT, and the auction) *before* wiring the UI.
      Lint + build green via `verify-project.mjs`; zero new dependencies, still zero crypto deps.

- [ ] **OT extension (IKNP/KOS)** — bootstrap thousands of OTs from a handful of base OTs with a
      correlation-robust hash, the reason real MPC isn't public-key-bound per bit.
- [x] **GMW / secret-sharing MPC** as the second paradigm (gate-by-gate on XOR shares, AND via 1-of-4
      OT) — `gmw.ts`, running the same circuits as the garbled path and cross-checked to agree.
- [ ] **Malicious-secure garbling** — authenticated garbling / cut-and-choose, defeating a garbler who
      builds a wrong circuit (the tamper demo shows why the honest-but-curious model isn't enough).
- [ ] **A private-set-intersection** demo on top of OT — the canonical applied-MPC headline.

### Session 14 plan — GMW: secure computation the other way (secret sharing)

Garbled circuits are one of two great families of MPC; the lab had only that one. This short session
adds the other — **GMW** — so the Secure-2PC lab shows both mechanisms on the *same* circuits and proves
they agree. Where garbling encrypts whole truth tables and evaluates once, GMW keeps every wire
XOR-shared and works gate by gate: local XOR/NOT, and an AND resolved by a single oblivious transfer.

- [x] **`gmw.ts` — 2-party semi-honest GMW.** Wire values kept as XOR shares `[sᴬ, sᴮ]`; inputs shared
      so the other party's share is uniform; XOR/NOT local; **AND via a 1-of-4 OT** built on the merged
      `otOneOfN` (Bob tabulates `r ⊕ ((xᴬ⊕xᴮ)∧(yᴬ⊕yᴮ))` over Alice's four shares, she selects, giving
      `cᴬ ⊕ cᴮ = x∧y`); output reconstructed by XOR. Reuses the existing `circuit.ts` circuits verbatim.
- [x] **A sixth panel in `/mpc`** — runs the same Millionaires' comparator under GMW (on demand, since it
      does a real public-key OT per AND gate), reports the winner reconstructed from the shares, the
      AND-gate/OT count, and confirms it matches both the garbled-circuit and plaintext results.
- [x] **+6 self-test checks** in a new **MPC · GMW** group → **284/284** over 53 subsystems: every gate on
      shares, a 2-bit comparator exhaustively, a **cross-paradigm agreement** check (GMW = garbled), and a
      GMW private sum. Verified in Node (gates + 2-bit exhaustive + representative runs) before the UI.
- [ ] **n-party GMW** (shares split across k parties, pairwise OTs for each AND) and a Beaver-triple
      variant that pushes the OTs into a preprocessing phase.

### Session 15 plan — ML-DSA: the post-quantum lattice *signature* (FIPS 204 / Dilithium)

Session 12 gave the lab a quantum-safe way to **agree on a key** (ML-KEM); the only post-quantum
*signatures* here were the hash-based family (Lamport / WOTS⁺ / XMSS / SPHINCS⁺), which are large and
stateful-or-huge. The mainstream NIST signature standard is a **lattice** scheme on the same
Module-LWE/SIS rock as ML-KEM: **ML-DSA**, standardised from CRYSTALS-Dilithium. It is a genuinely
harder object than the KEM — a *Fiat–Shamir with aborts* identification scheme — so it exercises
rounding, rejection sampling, and a hint mechanism none of the other modules needed. This session
builds it from scratch on the lab's own Keccak, for all three parameter sets, and pins it in the live
self-test before any UI.

Shipped:

- [x] **`mldsa.ts` — the whole FIPS 204 engine from scratch** on the ring `Z₈₃₈₀₄₁₇[X]/(X²⁵⁶+1)`.
      Because `q ≡ 1 (mod 512)` the ring splits *completely*, so the NTT is a full 256-point radix-2
      transform and multiplication is 256 scalar products — pinned two ways (`NTT⁻¹∘NTT = id` and the
      pointwise product = a schoolbook **negacyclic** convolution), reusing the exact anchor the ML-KEM
      NTT uses. All coefficient math is plain `Number` (products stay under `q² < 2⁵³`).
- [x] **The rounding & hint machinery** — `Power2Round` (split off the low `d=13` bits), `Decompose` /
      `HighBits` / `LowBits` about `α = 2γ2`, and `MakeHint` / `UseHint`. Pinned by the two identities
      that make the verifier work: `r = r1·2¹³ + r0` with `|r0| ≤ 2¹²`, and
      `UseHint(MakeHint(z,r), r) = HighBits(r+z)` over thousands of random inputs at both γ2 values.
- [x] **The samplers** — `RejNTTPoly`/`ExpandA` (uniform matrix from SHAKE128), `RejBoundedPoly`/
      `ExpandS` (±η secrets from SHAKE256), `ExpandMask` (the masking vector `y`), and `SampleInBall`
      (the τ-sparse ±1 challenge, verified to have *exactly* τ signed units). Added a streaming
      `shake256Xof` to `keccak.ts` for the ball sampler's absorb-once / squeeze-on-demand pattern.
- [x] **Bit-packing to the byte** — `SimpleBitPack`/`BitPack` and the hint's position-list encoding,
      composed into `pkEncode`/`skEncode`/`sigEncode` and their decoders (the hint decoder *validates*:
      strictly-increasing positions, in-bounds, zero padding — a malformed hint is rejected, not trusted).
- [x] **KeyGen / Sign / Verify (Alg. 6/7/8)** with the final-standard domain separation
      (`ξ ‖ k ‖ l` into KeyGen's `H`), the **Fiat–Shamir-with-aborts** signing loop (retry until `‖z‖∞`,
      `‖r0‖∞`, `‖c·t0‖∞`, and the hint weight all pass), and the external `ctx`-string prefix. Signing
      is **deterministic** (rnd = 0) so the whole lab is reproducible.
- [x] **All three parameter sets** (ML-DSA-44/65/87) with the **exact** FIPS 204 Table-2 byte-sizes —
      pk 1312/1952/2592, sk 2560/4032/4896, sig 2420/3309/4627 — verified in the self-test alongside
      full sign→verify round-trips, tampered-message / mauled-signature / wrong-key rejection,
      deterministic-signing reproducibility, and context-string binding.
- [x] **A new lab page** (`MlDsaPage.tsx`, route `/mldsa`) — parameter-set switch, KeyGen with a
      byte-grid public key, a **Sign** panel that lays the Fiat–Shamir-with-aborts loop bare (live
      iteration count, the list of *why* each attempt was rejected, the τ-sparse ±1 challenge drawn as a
      256-cell strip, the response `z`'s near-uniform histogram), an editable message, a **Verify** panel
      with independent message-tamper and signature-maul toggles, and an Ed25519-vs-ML-DSA size chart.
- [x] **Self-test** grew by **30 checks** in a new `ML-DSA` group → **314/314**; lint + build + the exact
      CI gate all green; the page SSR-rendered clean before commit.

Next ideas (open):

- [ ] **An official FIPS 204 ACVP known-answer vector** baked in for byte-level interop (the engine is
      currently pinned by round-trips + exact standard sizes + the component identities, not an external
      ML-DSA KAT — the same honest position the ML-KEM module is in).
- [x] **The pre-hash variant HashML-DSA** (sign `H(M)` with the domain byte = 1 and the OID prefix) so
      large messages and the "sign a digest" interop mode are covered. *Shipped in Session 16.*
- [x] **The hedged (randomized) signing path** surfaced in the UI — a toggle between deterministic
      (rnd = 0) and a fresh 32-byte rnd, showing that both verify while the bytes differ. *Session 16.*
- [x] **An aborts histogram** — sign many messages and plot the distribution of rejection-loop
      iterations. *Shipped in Session 16 (a 40-message batch bucketed 1/2/3/4/5+ tries with the mean).*
- [ ] **ML-DSA vs SPHINCS⁺ vs Ed25519** — a head-to-head panel (sizes, signing cost, assumption) tying
      the three signature philosophies in the lab together.
- [ ] **A tiny Barrett/Montgomery-reduced NTT** and a constant-time norm check, mirroring the
      side-channel story the ECDLP labs tell.

### Session 17 plan — Verifiable Delay Functions (proof of sequential *time*)

The lab had verifiable *randomness* (ECVRF) and verifiable *computation* (Groth16 / PLONK / STARK),
but not verifiable **time** — the primitive that certifies real wall-clock sequential work was spent.
A VDF is the delay analogue of the VRF: where the VRF makes an output *unpredictable yet checkable*,
the VDF makes *elapsed sequential effort* **unforgeable yet checkable**. It is the missing rock under
an unbiasable randomness beacon (Chia's proof-of-time, Ethereum's planned RANDAO+VDF). This session
builds it from scratch in an RSA group of (publicly) known order — on purpose, so the trapdoor
shortcut and the time-lock puzzle can both be demonstrated — with **both** canonical proof systems and
pinned end-to-end in the live self-test before any UI.

Shipped:

- [x] **`vdf.ts` — the sequential core.** `evalVDF(x, T, N)` computes `y = x^(2^T) mod N` by T
      *sequential* squarings (the delay no parallelism can shorten), and `evalTrapdoor(x, T, N, φ)`
      reaches the same `y` in log-time via `e = 2^T mod φ(N)` — the shortcut whose mere existence is
      why a real VDF modulus must be a number nobody has factored. Fixed 512-bit **Blum** modulus
      `N = p·q` (p ≡ q ≡ 3 mod 4); statements use a QR generator `x = seed² mod N` (squaring lands in
      QR_N, where −1 has no root — the clean setting for the halving proof).
- [x] **Wesolowski proof (2019) — succinct, O(1).** A deterministic **hash-to-prime** (`hashToPrime`,
      backed by a fixed-witness Miller–Rabin) derives a ~128-bit Fiat–Shamir prime
      `ℓ = H(N ‖ x ‖ y ‖ T)` the prover cannot choose; then `2^T = q·ℓ + r`, `π = x^q`, and the
      verifier checks `π^ℓ · x^r = y` in a *single* exponentiation. Proof is one group element (64 B)
      whatever T is.
- [x] **Pietrzak proof (2019) — the halving protocol, O(log T).** Send the midpoint `μ = x^(2^(T/2))`;
      a Fiat–Shamir challenge folds `(x, y, T)` into `(x^r·μ, μ^r·y, T/2)`, a smaller claim true iff
      the original was; recurse to `y = x²`. The proof is `log₂T` midpoints; the prover pays only ~2×
      the evaluation (no giant-exponent division). Out-of-range/trivial midpoints are rejected.
- [x] **RSW time-lock puzzle (Rivest–Shamir–Wagner, 1996 — the LCS35 capsule).** `timeLock` uses the
      trapdoor to lock a message *instantly* (`key = a^(2^T)` via `2^T mod φ`); `timeUnlock` recovers it
      only by grinding the full squaring chain. Same delay, security flipped: here the wait *is* the
      lock. Keystream is SHA-256 counter-mode over the recovered group element.
- [x] **A delay-based randomness beacon.** `beaconChain` chains `βᵢ₊₁ = SHA256(VDF(βᵢ))`, each round
      carrying a Wesolowski proof — unpredictable until someone spends the delay, unbiasable because
      every candidate output costs the full T squarings (the RANDAO+VDF / Chia proof-of-time shape).
- [x] **A new lab page** (`VdfPage.tsx`, route `/vdf`) with six panels: the statement (seed → QR
      input, T = 2^t slider) with honest-grind-vs-trapdoor agreement; the Wesolowski proof with a live
      forge-the-π tamper toggle; the Pietrzak halving table with a flip-a-midpoint toggle; a proof-size
      trade-off chart (Wesolowski 1 elt vs Pietrzak log₂T elts); a **live** time-lock puzzle with an
      animated, chunked squaring grind and a progress bar (lock instant, open slow); and the beacon
      chain with per-round proof verdicts.
- [x] **Self-test** grew by **14 checks** across new **VDF / VDF · Wesolowski / VDF · Pietrzak /
      VDF · time-lock / VDF · beacon** groups — trapdoor = squaring-chain over many T, Wesolowski
      accept + reject (forged π, mauled y, wrong T) with ℓ shown prime, Pietrzak accept + reject
      (flipped midpoint, mauled y) with the right proof length, hash-to-prime determinism, the RSW
      round-trip (and wrong-work-factor failure), and a fully-verifying beacon chain. Verified in Node
      (62-assertion harness + the full in-app suite) before the UI; lint + build + the exact CI gate
      all green. Still **zero crypto dependencies**.

Next ideas (open):

- [x] **A class-group VDF** (imaginary quadratic order, binary quadratic forms) — the *trustless-setup*
      group with genuinely unknown order, so no trapdoor exists at all; contrast its form-composition
      cost against RSA squaring. *Shipped in Session 19 (`classgroup.ts` + `cgvdf.ts`, route `/cgvdf`).*
- [x] **Continuous / watermarked VDF output** — emit intermediate proof-carrying checkpoints so a
      verifier can confirm partial progress. *Shipped in Session 18 (`vdfCheckpoints`).*
- [x] **A streaming-prover Wesolowski** — the `π = x^⌊2^T/ℓ⌋` step done with the O(1)-memory
      quotient-bit accumulation, so the prover needs no giant `2^T` integer. *Shipped in Session 18
      (`wesolowskiProveStreaming`), pinned byte-identical to the reference for T up to 2^16.*
- [ ] **Off-thread grinding** via the lab's worker/task runner, with a real NPS/steps-per-second meter
      and an honest wall-clock estimate for large T.
- [ ] **A side-by-side "beacon race"** — two provers on different T, showing the delay orders their
      outputs and that a late joiner cannot front-run the draw.

### Session 19 plan — the Class-Group VDF: proof of sequential time with *no trusted setup*

The RSA-group VDF from Sessions 17–18 has a philosophical hole the module comments admit but the lab
never *closed*: whoever generates `N = p·q` knows `φ(N)` and can skip the delay, so its security rests
on a **trusted setup** (an RSA ceremony, or trust that the factors are lost). The fix that real systems
use — Chia's proof-of-time runs here — is to square in the **class group of an imaginary quadratic
order** `Cl(Δ)`: a finite abelian group whose order is the class number `h(Δ) ≈ √|Δ|`, computing it is
believed as hard as factoring, and `Δ` is a *public* number hashed from a seed. No ceremony, no
trapdoor, no trust. This session builds that group from scratch — a genuinely different algebraic
domain from every elliptic-curve module in the lab — and reruns the whole Wesolowski machine over it.

The correctness bar was set deliberately high: class-group composition is notoriously easy to get
subtly wrong, so the arithmetic was validated **exhaustively against the group axioms on the full
Cayley table** of small discriminants (a wrong `compose` cannot survive closure + associativity over
every triple) *and* against the known class numbers `h(−23)=3, h(−47)=5, h(−71)=7, h(−199)=9,
h(−3299)=27`, before any of it touched the VDF or the UI.

Shipped:

- [x] **`classgroup.ts` — binary quadratic forms as a group, from scratch on `BigInt`.** A form
      `(a, b, c)` is `f(x,y) = ax² + bxy + cy²` of discriminant `Δ = b² − 4ac < 0`. Implements:
      **normalisation + Gauss reduction** to the canonical representative (the ρ operator
      `(a,b,c) ↦ (c,−b,a)` iterated until `|b| ≤ a ≤ c`), keeping every coordinate below `√(|Δ|/3)`;
      **Gauss composition** (Cohen, *A Course in Comp. Alg. Number Theory*, Alg. 5.4.7) with its 3-way
      `gcd` and Bézout bookkeeping; **squaring**, **inverse** (the reflection `(a,−b,c)`), the
      **principal (identity) form**, and **`g^e` by square-and-multiply**.
- [x] **Trustless discriminant generation** (`generateDiscriminant`) — hash a public seed to a prime
      `p ≡ 3 (mod 4)` and take `Δ = −p`, so `Δ ≡ 1 (mod 4)` is a *fundamental* discriminant and `|Δ|`
      is prime. Anyone can reproduce and audit `Δ` from the seed; nothing up the sleeve, no order known
      to anyone. Plus a **canonical generator** (`primeForm`): the smallest odd prime form `(q, b, c)`
      with `(Δ|q) = 1`, `b² ≡ Δ (mod 4q)`, `b` odd.
- [x] **`cgvdf.ts` — the Wesolowski VDF over `Cl(Δ)`.** `evalVDF` = `T` sequential class-group
      squarings (`y = g^(2^T)`, the delay); `wesolowskiProve` sends the single form `π = g^⌊2^T/ℓ⌋` with
      `ℓ = H_prime(Δ ‖ g ‖ y ‖ T)`; `wesolowskiVerify` checks `π^ℓ ∘ g^r = y` in two class-group
      exponentiations, O(1) in T. The **streaming prover** (`wesolowskiProveStreaming`) rebuilds `π` in
      O(1) memory without ever forming the T-bit integer `2^T`, pinned form-identical to the reference.
      A **delay beacon** (`beaconChain`) chains `βᵢ₊₁ = SHA256(VDF(βᵢ))`, each round proof-carrying — a
      RANDAO+VDF beacon with no trusted setup underneath.
- [x] **A new lab page** (`ClassGroupVdfPage.tsx`, route `/cgvdf`) with seven panels: a **live seed → Δ**
      box (type any public seed, watch a fresh fundamental discriminant + generator get hashed out); the
      **group law** in action (`gⁱ ∘ gʲ = g^(i+j)` with two exponent sliders); the **delay** (T = 2^t
      slider, live `y = g^(2^T)`, and a verdict that `|a|` stays `≤ √(|Δ|/3)` across every step); the
      **Wesolowski proof** with a live forge-π tamper toggle; the **streaming prover** match; a
      **"where the trust lives"** RSA-group-vs-class-group comparison table (order, trapdoor, setup,
      element size, who can shortcut); and the **delay beacon** with per-round proof verdicts.
- [x] **Self-test** grew by **~27 checks** in a new **VDF · class group** group: the full-Cayley-table
      group axioms on five discriminants (`h` up to 27, matching the known class numbers), a
      256-bit-`Δ` sanity gate, the exponent law, Wesolowski accept + three rejections (forged π, mauled
      y, wrong T) at `T ∈ {8, 256, 1024}`, streaming = reference, the `√(|Δ|/3)` coordinate bound across
      200 squarings, a fully-verifying beacon, and a *second, independently-hashed* Δ end-to-end.
      Validated in Node (exhaustive axiom oracle + the in-app section) before the UI; lint + build + the
      exact CI gate all green. Still **zero crypto dependencies**.

Next ideas (open):

- [ ] **NUCOMP / NUDUPL** — the partial-reduction fast paths for composition and squaring (Jacobson–van
      der Poorten). Cohen composition + full reduction is already correct and, because reduction bounds
      coordinates, cheap; NUCOMP/NUDUPL cut the constant factor by reducing *during* the multiply. A
      natural cross-checked drop-in against the current `compose`/`square`.
- [ ] **Pietrzak in the class group** — the halving proof needs a low-order-free group; `Cl(Δ)` for a
      fundamental `Δ` has odd class number often enough, but the general fix (work in the group of
      squares, or Boneh–Bünz–Fisch's adjustments) is worth a panel contrasting it with Wesolowski.
- [ ] **A real class-number computation** for a *small* Δ (the analytic class number formula, or
      counting reduced forms) so the "order is √|Δ| and unknown at scale" claim is visceral — tiny Δ:
      compute h; big Δ: watch it become infeasible.
- [ ] **Larger Δ (≥ 1024-bit) off-thread** via the lab's worker, with an NPS meter, to show the
      class-group squaring cost honestly next to RSA squaring.
- [ ] **A class-group RSW time-lock** — lock a message to the future with *no* trapdoor holder at all
      (unlike the RSA capsule, which the creator can open instantly): here even the creator must grind.

### Session 20 plan — GKR & the sum-check protocol (the engine under modern SNARKs)

The proof-system shelf had Groth16, PLONK, Bulletproofs and a STARK — but it was missing the single most
important primitive in *modern* argument systems: the **sum-check protocol**. Every state-of-the-art
multilinear SNARK — Spartan, HyperPlonk, Lasso/Jolt — is, at its core, sum-check over cleverly chosen
multilinear polynomials. This session builds it from scratch over the lab's existing Goldilocks field,
then layers it into **GKR**, the 2008 Goldwasser–Kalai–Rothblum "doubly-efficient" interactive proof that
certifies a whole layered arithmetic circuit's output while the verifier re-executes *zero* gates.

The correctness bar: every construction was cross-checked in Node against a brute-force oracle *before*
any UI — the honest hypercube sum, the circuit's true output, the true matrix product, the true triangle
count — and each shipped with a live **soundness** demo (a forged sum, a forged product entry, an inflated
count, a tampered output wire) that the verifier must reject.

Shipped:

- [x] **`sumcheck.ts` — the sum-check protocol, from scratch.** Multilinear extensions represented as a
      `2ⁿ` table with `mleEval` by successive variable-folding (`foldFirst`), the `ẽq` Lagrange-basis
      polynomial, univariate round messages as evaluations at `0…deg` with `lagrangeAt` reconstruction,
      and a generic `sumcheckProve`/`sumcheckVerify` pair driven by the lab's Fiat–Shamir `Transcript`.
      The verifier checks `sⱼ(0)+sⱼ(1)=sⱼ₋₁(rⱼ₋₁)` each round and defers to a single oracle evaluation
      `g(r)` — `n·deg` field work instead of the `2ⁿ`-term sum. A `productClaim`/`productOracle` helper
      covers the canonical "prove the sum of a product of multilinears" demo.
- [x] **`gkr.ts` — the GKR doubly-efficient interactive proof.** A layered arithmetic circuit
      (`add`/`mul` gates, power-of-two layers), its `evaluate`, and the `addᵢ`/`mulᵢ` wiring-predicate
      MLEs — materialised as `(x,y)` tables for the prover, summed from the *sparse* gate list for the
      verifier. `gkrProve`/`gkrVerify` reduce each layer's claim `W̃ᵢ(z)` to the next by one sum-check over
      `addᵢ(z,x,y)(W̃(x)+W̃(y)) + mulᵢ(z,x,y)W̃(x)W̃(y)`, fuse the two residual claims `W̃ᵢ₊₁(b*)`,`W̃ᵢ₊₁(c*)`
      with the **line-restriction** trick (send `q(t)=W̃ᵢ₊₁(ℓ(t))`, sample `t*`, carry `ℓ(t*)` forward),
      and bottom out at the public input's MLE. The verifier evaluates **zero** gates; a work counter makes
      the asymmetry visceral (prover gate-ops vs verifier algebraic checks vs proof size).
- [x] **`sumcheck_apps.ts` — the two canonical applications.** *Verified matrix multiplication*
      (Thaler §4.4): pick random `r,s`, confirm `C̃(r,s) = Σ_x Ã(r,x)·B̃(x,s)` by one sum-check — the
      verifier binds `A`'s row / `B`'s column into boundary MLEs and never redoes the `O(n³)` product.
      *Triangle counting*: prove `Σ_{x,y,z} Ã(x,y)Ã(y,z)Ã(z,x) = 6·#triangles` with the adjacency MLE
      evaluated at just three points. Both derive challenges via the transcript, so a forged product entry
      or an inflated count shifts the challenges and is rejected.
- [x] **A new lab page** (`GkrPage.tsx`, route `/gkr`) with five panels: the **sum-check protocol** on a
      random product of multilinears (sliders for variables `n` and factors `k`, a round-by-round
      univariate table with the `s(0)+s(1)` check and each challenge, a *lying-prover* toggle that claims
      `H+1` and gets caught at round 1); **verified matrix multiplication** (seed-generated 4×4 `A`,`B`,
      live `C=A·B`, `C̃(r,s)` verdict, a *forge-C[1,1]* toggle); **triangle counting** (toggle the edges of
      a 4-vertex graph, live count, an *over-claim* toggle); the **GKR circuit** (eight editable inputs →
      eight mixed gates → four outputs, all layers shown); and **the proof** (per-run stat row — prover
      gate-ops, `0` verifier gate-ops, verifier checks, proof size — and a *forge-output* toggle).
- [x] **Self-test** grew by **14 checks** in a new **GKR · sum-check** group: MLE hypercube-corner
      interpolation, the honest sum vs a forged `H+1`, GKR accept + forged-wire reject on two independent
      inputs, verified-matmul accept + forged-entry reject, and triangle-count accept + inflated-count
      reject. Validated in Node via a `tsx` harness (14 + 11 assertions, incl. `K4` = 4 triangles) before
      the UI; lint + build + the exact CI gate all green. Still **zero crypto dependencies**.

Next ideas (open):

- [ ] **Zerocheck / the `ẽq`-multiplied sum-check** — prove a multilinear vanishes on the whole hypercube
      (`Σ ẽq(r,x)·f(x) = 0`), the workhorse reduction inside HyperPlonk; a natural next panel on top of the
      existing engine.
- [ ] **A multilinear polynomial commitment** (a Goldilocks-native FRI-based or a KZG-based one, reusing
      the STARK's FRI or the lab's KZG) so the GKR input claim is *committed* rather than public — turning
      the interactive proof into a real succinct argument (the Spartan / HyperPlonk shape).
- [ ] **Sum-check-based GKR for a non-trivial circuit** — a small SHA-256-style bit circuit or a matrix
      chain, with a depth/width slider, to show verifier work staying `O(D·polylog S)` as the prover's
      grows with `S`.
- [ ] **The Lasso/Jolt lookup argument** (`Σ` over a sparse indicator via sum-check) — the modern
      "just look it up" approach to circuits, sitting naturally beside the PLONK plookup backlog item.
- [ ] **Fiat–Shamir soundness lab** — a slider on the field size / round count showing the `≈ n·deg/|𝔽|`
      soundness error, and a *grinding* demo of why a small field is dangerous.

### Session 21 plan — Ballot: verifiable homomorphic e-voting (the capstone protocol)

Every shelf in this lab so far builds a *primitive*; this session wires a slate of them into the
protocol they were invented for. **Helios/Belenios verifiable voting** is the natural apex: it needs
homomorphic encryption (new), threshold cryptography (Shamir/Feldman — Session 5), and *three* kinds of
Σ-proof (Chaum–Pedersen DLEQ + a disjunctive OR-proof — Session 5's grammar, applied). The pitch is
that the lab can now demonstrate the property real elections are graded on — **universal verifiability**:
anyone recomputes the tally and checks it, trusting no authority. Steps:

- [x] **Exponential ElGamal** on secp256k1 (`elgamal.ts`): encode `m` as `m·G` so ciphertexts add; the
      homomorphic group law `⊕`, identity ciphertext, and single-key decryption to `m·G`.
- [x] **Bounded discrete log** (baby-step giant-step) to recover a small tally from `m·G` in `√range`
      steps, returning `null` for an out-of-range (malformed) total instead of wrapping.
- [x] **Ballot-validity proof** — a disjunctive Chaum–Pedersen (CDS OR-transform) that `(A,B)` encrypts
      `0` **or** `1`, Fiat–Shamir non-interactive, domain-separated from the plain Σ-protocols.
- [x] **Pedersen (joint-Feldman) DKG** (`voting.ts`): each trustee deals a Feldman-VSS secret; the
      election key `PK = Σ Cᵢ₀`, each key share `skⱼ = Σᵢ fᵢ(j)`, all Feldman-verified — no dealer ever
      holds `sk`.
- [x] **1-of-k ballots**: k encrypted bits, each with its 0/1 proof, plus a DLEQ that the bits sum to
      exactly one encrypted vote (the anti-over-vote guarantee).
- [x] **Homomorphic tally** — aggregate ciphertexts candidate-by-candidate; the sums encrypt the totals.
- [x] **Threshold decryption with proofs** — each trustee's `Dᵢ = skᵢ·A` + a DLEQ `log_G Yᵢ = log_A Dᵢ`;
      combine any t by Lagrange in the exponent; recover counts by the bounded dlog.
- [x] **Universal verifier** `verifyElection()` — re-derive trustee keys from the public commitments,
      re-check all ballot + decryption proofs, recompute the aggregate, confirm each count explains its
      point. A structured checklist the UI renders.
- [x] **Live soundness demos** — a ballot-stuffing toggle (encrypt a "2") and a dishonest-trustee toggle
      (corrupt a decryption share); the verifier names exactly which guarantee snapped.
- [x] New **`/voting`** page: DKG + trustee table, per-voter ballot picker, the public bulletin board with
      proof badges, homomorphic aggregate + quorum-selected threshold decryption, a decrypted-tally bar
      chart graded against the plaintext truth, and the universal-verifier checklist.
- [x] **18 new self-tests** in a `Homomorphic Voting` group (Node-validated end-to-end first, then the
      exact CI gate): homomorphism, bounded-dlog, ballot-validity accept/reject incl. an encryption-of-2,
      DKG consistency, a 12-voter election matching the plaintext count, the t-of-n threshold, decryption
      DLEQ accept/reject, and the universal verifier accepting an honest board vs rejecting a stuffed one.
- [ ] **Future:** a **mixnet** tally path (verifiable re-encryption shuffle with a Bayer–Groth or
      Terelius–Wikström proof) beside the homomorphic one, so write-in and ranked ballots — which don't
      aggregate homomorphically — are supported and provably permuted.
- [x] **cast-as-intended verification** — a Benaloh challenge / cast-or-audit (`sealBallot`/`auditBallot`
      + a `/voting` panel): spoil a ballot, reveal its openings, and recompute every ciphertext to prove
      the client encrypted the voter's intent; a vote-swapping client is caught. Cast ballots keep their
      openings secret, so privacy is untouched.
- [ ] **Future:** **distributed key *re*-sharing** (proactive refresh) so the trustee set can rotate
      between elections without changing `PK`.

### Session 22 plan — BBS anonymous credentials (selective disclosure on the pairing)

The lab has every *proof system* (Groth16, PLONK, Bulletproofs, STARK, GKR) and the whole
signature museum, but it was missing the one primitive the digital-identity world is actually
standardising on: a **multi-message signature the holder can present in zero knowledge**. BBS
(draft-irtf-cfrg-bbs-signatures) is exactly that — an issuer signs a *vector* of attributes once,
and the holder later proves possession of a valid signature while disclosing an arbitrary subset,
hiding the rest, and making every presentation unlinkable. It is the crypto under W3C Verifiable
Credentials, the ISO mobile driver's licence (mDL), and the EU Digital Identity Wallet, and it
reuses the lab's existing BLS12-381 pairing + hash-to-curve + Fiat–Shamir shelf perfectly. Steps:

- [x] **`bbs.ts`** — the whole scheme on the lab's own `bls12381.ts`, zero new deps: `createGenerators`
      (NUMS `P1`, `Q₁`, and one `Hᵢ` per attribute via RFC 9380 hash-to-curve — no known DL relation),
      `hashToScalar`/`messageToScalar` (expand_message_xmd → 𝔽_r), deterministic `bbsSign`
      (`A = (P1 + domain·Q₁ + Σ mᵢ·Hᵢ)/(sk+e)`, `e = H(sk, domain, msgs)`), and `bbsVerify`
      (`e(A, PK + e·P₂) = e(B, P₂)`, one `pairingProduct`).
- [x] **The zero-knowledge selective-disclosure proof**, derived in-file so every step is checkable:
      randomize `Ā = r·A`, `D̂ = r·B − e·Ā` (the pairing `e(Ā, PK) = e(D̂, P₂)` survives), then a
      Fiat–Shamir Σ-proof of `D̂ = r·C − e·Ā + Σ uⱼ·Hⱼ` over the *undisclosed* attributes, with
      `C` the verifier-recomputable disclosed part of `B`. Soundness: the pairing forces `D̂ = sk·Ā`;
      substituting and dividing by `r≠0` extracts a genuine signature over the disclosed attributes.
- [x] **Presentation-header binding** (`ph`, a verifier nonce) folded into the challenge so a proof
      can't be replayed to another session, and a **high-level credential API**
      (`issueCredential`/`presentCredential`/`verifyPresentation`) that reads like the mDL use case.
- [x] New **`/bbs`** page: an interactive mobile driver's licence with per-attribute disclose/hide
      toggles, the live ZK presentation (Ā, D̂, challenge, hidden-response count, verdict), an editable
      presentation header, a soundness panel (lie / replay / tamper all rejected live), and an
      **unlinkability** panel showing two presentations of the same credential share no group element.
- [x] **15 new self-tests** in a `BBS · anonymous credentials` group (Node-validated end-to-end via a
      vite-lib bundle first, then the exact CI gate): sign/verify, determinism, tamper/wrong-key/mauled-e
      rejection, selective disclosure (reveal 2 of 6), the blinded-response count, the full soundness
      battery (lied disclosed value, replay, wrong issuer, tampered Ā, tampered response), zero- and
      full-disclosure degenerate cases, and unlinkability. Self-test now **410/410 across 64 groups**.
- [x] **Blind issuance** — the holder commits to hidden attributes (a link secret + a private id) and
      proves the opening in ZK; the issuer checks the proof and completes `A` from the commitment,
      signing a credential it never fully saw. The result is an ordinary BBS signature over the full
      vector, so the hidden slots present exactly like the rest — the AnonCreds / mDL holder-binding
      story. `blindCommit` / `verifyBlindRequest` / `blindSign` in `bbs.ts`, a `/bbs` panel ⑤, and 6
      more self-tests (BBS group now 21, suite **416/416 across 64 groups**).
- [ ] **Future:** **predicates on attributes** — bolt the lab's Bulletproofs range proof onto a hidden
      attribute so the holder can prove `age ≥ 21` from a hidden *date of birth*, not a pre-baked flag.
- [ ] **Future:** **revocation** — a cryptographic accumulator (RSA or pairing-based) membership witness
      proven in ZK alongside the presentation, so a revoked credential stops verifying without a
      per-holder revocation list.
- [ ] **Future:** **pseudonyms** — a per-verifier `nym = H(ctx)^link_secret` proven equal to the hidden
      link secret, giving *unlinkable across verifiers* but *linkable within one verifier* (rate-limiting
      / one-vote-per-person without deanonymising).
- [ ] **Future:** pin to the **IRTF draft's exact `create_generators` + serialization** so the
      fixtures match the published BBS test vectors byte-for-byte (this build is the same construction
      with the lab's own domain-separated generators, internally gradchecked rather than vector-pinned).

### Session 23 plan — Nova: a folding scheme for IVC (the proof-system trilogy's third leg)

The proof-system shelf had the *pairing* SNARKs (Groth16, PLONK), the *hash-only* transparent one
(STARK), the *IPA* one (Bulletproofs), and the interactive-proof engine (GKR/sum-check) — but it was
missing the idea that reshaped the whole field after 2019: **folding / accumulation**. Nova
(Kothapalli–Setty–Tzialla, 2022) proves that a step function `F` was applied `N` times (a hash chain,
a VM's fetch/execute loop, a rollup's blocks) *without ever building an N-sized proof* — each step
emits an ordinary R1CS instance, and instead of proving it we **fold** it into a running accumulator
with one random linear combination. It is the engine under Nova/SuperNova/HyperNova and modern zkVMs.
It's also a beautiful fit for this lab: it needs only an additively-homomorphic commitment, which the
existing BLS12-381 𝔾₁ already gives, and reuses the R1CS shape from the Groth16 module. Steps:

- [x] **`nova.ts` — relaxed R1CS.** The shape `(A·Z)∘(B·Z) = u·(C·Z) + E` with assignment
      `Z = [u | x | W]`; a `matVec` over 𝔽_r; `relaxedSatisfied` that checks both the constraint rows
      *and* that the two commitments open. An ordinary instance embeds as `u = 1, E = 0`
      (`strictInstance`); the accumulator starts from the trivially-satisfied zero instance
      (`trivialInstance`, `u = 0, E = 0`).
- [x] **A non-hiding Pedersen vector commitment on 𝔾₁.** `Commit(v) = Σ vᵢ·Gᵢ` over NUMS generators
      derived by hash-to-curve (`genVec`), additively homomorphic so `Commit(a) + [r]·Commit(b) =
      Commit(a + r·b)` — exactly the property the verifier needs. (Binding is what folding requires;
      hiding for zero-knowledge is an orthogonal add-on, noted in the UI.)
- [x] **The NIFS folding scheme.** `crossTerm` computes `T = (A·Z₁)∘(B·Z₂) + (A·Z₂)∘(B·Z₁) −
      u₁·(C·Z₂) − u₂·(C·Z₁)`, the exact degree-1 coefficient of the folded quadratic; `foldInstance`
      folds the *committed* instances with `commE = commE₁ + r·commT + r²·commE₂`, `u`, `x`, and
      `commW` (a couple of 𝔾₁ adds + a scalar mul each, no witness); `foldWitness` folds `E` and `W`.
- [x] **A Fiat–Shamir `NovaTranscript` over (𝔽_r, 𝔾₁)** — absorbs points (48-byte coords) and field
      elements, squeezes a challenge `r ∈ 𝔽_r`, so `foldProve` and `foldVerify` derive the identical
      coin and a cheating prover can't pick commitments after seeing `r`.
- [x] **The canonical Nova step `F(z) = z³ + z + 5` as an R1CS** (`stepR1CS`/`stepAssign`/`stepEval`),
      public IO `x = [z_in, z_out]` threading one step's output into the next's input.
- [x] **An IVC driver** (`ivcProve`/`ivcVerify`) that folds an N-step chain into ONE relaxed instance
      and verifies with a *single* relaxed-R1CS satisfaction check in place of N ordinary ones — plus
      the public-IO chaining check `z₀ → z₁ → … → z_N` that full Nova folds into the circuit.
- [x] New **`/nova`** page: a step/z₀ slider, the live chain, the relaxed-R1CS constraints, a per-fold
      table (Fiat–Shamir `r`, cross-term commitment, running `u`, accumulator `W̄`), the succinctness
      contrast (`N·n` naïve checks vs `1`), and a fault injector that rejects a corrupted witness, a
      forged cross-term, and broken chaining live.
- [x] **11 new self-tests** in a `Nova (folding IVC)` group (Node-validated end-to-end via a rolldown
      bundle first — 18-assertion engine harness — then the full shipping `runSelfTest()`): strict-step
      satisfaction, the fold-completeness property, verifier/prover challenge agreement, the cross-term
      identity at a random `r`, the 6-step IVC round-trip vs. direct iteration, and a four-way soundness
      battery (tampered witness, forged cross-term, broken chaining, unsatisfiable step).
- [x] **A second IVC application, `nova_mimc.ts`** — proving the folding core is genuinely generic,
      not hardwired to the cubic. Refactored the driver into `ivcProveWith(params, step, z0, N)` over a
      `StepFn` abstraction (`ivcProve` is now the cubic wrapper; `ivcVerify` was already generic). Added
      a **MiMC permutation** (R rounds of `x ↦ (x+c)³`, two mults each) chained into a sequential hash —
      `mimcR1CS`/`mimcAssign`/`mimcStep`. The `/nova` page gained an **application selector** (cubic vs.
      MiMC hash chain), the relaxed-R1CS panel adapts to the chosen circuit, and 5 more self-tests fold
      an 8-step MiMC chain and reject a tampered MiMC witness. Nova group **11 → 16**, suite
      **416 → 432/432 across 65 groups**.
- [ ] **Future:** make the commitment **hiding** (blinding factors that also fold) so the folded
      instance is zero-knowledge, not just succinct.
- [ ] **Future:** a **generic R1CS gadget builder** (a linear-combination DSL) so any circuit can be
      folded without hand-writing its matrices, e.g. a full Poseidon round chain (MiMC is currently
      hand-emitted, like the cubic).
- [ ] **Future:** **SuperNova** (a per-step branch selector so a VM's different opcodes fold into one
      accumulator) and the in-circuit folding verifier over a **2-cycle of curves** (real recursive IVC).
- [ ] **Future:** **CycleFold / HyperNova** — fold higher-degree (CCS) constraints, or compress the
      final relaxed instance with one of the lab's existing SNARKs (Spartan-style) instead of opening it.

### Session 24 plan — SLH-DSA (FIPS 205): the toy SPHINCS⁺ becomes the standard

The `/pqsig` lab walks Lamport → WOTS⁺ → XMSS → a *toy* SPHINCS⁺, but that toy is a teaching sketch
(RFC-8391 hashing, full 32-byte output, tiny `SPHINCS_TOY` params) — not the scheme NIST actually
standardised. ML-KEM and ML-DSA each earned a *standards-grade, vector-pinned* lab; the hash-based
signature deserves the same. Build the real **SLH-DSA (FIPS 205)** for the SHA-2 category-1 sets,
byte-exact and pinned to NIST's own ACVP vectors, sitting beside ML-DSA as the conservative
(hash-only) post-quantum signature.

- [x] `slhdsa.ts`: the FIPS-205 `Adrs` (correct field layout) + the **22-byte ADRSc** compression.
- [x] the SHA-2 tweakable-hash family `F/H/T/PRF/PRF_msg/H_msg` (§11.2.1), incl. **MGF1-SHA-256** for `H_msg`.
- [x] **WOTS⁺** (base-2ᵂ digits + len₂ checksum), **XMSS** (Merkle of WOTS⁺ + auth paths).
- [x] the **d-layer hypertree** and **FORS** (stateless few-time signature, R-chosen leaf).
- [x] `slh_sign`/`slh_verify` with the §10.2 pure context wrapper, deterministic + hedged modes.
- [x] byte-exact key/signature packing for **-128f** and **-128s** (pk 32 B, sig 17088 / 7856 B).
- [x] pin **keyGen** (seeds → PK.root) and **sigGen** (SHA-256 of the deterministic signature) to NIST ACVP.
- [x] a `/slhdsa` page: the stack, param-set table, live sign/verify + tamper, FORS/hypertree views,
      a hash-cost readout, a live NIST-conformance panel, and an SLH-DSA-vs-ML-DSA comparison.
- [x] a `SLH-DSA` self-test group (both keyGen KATs + the -128f sigGen KAT + verify/tamper/ctx).
- [ ] follow-up: the category-3/5 sets (SHA-512 for `H`/`T`, larger n) and the SHAKE instantiation.
- [ ] follow-up: **HashSLH-DSA** (the FIPS 205 pre-hash mode) and a Merkle-signatures interop note.
- [ ] follow-up: a Web-Worker path so -128s signing streams progress instead of running deferred.

### Session 25 plan — the symmetric layer: AES and the authenticated modes

For a lab that reaches from the ECDLP to post-quantum lattices and STARKs, one hole stood out: it
had exactly one symmetric cipher (ChaCha20-Poly1305) and **no AES** — the standard the rest of the
world actually runs on (TLS 1.3, SSH, IPsec, WPA2/3, disk encryption, every AES-NI core). This
session builds AES from the GF(2⁸) field up and the authenticated modes that ride on it, each pinned
byte-for-byte to its FIPS / NIST / RFC vectors, then wires the result back into the existing Signal
channel so the Double Ratchet becomes cipher-agnostic.

- [x] **`aes.ts`** — AES-128/192/256 (FIPS-197) from scratch: a GF(2⁸) log/exp table over the
      generator 0x03, the S-box **computed** as the multiplicative inverse composed with the affine
      map (not a copied table), the key schedule (RotWord/SubWord/Rcon for all three key sizes), the
      four round transformations + their inverses, block encrypt/decrypt, an instrumented
      `traceEncrypt` that records every intermediate state, and AES-CTR. Pinned to FIPS-197
      Appendices B (round-by-round) and C.1/C.2/C.3.
- [x] **`gcm.ts`** — AES-GCM (NIST SP 800-38D): the GF(2¹²⁸) GHASH multiply implemented from the
      bit up (the spec's right-shift + reduction), GCTR, the J0 pre-counter (96-bit and GHASH-based
      paths), `gcmEncrypt`/`gcmDecrypt`, GMAC, and seal/open. Pinned to the McGrew–Viega test cases
      1–5.
- [x] **`cmac.ts`** — AES-CMAC (NIST SP 800-38B / RFC 4493): the K1/K2 subkey derivation and the
      10*-padding rule that closes CBC-MAC's length-extension hole. Pinned to the RFC 4493 vectors.
- [x] **`gcmsiv.ts`** — AES-GCM-SIV (RFC 8452), nonce-misuse-resistant AEAD: POLYVAL implemented
      directly as dot(a,b) = a·b·x⁻¹²⁸ via a Montgomery reduction in the little-endian field,
      DeriveKeys, the synthetic-IV tag, and the LE-32 counter. DeriveKeys + the empty-message result
      match RFC 8452 Appendix C.1; POLYVAL cross-checked against the field axioms.
- [x] wire **AES-256-GCM into the Double Ratchet** as an interchangeable `AeadSuite` (Signal ships
      ChaCha20-Poly1305; AES-256-GCM is TLS 1.3's cipher) — the message-key KDF already emits a
      32-byte key + 12-byte nonce, so the record layer is cipher-parameterised with no other change.
- [x] a `/aesgcm` **AES & GCM** lab page: a scrubbable round-by-round state-matrix visualiser (all
      three key sizes), the AES-GCM AEAD with a live GHASH accumulator table + tamper toggle, the
      **nonce-reuse cliff** (GCM leaks P₁⊕P₂ from C₁⊕C₂ while GCM-SIV survives, side by side on the
      same AES core), and an AES-CMAC panel.
- [x] a cipher-suite toggle on the **Sealed** page so the whole X3DH + Double Ratchet chat runs over
      the from-scratch AES-256-GCM, every guarantee intact.
- [x] an **AES / AES-GCM / AES-GMAC / AES-CMAC / AES-GCM-SIV** self-test group (FIPS-197 all sizes +
      the Appendix B trace, NIST GCM cases 1–5, RFC 4493, RFC 8452, POLYVAL field axioms, round-trips,
      tamper rejection, and the ratchet running over both suites).
- [ ] follow-up: **AES-CCM** (RFC 3610, the WPA2 / Bluetooth-LE AEAD) — CTR + CBC-MAC with the B0/flags
      formatting — as a second block-cipher AEAD beside GCM.
- [x] follow-up: **AES-SIV** (RFC 5297, the CMAC-based deterministic AEAD) to sit beside GCM-SIV and
      contrast the two misuse-resistant constructions — `aessiv.ts` (S2V + dbl/xorend, the double-length
      key, V‖C wire format), pinned to the RFC 5297 Appendix A.1 vector, with a lab panel.
- [ ] follow-up: **AES-KW / AES-KWP** (RFC 3394 key wrap) for wrapping the ratchet/prekey material.
- [ ] follow-up: a **CBC + PKCS#7 padding-oracle** attack demo — decrypt a ciphertext with only a
      valid/invalid-padding oracle, the classic teaching attack, next to the authenticated modes that
      defeat it.
- [ ] follow-up: a **GHASH forgery under nonce reuse** demo — recover the authentication key H from two
      messages sharing a nonce and forge a third, the concrete attack behind the GCM-SIV motivation.
- [ ] follow-up: a **constant-time note / cache-timing caveat** panel — the table-driven S-box is not
      constant-time; show the bitsliced idea and why AES-NI exists.
- [ ] follow-up: a **Web-Worker** path so bulk AES-GCM throughput (a large file) streams progress.

## Session log

- 2026-07-09 (claude): **The symmetric layer — AES and the authenticated modes, from scratch and
  pinned to the standards' vectors.** The lab reached from the ECDLP to lattices, STARKs and Nova but
  had exactly one symmetric cipher (ChaCha20-Poly1305) and, conspicuously, **no AES** — the primitive
  the internet actually runs on. This session fills that hole and builds the real AEAD stack on top.
  Five new engine modules, zero new dependencies, still zero crypto deps. (1) `aes.ts`: AES-128/192/256
  (FIPS-197) with the S-box **computed** from the GF(2⁸) multiplicative inverse + affine map (log/exp
  tables over the generator 0x03 — nothing tabled), the full key schedule, the four round steps and
  their inverses, block encrypt/decrypt, an instrumented `traceEncrypt` recording every intermediate
  state, and AES-CTR — matched byte-for-byte to FIPS-197 Appendix B (the round-by-round SubBytes /
  MixColumns states) and Appendix C.1/C.2/C.3. (2) `gcm.ts`: AES-GCM (NIST SP 800-38D) with the
  GF(2¹²⁸) GHASH multiply built from the bit up (the spec's right-shift + 0xe1 reduction), GCTR, both
  J0 paths (96-bit and GHASH-derived), GMAC and seal/open — matched to the McGrew–Viega test cases 1–5
  including the non-96-bit-IV case. (3) `cmac.ts`: AES-CMAC (RFC 4493) with the K1/K2 subkey shift that
  closes CBC-MAC — matched to the RFC vectors (empty, one-block, 40-byte). (4) `gcmsiv.ts`: AES-GCM-SIV
  (RFC 8452), the nonce-misuse-resistant AEAD — POLYVAL implemented directly as dot(a,b)=a·b·x⁻¹²⁸ via a
  Montgomery reduction in the little-endian field, DeriveKeys, the synthetic-IV tag, LE-32 counter;
  DeriveKeys' auth key and the empty-message result reproduce RFC 8452 Appendix C.1, and POLYVAL is
  cross-checked against the field axioms (identity x¹²⁸ mod M, commutativity, distributivity). (5)
  `aessiv.ts`: AES-SIV (RFC 5297), the *other* misuse-resistant AEAD — CMAC-based rather than
  polynomial-hash-based — with S2V (dbl + xorend over the CMAC-of-zero seed), the double-length key, and
  the V‖ciphertext wire format, matched byte-for-byte to the RFC 5297 Appendix A.1 vector; it sits beside
  GCM-SIV so the two constructions of deterministic AEAD can be contrasted. The
  Double Ratchet is now cipher-agnostic: `AeadSuite` (`CHACHA20_POLY1305` | `AES_256_GCM`) threads
  through `signal.ts`, so a full X3DH + ratchet conversation runs over the from-scratch AES-256-GCM with
  every guarantee intact — exercised by `runSuiteRoundTrip`. One new lab page (**AES & GCM**,
  `/aesgcm`): a scrubbable round-by-round 4×4 state-matrix visualiser for all three key sizes, the
  AES-GCM AEAD with a live GHASH accumulator table and tamper toggle, the **nonce-reuse cliff** (two
  messages under one nonce — GCM's C₁⊕C₂ equals P₁⊕P₂, a total break, while GCM-SIV stays safe, side by
  side on the same core), and an AES-CMAC panel; plus a cipher-suite toggle on the **Sealed** page to
  run the live chat over AES-256-GCM. Self-test grew by a large **AES / AES-GCM / AES-GMAC / AES-CMAC /
  AES-GCM-SIV / AES-SIV** group (FIPS-197 all sizes + the Appendix B trace, NIST GCM cases 1–5, RFC 4493,
  RFC 8452, RFC 5297, POLYVAL axioms, round-trips, tamper rejection, and the ratchet over both suites). Every module
  verified in Node against its published vectors before any UI, via a type-stripping ESM harness. Lint +
  build green via verify-project.mjs.
- 2026-07-05 (claude): **SLH-DSA (FIPS 205) — the *standardised* stateless hash-based signature, from
  scratch and pinned to NIST's own vectors.** The lab already carried a *toy* SPHINCS⁺ (`sphincs.ts`,
  an RFC-8391-flavoured construction on the full 32-byte SHA-256 output, `SPHINCS_TOY`). This session
  turns that educational sketch into the real, standards-grade scheme — exactly the move the lab made
  for ML-KEM (FIPS 203) and ML-DSA (FIPS 204). One new engine module (`slhdsa.ts`), one page
  (`/slhdsa`), one self-test group; zero new dependencies, still zero crypto deps.
  - **`src/ecc/slhdsa.ts`** — SLH-DSA for the SHA-2, category-1 sets (**-128f** and **-128s**), built to
    the letter of FIPS 205: the 32-byte `Adrs` with the FIPS-205 field layout (4-byte layer, 12-byte
    tree, 4-byte type) and its **22-byte ADRSc compression**; the SHA-2 tweakable-hash family
    `F/H/T/PRF/PRF_msg/H_msg` (§11.2.1 — PK.seed zero-padded to a 64-byte block, and `H_msg` an
    **MGF1-SHA-256** over `R ‖ PK.seed ‖ SHA-256(R ‖ PK.seed ‖ PK.root ‖ M)`); **WOTS⁺** (base-2ᵂ digits
    + the len₂ checksum, chaining via `F`); **XMSS** (a Merkle tree of WOTS⁺ keys, auth paths);
    the **d-layer hypertree**; and **FORS** (a stateless few-time signature whose leaf is chosen
    pseudo-randomly from R). Full `slh_sign_internal`/`slh_verify_internal` plus the FIPS 205 §10.2 pure
    context wrapper `M′ = 0x00 ‖ |ctx| ‖ ctx ‖ M`, deterministic (opt_rand = PK.seed) and hedged modes,
    and byte-exact key/signature packing (pk 32 B, sk 64 B, sig 17088/7856 B). An optional per-call hash
    counter (`Stats`) makes the scheme's cost legible.
  - **Pinned to NIST ACVP FIPS 205 vectors, byte-for-byte.** `KEYGEN_KAT` maps the three seeds to the
    published public root for both sets; `SIGGEN_KAT` reproduces the deterministic *pure/external*
    signature over the vector's message+context and checks `SHA-256(sig)` against the pinned digest.
    Developed against these vectors in a Node reference *and* the TS port before any UI — all pass
    (keyGen roots + sigGen digests for -128f and -128s).
  - **`src/pages/SlhDsaPage.tsx`** + `/slhdsa` route (nav "SLH-DSA", after ML-DSA): the four-layer stack
    explained, a parameter-set table (the size⇄speed trade), a live keypair + signature over your own
    message/context with tamper toggles, a signature-composition bar (R ‖ FORS ‖ hypertree), a FORS
    leaf-selection strip (k trees), a hypertree walk (d layers, active leaf highlighted), a live hash-cost
    readout, a **standards-conformance panel** that recomputes NIST's keyGen roots and sigGen digests in
    the browser, and an SLH-DSA-vs-ML-DSA comparison (hash vs lattice). Heavy compute is deferred off the
    render frame; -128f signs live (~10⁵ hashes), -128s (~2·10⁶) is opt-in.
  - **Self-test** grew with a new **SLH-DSA** group: both keyGen KATs (-128f/-128s) reproduce NIST's
    public root, the -128f sigGen KAT reproduces NIST's signature digest, and verify accepts the genuine
    signature while rejecting a mauled byte and a wrong context. The full `verify-project.mjs` gate
    (scope + conformance + lint + build) is green.

- 2026-07-05 (claude / claude-opus-4-8[1m]): **Nova — a folding scheme for IVC, from scratch.** Added
  the post-2019 idea the proof-system shelf was missing: *folding*. One new engine module (`nova.ts`),
  one page (`/nova`), one self-test group — all on the existing BLS12-381 𝔾₁, zero new deps. Relaxed
  R1CS `(A·Z)∘(B·Z) = u·(C·Z) + E` is closed under a random fold `Z = Z₁ + r·Z₂`, so the quadratic's
  cross terms collapse into one computable `T`; because a Pedersen commitment is additively
  homomorphic, the verifier folds *committed* instances (a couple of curve adds + a scalar mul per
  commitment) while never seeing a witness, with a Fiat–Shamir `NovaTranscript` picking `r`. The IVC
  driver folds an N-step chain of the canonical `F(z) = z³ + z + 5` into ONE relaxed instance, so a
  single relaxed-R1CS check replaces `N·3` ordinary ones — the whole point of Nova. The `/nova` page
  shows the chain, the per-fold table (the recovered challenge `rᵢ = uᵢ − uᵢ₋₁`, cross-term
  commitment, running `u`, accumulator commitment), the `N·n` vs `1` contrast, and a fault injector
  that rejects a corrupted witness, a forged cross-term, and broken chaining live. Correctness proven
  before shipping: the folded assignment satisfies the folded instance, and the cross-term identity
  holds numerically at a random challenge. Node-validated (18-assertion rolldown harness + the full
  `runSelfTest()`), then the exact `verify-project.mjs` gate green. Then a **second IVC application**
  (`nova_mimc.ts`) to prove the folding core is generic: the driver became `ivcProveWith` over a
  `StepFn`, and a **MiMC arithmetic permutation** (R rounds of `x ↦ (x+c)³`) folds into a sequential
  hash chain — a `/nova` application selector switches cubic ↔ MiMC, with 5 more self-tests. Nova
  group **16** tests, suite **416 → 432/432 across 65 groups**. No new deps.

- 2026-07-04 (claude / claude-opus-4-8[1m]): **BBS, round 2 — blind issuance (holder binding).**
  Follow-up to the BBS lab: the issuer can now sign attributes it never sees. `blindCommit` has the
  holder commit to the hidden slots (a device **link secret** + a private id) as `U = Σ mᵢ·Hᵢ` and
  attach a Fiat–Shamir Σ-proof of the opening; `verifyBlindRequest` lets the issuer check it;
  `blindSign` completes `A = (P1 + domain·Q₁ + U + Σ mᵢ·Hᵢ)/(sk+e)` from the commitment, blind to the
  hidden messages. The elegance: the result is an *ordinary* BBS signature over the full (L+1)-message
  vector (the last slot being the holder's secret), so it verifies and presents with the existing
  machinery unchanged. Added a `/bbs` panel ⑤ (commit → issuer accepts proof → blind-issued sig
  verifies → still presents over-21 → issuer refuses a malformed commitment) and 6 self-tests. BBS
  group 15 → **21**, suite **410 → 416/416 across 64 groups**. Node-validated (a 7-assertion engine
  harness + the full shipping `runSelfTest()`), then the exact `verify-project.mjs` gate green. No new
  deps.

- 2026-07-04 (claude / claude-opus-4-8[1m]): **Built the BBS anonymous-credentials lab end to end.**
  One new engine module, one page, one self-test group — all on the existing BLS12-381 pairing, with
  zero new dependencies and still zero crypto deps.
  - **`src/ecc/bbs.ts`** — BBS from scratch: NUMS generators via RFC 9380 hash-to-curve, `hashToScalar`
    over `expand_message_xmd`, deterministic `bbsSign`/`bbsVerify` (the pairing `e(A, PK+e·P₂)=e(B,P₂)`),
    and the headline **zero-knowledge selective-disclosure proof** (`bbsProofGen`/`bbsProofVerify`).
    The proof is derived in the file (randomize `Ā=r·A`, `D̂=r·B−e·Ā`, Σ-prove `D̂=r·C−e·Ā+Σuⱼ·Hⱼ`),
    with the soundness argument written out: the pairing forces `D̂=sk·Ā`, so dividing by `r≠0` extracts
    a real signature over the disclosed attributes. A high-level `issueCredential`/`presentCredential`/
    `verifyPresentation` API expresses the mDL "prove over-21 without revealing date-of-birth" flow.
  - **`src/pages/BbsPage.tsx`** + `/bbs` route (nav label "BBS Credentials", after BLS Pairing): an
    interactive driver's-licence credential with disclose/hide toggles per attribute, the live ZK
    presentation, an editable verifier session header, a soundness panel (lie / replay / tampered-Ā all
    rejected live), and an unlinkability panel proving two presentations share no group element.
  - **Self-test** grew to **410/410 across 64 groups** with a new `BBS · anonymous credentials` group
    (15 checks): correctness + determinism, tamper/wrong-key/mauled-e rejection, selective disclosure
    (2 of 6), the blinded-response bookkeeping, the full soundness battery, zero-/full-disclosure edge
    cases, and unlinkability. **Validated in Node first** (a vite-lib bundle running the exact shipping
    `runSelfTest()` — 410/410, and a standalone 22-assertion harness of the raw engine), then the full
    `verify-project.mjs` gate (scope + conformance + lint + build) green.

- 2026-07-04 (claude): **Ballot, round 2 — the Benaloh cast-or-audit challenge (cast-as-intended).**
  Follow-up to the voting lab: added Helios's ballot-auditing step so a voter can catch a malicious
  *client*, not just a malicious server. `sealBallot` now returns a ballot together with its per-slot
  encryption randomness; `auditBallot` recomputes every ciphertext from a *spoiled* ballot's revealed
  openings and confirms it encodes the claimed vote — while a ballot that is actually **cast** keeps its
  openings secret, so privacy is preserved. A new `/voting` panel spoils any voter's ballot and shows the
  per-slot recomputation match; a vote-swapping client turns it red. +2 self-tests → **395/395**. Lint +
  build + the exact gate green; zero new deps.

- 2026-07-04 (claude): **Ballot — verifiable homomorphic e-voting, the capstone protocol.** Wired the
  threshold + zero-knowledge shelves into the protocol they were built for: **Helios/Belenios**
  end-to-end-verifiable voting, entirely from the lab's own parts. New `elgamal.ts` adds **exponential
  ElGamal** on secp256k1 — messages in the exponent (`m·G`) so ciphertexts **add**, with the homomorphic
  group law, a **bounded baby-step giant-step** dlog to recover a small tally (and flag an impossible
  total as `null`), and a **disjunctive Chaum–Pedersen** NIZK that a ciphertext encrypts `0`/`1`. New
  `voting.ts` assembles the election: a **Pedersen joint-Feldman DKG** (reusing `shamir.ts`) splits the
  key t-of-n so no authority can decrypt; **1-of-k ballots** are k proven bits plus a DLEQ that they sum
  to one; the **homomorphic tally** aggregates ciphertexts; **threshold decryption** has each trustee
  publish a partial with a **DLEQ proof** (`sigma.ts`) and any t combine by Lagrange in the exponent; and
  `verifyElection()` is a **universal verifier** that re-derives the trustee keys from the public
  commitments and re-checks every proof, **trusting no one and touching no secret**. One new `/voting`
  page — DKG + trustee table, per-voter ballot picker, the public bulletin board with proof badges, the
  homomorphic aggregate + quorum-selected threshold decryption, a decrypted-tally bar chart graded
  against the plaintext ground truth, and the universal-verifier checklist — with two live tamper toggles
  (ballot-stuffing, a dishonest trustee) the verifier catches by name. The whole protocol was
  Node-validated end-to-end first (30 assertions: homomorphism, every soundness/tamper path, a full
  election matching the plaintext count, the t-of-n threshold) **before** any UI. Self-test grew by
  **18** → **393/393** across **63 subsystems** in a new **Homomorphic Voting** group; lint + build + the
  exact `verify-project.mjs` gate all green. No new dependencies, still zero crypto deps.

- 2026-07-03 (claude): **GKR & the sum-check protocol — the engine under modern SNARKs, from scratch.**
  Added the proof-system shelf's missing primitive. `sumcheck.ts` implements the **sum-check protocol**
  over the Goldilocks field — multilinear extensions (`2ⁿ` table + `mleEval` by variable-folding), the
  `ẽq` Lagrange basis, univariate round messages with Lagrange reconstruction, and a generic
  `sumcheckProve`/`sumcheckVerify` on the lab's Fiat–Shamir transcript, collapsing an exponential
  `Σ_{x∈{0,1}ⁿ} g(x)` to one oracle call and `n·deg` field work. `gkr.ts` layers it into the
  **Goldwasser–Kalai–Rothblum** doubly-efficient interactive proof: a layered arithmetic circuit reduced
  layer-by-layer via the GKR identity, the `addᵢ`/`mulᵢ` wiring-predicate MLEs (sparse-summed by the
  verifier, tabulated by the prover), and the **two-claim line-restriction** trick — so the verifier
  certifies a whole circuit's output re-executing **zero** gates (a live stat row makes the asymmetry
  concrete: 12 prover gate-ops vs 13 verifier checks on the demo circuit). `sumcheck_apps.ts` adds the two
  textbook applications — **verified matrix multiplication** (`C̃(r,s)=Σ_x Ã(r,x)B̃(x,s)`, Thaler §4.4) and
  **triangle counting** (`Σ Ã(x,y)Ã(y,z)Ã(z,x)=6·#triangles`) — each with a live soundness demo. One new
  page (**GKR & Sum-Check**, `/gkr`), five panels, four tamper toggles (lying prover, forged product
  entry, inflated count, forged output wire), all caught. Self-test grew by **14** → **375/375** across
  **62 subsystems** in a new **GKR · sum-check** group. Every construction cross-checked in Node against a
  brute-force oracle (`tsx` harness, 14 + 11 assertions incl. `K4`=4 triangles) before any UI, then
  render-checked headless in Chromium (all five panels green, no console errors). No new dependencies,
  still zero crypto deps. Lint + build green via verify-project.mjs.

- 2026-07-03 (claude): **The Class-Group VDF — proof of sequential time with no trusted setup.** Closed
  the one philosophical gap in the RSA-group VDF: its trapdoor. Built the **class group of an imaginary
  quadratic order** `Cl(Δ)` from scratch — a genuinely new algebraic domain for the lab, not another
  elliptic curve — as binary quadratic forms `(a,b,c)` under **Gauss composition + reduction**
  (`classgroup.ts`), then reran the full **Wesolowski VDF** over it (`cgvdf.ts`): `y = g^(2^T)` by T
  sequential class-group squarings, a one-form succinct proof `π = g^⌊2^T/ℓ⌋` verified by
  `π^ℓ ∘ g^r = y`, a streaming O(1)-memory prover, and a delay beacon. The decisive property: the group
  order is the class number `h(Δ) ≈ √|Δ|`, believed as hard as factoring to compute, and `Δ` is a
  **public seed hash** — so unlike RSA there is no `φ(N)` anyone knows and *no ceremony to trust*. The
  arithmetic was validated the hard way before anything else: **the group axioms on the full Cayley
  table** of small discriminants (closure + associativity over every triple + identity + inverses) and
  the **known class numbers** `h(−23)=3 … h(−3299)=27`. New `/cgvdf` page (seed → Δ, the group law, the
  delay with a live coordinate-bound verdict, the Wesolowski proof with a forge toggle, a
  where-the-trust-lives comparison table, and the beacon) and ~27 new self-test checks in a
  **VDF · class group** group. Node-validated (exhaustive axiom oracle) + lint + build + the exact CI
  gate all green. Zero crypto dependencies.
- 2026-07-03 (claude): **VDF, round 2 — scaling the proof: a streaming Wesolowski prover and a
  continuous (checkpointed) VDF.** A follow-up that makes the VDF practical at the huge T a real
  deployment uses, built entirely on the round-1 primitives. **(1) `wesolowskiProveStreaming`:** the
  succinct proof `π = x^⌊2^T/ℓ⌋` computed in **O(1) memory without ever forming the T-bit integer
  2^T** — track `rᵢ = 2^i mod ℓ` and accumulate `π ← π²·x^(bᵢ)` with the quotient bit
  `bᵢ = ⌊2rᵢ₋₁/ℓ⌋`; the exponent telescopes to exactly `⌊2^T/ℓ⌋` (derived, then pinned **byte-identical**
  to the naive prover for T up to 2^16). This is the trick that lets Chia grind T ≈ 10⁹. **(2)
  `vdfCheckpoints`:** a continuous VDF that emits `k` proof-carrying milestones `(T_j, y_j, π_j)` along
  the delay — each an independent Wesolowski proof against the same input, so a light client confirms
  partial progress in real time without redoing a squaring; checkpoints are monotone and the last one
  equals the full evaluation. Uses the streaming prover so even large-T checkpoints form no giant
  integer. **(3) A new `/vdf` panel** ("Scaling the proof") — a live streaming-vs-reference match
  verdict, plus an on-demand continuous-evaluation table (total T and checkpoint-count sliders) that
  renders each milestone with a progress bar and a verify verdict. **Self-test** grew **+2** (streaming
  prover = reference for five T; continuous checkpoints monotone/proof-carrying/final = full eval) →
  **335/335 across 60 subsystems**. Verified in Node (21-assertion harness + the full in-app suite) and
  SSR-rendered before wiring; lint + build + the exact `verify-project.mjs` gate all green. No new
  dependencies, still **zero crypto deps**.
- 2026-07-03 (claude): **Verifiable Delay Functions — proof of sequential time, from scratch.** Added
  the time analogue of the VRF: a from-scratch VDF in a 512-bit Blum RSA group where `y = x^(2^T) mod N`
  demands T *sequential* squarings no parallelism can shorten, yet verifies in one shot. **(1) `vdf.ts`:**
  the squaring core plus a trapdoor shortcut (`e = 2^T mod φ(N)`) that motivates why a real modulus must
  be unfactored; **both** proof systems — **Wesolowski** (a deterministic hash-to-prime `ℓ` via
  fixed-witness Miller–Rabin, proof `π = x^⌊2^T/ℓ⌋`, verified by `π^ℓ·x^r = y` in one exponentiation) and
  **Pietrzak** (the Fiat–Shamir halving protocol, `log₂T` midpoints folded down to `y = x²`); an **RSW
  time-lock puzzle** (lock instantly with the trapdoor, open only by grinding); and a **delay beacon**
  (`βᵢ₊₁ = SHA256(VDF(βᵢ))`, each round proof-carrying — the RANDAO+VDF / Chia shape). **(2) `VdfPage.tsx`
  (`/vdf`):** six panels — the statement with honest-vs-trapdoor agreement, the Wesolowski proof with a
  forge-π toggle, the Pietrzak halving table with a flip-a-midpoint toggle, a proof-size trade-off chart,
  a **live animated** time-lock grind (chunked squaring + progress bar), and the beacon chain with
  per-round verdicts. **(3) Self-test** grew **+14** across five new VDF subsystems (trapdoor = squaring
  chain over many T; Wesolowski/Pietrzak accept and reject forgeries, mauled outputs, and the wrong
  delay; hash-to-prime determinism; RSW round-trip + wrong-work-factor failure; a verifying beacon
  chain) → all **333/333 across 59 subsystems**. Overview card, nav, and footer updated. Verified in
  Node (a 62-assertion harness *and* the full in-app suite) before wiring the UI; lint + build + the
  exact `verify-project.mjs` gate all green. No new dependencies, still **zero crypto deps**.
- 2026-07-03 (claude): **ML-DSA, round 2 — HashML-DSA (the pre-hash variant), hedged signing, and an
  aborts histogram.** A follow-up that deepens the ML-DSA lab shipped earlier the same day. **(1)
  HashML-DSA (FIPS 204 §5.4):** the pre-hash signing mode — sign `PH(M)` under domain byte 1 with the
  message representative `M′ = 0x01 ‖ len(ctx) ‖ ctx ‖ OID(PH) ‖ PH(M)`, for both `SHA-512`
  (OID 2.16.840.1.101.3.4.2.3) and `SHAKE-256` (2.16.840.1.101.3.4.2.12), reusing the lab's own
  `sha512` and `shake256`. The DER OID is what makes the signature *inseparable* from its hash
  function: a SHA-512 pre-hash signature is rejected under SHAKE-256 and rejected as pure ML-DSA
  (both pinned in the self-test). **(2) Hedged signing:** surfaced the engine's `rnd` path — two
  randomised signatures over one message differ byte-for-byte yet both verify, while the deterministic
  (rnd = 0) mode stays reproducible; a note contrasts this with ECDSA, where a repeated nonce is fatal.
  **(3) Aborts histogram:** signs a 40-message batch and buckets the Fiat–Shamir-with-aborts iteration
  counts (1/2/3/4/5+ tries) with the mean, making the "with aborts" cost visible. Three new lab panels
  (§4/5/6 on `/mldsa`), each in its own `useMemo` so the message box stays snappy. Self-test grew
  **314 → 319** (5 new ML-DSA checks: hedged-differs-yet-verifies per set, plus HashML-DSA OID binding
  for both hashes); lint + build + the exact CI gate all green; the page SSR-rendered clean (72 KB).
  **Still zero crypto dependencies.**
- 2026-07-03 (claude): **ML-DSA — the post-quantum lattice *signature* (FIPS 204 / Dilithium), from
  scratch.** Completed the post-quantum story: Session 12 added ML-KEM (a quantum-safe *key exchange*);
  this session adds the mainstream quantum-safe *signature* — the standard that retires ECDSA / Ed25519 /
  BLS. It is a much harder object than the KEM: a **Fiat–Shamir-with-aborts** identification scheme over
  `Z₈₃₈₀₄₁₇[X]/(X²⁵⁶+1)`, needing rounding, rejection sampling, and a hint mechanism nothing else in the
  lab used. One new engine module + one streaming-XOF addition + one lab. **(1) `mldsa.ts` (~700 LOC):**
  the full FIPS 204 stack — a complete 256-point NTT (`q ≡ 1 mod 512`, so the ring splits fully; pinned
  by `NTT⁻¹∘NTT = id` and pointwise = **negacyclic** convolution); `Power2Round` / `Decompose` /
  `HighBits` / `LowBits` / `MakeHint` / `UseHint` (pinned by `r = r1·2¹³ + r0`, `|r0| ≤ 2¹²`, and
  `UseHint(MakeHint(z,r),r) = HighBits(r+z)` at both γ2); the samplers `ExpandA` (SHAKE128),
  `ExpandS` / `ExpandMask` (SHAKE256), and `SampleInBall` (exactly τ signed units); byte-exact
  `SimpleBitPack`/`BitPack` and a *validating* hint decoder; and `KeyGen`/`Sign`/`Verify` (Alg. 6/7/8)
  with the final-standard `ξ ‖ k ‖ l` domain separation, the abort-retry signing loop, deterministic
  (rnd = 0) signatures, and an external `ctx`-string prefix. All three parameter sets (44/65/87) hit the
  **exact** FIPS 204 Table-2 sizes — pk 1312/1952/2592, sk 2560/4032/4896, sig 2420/3309/4627.
  **(2) `keccak.ts`:** added a streaming `shake256Xof` for `SampleInBall`'s absorb-once/squeeze pattern.
  **(3) `MlDsaPage.tsx` (route `/mldsa`):** a lab that lays the Fiat–Shamir-with-aborts loop bare — live
  iteration count, the *reasons* each attempt was rejected, the τ-sparse ±1 challenge as a 256-cell
  strip, the response `z`'s near-uniform histogram, an editable message, independent message-tamper /
  signature-maul toggles on Verify, and an Ed25519-vs-ML-DSA size chart. Self-test grew by **30 checks**
  in a new `ML-DSA` group → **314/314**; a Node harness confirmed all 30 pass at runtime; lint + build +
  the exact CI gate all green; the page SSR-rendered clean (66 KB, no throw) before commit. Nav/route
  wired; ML-DSA sits next to ML-KEM. **Zero new dependencies — still zero crypto deps.**
- 2026-07-02 (claude): **Sealed — the secure channel: X3DH + Double Ratchet (the Signal protocol),
  from scratch.** Closed the one missing dimension of the lab: *confidentiality*. Every prior module
  proves who signed something or that a statement is true; none kept a message secret. This session
  composes the existing X25519 + HKDF/HMAC-SHA256 with a **from-scratch ChaCha20-Poly1305** into the
  actual end-to-end encryption behind WhatsApp/Signal. Six new engine modules + one lab.
  **(1) `chacha20.ts` — ChaCha20-Poly1305 AEAD (RFC 8439):** the 20-round ARX block function, counter-
  mode encryption, the Poly1305 polynomial MAC mod 2¹³⁰−5, and the §2.8 length-framed AEAD with a
  constant-time tag compare — pinned **byte-for-byte** to the RFC's §2.3.2/§2.4.2/§2.5.2/§2.8.2 vectors.
  **(2) `hkdf.ts` — HKDF-SHA256 (RFC 5869):** extract/expand as a first-class module on the lab's HMAC,
  pinned to RFC test cases 1 and 3. **(3) `xeddsa.ts` — XEdDSA (Signal):** the birational
  Montgomery→Edwards trick that lets one X25519 identity key *sign* its prekey, with the sign bit pinned
  to 0 so the verifier rebuilds the key from the u-coordinate alone — an XEdDSA signature is a valid
  Ed25519 signature, so it reuses `ed25519Verify` unchanged. **(4) `x3dh.ts` — Extended Triple DH:**
  prekey bundles, the 3–4-way DH mix, and `SK = HKDF(F ‖ DH1‖…‖DH4)`, with a tampered signed-prekey
  signature yielding no session. **(5) `doubleratchet.ts` — the Double Ratchet:** the HKDF root chain,
  the HMAC symmetric chain, per-message ChaCha20 keys, the DH ratchet that reseeds the root on every
  direction change, and a bounded skipped-message-key store for out-of-order delivery — headers
  authenticated as AEAD associated data. **(6) `signal.ts` — the session + three replayable proofs:**
  out-of-order (3,1,2 still decrypts), **forward secrecy** (a used key is deleted, so replaying a
  delivered message fails), and **post-compromise security** (a stolen full state reads the next
  message but is locked back out one round trip later, once a fresh ratchet key it never saw reseeds
  the root — the subtle part: healing needs Bob to generate a new key, which he only does on *receiving*
  Alice's ratchet, so it takes a full round trip). **(7) `SealedPage.tsx` (Lab 24):** a live Alice⇄Bob
  chat — the X3DH handshake with a live prekey-signature verdict and the four DHs, message bubbles
  showing plaintext + header + ciphertext bytes + a "↻ DH ratchet" marker + a decrypt/rejected verdict,
  a forge toggle that flips a ciphertext bit and shows the AEAD reject it, a live two-sided ratchet-
  state panel, and one-click runners for the three guarantees. All 28 primitive+protocol checks pass in
  a Node harness (RFC vectors byte-exact); the live Self-Test grew **218 → 241/241**; lint + build +
  the exact CI gate all green; the page SSR-rendered clean before commit. Nav/Overview/footer updated;
  Sealed takes the free index 24. **Zero new dependencies — still zero crypto deps.**
- 2026-07-02 (claude): **Verifiable randomness (ECVRF) + linkable ring signatures & stealth
  addresses.** Two new engine modules and two new labs, adding the two applied-crypto pillars the shelf
  still lacked. **(1) `ecvrf.ts` — ECVRF (RFC 9381)**, a verifiable random function on Edwards25519 in
  both standardised ciphersuites: `TAI` (try-and-increment hash-to-curve) and `ELL2` (the constant-time
  **Elligator2** map, built on `expand_message_xmd` with SHA-512, L=48). A VRF is a signature whose
  *hash* is unique and uniformly random: the key holder computes β = VRF(sk, α) with an 80-byte
  Fiat–Shamir proof π that `Γ = x·H` under the same `x` behind `Y = x·B`; anyone re-derives H from
  (Y, α) and checks the challenge closes, learning nothing of the key, yet certain that exactly one β
  verifies and the signer can't steer it. Ported byte-exactly from Leo Reyzin's (an RFC 9381 co-author)
  public-domain reference, then **pinned to the standard's own vectors**: all six Edwards25519 examples
  (Appendix B.3 TAI + B.4 ELL2; SK/PK/α from RFC 8032 §7.1) reproduce the RFC's **π byte-for-byte**,
  verify accepts, a one-bit maul is rejected, and β is deterministic + unique — 30 live self-test
  checks. **(2) `ring.ts` — linkable ring signatures + stealth addresses**, the cryptography that hides
  a sender yet still forbids double-spends (Monero's core), on the lab's Ed25519 group: `SAG` (plain
  unlinkable AOS ring signature), `bLSAG` (Back's linkable SAG — adds a **key image** `I = x·Hₚ(P)`,
  deterministic in the secret but leaking nothing, so a ledger links repeat-spends of the same coin
  without ever unmasking the spender), and `CLSAG` (the *concise* scheme: fold an output-key ring and an
  amount-commitment ring into one aggregate LSAG via coefficients μ_P/μ_C, one response scalar per ring
  member). Plus CryptoNote **stealth** one-time output keys (`P = H(r·A)·B + B_spend`, spent with
  `x = H(a·R) + b`), assembled into a complete private payment — spend a stealth coin among decoys.
  Hash-to-point reuses ECVRF's Elligator2 map. 14 live property checks: bLSAG verifies from *every* ring
  position (anonymity), key image = x·Hₚ(P), two spends of the same key **link**, distinct keys **don't**,
  a swapped image is rejected, CLSAG verifies/tamper-rejects/links, and stealth recovery works for the
  recipient but not a stranger. **(3) Two lab pages.** `/vrf` (Lab 28): ciphersuite toggle, keygen,
  prove (β/Γ/c/s/π), verify with a live tamper switch, an RFC-vector loader that lights up "matches RFC
  9381 byte-for-byte" when it does, and a **verifiable leader-election lottery** (each player's β → a
  ticket in [0,1); smallest wins; every draw re-verifiable, none biasable). `/ring` (Lab 29): ring +
  signer picker, bLSAG/CLSAG sign+verify with a tamper switch, a **double-spend table** (same key →
  LINKED, other key → unlinked), and a four-step **stealth private-payment** flow. Both modules
  Node-verified against vectors/properties **before** any UI, and a headless-Chromium render check
  confirmed both routes paint with every verdict green and zero app JS errors. Self-test grew 174 →
  **218/218** across **39 subsystems**. Nav + Overview updated (ECVRF 28, Ring Sigs 29, Self-Test 30).
  No new dependencies — still zero crypto deps. Lint + build green via verify-project.mjs.
- 2026-07-02 (claude): **Poseidon — an arithmetic hash, and a STARK that proves you know its
  preimage.** Two new engine modules that finally bridge the lab's two hash worlds. Every earlier hash
  here is a *bit* function (SHA-256/512, RIPEMD-160) — rotations, xors, 32/64-bit adds — which a proof
  system loathes because one xor is dozens of field constraints; and every earlier STARK statement was
  a *toy* recurrence chosen precisely so its constraints were trivial. This session builds the missing
  piece: (1) `poseidon.ts` — a Poseidon permutation over the Goldilocks STARK field whose whole
  computation is *nothing but field arithmetic* (add a constant, raise to the 7th power, multiply by an
  MDS matrix), so it is already a short list of low-degree polynomial identities. The Hades layout
  (R_F=8 full + R_P=22 partial, 4·full · 22·partial · 4·full), an **x⁷ S-box** (7 is the smallest
  exponent coprime to p−1 = 2³²·3·5·17·257·65537, so x↦x⁷ is a bijection — the Plonky2/Risc0 choice),
  a **Cauchy MDS** matrix M[i][j]=1/(xᵢ−yⱼ) (Cauchy ⇒ MDS ⇒ the mix layer is a bijection, verified by
  a live Gaussian elimination), and **nothing-up-my-sleeve round constants** derived from the lab's
  *own* SHA-256 — nowhere to hide a trapdoor. Plus a sponge `hash`, a 2-to-1 Merkle `hashTwoToOne`, a
  `compress` (a 256→256-bit fixed-input hash), and a `permuteTrace` emitting one row per state.
  (2) `poseidon_stark.ts` — a genuine **multi-column AIR** (width t=8, versus the fib STARK's two
  columns): a 32×8 trace, eight **transition constraints** encoding `colⱼ(g·x)=Σₖ MDS[j][k]·Yₖ` with
  the round constants and the full/partial selector interpolated as **public polynomials** the verifier
  evaluates at ζ, and **boundary constraints** pinning the capacity IV to 0 (row 0) and the rate lanes
  to the public digest (output row). The x⁷ S-box makes these ≈degree-248 constraints — an order of
  magnitude past the fib STARK's degree-2 — so the FRI degree bound (256) and LDE blowup are larger;
  the same AIR→LDE→composition→DEEP→FRI pipeline proves *"I know a secret preimage m with
  Poseidon(m)=d"* in ~500 ms and verifies in ~175 ms, revealing nothing about m. **Soundness shown
  three ways, all live**: a prover who lies about the statement (a digest that isn't the real hash) is
  rejected (the output-boundary quotient stops vanishing); a prover who fudges one interior round is
  rejected (a transition quotient stops being a polynomial → the composition isn't low degree → FRI
  notices); and a mauled out-of-domain value is rejected (the DEEP quotient at ζ stops reproducing the
  committed codeword). New **Poseidon** lab page (Lab 26): the construction with a full/partial
  round-schedule strip, an editable secret preimage with its public digest, the permutation drawn round
  by round (the very table the STARK lays out as a trace), the commitment roots, the constraint table,
  the DEEP openings, the FRI folding bars, the verdict + proof-size stat line, and the two soundness
  demos. Wired into nav + Overview (cards renumbered 01–28: Poseidon 26, PQ Signatures 27, Self-Test
  28). Both modules Node-verified against their algebraic invariants before any UI (S-box=pow
  bijection, MDS invertibility, permutation/compression/2-to-1 pinned KATs, and the STARK's honest
  round-trip + all three soundness rejects across several edge-case preimages), and a headless-Chromium
  render check confirmed the `/poseidon` route paints, the hash runs, the preimage STARK verifies
  **accepted ✓** and both soundness provers show **rejected ✓**, with zero app JS errors. Self-test
  grew 163 → **174/174** across **37 subsystems** (+11 Poseidon checks). No new dependencies — still
  zero crypto deps. Lint + build green via verify-project.mjs.
- 2026-07-02 (claude): **post-quantum hash-based signatures — Lamport → WOTS⁺ → XMSS → SPHINCS⁺,
  from scratch.** The lab's first signature family that survives a quantum computer: every other
  signature here (ECDSA, Schnorr, MuSig, BLS) dies to Shor, while these rest on *nothing but a
  collision-resistant hash* — the exact assumption the STARK already makes — so the whole lab now
  spans classical curves, pairings, transparent proofs *and* a plausibly-post-quantum signature.
  Six new engine modules, each Node-verified against its algebraic invariants before any UI, all on
  the lab's own SHA-256 (still **zero crypto dependencies**). (1) `hashaddr.ts`: the RFC 8391
  §2.5/§5.1 **tweakable-hash substrate** — `toByte`, the 32-byte **ADRS** address (OTS / L-tree /
  hash-tree / FORS types with their field setters), the four domain-separated hashes
  `F`/`H`/`H_msg`/`PRF` (`SHA256(toByte(t,32) ‖ KEY ‖ M)`), `RAND_HASH` (the bitmasked Merkle node),
  and the SPHINCS⁺ `T_ℓ` multi-input compressor — standards-conformant by construction (SHA-256 is
  the only trust root, and it is already KAT-pinned to FIPS 180-4). (2) `lamport.ts`: **Lamport
  OTS**, the pencil-and-paper root — reveal one of two preimages per digest bit; a live forger shows
  that reusing the key ~16× leaks all 512 secret halves and enables *universal* forgery, the reason
  it is one-time. (3) `wots.ts`: **WOTS⁺** (RFC 8391 §3) — `base_w`, the bitmasked `chain`, the
  length-2 **checksum** that blocks forward-walking a chain, PRF-expanded keygen, `sign`,
  `pkFromSig`; `w` is a pure size/speed dial (`len = ⌈8n/lg w⌉ + len₂`; w=16 ⇒ 67 chains), verified
  at w=4/16/256 and via the chain composition law `chain(·,0,a)∘chain(·,a,b)=chain(·,0,a+b)`.
  (4) `xmss.ts`: **XMSS** (RFC 8391 §4) — the **L-tree** crush of a WOTS⁺ pk into a leaf, the Merkle
  `treeHash` + O(h) authentication path, and **stateful** sign where the leaf counter *must* advance
  (the signer refuses to reuse a leaf, and exhausts at 2^h). The root *is* the public key.
  (5) `sphincs.ts`: **SPHINCS⁺ / SLH-DSA-shape** (FIPS 205) — the *stateless* scheme: a **FORS**
  few-time signature (k Merkle trees, message-selected leaves) signed by a **hypertree** (d layers of
  XMSS, each root WOTS⁺-signed by the layer above, trees regenerated from seeds on demand), the leaf
  chosen pseudo-randomly from `H_msg(R ‖ PK.seed ‖ PK.root, M)` so there is no counter to lose;
  scaled toy params (h=12, d=3, k=8, a=6) keygen/sign/verify in the browser in well under a second,
  with the real SLH-DSA-128s names documented. (6) A **`PQSignatures` lab page** (Lab 26): the four
  schemes in one pedagogical arc — a Lamport reuse-slider that turns the key red as it leaks, a WOTS⁺
  `w` selector with the checksum guard shown rejecting a forward-walk, interactive XMSS signing that
  advances the leaf counter and refuses reuse once exhausted (with the authentication path drawn to
  its root), a one-click SPHINCS⁺ keygen·sign·verify showing the digest→(FORS indices, tree, leaf)
  split and a FORS/hypertree size breakdown, and a comparison table of key/signature sizes vs. the
  Shor-broken curves. Wired into nav + Overview (cards renumbered 01–27; Self-Test → 27). Self-test
  grew 142 → **163/163** across **36 subsystems** (+21: tweakable-hash domain separation, the WOTS⁺
  lengths + chain law + multi-w round-trips, Lamport reuse→universal-forgery, XMSS state-advance /
  tampered-path / exhaustion, and SPHINCS⁺ stateless round-trip + FORS/hypertree/randomiser
  mauling all rejected). Verified in Node against every invariant, and a headless-Chromium check
  confirmed the page paints, SPHINCS⁺ signs+verifies live and XMSS advances state with **zero app JS
  errors**. Lint + build green via verify-project.mjs.
- 2026-07-02 (claude): **STARK — a transparent, hash-only, post-quantum proof, from scratch.** The
  fourth proof system in the lab and the odd one out: Groth16, PLONK and Bulletproofs all rest on an
  elliptic curve (the first two on a trusted setup); a STARK rests on **nothing but a
  collision-resistant hash**. Five new engine modules, each Node-verified before any UI. (1)
  `goldilocks.ts`: the STARK-friendly field `p = 2⁶⁴ − 2³² + 1`, whose group has a 2³² power-of-two
  subgroup — a verified generator (g=7, checked against p−1 = 2³²·3·5·17·257·65537), primitive roots
  of unity, a batch inverse, an in-place iterative **NTT/INTT**, and coset evaluation for the
  low-degree extension. (2) `merkle.ts`: a binary Merkle tree over rows of field elements on the lab's
  own SHA-256 — the sole cryptographic assumption. (3) `transcript.ts`: a running SHA-256 **Fiat–Shamir**
  transcript threaded through the whole proof. (4) `fri.ts`: the **FRI** low-degree test — commit each
  layer, fold in half with a random challenge, re-open random positions to check every fold, collapsing
  a degree-<T claim to a constant (honest low-degree accepts; a random full-degree codeword and any
  tampered layer/constant reject). (5) `stark.ts`: the full **AIR → LDE → composition → DEEP → FRI**
  pipeline proving a real execution — the Fibonacci-square recurrence `a_{n+2}=a_n²+a_{n+1}²` run for T
  steps to a public output — with two transition + three boundary constraints, a random-combination
  composition polynomial, an **out-of-domain** point ζ whose constraint identity binds the trace to the
  committed CP, and a DEEP polynomial fed to FRI. Verification runs in milliseconds. **Soundness shown
  live**: a false claimed output rejects, and a *forged intermediate step* rejects because a constraint
  quotient stops being a polynomial and FRI notices. New **STARK** lab page (Lab 25: trace table,
  commitment roots, constraint table, DEEP OOD values, a FRI folding visualisation, a three-part
  verdict, a proof-size stat line, and the two soundness demos), wired into nav + Overview (Self-Test →
  26). Self-test grew 131 → **142/142** across 35 subsystems (+11: Goldilocks generator/root/NTT, FRI
  accept/reject/tamper, STARK pinned-output/honest/false-output/forged-step/mauled-OOD). Every module
  verified in Node via a `--experimental-strip-types` harness, and a headless-Chromium render check
  confirmed the `/stark` route paints with the honest verdict **accepted ✓**, all three verification
  parts green, and both soundness demos **rejected ✓**, with zero app JS errors. No new dependencies —
  still zero crypto deps. Lint + build green via `verify-project.mjs`.
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
- 2026-07-03 (claude): **ML-KEM — the post-quantum lattice KEM (FIPS 203 / Kyber), from scratch.**
  Added the lab's first *lattice* scheme and its first non-SHA-2 hash, closing the biggest gap on the
  shelf: everything here was quantum-broken except the hash-based *signatures*, and nothing
  established a quantum-safe *secret key*. Three new engine modules, each pinned before any UI.
  (1) `keccak.ts`: **Keccak-f[1600]** + **SHA-3 / SHAKE** (FIPS 202) — the θ/ρ/π/χ/ι permutation on 25
  BigInt lanes (ρ offsets and the π map generated from the canonical (x,y)←(y,2x+3y) walk, so there is
  nothing to mistranscribe), a streaming sponge, and `sha3_256`/`sha3_512`/`shake128`/`shake256` plus a
  `shake128Xof` squeeze-stream — pinned to the FIPS 202 digests of `""`/`"abc"` and a cross-check that
  the streaming XOF equals the one-shot across a rate boundary. (2) `mlkem.ts`: **ML-KEM** on
  Module-LWE — the negacyclic **NTT** over `Z₃₃₂₉[X]/(X²⁵⁶+1)` with the degree-2 base multiply (pinned
  both by `NTT⁻¹(NTT(f))=f` and by reproducing a schoolbook negacyclic convolution), centered-binomial
  noise, `Compress`/`Decompress` coding, uniform matrix rejection sampling from a SHAKE128 XOF, the
  **K-PKE** IND-CPA core, and the **Fujisaki–Okamoto** transform (re-encrypt + **implicit rejection**)
  that lifts it to **IND-CCA2** — for all three parameter sets, matching the FIPS 203 key/ciphertext
  byte-sizes exactly (ek 800/1184/1568, ct 768/1088/1568, dk 1632/2400/3168) and demonstrating IND-CCA2
  by catching a mauled ciphertext without leaking the real key. (3) `hybridkem.ts`: **X25519MLKEM768**,
  the exact TLS 1.3 hybrid handshake (IANA 0x11ec, default in Chrome / OpenSSL 3.5), concatenating a
  classical X25519 secret with the ML-KEM one so the session survives a break of either — both halves
  the lab's own from-scratch code. One new lab page (**ML-KEM**, `/mlkem`): a parameter-set switch, the
  short-secret centered-binomial histogram, KeyGen/Encaps/Decaps byte by byte, a live implicit-rejection
  toggle, a size comparison vs X25519, and the hybrid-handshake flow. Self-test grew 241 → **260/260**
  across **49 subsystems** (SHA-3, ML-KEM, Hybrid KEM). Every module verified in Node via a strip-types
  harness (NTT invert + convolution identity, KEM round-trips + exact sizes + implicit rejection for all
  three sets, hybrid agreement + tamper) before wiring the UI — no new dependencies, still zero crypto
  deps. Lint + build green via verify-project.mjs.
- 2026-07-03 (claude): **Secure two-party computation — oblivious transfer + Yao's garbled circuits,
  from scratch.** Added the lab's first *secure-computation* pillar: until now every module protected a
  value (an unforgeable signature, an unreadable ciphertext, a revealing-nothing proof), but nothing let
  two distrustful parties **compute together on inputs they never share**. Four new engine modules, each
  pinned against a plaintext oracle before any UI. (1) `ot.ts`: **Chou–Orlandi 1-of-2 oblivious
  transfer** on this lab's Ed25519 prime-order group — sender `S = y·B`, receiver `R = x·B + c·S`, and
  transcript-bound branch keys that agree with the receiver's `H(x·S)` only on the branch it secretly
  chose, so the sender learns nothing about `c` and the other message stays sealed; plus a batched form
  (one reusable `S`, one OT per bit) for the garbler. (2) `circuit.ts`: a boolean-circuit builder over
  `{AND, XOR, INV}` with derived OR/MUX and gadgets — full/ripple adders, an MSB→LSB comparator, an
  equality test, a schoolbook multiplier — plus a plaintext reference evaluator. (3) `garble.ts`:
  **Yao's garbled circuits** with **free-XOR** (a global Δ making XOR/NOT cost zero ciphertext) and
  **half-gates** (ZRE'15 — an AND is exactly two 128-bit ciphertexts, the proven minimum), point-and-
  permute select bits, and labels from the lab's SHA-256; the half-gate generator/evaluator formulas
  were derived and then verified from the inside. (4) `twopc.ts`: the whole protocol wired together —
  garble → send tables + Alice's labels → OT for Bob's input bits → evaluate → decode — exposed as
  `runMillionaires`/`runEquality`/`runSum`/`runProduct`, plus a **1-of-N OT** (`otOneOfN`, Naor–Pinkas
  bit-decomposition from ⌈log₂N⌉ base OTs) and a sealed-bid **second-price (Vickrey) auction**
  (`auctionCircuit`/`runAuction` — reveal the winner and the price, min of the two bids, not the bids),
  each returning an auditable transcript and an agreement flag vs the plaintext. One new lab page
  (**Secure 2PC**, `/mpc`), five panels: an OT demo, Yao's Millionaires' Problem on sliders with a full
  cost transcript, a garbled-gate anatomy view with a live single-byte-tamper integrity demo, the same
  protocol swapped onto equality/sum/product, and the sealed-bid auction. Self-test grew 260 →
  **278/278** across **52 subsystems** (Oblivious Transfer, Garbled Circuits, 2PC) — OT branch correctness
  (incl. 1-of-N), every elementary gate's truth table, all three demo circuits garbled exactly over
  *every* 4-bit input pair, full end-to-end 2PC runs, and the auction (win + tie). Verified in Node via
  vite-lib bundle harnesses (17 + 7 assertions, incl. exhaustive garble correctness, full 2PC over every
  4-bit pair, 1-of-N OT, and the auction) before wiring the UI. No new dependencies, still zero crypto
  deps. Lint + build green via verify-project.mjs.
- 2026-07-03 (claude): **GMW — secure computation the other way (secret sharing), from scratch.** The
  Secure-2PC lab had only one of the two great MPC families (garbled circuits); this adds the other.
  `gmw.ts` implements semi-honest two-party **GMW**: every wire value is kept XOR-shared between Alice
  and Bob (each input split so the other's share is uniform), XOR and NOT gates are purely local, and
  each **AND gate is resolved by a single 1-of-4 oblivious transfer** — Bob draws his output share `r`
  and tabulates `r ⊕ ((xᴬ⊕xᴮ)∧(yᴬ⊕yᴮ))` over Alice's four possible `(xᴬ,yᴬ)`, she selects her row via
  the merged `otOneOfN`, and `cᴬ ⊕ cᴮ = x∧y`; the output is reconstructed by XORing the final shares.
  It runs the *same* `circuit.ts` circuits as the garbled path, so the lab now shows both paradigms side
  by side and proves they agree. A sixth `/mpc` panel runs the Millionaires' comparator under GMW on
  demand (a real public-key OT per AND gate makes it a click, not a live slider), showing the winner
  reconstructed from the shares and the AND-gate/OT count. Self-test grew 278 → **284/284** across **53
  subsystems** with a new **MPC · GMW** group — every gate on shares, a 2-bit comparator exhaustively, a
  cross-paradigm agreement check (GMW output = garbled-circuit output on the same statement), and a GMW
  private sum. Verified in Node (gates + 2-bit exhaustive + representative larger runs) before wiring the
  UI. No new dependencies, still zero crypto deps. Lint + build green via verify-project.mjs.
