import { useEffect, useMemo, useState } from 'react'
import { PageHead, Panel, Verdict } from '../ui/components'
import { setup, commit, open, verify, homomorphismHolds, batchVerify, type SRS, type BatchItem } from '../ecc/kzg'
import { evaluate, fmtPoly, type Poly } from '../ecc/polynomial'
import { R, g1Hex, type G1 } from '../ecc/bls12381'
import { hex } from '../ui/format'

// A fixed toy τ for the lab. In a real ceremony this is sampled, used once, and
// destroyed — anyone who keeps it can forge proofs (the "toxic waste").
const TAU = 0x6e1a9c4b3f27d805a1b2c3d4e5f60718293a4b5c6d7e8f90n

const DEGREE = 6

export function KzgPage() {
  const [coeffs, setCoeffs] = useState<number[]>([3, 1, 4, 1, 5, 9, 2])
  const [z, setZ] = useState(11)

  const srs = useMemo<SRS>(() => setup(DEGREE, TAU), [])
  const poly = useMemo<Poly>(() => coeffs.map((c) => BigInt(((c % 1000) + 1000) % 1000)), [coeffs])

  // Fast (G1-only) part: commit + open. Pairings are deferred below.
  const fast = useMemo(() => {
    const C = commit(srs, poly)
    const zz = BigInt(z)
    const op = open(srs, poly, zz)
    const homo = homomorphismHolds(srs, poly, [7n, 0n, 3n, 0n, 0n, 0n, 1n])
    return { C, op, homo, zz, y: evaluate(poly, zz, R) }
  }, [srs, poly, z])

  // A key identifying the current inputs, so we can tell when the displayed
  // pairing result is stale (and show "computing…" instead).
  const key = useMemo(() => `${poly.join(',')}|${z}`, [poly, z])

  // Slow (pairing) part: run after paint so the UI stays responsive. State is set
  // only inside the deferred callback — never synchronously in the effect.
  const [pairings, setPairings] = useState<{
    key: string
    ok: boolean
    forgeRejected: boolean
    batch: boolean
  } | null>(null)

  useEffect(() => {
    let alive = true
    const id = setTimeout(() => {
      const ok = verify(srs, fast.C, fast.op)
      const forged = { ...fast.op, y: (fast.op.y + 1n) % R }
      const forgeRejected = !verify(srs, fast.C, forged)
      // Batch-verify two independent openings of the same commitment with one multi-pairing.
      const items: BatchItem[] = [
        { C: fast.C, op: fast.op },
        { C: fast.C, op: open(srs, poly, (fast.zz + 5n) % R) },
      ]
      const batch = batchVerify(srs, items)
      if (!alive) return
      setPairings({ key, ok, forgeRejected, batch })
    }, 30)
    return () => {
      alive = false
      clearTimeout(id)
    }
  }, [srs, fast, poly, key])

  const fresh = pairings !== null && pairings.key === key
  const running = !fresh

  const setCoeff = (i: number, v: string) =>
    setCoeffs((c) => c.map((x, j) => (j === i ? (Number(v) || 0) : x)))

  return (
    <main className="page">
      <PageHead eyebrow="Lab 19 — commit to a whole polynomial" title="KZG Polynomial Commitments">
        A KZG commitment crushes an entire degree-<code>d</code> polynomial into a <em>single</em>{' '}
        group element <code>C = f(τ)·G₁</code>, then proves any evaluation <code>f(z) = y</code> with a{' '}
        <em>constant-size</em> proof checked by one pairing — independent of the degree. It rests on a
        powers-of-τ structured reference string and the fact that <code>f(z)=y</code> iff{' '}
        <code>(X−z)</code> divides <code>f(X)−y</code>. This is the commitment scheme under PLONK,
        Marlin and Ethereum's EIP-4844 — running here on the engine's own from-scratch BLS12-381
        pairing.
      </PageHead>

      <Panel
        title="The polynomial f(X)"
        sub="Edit the coefficients (mod r). Everything below recomputes live."
      >
        <div style={{ display: 'flex', gap: '0.6rem', flexWrap: 'wrap' }}>
          {coeffs.map((c, i) => (
            <label key={i} className="field" style={{ width: '5.2rem' }}>
              <span style={{ fontSize: '0.72rem' }}>·X^{i}</span>
              <input
                type="number"
                value={c}
                onChange={(e) => setCoeff(i, e.target.value)}
                style={{ width: '100%' }}
              />
            </label>
          ))}
        </div>
        <dl className="kv" style={{ marginTop: '0.6rem' }}>
          <dt>f(X)</dt>
          <dd className="mono" style={{ gridColumn: '1 / -1', wordBreak: 'break-all' }}>{fmtPoly(poly, R)}</dd>
        </dl>
      </Panel>

      <Panel
        title="Structured reference string (powers of τ)"
        sub="[τ⁰·G₁, …, τ^d·G₁] in G₁ and [τ]₂ in G₂. The secret τ is shown for the demo only — a real setup destroys it."
      >
        <dl className="kv">
          <dt>toxic waste τ</dt>
          <dd className="hexbox" style={{ gridColumn: '1 / -1' }}>{hex(srs.tau, 48)}</dd>
          <dt>SRS size</dt>
          <dd>{srs.powG1.length} G₁ powers · 1 G₂ power</dd>
          <dt>[τ¹]₁ = τ·G₁</dt>
          <dd className="hexbox" style={{ gridColumn: '1 / -1' }}>{g1Hex(srs.powG1[1] as G1).slice(0, 38)}…</dd>
        </dl>
      </Panel>

      <Panel title="Commitment & opening" sub="C = f(τ)·G₁ is one group element; the proof W = q(τ)·G₁ for q(X) = (f(X)−y)/(X−z) is one more.">
        <div className="grid cols-2" style={{ gap: '1rem' }}>
          <label className="field">
            <span>evaluation point z</span>
            <input type="number" value={z} min={0} max={200} onChange={(e) => setZ(Number(e.target.value) || 0)} />
          </label>
          <div className="field">
            <span>claimed value y = f(z)</span>
            <span className="val mono">{hex(fast.y, 12)}…</span>
          </div>
        </div>
        <dl className="kv" style={{ marginTop: '0.6rem' }}>
          <dt>commitment C (G₁ x)</dt>
          <dd className="hexbox violet" style={{ gridColumn: '1 / -1' }}>{g1Hex(fast.C).slice(0, 50)}…</dd>
          <dt>opening proof W (G₁ x)</dt>
          <dd className="hexbox lavender" style={{ gridColumn: '1 / -1' }}>{g1Hex(fast.op.W).slice(0, 50)}…</dd>
        </dl>
      </Panel>

      <Panel
        title="Pairing verification"
        sub="e(C − [y]₁, [1]₂) ?= e(W, [τ]₂ − [z]₂). Hundreds of ms of F_p¹² math — run off the paint."
        right={running ? <span className="tag warn">computing…</span> : undefined}
      >
        {fresh && pairings ? (
          <dl className="kv">
            <dt>opening verifies</dt>
            <dd><Verdict ok={pairings.ok}>{pairings.ok ? 'e(·) = e(·) ✓' : 'failed'}</Verdict></dd>
            <dt>forged value (y+1) rejected</dt>
            <dd><Verdict ok={pairings.forgeRejected}>{pairings.forgeRejected ? 'soundness holds ✓' : 'forged!'}</Verdict></dd>
            <dt>homomorphism C(f+g)=C(f)+C(g)</dt>
            <dd><Verdict ok={fast.homo}>{fast.homo ? 'additive ✓' : 'no'}</Verdict></dd>
            <dt>batch-verify 2 openings (one multi-pairing)</dt>
            <dd><Verdict ok={pairings.batch}>{pairings.batch ? 'verified ✓' : 'failed'}</Verdict></dd>
          </dl>
        ) : (
          <div className="note">Running the pairing check…</div>
        )}
        <div className="note" style={{ marginTop: '0.6rem' }}>
          The verifier never sees <code>f</code> — only the constant-size <code>C</code> and{' '}
          <code>W</code>. Batch verification folds many openings into a single pairing equation by a
          random linear combination, exactly as production verifiers do.
        </div>
      </Panel>
    </main>
  )
}
