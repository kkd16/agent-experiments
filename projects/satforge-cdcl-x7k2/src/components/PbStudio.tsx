import { useMemo, useState } from 'react'
import {
  solvePb,
  solveViaCnf,
  bruteForce,
  optimize,
  toOpb,
  parseOpb,
  OpbError,
  encodePigeonhole,
  encodeKnapsack,
  encodeSetCover,
  encodeDominatingSet,
  randomPb,
  PETERSEN,
  labelOf,
  objectiveValue,
  runPbChecks,
  type PbInstance,
  type PbSolveResult,
  type PbCnfResult,
  type BruteResult,
  type OptimizeResult,
  type PbCheckReport,
} from '../pb'

interface ExampleDef {
  name: string
  blurb: string
  build: () => PbInstance
}

const EXAMPLES: ExampleDef[] = [
  {
    name: 'Pigeonhole 6 → 5 (UNSAT)',
    blurb:
      'The classic separation between proof systems: six pigeons cannot fit one-per-hole into five holes. Resolution (and therefore CDCL) needs exponentially many steps; cutting planes refute it in a handful. Watch the conflict counts.',
    build: () => encodePigeonhole(6, 5),
  },
  {
    name: 'Pigeonhole 8 → 7 (UNSAT)',
    blurb:
      'Same principle, bigger gap. The native cutting-plane solver still closes it in a linear number of conflicts while the resolution-based CDCL core spends thousands.',
    build: () => encodePigeonhole(8, 7),
  },
  {
    name: 'Knapsack (maximize value)',
    blurb:
      'A 0/1 knapsack: pick items to maximize value under a weight budget. Pseudo-Boolean optimization expresses both the budget and the objective natively — no clause blow-up.',
    build: () =>
      encodeKnapsack(
        [
          { weight: 2, value: 3 },
          { weight: 3, value: 4 },
          { weight: 4, value: 5 },
          { weight: 5, value: 8 },
          { weight: 9, value: 10 },
        ],
        10,
      ),
  },
  {
    name: 'Minimum set cover',
    blurb:
      'Choose the fewest subsets that cover every element of the universe. Each element becomes a clause "covered by ≥ 1 chosen set"; the objective minimizes the count.',
    build: () => encodeSetCover(6, [[0, 1, 2], [2, 3], [3, 4, 5], [0, 5], [1, 4], [0, 2, 4]]),
  },
  {
    name: 'Dominating set (Petersen)',
    blurb:
      'The minimum dominating set of the Petersen graph — pick vertices so every vertex is chosen or adjacent to a chosen one. The domination number is 3; solution-improving search proves optimality.',
    build: () => encodeDominatingSet(PETERSEN),
  },
]

interface Outcome {
  inst: PbInstance
  native: PbSolveResult
  oracle: PbCnfResult | null
  brute: BruteResult | null
  opt: OptimizeResult | null
}

function solveAll(inst: PbInstance): Outcome {
  const isOpt = (inst.objective?.length ?? 0) > 0
  const native = solvePb(inst, { trace: true, maxConflicts: 2_000_000, maxTimeMs: 8000 })
  const oracle = inst.constraints.length <= 4000 ? solveViaCnf(inst, 2_000_000) : null
  const brute = inst.numVars <= 18 ? bruteForce(inst) : null
  const opt = isOpt ? optimize(inst, { maxConflicts: 1_000_000, maxTimeMs: 8000 }) : null
  return { inst, native, oracle, brute, opt }
}

const DEFAULT_INST = EXAMPLES[0].build()

