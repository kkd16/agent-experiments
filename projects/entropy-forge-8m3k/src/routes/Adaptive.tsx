import { useMemo, useState } from 'react'
import { PageHeader, Panel, Stat } from '../components/ui'
import { InputPanel } from '../components/InputPanel'
import { FGKTree, adaptiveHuffmanEncode, type FGKNode } from '../lib/adaptiveHuffman'
import { huffmanEncode } from '../lib/huffman'
import { strToBytes } from '../lib/bits'
import { byteLabel } from '../lib/format'

const DEFAULT = 'abracadabra abracadabra'

// Rebuild the tree by feeding the first `k` symbols — cheap, and it lets the
// scrubber show any intermediate state without keeping a clone per step.
function treeAfter(data: Uint8Array, k: number): FGKTree {
  const t = new FGKTree()
  for (let i = 0; i < k && i < data.length; i++) t.update(data[i])
  return t
}

interface Pos {
  node: FGKNode
  x: number
  y: number
}

function layout(root: FGKNode): { positions: Pos[]; edges: [Pos, Pos][]; width: number; depth: number } {
  const positions: Pos[] = []
  const byId = new Map<number, Pos>()
  let leaf = 0
  let maxDepth = 0
  const assign = (node: FGKNode, depth: number): number => {
    maxDepth = Math.max(maxDepth, depth)
    let x: number
    if (!node.left && !node.right) {
      x = leaf++
    } else {
      const xs: number[] = []
      if (node.left) xs.push(assign(node.left, depth + 1))
      if (node.right) xs.push(assign(node.right, depth + 1))
      x = xs.reduce((a, b) => a + b, 0) / xs.length
    }
    const p: Pos = { node, x, y: depth }
    positions.push(p)
    byId.set(node.id, p)
    return x
  }
  assign(root, 0)
  const edges: [Pos, Pos][] = []
  for (const p of positions) {
    if (p.node.left) edges.push([p, byId.get(p.node.left.id)!])
    if (p.node.right) edges.push([p, byId.get(p.node.right.id)!])
  }
  return { positions, edges, width: Math.max(1, leaf), depth: maxDepth + 1 }
}

function nodeFill(n: FGKNode): string {
  if (n.symbol === -2) return 'var(--panel-2)' // NYT
  if (n.symbol === -1) return 'var(--panel-hi)' // internal
  return 'color-mix(in srgb, var(--teal) 26%, var(--panel-hi))' // leaf
}

function FGKTreeView({ root }: { root: FGKNode }) {
  const { positions, edges, width, depth } = useMemo(() => layout(root), [root])
  const colW = 74
  const rowH = 74
  const padX = 30
  const padY = 26
  const W = Math.max(320, (width - 1) * colW + padX * 2)
  const H = (depth - 1) * rowH + padY * 2 + 10
  const px = (x: number) => padX + x * colW
  const py = (y: number) => padY + y * rowH
  return (
    <div style={{ overflowX: 'auto' }}>
      <svg viewBox={`0 0 ${W} ${H}`} width="100%" style={{ minWidth: Math.min(W, 640) }}>
        {edges.map(([a, b], i) => (
          <line key={i} x1={px(a.x)} y1={py(a.y)} x2={px(b.x)} y2={py(b.y)} stroke="var(--border-hi)" strokeWidth={1.3} />
        ))}
        {edges.map(([a, b], i) => {
          const isLeft = a.node.left === b.node
          return (
            <text key={`l${i}`} x={(px(a.x) + px(b.x)) / 2 + (isLeft ? -7 : 7)} y={(py(a.y) + py(b.y)) / 2} fontSize={10} fill="var(--text-dim)" textAnchor="middle">
              {isLeft ? '0' : '1'}
            </text>
          )
        })}
        {positions.map((p, i) => {
          const n = p.node
          const label = n.symbol === -2 ? 'NYT' : n.symbol === -1 ? '' : byteLabel(n.symbol)
          return (
            <g key={i}>
              <circle cx={px(p.x)} cy={py(p.y)} r={15} fill={nodeFill(n)} stroke="var(--border-hi)" strokeWidth={1.2} />
              <text x={px(p.x)} y={py(p.y) + 4} textAnchor="middle" fontSize={n.symbol === -2 ? 8.5 : 11} fill="var(--text)" fontFamily="var(--mono)">
                {label}
              </text>
              <text x={px(p.x)} y={py(p.y) - 20} textAnchor="middle" fontSize={9.5} fill="var(--amber)" fontFamily="var(--mono)">
                {n.weight}
              </text>
            </g>
          )
        })}
      </svg>
    </div>
  )
}

