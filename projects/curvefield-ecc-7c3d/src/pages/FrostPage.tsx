import { useMemo, useState } from 'react'
import { PageHead, Panel, Slider, Verdict } from '../ui/components'
import { keygen, commitNonces, sign, verifyPartial } from '../ecc/frost'
import { schnorrVerify } from '../ecc/secp256k1'
import { bytesToHex, utf8 } from '../ecc/sha256'
import { seedRng } from '../ecc/rng'
import { hex } from '../ui/format'

const COLORS = ['#b794f6', '#5eead4', '#fbbf24', '#fb7185', '#60a5fa', '#34d399', '#f472b6']

export function FrostPage() {
  const [n, setN] = useState(5)
  const [t, setT] = useState(3)
  const [msg, setMsg] = useState('Move 10 BTC from the 3-of-5 treasury')
  const [seed, setSeed] = useState(1)
  const [picked, setPicked] = useState<number[]>([0, 2, 3])

  const tt = Math.min(t, n)
  const keys = useMemo(() => {
    seedRng(seed * 7919 + n * 31 + tt)
    return keygen(tt, n)
  }, [n, tt, seed])

  const msgBytes = useMemo(() => utf8(msg), [msg])

  // Round 1: every picked signer publishes nonce commitments.
  const session = useMemo(() => {
    seedRng(seed * 104729 + picked.reduce((a, b) => a + b, 0) + msg.length)
    const signers = picked
      .filter((i) => i < keys.shares.length)
      .map((i) => ({ commit: commitNonces(keys.shares[i].i), share: keys.shares[i] }))
    if (signers.length === 0) return null
    const sig = sign(keys, signers, msgBytes)
    return { signers, sig }
  }, [picked, keys, msgBytes, seed, msg])

  const valid = useMemo(
    () => (session ? schnorrVerify(keys.groupPubXonly, msgBytes, session.sig.sig) : false),
    [session, keys, msgBytes],
  )
  const partialsValid = useMemo(
    () =>
      session
        ? session.sig.partials.map((p, k) => verifyPartial(keys, session.sig, session.signers[k], p))
        : [],
    [session, keys],
  )

  const enough = picked.length >= tt
  const toggle = (i: number) =>
    setPicked((c) => (c.includes(i) ? c.filter((x) => x !== i) : [...c, i]))

  return (
    <main className="page">
      <PageHead eyebrow="Lab 17 — t-of-n, one signature" title="FROST Threshold Schnorr">
        A group shares one secret key — split with Shamir, so no party ever holds it whole — yet any{' '}
        <code>t</code> of them jointly produce a single 64-byte signature that verifies under one
        group key with the <em>ordinary</em> BIP-340 check. The danger in naive two-round threshold
        Schnorr is the Drijvers/ROS forgery; FROST defeats it with per-signer <em>binding factors</em>{' '}
        <code>ρᵢ = H(i, m, B)</code> that tie each nonce to the whole commitment set <code>B</code>.
        Each signer contributes a Lagrange-weighted partial, and the partials sum to a valid Schnorr
        scalar.
      </PageHead>

      <Panel
        title="Trusted-dealer key generation"
        sub="One Shamir sharing of a random group key. A real deployment replaces this with a distributed key generation; the signing protocol below is unchanged."
        right={
          <button className="btn" onClick={() => setSeed((s) => s + 1)}>
            ↻ new group
          </button>
        }
      >
        <div className="grid cols-2" style={{ gap: '1rem' }}>
          <Slider label="parties n" value={n} min={2} max={7} onChange={(v) => { setN(v); setT((x) => Math.min(x, v)); }} />
          <Slider label="threshold t" value={tt} min={1} max={n} onChange={setT} />
        </div>
        <dl className="kv" style={{ marginTop: '0.8rem' }}>
          <dt>group public key X (x-only)</dt>
          <dd className="hexbox violet" style={{ gridColumn: '1 / -1' }}>{hex(keys.groupPubXonly, 64)}</dd>
        </dl>
      </Panel>

      <Panel
        title="Pick the signers"
        sub={`Choose which parties come online to sign. Any ${tt} of the ${n} suffice; fewer cannot.`}
      >
        <div className="seg" style={{ flexWrap: 'wrap' }}>
          {keys.shares.map((_, i) => (
            <button key={i} className={picked.includes(i) ? 'on' : ''} onClick={() => toggle(i)}>
              <span style={{ color: COLORS[i % COLORS.length] }}>●</span> party #{i + 1}
            </button>
          ))}
        </div>
        <div style={{ marginTop: '0.7rem' }}>
          <Verdict ok={enough}>
            {enough ? `${picked.length} signers — quorum met` : `need ${tt - picked.length} more for a quorum`}
          </Verdict>
        </div>
        <input value={msg} onChange={(e) => setMsg(e.target.value)} style={{ marginTop: '0.8rem' }} />
      </Panel>

      {session && (
        <>
          <Panel
            title="Rounds 1 & 2 — commitments, binding, partials"
            sub="Each signer's (Dᵢ, Eᵢ) bind into ρᵢ; the group nonce is R = Σ (Dᵢ + ρᵢ·Eᵢ); the challenge is c = H(Rx, X, m)."
          >
            <dl className="kv">
              <dt>group nonce R (x)</dt>
              <dd className="hexbox" style={{ gridColumn: '1 / -1' }}>{hex(session.sig.Rx, 64)}</dd>
              <dt>challenge c</dt>
              <dd className="hexbox" style={{ gridColumn: '1 / -1' }}>{hex(session.sig.c, 32)}…</dd>
            </dl>
            <table className="data" style={{ marginTop: '0.8rem' }}>
              <thead>
                <tr>
                  <th>signer</th>
                  <th>binding ρᵢ</th>
                  <th>Lagrange λᵢ</th>
                  <th>partial zᵢ</th>
                  <th>valid?</th>
                </tr>
              </thead>
              <tbody>
                {session.sig.partials.map((p, k) => (
                  <tr key={k}>
                    <td style={{ color: COLORS[picked[k] % COLORS.length] }}>#{picked[k] + 1}</td>
                    <td className="mono">{hex(p.rho, 10)}…</td>
                    <td className="mono">{hex(p.lambda, 10)}…</td>
                    <td className="mono">{hex(p.z, 12)}…</td>
                    <td><Verdict ok={partialsValid[k]}>{partialsValid[k] ? 'ok' : 'bad'}</Verdict></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Panel>

          <Panel title="The aggregate signature" sub="Rx ‖ Σ zᵢ — a plain 64-byte BIP-340 signature.">
            <dl className="kv">
              <dt>signature</dt>
              <dd className="hexbox lavender" style={{ gridColumn: '1 / -1' }}>{bytesToHex(session.sig.sig)}</dd>
            </dl>
            <div style={{ marginTop: '0.8rem', display: 'flex', gap: '0.8rem', alignItems: 'center', flexWrap: 'wrap' }}>
              <Verdict ok={valid}>
                {valid ? 'verifies under BIP-340 ✓' : enough ? 'invalid' : 'invalid — under threshold'}
              </Verdict>
              <span className="note" style={{ display: 'inline' }}>
                {enough
                  ? 'The verifier ran the ordinary single-key Schnorr check — it cannot tell a threshold signature from a single-signer one.'
                  : `With fewer than ${tt} signers the Lagrange weights reconstruct the wrong key, and the signature fails — exactly the threshold guarantee.`}
              </span>
            </div>
          </Panel>
        </>
      )}
    </main>
  )
}
