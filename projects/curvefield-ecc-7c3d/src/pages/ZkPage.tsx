import { useMemo, useState } from 'react'
import { PageHead, Panel, Slider, Verdict } from '../ui/components'
import {
  H,
  commit,
  provePoK,
  verifyPoK,
  proveDleq,
  verifyDleq,
  proveRange,
  verifyRange,
  hashToCurve,
} from '../ecc/sigma'
import { secp256k1, N } from '../ecc/secp256k1'
import { seedRng, randomScalar } from '../ecc/rng'
import { hex } from '../ui/format'

export function ZkPage() {
  const [seed, setSeed] = useState(1)

  // ── Schnorr proof of knowledge ──
  const pok = useMemo(() => {
    seedRng(seed * 13 + 1)
    const x = randomScalar(N) || 1n
    const { P, proof } = provePoK(x)
    return { x, P, proof, ok: verifyPoK(P, proof), forged: verifyPoK(secp256k1.multiply(2n, P), proof) }
  }, [seed])

  // ── Chaum–Pedersen DLEQ ──
  const dleq = useMemo(() => {
    seedRng(seed * 29 + 7)
    const base2 = hashToCurve('Curvefield/zk/dleq-base')
    const x = randomScalar(N) || 1n
    const { P, Q, proof } = proveDleq(x, base2)
    const ok = verifyDleq(P, Q, base2, proof)
    // A "lie": claim equality for a Q′ with a different discrete log.
    const Qbad = secp256k1.add(Q, base2)
    const lieRejected = !verifyDleq(P, Qbad, base2, proof)
    return { base2, P, Q, proof, ok, lieRejected }
  }, [seed])

  // ── Range proof ──
  const [bits, setBits] = useState(8)
  const [value, setValue] = useState(45)
  const range = useMemo(() => {
    seedRng(seed * 131 + value + bits)
    const v = BigInt(value % (1 << bits))
    const proof = proveRange(v, bits)
    const ok = verifyRange(proof)
    // Soundness: forge the commitment to a value outside the bits and watch it break.
    const tampered = {
      ...proof,
      V: secp256k1.add(proof.V, secp256k1.multiply(1n << BigInt(bits), commit(1n, randomScalar(N) || 1n))),
    }
    const forgeRejected = !verifyRange(tampered)
    return { v, proof, ok, forgeRejected }
  }, [seed, value, bits])

  return (
    <main className="page">
      <PageHead eyebrow="Lab 18 — proving without revealing" title="Zero-Knowledge Σ-Protocols">
        A <em>Σ-protocol</em> lets a prover convince a verifier that a statement is true while
        revealing nothing else. The pattern is always the same — commit, be challenged, respond —
        and the Fiat–Shamir heuristic replaces the verifier's coin with a hash of the transcript, so
        each proof becomes a self-contained object anyone can check offline. Built on secp256k1 and a
        second generator <code>H</code> with unknown discrete log to <code>G</code>, so a Pedersen
        commitment <code>Com(m,r) = m·G + r·H</code> hides <code>m</code> perfectly yet binds the
        committer to it.
      </PageHead>

      <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: '0.8rem' }}>
        <button className="btn" onClick={() => setSeed((s) => s + 1)}>↻ new randomness</button>
      </div>

      <Panel
        title="The NUMS generator H"
        sub="Hashed onto the curve so nobody knows log_G(H) — the binding ingredient of every Pedersen commitment below."
      >
        <dl className="kv">
          <dt>H = hash-to-curve(\"Pedersen/H\")</dt>
          <dd className="hexbox" style={{ gridColumn: '1 / -1' }}>{H ? hex(H.x, 64) : '—'}</dd>
          <dt>on the curve?</dt>
          <dd><Verdict ok={secp256k1.isOnCurve(H)}>{secp256k1.isOnCurve(H) ? 'yes' : 'no'}</Verdict></dd>
        </dl>
      </Panel>

      <Panel
        title="① Schnorr — proof of knowledge of a discrete log"
        sub="Prove you know x with P = x·G. Transcript: T = k·G, challenge c = H(G,P,T), response s = k + c·x. Verify s·G ?= T + c·P."
      >
        <dl className="kv">
          <dt>statement P (x)</dt>
          <dd className="hexbox" style={{ gridColumn: '1 / -1' }}>{pok.P ? hex(pok.P.x, 64) : '—'}</dd>
          <dt>commitment T (x)</dt>
          <dd className="hexbox">{pok.proof.T ? hex(pok.proof.T.x, 16) : '—'}…</dd>
          <dt>response s</dt>
          <dd className="hexbox">{hex(pok.proof.s, 16)}…</dd>
          <dt>proof valid</dt>
          <dd><Verdict ok={pok.ok}>{pok.ok ? 'verifies ✓' : 'no'}</Verdict></dd>
          <dt>same proof vs. a different P</dt>
          <dd><Verdict ok={!pok.forged}>{pok.forged ? 'accepted (!)' : 'rejected ✓'}</Verdict></dd>
        </dl>
        <div className="note" style={{ marginTop: '0.5rem' }}>
          The verifier learns that <code>x</code> exists and is known to the prover — but not a single
          bit of <code>x</code> itself.
        </div>
      </Panel>

      <Panel
        title="② Chaum–Pedersen — equality of two discrete logs (DLEQ)"
        sub="Prove log_G(P) = log_H₂(Q) without revealing the shared exponent. The workhorse behind VRFs, verifiable shuffles and DLEQ-based oracles."
      >
        <dl className="kv">
          <dt>P = x·G (x)</dt>
          <dd className="hexbox">{dleq.P ? hex(dleq.P.x, 14) : '—'}…</dd>
          <dt>Q = x·H₂ (x)</dt>
          <dd className="hexbox">{dleq.Q ? hex(dleq.Q.x, 14) : '—'}…</dd>
          <dt>equality proof valid</dt>
          <dd><Verdict ok={dleq.ok}>{dleq.ok ? 'verifies ✓' : 'no'}</Verdict></dd>
          <dt>false equality claim</dt>
          <dd><Verdict ok={dleq.lieRejected}>{dleq.lieRejected ? 'rejected ✓' : 'accepted (!)'}</Verdict></dd>
        </dl>
      </Panel>

      <Panel
        title="③ Range proof — a committed value lies in [0, 2ⁿ)"
        sub="Commit to v, then to each of its bits, and OR-prove every bit commitment opens to 0 or 1. V = Σ 2ⁱ·Bᵢ ties the bits to v. The same bit-decomposition Bulletproofs later compresses to log size."
      >
        <div className="grid cols-2" style={{ gap: '1rem' }}>
          <Slider label="bit width n" value={bits} min={4} max={16} onChange={setBits} />
          <Slider
            label="secret value v"
            value={value % (1 << bits)}
            min={0}
            max={(1 << bits) - 1}
            onChange={setValue}
            display={`${value % (1 << bits)}`}
          />
        </div>
        <dl className="kv" style={{ marginTop: '0.8rem' }}>
          <dt>commitment V = Com(v, r) (x)</dt>
          <dd className="hexbox lavender" style={{ gridColumn: '1 / -1' }}>{range.proof.V ? hex(range.proof.V.x, 64) : '—'}</dd>
          <dt>bit commitments</dt>
          <dd>{range.proof.bits} × OR-proofs</dd>
          <dt>range proof valid</dt>
          <dd><Verdict ok={range.ok}>{range.ok ? `0 ≤ v < 2^${bits} ✓` : 'no'}</Verdict></dd>
          <dt>forged commitment (v ≥ 2ⁿ)</dt>
          <dd><Verdict ok={range.forgeRejected}>{range.forgeRejected ? 'rejected ✓' : 'accepted (!)'}</Verdict></dd>
        </dl>
        <div className="bitrow" style={{ display: 'flex', gap: '4px', flexWrap: 'wrap', marginTop: '0.8rem' }}>
          {range.proof.bitProofs.map((_, i) => (
            <span
              key={i}
              className="tag ok"
              title={`bit ${i} OR-proof verified`}
              style={{ minWidth: 'unset', padding: '2px 7px' }}
            >
              b{i}✓
            </span>
          ))}
        </div>
        <div className="note" style={{ marginTop: '0.5rem' }}>
          The verifier confirms the value fits in <code>{bits}</code> bits and never learns which
          value it is. Real confidential-transaction systems prove exactly this so an amount can be
          hidden yet provably non-negative.
        </div>
      </Panel>
    </main>
  )
}
