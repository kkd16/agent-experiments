// The Storage Lab — a living, self-balancing B+Tree you can poke.
//
// Every index in QueryForge sits on the B+Tree in `db/storage/btree.ts`. This
// Lab makes that structure visible and interactive: insert and delete keys and
// watch leaves split, the root grow, underfull nodes borrow from a sibling or
// merge, and the whole tree collapse back toward a single leaf as it drains —
// each step narrated from the tree's own structural trace. A range scan lights
// up the leaf chain it walks. An invariant checker runs after every mutation and
// shows a green badge only while the structure is a provably valid B+Tree. The
// seventh sibling of the Optimizer / Execution / Vectorize / Compile / Fuzz /
// Concurrency / Recovery Labs.

import { useCallback, useMemo, useRef, useState } from 'react'
import { BTree, type LeafEntry, type TraceEvent, type TreeSnapshot, type SnapNode } from '../db/storage/btree'

const ORDERS = [4, 6, 8, 16] as const
const CELLW = 30
const CELLH = 26
const HGAP = 26
const LEVELH = 78
const PAD = 22

type TreeView = { snap: TreeSnapshot; stats: ReturnType<BTree['stats']>; invariants: string[] }
type Highlight = { nodes: Set<number>; visitedLeaves: Set<number>; matched: Set<string> }
const emptyHighlight = (): Highlight => ({ nodes: new Set(), visitedLeaves: new Set(), matched: new Set() })

interface Placed {
  node: SnapNode
  x: number // center
  y: number // top
  w: number
}

// Lay the tree out: leaves spread left-to-right by cumulative width, every
// parent centered over the span of its children.
function layout(snap: TreeSnapshot): { placed: Map<number, Placed>; width: number; height: number } {
  const placed = new Map<number, Placed>()
  const widthOf = (n: SnapNode) =>
    n.leaf ? Math.max(1, n.keys.length) * CELLW : Math.max(2, n.childIds.length) * (CELLW * 0.9)

  const depth = snap.levels.length
  // Leaves (deepest level) first.
  let cursor = PAD
  const leaves = snap.levels[depth - 1] ?? []
  for (const n of leaves) {
    const w = widthOf(n)
    placed.set(n.id, { node: n, x: cursor + w / 2, y: PAD + (depth - 1) * LEVELH, w })
    cursor += w + HGAP
  }
  // Internal levels, from the one above the leaves up to the root.
  for (let d = depth - 2; d >= 0; d--) {
    for (const n of snap.levels[d]) {
      const w = widthOf(n)
      const childXs = (n as Extract<SnapNode, { leaf: false }>).childIds
        .map((id) => placed.get(id)?.x)
        .filter((x): x is number => x !== undefined)
      const cx = childXs.length ? (Math.min(...childXs) + Math.max(...childXs)) / 2 : cursor
      placed.set(n.id, { node: n, x: cx, y: PAD + d * LEVELH, w })
    }
  }
  let maxRight = 0
  for (const p of placed.values()) maxRight = Math.max(maxRight, p.x + p.w / 2)
  return { placed, width: maxRight + PAD, height: PAD * 2 + depth * LEVELH }
}

function kindLabel(k: TraceEvent['kind']): string {
  switch (k) {
    case 'split-leaf':
    case 'split-internal':
      return 'split'
    case 'grow-root':
      return 'grow'
    case 'shrink-root':
      return 'shrink'
    case 'borrow-left':
    case 'borrow-right':
      return 'borrow'
    case 'merge':
      return 'merge'
    case 'insert':
      return 'insert'
    case 'remove':
      return 'remove'
    case 'not-found':
      return 'no-op'
    default:
      return 'walk'
  }
}

