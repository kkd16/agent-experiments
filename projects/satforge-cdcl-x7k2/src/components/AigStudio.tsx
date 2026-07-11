import { useMemo, useState } from 'react'
import './AigStudio.css'
import {
  Aig,
  AIG_EXAMPLES,
  buildPairFromDsl,
  checkEquivalence,
  fraig,
  parseCircuit,
  buildCircuit,
  truthTable,
  inputBus,
  rippleAdder,
  carrySelectAdder,
  arrayMultiplier,
  type AigExample,
  type CecResult,
  type FraigStats,
  type Lit,
} from '../aig'
import { runAigChecks, type AigCheckReport } from '../aig'

type Panel = 'equiv' | 'sweep' | 'truth' | 'checks'

const PANELS: { id: Panel; label: string }[] = [
  { id: 'equiv', label: 'Equivalence' },
  { id: 'sweep', label: 'SAT Sweep' },
  { id: 'truth', label: 'Truth table' },
  { id: 'checks', label: 'Self-tests' },
]

export function AigStudio() {
  const [panel, setPanel] = useState<Panel>('equiv')
  return (
    <div className="layout aig">
      <aside className="panel aig-side">
        <h2>AIG Studio</h2>
        <p className="aig-intro">
          <strong>Are two circuits the same function?</strong> This is combinational{' '}
          <strong>equivalence checking</strong> — the reason SAT is a billion-dollar technology. Both
          circuits are folded into one <strong>And-Inverter Graph</strong>, then{' '}
          <strong>SAT sweeping</strong> proves out their internal equivalences one node at a time until
          the miter collapses. Every merge is <em>proved</em> by SatForge's own CDCL solver.
        </p>
        <div className="aig-navcol">
          {PANELS.map((p) => (
            <button key={p.id} className={panel === p.id ? 'active' : ''} onClick={() => setPanel(p.id)}>
              {p.label}
            </button>
          ))}
        </div>
        <div className="aig-legend">
          <h3>The one gate to rule them all</h3>
          <p>
            An AIG has a single gate — the 2-input <code>AND</code> — and a single edge bit, a fused{' '}
            <code>inverter</code>. Literal <code>l = node·2 + inv</code>; negation is <code>l ^ 1</code>.
            OR, XOR, MUX are all De-Morgan identities over that. Structural hashing fuses syntactically
            identical gates for free; SAT then finds the <em>functional</em> equivalences hashing can't see.
          </p>
        </div>
      </aside>
      <main className="content aig-main">
        {panel === 'equiv' && <EquivPanel />}
        {panel === 'sweep' && <SweepPanel />}
        {panel === 'truth' && <TruthPanel />}
        {panel === 'checks' && <ChecksPanel />}
      </main>
    </div>
  )
}

// ── Equivalence panel ─────────────────────────────────────────────────────────
const DEFAULT_A = `# Circuit A — a 2:1 multiplexer, AND/OR form
out y = (s & t) | (~s & e)`
const DEFAULT_B = `# Circuit B — the same mux as an XOR chain
out y = e ^ (s & (e ^ t))`

interface EquivRun {
  result: CecResult
  ms: number
  inputs: number
  ands: number
}

