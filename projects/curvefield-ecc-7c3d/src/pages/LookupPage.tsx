import { useEffect, useMemo, useRef, useState } from 'react'
import { PageHead, Panel, Verdict } from '../ui/components'
import * as lookup from '../ecc/lookup'
import type { SRS } from '../ecc/kzg'
import { R, type G1 } from '../ecc/bls12381'
import { compressG1 } from '../ecc/blsenc'
import { hex, ellipsize } from '../ui/format'

const LTAU = 0x1234_5678_9abc_def0_feed_face_dead_beefn
// Folding challenge for the vector (XOR-table) lookup — a fixed nothing-up-my-sleeve
// constant here so the demo is deterministic; a real prover draws it by Fiat–Shamir.
const XOR_GAMMA = 0x9e3779b97f4a7c15n

// Compress a G1 point to a short hex string for display.
function g1hex(P: G1): string {
  let s = ''
  for (const x of compressG1(P)) s += x.toString(16).padStart(2, '0')
  return s
}

const short = (n: bigint) => (n === 0n ? '0' : ellipsize(hex(mod(n), 64), 6, 4))
const mod = (n: bigint) => ((n % R) + R) % R

function parseList(s: string): bigint[] {
  return s
    .split(/[,\s]+/)
    .map((x) => x.trim())
    .filter((x) => x.length > 0)
    .map((x) => {
      try {
        return BigInt(x)
      } catch {
        return 0n
      }
    })
}

// An SRS is a few dozen group elements; cache one per domain size N and surface
// the current one through state (refs must not be read during render).
function useSrs(N: number): SRS | null {
  const cache = useRef(new Map<number, SRS>())
  const [entry, setEntry] = useState<{ N: number; srs: SRS } | null>(null)
  useEffect(() => {
    if (N <= 0) return
    const cached = cache.current.get(N)
    if (cached) {
      setEntry({ N, srs: cached })
      return
    }
    const id = setTimeout(() => {
      try {
        const srs = lookup.logupSetup(N, LTAU)
        cache.current.set(N, srs)
        setEntry({ N, srs })
      } catch {
        /* degraded env */
      }
    }, 0)
    return () => clearTimeout(id)
  }, [N])
  return entry && entry.N === N ? entry.srs : null
}

// ─────────────────────────────────────────────────────────────────────────────

export function LookupPage() {
  return (
    <main className="page">
      <PageHead eyebrow="Lab 41 — proving a value lives in a table, in one constraint" title="Lookup Arguments">
        A PLONK gate (Lab 24) expresses arithmetic — <code>a·b</code>, <code>a+b</code>, a constant —
        for almost nothing, but a bitwise <code>XOR</code>, an 8-bit range check, or an S-box costs
        dozens of gates each. A <strong>lookup argument</strong> collapses all of that to a single
        claim: <em>this row appears in that table</em>. It is the reason modern zkVMs (Halo2,
        Plonky2/3, the zkEVMs of Scroll, Polygon and zkSync) can prove a whole CPU — range checks,
        byte operations and precompiles all become lookups. This lab builds the two canonical
        arguments from scratch on the very same BLS12-381 pairing and KZG commitments as PLONK:
        the modern <strong>logUp</strong> (a full non-interactive SNARK) and the original{' '}
        <strong>Plookup</strong>, then puts them to work as a range check and an XOR table.
      </PageHead>

      <LogupPanel />
      <RangePanel />
      <XorPanel />
      <PlookupPanel />

      <Panel title="Why it matters">
        <p className="lead" style={{ margin: 0 }}>
          Lookups are what turn a general-purpose SNARK into a practical <em>virtual machine</em>.
          Every non-arithmetic operation a CPU performs — masking a byte, comparing two numbers,
          computing a hash round's S-box, bounding a memory address — is a table lookup, and logUp
          proves millions of them for the cost of committing one small multiplicity column. The same
          identity, <code>Σ 1/(β−fᵢ) = Σ mⱼ/(β−tⱼ)</code>, underlies the lookup arguments in every
          production zkVM shipping today.
        </p>
      </Panel>
    </main>
  )
}

// ── logUp — the flagship KZG SNARK ───────────────────────────────────────────