export function StorageLab() {
  const [order, setOrder] = useState<number>(4)
  const treeRef = useRef<BTree>(new BTree(4))
  const keysRef = useRef<Set<number>>(new Set())

  // Derived view of the tree, recomputed (off-render) after every mutation so
  // render never has to read the mutable ref.
  const [view, setView] = useState<TreeView>(() => {
    const t = new BTree(4)
    return { snap: t.snapshot(), stats: t.stats(), invariants: t.checkInvariants() }
  })
  const commit = useCallback(() => {
    const t = treeRef.current
    setView({ snap: t.snapshot(), stats: t.stats(), invariants: t.checkInvariants() })
  }, [])
  const rerender = commit

  const [trace, setTrace] = useState<TraceEvent[]>([])
  const [highlight, setHighlight] = useState<Highlight>(emptyHighlight)
  const [keyInput, setKeyInput] = useState('')
  const [rangeLo, setRangeLo] = useState('')
  const [rangeHi, setRangeHi] = useState('')
  const [message, setMessage] = useState<string>('Insert keys, then delete them and watch the tree rebalance.')

  // A scripted story the user can step through one operation at a time.
  const [demo, setDemo] = useState<{ ops: { op: 'ins' | 'del'; key: number }[]; i: number } | null>(null)

  const rebuild = useCallback((newOrder: number, useBulk = false) => {
    const sorted = [...keysRef.current].sort((a, b) => a - b)
    if (useBulk) {
      const entries: LeafEntry[] = sorted.map((k) => ({ key: [k], rowids: [k] }))
      treeRef.current = BTree.bulkLoad(entries, newOrder, 0.7)
    } else {
      const t = new BTree(newOrder)
      for (const k of sorted) t.insert([k], k)
      treeRef.current = t
    }
  }, [])

  const applyHighlightFromTrace = useCallback((tr: TraceEvent[]) => {
    const nodes = new Set<number>()
    for (const e of tr) for (const id of e.nodes) if (e.kind !== 'descend') nodes.add(id)
    setHighlight({ nodes, visitedLeaves: new Set(), matched: new Set() })
  }, [])

  const doInsert = useCallback(
    (k: number) => {
      const tr: TraceEvent[] = []
      const existed = keysRef.current.has(k)
      treeRef.current.insert([k], k, tr)
      keysRef.current.add(k)
      setTrace(tr)
      applyHighlightFromTrace(tr)
      setMessage(existed ? `Key ${k} already present — no structural change.` : `Inserted ${k}.`)
      rerender()
    },
    [applyHighlightFromTrace, rerender],
  )

  const doDelete = useCallback(
    (k: number) => {
      const tr: TraceEvent[] = []
      treeRef.current.remove([k], k, tr)
      keysRef.current.delete(k)
      setTrace(tr)
      applyHighlightFromTrace(tr)
      const merged = tr.some((e) => e.kind === 'merge')
      const borrowed = tr.some((e) => e.kind.startsWith('borrow'))
      const shrank = tr.some((e) => e.kind === 'shrink-root')
      const notes = [borrowed && 'borrowed from a sibling', merged && 'merged two nodes', shrank && 'collapsed the root'].filter(Boolean)
      setMessage(tr.some((e) => e.kind === 'not-found') ? `Key ${k} not present.` : `Deleted ${k}${notes.length ? ' — ' + notes.join(', ') : ''}.`)
      rerender()
    },
    [applyHighlightFromTrace, rerender],
  )

  const doInsertInput = useCallback(() => {
    const k = parseInt(keyInput, 10)
    if (Number.isFinite(k)) doInsert(k)
    setKeyInput('')
  }, [keyInput, doInsert])

  const doDeleteInput = useCallback(() => {
    const k = parseInt(keyInput, 10)
    if (Number.isFinite(k)) doDelete(k)
    setKeyInput('')
  }, [keyInput, doDelete])

  // A deterministic-feeling spread of keys without Math.random in the engine.
  const seedRef = useRef(0x2f6e1)
  const nextRand = useCallback((n: number) => {
    seedRef.current = (Math.imul(seedRef.current ^ (seedRef.current >>> 15), 0x2c1b3c6d) + 0x6d2b79f5) | 0
    return Math.abs(seedRef.current) % n
  }, [])

  const insertRandom = useCallback(() => {
    let k = nextRand(99) + 1
    let guard = 0
    while (keysRef.current.has(k) && guard++ < 200) k = nextRand(99) + 1
    doInsert(k)
  }, [nextRand, doInsert])

  const deleteRandom = useCallback(() => {
    const present = [...keysRef.current]
    if (!present.length) return
    doDelete(present[nextRand(present.length)])
  }, [nextRand, doDelete])

  const bulkLoad = useCallback(() => {
    const set = new Set<number>()
    while (set.size < 40) set.add(nextRand(200) + 1)
    keysRef.current = set
    rebuild(order, true)
    setTrace([])
    setHighlight(emptyHighlight())
    setMessage('Bulk-loaded 40 sorted keys bottom-up, packed to ~70% fill (how a real CREATE INDEX builds).')
    rerender()
  }, [nextRand, order, rebuild, rerender])

  const clear = useCallback(() => {
    keysRef.current = new Set()
    treeRef.current = new BTree(order)
    setTrace([])
    setHighlight(emptyHighlight())
    setDemo(null)
    setMessage('Cleared. Insert keys to begin.')
    rerender()
  }, [order, rerender])

  const changeOrder = useCallback(
    (o: number) => {
      setOrder(o)
      rebuild(o, false)
      setTrace([])
      setHighlight(emptyHighlight())
      setMessage(`Rebuilt at fanout ${o} (max ${o} entries per leaf; a node splits above that and rebalances below ⌈${o}/2⌉ = ${Math.ceil(o / 2)}).`)
      rerender()
    },
    [rebuild, rerender],
  )

  const runRange = useCallback(() => {
    const lo = rangeLo.trim() === '' ? null : [parseInt(rangeLo, 10)]
    const hi = rangeHi.trim() === '' ? null : [parseInt(rangeHi, 10)]
    const res = treeRef.current.rangeTraced(lo, hi)
    setTrace([])
    setHighlight({ nodes: new Set(), visitedLeaves: new Set(res.visitedLeaves), matched: new Set(res.matchedKeys.map((k) => String(k[0]))) })
    setMessage(`Range scan ${lo ? lo[0] : '−∞'} … ${hi ? hi[0] : '+∞'}: walked ${res.visitedLeaves.length} leaf node(s), matched ${res.matchedKeys.length} key(s) along the leaf chain.`)
    rerender()
  }, [rangeLo, rangeHi, rerender])

  // --- guided story -------------------------------------------------------
  const loadDemo = useCallback(() => {
    setOrder(4)
    keysRef.current = new Set()
    treeRef.current = new BTree(4)
    const ops: { op: 'ins' | 'del'; key: number }[] = []
    for (let i = 1; i <= 13; i++) ops.push({ op: 'ins', key: i * 5 })
    // Delete in an order that forces a borrow, then merges, then a collapse.
    for (const key of [5, 10, 15, 20, 25, 30, 35, 40, 45, 50, 55, 60, 65]) ops.push({ op: 'del', key })
    setDemo({ ops, i: 0 })
    setTrace([])
    setHighlight(emptyHighlight())
    setMessage('Guided demo loaded at fanout 4. Step through to watch growth, borrow, merge and collapse.')
    rerender()
  }, [rerender])

  const stepDemo = useCallback(() => {
    if (!demo) return
    const step = demo.ops[demo.i]
    if (!step) return
    if (step.op === 'ins') doInsert(step.key)
    else doDelete(step.key)
    setDemo({ ...demo, i: demo.i + 1 })
  }, [demo, doInsert, doDelete])

  const snap = view.snap
  const { placed, width, height } = useMemo(() => layout(snap), [snap])
  const stats = view.stats
  const invariants = view.invariants
  const ok = invariants.length === 0

  return (
    <div className="lab storage-lab">
      <div className="lab-head">
        <h2>Storage Lab</h2>
        <p className="lab-sub">
          The self-balancing <em>B+Tree</em> under every index — insert, delete, bulk-load and range-scan a live tree and
          watch it <em>split</em>, <em>borrow</em>, <em>merge</em> and <em>collapse</em>, each step proven valid.
        </p>
      </div>

      <div className="sl-controls">
        <div className="sl-ctrl-group">
          <span className="sl-ctrl-label">fanout</span>
          {ORDERS.map((o) => (
            <button key={o} className={`sl-chip ${order === o ? 'active' : ''}`} onClick={() => changeOrder(o)}>
              {o}
            </button>
          ))}
        </div>
        <div className="sl-ctrl-group">
          <input
            className="sl-input"
            type="number"
            placeholder="key"
            value={keyInput}
            onChange={(e) => setKeyInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') doInsertInput()
            }}
          />
          <button className="sl-btn accent" onClick={doInsertInput}>
            Insert
          </button>
          <button className="sl-btn" onClick={doDeleteInput}>
            Delete
          </button>
        </div>
        <div className="sl-ctrl-group">
          <button className="sl-btn" onClick={insertRandom}>
            + random
          </button>
          <button className="sl-btn" onClick={deleteRandom}>
            − random
          </button>
          <button className="sl-btn" onClick={bulkLoad}>
            Bulk-load 40
          </button>
          <button className="sl-btn ghost" onClick={clear}>
            Clear
          </button>
        </div>
        <div className="sl-ctrl-group">
          <span className="sl-ctrl-label">range</span>
          <input className="sl-input narrow" type="number" placeholder="lo" value={rangeLo} onChange={(e) => setRangeLo(e.target.value)} />
          <span className="sl-dash">…</span>
          <input className="sl-input narrow" type="number" placeholder="hi" value={rangeHi} onChange={(e) => setRangeHi(e.target.value)} />
          <button className="sl-btn" onClick={runRange}>
            Scan
          </button>
        </div>
        <div className="sl-ctrl-group">
          {!demo ? (
            <button className="sl-btn accent" onClick={loadDemo}>
              ▶ Guided demo
            </button>
          ) : (
            <>
              <button className="sl-btn accent" onClick={stepDemo} disabled={demo.i >= demo.ops.length}>
                Step ▸ ({demo.i}/{demo.ops.length})
              </button>
              <button className="sl-btn ghost" onClick={() => setDemo(null)}>
                Exit demo
              </button>
            </>
          )}
        </div>
      </div>

      <div className="sl-statbar">
        <span className={`sl-badge ${ok ? 'good' : 'bad'}`}>{ok ? '✓ valid B+Tree' : `✗ ${invariants.length} violation(s)`}</span>
        <span className="sl-stat">height <strong>{stats.height}</strong></span>
        <span className="sl-stat">nodes <strong>{stats.nodes}</strong></span>
        <span className="sl-stat">leaves <strong>{stats.leaves}</strong></span>
        <span className="sl-stat">keys <strong>{stats.entries}</strong></span>
        <span className="sl-stat">fill <strong>{(stats.fill * 100).toFixed(0)}%</strong></span>
      </div>

      <div className="sl-message">{message}</div>

      <div className="sl-canvas-wrap">
        {stats.entries === 0 ? (
          <div className="sl-empty">The tree is empty — a single leaf. Insert a key to begin.</div>
        ) : (
          <svg
            className="sl-svg"
            width={Math.max(width, 320)}
            height={height}
            viewBox={`0 0 ${Math.max(width, 320)} ${height}`}
            role="img"
            aria-label="B+Tree structure"
          >
            <TreeEdges placed={placed} />
            <LeafChain snap={snap} placed={placed} />
            {[...placed.values()].map((p) => (
              <NodeBox key={p.node.id} p={p} highlight={highlight} />
            ))}
          </svg>
        )}
      </div>

      <div className="sl-lower">
        <div className="sl-trace">
          <div className="sl-panel-title">Operation trace</div>
          {trace.length === 0 ? (
            <div className="sl-trace-empty">Run an operation to see the structural steps it took.</div>
          ) : (
            <ol className="sl-trace-list">
              {trace.map((e, i) => (
                <li key={i} className={`sl-trace-item k-${kindLabel(e.kind)}`}>
                  <span className="sl-trace-kind">{kindLabel(e.kind)}</span>
                  <span className="sl-trace-detail">{e.detail}</span>
                </li>
              ))}
            </ol>
          )}
        </div>
        <div className="sl-notes">
          <div className="sl-panel-title">How it balances</div>
          <ul className="sl-note-list">
            <li>A leaf holds up to <strong>{order}</strong> keys; the {order + 1}st <strong>splits</strong> it and pushes a separator up — the root <strong>grows</strong> when it splits.</li>
            <li>A delete that drops a node below <strong>⌈{order}/2⌉ = {Math.ceil(order / 2)}</strong> slots <strong>borrows</strong> a key from a fuller sibling, or <strong>merges</strong> with one.</li>
            <li>When the root is left with a single child it <strong>collapses</strong>, so an emptied tree returns to height 1.</li>
            <li>Every leaf sits at the same depth and the leaf chain (dashed) stays sorted — the <span className="sl-inline-badge">✓ valid</span> badge re-checks all of it after each step.</li>
          </ul>
        </div>
      </div>
    </div>
  )
}

