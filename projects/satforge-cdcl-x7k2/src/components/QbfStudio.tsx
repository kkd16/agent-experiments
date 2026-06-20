import { useMemo, useState } from 'react'
import {
  solveQbf,
  evalQbf,
  parseQdimacs,
  toQdimacs,
  alternations,
  prefixString,
  QBF_EXAMPLES,
  randomQbf,
  QDimacsError,
  type QBF,
  type Quant,
  type QbfResult,
  type QbfTraceEvent,
} from '../qbf'

type Source =
  | { kind: 'example'; index: number }
  | { kind: 'random' }
  | { kind: 'custom' }

interface RandomParams {
  seed: number
  leading: Quant
  blocks: number
  perBlock: number
  clauses: number
  k: number
}

const DEFAULT_RANDOM: RandomParams = { seed: 7, leading: 'e', blocks: 3, perBlock: 2, clauses: 8, k: 3 }

interface Parsed {
  ok: true
  qbf: QBF
  warnings: string[]
}
interface ParseFail {
  ok: false
  error: string
}

function parse(src: string): Parsed | ParseFail {
  try {
    const { qbf, warnings } = parseQdimacs(src)
    if (qbf.prefix.length === 0) return { ok: false, error: 'Formula has no variables — add a quantifier prefix and a matrix.' }
    return { ok: true, qbf, warnings }
  } catch (e) {
    if (e instanceof QDimacsError) return { ok: false, error: e.message }
    return { ok: false, error: e instanceof Error ? e.message : 'parse error' }
  }
}

export function QbfStudio() {
  const [source, setSource] = useState<Source>({ kind: 'example', index: 0 })
  const [src, setSrc] = useState<string>(() => toQdimacs(QBF_EXAMPLES[0].qbf))
  const [rand, setRand] = useState<RandomParams>(DEFAULT_RANDOM)
  const [run, setRun] = useState<{ res: QbfResult; oracle: boolean | null; qbf: QBF } | null>(null)

  const parsed = useMemo(() => parse(src), [src])
  const blurb =
    source.kind === 'example'
      ? QBF_EXAMPLES[source.index].blurb
      : source.kind === 'random'
        ? 'A randomly generated prenex QBF with strictly alternating blocks and a random k-CNF matrix. Small enough that the brute-force oracle can confirm the verdict.'
        : 'Your own formula in QDIMACS — a quantifier prefix (e/a lines) over a CNF matrix.'

  const pickExample = (index: number) => {
    setSource({ kind: 'example', index })
    setSrc(toQdimacs(QBF_EXAMPLES[index].qbf))
    setRun(null)
  }

  const genRandom = (p: RandomParams) => {
    setRand(p)
    setSource({ kind: 'random' })
    setSrc(toQdimacs(randomQbf(p)))
    setRun(null)
  }

  const onEdit = (text: string) => {
    setSrc(text)
    setSource({ kind: 'custom' })
    setRun(null)
  }

  const solve = () => {
    if (!parsed.ok) return
    const res = solveQbf(parsed.qbf, { trace: true })
    const oracle = evalQbf(parsed.qbf, 22)
    setRun({ res, oracle, qbf: parsed.qbf })
  }

  const verdictLabel =
    run == null ? '' : run.res.value === 'unknown' ? 'UNKNOWN' : run.res.value ? 'TRUE' : 'FALSE'
  const verdictClass =
    run == null ? '' : run.res.value === 'unknown' ? 'unknown' : run.res.value ? 'sat' : 'unsat'

  return (
    <div className="layout">
      <aside className="control qbf-side">
        <p className="imc-blurb">
          <strong>Quantified Boolean Formulas</strong> generalize SAT with <em>∀</em> as well as <em>∃</em>:
          deciding them is the canonical <strong>PSPACE-complete</strong> problem. SatForge solves them by{' '}
          <strong>counterexample-guided expansion</strong> (the idea behind RAReQS) — a quantifier game played
          one block at a time, every move proposed and refuted by the same CDCL engine — and cross-checks each
          verdict against an exhaustive brute-force oracle.
        </p>

        <div className="smt-examples">
          <h3>Examples</h3>
          <ul>
            {QBF_EXAMPLES.map((ex, i) => (
              <li key={ex.name}>
                <button
                  className={source.kind === 'example' && source.index === i ? 'active' : ''}
                  onClick={() => pickExample(i)}
                >
                  {ex.name}
                </button>
              </li>
            ))}
          </ul>
        </div>

        <div className="qbf-random">
          <h3>Random generator</h3>
          <div className="qbf-rand-grid">
            <label>
              leading
              <select
                value={rand.leading}
                onChange={(e) => genRandom({ ...rand, leading: e.target.value as Quant })}
              >
                <option value="e">∃ first</option>
                <option value="a">∀ first</option>
              </select>
            </label>
            <label>
              blocks
              <input
                type="number"
                min={1}
                max={6}
                value={rand.blocks}
                onChange={(e) => genRandom({ ...rand, blocks: clamp(+e.target.value, 1, 6) })}
              />
            </label>
            <label>
              vars/block
              <input
                type="number"
                min={1}
                max={4}
                value={rand.perBlock}
                onChange={(e) => genRandom({ ...rand, perBlock: clamp(+e.target.value, 1, 4) })}
              />
            </label>
            <label>
              clauses
              <input
                type="number"
                min={1}
                max={40}
                value={rand.clauses}
                onChange={(e) => genRandom({ ...rand, clauses: clamp(+e.target.value, 1, 40) })}
              />
            </label>
            <label>
              lits/clause
              <input
                type="number"
                min={2}
                max={4}
                value={rand.k}
                onChange={(e) => genRandom({ ...rand, k: clamp(+e.target.value, 2, 4) })}
              />
            </label>
            <button className="qbf-reroll" onClick={() => genRandom({ ...rand, seed: (rand.seed * 1103515245 + 12345) & 0x7fffffff })}>
              ↻ reroll seed
            </button>
          </div>
        </div>
      </aside>

      <main className="content">
        <div className="problem-head">
          <div>
            <h2>QBF Studio</h2>
            <p className="subtitle">{blurb}</p>
          </div>
          {run && <span className={`status-pill ${verdictClass}`}>{verdictLabel}</span>}
        </div>

        <div className="qbf-editor">
          <div className="qbf-editor-head">
            <label>QDIMACS — prefix (<code>e</code>/<code>a</code> … <code>0</code>) then CNF matrix</label>
            <button className="qbf-solve" onClick={solve} disabled={!parsed.ok}>
              ▶ Solve
            </button>
          </div>
          <textarea value={src} onChange={(e) => onEdit(e.target.value)} spellCheck={false} rows={9} />
          {!parsed.ok && <div className="banner error">⚠ {parsed.error}</div>}
          {parsed.ok &&
            parsed.warnings.map((w, i) => (
              <div key={i} className="banner warn">
                {w}
              </div>
            ))}
          {parsed.ok && (
            <div className="qbf-prefix-line">
              <span className="qbf-prefix">{prefixString(parsed.qbf)}</span>
              <span className="qbf-meta">
                {parsed.qbf.numVars} vars · {parsed.qbf.matrix.length} clauses ·{' '}
                {alternations(parsed.qbf)} alternation{alternations(parsed.qbf) === 1 ? '' : 's'}
              </span>
            </div>
          )}
        </div>

        {run && <Results run={run} />}
        {!run && (
          <div className="placeholder">
            <p>Pick an example or write a formula, then press Solve.</p>
          </div>
        )}
      </main>
    </div>
  )
}