function EquivPanel() {
  const dslExamples = AIG_EXAMPLES.filter((e) => e.kind === 'dsl')
  const genExamples = AIG_EXAMPLES.filter((e) => e.kind === 'gen')
  const [srcA, setSrcA] = useState(DEFAULT_A)
  const [srcB, setSrcB] = useState(DEFAULT_B)
  const [gen, setGen] = useState<AigExample | null>(null)
  const [run, setRun] = useState<EquivRun | null>(null)
  const [error, setError] = useState<string | null>(null)

  const loadDsl = (ex: AigExample) => {
    setGen(null)
    setSrcA(ex.srcA!)
    setSrcB(ex.srcB!)
    setRun(null)
    setError(null)
  }
  const loadGen = (ex: AigExample) => {
    setGen(ex)
    setRun(null)
    setError(null)
  }

  const check = () => {
    setError(null)
    let aig: Aig
    let pairs: { name: string; a: Lit; b: Lit }[]
    if (gen) {
      aig = new Aig()
      pairs = gen.build!(aig)
    } else {
      const built = buildPairFromDsl(srcA, srcB)
      if (!built.ok) {
        setError(built.error)
        setRun(null)
        return
      }
      aig = built.built.aig
      pairs = built.built.pairs
    }
    const t0 = performance.now()
    const result = checkEquivalence(aig, pairs, { patterns: 64, seed: 0xabcdef })
    const ms = performance.now() - t0
    setRun({ result, ms, inputs: aig.inputs.length, ands: aig.numAnds })
  }

  return (
    <div className="aig-panel">
      <div className="aig-head">
        <h3>Combinational equivalence checking</h3>
        <p className="aig-sub">
          Pick a pair — or write your own — and prove whether the two circuits compute the identical
          Boolean function. Outputs are matched by name.
        </p>
      </div>

      <div className="aig-examples">
        <span className="aig-tag">Hand-written identities</span>
        {dslExamples.map((ex) => (
          <button
            key={ex.id}
            className={!gen && srcA === ex.srcA ? 'chip active' : 'chip'}
            title={ex.blurb}
            onClick={() => loadDsl(ex)}
          >
            {ex.title}
          </button>
        ))}
      </div>
      <div className="aig-examples">
        <span className="aig-tag">Structural (generated)</span>
        {genExamples.map((ex) => (
          <button
            key={ex.id}
            className={gen?.id === ex.id ? 'chip active' : 'chip'}
            title={ex.blurb}
            onClick={() => loadGen(ex)}
          >
            {ex.title}
          </button>
        ))}
      </div>

      {gen ? (
        <div className="aig-gennote">
          <strong>{gen.title}.</strong> {gen.blurb}
          <div className="aig-gendetail">{gen.genNote}</div>
        </div>
      ) : (
        <div className="aig-editors">
          <label>
            <span>Circuit A</span>
            <textarea spellCheck={false} value={srcA} onChange={(e) => setSrcA(e.target.value)} rows={6} />
          </label>
          <label>
            <span>Circuit B</span>
            <textarea spellCheck={false} value={srcB} onChange={(e) => setSrcB(e.target.value)} rows={6} />
          </label>
        </div>
      )}

      <div className="aig-actions">
        <button className="aig-run" onClick={check}>
          Check equivalence
        </button>
        {run && <span className="aig-timing">{run.inputs} inputs · {run.ands} AND gates · {run.ms.toFixed(1)} ms</span>}
      </div>

      {error && <div className="aig-error">⚠ {error}</div>}

      {run && <EquivResult run={run} />}
    </div>
  )
}

