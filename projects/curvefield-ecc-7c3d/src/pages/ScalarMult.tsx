import { useMemo, useState } from 'react'
import { PageHead, Panel } from '../ui/components'
import { Curve, fmtPoint, type Point } from '../ecc/curve'

const SIZE = 440
const CURVES = [
  { p: 97, a: 2, b: 3, label: '𝔽₉₇ : y² = x³ + 2x + 3' },
  { p: 61, a: 1, b: 6, label: '𝔽₆₁ : y² = x³ + x + 6' },
  { p: 127, a: 4, b: 7, label: '𝔽₁₂₇ : y² = x³ + 4x + 7' },
]

export function ScalarMult() {
  const [ci, setCi] = useState(0)
  const [k, setK] = useState(20)
  const [showWalk, setShowWalk] = useState(true)
  const cfg = CURVES[ci]

  const curve = useMemo(() => new Curve(BigInt(cfg.a), BigInt(cfg.b), BigInt(cfg.p)), [cfg])
  const G = useMemo(() => {
    // pick a generator of maximal order
    let best: Point = null
    let bestOrd = 0n
    for (const pt of curve.points()) {
      if (pt === null) continue
      const o = curve.pointOrder(pt)
      if (o > bestOrd) {
        bestOrd = o
        best = pt
      }
    }
    return { G: best, order: bestOrd }
  }, [curve])

  const order = Number(G.order)
  const kk = ((k % order) + order) % order
  const kG = curve.multiply(BigInt(kk), G.G)
  const trace = useMemo(() => (kk > 0 ? curve.multiplyTrace(BigInt(kk), G.G) : []), [curve, kk, G.G])
  const bits = kk.toString(2)

  const cell = SIZE / cfg.p
  const cx = (x: bigint) => 10 + Number(x) * cell + cell / 2
  const cy = (y: bigint) => SIZE - 10 - Number(y) * cell + cell / 2 - cell

  const allPts = curve.points().filter((pt): pt is { x: bigint; y: bigint } => pt !== null)

  // walk polyline through accumulator after each step
  const walkPts: { x: bigint; y: bigint }[] = []
  for (const s of trace) if (s.acc !== null) walkPts.push(s.acc)

  return (
    <main className="page">
      <PageHead eyebrow="Lab 03 — the one-way street" title="Scalar Multiplication">
        Public keys are <code>k·G</code> — the point G added to itself k times. Done cleverly with{' '}
        <b>double-and-add</b>, that is a few dozen operations even for astronomically large k. But
        the result lands in a seemingly random spot: nudge k by one and k·G leaps across the field.
        That unpredictability, with no shortcut backwards, is what a public key hides behind.
      </PageHead>

      <div className="grid cols-2" style={{ gridTemplateColumns: '1fr 1fr' }}>
        <div className="plotwrap" style={{ padding: '0.5rem' }}>
          <svg viewBox={`0 0 ${SIZE} ${SIZE}`}>
            {allPts.map((pt) => (
              <circle key={`${pt.x},${pt.y}`} cx={cx(pt.x)} cy={cy(pt.y)} r={2.4} fill="#28406a" />
            ))}
            {showWalk && walkPts.length > 1 && (
              <polyline
                points={walkPts.map((pt) => `${cx(pt.x)},${cy(pt.y)}`).join(' ')}
                fill="none"
                stroke="#fbbf2466"
                strokeWidth="1.3"
              />
            )}
            {showWalk &&
              walkPts.map((pt, i) => (
                <circle key={i} cx={cx(pt.x)} cy={cy(pt.y)} r={3} fill="#fbbf24" opacity={0.5} />
              ))}
            {G.G && (
              <>
                <circle cx={cx(G.G.x)} cy={cy(G.G.y)} r={6} fill="#5eead4" stroke="#06121a" strokeWidth="1.4" />
                <text x={cx(G.G.x) + 7} y={cy(G.G.y) - 6} fill="#5eead4" fontSize="13" fontWeight={700}>G</text>
              </>
            )}
            {kG && (
              <>
                <circle cx={cx(kG.x)} cy={cy(kG.y)} r={7} fill="#f0abfc" stroke="#06121a" strokeWidth="1.6" />
                <text x={cx(kG.x) + 8} y={cy(kG.y) + 14} fill="#f0abfc" fontSize="13" fontWeight={700}>{kk}·G</text>
              </>
            )}
          </svg>
          <div className="legend" style={{ padding: '0 0.4rem 0.4rem' }}>
            <span><i style={{ background: '#28406a' }} />curve point</span>
            <span><i style={{ background: '#5eead4' }} />generator G</span>
            <span><i style={{ background: '#fbbf24' }} />double-and-add path</span>
            <span><i style={{ background: '#f0abfc' }} />k·G</span>
          </div>
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: '1.1rem' }}>
          <Panel title="Setup">
            <div className="seg" style={{ flexWrap: 'wrap', marginBottom: '0.9rem' }}>
              {CURVES.map((c, i) => (
                <button key={i} className={ci === i ? 'on' : ''} onClick={() => setCi(i)}>
                  𝔽<sub>{c.p}</sub>
                </button>
              ))}
            </div>
            <div className="sub" style={{ marginBottom: '0.8rem' }}>{cfg.label}</div>
            <div className="field">
              <label><span>scalar k</span><span className="val">{kk}</span></label>
              <input type="range" min={1} max={order - 1} value={k} onChange={(e) => setK(Number(e.target.value))} />
            </div>
            <div className="btn-row">
              <button className="btn ghost" onClick={() => setK((v) => Math.max(1, v - 1))}>− 1</button>
              <button className="btn ghost" onClick={() => setK((v) => v + 1)}>+ 1</button>
              <label style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', fontSize: '0.82rem', color: 'var(--ink-dim)' }}>
                <input type="checkbox" checked={showWalk} onChange={(e) => setShowWalk(e.target.checked)} style={{ width: 'auto' }} />
                show walk
              </label>
            </div>
            <dl className="kv" style={{ marginTop: '0.9rem' }}>
              <dt>G</dt><dd>{fmtPoint(G.G)}</dd>
              <dt>order of G</dt><dd>{order}</dd>
              <dt style={{ color: 'var(--accent-3)' }}>k·G</dt>
              <dd style={{ color: 'var(--accent-3)' }}>{fmtPoint(kG)}</dd>
            </dl>
          </Panel>

          <Panel title="Double-and-add" sub={`k = ${kk} = (${bits})₂ — ${bits.length} bits, ${trace.filter((t) => t.bit).length} ones`}>
            <div className="scroll" style={{ maxHeight: 280, overflowY: 'auto' }}>
              <table className="data">
                <thead>
                  <tr><th>step</th><th>bit</th><th>op</th><th>accumulator</th></tr>
                </thead>
                <tbody>
                  {trace.map((s, i) => (
                    <tr key={i}>
                      <td>{i + 1}</td>
                      <td className="mono" style={{ color: s.bit ? 'var(--accent)' : 'var(--ink-faint)' }}>{s.bit}</td>
                      <td style={{ color: 'var(--ink-dim)' }}>{s.bit ? 'double, then +G' : 'double'}</td>
                      <td className="mono">{s.acc === null ? 'O' : `${s.acc.x},${s.acc.y}`}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="note">
              A real 256-bit key takes ~256 doublings and ~128 adds — under 400 group operations.
              Brute-forcing the inverse would take ~2²⁵⁶. The asymmetry is the entire point.
            </div>
          </Panel>
        </div>
      </div>
    </main>
  )
}
