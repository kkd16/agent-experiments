import { useMemo, useState } from 'react'
import { PageHead, Panel } from '../ui/components'
import { Curve, fmtPoint, type Point } from '../ecc/curve'

const PRIMES = [11, 17, 23, 31, 47, 61, 79, 97]
const SIZE = 460

const same = (a: Point, b: Point) =>
  (a === null && b === null) || (a !== null && b !== null && a.x === b.x && a.y === b.y)

export function FiniteField() {
  const [p, setP] = useState(23)
  const [a, setA] = useState(1)
  const [b, setB] = useState(1)
  const [target, setTarget] = useState<'P' | 'Q'>('P')
  const [P, setP_] = useState<Point>(null)
  const [Q, setQ] = useState<Point>(null)

  const curve = useMemo(() => new Curve(BigInt(a), BigInt(b), BigInt(p)), [a, b, p])
  const singular = !curve.isNonSingular()
  const points = useMemo(() => (singular ? [] : curve.points()), [curve, singular])
  const affine = points.filter((pt): pt is { x: bigint; y: bigint } => pt !== null)
  const order = curve.count()

  const subgroup = useMemo(() => (P ? curve.subgroup(P) : []), [curve, P])
  const subSet = useMemo(
    () => new Set(subgroup.filter((pt) => pt !== null).map((pt) => `${pt!.x},${pt!.y}`)),
    [subgroup],
  )
  const pOrder = P ? curve.pointOrder(P) : 0n
  const sum = P && Q ? curve.add(P, Q) : null

  const cell = SIZE / p
  const cx = (x: bigint) => 28 + Number(x) * cell + cell / 2
  const cy = (y: bigint) => SIZE - 14 - Number(y) * cell + cell / 2 - cell

  const sqrtP = Math.sqrt(p)
  const hasseLo = Math.ceil(p + 1 - 2 * sqrtP)
  const hasseHi = Math.floor(p + 1 + 2 * sqrtP)

  const assign = (pt: Point) => {
    if (target === 'P') setP_(same(P, pt) ? null : pt)
    else setQ(same(Q, pt) ? null : pt)
  }

  return (
    <main className="page">
      <PageHead eyebrow="Lab 02 — finite fields" title="Curves over a Finite Field">
        Replace the real numbers with arithmetic mod a prime <i>p</i>, and the smooth curve shatters
        into a scatter of points — but the same addition formulas still hold, taken mod <i>p</i>.
        The points form a finite abelian group. Click any point to pick a base; its repeated sums
        light up the cyclic subgroup it generates.
      </PageHead>

      <div className="grid cols-2" style={{ gridTemplateColumns: '1.25fr 1fr' }}>
        <div className="plotwrap" style={{ padding: '0.4rem' }}>
          <svg viewBox={`0 0 ${SIZE + 40} ${SIZE + 28}`}>
            {/* faint lattice */}
            {Array.from({ length: p + 1 }, (_, i) => (
              <g key={i} opacity={0.5}>
                <line x1={28} y1={cy(BigInt(i)) + cell / 2} x2={SIZE + 28} y2={cy(BigInt(i)) + cell / 2} stroke="#101a2c" />
                <line x1={28 + i * cell} y1={14} x2={28 + i * cell} y2={SIZE + 2} stroke="#101a2c" />
              </g>
            ))}
            {/* symmetry axis y = p/2 */}
            <line
              x1={28}
              y1={cy(BigInt(p) / 2n) + cell / 2}
              x2={SIZE + 28}
              y2={cy(BigInt(p) / 2n) + cell / 2}
              stroke="#22324d"
              strokeDasharray="3 5"
            />

            {affine.map((pt) => {
              const key = `${pt.x},${pt.y}`
              const inSub = subSet.has(key)
              const isP = P && same(P, pt)
              const isQ = Q && same(Q, pt)
              const isSum = sum && same(sum, pt)
              const fill = inSub ? '#5eead4' : '#33507a'
              const r = isP || isQ || isSum ? 7 : inSub ? 4.5 : 3.2
              return (
                <circle
                  key={key}
                  cx={cx(pt.x)}
                  cy={cy(pt.y)}
                  r={r}
                  fill={isSum ? '#f0abfc' : isQ ? '#a78bfa' : isP ? '#5eead4' : fill}
                  stroke={isP || isQ || isSum ? '#06121a' : 'none'}
                  strokeWidth="1.5"
                  style={{ cursor: 'pointer', transition: 'r 0.1s' }}
                  onClick={() => assign(pt)}
                />
              )
            })}
            {P && (
              <text x={cx(P.x) + 8} y={cy(P.y) - 7} fill="#5eead4" fontSize="13" fontWeight={700}>
                P
              </text>
            )}
            {Q && (
              <text x={cx(Q.x) + 8} y={cy(Q.y) - 7} fill="#a78bfa" fontSize="13" fontWeight={700}>
                Q
              </text>
            )}
            {sum && !same(sum, P) && !same(sum, Q) && (
              <text x={cx(sum.x) + 8} y={cy(sum.y) - 7} fill="#f0abfc" fontSize="13" fontWeight={700}>
                P+Q
              </text>
            )}
          </svg>
          <div className="legend" style={{ padding: '0 0.6rem 0.5rem' }}>
            <span><i style={{ background: '#33507a' }} />curve point</span>
            <span><i style={{ background: '#5eead4' }} />⟨P⟩ subgroup</span>
            <span><i style={{ background: '#a78bfa' }} />Q</span>
            <span><i style={{ background: '#f0abfc' }} />P + Q</span>
          </div>
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: '1.1rem' }}>
          <Panel title="Curve y² = x³ + ax + b (mod p)">
            <div className="field">
              <label><span>prime p</span><span className="val">{p}</span></label>
              <div className="seg" style={{ flexWrap: 'wrap' }}>
                {PRIMES.map((pp) => (
                  <button key={pp} className={p === pp ? 'on' : ''} onClick={() => { setP(pp); setP_(null); setQ(null) }}>
                    {pp}
                  </button>
                ))}
              </div>
            </div>
            <div className="field" style={{ marginTop: '0.9rem' }}>
              <label><span>a</span><span className="val">{a}</span></label>
              <input type="range" min={0} max={p - 1} value={a} onChange={(e) => { setA(Number(e.target.value)); setP_(null); setQ(null) }} />
            </div>
            <div className="field">
              <label><span>b</span><span className="val">{b}</span></label>
              <input type="range" min={0} max={p - 1} value={b} onChange={(e) => { setB(Number(e.target.value)); setP_(null); setQ(null) }} />
            </div>
            {singular ? (
              <div className="note" style={{ borderColor: 'var(--bad)', color: 'var(--bad)' }}>
                4a³ + 27b² ≡ 0 (mod {p}) — singular curve, not a group. Adjust a or b.
              </div>
            ) : (
              <dl className="kv">
                <dt>group order |E|</dt>
                <dd style={{ color: 'var(--accent)' }}>{order.toString()} points (incl. O)</dd>
                <dt>Hasse interval</dt>
                <dd>[{hasseLo}, {hasseHi}] ∋ {order.toString()}</dd>
              </dl>
            )}
          </Panel>

          <Panel title="Selection" sub="click a point on the plot to assign it">
            <div className="seg" style={{ marginBottom: '0.9rem' }}>
              <button className={target === 'P' ? 'on' : ''} onClick={() => setTarget('P')}>set P</button>
              <button className={target === 'Q' ? 'on' : ''} onClick={() => setTarget('Q')}>set Q</button>
            </div>
            <dl className="kv">
              <dt>P</dt><dd>{P ? fmtPoint(P) : '—'}</dd>
              <dt>order of P</dt>
              <dd>
                {P ? (
                  <>
                    {pOrder.toString()}{' '}
                    {pOrder === order ? (
                      <span className="tag ok" style={{ marginLeft: 4 }}>generator</span>
                    ) : (
                      <span className="tag" style={{ marginLeft: 4 }}>
                        cofactor {(order / pOrder).toString()}
                      </span>
                    )}
                  </>
                ) : '—'}
              </dd>
              <dt>Q</dt><dd>{Q ? fmtPoint(Q) : '—'}</dd>
              <dt style={{ color: 'var(--accent-3)' }}>P + Q</dt>
              <dd style={{ color: 'var(--accent-3)' }}>{P && Q ? fmtPoint(sum) : '—'}</dd>
            </dl>
          </Panel>
        </div>
      </div>

      {P && subgroup.length > 1 && (
        <Panel
          title={`The cyclic subgroup ⟨P⟩ — order ${pOrder}`}
          sub="every element is some multiple k·P; the sequence wraps back to O. This is exactly the structure a discrete-log attacker must invert."
        >
          <div className="scroll" style={{ overflowX: 'auto' }}>
            <table className="data">
              <thead>
                <tr>
                  <th>k</th>
                  {subgroup.map((_, i) => <th key={i}>{i}</th>)}
                </tr>
              </thead>
              <tbody>
                <tr>
                  <td className="mono" style={{ color: 'var(--ink-faint)' }}>k·P</td>
                  {subgroup.map((pt, i) => (
                    <td key={i} className="mono" style={{ color: pt === null ? 'var(--warn)' : 'var(--accent)' }}>
                      {pt === null ? 'O' : `${pt.x},${pt.y}`}
                    </td>
                  ))}
                </tr>
              </tbody>
            </table>
          </div>
        </Panel>
      )}
    </main>
  )
}