function clamp(n: number, lo: number, hi: number): number {
  if (Number.isNaN(n)) return lo
  return Math.max(lo, Math.min(hi, n))
}

function Results({ run }: { run: { res: QbfResult; oracle: boolean | null; qbf: QBF } }) {
  const { res, oracle, qbf } = run
  const agrees = oracle === null || res.value === 'unknown' ? null : res.value === oracle

  return (
    <>
      <div className="imc-cards">
        <div className="imc-card">
          <h3>Verdict</h3>
          <p>
            The formula is{' '}
            <strong>
              {res.value === 'unknown' ? 'UNKNOWN (budget exhausted)' : res.value ? 'TRUE' : 'FALSE'}
            </strong>
            .{' '}
            {res.value !== 'unknown' && (
              <>
                The {res.topQuant === 'e' ? 'existential' : 'universal'} player who moves first{' '}
                {(res.topQuant === 'e') === res.value ? 'has a winning move' : 'loses the game'}.
              </>
            )}
          </p>
        </div>
        <div className="imc-card oracle">
          <h3>Brute-force oracle</h3>
          <p>
            {oracle === null ? (
              <>Too many variables to enumerate exhaustively — oracle skipped.</>
            ) : (
              <>
                Exhaustive Shannon expansion reports <strong>{oracle ? 'TRUE' : 'FALSE'}</strong>.{' '}
                <span className={agrees ? 'check-ok' : 'check-bad'}>
                  {agrees ? '✓ agrees' : '✗ MISMATCH'}
                </span>
              </>
            )}
          </p>
        </div>
        <div className="imc-card">
          <h3>Search effort</h3>
          <div className="qbf-stats">
            <div>
              <span>{res.stats.satCalls}</span>SAT calls
            </div>
            <div>
              <span>{res.stats.candidates}</span>candidates
            </div>
            <div>
              <span>{res.stats.refinements}</span>refinements
            </div>
            <div>
              <span>{res.stats.maxDepth}</span>max depth
            </div>
            <div>
              <span>{res.stats.timeMs.toFixed(1)}</span>ms
            </div>
          </div>
        </div>
      </div>

      {res.witness && (
        <div className="imc-panel">
          <h3>
            Winning move for the outer {res.topQuant === 'e' ? '∃' : '∀'} block{' '}
            <WitnessCheck run={run} />
          </h3>
          <div className="qbf-chips">
            {res.topVars.map((v) => {
              const val = res.witness![v]
              if (val === undefined) return <span key={v} className="qbf-chip qbf-chip-dc">x{v} = *</span>
              return (
                <span key={v} className={`qbf-chip ${val ? 'qbf-chip-t' : 'qbf-chip-f'}`}>
                  x{v} = {val ? '1' : '0'}
                </span>
              )
            })}
          </div>
          <p className="imc-note">
            {res.topQuant === 'e' ? (
              <>
                Fixing the outer existential variables to these values makes the residual{' '}
                <code>∀…∃…</code> formula <strong>true</strong> no matter how the adversary plays — a concrete
                certificate of satisfiability.
              </>
            ) : (
              <>
                These values for the outer universal variables drive the residual formula{' '}
                <strong>false</strong> against any response — a concrete refutation.
              </>
            )}
          </p>
        </div>
      )}

      <div className="imc-panel">
        <h3>System</h3>
        <dl className="imc-def">
          <dt>Prefix</dt>
          <dd className="qbf-prefix">{prefixString(qbf)}</dd>
          <dt>Matrix</dt>
          <dd className="qbf-matrix">{matrixToString(qbf)}</dd>
        </dl>
      </div>

      {res.trace.length > 0 && (
        <div className="imc-panel">
          <h3>Refinement trace (outermost block)</h3>
          <p className="imc-note">
            Each candidate is a move proposed by the SAT solver; a <em>refute/win</em> ends the search, a{' '}
            <em>block</em> records the opponent's counter-move and rules the candidate out.
          </p>
          <ol className="imc-log qbf-log">
            {res.trace.map((ev, i) => (
              <li key={i}>
                <TraceLine ev={ev} />
              </li>
            ))}
          </ol>
        </div>
      )}
    </>
  )
}

