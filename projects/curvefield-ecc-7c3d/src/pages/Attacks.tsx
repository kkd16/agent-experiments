import { useMemo, useState } from 'react'
import { PageHead, Panel, Verdict } from '../ui/components'
import { Curve, fmtPoint, type Point } from '../ecc/curve'
import { bruteForce, babyStepGiantStep, pollardRho, type DlogResult } from '../ecc/dlog'

// Pick a non-singular curve over F_p with a usable base point. Returns the curve,
// a generator G (first affine point), and the order of ⟨G⟩.
function setup(p: number): { curve: Curve; G: Point; order: bigint } {
  for (let b = 3; b < 12; b++) {
    const curve = new Curve(2n, BigInt(b), BigInt(p))
    if (!curve.isNonSingular()) continue
    const pts = curve.points().filter((pt): pt is { x: bigint; y: bigint } => pt !== null)
    if (!pts.length) continue
    const G = pts[0]
    return { curve, G, order: curve.pointOrder(G) }
  }
  const curve = new Curve(2n, 3n, BigInt(p))
  return { curve, G: null, order: 1n }
}

const INTERACTIVE_PRIMES = [97, 211, 419, 797, 1013]
const SCALING_PRIMES = [53, 101, 211, 419, 797, 1499, 3001]

export function Attacks() {
  const [p, setP] = useState(211)
  const [k, setK] = useState(73)

  const { curve, G, order } = useMemo(() => setup(p), [p])
  const ord = Number(order)
  const kk = ((k % ord) + ord) % ord || 1
  const target = G ? curve.multiply(BigInt(kk), G) : null

  const results: DlogResult[] = useMemo(() => {
    if (!G || !target) return []
    return [
      bruteForce(curve, G, target, order),
      babyStepGiantStep(curve, G, target, order),
      pollardRho(curve, G, target, order),
    ]
  }, [curve, G, target, order])

  const maxSteps = Math.max(1, ...results.map((r) => r.steps))

  const scaling = useMemo(() => {
    return SCALING_PRIMES.map((pp) => {
      const s = setup(pp)
      if (!s.G) return { p: pp, order: 0, brute: 0, bsgs: 0 }
      const kSecret = BigInt(Math.max(1, Math.floor(Number(s.order) * 0.618)))
      const tg = s.curve.multiply(kSecret, s.G)
      const bf = bruteForce(s.curve, s.G, tg, s.order)
      const bs = babyStepGiantStep(s.curve, s.G, tg, s.order)
      return { p: pp, order: Number(s.order), brute: bf.steps, bsgs: bs.steps }
    })
  }, [])
  const maxScale = Math.max(...scaling.map((s) => s.brute), 1)

  return (
    <main className="page">
      <PageHead eyebrow="Lab 05 — breaking it" title="Attacking the Discrete Log">
        Security rests on one asymmetry: computing <code>Q = k·G</code> is cheap, but recovering{' '}
        <code>k</code> from <code>Q</code> and <code>G</code> — the elliptic-curve discrete log — is
        not. On these toy groups it <i>is</i> breakable, and watching the cost of each algorithm grow
        with the group order shows exactly why a 256-bit curve is safe and a 32-bit one is a toy.
      </PageHead>

      <div className="grid cols-2" style={{ gridTemplateColumns: '1fr 1.1fr', alignItems: 'start' }}>
        <Panel title="Target" sub="choose a group and a secret; the solvers recover it from Q alone">
          <div className="field">
            <label><span>prime p</span><span className="val">{p}</span></label>
            <div className="seg" style={{ flexWrap: 'wrap' }}>
              {INTERACTIVE_PRIMES.map((pp) => (
                <button key={pp} className={p === pp ? 'on' : ''} onClick={() => setP(pp)}>{pp}</button>
              ))}
            </div>
          </div>
          <div className="field" style={{ marginTop: '0.8rem' }}>
            <label><span>secret k</span><span className="val">{kk}</span></label>
            <input type="range" min={1} max={Math.max(1, ord - 1)} value={Math.min(k, ord - 1)} onChange={(e) => setK(Number(e.target.value))} />
          </div>
          <dl className="kv">
            <dt>generator G</dt><dd>{fmtPoint(G)}</dd>
            <dt>order of ⟨G⟩</dt><dd>{ord}</dd>
            <dt>secret k</dt><dd style={{ color: 'var(--warn)' }}>{kk} (hidden from solvers)</dd>
            <dt style={{ color: 'var(--accent-3)' }}>Q = k·G</dt>
            <dd style={{ color: 'var(--accent-3)' }}>{fmtPoint(target)}</dd>
          </dl>
        </Panel>

        <Panel title="Solvers" sub={`√${ord} ≈ ${Math.sqrt(ord).toFixed(1)} — the target step count for the smart methods`}>
          <div className="bars">
            {results.map((r) => {
              const recovered = r.k === BigInt(kk)
              const color = r.method.startsWith('brute') ? '#fb7185' : r.method.startsWith('baby') ? '#5eead4' : '#a78bfa'
              return (
                <div className="bar" key={r.method}>
                  <span style={{ color: 'var(--ink-dim)' }}>{r.method}</span>
                  <div className="track">
                    <div className="fill" style={{ width: `${(r.steps / maxSteps) * 100}%`, background: color }} />
                  </div>
                  <span className="mono" style={{ minWidth: 92, textAlign: 'right' }}>
                    {r.steps} steps <Verdict ok={recovered}>{recovered ? `k=${r.k}` : 'fail'}</Verdict>
                  </span>
                </div>
              )
            })}
          </div>
          <div className="note">
            Brute force scans the whole group: ~n steps. Baby-step giant-step and Pollard’s rho both
            run in ~√n — the square-root speedup that defines ECC’s security margin. Halving the cost
            exponent is why we need 256-bit keys for 128-bit security.
          </div>
        </Panel>
      </div>

      <Panel title="How the cost scales" sub="brute force (≈ n) vs. baby-step giant-step (≈ √n) as the group grows">
        <div className="scroll" style={{ overflowX: 'auto' }}>
          <table className="data">
            <thead>
              <tr><th>field 𝔽ₚ</th><th>group order n</th><th>brute steps (≈n)</th><th>BSGS steps (≈√n)</th><th>√n</th><th>speedup</th></tr>
            </thead>
            <tbody>
              {scaling.map((s) => (
                <tr key={s.p}>
                  <td className="mono">𝔽<sub>{s.p}</sub></td>
                  <td className="mono">{s.order}</td>
                  <td className="mono" style={{ color: 'var(--bad)' }}>{s.brute}</td>
                  <td className="mono" style={{ color: 'var(--accent)' }}>{s.bsgs}</td>
                  <td className="mono" style={{ color: 'var(--ink-faint)' }}>{Math.sqrt(s.order).toFixed(1)}</td>
                  <td className="mono">{s.bsgs ? `${(s.brute / s.bsgs).toFixed(1)}×` : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="bars" style={{ marginTop: '1rem' }}>
          {scaling.map((s) => (
            <div className="bar" key={s.p}>
              <span className="mono" style={{ color: 'var(--ink-dim)' }}>𝔽<sub>{s.p}</sub> · n={s.order}</span>
              <div className="track" style={{ position: 'relative' }}>
                <div className="fill" style={{ width: `${(s.brute / maxScale) * 100}%`, background: '#fb718577' }} />
                <div className="fill" style={{ width: `${(s.bsgs / maxScale) * 100}%`, background: '#5eead4', position: 'absolute', top: 0, left: 0 }} />
              </div>
              <span className="mono" style={{ minWidth: 92, textAlign: 'right' }}>{s.brute} vs {s.bsgs}</span>
            </div>
          ))}
        </div>
        <div className="legend">
          <span><i style={{ background: '#fb7185' }} />brute force (linear)</span>
          <span><i style={{ background: '#5eead4' }} />baby-step giant-step (√n)</span>
        </div>
        <div className="note">
          Extrapolate: secp256k1’s group has n ≈ 2²⁵⁶. The √n attack still needs ~2¹²⁸ steps — more
          than the number of atoms in a mountain. No shortcut beyond this square-root barrier is
          known for a well-chosen curve, which is the entire basis of the system’s security.
        </div>
      </Panel>
    </main>
  )
}
