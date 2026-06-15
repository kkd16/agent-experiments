import type { BuiltProblem } from '../problems'
import type { SolveResult, FactorSolution, HamiltonianSolution, ZebraSolution, Graph } from '../sat'
import { ZEBRA_CATEGORIES, ZEBRA_VALUES } from '../sat'

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
      {problem.render === 'langford' && problem.decodeLangford && (
        <LangfordView sol={problem.decodeLangford(model)} />
      )}
      {problem.render === 'hamiltonian' && problem.decodeHamiltonian && problem.graph && (
        <HamiltonianView sol={problem.decodeHamiltonian(model)} graph={problem.graph} />
      )}
      {problem.render === 'factoring' && problem.decodeFactoring && (
        <FactoringView sol={problem.decodeFactoring(model)} />
      )}
      {problem.render === 'zebra' && problem.decodeZebra && <ZebraView sol={problem.decodeZebra(model)} />}
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

function LangfordView({ sol }: { sol: { sequence: number[]; n: number } }) {
  const { sequence, n } = sol
  const hue = (v: number) => `hsl(${(v * 360) / Math.max(1, n)}, 62%, 55%)`
  return (
    <div className="langford">
      <p className="muted">
        A valid Langford pairing of 1..{n}: each value k has exactly k slots between its two copies.
      </p>
      <div className="langford-row">
        {sequence.map((v, i) => (
          <div
            key={i}
            className="langford-slot"
            style={v ? { background: hue(v), borderColor: hue(v) } : undefined}
            title={`slot ${i + 1}`}
          >
            {v || ''}
          </div>
        ))}
      </div>
    </div>
  )
}

function HamiltonianView({ sol, graph }: { sol: HamiltonianSolution; graph: Graph }) {
  const n = graph.numVertices
  const size = 360
  const cx = size / 2
  const cy = size / 2
  const radius = size / 2 - 28
  const pts = Array.from({ length: n }, (_, i) => {
    const a = (i / n) * Math.PI * 2 - Math.PI / 2
    return { x: cx + radius * Math.cos(a), y: cy + radius * Math.sin(a) }
  })
  // Tour edges (as an undirected set of "u-w" keys) for highlighting.
  const tourEdges = new Set<string>()
  for (let p = 0; p < n; p++) {
    const u = sol.tour[p]
    const w = sol.tour[(p + 1) % n]
    tourEdges.add(u < w ? `${u}-${w}` : `${w}-${u}`)
  }
  const onTour = (a: number, b: number) => tourEdges.has(a < b ? `${a}-${b}` : `${b}-${a}`)
  return (
    <div className="hamiltonian">
      <p className="muted">
        A Hamiltonian cycle (highlighted) — visiting every vertex exactly once and returning home:{' '}
        <span className="mono">{sol.tour.join(' → ')} → {sol.tour[0]}</span>
      </p>
      <svg className="coloring" viewBox={`0 0 ${size} ${size}`} width={size} height={size}>
        {graph.edges.map(([a, b], i) => (
          <line
            key={i}
            x1={pts[a].x}
            y1={pts[a].y}
            x2={pts[b].x}
            y2={pts[b].y}
            stroke={onTour(a, b) ? '#06d6a0' : 'rgba(148,163,184,0.25)'}
            strokeWidth={onTour(a, b) ? 3 : 1}
          />
        ))}
        {pts.map((p, i) => (
          <g key={i}>
            <circle cx={p.x} cy={p.y} r={13} fill="#118ab2" stroke="#0b1020" strokeWidth={2} />
            <text x={p.x} y={p.y + 4} textAnchor="middle" className="vlabel">
              {i}
            </text>
          </g>
        ))}
      </svg>
    </div>
  )
}

function FactoringView({ sol }: { sol: FactorSolution }) {
  const lo = Math.min(sol.a, sol.b)
  const hi = Math.max(sol.a, sol.b)
  return (
    <div className="factoring">
      <div className="factor-eq">
        <span className="factor-num">{lo}</span>
        <span className="factor-op">×</span>
        <span className="factor-num">{hi}</span>
        <span className="factor-op">=</span>
        <span className="factor-num result">{sol.n}</span>
      </div>
      <p className="muted">
        The solver recovered the bits of both factors from a from-scratch shift-and-add multiplier circuit —
        running multiplication backwards. Binary: <span className="mono">{toBin(lo)} × {toBin(hi)} = {toBin(sol.n)}</span>
      </p>
    </div>
  )
}

const HOUSE_TINT = ['#fca5a5', '#86efac', '#fde68a', '#fcd34d', '#93c5fd']

function ZebraView({ sol }: { sol: ZebraSolution }) {
  return (
    <div className="zebra">
      <div className="zebra-answers">
        <div className="zebra-answer">
          💧 <strong>{ZEBRA_VALUES[1][sol.waterDrinker] ?? '?'}</strong> drinks water
        </div>
        <div className="zebra-answer">
          🦓 <strong>{ZEBRA_VALUES[1][sol.zebraOwner] ?? '?'}</strong> owns the zebra
        </div>
      </div>
      <div className="zebra-table-wrap">
        <table className="zebra-table">
          <thead>
            <tr>
              <th>House</th>
              {ZEBRA_CATEGORIES.map((c) => (
                <th key={c}>{c}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {sol.houses.map((house, h) => (
              <tr key={h}>
                <td className="zebra-house" style={{ background: HOUSE_TINT[h] }}>
                  {h + 1}
                </td>
                {house.map((val, cat) => (
                  <td key={cat}>{ZEBRA_VALUES[cat][val] ?? '?'}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}

function toBin(n: number): string {
  return n.toString(2)
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
