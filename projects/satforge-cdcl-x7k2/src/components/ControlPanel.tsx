import type { ProblemKind, ProblemSpec } from '../problems'

export interface SolverUiOptions {
  minimize: boolean
  randomize: boolean
  restartBase: number
}

const KINDS: { kind: ProblemKind; label: string }[] = [
  { kind: 'nqueens', label: 'N-Queens' },
  { kind: 'sudoku', label: 'Sudoku' },
  { kind: 'coloring', label: 'Graph coloring' },
  { kind: 'pigeonhole', label: 'Pigeonhole' },
  { kind: 'langford', label: 'Langford pairs' },
  { kind: 'random', label: 'Random 3-SAT' },
  { kind: 'dimacs', label: 'Custom CNF' },
]

const SUDOKU_PRESETS: Record<string, string> = {
  'Gentle': '53..7....6..195....98....6.8...6...34..8.3..17...2...6.6....28....419..5....8..79',
  'Hard (17 clues)': '.......1.4.........2...........5.6.4..8...3....1.9....3..4..2...5.1........8.6...',
  'Empty (any solution)': '.'.repeat(81),
}

export function ControlPanel({
  spec,
  onSpec,
  opts,
  onOpts,
  onSolve,
  solving,
}: {
  spec: ProblemSpec
  onSpec: (patch: Partial<ProblemSpec>) => void
  opts: SolverUiOptions
  onOpts: (patch: Partial<SolverUiOptions>) => void
  onSolve: () => void
  solving: boolean
}) {
  return (
    <aside className="panel">
      <section>
        <h2>Problem</h2>
        <div className="kind-grid">
          {KINDS.map(({ kind, label }) => (
            <button
              key={kind}
              className={`kind-btn ${spec.kind === kind ? 'active' : ''}`}
              onClick={() => onSpec({ kind })}
            >
              {label}
            </button>
          ))}
        </div>
      </section>

      <section className="params">
        {spec.kind === 'nqueens' && (
          <Slider label="Board size N" min={4} max={32} value={spec.n} onChange={(n) => onSpec({ n })} suffix={`${spec.n}×${spec.n}`} />
        )}

        {spec.kind === 'sudoku' && (
          <>
            <label className="field">
              <span>Preset</span>
              <select
                onChange={(e) => onSpec({ sudoku: SUDOKU_PRESETS[e.target.value] ?? spec.sudoku })}
                defaultValue="Gentle"
              >
                {Object.keys(SUDOKU_PRESETS).map((k) => (
                  <option key={k}>{k}</option>
                ))}
              </select>
            </label>
            <label className="field">
              <span>Puzzle (81 cells · use . for blanks)</span>
              <textarea
                className="mono"
                rows={4}
                value={spec.sudoku}
                onChange={(e) => onSpec({ sudoku: e.target.value })}
              />
            </label>
          </>
        )}

        {spec.kind === 'coloring' && (
          <>
            <Slider label="Vertices" min={4} max={32} value={spec.n} onChange={(n) => onSpec({ n })} suffix={`${spec.n}`} />
            <Slider label="Colors k" min={2} max={6} value={spec.k} onChange={(k) => onSpec({ k })} suffix={`${spec.k}`} />
            <Slider label="Edge density" min={10} max={90} value={Math.round(spec.edgeProb * 100)} onChange={(v) => onSpec({ edgeProb: v / 100 })} suffix={`${Math.round(spec.edgeProb * 100)}%`} />
            <Slider label="Seed" min={1} max={50} value={spec.seed} onChange={(seed) => onSpec({ seed })} suffix={`${spec.seed}`} />
          </>
        )}

        {spec.kind === 'pigeonhole' && (
          <Slider label="Holes n (n+1 pigeons)" min={2} max={12} value={spec.n} onChange={(n) => onSpec({ n })} suffix={`PHP(${spec.n})`} />
        )}

        {spec.kind === 'langford' && (
          <>
            <Slider label="Numbers n" min={1} max={12} value={spec.n} onChange={(n) => onSpec({ n })} suffix={`L(${spec.n})`} />
            <p className="hint">Solvable iff n ≡ 0 or 3 (mod 4): L(3), L(4), L(7), L(8) are SAT; L(1), L(2), L(5), L(6) are UNSAT — open the Proof tab to certify the refutation.</p>
          </>
        )}

        {spec.kind === 'random' && (
          <>
            <Slider label="Variables" min={10} max={300} value={spec.n} onChange={(n) => onSpec({ n })} suffix={`${spec.n}`} />
            <Slider label="Ratio α (clauses/var)" min={20} max={80} value={Math.round(spec.ratio * 10)} onChange={(v) => onSpec({ ratio: v / 10 })} suffix={spec.ratio.toFixed(1)} />
            <Slider label="Seed" min={1} max={50} value={spec.seed} onChange={(seed) => onSpec({ seed })} suffix={`${spec.seed}`} />
            <p className="hint">α ≈ 4.26 is the SAT/UNSAT phase transition — the hardest random instances.</p>
          </>
        )}

        {spec.kind === 'dimacs' && (
          <label className="field">
            <span>DIMACS CNF</span>
            <textarea className="mono" rows={10} value={spec.dimacs} onChange={(e) => onSpec({ dimacs: e.target.value })} />
          </label>
        )}
      </section>

      <section>
        <h2>Solver</h2>
        <label className="check">
          <input type="checkbox" checked={opts.minimize} onChange={(e) => onOpts({ minimize: e.target.checked })} />
          <span>Clause minimization</span>
        </label>
        <label className="check">
          <input type="checkbox" checked={opts.randomize} onChange={(e) => onOpts({ randomize: e.target.checked })} />
          <span>Random decision noise</span>
        </label>
        <Slider label="Restart base (Luby unit)" min={20} max={400} value={opts.restartBase} onChange={(restartBase) => onOpts({ restartBase })} suffix={`${opts.restartBase}`} />
      </section>

      <button className="solve-btn" onClick={onSolve} disabled={solving}>
        {solving ? 'Solving…' : 'Solve ▶'}
      </button>
    </aside>
  )
}

function Slider({
  label,
  min,
  max,
  value,
  onChange,
  suffix,
}: {
  label: string
  min: number
  max: number
  value: number
  onChange: (v: number) => void
  suffix: string
}) {
  return (
    <label className="field slider-field">
      <span>
        {label} <em>{suffix}</em>
      </span>
      <input type="range" min={min} max={max} value={value} onChange={(e) => onChange(Number(e.target.value))} />
    </label>
  )
}
