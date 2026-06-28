import { useMemo, useState } from 'react'
import { PageHead, Panel, Slider, Verdict } from '../ui/components'
import { fmtPoint } from '../ecc/curve'
import { pohligHellman, findSmoothCurve } from '../ecc/pohlig'

export function PohligHellman() {
  const [k, setK] = useState(523)

  // A deliberately weak curve: smooth group order, all prime factors ≤ 13.
  const weak = useMemo(() => findSmoothCurve(13n, 800, 8000), [])
  const ord = weak ? Number(weak.order) : 1
  const secret = ((k % ord) + ord) % ord || 1
  const Q = weak ? weak.curve.multiply(BigInt(secret), weak.G) : null
  const result = useMemo(
    () => (weak && Q ? pohligHellman(weak.curve, weak.G, Q, weak.order) : null),
    [weak, Q],
  )

  if (!weak || !Q || !result) {
    return (
      <main className="page">
        <PageHead eyebrow="Lab 08" title="Pohlig–Hellman">
          Could not find a smooth curve in range.
        </PageHead>
      </main>
    )
  }

  const { curve, G, order, factors } = weak
  const frontal = Math.round(Math.sqrt(ord))

  return (
    <main className="page">
      <PageHead eyebrow="Lab 08 — why order must be prime" title="Pohlig–Hellman">
        The discrete log is only as strong as the <em>largest prime factor</em> of the group order.
        If the order is <strong>smooth</strong> — a product of small primes — Pohlig–Hellman shatters
        the problem into one tiny discrete log per prime power, solves each with baby-step giant-step,
        and reassembles the answer with the Chinese Remainder Theorem. This curve was hand-picked to
        be weak; secp256k1's order is a 256-bit prime precisely so this attack has nothing to bite.
      </PageHead>

      <div className="statline" style={{ marginBottom: '1.4rem' }}>
        <div className="stat"><b>y²=x³+{curve.a.toString()}x+{curve.b.toString()}</b><span>over F<sub>{curve.p.toString()}</sub></span></div>
        <div className="stat"><b>{order.toString()}</b><span>group order (smooth)</span></div>
        <div className="stat"><b>{factors.map((f) => `${f.prime}${f.exp > 1 ? '^' + f.exp : ''}`).join(' · ')}</b><span>factorization</span></div>
        <div className="stat"><b>{result.largestPrime.toString()}</b><span>largest prime factor</span></div>
      </div>

      <Panel
        title="The target"
        sub="A secret scalar multiplies the generator. Slide it; the attack re-runs live."
      >
        <Slider
          label="secret k"
          value={k}
          min={2}
          max={ord - 1}
          display={`${secret}`}
          onChange={setK}
        />
        <dl className="kv">
          <dt>generator P</dt>
          <dd className="mono">{fmtPoint(G)}</dd>
          <dt>public Q = k·P</dt>
          <dd className="mono">{fmtPoint(Q)}</dd>
        </dl>
      </Panel>

      <Panel
        title="Divide — one small discrete log per prime power"
        sub="In each subgroup of prime-power order, k is recovered digit by digit; the cost is √p, not √n."
      >
        <table className="data">
          <thead>
            <tr>
              <th>prime power pᵉ</th>
              <th>subgroup generator (n/pᵉ)·P</th>
              <th>base-p digits of k</th>
              <th>k mod pᵉ</th>
              <th>BSGS steps</th>
            </tr>
          </thead>
          <tbody>
            {result.sub.map((s, i) => (
              <tr key={i}>
                <td className="mono">
                  {s.prime.toString()}
                  {s.exp > 1 ? <sup>{s.exp}</sup> : ''} = {s.power.toString()}
                </td>
                <td className="mono">{fmtPoint(curve.multiply(order / s.power, G))}</td>
                <td className="mono">[{s.digits.map((d) => d.toString()).join(', ')}]</td>
                <td className="mono">{s.residue.toString()}</td>
                <td className="mono">{s.steps}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Panel>

      <Panel
        title="Conquer — glue with the Chinese Remainder Theorem"
        sub="The per-factor residues pin down a single k modulo the full order."
      >
        <div className="mono note" style={{ lineHeight: 1.9, marginBottom: '0.8rem' }}>
          {result.sub.map((s, i) => (
            <div key={i}>
              k ≡ {s.residue.toString()} (mod {s.power.toString()})
            </div>
          ))}
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.8rem', flexWrap: 'wrap' }}>
          <Verdict ok={result.k === BigInt(secret)}>
            CRT ⇒ k = {result.k?.toString() ?? '—'}
          </Verdict>
          <span className="note">
            total cost {result.totalSteps} steps — a frontal baby-step giant-step on the whole group
            would need ≈ √{order.toString()} ≈ {frontal}. Smoothness turned a{' '}
            {Math.round((frontal / Math.max(1, result.totalSteps)) * 10) / 10}× harder problem into
            child's play.
          </span>
        </div>
      </Panel>
    </main>
  )
}
