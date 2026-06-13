import { useMemo, useState } from 'react'
import type { Expr } from '../../lang/ast.ts'
import type { InferResult } from '../../lang/infer.ts'
import { layoutAst } from '../../astLayout.ts'
import { nodeTypeString } from '../../lang/pipeline.ts'

interface Props {
  ast: Expr | null
  typeResult: InferResult | null
}

const HSPACE = 132
const VSPACE = 78
const MARGIN = 40
const NODE_W = 108
const NODE_H = 34

export default function AstPanel({ ast, typeResult }: Props) {
  const [hover, setHover] = useState<number | null>(null)
  const layout = useMemo(() => (ast ? layoutAst(ast) : null), [ast])

  if (!ast || !layout) return <div className="panel-empty">No AST — fix the error first.</div>

  const width = (layout.maxGx + 1) * HSPACE + MARGIN * 2
  const height = (layout.maxDepth + 1) * VSPACE + MARGIN * 2
  const cx = (gx: number): number => MARGIN + gx * HSPACE + NODE_W / 2
  const cy = (depth: number): number => MARGIN + depth * VSPACE + NODE_H / 2

  const hoveredType =
    hover !== null ? nodeTypeString(typeResult, layout.nodes[hover].expr) : null

  return (
    <div className="ast-panel">
      <p className="panel-note">
        The parser builds this tree (function application binds tighter than operators). Hover a
        node to see its inferred type.
      </p>
      <div className="ast-scroll">
        <svg width={width} height={height} className="ast-svg">
          {layout.edges.map((e, i) => {
            const from = layout.nodes[e.from]
            const to = layout.nodes[e.to]
            return (
              <line
                key={i}
                x1={cx(from.gx)}
                y1={cy(from.depth) + NODE_H / 2}
                x2={cx(to.gx)}
                y2={cy(to.depth) - NODE_H / 2}
                className="ast-edge"
              />
            )
          })}
          {layout.nodes.map((n) => {
            const x = cx(n.gx) - NODE_W / 2
            const y = cy(n.depth) - NODE_H / 2
            return (
              <g
                key={n.index}
                className={`ast-node ${hover === n.index ? 'hover' : ''}`}
                onMouseEnter={() => setHover(n.index)}
                onMouseLeave={() => setHover((h) => (h === n.index ? null : h))}
              >
                <rect x={x} y={y} width={NODE_W} height={NODE_H} rx={8} />
                <text x={cx(n.gx)} y={cy(n.depth)} textAnchor="middle" dominantBaseline="central">
                  {n.label}
                </text>
              </g>
            )
          })}
        </svg>
      </div>
      {hoveredType && (
        <div className="ast-tip">
          <span className="type-label">type</span> <code>{hoveredType}</code>
        </div>
      )}
    </div>
  )
}
