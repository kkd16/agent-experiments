import { useMemo, useState } from 'react'
import { PageHead, Panel, Verdict } from '../ui/components'
import { musigSign, verifyPartial, makeSigner } from '../ecc/musig'
import { schnorrVerify, secp256k1, N } from '../ecc/secp256k1'
import { bytesToHex, utf8 } from '../ecc/sha256'
import { randomScalar } from '../ecc/rng'
import { hex } from '../ui/format'

const COLORS = ['#b794f6', '#5eead4', '#fbbf24', '#fb7185', '#60a5fa']

export function MuSigPage() {
  const [n, setN] = useState(2)
  const [msg, setMsg] = useState('Pay 1 BTC from our shared vault')
  const [seed, setSeed] = useState(0)

  // Independent secret keys, regenerated on demand.
  const secrets = useMemo(() => {
    void seed
    return Array.from({ length: n }, () => randomScalar(N))
  }, [n, seed])

  const msgBytes = useMemo(() => utf8(msg), [msg])
  const res = useMemo(() => musigSign(secrets, msgBytes), [secrets, msgBytes])

  const aggValid = useMemo(
    () => schnorrVerify(res.keyagg.xonly, msgBytes, res.sig),
    [res, msgBytes],
  )
  const partialsValid = useMemo(
    () => secrets.map((_, i) => verifyPartial(res, i, msgBytes)),
    [res, secrets, msgBytes],
  )

  // The rogue-key contrast: the naive sum of public keys ≠ the MuSig aggregate.
  const naive = useMemo(() => {
    let X = null
    for (const s of secrets) X = secp256k1.add(X, makeSigner(s).P)
    return X
  }, [secrets])

  return (
    <main className="page">
      <PageHead eyebrow="Lab 09 — many keys, one signature" title="MuSig2 Aggregation">
        Because Schnorr is linear, <code>n</code> signers can fold their keys into one aggregate key
        and their signatures into one 64-byte signature that a verifier checks exactly like a
        single-signer BIP-340 signature — the basis of Bitcoin Taproot multisig. The catch is the{' '}
        <em>rogue-key attack</em>: a naive key sum lets the last signer choose a key that cancels the
        others and steal sole control. MuSig2 stops it by weighting every key with a coefficient{' '}
        <code>aᵢ = H(L, Pᵢ)</code> that no one can game.
      </PageHead>

      <div className="seg" style={{ marginBottom: '1rem' }}>
        {[2, 3, 4, 5].map((v) => (
          <button key={v} className={n === v ? 'on' : ''} onClick={() => setN(v)}>
            {v} signers
          </button>
        ))}
      </div>

      <Panel
        title="The message"
        right={
          <button className="btn" onClick={() => setSeed((s) => s + 1)}>
            ↻ new keys
          </button>
        }
      >
        <input value={msg} onChange={(e) => setMsg(e.target.value)} />
      </Panel>

      <Panel
        title="Round 0 — key aggregation"
        sub="Each signer's key is scaled by its coefficient, then summed. L commits to the whole set."
      >
        <table className="data">
          <thead>
            <tr>
              <th>signer</th>
              <th>public key Pᵢ (x)</th>
              <th>coefficient aᵢ = H(L, Pᵢ)</th>
            </tr>
          </thead>
          <tbody>
            {res.signers.map((s, i) => (
              <tr key={i}>
                <td style={{ color: COLORS[i] }}>#{i + 1}</td>
                <td className="mono">{hex(s.P ? s.P.x : 0n, 16)}…</td>
                <td className="mono">{hex(res.keyagg.coeffs[i], 16)}…</td>
              </tr>
            ))}
          </tbody>
        </table>
        <dl className="kv" style={{ marginTop: '0.8rem' }}>
          <dt>aggregate key X (x-only)</dt>
          <dd className="hexbox violet" style={{ gridColumn: '1 / -1' }}>{hex(res.keyagg.xonly, 64)}</dd>
          <dt>naive Σ Pᵢ (insecure)</dt>
          <dd className="hexbox" style={{ gridColumn: '1 / -1' }}>{naive ? hex(naive.x, 64) : '—'}</dd>
        </dl>
        <div className="note" style={{ marginTop: '0.4rem' }}>
          The two differ — the coefficients are exactly what makes the aggregate key
          rogue-key-resistant.
        </div>
      </Panel>

      <Panel
        title="Rounds 1 & 2 — nonces, challenge, partial signatures"
        sub="Two aggregate nonces R₁, R₂ are bound by b = H(X, R₁, R₂, m); the effective nonce is R = R₁ + b·R₂."
      >
        <dl className="kv">
          <dt>aggregate nonce R (x)</dt>
          <dd className="hexbox" style={{ gridColumn: '1 / -1' }}>{hex(res.Rx, 64)}</dd>
          <dt>nonce coef b</dt>
          <dd className="hexbox" style={{ gridColumn: '1 / -1' }}>{hex(res.b, 32)}…</dd>
          <dt>challenge e</dt>
          <dd className="hexbox" style={{ gridColumn: '1 / -1' }}>{hex(res.e, 32)}…</dd>
        </dl>
        <table className="data" style={{ marginTop: '0.8rem' }}>
          <thead>
            <tr>
              <th>signer</th>
              <th>partial sᵢ = (k₁+b·k₂) + e·aᵢ·xᵢ</th>
              <th>valid?</th>
            </tr>
          </thead>
          <tbody>
            {res.partials.map((si, i) => (
              <tr key={i}>
                <td style={{ color: COLORS[i] }}>#{i + 1}</td>
                <td className="mono">{hex(si, 18)}…</td>
                <td>
                  <Verdict ok={partialsValid[i]}>{partialsValid[i] ? 'ok' : 'bad'}</Verdict>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Panel>

      <Panel title="The aggregate signature" sub="Σ sᵢ, paired with R.x, is a plain BIP-340 signature.">
        <dl className="kv">
          <dt>signature (64 bytes)</dt>
          <dd className="hexbox lavender" style={{ gridColumn: '1 / -1' }}>{bytesToHex(res.sig)}</dd>
        </dl>
        <div style={{ marginTop: '0.8rem', display: 'flex', alignItems: 'center', gap: '0.8rem' }}>
          <Verdict ok={aggValid}>
            {aggValid ? 'verifies under BIP-340 ✓' : 'invalid'}
          </Verdict>
          <span className="note">
            The verifier ran the ordinary single-key Schnorr check against X — it has no idea {n}{' '}
            parties were involved. That indistinguishability is the privacy win of Taproot.
          </span>
        </div>
      </Panel>
    </main>
  )
}