function TreeEdges({ placed }: { placed: Map<number, Placed> }) {
  const edges: { x1: number; y1: number; x2: number; y2: number; key: string }[] = []
  for (const p of placed.values()) {
    if (p.node.leaf) continue
    const childIds = p.node.childIds
    const c = childIds.length
    for (let i = 0; i < c; i++) {
      const child = placed.get(childIds[i])
      if (!child) continue
      const px = p.x - p.w / 2 + ((i + 0.5) * p.w) / c
      edges.push({ x1: px, y1: p.y + CELLH, x2: child.x, y2: child.y, key: `${p.node.id}-${childIds[i]}` })
    }
  }
  return (
    <g className="sl-edges">
      {edges.map((e) => (
        <line key={e.key} x1={e.x1} y1={e.y1} x2={e.x2} y2={e.y2} className="sl-edge" />
      ))}
    </g>
  )
}

function LeafChain({ snap, placed }: { snap: TreeSnapshot; placed: Map<number, Placed> }) {
  const segs: { x1: number; y: number; x2: number; key: string }[] = []
  for (let i = 0; i + 1 < snap.leafOrder.length; i++) {
    const a = placed.get(snap.leafOrder[i])
    const b = placed.get(snap.leafOrder[i + 1])
    if (!a || !b) continue
    segs.push({ x1: a.x + a.w / 2, y: a.y + CELLH / 2, x2: b.x - b.w / 2, key: `${snap.leafOrder[i]}` })
  }
  return (
    <g className="sl-leafchain">
      {segs.map((s) => (
        <line key={s.key} x1={s.x1} y1={s.y} x2={s.x2} y2={s.y} className="sl-chain-edge" markerEnd="url(#sl-arrow)" />
      ))}
      <defs>
        <marker id="sl-arrow" markerWidth="6" markerHeight="6" refX="5" refY="3" orient="auto">
          <path d="M0,0 L6,3 L0,6 Z" className="sl-arrow-head" />
        </marker>
      </defs>
    </g>
  )
}

