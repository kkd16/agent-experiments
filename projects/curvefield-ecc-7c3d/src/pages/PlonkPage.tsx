import { useEffect, useMemo, useRef, useState } from 'react'
import { PageHead, Panel, Verdict } from '../ui/components'
import * as plonk from '../ecc/plonk'
import { R } from '../ecc/bls12381'
import { compressG1 } from '../ecc/blsenc'
import { hex, ellipsize } from '../ui/format'

const SETUP_TAU = 0x15c0ffee_ce12_2024_9f3c_2a1bn
const PROOF_SEED = 0x9f3c2a1b_77e4d5c6_babe_1234n

const circuit = plonk.cubeCircuit()

const g1hex = (P: plonk.PlonkProof['cA']): string => {
  let s = ''
  for (const x of compressG1(P)) s += x.toString(16).padStart(2, '0')
  return s
}

// The 3n cell grid labels for the copy-constraint view.
const cellLabel = (cell: number, n: number): string => {
  const col = Math.floor(cell / n)
  const row = cell % n
  return `${col === 0 ? 'a' : col === 1 ? 'b' : 'c'}${row}`
}

type Computed = {
  x: number
  out: bigint
  pp: plonk.PreprocessedInput
  proof: plonk.PlonkProof
  trace: plonk.ProverTrace
  satisfied: boolean
}

