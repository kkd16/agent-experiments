import { useMemo, useState } from 'react'
import {
  type PresburgerExample,
  PresburgerBudgetError,
  eliminate,
  evalFormula,
  formatFormula,
  freeVars,
  parsePresburger,
} from '../lia'

interface Props {
  examples: PresburgerExample[]
}

export function PresburgerPanel({ examples }: Props) {
  const [src, setSrc] = useState<string>(examples[0].src)
  const [picked, setPicked] = useState<number | null>(0)
  const [env, setEnv] = useState<Record<number, string>>({})

  const parsed = useMemo(() => parsePresburger(src), [src])

  const result = useMemo(() => {
    if (!parsed.ok) return null
    try {
      const free = [...freeVars(parsed.formula)].sort((a, b) => a - b)
      const elim = eliminate(parsed.formula)
      return { free, elim, error: null as string | null }
    } catch (e) {
      if (e instanceof PresburgerBudgetError) return { free: [], elim: null, error: e.message }
      return { free: [], elim: null, error: e instanceof Error ? e.message : 'elimination error' }
    }
  }, [parsed])

  const name = (v: number) => (parsed.ok ? parsed.names[v] ?? `x${v}` : `x${v}`)

  const closed = result && result.free.length === 0 && result.elim
  const decision: boolean | null =
    closed && result.elim ? (result.elim.formula.kind === 'true' ? true : result.elim.formula.kind === 'false' ? false : null) : null

  // Evaluate the eliminated (quantifier-free) formula at the user's free values.
  const freeEval = useMemo(() => {
    if (!result?.elim || result.free.length === 0) return null
    const m = new Map<number, bigint>()
    for (const v of result.free) {
      const raw = env[v]
      if (raw === undefined || raw.trim() === '') return null
      try {
        m.set(v, BigInt(raw.trim()))
      } catch {
        return null
      }
    }
    return evalFormula(result.elim.formula, m, 0n, 0n)
  }, [result, env])

  const pick = (i: number) => {
    setPicked(i)
    setSrc(examples[i].src)
    setEnv({})
  }

  return (
    <div className="pres">
      <div className="lia-examples pres-examples">
        <h3>Sentences & formulas</h3>
        <div className="lia-ex-grid pres-ex-grid">
          {examples.map((ex, i) => (
            <button key={i} className={picked === i ? 'active' : ''} onClick={() => pick(i)} title={ex.blurb}>
              {ex.title}
            </button>
          ))}
        </div>
      </div>

      {picked !== null && <p className="pres-blurb">{examples[picked].blurb}</p>}

      <div className="lia-editor">
        <label>
          Presburger formula — quantifiers <code>forall</code>/<code>exists</code> (or ∀/∃), connectives{' '}
          <code>&amp;</code> <code>||</code> <code>-&gt;</code> <code>&lt;-&gt;</code> <code>not</code>, divisibility{' '}
          <code>d | term</code>
        </label>
        <textarea
          value={src}
          onChange={(e) => {
            setSrc(e.target.value)
            setPicked(null)
            setEnv({})
          }}
          spellCheck={false}
          rows={4}
        />
        {!parsed.ok && <div className="banner error">⚠ {parsed.error}</div>}
        {result?.error && <div className="banner error">⚠ {result.error}</div>}
      </div>

      {parsed.ok && (
        <div className="lia-summary">
          <span className="lia-chip">
            {result?.free.length ?? 0} free variable{(result?.free.length ?? 0) === 1 ? '' : 's'}
          </span>
          {result?.elim && <span className="lia-chip">{result.elim.nodes} Cooper steps</span>}
          {result && result.free.length > 0 && <span className="lia-vars">free: {result.free.map(name).join(', ')}</span>}
        </div>
      )}

      {closed && decision !== null && (
        <section className="view">
          <div className="status-pill-row">
            <span className={`status-pill ${decision ? 'sat' : 'unsat'}`}>{decision ? 'TRUE' : 'FALSE'}</span>
            <span className="pres-decided">decided over all integers — every quantifier eliminated by Cooper's algorithm</span>
          </div>
        </section>
      )}

      {result?.elim && result.free.length > 0 && (
        <section className="view pres-qe">
          <h3>Quantifier-free equivalent (free {result.free.map(name).join(', ')})</h3>
          <pre className="pres-formula">{formatFormula(result.elim.formula, name)}</pre>
          <p className="pres-note">
            Cooper's algorithm eliminated every quantifier, leaving a quantifier-free condition over the free
            variables — linear (in)equalities and the modular constraints elimination manufactures. It holds for
            exactly the same integers as the original.
          </p>
          <div className="pres-tester">
            <span className="pres-tester-label">test:</span>
            {result.free.map((v) => (
              <label key={v} className="pres-input">
                {name(v)} =
                <input
                  value={env[v] ?? ''}
                  spellCheck={false}
                  onChange={(e) => setEnv((s) => ({ ...s, [v]: e.target.value }))}
                  placeholder="0"
                />
              </label>
            ))}
            {freeEval !== null && (
              <span className={`pres-eval ${freeEval ? 'yes' : 'no'}`}>{freeEval ? 'holds ✓' : 'fails ✗'}</span>
            )}
          </div>
        </section>
      )}
    </div>
  )
}
