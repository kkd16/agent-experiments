import type { BuiltProblem } from '../problems'
import type { SolveResult } from '../sat'

export function SolutionView({ problem, result }: { problem: BuiltProblem; result: SolveResult }) {
  if (result.status === 'unsat')
    return (
      <Verdict tone="unsat" label="UNSATISFIABLE">
        No assignment satisfies the formula. The solver derived the empty clause through resolution
        of its learnt clauses — a machine-checked proof of unsatisfiability.
      </Verdict>
    )
  if (result.status === 'unknown')
    return (
      <Verdict tone="unknown" label="UNKNOWN">
        {result.message ?? 'The solver hit its resource budget before deciding.'}
      </Verdict>
    )

  // SAT — render the decoded solution per problem type.
  const model = result.model!
  return (
    <div className="solution">
      <Verdict tone="sat" label="SATISFIABLE">
        A satisfying assignment was found and verified.
      </Verdict>
      {problem.render === 'queens' && problem.decodeQueens && (
        <QueensBoard sol={problem.decodeQueens(model)} />
      )}
      {problem.render === 'sudoku' && problem.decodeSudoku && (
        <SudokuBoard sol={problem.decodeSudoku(model)} clues={problem.clues ?? []} />
      )}
      {problem.render === 'coloring' && problem.decodeColoring && problem.graph && (
        <ColoringView sol={problem.decodeColoring(model)} graph={problem.graph} />
      )}
      {problem.render === 'model' && <ModelView model={model} />}
    </div>
  )
}

function Verdict({
  tone,
  label,
  children,
}: {
  tone: 'sat' | 'unsat' | 'unknown'
  label: string
  children: React.ReactNode
}) {
  return (
    <div className={`verdict verdict-${tone}`}>
      <span className="verdict-badge">{label}</span>
      <p>{children}</p>
    </div>
  )
}

function QueensBoard({ sol }: { sol: { n: number; queens: number[] } }) {
  const { n, queens } = sol
  const cells = []
  for (let r = 0; r < n; r++)
    for (let c = 0; c < n; c++) {
      const dark = (r + c) % 2 === 1
      const queen = queens[r] === c
      cells.push(
        <div key={`${r}-${c}`} className={`cell ${dark ? 'dark' : 'light'}`}>
          {queen && <span className="queen">♛</span>}
        </div>,
      )
    }
  return (
    <div
      className="board queens-board"
      style={{ gridTemplateColumns: `repeat(${n}, 1fr)`, maxWidth: Math.min(520, n * 56) }}
    >
      {cells}
    </div>
  )
}

function SudokuBoard({ sol, clues }: { sol: { size: number; grid: number[] }; clues: number[] }) {
  const { grid } = sol
  return (
    <div className="sudoku">
      {grid.map((d, i) => {
        const r = Math.floor(i / 9)
        const c = i % 9
        const given = clues[i] > 0
        const thickRight = c % 3 === 2 && c !== 8
        const thickBottom = r % 3 === 2 && r !== 8
        return (
          <div
            key={i}
            className={`sudoku-cell ${given ? 'given' : 'filled'} ${thickRight ? 'br' : ''} ${
              thickBottom ? 'bb' : ''
            }`}
          >
            {d || ''}
          </div>
        )
      })}
    </div>
  )
}

const PALETTE = ['#ef476f', '#06d6a0', '#118ab2', '#ffd166', '#9b5de5', '#f15bb5', '#00bbf9', '#fb8500']

function ColoringView({
  sol,
  graph,
}: {
  sol: { colors: number[]; numVertices: number; k: number }
  graph: { numVertices: number; edges: [number, number][] }
}) {
  const n = graph.numVertices
  const size = 360
  const cx = size / 2
  const cy = size / 2
  const radius = size / 2 - 28
  const pts = Array.from({ length: n }, (_, i) => {
    const a = (i / n) * Math.PI * 2 - Math.PI / 2
    return { x: cx + radius * Math.cos(a), y: cy + radius * Math.sin(a) }
  })
  return (
    <svg className="coloring" viewBox={`0 0 ${size} ${size}`} width={size} height={size}>
      {graph.edges.map(([a, b], i) => (
        <line
          key={i}
          x1={pts[a].x}
          y1={pts[a].y}
          x2={pts[b].x}
          y2={pts[b].y}
          stroke="rgba(148,163,184,0.35)"
          strokeWidth={1.2}
        />
      ))}
      {pts.map((p, i) => (
        <g key={i}>
          <circle
            cx={p.x}
            cy={p.y}
            r={13}
            fill={PALETTE[(sol.colors[i] + PALETTE.length) % PALETTE.length] ?? '#64748b'}
            stroke="#0b1020"
            strokeWidth={2}
          />
          <text x={p.x} y={p.y + 4} textAnchor="middle" className="vlabel">
            {i}
          </text>
        </g>
      ))}
    </svg>
  )
}

function ModelView({ model }: { model: boolean[] }) {
  const vars = model.length - 1
  const shown = Math.min(vars, 400)
  return (
    <div className="model-view">
      <p className="muted">
        Assignment over {vars} variables {vars > shown ? `(showing first ${shown})` : ''}:
      </p>
      <div className="model-grid">
        {Array.from({ length: shown }, (_, i) => {
          const v = i + 1
          return (
            <span key={v} className={`lit ${model[v] ? 'true' : 'false'}`}>
              {model[v] ? '' : '¬'}x{v}
            </span>
          )
        })}
      </div>
    </div>
  )
}
