import { useMemo, useState } from 'react'
import './BddStudio.css'
import {
  Bdd,
  compileExpr,
  reorder,
  reverseOrder,
  randomOrder,
  sift,
  layoutBdd,
  GALLERY,
} from '../bdd'
import type { NodeId, GalleryItem, Layout } from '../bdd'

// The maximum diagram we will draw; beyond this we ask the user to reorder first.
const DRAW_LIMIT = 600

interface BuiltState {
  ok: boolean
  bdd: Bdd
  root: NodeId
  varNames: string[]
  item?: GalleryItem
  error?: string
}

const PLACEHOLDER = '(a & b) | (c ^ d)'

export function BddStudio() {
  const [sourceKind, setSourceKind] = useState<'gallery' | 'expr'>('gallery')
  const [galleryId, setGalleryId] = useState<string>(GALLERY[0].id)
  const [exprText, setExprText] = useState<string>(PLACEHOLDER)
  // The active order (and any sift report) is tagged with the function it belongs
  // to; when the function changes, a stale order is simply ignored — no effect needed.
  const [orderState, setOrderState] = useState<{ key: string; order: number[] } | null>(null)
  const [siftState, setSiftState] = useState<{ key: string; before: number; after: number } | null>(null)
  const [shuffleSeed, setShuffleSeed] = useState(1)

  const baseKey = sourceKind === 'gallery' ? 'g:' + galleryId : 'e:' + exprText

  // Build the base function (in its natural order) from the chosen source.
  const base: BuiltState = useMemo(() => {
    if (sourceKind === 'gallery') {
      const item = GALLERY.find((g) => g.id === galleryId) ?? GALLERY[0]
      const f = item.build()
      return { ok: true, bdd: f.bdd, root: f.root, varNames: f.varNames, item }
    }
    try {
      const c = compileExpr(exprText.trim() || '0')
      return { ok: true, bdd: c.bdd, root: c.root, varNames: c.varNames }
    } catch (e) {
      const empty = new Bdd(0)
      return { ok: false, bdd: empty, root: 0, varNames: [], error: e instanceof Error ? e.message : String(e) }
    }
  }, [sourceKind, galleryId, exprText])

  const order = orderState && orderState.key === baseKey ? orderState.order : null
  const siftInfo = siftState && siftState.key === baseKey ? siftState : null

  // Apply the active variable order (reconstruct the diagram).
  const current = useMemo(() => {
    if (!base.ok) return base
    if (!order) return base
    const r = reorder(base.bdd, base.root, order)
    return { ok: true, bdd: r.bdd, root: r.root, varNames: base.varNames, item: base.item }
  }, [base, order])

  const stats = useMemo(() => {
    if (!current.ok) return null
    const { bdd, root } = current
    return {
      numVars: bdd.numVars,
      size: bdd.size(root),
      satCount: bdd.satCount(root),
      isTaut: root === 1,
      isContra: root === 0,
      order: bdd.order.slice(),
    }
  }, [current])

  const layout: Layout | null = useMemo(() => {
    if (!current.ok) return null
    const sz = current.bdd.size(current.root)
    if (sz > DRAW_LIMIT) return null
    return layoutBdd(current.bdd, current.root, current.varNames)
  }, [current])

  const numVars = base.ok ? base.bdd.numVars : 0

  const setOrder = (o: number[]) => {
    setOrderState({ key: baseKey, order: o })
    setSiftState(null)
  }
  const applySift = () => {
    if (!base.ok) return
    const s = sift(base.bdd, base.root)
    setOrderState({ key: baseKey, order: s.order })
    setSiftState({ key: baseKey, before: s.sizeBefore, after: s.sizeAfter })
  }
  const applyReverse = () => {
    if (current.ok) setOrder(reverseOrder(current.bdd.order))
  }
  const applyShuffle = () => {
    if (!base.ok) return
    const seed = shuffleSeed + 1
    setShuffleSeed(seed)
    setOrder(randomOrder(numVars, seed * 2654435761))
  }
  const reset = () => {
    setOrderState(null)
    setSiftState(null)
  }

  return (
    <div className="bdd-studio">
      <aside className="bdd-side">
        <div className="bdd-card">
          <h3>Function</h3>
          <div className="bdd-seg">
            <button className={sourceKind === 'gallery' ? 'on' : ''} onClick={() => setSourceKind('gallery')}>
              Gallery
            </button>
            <button className={sourceKind === 'expr' ? 'on' : ''} onClick={() => setSourceKind('expr')}>
              Expression
            </button>
          </div>

          {sourceKind === 'gallery' ? (
            <>
              <select className="bdd-select" value={galleryId} onChange={(e) => setGalleryId(e.target.value)}>
                {GALLERY.map((g) => (
                  <option key={g.id} value={g.id}>
                    {g.title}
                  </option>
                ))}
              </select>
              <p className="bdd-blurb">{base.item?.blurb}</p>
            </>
          ) : (
            <>
              <textarea
                className="bdd-expr"
                spellCheck={false}
                rows={3}
                value={exprText}
                onChange={(e) => setExprText(e.target.value)}
                placeholder={PLACEHOLDER}
              />
              <p className="bdd-hint">
                Operators: <code>! ~</code> not · <code>&amp; *</code> and · <code>|| +</code> or · <code>^</code> xor ·{' '}
                <code>-&gt;</code> implies · <code>&lt;-&gt; =</code> iff. Variables are bare names.
              </p>
              {!base.ok && <div className="bdd-err">⚠ {base.error}</div>}
            </>
          )}
        </div>

        <div className="bdd-card">
          <h3>Variable order</h3>
          <p className="bdd-hint">
            The order in which variables are tested decides whether a diagram is linear or exponential — same
            function, wildly different size.
          </p>
          <div className="bdd-order-btns">
            <button onClick={applySift} disabled={!base.ok || numVars > 24} title="Rudell sifting: search each variable's best level">
              ⤓ Sift (minimize)
            </button>
            <button onClick={applyReverse} disabled={!base.ok}>
              ⇄ Reverse
            </button>
            <button onClick={applyShuffle} disabled={!base.ok || numVars < 2}>
              ⤨ Shuffle
            </button>
            {base.item?.goodOrder && (
              <button onClick={() => setOrder(base.item!.goodOrder!)}>★ Good order</button>
            )}
            {base.item?.badOrder && (
              <button onClick={() => setOrder(base.item!.badOrder!)}>☠ Bad order</button>
            )}
            <button onClick={reset} disabled={!order}>
              ↺ Reset
            </button>
          </div>
          {siftInfo && (
            <div className="bdd-sift-note">
              Sift: {siftInfo.before} → <strong>{siftInfo.after}</strong> nodes
              {siftInfo.before > 0 && (
                <span className="bdd-shrink"> ({Math.round((1 - siftInfo.after / siftInfo.before) * 100)}% smaller)</span>
              )}
            </div>
          )}
          {stats && (
            <div className="bdd-order-chips">
              {stats.order.map((v, i) => (
                <span key={i} className="bdd-chip" title={`level ${i}`}>
                  {current.varNames[v] ?? `x${v}`}
                </span>
              ))}
            </div>
          )}
        </div>

        {stats && (
          <div className="bdd-card">
            <h3>Diagram</h3>
            <div className="bdd-stat-grid">
              <Stat value={String(stats.numVars)} label="variables" />
              <Stat value={String(stats.size)} label="nodes" />
              <Stat value={fmtCount(stats.satCount, stats.numVars)} label="solutions" />
              <Stat
                value={stats.isTaut ? 'tautology' : stats.isContra ? 'unsat' : stats.satCount > 0n ? 'sat' : '—'}
                label="status"
              />
            </div>
          </div>
        )}
      </aside>

      <main className="bdd-canvas">
        <div className="bdd-legend">
          <span>
            <svg width="34" height="12">
              <line x1="2" y1="6" x2="32" y2="6" stroke="var(--accent)" strokeWidth="2.5" />
            </svg>
            1-edge (then)
          </span>
          <span>
            <svg width="34" height="12">
              <line x1="2" y1="6" x2="32" y2="6" stroke="var(--muted)" strokeWidth="2" strokeDasharray="4 3" />
            </svg>
            0-edge (else)
          </span>
          <span className="bdd-term-key">▢ terminal 0 / 1</span>
        </div>

        {!current.ok ? (
          <div className="bdd-empty">Fix the expression to render its diagram.</div>
        ) : layout ? (
          <BddSvg layout={layout} />
        ) : (
          <div className="bdd-empty">
            This diagram has more than {DRAW_LIMIT} nodes in the current order — try <strong>Sift</strong> or a{' '}
            <strong>good order</strong> to shrink it, then it will draw.
          </div>
        )}
      </main>
    </div>
  )
}