function LogupPanel() {
  const [tableStr, setTableStr] = useState('3, 5, 8, 13, 21, 34, 55, 89')
  const [witnessStr, setWitnessStr] = useState('8, 8, 55, 3, 21, 8')
  const [cheat, setCheat] = useState(false)
  const [tamper, setTamper] = useState(false)

  const table = useMemo(() => parseList(tableStr), [tableStr])
  const witnessBase = useMemo(() => parseList(witnessStr), [witnessStr])
  const witness = useMemo(
    () => (cheat ? [...witnessBase, 999n] : witnessBase),
    [witnessBase, cheat],
  )
  const N = useMemo(
    () => (table.length ? lookup.padToPow2(Math.max(table.length, witness.length)) : 0),
    [table.length, witness.length],
  )
  const srs = useSrs(N)

  type Out = {
    key: string
    proof: lookup.LogupProof
    aux: lookup.LogupWitnessAux
    res: lookup.LogupVerifyResult
    replay: { closes: boolean; rowsOk: boolean }
  }
  const [out, setOut] = useState<Out | null>(null)
  const key = `${tableStr}|${witnessStr}|${cheat}|${tamper}`
  useEffect(() => {
    if (!srs || table.length === 0 || N === 0) return
    let alive = true
    const id = setTimeout(() => {
      try {
        const inst: lookup.LogupInstance = { table, N }
        const { proof, aux } = lookup.logupProve(srs, inst, witness, { forceCheat: cheat })
        const shown = tamper ? { ...proof, sz: mod(proof.sz + 1n) } : proof
        const res = lookup.logupVerify(srs, inst, shown)
        const replay = lookup.logupReplay(aux)
        if (alive) setOut({ key, proof, aux, res, replay })
      } catch {
        /* degraded env / mid-edit */
      }
    }, 20)
    return () => {
      alive = false
      clearTimeout(id)
    }
  }, [srs, table, witness, N, cheat, tamper, key])

  const fresh = out !== null && out.key === key
  const aux = out?.aux
  const maxMult = aux ? aux.multiplicities.reduce((m, x) => (x > m ? x : m), 0n) : 1n

  return (
    <Panel
      title="1 · logUp — the log-derivative lookup argument"
      sub="Prove every witness value fᵢ appears in the table t, via Σ 1/(β−fᵢ) = Σ mⱼ/(β−tⱼ). Committed with KZG and checked at one Fiat–Shamir point ζ."
      right={
        fresh ? (
          <Verdict ok={out.res.ok}>
            {out.res.ok ? 'proof accepts ✓' : 'rejected ✗'}
          </Verdict>
        ) : (
          <span className="tag">building…</span>
        )
      }
    >
      <div className="grid cols-2" style={{ gap: '1rem' }}>
        <label className="field">
          <span>table t (the fixed set values may be drawn from)</span>
          <input value={tableStr} onChange={(e) => setTableStr(e.target.value)} />
        </label>
        <label className="field">
          <span>witness f (the values used — must all be in t)</span>
          <input value={witnessStr} onChange={(e) => setWitnessStr(e.target.value)} />
        </label>
      </div>

      <div className="btn-row" style={{ marginTop: '0.4rem' }}>
        <button className={'btn' + (cheat ? ' on' : '')} onClick={() => setCheat((v) => !v)}>
          {cheat ? '✓ ' : ''}inject an out-of-table value (999)
        </button>
        <button className={'btn' + (tamper ? ' on' : '')} onClick={() => setTamper((v) => !v)}>
          {tamper ? '✓ ' : ''}tamper with an opening
        </button>
      </div>

      {N > 0 && (
        <div className="statline" style={{ marginTop: '0.8rem' }}>
          <div className="stat"><b>{table.length}</b><span>table entries</span></div>
          <div className="stat"><b>{witness.length}</b><span>witness values</span></div>
          <div className="stat"><b>{N}</b><span>domain |H| (padded)</span></div>
          <div className="stat"><b>6</b><span>KZG openings</span></div>
          <div className="stat"><b>1</b><span>final pairing</span></div>
        </div>
      )}

      {fresh && aux && (
        <>
          <div className="note" style={{ marginTop: '0.8rem' }}>
            {out.res.detail}. Fiat–Shamir β = <span className="mono">{short(aux.beta)}</span>. Every
            witness value {aux.inTable ? 'was found in the table' : 'could NOT all be matched — 999 has no row'}.
          </div>

          <h3 style={{ margin: '1rem 0 0.4rem' }}>Multiplicities m — how often each table row is looked up</h3>
          <div className="bars">
            {aux.tablePadded.map((tv, j) => {
              const m = aux.multiplicities[j]
              const pct = maxMult > 0n ? Number((m * 100n) / maxMult) : 0
              return (
                <div className="bar" key={j}>
                  <span className="mono" style={{ minWidth: '3.5rem' }}>t={tv.toString()}</span>
                  <div className="track">
                    <div
                      className="fill"
                      style={{ width: `${Math.max(pct, m > 0n ? 6 : 0)}%`, background: m > 0n ? '#a78bfa' : '#2a2a3a' }}
                    />
                  </div>
                  <span className="mono val">m={m.toString()}</span>
                </div>
              )
            })}
          </div>

          <h3 style={{ margin: '1rem 0 0.4rem' }}>The grand-sum accumulator S over H</h3>
          <div className="sub" style={{ marginBottom: '0.4rem' }}>
            S starts at 0 and adds each row's term aᵢ = 1/(β−fᵢ) − mᵢ/(β−tᵢ). Because H is a full
            cycle, S returns to 0 <em>iff</em> the two sides of the identity are equal.
          </div>
          <div className="acc-row">
            {aux.accumulator.map((a, i) => (
              <div key={i} className={'acc-cell' + (i === 0 ? ' close' : '')}>
                <div className="acc-ix">S(ω{sup(i)})</div>
                <div className="acc-val mono">{a === 0n ? '0' : short(a)}</div>
              </div>
            ))}
          </div>
          <dl className="kv" style={{ marginTop: '0.6rem' }}>
            <dt>grand sum closes (Σ aᵢ = 0, so S wraps to 0)</dt>
            <dd>
              <Verdict ok={out.replay.closes && out.replay.rowsOk}>
                {out.replay.closes && out.replay.rowsOk ? 'log-derivative identity holds ✓' : 'does not close ✗'}
              </Verdict>
            </dd>
            <dt>KZG openings verify (one multi-pairing)</dt>
            <dd><Verdict ok={out.res.openingsOk}>{out.res.openingsOk ? 'six openings ✓' : 'a pairing failed ✗'}</Verdict></dd>
            <dt>constraint holds at ζ = {short(out.proof.zeta)}</dt>
            <dd><Verdict ok={out.res.identityOk}>{out.res.identityOk ? 'quotient checks ✓' : 'identity broken ✗'}</Verdict></dd>
          </dl>

          <h3 style={{ margin: '1rem 0 0.4rem' }}>KZG commitments (each an entire polynomial in one BLS12-381 point)</h3>
          <div className="kv mono" style={{ fontSize: '0.82rem' }}>
            <div className="acc-ix">[f]₁ = {ellipsize(g1hex(out.proof.cF), 8, 6)}</div>
            <div className="acc-ix">[m]₁ = {ellipsize(g1hex(out.proof.cM), 8, 6)}</div>
            <div className="acc-ix">[S]₁ = {ellipsize(g1hex(out.proof.cS), 8, 6)}</div>
            <div className="acc-ix">[Q]₁ = {ellipsize(g1hex(out.proof.cQ), 8, 6)}</div>
          </div>
        </>
      )}
    </Panel>
  )
}

