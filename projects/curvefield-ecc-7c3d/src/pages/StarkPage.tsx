import { useEffect, useMemo, useState } from 'react'
import { PageHead, Panel, Verdict } from '../ui/components'
import { hex, ellipsize } from '../ui/format'
import {
  starkProve,
  starkVerify,
  buildTrace,
  type StarkConfig,
  type StarkProof,
  type StarkInfo,
  type StarkVerdict,
} from '../ecc/stark'
import { add as gAdd, P as GOLD_P } from '../ecc/goldilocks'

const TRACE_LENS = [8, 16, 32, 64]
const BLOWUP = 8
const NUM_QUERIES = 32

interface Computed {
  key: string
  config: StarkConfig
  proof: StarkProof
  info: StarkInfo
  verdict: StarkVerdict
  forgedVerdict: StarkVerdict
  wrongOutputVerdict: StarkVerdict
  seq: bigint[]
  output: bigint
}

function compute(traceLen: number): Computed {
  const config: StarkConfig = { traceLen, blowup: BLOWUP, numQueries: NUM_QUERIES }
  const { A, B, output } = buildTrace(traceLen)
  // The underlying aₙ sequence: A holds aₙ, and B[last] = a_T (one past the end).
  const seq = [...A, B[traceLen - 1]]
  const { proof, info } = starkProve(config)
  const verdict = starkVerify(output, config, proof)
  // Soundness demos, computed live.
  const forged = starkProve(config, { corruptRow: Math.max(1, Math.floor(traceLen / 2)) }).proof
  const forgedVerdict = starkVerify(output, config, forged)
  const wrongOutputVerdict = starkVerify(gAdd(output, 1n), config, proof)
  return {
    key: String(traceLen),
    config,
    proof,
    info,
    verdict,
    forgedVerdict,
    wrongOutputVerdict,
    seq,
    output,
  }
}

