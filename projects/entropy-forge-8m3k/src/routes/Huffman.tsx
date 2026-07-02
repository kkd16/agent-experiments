import { useMemo, useState } from 'react'
import { PageHeader, Panel, Stat } from '../components/ui'
import { InputPanel } from '../components/InputPanel'
import { huffmanEncode, type HuffNode } from '../lib/huffman'
import { analyze } from '../lib/entropy'
import { strToBytes } from '../lib/bits'
import { byteLabel, fmtNum } from '../lib/format'

// Lay out the Huffman tree: leaves spread evenly left-to-right, internal nodes
// centred over their children, depth mapped to rows. Drawn as pure SVG.
interface Pos {
  node: HuffNode
  x: number
  y: number
  depth: number
}
function layout(root: HuffNode | null): { positions: Pos[]; edges: [Pos, Pos, string][]; width: number; depth: number } {
  const positions: Pos[] = []
  const edges: [Pos, Pos, string][] = []
  if (!root) return { positions, edges, width: 1, depth: 1 }
  let leaf = 0
  let maxDepth = 0
  const map = new Map<HuffNode, Pos>()
  const assign = (node: HuffNode, depth: number): number => {
    maxDepth = Math.max(maxDepth, depth)
    let x: number
    if (node.symbol !== null || (!node.left && !node.right)) {
      x = leaf++
    } else {
      const xs: number[] = []
      if (node.left) xs.push(assign(node.left, depth + 1))
      if (node.right) xs.push(assign(node.right, depth + 1))
      x = xs.reduce((a, b) => a + b, 0) / xs.length
    }
    const p: Pos = { node, x, y: depth, depth }
    positions.push(p)
    map.set(node, p)
    return x
  }
  assign(root, 0)
  for (const p of positions) {
    if (p.node.left) edges.push([p, map.get(p.node.left)!, '0'])
    if (p.node.right) edges.push([p, map.get(p.node.right)!, '1'])
  }
  return { positions, edges, width: Math.max(1, leaf), depth: maxDepth + 1 }
}

function HuffTree({ root }: { root: HuffNode | null }) {
  const { positions, edges, width, depth } = useMemo(() => layout(root), [root])
  if (!root) return <div className="muted">Empty input.</div>
  const colW = 46
  const rowH = 62
  const padX = 30
  const padY = 26
  const W = Math.max(320, (width - 1) * colW + padX * 2)
  const H = (depth - 1) * rowH + padY * 2
  const px = (x: number) => padX + x * colW
  const py = (y: number) => padY + y * rowH
  return (
    <div style={{ overflowX: 'auto' }}>
      <svg viewBox={`0 0 ${W} ${H}`} width="100%" style={{ minWidth: Math.min(W, 640) }}>
        {edges.map(([a, b, bit], i) => {
          const mx = (px(a.x) + px(b.x)) / 2
          const my = (py(a.y) + py(b.y)) / 2
          return (
            <g key={i}>
              <line x1={px(a.x)} y1={py(a.y)} x2={px(b.x)} y2={py(b.y)} stroke="var(--border-hi)" strokeWidth={1.4} />
              <circle cx={mx} cy={my} r={8} fill="var(--panel-2)" stroke="var(--border-hi)" />
              <text x={mx} y={my + 3} textAnchor="middle" fontSize={9} fill={bit === '1' ? 'var(--amber)' : 'var(--blue)'}>
                {bit}
              </text>
            </g>
          )
        })}
        {positions.map((p, i) => {
          const isLeaf = p.node.symbol !== null
          return (
            <g key={i}>
              <circle
                cx={px(p.x)}
                cy={py(p.y)}
                r={isLeaf ? 13 : 6}
                fill={isLeaf ? 'color-mix(in srgb, var(--teal) 22%, var(--panel))' : 'var(--panel-hi)'}
                stroke={isLeaf ? 'var(--teal)' : 'var(--border-hi)'}
                strokeWidth={1.4}
              />
              {isLeaf && (
                <text x={px(p.x)} y={py(p.y) + 4} textAnchor="middle" fontSize={11} fill="var(--text)">
                  {byteLabel(p.node.symbol!)}
                </text>
              )}
              {isLeaf && (
                <text x={px(p.x)} y={py(p.y) + 27} textAnchor="middle" fontSize={9} fill="var(--text-dim)">
                  {p.node.weight}
                </text>
              )}
            </g>
          )
        })}
      </svg>
    </div>
  )
}

