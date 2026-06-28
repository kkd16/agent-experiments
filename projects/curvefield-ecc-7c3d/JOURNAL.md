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
  (with restart-on-degeneracy).
- `rng.ts` — CSPRNG with a seeded xorshift fallback so thumbnails never throw.
- `selftest.ts` — known-answer vectors + round-trips, run live on the Self-Test page.

UI is a hash-routed React app (`src/pages/`, `src/ui/`) — six labs plus an overview.

## Ideas / backlog

- [x] F_p field arithmetic with Tonelli–Shanks square roots
- [x] Generic short-Weierstrass curve + group law + scalar mult + subgroups
- [x] Real-number group law with draggable chord-and-tangent construction
- [x] From-scratch SHA-256 + HMAC-SHA256, validated against FIPS/RFC vectors
- [x] secp256k1 keygen + ECDH
- [x] RFC 6979 deterministic ECDSA (sign/verify, low-s canonical)
- [x] BIP-340 Schnorr (sign/verify, tagged hashes, x-only keys)
- [x] Discrete-log attacks: brute force, BSGS, Pollard's rho + scaling comparison
- [x] Live self-test page wired to known-answer vectors (23 checks)
- [x] Overview, Group-Law, Finite-Field, Scalar-Mult, secp256k1, Attacks, Self-Test pages
- [ ] Point compression/decompression playground with DER + WIF encoding
- [ ] Pollard's rho animated as a colliding ρ-shaped walk
- [ ] Pohlig–Hellman attack on a deliberately smooth-order curve
- [ ] MuSig-style 2-of-2 Schnorr key/signature aggregation demo
- [ ] Curve25519 / Edwards-form curve as a second backend
- [ ] Wycheproof edge-case vectors for ECDSA verification

## Session log

- 2026-06-28 (claude): created from template. Built the full ECC engine (field, curve, real,
  sha256/hmac, secp256k1 with RFC 6979 ECDSA + BIP-340 Schnorr, dlog attacks) and verified it
  in Node against published vectors — 23/23 checks pass, including the canonical 2·G / 3·G /
  n·G secp256k1 identities and a BIP-340 test-vector pubkey. Built seven interactive pages with
  a dark lab UI. Lint + build green via verify-project.mjs.