function EquivResult({ run }: { run: EquivRun }) {
  const { result } = run
  const s = result.fraig
  return (
    <div className="aig-result">
      <div className={`aig-verdict ${result.equivalent ? 'eq' : 'neq'}`}>
        {result.equivalent ? '✓ EQUIVALENT' : '✗ NOT EQUIVALENT'}
        <span className="aig-verdict-sub">
          {result.equivalent
            ? 'the two circuits compute the identical function on every input'
            : 'a distinguishing input exists — see below'}
        </span>
      </div>

      <SweepStats stats={s} miterCalls={result.miterCalls} />

      <div className="aig-outputs">
        {result.outputs.map((o) => (
          <div key={o.name} className={`aig-out ${o.equivalent ? 'eq' : 'neq'}`}>
            <span className="aig-out-name">{o.name}</span>
            <span className="aig-out-verdict">{o.equivalent ? 'equal' : 'differs'}</span>
            {o.counterexample && (
              <div className="aig-cex">
                <span className="aig-cex-label">counterexample</span>
                {o.counterexample.map((c) => (
                  <span key={c.name} className="aig-bit">
                    {c.name}=<b>{c.value}</b>
                  </span>
                ))}
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  )
}

function SweepStats({ stats, miterCalls }: { stats: FraigStats; miterCalls?: number }) {
  const pct = stats.andsBefore > 0 ? Math.round((100 * stats.andsAfter) / stats.andsBefore) : 100
  return (
    <div className="aig-stats">
      <div className="aig-stat">
        <span className="v">
          {stats.andsBefore} → {stats.andsAfter}
        </span>
        <span className="k">AND gates (after sweep)</span>
        <div className="aig-bar">
          <div className="aig-bar-fill" style={{ width: `${pct}%` }} />
        </div>
      </div>
      <div className="aig-stat">
        <span className="v">{stats.merges}</span>
        <span className="k">nodes proved equal &amp; merged</span>
      </div>
      <div className="aig-stat">
        <span className="v">{stats.satCalls}</span>
        <span className="k">SAT proofs</span>
      </div>
      <div className="aig-stat">
        <span className="v">{stats.refutations}</span>
        <span className="k">sim. counterexamples</span>
      </div>
      <div className="aig-stat">
        <span className="v">
          {stats.depthBefore} → {stats.depthAfter}
        </span>
        <span className="k">logic depth</span>
      </div>
      {miterCalls !== undefined && (
        <div className="aig-stat">
          <span className="v">{miterCalls}</span>
          <span className="k">final miter solves</span>
        </div>
      )}
    </div>
  )
}

// ── SAT-sweep panel (single circuit) ──────────────────────────────────────────
interface SweepPreset {
  id: string
  label: string
  note: string
  build: () => Aig
}

const SWEEP_PRESETS: SweepPreset[] = [
  {
    id: 'adder',
    label: 'Ripple ∥ carry-select adder (8-bit)',
    note: 'Both adders live in one graph. Structural hashing shares nothing between them; SAT sweeping proves each carry-select bit equals its ripple twin and folds the two designs into one.',
    build: () => {
      const aig = new Aig()
      const a = inputBus(aig, 'a', 8)
      const b = inputBus(aig, 'b', 8)
      const r = rippleAdder(aig, a, b)
      const s = carrySelectAdder(aig, a, b, 3)
      r.sum.forEach((bit, i) => aig.addOutput(`r_sum${i}`, bit))
      aig.addOutput('r_cout', r.cout)
      s.sum.forEach((bit, i) => aig.addOutput(`s_sum${i}`, bit))
      aig.addOutput('s_cout', s.cout)
      return aig
    },
  },
  {
    id: 'mult',
    label: 'a·b ∥ b·a multiplier (4-bit)',
    note: 'Two array multipliers with the operands swapped. Commutativity is invisible to structure — sweeping proves every product bit equal and merges the second multiplier away entirely.',
    build: () => {
      const aig = new Aig()
      const a = inputBus(aig, 'a', 4)
      const b = inputBus(aig, 'b', 4)
      const p1 = arrayMultiplier(aig, a, b)
      const p2 = arrayMultiplier(aig, b, a)
      p1.forEach((bit, i) => aig.addOutput(`ab${i}`, bit))
      p2.forEach((bit, i) => aig.addOutput(`ba${i}`, bit))
      return aig
    },
  },
  {
    id: 'mux',
    label: 'Multiplexer, three ways',
    note: 'The same 2:1 mux written as an AND/OR tree, an XOR chain, and a NAND form — all in one graph. None share structure, yet sweeping collapses all three into a single cone.',
    build: () => {
      const aig = new Aig()
      const s = aig.addInput('s')
      const t = aig.addInput('t')
      const e = aig.addInput('e')
      const andor = aig.mkOr(aig.mkAnd(s, t), aig.mkAnd(litNotUi(s), e))
      const xorform = aig.mkXor(e, aig.mkAnd(s, aig.mkXor(e, t)))
      const nandform = litNotUi(aig.mkAnd(litNotUi(aig.mkAnd(s, t)), litNotUi(aig.mkAnd(litNotUi(s), e))))
      aig.addOutput('andor', andor)
      aig.addOutput('xor', xorform)
      aig.addOutput('nand', nandform)
      return aig
    },
  },
]

const litNotUi = (l: Lit): Lit => l ^ 1

function SweepPanel() {
  const [presetId, setPresetId] = useState(SWEEP_PRESETS[0].id)
  const result = useMemo(() => {
    const preset = SWEEP_PRESETS.find((p) => p.id === presetId)!
    const aig = preset.build()
    const swept = fraig(aig, { patterns: 64, seed: 0x77 })
    return { swept, inputs: aig.inputs.length, note: preset.note }
  }, [presetId])

  return (
    <div className="aig-panel">
      <div className="aig-head">
        <h3>SAT sweeping (FRAIG) a single circuit</h3>
        <p className="aig-sub">
          Structural hashing fuses only <em>syntactically</em> identical gates. SAT sweeping goes
          further: it simulates to find candidate equal nodes, then <em>proves</em> each with the CDCL
          solver, folding the redundant one away. The result is the same function in fewer gates —
          the &ldquo;fraig&rdquo; (functionally-reduced AIG) at the heart of logic synthesis.
        </p>
      </div>
      <div className="aig-examples">
        {SWEEP_PRESETS.map((p) => (
          <button key={p.id} className={presetId === p.id ? 'chip active' : 'chip'} onClick={() => setPresetId(p.id)}>
            {p.label}
          </button>
        ))}
      </div>
      <div className="aig-gennote">{result.note}</div>
      <div className="aig-actions">
        <span className="aig-timing">{result.inputs} inputs</span>
      </div>
      <SweepStats stats={result.swept.stats} />
      <p className="aig-foot">
        {result.swept.stats.merges > 0 ? (
          <>
            SAT sweeping proved <b>{result.swept.stats.merges}</b> internal nodes redundant, shrinking the
            graph from <b>{result.swept.stats.andsBefore}</b> to <b>{result.swept.stats.andsAfter}</b> AND
            gates — a reduction structural hashing alone could not find.
          </>
        ) : (
          <>This graph is already functionally reduced — structural hashing caught everything.</>
        )}
      </p>
    </div>
  )
}

// ── Truth-table panel ─────────────────────────────────────────────────────────
const TRUTH_DEFAULT = `# a full adder — two outputs
out sum  = a ^ b ^ cin
out cout = (a & b) | (cin & (a ^ b))`

function TruthPanel() {
  const [src, setSrc] = useState(TRUTH_DEFAULT)
  const analysis = useMemo(() => {
    const parsed = parseCircuit(src)
    if (!parsed.ok) return { error: `line ${parsed.line}: ${parsed.error}` }
    if (parsed.circuit.inputs.length > 10)
      return { error: `${parsed.circuit.inputs.length} inputs — truth table capped at 10` }
    const aig = new Aig()
    const inputLit = new Map<string, Lit>()
    for (const n of parsed.circuit.inputs) inputLit.set(n, aig.addInput(n))
    let outs: { name: string; lit: Lit }[]
    try {
      outs = buildCircuit(aig, parsed.circuit, inputLit)
    } catch (e) {
      return { error: (e as Error).message }
    }
    const tables = outs.map((o) => ({ name: o.name, tt: truthTable(aig, o.lit) }))
    return { inputs: parsed.circuit.inputs, tables, ands: aig.numAnds }
  }, [src])

  return (
    <div className="aig-panel">
      <div className="aig-head">
        <h3>Truth table</h3>
        <p className="aig-sub">The exhaustive semantics of a circuit — the reference the equivalence checker is pinned against.</p>
      </div>
      <div className="aig-editors one">
        <label>
          <span>Circuit</span>
          <textarea spellCheck={false} value={src} onChange={(e) => setSrc(e.target.value)} rows={6} />
        </label>
      </div>
      {'error' in analysis && analysis.error ? (
        <div className="aig-error">⚠ {analysis.error}</div>
      ) : (
        'tables' in analysis && (
          <div className="aig-truth-wrap">
            <table className="aig-truth">
              <thead>
                <tr>
                  {analysis.inputs!.map((n) => (
                    <th key={n} className="in">
                      {n}
                    </th>
                  ))}
                  {analysis.tables!.map((t) => (
                    <th key={t.name} className="out">
                      {t.name}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {Array.from({ length: 1 << analysis.inputs!.length }, (_, m) => (
                  <tr key={m}>
                    {analysis.inputs!.map((n, s) => (
                      <td key={n} className="in">
                        {(m >> s) & 1}
                      </td>
                    ))}
                    {analysis.tables!.map((t) => (
                      <td key={t.name} className={`out ${(t.tt >> BigInt(m)) & 1n ? 'one' : 'zero'}`}>
                        {Number((t.tt >> BigInt(m)) & 1n)}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )
      )}
    </div>
  )
}

// ── Self-tests panel ──────────────────────────────────────────────────────────
function ChecksPanel() {
  const report: AigCheckReport = useMemo(() => runAigChecks(), [])
  return (
    <div className="aig-panel">
      <div className="aig-head">
        <h3>Differential self-check</h3>
        <p className="aig-sub">
          The whole engine, pinned against an independent exhaustive truth-table oracle — nothing here
          trusts the SAT path it is verifying.
        </p>
      </div>
      <div className={`aig-badge ${report.fail === 0 ? 'ok' : 'bad'}`}>
        {report.fail === 0 ? `✓ all ${report.pass} checks pass` : `✗ ${report.fail} of ${report.pass + report.fail} checks failed`}
      </div>
      <ul className="aig-checklist">
        {report.messages.map((m, i) => (
          <li key={i} className={m.startsWith('✓') ? 'ok' : 'bad'}>
            {m}
          </li>
        ))}
      </ul>
    </div>
  )
}