export function Adaptive() {
  const [text, setText] = useState(DEFAULT)
  const data = useMemo(() => strToBytes(text), [text])
  const [step, setStep] = useState(9999)

  // The scrubber holds a large value by default (→ end of stream) and is clamped
  // to the current input length on every render.
  const maxStep = data.length
  const k = Math.min(step, maxStep)

  const tree = useMemo(() => treeAfter(data, k), [data, k])
  const full = useMemo(() => adaptiveHuffmanEncode(data), [data])
  const staticH = useMemo(() => (data.length > 0 ? huffmanEncode(data) : null), [data])

  // Codes currently assigned to each seen symbol (after k symbols).
  const codeTable = useMemo(() => {
    const rows: { symbol: number; code: string; weight: number }[] = []
    const root = tree.snapshot()
    const walk = (n: FGKNode, path: string) => {
      if (!n.left && !n.right) {
        if (n.symbol >= 0) rows.push({ symbol: n.symbol, code: path, weight: n.weight })
        return
      }
      if (n.left) walk(n.left, path + '0')
      if (n.right) walk(n.right, path + '1')
    }
    walk(root, '')
    return rows.sort((a, b) => b.weight - a.weight)
  }, [tree])

  const staticBytes = staticH ? Math.ceil(staticH.encodedBits / 8) : 0
  const staticTableBytes = staticH ? staticH.canonical.length * 2 + 8 : 0
  const adaptiveBytes = Math.ceil(full.encodedBits / 8)

  return (
    <div>
      <PageHeader
        kicker="Module 02 · one-pass coding"
        title="Adaptive Huffman — the tree that learns"
        lede={
          <>
            FGK builds the code <strong>as bytes arrive</strong>: no counting pass, no transmitted
            table. After every symbol it restores Gallager's <strong>sibling property</strong> by
            swapping the touched node up past any equal-weight node of higher rank, then increments
            weights to the root. A special <strong>NYT</strong> leaf escapes to a raw byte the first
            time a symbol appears. Scrub the slider to watch the tree reorganise itself.
          </>
        }
      />

      <Panel title="Input">
        <InputPanel value={text} onChange={setText} rows={3} />
        <div className="controls" style={{ marginTop: 14 }}>
          <label className="field" style={{ minWidth: 320, flex: 1 }}>
            after symbol {k} / {maxStep}
            <input type="range" min={0} max={maxStep} value={k} onChange={(e) => setStep(Number(e.target.value))} />
          </label>
          <div className="row" style={{ gap: 6 }}>
            <button className="btn small" onClick={() => setStep(Math.max(0, k - 1))} disabled={k === 0}>◀ step</button>
            <button className="btn small" onClick={() => setStep(Math.min(maxStep, k + 1))} disabled={k >= maxStep}>step ▶</button>
            <button className="btn small" onClick={() => setStep(maxStep)}>end</button>
          </div>
        </div>
        {k > 0 && k <= maxStep && (
          <div className="tag" style={{ marginTop: 4 }}>
            last symbol fed: <strong style={{ color: 'var(--teal)' }}>{byteLabel(data[k - 1])}</strong>
          </div>
        )}
      </Panel>

      <div className="grid grid-4" style={{ marginTop: 16 }}>
        <Stat label="Input" value={data.length} unit="B" />
        <Stat label="Adaptive (FGK)" value={adaptiveBytes} unit="B" accent sub={`${full.symbolsSeen} first-seen escapes`} />
        <Stat label="Static + table" value={staticBytes + staticTableBytes} unit="B" sub={`${staticBytes}B code + ${staticTableBytes}B table`} />
        <Stat
          label="one-pass edge"
          value={staticBytes + staticTableBytes > 0 ? `${(((staticBytes + staticTableBytes - adaptiveBytes) / (staticBytes + staticTableBytes)) * 100).toFixed(0)}%` : '—'}
          sub="saved vs static incl. its table"
        />
      </div>

      <Panel title={`FGK tree after ${k} symbol${k === 1 ? '' : 's'}`} note="amber = weight · leaves carry a byte or the NYT escape">
        {tree.snapshot() ? <FGKTreeView root={tree.snapshot()} /> : <div className="muted">Empty.</div>}
      </Panel>

      <Panel title="Current codes" note="the live code assigned to each symbol seen so far — these shift as weights change">
        {codeTable.length === 0 ? (
          <div className="muted">No symbols yet.</div>
        ) : (
          <div className="byte-grid">
            {codeTable.map((r) => (
              <span key={r.symbol} className="byte-cell" style={{ fontSize: 12 }}>
                {byteLabel(r.symbol)} <b style={{ color: 'var(--teal)' }}>{r.code}</b> <span style={{ color: 'var(--text-dim)' }}>·{r.weight}</span>
              </span>
            ))}
          </div>
        )}
      </Panel>
    </div>
  )
}
