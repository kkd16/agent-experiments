import { useMemo, useRef, useState } from 'react'
import type { CNF, Ddnnf, CompileStats, Weights } from '../sat'
import { ddnnfCount, ddnnfMarginals, ddnnfWmc, verifyCircuit, toNnf } from '../sat'
import { compileDdnnfTask } from '../tasks'

type State =
  | { phase: 'idle' }
  | { phase: 'running' }
  | { phase: 'done'; ddnnf: Ddnnf | null; stats: CompileStats }
  | { phase: 'error'; message: string }

/**
 * Knowledge compilation: turn the formula into a smooth d-DNNF circuit *once*, then
 * answer a family of #P-hard queries on it in linear time — exact model count, weighted
 * model count, and every variable's exact marginal probability in a single sweep.
 */
export function CompileView({ cnf }: { cnf: CNF }) {
  const [state, setState] = useState<State>({ phase: 'idle' })
  const reqId = useRef(0)

  const run = () => {
    const id = ++reqId.current
    setState({ phase: 'running' })
    compileDdnnfTask(cnf, 800000)
      .then((r) => {
        if (id === reqId.current) setState({ phase: 'done', ddnnf: r.ddnnf, stats: r.stats })
      })
      .catch((e) => {
        if (id === reqId.current)
          setState({ phase: 'error', message: e instanceof Error ? e.message : String(e) })
      })
  }

  return (
    <div className="count-view compile-view">
      <p className="proof-intro">
        <strong>Knowledge compilation</strong> pays for the search <em>once</em>, transforming the
        formula into a circuit in <strong>smooth deterministic Decomposable NNF</strong> (sd-DNNF). On
        that circuit a whole family of otherwise-#P-hard questions becomes a single linear-time pass:
        the exact <strong>model count</strong>, the <strong>weighted model count</strong> (the
        partition function behind probabilistic inference), and every variable's exact{' '}
        <strong>marginal probability</strong> — all read straight off the compiled DAG. The compiler
        is the trace of an exhaustive DPLL search: forced literals become an AND, free variables
        become OR(x,¬x), independent sub-problems become a decomposable AND, and a branch becomes a
        deterministic OR — with repeated sub-formulas <strong>cached into a shared DAG</strong>, the
        same idea behind <em>c2d</em> and <em>Dsharp</em>.
      </p>

      <button className="solve-btn count-btn" onClick={run} disabled={state.phase === 'running'}>
        {state.phase === 'running' ? 'Compiling…' : '⛭ Compile to d-DNNF'}
      </button>

      {state.phase === 'error' && <div className="banner error">Compiler error: {state.message}</div>}

      {state.phase === 'done' && state.ddnnf === null && (
        <div className="banner warn">
          The compilation budget was exhausted before the circuit finished ({fmt(state.stats.searchNodes)}{' '}
          search nodes). This formula has too many independent decisions to compile in the browser —
          try a smaller instance.
        </div>
      )}

      {state.phase === 'done' && state.ddnnf && <Compiled ddnnf={state.ddnnf} stats={state.stats} />}
    </div>
  )
}

