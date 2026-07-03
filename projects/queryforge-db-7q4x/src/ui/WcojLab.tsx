// The WCOJ Lab — the eleventh Lab. Worst-case-optimal joins made legible: pick a
// query shape and an instance, and watch a Leapfrog Triejoin eliminate variables
// one at a time while a classical binary-join plan blows an intermediate up past
// the final answer. Every number comes from the from-scratch `db/wcoj/*` engine,
// cross-checked against a binary-join oracle over the same data.

import { useMemo, useState } from 'react'
import {
  SHAPES,
  shape,
  randomInstance,
  denseInstance,
  wcojReport,
  eliminationTrace,
  type Atom,
  type ShapeId,
} from '../db/wcoj'
import { Rng } from '../db/fuzz/rng'

type InstanceKind = 'random' | 'dense'

const SIZES = [6, 12, 24, 48]

function fmt(n: number): string {
  if (!isFinite(n)) return '∞'
  return Math.round(n).toLocaleString()
}
function fmt1(n: number): string {
  if (!isFinite(n)) return '∞'
  return n.toFixed(n >= 100 ? 0 : 1)
}

/** Lay the query's variables on a circle and draw each atom as a hyperedge. */
function Hypergraph({ atoms }: { atoms: Atom[] }) {
  const vars = useMemo(() => {
    const seen: string[] = []
    for (const a of atoms) for (const v of a.relation.vars) if (!seen.includes(v)) seen.push(v)
    return seen
  }, [atoms])
  const W = 260
  const H = 220
  const cx = W / 2
  const cy = H / 2
  const R = 74
  const pos = new Map<string, { x: number; y: number }>()
  vars.forEach((v, i) => {
    const ang = (i / vars.length) * Math.PI * 2 - Math.PI / 2
    pos.set(v, { x: cx + R * Math.cos(ang), y: cy + R * Math.sin(ang) })
  })
  const colors = ['var(--accent)', 'var(--accent-2)', 'var(--green)', 'var(--amber)', '#c07de0', '#e07d9a']
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="wcoj-graph" role="img" aria-label="query hypergraph">
      {atoms.map((a, i) => {
        const ps = a.relation.vars.map((v) => pos.get(v)!)
        if (ps.length === 2) {
          return (
            <line
              key={i}
              x1={ps[0].x}
              y1={ps[0].y}
              x2={ps[1].x}
              y2={ps[1].y}
              stroke={colors[i % colors.length]}
              strokeWidth={2.5}
              strokeLinecap="round"
              opacity={0.8}
            />
          )
        }
        const d = 'M' + ps.map((p) => `${p.x},${p.y}`).join(' L') + ' Z'
        return <path key={i} d={d} fill={colors[i % colors.length]} fillOpacity={0.1} stroke={colors[i % colors.length]} strokeWidth={2} />
      })}
      {vars.map((v) => {
        const p = pos.get(v)!
        return (
          <g key={v}>
            <circle cx={p.x} cy={p.y} r={14} className="wcoj-node" />
            <text x={p.x} y={p.y + 4} textAnchor="middle" className="wcoj-node-label">
              {v}
            </text>
          </g>
        )
      })}
    </svg>
  )
}

/** Three bars: WCOJ output, AGM bound, and the binary plan's max intermediate. */
function BoundBars({ output, bound, binary }: { output: number; bound: number; binary: number }) {
  const max = Math.max(output, isFinite(bound) ? bound : 0, binary, 1)
  const bars = [
    { label: 'WCOJ output', val: output, cls: 'good' },
    { label: 'AGM bound', val: bound, cls: 'bound' },
    { label: 'binary max intermediate', val: binary, cls: 'bad' },
  ]
  const W = 520
  const rowH = 34
  return (
    <svg viewBox={`0 0 ${W} ${bars.length * rowH + 6}`} className="wcoj-bars" role="img" aria-label="size comparison">
      {bars.map((b, i) => {
        const w = (Math.min(b.val, max) / max) * (W - 210)
        return (
          <g key={b.label} transform={`translate(0 ${i * rowH + 4})`}>
            <text x={0} y={17} className="wcoj-bar-label">
              {b.label}
            </text>
            <rect x={180} y={4} width={Math.max(2, w)} height={18} rx={4} className={`wcoj-bar ${b.cls}`} />
            <text x={180 + Math.max(2, w) + 6} y={17} className="wcoj-bar-val">
              {fmt(b.val)}
            </text>
          </g>
        )
      })}
    </svg>
  )
}

