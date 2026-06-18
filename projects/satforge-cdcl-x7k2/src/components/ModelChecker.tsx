import { useMemo, useState } from 'react'
import {
  imc,
  bfsReachability,
  checkInvariant,
  checkCounterexample,
  interpolate,
  checkInterpolant,
  simplify,
  formulaToString,
  TS_EXAMPLES,
  type TransitionSystem,
  type ImcResult,
  type BfsResult,
} from '../imc'

type Sub = 'mc' | 'interp'

export function ModelChecker() {
  const [sub, setSub] = useState<Sub>('mc')
  return (
    <div className="layout">
      <aside className="control imc-side">
        <div className="mode-switch imc-subswitch">
          <button className={sub === 'mc' ? 'active' : ''} onClick={() => setSub('mc')}>
            Model Checker
          </button>
          <button className={sub === 'interp' ? 'active' : ''} onClick={() => setSub('interp')}>
            Interpolation
          </button>
        </div>
        <p className="imc-blurb">
          {sub === 'mc' ? (
            <>
              <strong>Interpolation-based model checking</strong> (McMillan 2003) proves a
              finite-state system can <em>never</em> reach a bad state — unbounded safety — by
              turning Craig interpolants of bounded unrollings into an inductive invariant. Every
              verdict here is double-checked against an independent explicit-state BFS oracle.
            </>
          ) : (
            <>
              A <strong>Craig interpolant</strong> of an unsatisfiable A ∧ B is a formula I with
              A ⟹ I, I ∧ B unsat, and vocabulary shared by A and B. SatForge reads I straight off
              the resolution refutation via McMillan's rules, then verifies all three properties
              exhaustively.
            </>
          )}
        </p>
      </aside>
      <main className="content">{sub === 'mc' ? <McView /> : <InterpView />}</main>
    </div>
  )
}

// ---- Model-checking view ---------------------------------------------------

function bitName(ts: TransitionSystem, v: number): string {
  return ts.bitNames?.[v - 1] ?? `b${v - 1}`
}

