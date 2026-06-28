import { useMemo, useState } from 'react'
import { PageHead, Panel, Verdict } from '../ui/components'
import {
  TARGET,
  targetCurve,
  targetG,
  makeBrokenOracle,
  makeSafeOracle,
  targetPubkey,
  invalidCurveAttack,
} from '../ecc/invalid'
import { fmtPoint, type Point } from '../ecc/curve'

export function InvalidCurvePage() {
  const [secret, setSecret] = useState(7777)
  const d = ((secret % Number(TARGET.n)) + Number(TARGET.n)) % Number(TARGET.n) || 1

  const { attack, pub, recoveredOk, safeRejects } = useMemo(() => {
    const oracle = makeBrokenOracle(BigInt(d))
    const attack = invalidCurveAttack(oracle)
    const pub = targetPubkey(BigInt(d))
    const recoveredOk =
      attack.recovered !== null &&
      pointEq(targetCurve.multiply(attack.recovered, targetG), pub)
    const safe = makeSafeOracle(BigInt(d))
    const safeRejects = attack.hits.every((h) => safe(h.point) === 'rejected')
    return { attack, pub, recoveredOk, safeRejects }
  }, [d])

  return (
    <main className="page">
      <PageHead eyebrow="Lab 15 — one missing check" title="The Invalid-Curve Attack">
        The chord-and-tangent addition law for <code>y² = x³ + ax + b</code> never uses{' '}
        <code>b</code>. So a victim who computes <code>d·Q</code> on an attacker-supplied point —
        without checking it is on the real curve — is tricked into doing the math on a{' '}
        <em>different</em> curve <code>y² = x³ + ax + b′</code> of the attacker's choosing. Pick
        invalid curves with tiny subgroups, send points of small prime order <code>ℓ</code>, and each
        reply leaks <code>d mod ℓ</code>. The CRT stitches the residues into the whole key. This is a
        real CVE class (ECDH without point validation), reproduced here end to end.
      </PageHead>

      <Panel
        title="The target — a strong, prime-order curve"
        sub="Nothing is wrong with the curve. The bug is entirely in a verifier that skips the on-curve check."
      >
        <dl className="kv">
          <dt>curve</dt>
          <dd className="mono">y² = x³ + {TARGET.a.toString()}x + {TARGET.b.toString()} over 𝔽<sub>{TARGET.p.toString()}</sub></dd>
          <dt>group order n (prime)</dt>
          <dd className="mono">{TARGET.n.toString()}</dd>
          <dt>generator G</dt>
          <dd className="mono">{fmtPoint(targetG)}</dd>
          <dt>public key Q = d·G</dt>
          <dd className="mono">{fmtPoint(pub)}</dd>
        </dl>
        <div className="field" style={{ marginTop: '0.8rem' }}>
          <label>
            <span>victim's secret key d (hidden from the attacker)</span>
            <span className="val">{d}</span>
          </label>
          <input
            type="range"
            min={1}
            max={Number(TARGET.n) - 1}
            value={d}
            onChange={(e) => setSecret(Number(e.target.value))}
          />
        </div>
        <div className="note">
          A frontal attack would need to solve the discrete log <code>Q = d·G</code> in a prime group
          of order {TARGET.n.toString()} — about √n work. The invalid-curve attack sidesteps it
          entirely.
        </div>
      </Panel>

      <Panel
        title="The attack — leak d one small prime at a time"
        sub="Each row is one oracle query: a malicious point Q′ of prime order ℓ on an invalid curve, and the residue d mod ℓ read off from the reply."
      >
        <div style={{ overflowX: 'auto' }}>
          <table className="data">
            <thead>
              <tr>
                <th>invalid curve b′</th>
                <th>|E<sub>b′</sub>|</th>
                <th>prime ℓ</th>
                <th>malicious Q′ (order ℓ)</th>
                <th>oracle d·Q′</th>
                <th>d mod ℓ</th>
              </tr>
            </thead>
            <tbody>
              {attack.hits.map((h, i) => (
                <tr key={i}>
                  <td className="mono">{h.bPrime.toString()}</td>
                  <td className="mono">{h.invalidOrder.toString()}</td>
                  <td className="mono" style={{ color: '#fbbf24' }}>{h.prime.toString()}</td>
                  <td className="mono">{fmtPoint(h.point)}</td>
                  <td className="mono">{fmtPoint(h.oracleResult)}</td>
                  <td className="mono" style={{ color: '#5eead4' }}>{h.residue.toString()}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="note" style={{ marginTop: '0.5rem' }}>
          {attack.queries} oracle queries; the residues lock the key modulo{' '}
          <code className="mono">∏ℓ = {attack.modulus.toString()}</code>
          {attack.pinned ? ' ≥ n — enough to determine d uniquely.' : ' — not yet enough.'}
        </div>
      </Panel>

      <Panel title="CRT recombination → the private key" sub="Glue the residues d mod ℓ into one value modulo their product, then reduce mod n.">
        <dl className="kv">
          <dt>recovered d</dt>
          <dd className="hexbox violet" style={{ gridColumn: '1 / -1' }}>{attack.recovered?.toString() ?? '—'}</dd>
          <dt>actual d</dt>
          <dd className="hexbox" style={{ gridColumn: '1 / -1' }}>{d}</dd>
        </dl>
        <div style={{ marginTop: '0.7rem', display: 'flex', gap: '0.8rem', flexWrap: 'wrap' }}>
          <Verdict ok={recoveredOk}>
            {recoveredOk ? 'recovered key reproduces the public key Q ✓ — full compromise' : 'incomplete'}
          </Verdict>
        </div>
      </Panel>

      <Panel
        title="The fix — validate the point"
        sub="A single on-curve check defeats the entire attack: every malicious point is off the real curve, so a correct implementation rejects it before any scalar multiplication."
      >
        <Verdict ok={safeRejects}>
          {safeRejects
            ? 'a verifier that checks isOnCurve(Q) rejects all malicious points ✓'
            : 'something slipped through'}
        </Verdict>
        <div className="note" style={{ marginTop: '0.5rem' }}>
          Real libraries also clear the cofactor and use x-only Montgomery ladders (as in X25519,
          where every 32-byte string is a valid public key) to make this whole class of bug
          structurally impossible.
        </div>
      </Panel>
    </main>
  )
}

function pointEq(P: Point, Q: Point): boolean {
  return P === null || Q === null ? P === Q : P.x === Q.x && P.y === Q.y
}
