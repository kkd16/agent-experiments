import { useMemo, useState } from 'react'
import { PageHead, Panel, Slider, Verdict } from '../ui/components'
import { g1Hex, R } from '../ecc/bls12381'
import { ellipsize } from '../ui/format'
import {
  setup,
  CUBIC_STEP,
  ivcProveWith,
  ivcVerify,
  type IvcProof,
  type StepFn,
  type NovaParams,
} from '../ecc/nova'
import { mimcStep } from '../ecc/nova_mimc'

// The two IVC applications share one generic folding core; only the step circuit
// differs. Generators are built once per circuit at module load.
const APPS: { key: string; label: string; blurb: string; step: StepFn; params: NovaParams }[] = [
  {
    key: 'cubic',
    label: 'Cubic — z ↦ z³ + z + 5',
    blurb: 'The canonical Nova example: one cube per step, 3 constraints.',
    step: CUBIC_STEP,
    params: setup(CUBIC_STEP.r1cs),
  },
  (() => {
    const step = mimcStep(6)
    return {
      key: 'mimc',
      label: 'MiMC — a sequential hash chain',
      blurb: 'A MiMC permutation (6 rounds of x ↦ (x+c)³) per step, 13 constraints — an arithmetic hash nobody can shortcut, the MinRoot-VDF skeleton.',
      step,
      params: setup(step.r1cs),
    }
  })(),
]

type Tamper = 'none' | 'witness' | 'crossterm' | 'chaining'

function short(x: bigint): string {
  const v = ((x % R) + R) % R
  if (v < 100000n) return v.toString()
  return ellipsize('0x' + v.toString(16), 8, 6)
}

function commHex(P: Parameters<typeof g1Hex>[0]): string {
  return ellipsize('0x' + g1Hex(P), 10, 6)
}

/** Apply the chosen corruption to a fresh honest proof, mirroring the selftest. */
function corrupt(proof: IvcProof, mode: Tamper, params: NovaParams): IvcProof {
  if (mode === 'none') return proof
  const p: IvcProof = {
    ...proof,
    stepInstances: proof.stepInstances.map((U) => ({ ...U, x: [...U.x] })),
    commTs: [...proof.commTs],
    finalWit: { E: [...proof.finalWit.E], W: [...proof.finalWit.W] },
  }
  const mid = Math.min(2, p.numSteps - 1)
  if (mode === 'witness') p.finalWit.W[0] = (p.finalWit.W[0] + 1n) % R
  if (mode === 'crossterm') p.commTs[mid] = params.gW[0]
  if (mode === 'chaining' && mid >= 0)
    p.stepInstances[mid].x[1] = (p.stepInstances[mid].x[1] + 1n) % R
  return p
}