function Compiled({ ddnnf, stats }: { ddnnf: Ddnnf; stats: CompileStats }) {
  // The "tilt" knob: every variable's positive literal is worth p, its negative 1−p.
  // p = 0.5 ⇒ uniform, so WMC = count / 2ⁿ and the marginals are pure solution fractions.
  const [p, setP] = useState(0.5)

  const props = useMemo(() => verifyCircuit(ddnnf), [ddnnf])
  const count = useMemo(() => ddnnfCount(ddnnf), [ddnnf])
  const weights = useMemo<Weights>(() => {
    const pos = new Array(ddnnf.numVars + 1).fill(p)
    const neg = new Array(ddnnf.numVars + 1).fill(1 - p)
    return { pos, neg }
  }, [ddnnf, p])
  const wmc = useMemo(() => ddnnfWmc(ddnnf, weights), [ddnnf, weights])
  const marg = useMemo(() => ddnnfMarginals(ddnnf, weights), [ddnnf, weights])

  const digits = count.toString()
  const cacheTotal = stats.cacheHits + stats.cacheSize
  const reuse = cacheTotal > 0 ? Math.round((stats.cacheHits / cacheTotal) * 100) : 0

  return (
    <div className="count-result">
      <div className="count-big">
        <span className="count-label">Models (exact, from the circuit)</span>
        <span className="count-number" title={digits}>
          {groupDigits(digits)}
        </span>
        {digits.length > 12 && <span className="count-sci">≈ {scientific(count)}</span>}
        {count === 0n && <span className="count-note">— the formula is unsatisfiable.</span>}
        {count === 1n && <span className="count-note">— the solution is unique.</span>}
      </div>

      <div className="circuit-badges">
        <Badge ok={props.smooth} label="smooth" />
        <Badge ok={props.decomposable} label="decomposable" />
        <Badge ok={props.deterministic} label="deterministic" />
        <span className="circuit-badge-note">
          structurally verified — these properties are what make the queries below exact &amp; linear
        </span>
      </div>

      <div className="stat-grid proof-grid">
        <Stat value={fmt(stats.nodes)} label="Circuit nodes" hint="shared DAG" />
        <Stat value={fmt(stats.edges)} label="Edges" hint="wires" />
        <Stat value={fmt(stats.decisionNodes)} label="Decision (OR)" hint="branch points" />
        <Stat value={fmt(stats.andNodes)} label="AND nodes" hint="decompositions" />
        <Stat value={fmt(stats.litNodes)} label="Literal leaves" hint="forced + free" />
        <Stat value={`${reuse}%`} label="Sub-formula reuse" hint={`${fmt(stats.cacheHits)} cache hits`} />
        <Stat value={fmt(stats.searchNodes)} label="Search nodes" hint="DPLL trace" />
        <Stat value={`${stats.timeMs.toFixed(1)} ms`} label="Compile time" hint="one-time cost" />
      </div>

      <div className="wmc-panel">
        <h3 className="compile-h3">Weighted model count &amp; marginals</h3>
        <p className="compile-sub">
          Tilt every variable toward <em>true</em> with weight <code>p</code> (so a positive literal
          is worth <code>p</code> and a negative one <code>1−p</code>). At <code>p = 0.5</code> the
          weighted count is exactly <code>models / 2ⁿ</code> and the bars below are the fraction of
          solutions in which each variable is true. Both update in real time — each is a single linear
          pass over the same compiled circuit.
        </p>
        <div className="tilt-row">
          <label className="tilt-label">
            p = <strong>{p.toFixed(2)}</strong>
          </label>
          <input
            className="tilt-slider"
            type="range"
            min={0}
            max={1}
            step={0.01}
            value={p}
            onChange={(e) => setP(Number(e.target.value))}
          />
          <button className="tilt-reset" onClick={() => setP(0.5)} disabled={p === 0.5}>
            reset
          </button>
        </div>
        <div className="wmc-readout">
          <div className="wmc-figure">
            <span className="wmc-key">Weighted model count Z</span>
            <span className="wmc-val">{wmc.toExponential(6)}</span>
          </div>
          <div className="wmc-figure">
            <span className="wmc-key">{p === 0.5 ? 'Z × 2ⁿ (= model count)' : 'share of weighted mass'}</span>
            <span className="wmc-val">{p === 0.5 ? groupDigits(count.toString()) : wmc.toPrecision(6)}</span>
          </div>
        </div>

        <MarginalBars probTrue={marg.probTrue} numVars={ddnnf.numVars} />
      </div>

      <div className="compile-actions">
        <button className="tilt-reset" onClick={() => download(`circuit-${ddnnf.numVars}v.nnf`, toNnf(ddnnf))}>
          ⤓ Download .nnf circuit
        </button>
      </div>
    </div>
  )
}

function MarginalBars({ probTrue, numVars }: { probTrue: number[]; numVars: number }) {
  const cap = 64
  const shown = Math.min(numVars, cap)
  return (
    <div className="marg-wrap">
      <div className="marg-head">
        <span>Variable marginals — Pr(xᵢ = true)</span>
        {numVars > cap && <span className="marg-note">showing first {cap} of {numVars}</span>}
      </div>
      <div className="marg-grid">
        {Array.from({ length: shown }, (_, i) => {
          const v = i + 1
          const pr = probTrue[v] ?? 0
          const pct = Math.round(pr * 100)
          const pinned = pr <= 1e-9 ? 'false' : pr >= 1 - 1e-9 ? 'true' : ''
          return (
            <div className="marg-row" key={v} title={`x${v}: Pr(true) = ${pr.toFixed(4)}`}>
              <span className="marg-var">x{v}</span>
              <div className="marg-track">
                <div className={`marg-fill ${pinned}`} style={{ width: `${pct}%` }} />
                <div className="marg-mid" />
              </div>
              <span className="marg-pct">{pr.toFixed(2)}</span>
            </div>
          )
        })}
      </div>
    </div>
  )
}

function Badge({ ok, label }: { ok: boolean; label: string }) {
  return <span className={`circuit-badge ${ok ? 'ok' : 'bad'}`}>{ok ? '✓' : '✗'} {label}</span>
}

function Stat({ value, label, hint }: { value: string; label: string; hint: string }) {
  return (
    <div className="stat-card">
      <div className="stat-value">{value}</div>
      <div className="stat-label">{label}</div>
      <div className="stat-hint">{hint}</div>
    </div>
  )
}

function fmt(n: number): string {
  return n.toLocaleString('en-US')
}

function groupDigits(s: string): string {
  const neg = s.startsWith('-')
  const body = neg ? s.slice(1) : s
  const grouped = body.replace(/\B(?=(\d{3})+(?!\d))/g, ',')
  return neg ? '-' + grouped : grouped
}

function scientific(n: bigint): string {
  const s = (n < 0n ? -n : n).toString()
  const exp = s.length - 1
  const mantissa = `${s[0]}.${s.slice(1, 3)}`
  return `${n < 0n ? '-' : ''}${mantissa} × 10^${exp}`
}

/** Trigger a client-side download. Sandboxed previews may block this — tolerate it. */
function download(name: string, text: string): void {
  try {
    const blob = new Blob([text], { type: 'text/plain' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = name
    document.body.appendChild(a)
    a.click()
    a.remove()
    setTimeout(() => URL.revokeObjectURL(url), 0)
  } catch {
    /* ignore — download not available in this context */
  }
}
