import { useMemo } from 'react'
import { PageHead, Panel, Verdict } from '../ui/components'
import { runEdgeCases } from '../ecc/wycheproof'

export function EdgeCases() {
  const cases = useMemo(() => runEdgeCases(), [])
  const passed = cases.filter((c) => c.pass).length

  return (
    <main className="page">
      <PageHead eyebrow="Lab 11 — adversarial verification" title="Wycheproof-Style Edge Cases">
        Signing is the easy half. The dangerous bugs live in the <em>verifier</em>: a library that
        accepts a zero <code>r</code>, a malleated DER blob, or a key that isn't on the curve has a
        forgery or a denial-of-service hiding in it. Inspired by Google's Project Wycheproof, this
        page throws a battery of adversarial inputs at the same ECDSA verifier the rest of the lab
        uses, and asserts the single correct answer for each — accept the honest, reject the rest.
      </PageHead>

      <div className="statline" style={{ marginBottom: '1.4rem' }}>
        <div className="stat"><b>{passed}/{cases.length}</b><span>cases correct</span></div>
        <div className="stat"><b>range</b><span>r,s ∈ [1, n)</span></div>
        <div className="stat"><b>strict DER</b><span>BIP-66 canonical</span></div>
        <div className="stat"><b>low-s</b><span>BIP-62/146 policy</span></div>
      </div>

      <Panel title="The battery" sub="Each row feeds the verifier one adversarial input and checks the response.">
        <table className="data">
          <thead>
            <tr>
              <th>case</th>
              <th>what it probes</th>
              <th>expected</th>
              <th>result</th>
            </tr>
          </thead>
          <tbody>
            {cases.map((c, i) => (
              <tr key={i}>
                <td className="mono">{c.name}</td>
                <td>{c.detail}</td>
                <td>
                  <span className={'tag ' + (c.expected === 'accept' ? 'ok' : 'warn')}>
                    {c.expected}
                  </span>
                </td>
                <td>
                  <Verdict ok={c.pass}>{c.pass ? c.actual : `${c.actual} ✗`}</Verdict>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Panel>

      <Panel title="Why these specific cases" sub="Each maps to a real-world failure.">
        <ul className="lead" style={{ lineHeight: 1.8 }}>
          <li>
            <b>r = 0 / s = 0 / r,s ≥ n</b> — out-of-range scalars. Accepting them has produced
            universal-forgery bugs (the inverse or the recovery silently degenerates).
          </li>
          <li>
            <b>high-s twin</b> — every ECDSA signature has a malleable partner s′ = n − s. It is a
            valid signature mathematically, which is exactly why it broke Bitcoin transaction IDs
            until BIP-62/146 mandated low-s.
          </li>
          <li>
            <b>key not on the curve</b> — skipping the on-curve check enables invalid-curve attacks
            that can extract the private key over many queries.
          </li>
          <li>
            <b>non-canonical DER</b> — re-padded or trailing-byte encodings are a second malleability
            surface; strict parsing (BIP-66) is the fix.
          </li>
        </ul>
      </Panel>
    </main>
  )
}