export function NovaPage() {
  const [appKey, setAppKey] = useState('cubic')
  const [z0, setZ0] = useState(5)
  const [numSteps, setNumSteps] = useState(6)
  const [tamper, setTamper] = useState<Tamper>('none')

  const app = APPS.find((a) => a.key === appKey) ?? APPS[0]

  const { proof, report, chain, naive, nConstraints } = useMemo(() => {
    const honest = ivcProveWith(app.params, app.step, BigInt(z0), numSteps)
    const shown = corrupt(honest, tamper, app.params)
    const rep = ivcVerify(app.params, shown)
    const seq: bigint[] = [((BigInt(z0) % R) + R) % R]
    for (let i = 0; i < numSteps; i++) seq.push(app.step.eval(seq[seq.length - 1]))
    const n = app.step.r1cs.A.length
    return { proof: shown, report: rep, chain: seq, naive: numSteps * n, nConstraints: n }
  }, [z0, numSteps, tamper, app])

  return (
    <main className="page">
      <PageHead
        eyebrow="Lab 40 — proving a long computation without a long proof"
        title="Nova — a folding scheme for IVC"
      >
        To prove a function <code>F</code> was applied <code>N</code> times in a row — a hash chain, a
        VM loop, a rollup's blocks — must you build one huge proof over all <code>N</code> steps? Nova
        (Kothapalli–Setty–Tzialla, 2022) says no. Each step emits an ordinary R1CS instance, and
        instead of <em>proving</em> it we merely <strong>fold</strong> it into a running accumulator —
        one cheap linear combination of two instances into one. The prover only ever holds a single
        instance, and one final check certifies the whole chain. No trusted setup, no pairings, no
        FFTs: the entire scheme rides on the additive homomorphism of a Pedersen commitment on this
        lab's from-scratch BLS12-381 𝔾₁.
      </PageHead>

      <Panel
        title="The statement"
        sub="Prove that z₀ was pushed through the step map F, N times, ending at z_N — revealing only the endpoints."
      >
        <label className="field" style={{ marginBottom: '0.7rem' }}>
          <span>IVC application (the step circuit — the folding core is identical)</span>
          <select value={appKey} onChange={(e) => setAppKey(e.target.value)}>
            {APPS.map((a) => (
              <option key={a.key} value={a.key}>{a.label}</option>
            ))}
          </select>
        </label>
        <div className="note" style={{ marginBottom: '0.8rem' }}>{app.blurb}</div>
        <Slider label="initial z₀" value={z0} min={0} max={99} onChange={setZ0} />
        <Slider label="number of steps N" value={numSteps} min={1} max={16} onChange={setNumSteps} />
        <div className="mono" style={{ fontSize: '0.82rem', lineHeight: 1.9, marginTop: '0.6rem', wordBreak: 'break-all' }}>
          {chain.map((z, i) => (
            <span key={i}>
              {i > 0 && <span style={{ opacity: 0.4 }}> → </span>}
              <span style={{ opacity: i === 0 || i === chain.length - 1 ? 1 : 0.65 }}>{short(z)}</span>
            </span>
          ))}
        </div>
      </Panel>

      <Panel
        title="1 · Relaxed R1CS — the shape that folds"
        sub="Ordinary R1CS is (A·Z)∘(B·Z) = (C·Z); the quadratic ∘ breaks linearity. Nova relaxes it with a scalar u and an error vector E."
      >
        <div className="note mono" style={{ marginBottom: '0.6rem' }}>
          (A·Z)∘(B·Z) = u·(C·Z) + E &nbsp;&nbsp;·&nbsp;&nbsp; Z = [ u | x | W ]
        </div>
        <div className="mono" style={{ fontSize: '0.8rem', lineHeight: 1.8 }}>
          <div className="note" style={{ marginBottom: '0.3rem', opacity: 0.7 }}>
            step circuit — {nConstraints} rank-1 constraints, public IO x = [z_in, z_out]:
          </div>
          {app.key === 'cubic' ? (
            <>
              <div>c₁: &nbsp;z_in · z_in = sym1</div>
              <div>c₂: &nbsp;sym1 · z_in = y</div>
              <div>c₃: &nbsp;(y + z_in + 5·one) · one = z_out</div>
            </>
          ) : (
            <>
              <div>per round r on the running value xᵣ (x₀ = z_in):</div>
              <div>&nbsp;&nbsp;sqᵣ &nbsp;&nbsp;= (xᵣ + cᵣ) · (xᵣ + cᵣ)</div>
              <div>&nbsp;&nbsp;cubeᵣ = sqᵣ · (xᵣ + cᵣ) &nbsp;&nbsp;(= xᵣ₊₁)</div>
              <div>final: cube_R−1 · one = z_out</div>
            </>
          )}
        </div>
        <p className="note" style={{ marginTop: '0.7rem' }}>
          An ordinary step instance embeds as <span className="mono">u = 1, E = 0</span> — the
          un-relaxed case. The accumulator starts from the trivially-satisfied zero instance
          (<span className="mono">u = 0, E = 0, W = 0</span>) and picks up a non-trivial u and E as
          steps fold in.
        </p>
      </Panel>

      <Panel
        title="2 · The folding scheme (NIFS)"
        sub="Fold Z = Z₁ + r·Z₂ and the quadratic's cross terms land exactly in a computable T; the verifier folds the committed instances homomorphically — never touching a witness."
      >
        <div className="note mono" style={{ marginBottom: '0.8rem', wordBreak: 'break-all' }}>
          A(Z₁+rZ₂)∘B(Z₁+rZ₂) = (u₁+ru₂)·C(…) + (E₁ + r·T + r²·E₂)
        </div>
        <div style={{ overflowX: 'auto' }}>
          <table className="data">
            <thead>
              <tr>
                <th>fold</th>
                <th>challenge r (Fiat–Shamir)</th>
                <th>cross-term commit T̄</th>
                <th>running u</th>
                <th>acc. commit W̄</th>
              </tr>
            </thead>
            <tbody>
              {proof.accInstances.map((U, i) => (
                <tr key={i}>
                  <td className="mono">{i + 1}</td>
                  <td className="mono">{short(reChallenge(proof, i))}</td>
                  <td className="mono">{commHex(proof.commTs[i])}</td>
                  <td className="mono">{short(U.u)}</td>
                  <td className="mono">{commHex(U.commW)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="note" style={{ marginTop: '0.7rem' }}>
          Each row is two 𝔾₁ additions and a scalar-mul per commitment. The prover keeps one folded
          witness; the verifier keeps one folded instance. Nothing grows with N.
        </p>
      </Panel>

      <Panel
        title="3 · Verify — one relaxed check for the whole chain"
        sub="The verifier replays every folding challenge, re-folds the committed instances, then runs a single relaxed-R1CS satisfaction test on the final accumulator."
        right={<Verdict ok={report.ok}>{report.ok ? 'ACCEPT ✓' : 'REJECT ✕'}</Verdict>}
      >
        <label className="field" style={{ marginBottom: '0.8rem' }}>
          <span>inject a fault (soundness demo)</span>
          <select value={tamper} onChange={(e) => setTamper(e.target.value as Tamper)}>
            <option value="none">none — honest prover</option>
            <option value="witness">corrupt the final folded witness</option>
            <option value="crossterm">forge a cross-term commitment</option>
            <option value="chaining">break the z_out → z_in chaining</option>
          </select>
        </label>

        <dl className="kv">
          {report.checks.map((c, i) => (
            <span key={i} style={{ display: 'contents' }}>
              <dt>{c.name}</dt>
              <dd>
                <Verdict ok={c.ok}>{c.ok ? 'ok' : 'fail'}</Verdict>{' '}
                <span className="note" style={{ opacity: 0.7 }}>{c.detail}</span>
              </dd>
            </span>
          ))}
        </dl>

        <div className="grid cols-2" style={{ gap: '1rem', marginTop: '1rem' }}>
          <div className="hexbox violet" style={{ textAlign: 'center' }}>
            <div style={{ fontSize: '1.6rem', fontWeight: 700 }}>{naive}</div>
            <div className="note">ordinary R1CS row-checks the naïve verifier would run (N × {nConstraints})</div>
          </div>
          <div className="hexbox lavender" style={{ textAlign: 'center' }}>
            <div style={{ fontSize: '1.6rem', fontWeight: 700 }}>1</div>
            <div className="note">relaxed-R1CS check Nova runs, for any N — the folding dividend</div>
          </div>
        </div>
        <p className="note" style={{ marginTop: '0.8rem' }}>
          This lab checks the final accumulator and the public-IO chaining directly; full Nova folds
          even the folding-verifier into the step circuit (a curve cycle) so a single recursive SNARK
          at the end proves the lot. The folding scheme demonstrated here is the engine that makes
          that recursion cheap — every tamper above is caught because the binding Pedersen commitment
          pins the witness the prover never reveals.
        </p>
      </Panel>
    </main>
  )
}

/** Re-derive the r used at fold i purely for display, by diffing the running u:
 *  u_i = u_{i-1} + r_i·u_step, and each step has u_step = 1, so r_i = u_i − u_{i-1}. */
function reChallenge(proof: IvcProof, i: number): bigint {
  const prev = i === 0 ? 0n : proof.accInstances[i - 1].u
  return ((proof.accInstances[i].u - prev) % R + R) % R
}