// ── Range check ──────────────────────────────────────────────────────────────

function RangePanel() {
  const [bits, setBits] = useState(4)
  const [valsStr, setValsStr] = useState('0, 7, 15, 3, 10')
  const vals = useMemo(() => parseList(valsStr), [valsStr])
  const table = useMemo(() => lookup.rangeTable(bits), [bits])
  const N = useMemo(() => lookup.padToPow2(Math.max(table.length, vals.length || 1)), [table.length, vals.length])
  const srs = useSrs(N)

  const [res, setRes] = useState<{ key: string; ok: boolean; bad: bigint[] } | null>(null)
  const key = `${bits}|${valsStr}`
  useEffect(() => {
    if (!srs) return
    let alive = true
    const id = setTimeout(() => {
      try {
        const bound = 1n << BigInt(bits)
        const bad = vals.filter((v) => v < 0n || v >= bound)
        const inst: lookup.LogupInstance = { table, N }
        const { proof } = lookup.logupProve(srs, inst, vals, { forceCheat: bad.length > 0 })
        const ok = lookup.logupVerify(srs, inst, proof).ok
        if (alive) setRes({ key, ok, bad })
      } catch {
        /* degraded */
      }
    }, 20)
    return () => {
      alive = false
      clearTimeout(id)
    }
  }, [srs, table, vals, N, bits, key])

  const fresh = res !== null && res.key === key
  return (
    <Panel
      title="2 · Range check — is every value in [0, 2ⁿ)?"
      sub="Look each value up into the table {0, 1, …, 2ⁿ−1}. Success is exactly a proof that 0 ≤ value < 2ⁿ — the single most common lookup in any zkVM."
      right={fresh ? <Verdict ok={res.ok}>{res.ok ? 'all in range ✓' : 'out of range ✗'}</Verdict> : <span className="tag">building…</span>}
    >
      <div className="field">
        <label>
          <span>range width n (table = {'{'}0,…,{(1 << bits) - 1}{'}'})</span>
          <span className="val">{bits} bits</span>
        </label>
        <input type="range" min={2} max={6} value={bits} onChange={(e) => setBits(Number(e.target.value))} />
      </div>
      <label className="field">
        <span>values to bound</span>
        <input value={valsStr} onChange={(e) => setValsStr(e.target.value)} />
      </label>
      {fresh && (
        <div className="note" style={{ marginTop: '0.6rem' }}>
          {res.ok
            ? `Every value looks up into {0,…,${(1 << bits) - 1}} — the range proof holds.`
            : `Rejected: ${res.bad.map((b) => b.toString()).join(', ')} ${res.bad.length === 1 ? 'is' : 'are'} ≥ 2^${bits}, with no table row to match.`}
        </div>
      )}
    </Panel>
  )
}

