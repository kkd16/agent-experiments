import { useEffect, useState } from 'react'
import { PageHead, Panel, Verdict } from '../ui/components'
import {
  G1_GEN,
  G2_GEN,
  g1,
  g2,
  pairing,
  blsKeygen,
  blsSign,
  aggregateSigs,
  blsAggregateVerifyDistinct,
  blsFastAggregateVerify,
  g1Hex,
  hashToG1,
  type G1,
  type G2,
} from '../ecc/bls12381'
import { Fp12 } from '../ecc/fp12'
import { utf8 } from '../ecc/sha256'
import { ellipsize } from '../ui/format'

const COLORS = ['#b794f6', '#5eead4', '#fbbf24', '#fb7185', '#60a5fa']

// A compact view of an F_{p¹²} element — the bottom F_p coefficient, ellipsized.
function fp12Short(x: ReturnType<typeof pairing>): string {
  const c = x.c0.c0.a.toString(16).padStart(96, '0')
  return '0x' + c.slice(0, 10) + '…' + c.slice(-6)
}

interface Computed {
  key: string
  e: ReturnType<typeof pairing>
  bilinearOk: boolean
  lhsShort: string
  rhsShort: string
  signers: { color: string; msg: string; pk: G2; sig: G1 }[]
  aggSig: G1
  aggOk: boolean
  tamperOk: boolean
  fastOk: boolean
  rogueForges: boolean
  ms: number
}

const MESSAGES = [
  'block #840000 → Alice',
  'block #840000 → Bob',
  'epoch 31337 attestation',
  'withdraw 32 ETH',
  'finalize checkpoint',
]