export function StarkPage() {
  const [traceLen, setTraceLen] = useState(16)
  const [data, setData] = useState<Computed | null>(null)

  const key = String(traceLen)
  useEffect(() => {
    let alive = true
    const id = setTimeout(() => {
      const c = compute(traceLen)
      if (alive) setData(c)
    }, 20)
    return () => {
      alive = false
      clearTimeout(id)
    }
  }, [traceLen])

  // `data` may still hold the previous run while the new one computes off-paint.
  const fresh = data !== null && data.key === key

  const foldRows = useMemo(() => {
    if (!data) return []
    const N = data.info.domainSize
    const rows: { size: number; deg: number; label: string }[] = []
    for (let i = 0; i < data.info.friLayers; i++) {
      rows.push({ size: N >> i, deg: data.config.traceLen >> i, label: `layer ${i}` })
    }
    rows.push({ size: BLOWUP, deg: 1, label: 'final (constant)' })
    return rows
  }, [data])

  return (
    <main className="page">
      <PageHead eyebrow="Lab 25 — prove a computation with nothing but a hash" title="STARK — a Transparent, Post-Quantum Proof">
        The other three proof systems here (Groth16, PLONK, Bulletproofs) all lean on the hardness of
        an elliptic curve, and the first two on a trusted setup. A <strong>STARK</strong> leans on{' '}
        <em>nothing but a collision-resistant hash</em> — no pairing, no toxic waste, no discrete-log
        assumption. That makes it <em>transparent</em> (anyone can verify; nothing secret was ever
        generated) and plausibly <em>post-quantum</em> (Shor breaks curves, not SHA-256). Here we prove
        an actual <em>execution</em>: the Fibonacci-square recurrence run for T steps, ending at a
        public value — over the STARK-friendly Goldilocks field <code>p = 2⁶⁴ − 2³² + 1</code>, with a
        from-scratch NTT, Merkle commitments, DEEP out-of-domain sampling, and a FRI low-degree test.
      </PageHead>

      <Panel title="The statement" sub="A tiny CPU: two registers, one quadratic step, run T times.">
        <div className="seg" role="group" aria-label="trace length">
          {TRACE_LENS.map((t) => (
            <button key={t} className={traceLen === t ? 'on' : ''} onClick={() => setTraceLen(t)}>
              T = {t}
            </button>
          ))}
        </div>
        <div className="note" style={{ marginTop: '0.7rem' }}>
          <code>a₀ = 1, a₁ = 1, a_{'{n+2}'} = a_n² + a_{'{n+1}'}²</code>, computed modulo the Goldilocks
          prime. The prover claims to know a run of length T reaching the public output{' '}
          <code>a_{'{T−1}'}</code>. The trace has two columns, <code>A(row)=aₙ</code> and{' '}
          <code>B(row)=a_{'{n+1}'}</code>, so every step is a single-row transition.
        </div>
        {fresh && data && (
          <div style={{ overflowX: 'auto', marginTop: '0.7rem' }}>
            <table className="data">
              <thead>
                <tr>
                  <th>n</th>
                  {data.seq.slice(0, 12).map((_, i) => (
                    <th key={i}>a{sub(i)}</th>
                  ))}
                  {data.seq.length > 12 && <th>…</th>}
                </tr>
              </thead>
              <tbody>
                <tr>
                  <td className="dim">value</td>
                  {data.seq.slice(0, 12).map((v, i) => (
                    <td key={i} className="mono">
                      {v < 100000n ? v.toString() : ellipsize(v.toString(), 5, 3)}
                    </td>
                  ))}
                  {data.seq.length > 12 && <td className="mono">…</td>}
                </tr>
              </tbody>
            </table>
          </div>
        )}
      </Panel>

      {!fresh || !data ? (
        <Panel title="Proving…">
          <div className="note">Building the trace, committing, and running FRI…</div>
        </Panel>
      ) : (
        <>
          <Panel
            title="1 · Arithmetization + commitment"
            sub="Interpolate each column over the size-T trace domain, re-evaluate on a blowup×-larger coset (the low-degree extension), and commit the codeword by a Merkle root."
          >
            <dl className="kv">
              <dt>public output a_{'{T−1}'}</dt>
              <dd className="mono" style={{ gridColumn: '1 / -1', wordBreak: 'break-all' }}>
                {data.output.toString()} <span className="dim">= {hex(data.output, 16)}</span>
              </dd>
              <dt>trace domain |H|</dt>
              <dd>{data.config.traceLen} rows × 2 columns</dd>
              <dt>LDE domain |D|</dt>
              <dd>
                {data.info.domainSize} points ({BLOWUP}× blowup, coset of ⟨ω⟩)
              </dd>
              <dt>trace Merkle root</dt>
              <dd className="hexbox violet" style={{ gridColumn: '1 / -1' }}>
                {ellipsize('0x' + data.proof.traceRoot, 22, 12)}
              </dd>
              <dt>composition Merkle root</dt>
              <dd className="hexbox lavender" style={{ gridColumn: '1 / -1' }}>
                {ellipsize('0x' + data.proof.cpRoot, 22, 12)}
              </dd>
            </dl>
          </Panel>

          <Panel
            title="2 · Constraints → composition polynomial"
            sub="Each rule becomes a polynomial that must be divisible by the vanishing polynomial of the rows it applies to. A random linear combination is the composition polynomial CP, committed above."
          >
            <table className="plonk-table">
              <thead>
                <tr>
                  <th>constraint</th>
                  <th>algebraic form</th>
                  <th>holds on</th>
                </tr>
              </thead>
              <tbody>
                <tr>
                  <td>transition 1</td>
                  <td className="mono">A(gx) − B(x) = 0</td>
                  <td className="dim">rows 0 … T−2</td>
                </tr>
                <tr>
                  <td>transition 2</td>
                  <td className="mono">B(gx) − A(x)² − B(x)² = 0</td>
                  <td className="dim">rows 0 … T−2</td>
                </tr>
                <tr>
                  <td>boundary</td>
                  <td className="mono">A(1) = 1, B(1) = 1</td>
                  <td className="dim">first row</td>
                </tr>
                <tr>
                  <td>boundary</td>
                  <td className="mono">A(g^(T−1)) = output</td>
                  <td className="dim">last row</td>
                </tr>
              </tbody>
            </table>
          </Panel>

          <Panel
            title="3 · DEEP — the out-of-domain query"
            sub="Sample a point ζ outside the domain, reveal the trace there, and check the constraint identity. Then fold trace + CP into one DEEP polynomial whose low-degreeness binds everything together."
          >
            <dl className="kv">
              <dt>ζ (Fiat–Shamir)</dt>
              <dd className="mono" style={{ gridColumn: '1 / -1', wordBreak: 'break-all' }}>
                {hex(data.info.zeta, 16)}
              </dd>
              <dt>A(ζ)</dt>
              <dd className="mono">{ellipsize(data.proof.ood.Az.toString(), 10, 6)}</dd>
              <dt>B(ζ)</dt>
              <dd className="mono">{ellipsize(data.proof.ood.Bz.toString(), 10, 6)}</dd>
              <dt>A(ζ·g)</dt>
              <dd className="mono">{ellipsize(data.proof.ood.Agz.toString(), 10, 6)}</dd>
              <dt>B(ζ·g)</dt>
              <dd className="mono">{ellipsize(data.proof.ood.Bgz.toString(), 10, 6)}</dd>
            </dl>
            <div className="note" style={{ marginTop: '0.6rem' }}>
              The verifier recomputes CP(ζ) from these four values via the constraint identity. Because
              ζ is random over a 64-bit field, an identity that holds at ζ holds as a polynomial — so
              the trace really does satisfy every constraint.
            </div>
          </Panel>

          <Panel
            title="4 · FRI — the low-degree test"
            sub="Fold the DEEP codeword in half with a random challenge each round. A degree-<T claim over a size-N domain collapses to a single constant; a few random queries per round catch any cheat."
          >
            <div className="bars">
              {foldRows.map((r, i) => (
                <div className="bar" key={i}>
                  <span>
                    {r.label} <span className="dim">deg &lt; {r.deg}</span>
                  </span>
                  <span className="track">
                    <span
                      className="fill"
                      style={{
                        width: `${(r.size / data.info.domainSize) * 100}%`,
                        background: i === foldRows.length - 1 ? 'var(--accent)' : '#818cf8',
                      }}
                    />
                  </span>
                  <span className="mono">{r.size} pts</span>
                </div>
              ))}
            </div>
            <dl className="kv" style={{ marginTop: '0.8rem' }}>
              <dt>committed FRI layers</dt>
              <dd>{data.info.friLayers}</dd>
              <dt>final constant</dt>
              <dd className="mono">{ellipsize(data.proof.fri.finalConst.toString(), 10, 6)}</dd>
              <dt>queries</dt>
              <dd>
                {data.config.numQueries} · ≈ {data.config.numQueries * Math.log2(BLOWUP)} bits of
                soundness
              </dd>
            </dl>
          </Panel>

          <Panel
            title="Verification"
            sub="The whole proof, checked in milliseconds — far less work than re-running the computation."
            right={<Verdict ok={data.verdict.ok}>{data.verdict.ok ? 'accepted ✓' : 'rejected'}</Verdict>}
          >
            <dl className="kv">
              <dt>FRI low-degree</dt>
              <dd>
                <Verdict ok={data.verdict.friOk}>{data.verdict.friOk ? 'DEEP is low degree ✓' : 'failed'}</Verdict>
              </dd>
              <dt>Merkle openings</dt>
              <dd>
                <Verdict ok={data.verdict.merkleOk}>{data.verdict.merkleOk ? 'all paths valid ✓' : 'failed'}</Verdict>
              </dd>
              <dt>DEEP consistency</dt>
              <dd>
                <Verdict ok={data.verdict.deepConsistent}>
                  {data.verdict.deepConsistent ? 'trace + CP reproduce FRI ✓' : 'failed'}
                </Verdict>
              </dd>
            </dl>
            <div className="statline" style={{ marginTop: '1rem' }}>
              <div className="stat">
                <b>{(data.info.proofBytes / 1024).toFixed(1)} KB</b>
                <span>proof size</span>
              </div>
              <div className="stat">
                <b>{data.info.proofFieldElements.toLocaleString()}</b>
                <span>field elements</span>
              </div>
              <div className="stat">
                <b>0</b>
                <span>trusted setup</span>
              </div>
              <div className="stat">
                <b>SHA-256</b>
                <span>only assumption</span>
              </div>
            </div>
          </Panel>

          <Panel
            title="Soundness, demonstrated"
            sub="Two cheating provers, both caught live — the reason a STARK is a proof and not just a checksum."
          >
            <dl className="kv">
              <dt>claims a false output (a_{'{T−1}'} + 1)</dt>
              <dd>
                <Verdict ok={!data.wrongOutputVerdict.ok}>
                  {!data.wrongOutputVerdict.ok ? 'rejected ✓' : 'accepted (!)'}
                </Verdict>
              </dd>
              <dt>fudges one interior step</dt>
              <dd>
                <Verdict ok={!data.forgedVerdict.ok}>
                  {!data.forgedVerdict.ok ? 'rejected ✓' : 'accepted (!)'}
                </Verdict>
              </dd>
            </dl>
            <div className="note" style={{ marginTop: '0.6rem' }}>
              A forged step makes a constraint quotient stop being a polynomial, so the composition is
              no longer low degree — and FRI notices: <em>{data.forgedVerdict.reason}</em>
            </div>
          </Panel>

          <div className="note" style={{ marginTop: '0.4rem' }}>
            Everything above — the Goldilocks field, the NTT, the Merkle trees, the Fiat–Shamir
            transcript, DEEP and FRI — is computed here in your browser with zero dependencies. The
            field modulus is <code className="mono">{GOLD_P.toString()}</code>.
          </div>
        </>
      )}
    </main>
  )
}

// Unicode subscript digits for a₀, a₁, …
function sub(n: number): string {
  return String(n)
    .split('')
    .map((d) => '₀₁₂₃₄₅₆₇₈₉'[Number(d)])
    .join('')
}