// ── XOR table (vector lookup) ────────────────────────────────────────────────

function XorPanel() {
  const [bits, setBits] = useState(2)
  const [a, setA] = useState(1)
  const [b, setB] = useState(2)
  const [claimed, setClaimed] = useState(3)

  const tableRows = useMemo(() => lookup.xorTable(bits), [bits])
  const truth = (a ^ b) & ((1 << bits) - 1)
  const folded = useMemo(
    () => lookup.foldVectorLookup({ tableRows, witnessRows: [[BigInt(a), BigInt(b), BigInt(claimed)]], gamma: XOR_GAMMA }),
    [tableRows, a, b, claimed],
  )
  const N = useMemo(() => lookup.padToPow2(folded.table.length), [folded.table.length])
  const srs = useSrs(N)

  const [res, setRes] = useState<{ key: string; ok: boolean } | null>(null)
  const key = `${bits}|${a}|${b}|${claimed}`
  useEffect(() => {
    if (!srs) return
    let alive = true
    const id = setTimeout(() => {
      try {
        const inst: lookup.LogupInstance = { table: folded.table, N }
        const cheat = claimed !== truth
        const { proof } = lookup.logupProve(srs, inst, folded.witness, { forceCheat: cheat })
        const ok = lookup.logupVerify(srs, inst, proof).ok
        if (alive) setRes({ key, ok })
      } catch {
        /* degraded */
      }
    }, 20)
    return () => {
      alive = false
      clearTimeout(id)
    }
  }, [srs, folded, N, claimed, truth, key])

  const fresh = res !== null && res.key === key
  const maxV = (1 << bits) - 1
  return (
    <Panel
      title="3 · XOR table — a vector (multi-column) lookup"
      sub="Each table row is a triple (x, y, x⊕y). Folding a triple into x + γ·y + γ²·(x⊕y) turns a tuple lookup into a scalar logUp — how a zkVM proves bitwise ops."
      right={fresh ? <Verdict ok={res.ok}>{res.ok ? 'triple in table ✓' : 'not in table ✗'}</Verdict> : <span className="tag">building…</span>}
    >
      <div className="field">
        <label>
          <span>operand width</span>
          <span className="val">{bits} bits ({(1 << bits) * (1 << bits)} table rows)</span>
        </label>
        <input type="range" min={1} max={3} value={bits} onChange={(e) => { setBits(Number(e.target.value)); setA((x) => x & ((1 << Number(e.target.value)) - 1)); setB((x) => x & ((1 << Number(e.target.value)) - 1)); }} />
      </div>
      <div className="grid cols-3" style={{ gap: '1rem' }}>
        <div className="field">
          <label><span>a</span><span className="val mono">{a}</span></label>
          <input type="range" min={0} max={maxV} value={a} onChange={(e) => setA(Number(e.target.value))} />
        </div>
        <div className="field">
          <label><span>b</span><span className="val mono">{b}</span></label>
          <input type="range" min={0} max={maxV} value={b} onChange={(e) => setB(Number(e.target.value))} />
        </div>
        <div className="field">
          <label><span>claimed a⊕b</span><span className="val mono">{claimed}</span></label>
          <input type="range" min={0} max={maxV} value={claimed} onChange={(e) => setClaimed(Number(e.target.value))} />
        </div>
      </div>
      <div className="note" style={{ marginTop: '0.6rem' }}>
        Row (<span className="mono">{a}, {b}, {claimed}</span>) folds to{' '}
        <span className="mono">{short(folded.witness[0])}</span>. True {a} ⊕ {b} ={' '}
        <span className="mono">{truth}</span>{' '}
        {fresh && (res.ok
          ? '— the folded triple is in the XOR table, so the bitwise result is proven correct.'
          : '— the claimed result is wrong, so the folded triple has no matching table row.')}
      </div>
    </Panel>
  )
}