function Stat({ value, label }: { value: string; label: string }) {
  return (
    <div className="bdd-stat">
      <div className="bdd-stat-v">{value}</div>
      <div className="bdd-stat-l">{label}</div>
    </div>
  )
}

function BddSvg({ layout }: { layout: Layout }) {
  const pos = new Map<number, { x: number; y: number }>()
  for (const n of layout.nodes) pos.set(n.id, { x: n.x, y: n.y })
  const R = 17
  return (
    <div className="bdd-svg-wrap">
      <svg
        viewBox={`0 0 ${layout.width} ${layout.height}`}
        style={{ maxWidth: layout.width, width: '100%' }}
        className="bdd-svg"
      >
        <g>
          {layout.edges.map((e, i) => {
            const a = pos.get(e.from)!
            const b = pos.get(e.to)!
            // route a touch around the source circle for clarity
            return (
              <line
                key={i}
                x1={a.x}
                y1={a.y + R}
                x2={b.x}
                y2={b.y - R}
                stroke={e.kind === 'hi' ? 'var(--accent)' : 'var(--muted)'}
                strokeWidth={e.kind === 'hi' ? 2.4 : 1.8}
                strokeDasharray={e.kind === 'hi' ? undefined : '5 4'}
                opacity={0.85}
              />
            )
          })}
        </g>
        <g>
          {layout.nodes.map((n) =>
            n.terminal ? (
              <g key={n.id}>
                <rect
                  x={n.x - 13}
                  y={n.y - 13}
                  width={26}
                  height={26}
                  rx={5}
                  fill={n.label === '1' ? 'rgba(34,197,94,0.18)' : 'rgba(239,71,111,0.16)'}
                  stroke={n.label === '1' ? 'var(--sat)' : 'var(--unsat)'}
                  strokeWidth={1.6}
                />
                <text x={n.x} y={n.y + 5} textAnchor="middle" className="bdd-term-label">
                  {n.label}
                </text>
              </g>
            ) : (
              <g key={n.id}>
                <circle cx={n.x} cy={n.y} r={R} fill="var(--panel-2)" stroke="var(--accent-2)" strokeWidth={1.6} />
                <text x={n.x} y={n.y + 5} textAnchor="middle" className="bdd-node-label">
                  {n.label}
                </text>
              </g>
            )
          )}
        </g>
      </svg>
    </div>
  )
}

function fmtCount(c: bigint, numVars: number): string {
  void numVars
  const s = c.toString()
  if (s.length <= 9) return Number(s).toLocaleString('en-US')
  const exp = s.length - 1
  return `${s[0]}.${s.slice(1, 3)}e${exp}`
}
