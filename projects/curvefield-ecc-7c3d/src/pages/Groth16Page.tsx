import { useEffect, useMemo, useState } from 'react'
import { PageHead, Panel, Verdict } from '../ui/components'
import * as g16 from '../ecc/groth16'
import { compressG1, compressG2 } from '../ecc/blsenc'
import { R } from '../ecc/bls12381'
import { fmtPoly } from '../ecc/polynomial'
import { hex, ellipsize } from '../ui/format'

const SETUP_SEED = 0x15c0ffee_ce12_2024n
const PROOF_SEED = 0x9f3c2a1b77e4d5c6n

const sys = g16.cubeCircuit()
const qap = g16.r1csToQap(sys)

export function Groth16Page() {
  const [x, setX] = useState(3)
  const [wrongOut, setWrongOut] = useState(false)
  const [tamper, setTamper] = useState(false)

  const { witness, out } = useMemo(() => g16.cubeWitness(BigInt(x)), [x])
  const satisfied = useMemo(() => g16.r1csSatisfied(sys, witness), [witness])
  const qw = useMemo(() => g16.qapWitnessPolys(qap, witness), [witness])

  // Setup is fixed (one ceremony); the proof depends on the witness.
  const setup = useMemo(() => g16.setup(sys, SETUP_SEED), [])
  const proof = useMemo(() => g16.prove(setup, sys, witness, PROOF_SEED), [setup, witness])

  const claimedOut = useMemo(() => (wrongOut ? (out + 1n) % R : out), [wrongOut, out])
  const provedProof = useMemo(
    () => (tamper ? { ...proof, C: setup.pk.alpha1 } : proof),
    [tamper, proof, setup],
  )

  // The verification pairing equation runs off the paint.
  const key = `${x}|${wrongOut}|${tamper}`
  const [res, setRes] = useState<{ key: string; ok: boolean } | null>(null)
  useEffect(() => {
    let alive = true
    const id = setTimeout(() => {
      const ok = g16.verify(setup.vk, [1n, claimedOut], provedProof)
      if (alive) setRes({ key, ok })
    }, 30)
    return () => {
      alive = false
      clearTimeout(id)
    }
  }, [setup, claimedOut, provedProof, key])
  const fresh = res !== null && res.key === key
  const expectAccept = !wrongOut && !tamper

  const varNames = sys.vars

  return (
    <main className="page">
      <PageHead eyebrow="Lab 21 — prove knowledge of a secret in 3 group elements" title="Groth16 zk-SNARK">
        A zk-SNARK lets a prover convince a verifier it knows a secret satisfying a computation, while
        revealing <em>nothing</em> but the public result — and Groth16 makes the proof just three group
        elements, checked by a single pairing equation regardless of circuit size. Here we prove
        knowledge of a secret <code>x</code> with <code>x³ + x + 5 = out</code>: the circuit is flattened
        to an R1CS, interpolated into a QAP, run through a (transparent) trusted setup, and proven and
        verified — all on this lab's own from-scratch BLS12-381 pairing.
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
      </Panel>

      <Panel
        title="1 · R1CS — the flattened circuit"
        sub="Each gate is a rank-1 constraint (A·s)·(B·s) = (C·s) over the variable vector s."
      >
        <div className="mono" style={{ fontSize: '0.8rem', lineHeight: 1.7 }}>
          <div className="note" style={{ marginBottom: '0.4rem' }}>
            s = [{varNames.join(', ')}] &nbsp;→&nbsp; witness = [{witness.map((w) => w.toString()).join(', ')}]
          </div>
          {['x·x = sym1', 'sym1·x = y', '(y + x)·1 = sym2', '(sym2 + 5)·1 = out'].map((c, i) => (
            <div key={i}>
              c{i + 1}: &nbsp;{c}
            </div>
          ))}
        </div>
        <dl className="kv" style={{ marginTop: '0.5rem' }}>
          <dt>witness satisfies all {sys.a.length} constraints</dt>
          <dd><Verdict ok={satisfied}>{satisfied ? 'satisfied ✓' : 'no'}</Verdict></dd>
        </dl>
      </Panel>

      <Panel
        title="2 · QAP — constraints become polynomials"
        sub="Interpolating the columns at x = 1..n turns the system into A(x)·B(x) − C(x) = h(x)·t(x)."
      >
        <dl className="kv">
          <dt>target t(x) = ∏(x − j)</dt>
          <dd className="mono" style={{ gridColumn: '1 / -1', wordBreak: 'break-all' }}>{fmtPoly(qap.t, R)}</dd>
          <dt>quotient h(x) = (A·B − C)/t</dt>
          <dd className="mono" style={{ gridColumn: '1 / -1', wordBreak: 'break-all' }}>
            {ellipsize(fmtPoly(qw.h, R), 60, 12)}
          </dd>
          <dt>divisibility (remainder = 0)</dt>
          <dd><Verdict ok={qw.remainderZero}>{qw.remainderZero ? 'A·B − C is divisible by t ✓' : 'no'}</Verdict></dd>
        </dl>
      </Panel>

      <Panel
        title="3 · Trusted setup"
        sub="Sampling τ, α, β, γ, δ produces the proving & verifying keys. A real ceremony destroys this 'toxic waste'."
        right={<span className="tag warn">toxic waste shown for the demo</span>}
      >
        <dl className="kv">
          <dt>τ</dt><dd className="mono">{ellipsize(hex(setup.toxic.tau, 64), 10, 6)}</dd>
          <dt>α, β</dt><dd className="mono">{ellipsize(hex(setup.toxic.alpha, 64), 8, 4)}, {ellipsize(hex(setup.toxic.beta, 64), 8, 4)}</dd>
          <dt>γ, δ</dt><dd className="mono">{ellipsize(hex(setup.toxic.gamma, 64), 8, 4)}, {ellipsize(hex(setup.toxic.delta, 64), 8, 4)}</dd>
          <dt>verifying key</dt>
          <dd>{setup.vk.ic.length} IC points (one per public input) + α₁, β₂, γ₂, δ₂</dd>
        </dl>
      </Panel>

      <Panel
        title="4 · The proof π = (A, B, C)"
        sub="Three group elements — 192 bytes — no matter how big the circuit. Compressed wire bytes below."
      >
        <dl className="kv">
          <dt>A (𝔾₁)</dt><dd className="hexbox violet" style={{ gridColumn: '1 / -1' }}>{ellipsize(compressG1Hex(proof.A), 40, 10)}</dd>
          <dt>B (𝔾₂)</dt><dd className="hexbox lavender" style={{ gridColumn: '1 / -1' }}>{ellipsize(compressG2Hex(proof.B), 40, 10)}</dd>
          <dt>C (𝔾₁)</dt><dd className="hexbox violet" style={{ gridColumn: '1 / -1' }}>{ellipsize(compressG1Hex(proof.C), 40, 10)}</dd>
        </dl>
      </Panel>

      <Panel
        title="5 · Verify — one pairing equation"
        sub="e(A,B) = e(α₁,β₂) · e(Σ aᵢ·ICᵢ, γ₂) · e(C, δ₂). The verifier never learns x."
        right={fresh ? undefined : <span className="tag warn">computing…</span>}
      >
        <div className="btn-row" style={{ marginBottom: '0.6rem' }}>
          <button className={'btn' + (wrongOut ? ' violet' : ' ghost')} onClick={() => setWrongOut((v) => !v)}>
            {wrongOut ? 'claiming out+1 (lie)' : 'claim honest out'}
          </button>
          <button className={'btn' + (tamper ? ' violet' : ' ghost')} onClick={() => setTamper((v) => !v)}>
            {tamper ? 'proof tampered' : 'proof intact'}
          </button>
        </div>
        {fresh && res ? (
          <dl className="kv">
            <dt>public input claimed</dt>
            <dd className="mono">out = {claimedOut.toString()}</dd>
            <dt>pairing equation holds</dt>
            <dd><Verdict ok={res.ok === expectAccept}>{res.ok ? 'accepts ✓' : 'rejects ✗'}</Verdict></dd>
            <dt>this is the {expectAccept ? 'expected accept' : 'expected reject'}</dt>
            <dd>
              <Verdict ok={res.ok === expectAccept}>
                {res.ok === expectAccept ? 'soundness/completeness holds ✓' : 'unexpected!'}
              </Verdict>
            </dd>
          </dl>
        ) : (
          <div className="note">Running the pairing check…</div>
        )}
        <div className="note" style={{ marginTop: '0.6rem' }}>
          Flip the toggles: a dishonest public output or a mauled proof element breaks the single
          pairing equation, while the honest proof always passes — and in every case the verifier sees
          only <code>out</code>, never the secret <code>x</code>.
        </div>
      </Panel>
    </main>
  )
}

function compressG1Hex(P: g16.Proof['A']): string {
  return toHex(compressG1(P))
}
function compressG2Hex(P: g16.Proof['B']): string {
  return toHex(compressG2(P))
}
function toHex(b: Uint8Array): string {
  let s = ''
  for (const x of b) s += x.toString(16).padStart(2, '0')
  return s
}