// ── Plookup — the original argument ──────────────────────────────────────────

function PlookupPanel() {
  const [tableStr, setTableStr] = useState('3, 5, 8, 13, 21, 34')
  const [witnessStr, setWitnessStr] = useState('8, 8, 21, 3, 34')
  const table = useMemo(() => parseList(tableStr), [tableStr])
  const witness = useMemo(() => parseList(witnessStr), [witnessStr])
  const result = useMemo(() => {
    try {
      if (!table.length || !witness.length) return null
      return lookup.plookupCheck(witness, table)
    } catch {
      return null
    }
  }, [table, witness])

  return (
    <Panel
      title="4 · Plookup — the original multiset-equality argument"
      sub="Gabizon–Williamson 2020: sort f∪t by the table's order into s, then (1+β)ⁿ ∏(γ+fᵢ)∏(γ(1+β)+tᵢ+β·tᵢ₊₁) = ∏(γ(1+β)+sᵢ+β·sᵢ₊₁) holds iff f ⊆ t."
      right={result ? <Verdict ok={result.equal}>{result.equal ? 'LHS = RHS ✓' : 'LHS ≠ RHS ✗'}</Verdict> : <span className="tag">—</span>}
    >
      <div className="grid cols-2" style={{ gap: '1rem' }}>
        <label className="field">
          <span>table t</span>
          <input value={tableStr} onChange={(e) => setTableStr(e.target.value)} />
        </label>
        <label className="field">
          <span>witness f</span>
          <input value={witnessStr} onChange={(e) => setWitnessStr(e.target.value)} />
        </label>
      </div>
      {result && (
        <>
          <h3 style={{ margin: '1rem 0 0.4rem' }}>The sorted merge s = sort<sub>t</sub>(f ∪ t)</h3>
          <div className="acc-row">
            {result.s.map((v, i) => (
              <div key={i} className="acc-cell">
                <div className="acc-ix">s{sup(i)}</div>
                <div className="acc-val mono">{v.toString()}</div>
              </div>
            ))}
          </div>
          <dl className="kv mono" style={{ marginTop: '0.8rem', fontSize: '0.82rem' }}>
            <dt>β</dt><dd>{short(result.beta)}</dd>
            <dt>γ</dt><dd>{short(result.gamma)}</dd>
            <dt>LHS</dt><dd>{short(result.lhs)}</dd>
            <dt>RHS</dt><dd>{short(result.rhs)}</dd>
          </dl>
          <div className="note" style={{ marginTop: '0.4rem' }}>
            {result.equal
              ? 'The two grand products match: f is a sub-multiset of t. The randomised "difference encoding" (tᵢ + β·tᵢ₊₁) forces s to be a genuine sorted merge, not any rearrangement.'
              : 'The products differ: some witness value is not in the table, so no valid sorted merge exists and the equality fails (for these Fiat–Shamir β, γ, with overwhelming probability).'}
          </div>
        </>
      )}
    </Panel>
  )
}

function sup(i: number): string {
  const map: Record<string, string> = { '0': '⁰', '1': '¹', '2': '²', '3': '³', '4': '⁴', '5': '⁵', '6': '⁶', '7': '⁷', '8': '⁸', '9': '⁹' }
  return String(i)
    .split('')
    .map((d) => map[d] ?? d)
    .join('')
}