function McView() {
  const [idx, setIdx] = useState(0)
  const ts = TS_EXAMPLES[idx]

  const run = useMemo(() => {
    const res: ImcResult = imc(ts, { maxBound: 40, maxRounds: 200 })
    const ref: BfsResult = bfsReachability(ts)
    const invOk = res.result === 'SAFE' && res.invariant ? checkInvariant(ts, res.invariant) : null
    const cexOk =
      res.result === 'UNSAFE' && res.counterexample ? checkCounterexample(ts, res.counterexample) : null
    const agrees = res.result !== 'UNKNOWN' && (res.result === 'SAFE') === ref.safe
    return { res, ref, invOk, cexOk, agrees }
  }, [ts])

  const { res, ref, invOk, cexOk, agrees } = run

  return (
    <>
      <div className="problem-head">
        <div>
          <h2>{ts.name}</h2>
          <p className="subtitle">{ts.description}</p>
        </div>
        <span className={`status-pill ${res.result === 'SAFE' ? 'sat' : res.result === 'UNSAFE' ? 'unsat' : ''}`}>
          {res.result === 'SAFE' ? '✓ SAFE' : res.result === 'UNSAFE' ? '✗ UNSAFE' : '? UNKNOWN'}
        </span>
      </div>

      <div className="imc-pick">
        <label>Example system</label>
        <select value={idx} onChange={(e) => setIdx(Number(e.target.value))}>
          {TS_EXAMPLES.map((t, i) => (
            <option key={i} value={i}>
              {t.name}
            </option>
          ))}
        </select>
        <span className="imc-meta">
          {ts.stateBits} state bits · {1 << ts.stateBits} states
        </span>
      </div>

      <div className="imc-cards">
        <div className="imc-card">
          <h3>Result</h3>
          <p>
            {res.result === 'SAFE' && (
              <>
                The bad state is <strong>unreachable</strong>. Proven by an inductive invariant
                discovered at BMC bound {res.bound} after {res.rounds} interpolation round(s).
              </>
            )}
            {res.result === 'UNSAFE' && (
              <>
                The bad state <strong>is reachable</strong> — a concrete counterexample of length{' '}
                {res.counterexample!.length - 1} was found at bound {res.bound}.
              </>
            )}
            {res.result === 'UNKNOWN' && <>The bound/round budget was exhausted.</>}
          </p>
        </div>
        <div className="imc-card oracle">
          <h3>Independent oracle</h3>
          <p>
            Explicit-state BFS over all {1 << ts.stateBits} states reports{' '}
            <strong>{ref.safe ? 'SAFE' : `UNSAFE (bad reachable in ${ref.distance} step${ref.distance === 1 ? '' : 's'})`}</strong>.{' '}
            <span className={agrees ? 'check-ok' : 'check-bad'}>{agrees ? '✓ verdicts agree' : '✗ MISMATCH'}</span>
          </p>
        </div>
      </div>

      {res.result === 'SAFE' && res.invariant && (
        <div className="imc-panel">
          <h3>Inductive invariant</h3>
          <pre className="imc-formula">{formulaToString(simplify(res.invariant), (v) => bitName(ts, v))}</pre>
          <ul className="imc-checks">
            <li className={invOk ? 'check-ok' : 'check-bad'}>{invOk ? '✓' : '✗'} Init ⟹ Inv</li>
            <li className={invOk ? 'check-ok' : 'check-bad'}>{invOk ? '✓' : '✗'} Inv ∧ Trans ⟹ Inv′</li>
            <li className={invOk ? 'check-ok' : 'check-bad'}>{invOk ? '✓' : '✗'} Inv ⟹ ¬Bad</li>
          </ul>
          <p className="imc-note">
            These three conditions, machine-checked above, are a self-contained proof that no
            execution — of any length — ever reaches the bad state.
          </p>
        </div>
      )}

      {res.result === 'UNSAFE' && res.counterexample && (
        <div className="imc-panel">
          <h3>
            Counterexample trace{' '}
            <span className={cexOk ? 'check-ok' : 'check-bad'}>{cexOk ? '✓ replays through Trans' : '✗ invalid'}</span>
          </h3>
          <table className="imc-trace">
            <thead>
              <tr>
                <th>step</th>
                {Array.from({ length: ts.stateBits }, (_, j) => (
                  <th key={j}>{bitName(ts, j + 1)}</th>
                ))}
                <th />
              </tr>
            </thead>
            <tbody>
              {res.counterexample.map((s, i) => {
                const last = i === res.counterexample!.length - 1
                return (
                  <tr key={i} className={last ? 'cex-bad' : ''}>
                    <td>{i}</td>
                    {Array.from({ length: ts.stateBits }, (_, j) => (
                      <td key={j}>{s[j + 1] ? '1' : '0'}</td>
                    ))}
                    <td>{i === 0 ? 'init' : last ? 'BAD' : ''}</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}

      <div className="imc-panel">
        <h3>Search trace</h3>
        <ol className="imc-log">
          {res.trace.map((t, i) => (
            <li key={i}>
              <span className={`imc-kind imc-${t.kind}`}>{t.kind}</span>
              <span className="imc-k">k={t.bound}</span> {t.message}
            </li>
          ))}
        </ol>
      </div>

      <div className="imc-panel">
        <h3>System definition</h3>
        <dl className="imc-def">
          <dt>Init</dt>
          <dd>{formulaToString(simplify(ts.init), (v) => bitName(ts, v))}</dd>
          <dt>Bad</dt>
          <dd>{formulaToString(simplify(ts.bad), (v) => bitName(ts, v))}</dd>
          <dt>Trans</dt>
          <dd>
            relation over current ({ts.bitNames?.join(', ') ?? 'bits'}) and next (primed) state — a{' '}
            {ts.stateBits}-bit transition system.
          </dd>
        </dl>
      </div>
    </>
  )
}

// ---- Interpolation view ----------------------------------------------------

interface InterpExample {
  name: string
  blurb: string
  numVars: number
  a: string
  b: string
}

const INTERP_EXAMPLES: InterpExample[] = [
  {
    name: 'Transitivity chain',
    blurb: 'A says x₁→x₂→x₃ and x₁; B says ¬x₃. The interpolant captures exactly the shared fact x₃.',
    numVars: 3,
    a: '1\n-1 2\n-2 3',
    b: '-3',
  },
  {
    name: 'Hidden middle variables',
    blurb: 'A fixes x₁ and forces x₂ via private variable a; B forbids x₂. Only x₂ is shared, and the interpolant is just x₂.',
    numVars: 4, // 1=x1, 2=x2, 3=x3(unused), 4=a (A-local)
    a: '1\n-1 4\n-4 2',
    b: '-2',
  },
  {
    name: 'Pigeon pair',
    blurb: 'A places two pigeons; B forbids the shared hole assignment — the interpolant is the shared core.',
    numVars: 4,
    a: '1 2\n-1 3\n-2 3',
    b: '-3 4\n-3 -4',
  },
]

function parseClauses(text: string): number[][] {
  return text
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
    .map((l) => l.split(/\s+/).map(Number).filter((n) => n !== 0))
}

function InterpView() {
  const [ex, setEx] = useState<InterpExample>(INTERP_EXAMPLES[0])
  const [aText, setAText] = useState(INTERP_EXAMPLES[0].a)
  const [bText, setBText] = useState(INTERP_EXAMPLES[0].b)

  const pick = (e: InterpExample) => {
    setEx(e)
    setAText(e.a)
    setBText(e.b)
  }

  const result = useMemo(() => {
    let A: number[][]
    let B: number[][]
    try {
      A = parseClauses(aText)
      B = parseClauses(bText)
    } catch {
      return { error: 'Could not parse clauses.' as const }
    }
    const nv = Math.max(1, ...[...A, ...B].flat().map((l) => Math.abs(l)))
    const r = interpolate(nv, A, B)
    if (r.status === 'sat') return { sat: true as const, A, B, nv }
    const chk = checkInterpolant(nv, A, B, r.interpolant, new Set(r.shared))
    return { sat: false as const, A, B, nv, itp: r, chk }
  }, [aText, bText])

  return (
    <>
      <div className="problem-head">
        <div>
          <h2>Craig interpolation</h2>
          <p className="subtitle">{ex.blurb}</p>
        </div>
      </div>

      <div className="imc-pick">
        <label>Example</label>
        <select
          value={ex.name}
          onChange={(e) => pick(INTERP_EXAMPLES.find((x) => x.name === e.target.value) ?? INTERP_EXAMPLES[0])}
        >
          {INTERP_EXAMPLES.map((e) => (
            <option key={e.name} value={e.name}>
              {e.name}
            </option>
          ))}
        </select>
        <span className="imc-meta">one clause per line · space-separated DIMACS literals</span>
      </div>

      <div className="imc-ab">
        <div>
          <label>A clauses</label>
          <textarea value={aText} onChange={(e) => setAText(e.target.value)} spellCheck={false} rows={6} />
        </div>
        <div>
          <label>B clauses</label>
          <textarea value={bText} onChange={(e) => setBText(e.target.value)} spellCheck={false} rows={6} />
        </div>
      </div>

      {'error' in result && <div className="banner error">⚠ {result.error}</div>}
      {'sat' in result && result.sat && (
        <div className="banner warn">A ∧ B is satisfiable — no interpolant exists. Make the conjunction unsatisfiable.</div>
      )}
      {'sat' in result && !result.sat && result.itp && (
        <div className="imc-panel">
          <h3>Interpolant</h3>
          <pre className="imc-formula">
            {formulaToString(simplify(result.itp.interpolant), (v) => `x${v}`)}
          </pre>
          <p className="imc-note">
            Shared vocabulary: {result.itp.shared.length ? result.itp.shared.map((v) => `x${v}`).join(', ') : '∅'} ·
            resolution proof: {result.itp.proofSize} node(s)
          </p>
          <ul className="imc-checks">
            <li className={result.chk!.aImpliesI ? 'check-ok' : 'check-bad'}>
              {result.chk!.aImpliesI ? '✓' : '✗'} A ⟹ I
            </li>
            <li className={result.chk!.iAndBUnsat ? 'check-ok' : 'check-bad'}>
              {result.chk!.iAndBUnsat ? '✓' : '✗'} I ∧ B unsatisfiable
            </li>
            <li className={result.chk!.vocabularyOk ? 'check-ok' : 'check-bad'}>
              {result.chk!.vocabularyOk ? '✓' : '✗'} vars(I) ⊆ vars(A) ∩ vars(B)
            </li>
          </ul>
          <p className="imc-note">All three properties are verified by exhaustive enumeration of the {1 << result.nv} assignments.</p>
        </div>
      )}
    </>
  )
}
