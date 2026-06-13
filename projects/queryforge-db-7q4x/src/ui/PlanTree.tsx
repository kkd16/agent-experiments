// Visualizes an EXPLAIN plan as a top-down operator tree. Each node shows the
// chosen operator, its detail, estimated rows/cost, and (for ANALYZE) the
// actual rows produced. A cost bar makes the heavy operators pop.

import type { PlanNode } from '../db/operators'

function maxCost(n: PlanNode): number {
  return Math.max(n.estCost, ...n.children.map(maxCost))
}

function Node({ node, peak, analyze }: { node: PlanNode; peak: number; analyze: boolean }) {
  const pct = peak > 0 ? Math.min(100, (node.estCost / peak) * 100) : 0
  const misEstimate =
    analyze && node.estRows > 0 ? Math.abs(node.actualRows - node.estRows) / Math.max(node.estRows, 1) > 1.5 : false
  return (
    <li>
      <div className="plan-node">
        <div className="plan-node-head">
          <span className="plan-op">{node.op}</span>
          {node.detail && <span className="plan-detail">{node.detail}</span>}
        </div>
        <div className="plan-metrics">
          <span title="estimated rows">~{formatNum(node.estRows)} rows</span>
          <span title="estimated cost">cost {node.estCost.toFixed(2)}</span>
          {analyze && (
            <span className={misEstimate ? 'plan-actual mis' : 'plan-actual'} title="actual rows (ANALYZE)">
              actual {formatNum(node.actualRows)}
            </span>
          )}
        </div>
        {node.extra.length > 0 && (
          <div className="plan-extra">
            {node.extra.map((x, i) => (
              <span key={i}>{x}</span>
            ))}
          </div>
        )}
        <div className="plan-cost-bar">
          <div className="plan-cost-fill" style={{ width: `${pct}%` }} />
        </div>
      </div>
      {node.children.length > 0 && (
        <ul className="plan-children">
          {node.children.map((c, i) => (
            <Node key={i} node={c} peak={peak} analyze={analyze} />
          ))}
        </ul>
      )}
    </li>
  )
}

function formatNum(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(Math.round(n))
}

export function PlanTree({ plan, analyze }: { plan: PlanNode; analyze: boolean }) {
  const peak = maxCost(plan)
  return (
    <div className="plan-tree">
      <ul className="plan-root">
        <Node node={plan} peak={peak} analyze={analyze} />
      </ul>
    </div>
  )
}