export function PlonkPage() {
  const [x, setX] = useState(3)
  const [wrongOut, setWrongOut] = useState(false)
  const [tamper, setTamper] = useState(false)

  // Preprocessing depends only on the circuit — compute it once and cache it.
  const ppRef = useRef<plonk.PreprocessedInput | null>(null)

  const { witness, out } = useMemo(() => plonk.cubeWitness(BigInt(x)), [x])
  const satisfiedNow = useMemo(() => plonk.circuitSatisfied(circuit, witness), [witness])

  // Prove off the paint (preprocess ~2s the first time, prove ~2.5s each x).
  const [computed, setComputed] = useState<Computed | null>(null)
  const proving = !computed || computed.x !== x
  useEffect(() => {
    let alive = true
    const id = setTimeout(() => {
      try {
        if (!ppRef.current) ppRef.current = plonk.preprocess(circuit, SETUP_TAU)
        const pp = ppRef.current
        const { proof, trace } = plonk.prove(pp, circuit, witness, PROOF_SEED)
        if (alive)
          setComputed({ x, out, pp, proof, trace, satisfied: plonk.circuitSatisfied(circuit, witness) })
      } catch {
        /* thumbnails / degraded envs: leave the "computing…" state */
      }
    }, 30)
    return () => {
      alive = false
      clearTimeout(id)
    }
  }, [x, witness, out])

  // Verify off the paint too (~0.5s); re-runs when toggles change.
  const claimedOut = useMemo(() => (wrongOut ? (out + 1n) % R : out), [wrongOut, out])
  const [res, setRes] = useState<{ key: string; r: plonk.VerifyResult } | null>(null)
  const key = `${x}|${wrongOut}|${tamper}`
  useEffect(() => {
    if (!computed || computed.x !== x) return
    let alive = true
    const id = setTimeout(() => {
      try {
        const proof = tamper ? { ...computed.proof, cC: computed.pp.cQM } : computed.proof
        const r = plonk.verify(computed.pp, [claimedOut], proof)
        if (alive) setRes({ key, r })
      } catch {
        /* ignore in degraded envs */
      }
    }, 30)
    return () => {
      alive = false
      clearTimeout(id)
    }
  }, [computed, claimedOut, tamper, x, key])

  const fresh = res !== null && res.key === key && computed?.x === x
  const expectAccept = !wrongOut && !tamper
  const proof = computed?.proof
  const trace = computed?.trace

  return (
    <main className="page">
      <PageHead
        eyebrow="Lab 24 — a universal SNARK: one setup proves any circuit"
        title="PLONK"
      >
        Groth16 (Lab 21) is the smallest proof there is — but its trusted setup is welded to one
        circuit. <strong>PLONK</strong> keeps a proof only a little larger and buys something huge in
        return: a <em>universal, updatable</em> setup — the very same KZG powers-of-τ this lab already
        builds (Lab 19) proves <em>any</em> circuit up to a size bound. It is the arithmetization
        behind Aztec, zkSync and Halo2. We prove the <em>same statement</em> as the Groth16 lab —
        knowledge of a secret <code>x</code> with <code>x³ + x + 5 = out</code> — so you can watch two
        very different machines certify one fact, entirely on this lab's from-scratch BLS12-381
        pairing and KZG commitments.
      </PageHead>

      <Panel title="The statement" sub='"I know x such that x³ + x + 5 = out", revealing only out.'>
        <div className="grid cols-2" style={{ gap: '1rem' }}>
          <label className="field">
            <span>secret x (the witness — never revealed)</span>
            <input type="number" value={x} onChange={(e) => setX(Number(e.target.value) || 0)} />
          </label>
          <div className="field">
            <span>public output out (= x³ + x + 5)</span>
            <span className="val mono">= {out.toString()}</span>
          </div>
        </div>
        <div className="note" style={{ marginTop: '0.6rem' }}>
          {proving && (!computed || computed.x !== x)
            ? 'Preprocessing the circuit and building the proof (KZG commitments over BLS12-381 — a few seconds)…'
            : 'Proof built. Every commitment and evaluation below was computed live in your browser.'}
        </div>
      </Panel>

      <Panel
        title="1 · One gate equation for the whole circuit"
        sub="Each gate is five selector constants picking a combination of its three wires a, b, c: q_L·a + q_R·b + q_O·c + q_M·a·b + q_C + PI = 0."
      >
        <div style={{ overflowX: 'auto' }}>
          <table className="plonk-table mono">
            <thead>
              <tr>
                <th>gate</th>
                <th>q_L</th>
                <th>q_R</th>
                <th>q_O</th>
                <th>q_M</th>
                <th>q_C</th>
                <th>a</th>
                <th>b</th>
                <th>c</th>
                <th>meaning</th>
              </tr>
            </thead>
            <tbody>
              {GATE_MEANINGS.map((meaning, i) => {
                const g = circuit.gates[i]
                return (
                  <tr key={i}>
                    <td>{i}</td>
                    <td>{sel(g.qL)}</td>
                    <td>{sel(g.qR)}</td>
                    <td>{sel(g.qO)}</td>
                    <td>{sel(g.qM)}</td>
                    <td>{sel(g.qC)}</td>
                    <td>{witness.a[i].toString()}</td>
                    <td>{witness.b[i].toString()}</td>
                    <td>{witness.c[i].toString()}</td>
                    <td className="dim">{meaning}</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
        <dl className="kv" style={{ marginTop: '0.6rem' }}>
          <dt>domain H = ⟨ω⟩, size n</dt>
          <dd className="mono">{circuit.n} (padded from 5 gates to a power of two)</dd>
          <dt>witness satisfies every gate</dt>
          <dd>
            <Verdict ok={satisfiedNow}>{satisfiedNow ? 'all gates hold ✓' : 'no'}</Verdict>
          </dd>
        </dl>
        <div className="note" style={{ marginTop: '0.4rem' }}>
          Gate 4 carries the public input: <code>q_L·a + PI = out − out = 0</code> binds the private
          output wire to the value the verifier is told. <code>−1</code> ≡ the field's{' '}
          <code>r−1</code>, shown as <code>−1</code> here for clarity.
        </div>
      </Panel>

      <Panel
        title="2 · The wiring is a permutation"
        sub="Which wires must be equal (x reused, an output fed forward) is a permutation σ over the 3n = 24 wire cells. Each equivalence class becomes a cycle."
      >
        <div className="mono" style={{ fontSize: '0.85rem', lineHeight: 1.9 }}>
          {circuit.copyClasses.map((cls, i) => (
            <div key={i}>
              <span className="pill">{VAR_NAMES[i]}</span> &nbsp;
              {cls.map((c) => cellLabel(c, circuit.n)).join(' = ')}
              &nbsp;→&nbsp; σ-cycle&nbsp;(
              {cls.map((c) => cellLabel(c, circuit.n)).join(' → ')} → {cellLabel(cls[0], circuit.n)})
            </div>
          ))}
        </div>
        <div className="note" style={{ marginTop: '0.5rem' }}>
          The three permutation polynomials S_σ1, S_σ2, S_σ3 interpolate σ over the cosets{' '}
          <code>H, k₁·H, k₂·H</code> (k₁={plonk.K1.toString()}, k₂={plonk.K2.toString()}), keeping the
          3n identity values distinct — and are committed once at preprocessing, part of the reusable
          verifying key.
        </div>
      </Panel>

      <Panel
        title="3 · The grand-product accumulator z(X)"
        sub="z multiplies a running ratio of (wire + β·identity + γ) over (wire + β·σ + γ) across every row. It returns to 1 after a full loop iff every copy constraint holds."
      >
        {trace ? (
          <>
            <div className="acc-row">
              {trace.accumulator.map((a, i) => (
                <div key={i} className={'acc-cell' + (i === trace.accumulator.length - 1 ? ' close' : '')}>
                  <div className="acc-ix">z(ω{sup(i)})</div>
                  <div className="acc-val mono">{a === 1n ? '1' : ellipsize(hex(a, 64), 5, 4)}</div>
                </div>
              ))}
            </div>
            <dl className="kv" style={{ marginTop: '0.6rem' }}>
              <dt>grand product closes (z(ωⁿ) = z(ω⁰) = 1)</dt>
              <dd>
                <Verdict ok={trace.grandProductClosed}>
                  {trace.grandProductClosed ? 'permutation consistent ✓' : 'no'}
                </Verdict>
              </dd>
            </dl>
          </>
        ) : (
          <div className="note">Computing the accumulator…</div>
        )}
      </Panel>

      <Panel
        title="4 · The quotient & the proof π"
        sub="The gate + permutation + boundary checks bundle into one quotient t(X) = (…) / Z_H(X); a valid witness makes the division exact. The proof is a handful of commitments and evaluations."
      >
        {proof && trace ? (
          <>
            <dl className="kv">
              <dt>t(X) = numerator / (Xⁿ − 1) divides exactly</dt>
              <dd>
                <Verdict ok={trace.quotientRemainderZero}>
                  {trace.quotientRemainderZero ? 'remainder = 0 ✓' : 'no'}
                </Verdict>
              </dd>
            </dl>
            <div className="grid cols-2" style={{ gap: '0.4rem 1.2rem', marginTop: '0.4rem' }}>
              <Wire label="[a]₁ witness a" hexs={g1hex(proof.cA)} />
              <Wire label="[b]₁ witness b" hexs={g1hex(proof.cB)} />
              <Wire label="[c]₁ witness c" hexs={g1hex(proof.cC)} />
              <Wire label="[z]₁ grand product" hexs={g1hex(proof.cZ)} />
              <Wire label="[t_lo]₁ quotient" hexs={g1hex(proof.cTlo)} />
              <Wire label="[t_hi]₁ quotient" hexs={g1hex(proof.cThi)} />
              <Wire label="W_ζ  (opening at ζ)" hexs={g1hex(proof.Wzeta)} />
              <Wire label="W_ζω (opening at ζ·ω)" hexs={g1hex(proof.Wzomega)} />
            </div>
            <dl className="kv" style={{ marginTop: '0.5rem' }}>
              <dt>ā = a(ζ)</dt>
              <dd className="mono">{ellipsize(hex(proof.aBar, 64), 8, 6)}</dd>
              <dt>z(ζ·ω)</dt>
              <dd className="mono">{ellipsize(hex(proof.zOmegaBar, 64), 8, 6)}</dd>
            </dl>
            <div className="note" style={{ marginTop: '0.4rem' }}>
              Proof size: <strong>7 group elements</strong> (a, b, c, z, t_lo/mid/hi) +{' '}
              <strong>2 openings</strong> (W_ζ, W_ζω) + 11 field evaluations — constant, whatever the
              circuit's size.
            </div>
          </>
        ) : (
          <div className="note">Building commitments…</div>
        )}
      </Panel>

      <Panel
        title="5 · Verify — the identity at one random point ζ"
        sub="The prover opens every polynomial at ζ; the verifier re-checks gate + α·perm + α²·boundary = t(ζ)·Z_H(ζ) as a scalar equation, then confirms the openings by two KZG pairings."
        right={fresh ? undefined : <span className="tag warn">computing…</span>}
      >
        <div className="btn-row" style={{ marginBottom: '0.6rem' }}>
          <button
            className={'btn' + (wrongOut ? ' violet' : ' ghost')}
            onClick={() => setWrongOut((v) => !v)}
          >
            {wrongOut ? 'claiming out+1 (lie)' : 'claim honest out'}
          </button>
          <button className={'btn' + (tamper ? ' violet' : ' ghost')} onClick={() => setTamper((v) => !v)}>
            {tamper ? 'proof tampered' : 'proof intact'}
          </button>
        </div>
        {fresh && res ? (
          <>
            <dl className="kv">
              <dt>public input claimed</dt>
              <dd className="mono">out = {claimedOut.toString()}</dd>
              <dt>gate(ζ) + PI(ζ)</dt>
              <dd className="mono">{ellipsize(hex(res.r.gateTerm, 64), 8, 6)}</dd>
              <dt>+ α·(perm₁ − perm₂)</dt>
              <dd className="mono">{ellipsize(hex(res.r.permTerm, 64), 8, 6)}</dd>
              <dt>+ α²·(z̄−1)·L₁(ζ)</dt>
              <dd className="mono">{ellipsize(hex(res.r.boundaryTerm, 64), 8, 6)}</dd>
              <dt>= LHS vs t(ζ)·Z_H(ζ)</dt>
              <dd>
                <Verdict ok={res.r.identityHolds}>
                  {res.r.identityHolds ? 'identity holds ✓' : 'identity fails ✗'}
                </Verdict>
              </dd>
              <dt>KZG opening at ζ (batched, 1 pairing)</dt>
              <dd>
                <Verdict ok={res.r.openingZeta}>{res.r.openingZeta ? 'verifies ✓' : 'fails ✗'}</Verdict>
              </dd>
              <dt>KZG opening at ζ·ω (1 pairing)</dt>
              <dd>
                <Verdict ok={res.r.openingZetaOmega}>
                  {res.r.openingZetaOmega ? 'verifies ✓' : 'fails ✗'}
                </Verdict>
              </dd>
              <dt>final verdict</dt>
              <dd>
                <Verdict ok={res.r.accepted === expectAccept}>
                  {res.r.accepted ? 'ACCEPTED' : 'REJECTED'} —{' '}
                  {res.r.accepted === expectAccept ? 'as expected ✓' : 'unexpected!'}
                </Verdict>
              </dd>
            </dl>
            <div className="note" style={{ marginTop: '0.6rem' }}>
              Flip the toggles: a dishonest public output breaks the scalar identity; a mauled
              commitment breaks the KZG opening pairing. Because ζ is drawn by Fiat–Shamir{' '}
              <em>after</em> the commitments are fixed, a false statement can only slip through with
              probability ≈ deg/r ≈ 2⁻²⁴⁰. The verifier never learns <code>x</code>.
            </div>
          </>
        ) : (
          <div className="note">Running the verifier (two pairings)…</div>
        )}
      </Panel>

      <Panel title="PLONK vs Groth16 — the same fact, two machines">
        <div style={{ overflowX: 'auto' }}>
          <table className="plonk-table">
            <thead>
              <tr>
                <th></th>
                <th>Groth16 (Lab 21)</th>
                <th>PLONK (this lab)</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td className="dim">trusted setup</td>
                <td>circuit-specific (new ceremony per circuit)</td>
                <td>
                  <strong>universal + updatable</strong> — one KZG SRS for all circuits
                </td>
              </tr>
              <tr>
                <td className="dim">arithmetization</td>
                <td>R1CS → QAP</td>
                <td>selector gates + a permutation argument</td>
              </tr>
              <tr>
                <td className="dim">proof size</td>
                <td>3 group elements (192 B)</td>
                <td>~9 group elements + evaluations</td>
              </tr>
              <tr>
                <td className="dim">verification</td>
                <td>1 pairing equation (3 pairings)</td>
                <td>a scalar identity + 2 KZG pairings</td>
              </tr>
              <tr>
                <td className="dim">commitment scheme</td>
                <td>baked into the CRS</td>
                <td>KZG (Lab 19) — swappable, this is why it's universal</td>
              </tr>
            </tbody>
          </table>
        </div>
      </Panel>
    </main>
  )
}

const GATE_MEANINGS = [
  'x · x = v1',
  'v1 · x = v2 (= x³)',
  'v2 + x = v3',
  'v3 + 5 = out',
  'out = OUT (public)',
  'padding',
  'padding',
  'padding',
]
const VAR_NAMES = ['x', 'v1 = x²', 'v2 = x³', 'v3 = x³+x', 'out']

function sel(v: bigint): string {
  const half = R >> 1n
  if (v > half) return '−' + (R - v).toString()
  return v.toString()
}

function sup(i: number): string {
  const map: Record<string, string> = { '0': '⁰', '1': '¹', '2': '²', '3': '³', '4': '⁴', '5': '⁵', '6': '⁶', '7': '⁷', '8': '⁸', '9': '⁹' }
  return i
    .toString()
    .split('')
    .map((d) => map[d])
    .join('')
}

function Wire({ label, hexs }: { label: string; hexs: string }) {
  return (
    <div className="field" style={{ margin: 0 }}>
      <span style={{ fontSize: '0.78rem' }}>{label}</span>
      <span className="hexbox violet" style={{ fontSize: '0.72rem' }}>
        {ellipsize(hexs, 12, 8)}
      </span>
    </div>
  )
}