export function BlsPage() {
  const [n, setN] = useState(3)
  const [seed, setSeed] = useState(0)
  const [a, setA] = useState(3)
  const [b, setB] = useState(5)
  const [res, setRes] = useState<Computed | null>(null)

  const key = `${n}-${seed}-${a}-${b}`
  const busy = !res || res.key !== key

  useEffect(() => {
    let alive = true
    // Defer the (heavy) pairing math off the paint so the spinner shows.
    const id = setTimeout(() => {
      const t0 = performance.now()

      // ── Bilinearity: e(aP, bQ) =?= e(P, Q)^(ab) ──
      const e = pairing(G1_GEN, G2_GEN)
      const lhs = pairing(g1.mul(BigInt(a), G1_GEN), g2.mul(BigInt(b), G2_GEN))
      const rhs = Fp12.pow(e, BigInt(a * b))
      const bilinearOk = Fp12.eq(lhs, rhs)

      // ── Aggregation over distinct messages ──
      const keys = Array.from({ length: n }, (_, i) => blsKeygen(BigInt(1000003 + seed * 97 + i * 7919)))
      const msgs = Array.from({ length: n }, (_, i) => MESSAGES[i])
      const sigs = keys.map((k, i) => blsSign(k.sk, utf8(msgs[i])))
      const aggSig = aggregateSigs(sigs)
      const aggOk = blsAggregateVerifyDistinct(keys.map((k) => k.pk), msgs.map(utf8), aggSig)
      // Tamper: flip one signer's message, aggregate must reject.
      const badMsgs = msgs.slice()
      badMsgs[0] = badMsgs[0] + '!'
      const tamperOk = !blsAggregateVerifyDistinct(keys.map((k) => k.pk), badMsgs.map(utf8), aggSig)

      // ── Common-message fast aggregation + rogue-key forgery ──
      const common = utf8('we all sign this exact block')
      const honestSigs = keys.map((k) => blsSign(k.sk, common))
      const fastOk = blsFastAggregateVerify(keys.map((k) => k.pk), common, aggregateSigs(honestSigs))
      const rogueForges = rogueKeyForgery(keys.map((k) => k.pk), common)

      if (!alive) return
      setRes({
        key,
        e,
        bilinearOk,
        lhsShort: fp12Short(lhs),
        rhsShort: fp12Short(rhs),
        signers: keys.map((k, i) => ({ color: COLORS[i], msg: msgs[i], pk: k.pk, sig: sigs[i] })),
        aggSig,
        aggOk,
        tamperOk,
        fastOk,
        rogueForges,
        ms: Math.round(performance.now() - t0),
      })
    }, 30)
    return () => {
      alive = false
      clearTimeout(id)
    }
  }, [n, seed, a, b, key])

  return (
    <main className="page">
      <PageHead eyebrow="Lab 12 — pairings & aggregate signatures" title="BLS12-381 & the Pairing">
        Everything so far used one group. A <em>pairing</em> is a map{' '}
        <code>e : G₁ × G₂ → G_T</code> that is <strong>bilinear</strong>:{' '}
        <code>e(a·P, b·Q) = e(P, Q)^(ab)</code>. That single identity lets a verifier check a
        product of secrets it never sees — the trick behind <strong>BLS signatures</strong>, where a
        whole committee's signatures collapse into one group element. BLS12-381 is the curve Ethereum,
        Zcash, Filecoin, and Chia run on. The pairing below is a hand-written optimal-ate Miller loop
        over a from-scratch F_p² ⊂ F_p⁶ ⊂ F_p¹² tower — no pairing library.
      </PageHead>

      {busy && (
        <div className="note" style={{ marginBottom: '1rem' }}>
          computing pairings (a Miller loop + final exponentiation in F_p¹²)…
        </div>
      )}

      {res && (
        <>
          <Panel
            title="Bilinearity, checked live"
            sub="Pick scalars a and b. The two sides are computed by completely different routes — yet they land on the same element of G_T."
            right={<span className="note">{res.ms} ms</span>}
          >
            <div className="seg" style={{ marginBottom: '0.8rem' }}>
              <span style={{ alignSelf: 'center', marginRight: '0.5rem', color: 'var(--ink-dim)' }}>a =</span>
              {[2, 3, 5, 7].map((v) => (
                <button key={v} className={a === v ? 'on' : ''} onClick={() => setA(v)}>
                  {v}
                </button>
              ))}
              <span style={{ alignSelf: 'center', margin: '0 0.5rem', color: 'var(--ink-dim)' }}>b =</span>
              {[2, 4, 5, 9].map((v) => (
                <button key={v} className={b === v ? 'on' : ''} onClick={() => setB(v)}>
                  {v}
                </button>
              ))}
            </div>
            <dl className="kv">
              <dt>e(a·P, b·Q)</dt>
              <dd className="hexbox" style={{ gridColumn: '1 / -1' }}>{res.lhsShort}</dd>
              <dt>e(P, Q)^(a·b)</dt>
              <dd className="hexbox violet" style={{ gridColumn: '1 / -1' }}>{res.rhsShort}</dd>
            </dl>
            <div style={{ marginTop: '0.7rem' }}>
              <Verdict ok={res.bilinearOk}>
                {res.bilinearOk ? `e(${a}P, ${b}Q) = e(P,Q)^${a * b} ✓` : 'mismatch'}
              </Verdict>
            </div>
          </Panel>

          <Panel
            title={`Aggregate ${n} signatures → one`}
            sub="Each signer signs a different message. The signatures are summed in G₁; the verifier checks one product of pairings — e(σ_agg, G₂) = ∏ e(H(mᵢ), pkᵢ)."
            right={
              <button className="btn" onClick={() => setSeed((s) => s + 1)}>
                ↻ new keys
              </button>
            }
          >
            <div className="seg" style={{ marginBottom: '1rem' }}>
              {[2, 3, 4, 5].map((v) => (
                <button key={v} className={n === v ? 'on' : ''} onClick={() => setN(v)}>
                  {v} signers
                </button>
              ))}
            </div>
            <table className="data">
              <thead>
                <tr>
                  <th>signer</th>
                  <th>message</th>
                  <th>signature σᵢ ∈ G₁ (96 bytes)</th>
                </tr>
              </thead>
              <tbody>
                {res.signers.map((s, i) => (
                  <tr key={i}>
                    <td style={{ color: s.color }}>#{i + 1}</td>
                    <td>{s.msg}</td>
                    <td className="mono">{ellipsize(g1Hex(s.sig), 12, 8)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <dl className="kv" style={{ marginTop: '0.9rem' }}>
              <dt>aggregate σ_agg</dt>
              <dd className="hexbox lavender" style={{ gridColumn: '1 / -1' }}>{g1Hex(res.aggSig)}</dd>
            </dl>
            <div style={{ marginTop: '0.7rem', display: 'flex', gap: '0.8rem', flexWrap: 'wrap' }}>
              <Verdict ok={res.aggOk}>{res.aggOk ? 'aggregate verifies ✓' : 'invalid'}</Verdict>
              <Verdict ok={res.tamperOk}>{res.tamperOk ? 'one altered message → rejected ✓' : 'tamper slipped through'}</Verdict>
            </div>
            <div className="note" style={{ marginTop: '0.6rem' }}>
              {n} signatures, {n * 96} bytes of raw Schnorr/ECDSA, become a single 96-byte element —
              a {n}× compression that stays constant no matter how many signers join. This is why
              Ethereum can fold tens of thousands of validator votes into one slot.
            </div>
          </Panel>

          <Panel
            title="The rogue-key attack"
            sub="The cheap variant — everyone signs one common message and the verifier checks e(σ_agg, G₂) = e(H(m), Σ pkᵢ) — is forgeable unless keys are bound by a proof of possession."
          >
            <div style={{ display: 'flex', gap: '0.8rem', flexWrap: 'wrap' }}>
              <Verdict ok={res.fastOk}>
                {res.fastOk ? 'honest fast-aggregate verifies ✓' : 'honest path broken'}
              </Verdict>
              <Verdict ok={res.rogueForges}>
                {res.rogueForges
                  ? 'rogue key forges a group signature with no secret ✓ (attack works)'
                  : 'rogue forgery failed'}
              </Verdict>
            </div>
            <div className="note" style={{ marginTop: '0.6rem' }}>
              A rogue signer publishes <code>pk_rogue = [t]·G₂ − Σ pk_honest</code>. The aggregate key
              becomes exactly <code>[t]·G₂</code>, so the attacker alone produces a valid “group”
              signature <code>[t]·H(m)</code> — the honest signers never participated. The fixes:
              require each key to prove possession of its secret, weight keys with MuSig-style
              coefficients, or (as in the panel above) make every signer commit to a{' '}
              <em>distinct</em> message.
            </div>
          </Panel>

          <Panel title="What the pairing is" sub="e(G₁, G₂) is an r-th root of unity living in the degree-12 extension F_p¹² — the target group G_T.">
            <dl className="kv">
              <dt>e(G₁, G₂) (F_p¹², c₀ component)</dt>
              <dd className="hexbox" style={{ gridColumn: '1 / -1' }}>{fp12Short(res.e)}</dd>
            </dl>
            <div className="note" style={{ marginTop: '0.5rem' }}>
              Non-degenerate (≠ 1) and of exact order <code>r</code>: raising it to the group order
              gives 1, the hallmark of a value in G_T. The Miller loop runs over the 64-bit BLS seed
              <code> x = −0xd201000000010000</code>, and the final exponentiation lifts the result into
              the r-th roots of unity.
            </div>
          </Panel>
        </>
      )}
    </main>
  )
}

/**
 * Construct the canonical rogue-key forgery against naive common-message
 * aggregation and confirm it verifies. The attacker chooses pk_rogue so the
 * aggregate public key is exactly [t]·G₂ for a t it knows, then signs alone.
 */
function rogueKeyForgery(honestPks: G2[], msg: Uint8Array): boolean {
  const t = 0xdeadbeefn
  let sumHonest: G2 = null
  for (const pk of honestPks) sumHonest = g2.add(sumHonest, pk)
  const pkRogue = g2.add(g2.mul(t, G2_GEN), g2.neg(sumHonest))
  const allPks = [...honestPks, pkRogue]
  // The attacker signs with t alone — no honest secret involved.
  const forged = g1.mul(t, hashToG1(msg))
  return blsFastAggregateVerify(allPks, msg, forged)
}