function WitnessCheck({ run }: { run: { res: QbfResult; qbf: QBF } }) {
  const ok = useMemo(() => verifyWitness(run.qbf, run.res), [run])
  if (ok === null) return null
  return <span className={ok ? 'check-ok' : 'check-bad'}>{ok ? '✓ verified' : '✗ invalid'}</span>
}

/** Substitute the witness into the matrix and confirm the residual QBF's value with the oracle. */
function verifyWitness(qbf: QBF, res: QbfResult): boolean | null {
  if (!res.witness || res.value === 'unknown') return null
  const assign = new Map<number, boolean>()
  for (const k of Object.keys(res.witness)) assign.set(Number(k), res.witness[Number(k)])
  const matrix: number[][] = []
  for (const c of qbf.matrix) {
    let sat = false
    const lits: number[] = []
    for (const l of c) {
      const v = Math.abs(l)
      const a = assign.get(v)
      if (a === undefined) lits.push(l)
      else if (l > 0 === a) {
        sat = true
        break
      }
    }
    if (!sat) matrix.push(lits)
  }
  const residual: QBF = { numVars: qbf.numVars, prefix: qbf.prefix.slice(1), matrix }
  const val = evalQbf(residual, 24)
  if (val === null) return null
  const expectInner = res.topQuant === 'e' // ∃ wins ⇒ residual true; ∀ wins ⇒ residual false
  return val === expectInner
}

function TraceLine({ ev }: { ev: QbfTraceEvent }) {
  const move = (m: Record<number, boolean>) =>
    Object.keys(m).length === 0
      ? '∅'
      : Object.keys(m)
          .map(Number)
          .sort((a, b) => a - b)
          .map((v) => `x${v}=${m[v] ? 1 : 0}`)
          .join(' ')
  switch (ev.t) {
    case 'candidate':
      return (
        <>
          <span className="imc-kind qbf-k-candidate">candidate</span>
          <span className="imc-k">#{ev.iter}</span> {move(ev.move)}
        </>
      )
    case 'win':
      return (
        <>
          <span className="imc-kind qbf-k-win">win</span>
          <span className="imc-k">#{ev.iter}</span> {move(ev.move)} satisfies the rest
        </>
      )
    case 'refute':
      return (
        <>
          <span className="imc-kind qbf-k-refute">refute</span>
          <span className="imc-k">#{ev.iter}</span> {move(ev.move)} falsifies the rest
        </>
      )
    case 'block':
      return (
        <>
          <span className="imc-kind qbf-k-block">block</span>
          <span className="imc-k">#{ev.iter}</span> counter {move(ev.counter)} → {ev.blocked} blocking clause
          {ev.blocked === 1 ? '' : 's'}
        </>
      )
    case 'exhausted':
      return (
        <>
          <span className="imc-kind qbf-k-exhausted">exhausted</span>
          <span className="imc-k">#{ev.iter}</span> no candidate survives ⇒ {ev.value ? 'TRUE' : 'FALSE'}
        </>
      )
  }
}

function matrixToString(qbf: QBF): string {
  if (qbf.matrix.length === 0) return '⊤ (empty)'
  return qbf.matrix
    .map((c) => '(' + c.map((l) => (l < 0 ? `¬x${-l}` : `x${l}`)).join(' ∨ ') + ')')
    .join(' ∧ ')
}