function NodeBox({ p, highlight }: { p: Placed; highlight: Highlight }) {
  const touched = highlight.nodes.has(p.node.id)
  const visited = highlight.visitedLeaves.has(p.node.id)
  const x0 = p.x - p.w / 2
  if (p.node.leaf) {
    const keys = p.node.keys
    const cells = keys.length || 1
    const cw = p.w / cells
    return (
      <g className={`sl-node leaf ${touched ? 'touched' : ''} ${visited ? 'visited' : ''}`}>
        <rect x={x0} y={p.y} width={p.w} height={CELLH} rx={5} className="sl-node-rect" />
        {keys.map((kStr, i) => {
          const matched = highlight.matched.has(kStr)
          return (
            <g key={i}>
              {matched && <rect x={x0 + i * cw + 1} y={p.y + 1} width={cw - 2} height={CELLH - 2} rx={3} className="sl-cell-match" />}
              {i > 0 && <line x1={x0 + i * cw} y1={p.y + 3} x2={x0 + i * cw} y2={p.y + CELLH - 3} className="sl-cell-div" />}
              <text x={x0 + (i + 0.5) * cw} y={p.y + CELLH / 2 + 4} textAnchor="middle" className="sl-key">
                {kStr}
              </text>
            </g>
          )
        })}
      </g>
    )
  }
  const keys = p.node.keys
  return (
    <g className={`sl-node internal ${touched ? 'touched' : ''}`}>
      <rect x={x0} y={p.y} width={p.w} height={CELLH} rx={5} className="sl-node-rect" />
      {keys.map((kStr, i) => {
        const cx = x0 + ((i + 1) * p.w) / (keys.length + 1)
        return (
          <text key={i} x={cx} y={p.y + CELLH / 2 + 4} textAnchor="middle" className="sl-sep">
            {kStr}
          </text>
        )
      })}
    </g>
  )
}
