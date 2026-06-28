import { useMemo, useState } from 'react'
import { PageHead, Panel, Slider, Verdict } from '../ui/components'
import { split, reconstruct, verifyShare, corruptShare, subsets } from '../ecc/shamir'
import { fmtPoly } from '../ecc/polynomial'
import { N } from '../ecc/secp256k1'
import { seedRng } from '../ecc/rng'
import { hex } from '../ui/format'

const COLORS = ['#b794f6', '#5eead4', '#fbbf24', '#fb7185', '#60a5fa', '#34d399', '#f472b6']

export function ShamirPage() {
  const [n, setN] = useState(5)
  const [t, setT] = useState(3)
  const [seed, setSeed] = useState(1)
  // The secret the dealer is splitting (kept small + readable for the demo).
  const [secret] = useState(0x5ec1e7n)

  const result = useMemo(() => {
    seedRng(seed * 1000 + n * 17 + t)
    return split(secret, Math.min(t, n), n)
  }, [n, t, seed, secret])

  // Pick the first t shares as the reconstructing quorum; also try t−1.
  const [chosen, setChosen] = useState<number[]>([0, 1, 2])
  const quorum = useMemo(
    () => chosen.map((i) => result.shares[i]).filter(Boolean),
    [chosen, result],
  )

  const recovered = useMemo(() => (quorum.length ? reconstruct(quorum) : 0n), [quorum])
  const enough = quorum.length >= result.threshold
  const recoveredOk = enough && recovered === result.secret

  // A deliberately short quorum (t−1) to show it fails.
  const shortQuorum = result.shares.slice(0, Math.max(1, result.threshold - 1))
  const shortRecovered = reconstruct(shortQuorum)

  const allVerify = result.shares.every((s) => verifyShare(s, result.commitments))
  const corrupted = useMemo(() => corruptShare(result.shares[0]), [result])
  const corruptCaught = !verifyShare(corrupted, result.commitments)

  const totalSubsets = subsets(n, result.threshold).length

  const toggle = (i: number) =>
    setChosen((c) => (c.includes(i) ? c.filter((x) => x !== i) : [...c, i]))

  return (
    <main className="page">
      <PageHead eyebrow="Lab 16 — splitting a secret" title="Shamir Secret Sharing & Feldman VSS">
        A secret is hidden as the constant term of a random degree-<code>(t−1)</code> polynomial{' '}
        <code>f</code> over the scalar field 𝔽ₙ; each party gets a point <code>(i, f(i))</code> on
        it. Any <code>t</code> points determine the polynomial — and so <code>f(0)</code> — by
        Lagrange interpolation; any <code>t−1</code> leave the secret a uniform unknown. <em>Feldman
        VSS</em> adds public curve commitments <code>Cⱼ = aⱼ·G</code> so each holder can verify their
        share is consistent — catching a cheating dealer — without learning the secret. This is the
        primitive under FROST, threshold ECDSA, and every distributed key generation.
      </PageHead>

      <Panel
        title="The dealer"
        sub="A random sharing polynomial with the secret as its constant term, plus Feldman commitments to each coefficient."
        right={
          <button className="btn" onClick={() => setSeed((s) => s + 1)}>
            ↻ re-share
          </button>
        }
      >
        <div className="grid cols-2" style={{ gap: '1rem' }}>
          <Slider label="parties n" value={n} min={2} max={7} onChange={(v) => { setN(v); setT((tt) => Math.min(tt, v)); }} />
          <Slider label="threshold t" value={Math.min(t, n)} min={1} max={n} onChange={setT} />
        </div>
        <dl className="kv" style={{ marginTop: '0.8rem' }}>
          <dt>secret s = f(0)</dt>
          <dd className="hexbox violet">{hex(result.secret)}</dd>
          <dt>polynomial f(X)</dt>
          <dd className="mono" style={{ gridColumn: '1 / -1', wordBreak: 'break-all' }}>
            {fmtPoly(result.poly.map((c) => (c > (N >> 1n) ? c - N : c)), N)}{' '}
            <span className="note" style={{ display: 'inline' }}>(coeffs shown signed-small for legibility)</span>
          </dd>
          <dt>group key C₀ = s·G (x)</dt>
          <dd className="hexbox" style={{ gridColumn: '1 / -1' }}>
            {result.commitments[0] ? hex(result.commitments[0].x, 64) : '—'}
          </dd>
        </dl>
        <div className="note" style={{ marginTop: '0.5rem' }}>
          A real dealer keeps <code>f</code> private and publishes only the shares and the{' '}
          <code>t</code> commitments. The full polynomial is shown here to make the construction
          visible.
        </div>
      </Panel>

      <Panel
        title="The shares"
        sub="Click rows to choose a reconstructing quorum. Each share is checked against the Feldman commitments: yᵢ·G ?= Σⱼ Cⱼ·iʲ."
      >
        <table className="data">
          <thead>
            <tr>
              <th>party i</th>
              <th>share f(i)</th>
              <th>Feldman</th>
              <th>in quorum?</th>
            </tr>
          </thead>
          <tbody>
            {result.shares.map((s, i) => {
              const ok = verifyShare(s, result.commitments)
              const inQ = chosen.includes(i)
              return (
                <tr
                  key={i}
                  onClick={() => toggle(i)}
                  style={{ cursor: 'pointer', opacity: inQ ? 1 : 0.62 }}
                >
                  <td style={{ color: COLORS[i % COLORS.length] }}>#{i + 1}</td>
                  <td className="mono">{hex(s.y, 16)}…</td>
                  <td><Verdict ok={ok}>{ok ? 'valid' : 'bad'}</Verdict></td>
                  <td>{inQ ? '◆ selected' : '◇'}</td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </Panel>

      <Panel title="Reconstruction" sub="Lagrange-interpolate the chosen shares back to f(0).">
        <div style={{ display: 'flex', gap: '0.8rem', alignItems: 'center', flexWrap: 'wrap' }}>
          <span className="note" style={{ display: 'inline' }}>
            {quorum.length} share{quorum.length === 1 ? '' : 's'} selected · threshold is {result.threshold}
          </span>
          <Verdict ok={enough}>{enough ? 'quorum reached' : `need ${result.threshold - quorum.length} more`}</Verdict>
        </div>
        <dl className="kv" style={{ marginTop: '0.8rem' }}>
          <dt>reconstructed f(0)</dt>
          <dd className="hexbox lavender">{hex(recovered)}</dd>
          <dt>matches secret?</dt>
          <dd><Verdict ok={recoveredOk}>{recoveredOk ? 'exact ✓' : enough ? 'mismatch' : 'under threshold'}</Verdict></dd>
        </dl>
        <div className="note" style={{ marginTop: '0.6rem' }}>
          Every one of the <b>{totalSubsets}</b> distinct {result.threshold}-of-{n} subsets recovers
          the same secret. With only <b>t−1 = {result.threshold - 1}</b> shares, interpolation lands
          on the wrong value <code className="mono">{hex(shortRecovered, 10)}…</code> — the secret
          stays information-theoretically hidden.
        </div>
      </Panel>

      <Panel title="Catching a cheating dealer" sub="Flip one share's value and the Feldman check rejects it on the spot.">
        <dl className="kv">
          <dt>tampered share #1</dt>
          <dd className="hexbox">{hex(corrupted.y, 20)}…</dd>
          <dt>Feldman verdict</dt>
          <dd><Verdict ok={corruptCaught}>{corruptCaught ? 'rejected ✓' : 'slipped through'}</Verdict></dd>
          <dt>all honest shares verify</dt>
          <dd><Verdict ok={allVerify}>{allVerify ? 'yes' : 'no'}</Verdict></dd>
        </dl>
      </Panel>
    </main>
  )
}