export function PbStudio() {
  const [exampleIdx, setExampleIdx] = useState(0)
  const [src, setSrc] = useState<string>(() => toOpb(DEFAULT_INST))
  const [dirty, setDirty] = useState(false)
  const [baseInst, setBaseInst] = useState<PbInstance>(() => DEFAULT_INST)
  const [randCfg, setRandCfg] = useState({ seed: 1, vars: 8, cons: 10 })
  // Solve the default instance once, synchronously, as the initial state (no mount effect).
  const [outcome, setOutcome] = useState<Outcome | null>(() => solveAll(DEFAULT_INST))
  const [checks, setChecks] = useState<PbCheckReport | null>(null)
  const [checking, setChecking] = useState(false)

  // The instance we actually solve: the rich example/random instance unless the user has
  // edited the OPB text, in which case we re-parse it (losing only the cosmetic labels).
  const parsed = useMemo<{ ok: true; inst: PbInstance } | { ok: false; error: string } | null>(() => {
    if (!dirty) return { ok: true, inst: baseInst }
    try {
      return { ok: true, inst: parseOpb(src).instance }
    } catch (e) {
      if (e instanceof OpbError) return { ok: false, error: e.message }
      return { ok: false, error: e instanceof Error ? e.message : 'parse error' }
    }
  }, [dirty, src, baseInst])

  const pickExample = (i: number) => {
    const inst = EXAMPLES[i].build()
    setExampleIdx(i)
    setBaseInst(inst)
    setSrc(toOpb(inst))
    setDirty(false)
    setOutcome(null)
  }

  const genRandom = (cfg: typeof randCfg) => {
    setRandCfg(cfg)
    const inst = randomPb(cfg.seed, cfg.vars, cfg.cons)
    setExampleIdx(-1)
    setBaseInst(inst)
    setSrc(toOpb(inst))
    setDirty(false)
    setOutcome(null)
  }

  const onEdit = (text: string) => {
    setSrc(text)
    setDirty(true)
    setOutcome(null)
  }

  const solve = () => {
    if (!parsed || !parsed.ok) return
    setOutcome(solveAll(parsed.inst))
  }

  const runVerify = () => {
    setChecking(true)
    // Let the spinner paint before the synchronous suite runs.
    setTimeout(() => {
      setChecks(runPbChecks())
      setChecking(false)
    }, 30)
  }

  const blurb = exampleIdx >= 0 ? EXAMPLES[exampleIdx].blurb : 'A randomly generated pseudo-Boolean instance.'
  const canSolve = parsed?.ok ?? false

  return (
    <div className="layout">
      <aside className="control qbf-side">
        <p className="imc-blurb">
          <strong>Pseudo-Boolean</strong> constraints are 0/1 integer-linear inequalities
          (<code>Σ aᵢ·ℓᵢ ≥ d</code>) — a strict generalization of CNF. This engine solves them with a native{' '}
          <strong>cutting-plane</strong> conflict solver whose learned constraints live in a proof system
          provably stronger than the resolution behind CDCL, plus 0/1 <strong>optimization</strong>. Every
          verdict is cross-checked against an independent CNF encoding and a brute-force oracle.
        </p>

        <div className="smt-examples">
          <h3>Examples</h3>
          <ul>
            {EXAMPLES.map((ex, i) => (
              <li key={ex.name}>
                <button className={exampleIdx === i ? 'active' : ''} onClick={() => pickExample(i)}>
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
              variables
              <input
                type="number"
                min={2}
                max={16}
                value={randCfg.vars}
                onChange={(e) => genRandom({ ...randCfg, vars: clamp(+e.target.value, 2, 16) })}
              />
            </label>
            <label>
              constraints
              <input
                type="number"
                min={1}
                max={30}
                value={randCfg.cons}
                onChange={(e) => genRandom({ ...randCfg, cons: clamp(+e.target.value, 1, 30) })}
              />
            </label>
          </div>
          <button className="qbf-reroll" onClick={() => genRandom({ ...randCfg, seed: (randCfg.seed * 1103515245 + 12345) & 0x7fffffff })}>
            ⟳ Reroll (seed {randCfg.seed})
          </button>
        </div>

        <div className="pb-editor">
          <div className="qbf-editor-head">
            <label>OPB source {dirty && <span className="pb-dirty">edited</span>}</label>
            <code>±a xᵢ … ⋈ b ;</code>
          </div>
          <textarea spellCheck={false} value={src} onChange={(e) => onEdit(e.target.value)} rows={8} />
          {parsed && !parsed.ok && <div className="banner error">⚠ {parsed.error}</div>}
        </div>

        <button className="qbf-solve" onClick={solve} disabled={!canSolve}>
          Solve ▶
        </button>
      </aside>

      <main className="content">
        <div className="problem-head">
          <div>
            <h2>Pseudo-Boolean Studio</h2>
            <p className="subtitle">{blurb}</p>
          </div>
        </div>

        {outcome ? <OutcomeView outcome={outcome} /> : <div className="placeholder"><p>Press Solve.</p></div>}

        <div className="pb-verify">
          <button className="count-btn" onClick={runVerify} disabled={checking}>
            {checking ? 'Running…' : 'Run verification suite'}
          </button>
          {checks && (
            <span className={checks.fail === 0 ? 'check-ok' : 'check-bad'}>
              {checks.fail === 0 ? `✓ all ${checks.pass} assertions pass` : `✗ ${checks.fail} of ${checks.pass + checks.fail} failed`}
            </span>
          )}
          <p className="count-note">
            Thousands of random instances cross-checked against brute force and the CNF oracle, plus
            algebraic soundness of every cutting-plane rule and optimization optima — run live in your browser.
          </p>
          {checks && checks.messages.length > 0 && (
            <ul className="pb-fail-list">
              {checks.messages.slice(0, 8).map((m, i) => (
                <li key={i}>{m}</li>
              ))}
            </ul>
          )}
        </div>
      </main>
    </div>
  )
}

function OutcomeView({ outcome }: { outcome: Outcome }) {
  const { inst, native, oracle, brute, opt } = outcome
  const isOpt = opt !== null

  // verdict + agreement
  const nativeSat = native.status === 'sat'
  const oracleAgrees = oracle && oracle.status !== 'unknown' ? (oracle.status === 'sat') === nativeSat : null
  const bruteAgrees = brute ? (brute.status === 'sat') === nativeSat : null

  const model = isOpt ? opt!.model : native.model

  return (
    <>
      <div className="imc-cards">
        <div className="imc-card">
          <h3>Verdict</h3>
          {isOpt ? (
            <p>
              {opt!.status === 'optimal' ? (
                <>
                  Optimal objective <strong>{opt!.optimum!.toString()}</strong> found and proven (the bounded
                  problem became UNSAT). {opt!.steps.length} improving solution{opt!.steps.length === 1 ? '' : 's'}
                  {' '}along the way.
                </>
              ) : opt!.status === 'unsat' ? (
                <>The constraints are <strong>infeasible</strong> — no assignment satisfies them.</>
              ) : (
                <><strong>{opt!.status.toUpperCase()}</strong> (budget exhausted).</>
              )}
            </p>
          ) : (
            <p>
              The instance is{' '}
              <strong className={native.status === 'sat' ? 'verdict-sat' : native.status === 'unsat' ? 'verdict-unsat' : 'verdict-unknown'}>
                {native.status.toUpperCase()}
              </strong>{' '}
              by the native cutting-plane solver.
            </p>
          )}
        </div>

        <div className="imc-card oracle">
          <h3>Cross-check</h3>
          <p>
            CNF oracle:{' '}
            {oracle === null ? (
              <em>skipped (too large)</em>
            ) : oracle.status === 'unknown' ? (
              <em>unknown</em>
            ) : (
              <span className={oracleAgrees ? 'check-ok' : 'check-bad'}>
                {oracle.status.toUpperCase()} {oracleAgrees ? '✓' : '✗ MISMATCH'}
              </span>
            )}
            <br />
            Brute force:{' '}
            {brute === null ? (
              <em>skipped (n &gt; 18)</em>
            ) : (
              <span className={bruteAgrees ? 'check-ok' : 'check-bad'}>
                {brute.status.toUpperCase()} {bruteAgrees ? '✓' : '✗ MISMATCH'}
                {brute.optimum !== undefined && opt?.optimum !== undefined && (
                  <> · optimum {brute.optimum === opt.optimum ? '✓' : '✗'}</>
                )}
              </span>
            )}
          </p>
        </div>

        <div className="imc-card">
          <h3>Effort</h3>
          <div className="qbf-stats">
            <div><span>{(isOpt ? opt!.stats.conflicts : native.stats.conflicts).toLocaleString()}</span>conflicts</div>
            <div><span>{(isOpt ? opt!.stats.decisions : native.stats.decisions).toLocaleString()}</span>decisions</div>
            <div><span>{(isOpt ? opt!.stats.propagations : native.stats.propagations).toLocaleString()}</span>propagations</div>
            <div><span>{isOpt ? opt!.iterations : native.stats.learned}</span>{isOpt ? 'opt steps' : 'learned'}</div>
            <div><span>{native.stats.maxCoef}</span>max coef</div>
            <div><span>{(isOpt ? opt!.stats.timeMs : native.stats.timeMs).toFixed(1)}</span>ms</div>
          </div>
        </div>
      </div>

      {!isOpt && oracle && oracle.status !== 'unknown' && (
        <div className="pb-compare">
          <h3>Cutting planes vs. resolution</h3>
          <div className="pb-bars">
            <Bar label="Native (cutting planes)" value={native.stats.conflicts} max={Math.max(native.stats.conflicts, oracle.conflicts, 1)} cls="pb-bar-native" />
            <Bar label="CNF / CDCL (resolution)" value={oracle.conflicts} max={Math.max(native.stats.conflicts, oracle.conflicts, 1)} cls="pb-bar-cnf" />
          </div>
          <p className="count-note">
            Both reach the same verdict. The native solver learns <em>pseudo-Boolean cuts</em>; the CNF path
            learns clauses by resolution. On pigeonhole-style instances the resolution path needs dramatically
            more conflicts — the cutting-plane proof system is exponentially stronger.
            {' '}({oracle.auxVars} totalizer aux vars, {oracle.clauses} clauses.)
          </p>
        </div>
      )}

      {opt && opt.steps.length > 0 && (
        <div className="pb-panel">
          <h3>Optimization trace</h3>
          <div className="pb-steps">
            {opt.steps.map((s, i) => (
              <span key={i} className="pb-step">
                {s.value.toString()}
                {i < opt.steps.length - 1 && ' →'}
              </span>
            ))}
            {opt.status === 'optimal' && <span className="pb-step pb-step-opt">optimum ✓</span>}
          </div>
        </div>
      )}

      {model && (
        <div className="pb-panel">
          <h3>{isOpt ? 'Optimal assignment' : 'Model'}</h3>
          <div className="qbf-chips">
            {Array.from({ length: inst.numVars }, (_, i) => i + 1).map((v) => (
              <span key={v} className={`qbf-chip ${model[v] ? 'qbf-chip-t' : 'qbf-chip-f'}`}>
                {labelOf(inst, v)} = {model[v] ? '1' : '0'}
              </span>
            ))}
          </div>
          {isOpt && inst.objective && (
            <p className="count-note">Objective = {objectiveValue(inst, model).toString()}.</p>
          )}
        </div>
      )}

      {native.derivation && native.derivation.length > 0 && (
        <div className="pb-panel">
          <h3>Cutting-plane derivation (first conflict)</h3>
          <p className="count-note">
            Conflict analysis by <strong>generalized resolution</strong>: each step reduces the reason
            constraint (weaken + Chvátal–Gomory divide so the pivot's coefficient is 1) and adds it to the
            running conflict so the pivot cancels — a sequence of sound cutting-plane inferences ending in the
            learned cut.
          </p>
          <div className="pb-deriv">
            {native.derivation.map((s, i) => (
              <div key={i} className="pb-deriv-step">
                <div className="pb-deriv-line"><span className="pb-deriv-tag">conflict</span><code>{s.conflict}</code></div>
                <div className="pb-deriv-line"><span className="pb-deriv-tag">reason (x{s.pivot})</span><code>{s.reason}</code></div>
                <div className="pb-deriv-line pb-deriv-out"><span className="pb-deriv-tag">⟹ cut</span><code>{s.resolvent}</code></div>
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="pb-panel">
        <h3>Constraint database ({inst.constraints.length})</h3>
        <div className="pb-cons">
          {inst.constraints.slice(0, 80).map((c, i) => (
            <code key={i} className="pb-con">{c.toString()}</code>
          ))}
          {inst.constraints.length > 80 && <code className="pb-con">… {inst.constraints.length - 80} more</code>}
        </div>
      </div>
    </>
  )
}

function Bar({ label, value, max, cls }: { label: string; value: number; max: number; cls: string }) {
  const pct = Math.max(2, Math.round((value / max) * 100))
  return (
    <div className="pb-bar-row">
      <div className="pb-bar-label">{label}</div>
      <div className="pb-bar-track">
        <div className={`pb-bar-fill ${cls}`} style={{ width: `${pct}%` }} />
      </div>
      <div className="pb-bar-val">{value.toLocaleString()}</div>
    </div>
  )
}

function clamp(x: number, lo: number, hi: number): number {
  if (Number.isNaN(x)) return lo
  return Math.max(lo, Math.min(hi, x))
}
