import { useMemo } from 'react'
import type { BuiltProblem } from '../problems'
import { cnfStats, toDimacs } from '../sat'

export function CnfView({ problem }: { problem: BuiltProblem }) {
  const stats = useMemo(() => cnfStats(problem.cnf), [problem])
  const dimacs = useMemo(() => {
    // Cap the rendered text so a 100k-clause formula doesn't lock the DOM.
    const text = toDimacs(problem.cnf)
    const lines = text.split('\n')
    if (lines.length > 600) return lines.slice(0, 600).join('\n') + `\n… (${lines.length - 600} more lines)`
    return text
  }, [problem])

  const cells: [string, string][] = [
    ['Variables', stats.numVars.toLocaleString()],
    ['Clauses', stats.numClauses.toLocaleString()],
    ['Literals', stats.literals.toLocaleString()],
    ['Unit clauses', stats.units.toLocaleString()],
    ['Max clause width', String(stats.maxWidth)],
    ['Avg clause width', stats.avgWidth.toFixed(2)],
  ]

  return (
    <div className="cnf-view">
      <div className="cnf-stats">
        {cells.map(([k, v]) => (
          <div key={k} className="cnf-stat">
            <span className="k">{k}</span>
            <span className="v">{v}</span>
          </div>
        ))}
      </div>
      <pre className="dimacs">{dimacs}</pre>
    </div>
  )
}