export function Huffman() {
  const [text, setText] = useState('huffman coding assigns short codes to frequent symbols')
  const data = useMemo(() => strToBytes(text), [text])
  const result = useMemo(() => huffmanEncode(data), [data])
  const report = useMemo(() => analyze(data), [data])

  const encodedBitString = useMemo(() => {
    // Reconstruct the bit string colored by symbol boundaries (first ~600 bits).
    let s = ''
    for (const b of data) {
      const code = result.codes.get(b)
      if (code) s += code + ' '
      if (s.length > 700) break
    }
    return s.trim()
  }, [data, result])

  const origBits = data.length * 8
  const ratio = origBits > 0 ? result.encodedBits / origBits : 1

  return (
    <div>
      <PageHeader
        kicker="Module 02 · Entropy coding"
        title="Huffman Coding"
        lede={
          <>
            Huffman's algorithm (1952) builds a provably optimal prefix code: repeatedly merge the
            two least-frequent nodes into a binary tree, then read each symbol's code off the path
            from the root. Frequent symbols land near the top and earn the shortest codes.
          </>
        }
      />

      <Panel title="Input">
        <InputPanel value={text} onChange={setText} rows={3} />
      </Panel>

      <div className="grid grid-4" style={{ marginTop: 16 }}>
        <Stat label="Original" value={origBits} unit="bits" sub={`${data.length} bytes × 8`} />
        <Stat label="Huffman" value={result.encodedBits} unit="bits" accent sub={`${Math.ceil(result.encodedBits / 8)} bytes packed`} />
        <Stat label="Avg code length" value={fmtNum(result.avgLength)} unit="bits/sym" sub={`entropy ${fmtNum(report.order0)}`} />
        <Stat label="Ratio" value={`${(ratio * 100).toFixed(0)}%`} sub={`${fmtNum((1 - ratio) * 100, 0)}% smaller`} />
      </div>

      <Panel title="The code tree" note="Leaves are symbols (weight = count). Left edge = 0, right edge = 1.">
        <HuffTree root={result.tree} />
      </Panel>

      <div className="grid grid-2">
        <Panel title="Canonical code table" note="The length-only form real formats transmit.">
          <div className="table-wrap" style={{ maxHeight: 300, overflowY: 'auto' }}>
            <table className="data">
              <thead>
                <tr>
                  <th>Symbol</th>
                  <th>Count</th>
                  <th>Length</th>
                  <th>Code</th>
                </tr>
              </thead>
              <tbody>
                {result.canonical.map((c) => (
                  <tr key={c.symbol}>
                    <td className="mono">{byteLabel(c.symbol)}</td>
                    <td className="num">{report.stats.find((s) => s.symbol === c.symbol)?.count ?? 0}</td>
                    <td className="num">{c.length}</td>
                    <td className="mono" style={{ color: 'var(--teal)' }}>{c.code}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Panel>
        <Panel title="Encoded bitstream" note="Each group is one symbol's code, in order.">
          <div className="bitstream">{encodedBitString || <span className="muted">—</span>}</div>
          <p className="muted" style={{ fontSize: 13, marginTop: 12 }}>
            Huffman is optimal among <em>integer-length</em> codes, but it must spend a whole number
            of bits per symbol — so it loses up to ~1 bit/symbol versus the entropy when
            probabilities are not powers of two. Arithmetic coding closes that gap.
          </p>
        </Panel>
      </div>
    </div>
  )
}