export function WcojLab() {
  const [shapeId, setShapeId] = useState<ShapeId>('triangle')
  const [kind, setKind] = useState<InstanceKind>('dense')
  const [size, setSize] = useState(24)
  const [seed, setSeed] = useState(1)

  const sh = shape(shapeId)
  const atoms = useMemo<Atom[]>(() => {
    if (kind === 'dense') return denseInstance(sh, size)
    return randomInstance(sh, new Rng(seed * 2654435761 + 1), size, Math.max(3, Math.round(size / 3)))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shapeId, kind, size, seed])

  const report = useMemo(() => wcojReport(atoms), [atoms])
  const trace = useMemo(() => eliminationTrace(atoms, report.order), [atoms, report.order])

  const coverStr = report.cover.weights.map((w) => w.toFixed(2)).join(', ')

  return (
    <div className="sk-lab">
      <div className="sk-head">
        <h2>WCOJ Lab</h2>
        <p>
          Every join elsewhere in QueryForge is <em>binary</em> — a tree of two-way joins. In 2012 that
          model was proven <em>sub-optimal</em>: on a cyclic query the smallest binary plan still builds an
          intermediate bigger than the final answer. A <em>worst-case-optimal join</em> — here a from-scratch{' '}
          <em>Leapfrog Triejoin</em> — runs in <code>O(AGM bound)</code> by joining one variable at a time
          across all relations at once. Pick a shape and watch the blow-up it dodges.
        </p>
      </div>

      <div className="sk-tabs">
        {SHAPES.map((s) => (
          <button key={s.id} className={`sk-tab ${shapeId === s.id ? 'active' : ''}`} onClick={() => setShapeId(s.id)}>
            <span className="sk-tab-label">{s.label}</span>
            <span className="sk-tab-tag">ρ* = {fmt1(shapeCover(s.id))}</span>
          </button>
        ))}
      </div>

      <div className="sk-controls">
        <div className="sk-control">
          <label>Instance</label>
          <div className="sk-seg">
            <button className={kind === 'dense' ? 'active' : ''} onClick={() => setKind('dense')}>
              dense grid
            </button>
            <button className={kind === 'random' ? 'active' : ''} onClick={() => setKind('random')}>
              random
            </button>
          </div>
          <span className="sk-hint">
            {kind === 'dense'
              ? 'the adversarial fan-out where binary plans blow up'
              : 'uniform random tuples over a small domain'}
          </span>
        </div>
        <div className="sk-control">
          <label>Size&nbsp;(N per relation)</label>
          <div className="sk-seg">
            {SIZES.map((s) => (
              <button key={s} className={size === s ? 'active' : ''} onClick={() => setSize(s)}>
                {s}
              </button>
            ))}
          </div>
        </div>
        {kind === 'random' && (
          <div className="sk-control">
            <label>Seed</label>
            <button className="wcoj-reroll" onClick={() => setSeed((s) => s + 1)}>
              reroll #{seed}
            </button>
          </div>
        )}
      </div>

      <div className="sk-panel">
        <div className="wcoj-split">
          <div>
            <div className="wcoj-sub">the query hypergraph</div>
            <Hypergraph atoms={atoms} />
            <div className="wcoj-blurb">{sh.blurb}</div>
          </div>
          <div className="wcoj-atoms">
            <div className="wcoj-sub">atoms · variable order {report.order.join(' → ')}</div>
            <table className="wcoj-table">
              <thead>
                <tr>
                  <th>atom</th>
                  <th>vars</th>
                  <th>|R|</th>
                  <th>x_e</th>
                </tr>
              </thead>
              <tbody>
                {report.atoms.map((a, i) => (
                  <tr key={a.name}>
                    <td className="mono">{a.name}</td>
                    <td className="mono">({a.vars.join(',')})</td>
                    <td className="num">{fmt(a.size)}</td>
                    <td className="num accent">{report.agm.weights[i].toFixed(2)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <div className="wcoj-cover">
              fractional edge cover ρ* = <strong>{fmt1(report.cover.rho)}</strong> &nbsp;·&nbsp; weights [{coverStr}]
            </div>
          </div>
        </div>
      </div>

      <div className="sk-panel">
        <div className="sk-stat-row">
          <div className="sk-stat">
            <span className="sk-stat-k">WCOJ output rows</span>
            <span className="sk-stat-v accent">{fmt(report.outputSize)}</span>
          </div>
          <div className="sk-stat">
            <span className="sk-stat-k">AGM bound ∏|R|^x</span>
            <span className="sk-stat-v">{fmt(report.agm.bound)}</span>
          </div>
          <div className="sk-stat">
            <span className="sk-stat-k">binary max intermediate</span>
            <span className="sk-stat-v">{fmt(report.binary.maxIntermediate)}</span>
          </div>
          <div className="sk-stat">
            <span className="sk-stat-k">blow-up (binary ÷ answer)</span>
            <span className="sk-stat-v">{fmt1(report.blowup)}×</span>
          </div>
        </div>
        <BoundBars output={report.outputSize} bound={report.agm.bound} binary={report.binary.maxIntermediate} />
        <div className="wcoj-steps">
          {report.binary.intermediates.map((s, i) => (
            <span key={i} className="wcoj-step">
              {i === 0 ? '' : '⋈ '}
              {s.joined} <span className="wcoj-step-size">→ {fmt(s.size)}</span>
            </span>
          ))}
        </div>
      </div>

      <div className="sk-panel">
        <div className="wcoj-sub">variable elimination — the leapfrog intersection at each level</div>
        <div className="wcoj-elim">
          {trace.map((lvl) => (
            <div key={lvl.variable} className="wcoj-level">
              <div className="wcoj-level-var">{lvl.variable}</div>
              <div className="wcoj-level-body">
                {lvl.candidates.map((c) => (
                  <div key={c.atom} className="wcoj-cand">
                    <span className="wcoj-cand-atom">{c.atom}</span>
                    <span className="wcoj-cand-vals">
                      {c.values.slice(0, 12).join(' ')}
                      {c.values.length > 12 ? ' …' : ''}
                    </span>
                  </div>
                ))}
                <div className="wcoj-inter">
                  <span className="wcoj-inter-tag">⋂ leapfrog</span>
                  <span className="wcoj-inter-vals">
                    {lvl.intersection.length === 0 ? '∅' : lvl.intersection.slice(0, 14).join(' ')}
                    {lvl.intersection.length > 14 ? ' …' : ''}
                  </span>
                </div>
              </div>
            </div>
          ))}
        </div>
      </div>

      <div className={`sk-verdict ${report.agree ? '' : 'warn'}`}>
        {report.agree ? (
          <>
            <strong>Verified.</strong> The Leapfrog Triejoin and the binary-join reference return the{' '}
            <strong>identical answer set</strong> ({fmt(report.outputSize)} rows), and the output stays within the
            AGM bound of <code>{fmt(report.agm.bound)}</code>. The binary plan meanwhile materialised an
            intermediate of <code>{fmt(report.binary.maxIntermediate)}</code> rows —{' '}
            <strong>{fmt1(report.blowup)}× the final answer</strong> — the exact work a worst-case-optimal join
            is proven never to do.
          </>
        ) : (
          <>
            <strong>Mismatch.</strong> The two engines disagreed — a bug the self-tests should have caught.
          </>
        )}
      </div>
    </div>
  )
}

/** Closed-form ρ* per shape, for the tab tags (kept in sync with `agm.ts`). */
function shapeCover(id: ShapeId): number {
  switch (id) {
    case 'triangle':
      return 1.5
    case 'path':
      return 2
    case 'cycle4':
      return 2
    case 'clique4':
      return 2
    case 'star':
      return 3
  }
}
