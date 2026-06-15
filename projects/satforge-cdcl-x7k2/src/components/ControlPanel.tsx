import type { ProblemKind, ProblemSpec } from '../problems'
import { isMaxSatKind } from '../problems'

export interface SolverUiOptions {
  minimize: boolean
  randomize: boolean
  restartBase: number
}

const KINDS: { kind: ProblemKind; label: string }[] = [
  { kind: 'nqueens', label: 'N-Queens' },
  { kind: 'sudoku', label: 'Sudoku' },
  { kind: 'coloring', label: 'Graph coloring' },
  { kind: 'hamiltonian', label: 'Hamiltonian' },
  { kind: 'factoring', label: 'Factoring' },
  { kind: 'zebra', label: 'Zebra puzzle' },
  { kind: 'pigeonhole', label: 'Pigeonhole' },
  { kind: 'langford', label: 'Langford pairs' },
  { kind: 'random', label: 'Random 3-SAT' },
  { kind: 'dimacs', label: 'Custom CNF' },
]

const MAX_KINDS: { kind: ProblemKind; label: string }[] = [
  { kind: 'maxcut', label: 'Max-Cut' },
  { kind: 'vertexcover', label: 'Vertex cover' },
  { kind: 'maxindset', label: 'Independent set' },
  { kind: 'max2sat', label: 'MAX-2-SAT' },
  { kind: 'wcnf', label: 'Custom WCNF' },
]

const FACTOR_PRESETS: { label: string; n: number }[] = [
  { label: '143 = 11×13', n: 143 },
  { label: '323 = 17×19', n: 323 },
  { label: '1517 = 37×41', n: 1517 },
  { label: '3599 = 59×61', n: 3599 },
  { label: '8633 = 89×97', n: 8633 },
  { label: '9973 (prime)', n: 9973 },
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
  const maxsat = isMaxSatKind(spec.kind)
  return (
    <aside className="panel">
      <section>
        <h2>Decide (SAT)</h2>
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
        <h2 className="section-gap">Optimize (MaxSAT)</h2>
        <div className="kind-grid">
          {MAX_KINDS.map(({ kind, label }) => (
            <button
              key={kind}
              className={`kind-btn opt ${spec.kind === kind ? 'active' : ''}`}
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

        {spec.kind === 'hamiltonian' && (
          <>
            <Slider label="Vertices" min={4} max={16} value={spec.n} onChange={(n) => onSpec({ n })} suffix={`${spec.n}`} />
            <Slider label="Edge density" min={20} max={90} value={Math.round(spec.edgeProb * 100)} onChange={(v) => onSpec({ edgeProb: v / 100 })} suffix={`${Math.round(spec.edgeProb * 100)}%`} />
            <Slider label="Seed" min={1} max={50} value={spec.seed} onChange={(seed) => onSpec({ seed })} suffix={`${spec.seed}`} />
            <p className="hint">Sparse graphs are often UNSAT (no closed tour); denser ones almost always have one.</p>
          </>
        )}

        {spec.kind === 'factoring' && (
          <>
            <label className="field">
              <span>Preset</span>
              <select
                value={spec.target}
                onChange={(e) => onSpec({ target: Number(e.target.value) })}
              >
                {FACTOR_PRESETS.map((p) => (
                  <option key={p.n} value={p.n}>
                    {p.label}
                  </option>
                ))}
              </select>
            </label>
            <label className="field">
              <span>Target N (2 … 1,000,000)</span>
              <input
                type="number"
                className="mono"
                min={2}
                max={1000000}
                value={spec.target}
                onChange={(e) => onSpec({ target: Number(e.target.value) })}
              />
            </label>
            <p className="hint">The solver searches the bits of a and b in a from-scratch multiplier circuit. UNSAT certifies N is prime.</p>
          </>
        )}

        {spec.kind === 'zebra' && (
          <p className="hint">
            The classic 1962 <em>Life International</em> riddle: five houses with unique colors, nationalities,
            drinks, cigarettes and pets, tied together by 15 clues. Solve it, then open the Statistics ▸ Count
            card — there is exactly one solution.
          </p>
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

        {(spec.kind === 'maxcut' || spec.kind === 'vertexcover' || spec.kind === 'maxindset') && (
          <>
            <Slider label="Vertices" min={3} max={16} value={spec.n} onChange={(n) => onSpec({ n })} suffix={`${spec.n}`} />
            <Slider label="Edge density" min={15} max={90} value={Math.round(spec.edgeProb * 100)} onChange={(v) => onSpec({ edgeProb: v / 100 })} suffix={`${Math.round(spec.edgeProb * 100)}%`} />
            {spec.kind === 'maxcut' && (
              <Slider label="Max edge weight" min={1} max={9} value={spec.maxWeight} onChange={(maxWeight) => onSpec({ maxWeight })} suffix={`${spec.maxWeight}`} />
            )}
            <Slider label="Seed" min={1} max={50} value={spec.seed} onChange={(seed) => onSpec({ seed })} suffix={`${spec.seed}`} />
            <p className="hint">
              {spec.kind === 'maxcut'
                ? 'Maximize the weight of edges crossing the partition — the canonical NP-hard cut problem.'
                : spec.kind === 'vertexcover'
                  ? 'Hard clauses force every edge to be covered; soft clauses pay 1 per chosen vertex.'
                  : 'Hard clauses forbid adjacent pairs; soft clauses reward each vertex put in the set.'}
            </p>
          </>
        )}

        {spec.kind === 'max2sat' && (
          <>
            <Slider label="Variables" min={2} max={18} value={spec.n} onChange={(n) => onSpec({ n })} suffix={`${spec.n}`} />
            <Slider label="Clauses per var" min={5} max={60} value={Math.round(spec.ratio * 10)} onChange={(v) => onSpec({ ratio: v / 10 })} suffix={`${spec.ratio.toFixed(1)}×`} />
            <Slider label="Max clause weight" min={1} max={9} value={spec.maxWeight} onChange={(maxWeight) => onSpec({ maxWeight })} suffix={`${spec.maxWeight}`} />
            <Slider label="Seed" min={1} max={50} value={spec.seed} onChange={(seed) => onSpec({ seed })} suffix={`${spec.seed}`} />
            <p className="hint">Random weighted 2-clauses with no hard constraints — minimize the violated weight.</p>
          </>
        )}

        {spec.kind === 'wcnf' && (
          <label className="field">
            <span>WCNF (weighted CNF)</span>
            <textarea className="mono" rows={10} value={spec.wcnf} onChange={(e) => onSpec({ wcnf: e.target.value })} />
          </label>
        )}
      </section>

      {maxsat ? (
        <section>
          <h2>MaxSAT strategy</h2>
          <div className="kind-grid strat-grid">
            <button className={`kind-btn ${spec.strategy === 'linear' ? 'active' : ''}`} onClick={() => onSpec({ strategy: 'linear' })}>
              Linear SAT-UNSAT
            </button>
            <button className={`kind-btn ${spec.strategy === 'core-guided' ? 'active' : ''}`} onClick={() => onSpec({ strategy: 'core-guided' })}>
              Core-guided (WPM1)
            </button>
          </div>
          <p className="hint">
            Both prove the same optimum. Linear improves a model's cost downward; core-guided raises a lower
            bound by relaxing each unsat core. Switch to watch the convergence chart change shape.
          </p>
        </section>
      ) : (
        <>
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
        </>
      )}
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
