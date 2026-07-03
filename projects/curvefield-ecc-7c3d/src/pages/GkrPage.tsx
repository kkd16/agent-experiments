import { useMemo, useState } from 'react'
import { PageHead, Panel, Verdict, Slider } from '../ui/components'
import { P, fp, add } from '../ecc/goldilocks'
import { Transcript } from '../ecc/transcript'
import {
  productClaim,
  productOracle,
  sumcheckProve,
  sumcheckVerify,
} from '../ecc/sumcheck'
import { exampleCircuit, evaluate, gkrProve, gkrVerify, type Gate } from '../ecc/gkr'
import {
  matmulProve,
  matmulVerify,
  countTriangles,
  trianglesProve,
  trianglesVerify,
} from '../ecc/sumcheck_apps'

// Compact field-element rendering: small values as decimals, big ones as short hex.
function fF(x: bigint): string {
  const v = ((x % P) + P) % P
  if (v < 1_000_000n) return v.toString()
  return '0x' + v.toString(16).padStart(16, '0').slice(0, 10) + '…'
}

// A deterministic 64-bit LCG so every render (and the thumbnail) is reproducible —
// no Math.random, which the sandboxed catalog preview would make non-deterministic.
function lcg(seed: bigint) {
  let s = seed & ((1n << 64n) - 1n)
  return () => {
    s = (s * 6364136223846793005n + 1442695040888963407n) & ((1n << 64n) - 1n)
    return s % P
  }
}

function randomTables(seed: bigint, numVars: number, factors: number): bigint[][] {
  const rng = lcg(seed)
  const n = 1 << numVars
  return Array.from({ length: factors }, () => Array.from({ length: n }, () => rng()))
}

export function GkrPage() {
  // ── Sum-check playground ──
  const [numVars, setNumVars] = useState(3)
  const [factors, setFactors] = useState(2)
  const [seed, setSeed] = useState(7)
  const [cheat, setCheat] = useState(false)

  const sc = useMemo(() => {
    const tables = randomTables(BigInt(seed) * 2654435761n + 1n, numVars, factors)
    const claim = productClaim(tables, numVars)
    const proof = sumcheckProve(claim, new Transcript('lab/sumcheck'))
    const shownSum = cheat ? fp(proof.claimedSum + 1n) : proof.claimedSum
    const verdict = sumcheckVerify(
      numVars,
      factors,
      shownSum,
      proof.rounds,
      productOracle(tables),
      new Transcript('lab/sumcheck'),
    )
    return { tables, proof, verdict, shownSum }
  }, [numVars, factors, seed, cheat])

  // ── Verified matrix multiplication ──
  const [matSeed, setMatSeed] = useState(3)
  const [matTamper, setMatTamper] = useState(false)

  const mm = useMemo(() => {
    const rng = lcg(BigInt(matSeed) * 40503n + 17n)
    const gen = () => rng() % 10n
    const A = Array.from({ length: 16 }, gen)
    const B = Array.from({ length: 16 }, gen)
    const proof = matmulProve(A, B, 4)
    const C = proof.C
    const shownC = matTamper ? C.map((v, i) => (i === 5 ? fp(v + 1n) : v)) : C
    const verdict = matmulVerify(A, B, shownC, 4, proof)
    return { A, B, C, shownC, proof, verdict }
  }, [matSeed, matTamper])

  // ── Triangle counting ──
  const triPairs: [number, number][] = [
    [0, 1],
    [0, 2],
    [0, 3],
    [1, 2],
    [1, 3],
    [2, 3],
  ]
  const [edges, setEdges] = useState<boolean[]>([true, true, false, true, false, true])
  const [triTamper, setTriTamper] = useState(false)

  const tri = useMemo(() => {
    const N = 4
    const adj = new Array(N * N).fill(0)
    edges.forEach((on, i) => {
      if (on) {
        const [a, b] = triPairs[i]
        adj[a * N + b] = 1
        adj[b * N + a] = 1
      }
    })
    const count = countTriangles(adj, N)
    const proof = trianglesProve(adj, N)
    const claimed = triTamper ? count + 1 : count
    const verdict = trianglesVerify(adj, N, claimed, proof)
    return { adj, count, proof, claimed, verdict }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [edges, triTamper])

  // ── GKR circuit ──
  const [inputs, setInputs] = useState<number[]>([2, 3, 4, 5, 6, 7, 8, 9])
  const [tamper, setTamper] = useState(false)

  const gkr = useMemo(() => {
    const circuit = exampleCircuit(inputs.map((v) => BigInt(v)))
    const values = evaluate(circuit)
    const proof = gkrProve(circuit)
    const shownOutput = tamper
      ? proof.output.map((v, i) => (i === 0 ? fp(v + 1n) : v))
      : proof.output
    const verdict = gkrVerify(circuit, shownOutput, proof)
    return { circuit, values, proof, verdict, shownOutput }
  }, [inputs, tamper])

  const setInput = (i: number, v: string) =>
    setInputs((xs) => xs.map((x, j) => (j === i ? (Number(v) || 0) : x)))

  const layerNames = ['output', 'layer 1', 'input']

  return (
    <main className="page">
      <PageHead eyebrow="Lab 34 — the sum-check protocol & doubly-efficient proofs" title="GKR — Verify a Whole Circuit Without Re-Running It">
        The <strong>sum-check protocol</strong> lets a verifier learn{' '}
        <code>H = Σ_&#123;x∈&#123;0,1&#125;ⁿ&#125; g(x)</code> — a sum over an <em>exponential</em>{' '}
        hypercube — while touching <code>g</code> at a single random point. Stack it layer by layer
        over a circuit and you get <strong>GKR</strong>: a prover convinces a verifier that a claimed
        output is correct, and the verifier <em>never executes a gate</em>. This is the interactive-proof
        machinery under Spartan, HyperPlonk and Jolt — running here on the lab's own Goldilocks field
        with a Fiat–Shamir transcript, exact BigInt throughout.
      </PageHead>

      <Panel
        title="1 · The sum-check protocol"
        sub="Prove the sum over the boolean hypercube of a product of random multilinear polynomials. Each round the prover sends one univariate; the verifier checks s(0)+s(1) equals the running claim and folds in a random challenge."
      >
        <div className="grid cols-2" style={{ gap: '1rem' }}>
          <Slider label="variables n (hypercube size 2ⁿ)" value={numVars} min={1} max={8} onChange={setNumVars} display={`${numVars}  (2^${numVars} = ${1 << numVars} terms)`} />
          <Slider label="product factors k (round-poly degree)" value={factors} min={1} max={4} onChange={setFactors} display={`${factors}`} />
        </div>
        <div className="grid cols-2" style={{ gap: '1rem', marginTop: '0.4rem' }}>
          <Slider label="random seed" value={seed} min={1} max={64} onChange={setSeed} />
          <label className="field" style={{ justifyContent: 'flex-end' }}>
            <span style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
              <input type="checkbox" checked={cheat} onChange={(e) => setCheat(e.target.checked)} style={{ width: 'auto' }} />
              lying prover: claim H + 1
            </span>
          </label>
        </div>

        <dl className="kv" style={{ marginTop: '0.8rem' }}>
          <dt>claimed sum H</dt>
          <dd className="mono">
            {fF(sc.shownSum)} {cheat && <span className="tag warn">forged</span>}
          </dd>
          <dt>honest Σ over 2ⁿ points</dt>
          <dd className="mono">{fF(sc.proof.claimedSum)}</dd>
          <dt>verifier verdict</dt>
          <dd>
            <Verdict ok={sc.verdict.ok}>
              {sc.verdict.ok
                ? `accepted — 1 oracle call, ${numVars} rounds`
                : `rejected at round ${sc.verdict.failedRound + 1}`}
            </Verdict>
          </dd>
        </dl>

        <div style={{ overflowX: 'auto', marginTop: '0.6rem' }}>
          <table className="data">
            <thead>
              <tr>
                <th>round</th>
                <th>univariate sⱼ(X) at X = 0…{factors}</th>
                <th>s(0)+s(1)</th>
                <th>challenge rⱼ</th>
              </tr>
            </thead>
            <tbody>
              {sc.proof.rounds.map((rd, i) => (
                <tr key={i}>
                  <td className="mono">{i + 1}</td>
                  <td className="mono">[{rd.evals.map(fF).join(', ')}]</td>
                  <td className="mono">{fF(add(rd.evals[0], rd.evals[1]))}</td>
                  <td className="mono">{fF(rd.challenge)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="note" style={{ marginTop: '0.6rem' }}>
          The verifier does <strong>{numVars}</strong> round-checks plus one evaluation of the product's
          multilinear extensions at the random point <code>r</code> — versus the{' '}
          <strong>{1 << numVars}</strong> additions an honest re-summation would need. Corrupt the claim
          and the transcript's very first identity <code>s₁(0)+s₁(1)=H</code> breaks: soundness gives the
          prover only a <code>{'≈'} n·k / |𝔽|</code> chance of ever getting caught out.
        </div>
      </Panel>

      <Panel
        title="2 · Application — verified matrix multiplication"
        sub="To check C = A·B the verifier picks random r,s and confirms C̃(r,s) = Σ_x Ã(r,x)·B̃(x,s) by one sum-check — never recomputing the O(n³) product. (Thaler, Proofs Args & ZK §4.4.)"
        right={
          <label style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', fontSize: '0.8rem' }}>
            <input type="checkbox" checked={matTamper} onChange={(e) => setMatTamper(e.target.checked)} style={{ width: 'auto' }} />
            forge C[1,1]
          </label>
        }
      >
        <Slider label="matrix seed (regenerate A, B)" value={matSeed} min={1} max={40} onChange={setMatSeed} />
        <div className="grid cols-2" style={{ gap: '1rem', marginTop: '0.6rem' }}>
          <div>
            <div className="sub">A</div>
            <MatrixView m={mm.A} />
          </div>
          <div>
            <div className="sub">B</div>
            <MatrixView m={mm.B} />
          </div>
        </div>
        <div className="sub" style={{ marginTop: '0.8rem' }}>
          C = A·B {matTamper && <span className="tag warn">C[1,1] forged</span>}
        </div>
        <MatrixView m={mm.shownC} />
        <dl className="kv" style={{ marginTop: '0.6rem' }}>
          <dt>C̃(r,s) claimed by the verifier</dt>
          <dd className="mono">{fF(mm.verdict.claimEval)}</dd>
          <dt>sum-check verdict</dt>
          <dd><Verdict ok={mm.verdict.ok}>{mm.verdict.reason}</Verdict></dd>
        </dl>
        <div className="note" style={{ marginTop: '0.6rem' }}>
          The prover runs the honest <strong>{4 * 4 * 4} multiplications</strong>; the verifier does one
          2-round sum-check plus two boundary-MLE evaluations. Forge any product entry and the
          transcript-derived <code>(r,s)</code> shift, so the proof no longer matches.
        </div>
      </Panel>

      <Panel
        title="3 · Application — counting triangles with sum-check"
        sub="The number of triangles is (1/6)·Σ_{x,y,z} Ã(x,y)·Ã(y,z)·Ã(z,x). Sum-check proves that sum over all vertex triples while the verifier evaluates the adjacency MLE at just three points."
        right={
          <label style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', fontSize: '0.8rem' }}>
            <input type="checkbox" checked={triTamper} onChange={(e) => setTriTamper(e.target.checked)} style={{ width: 'auto' }} />
            over-claim count
          </label>
        }
      >
        <div className="sub">Toggle edges of a 4-vertex graph:</div>
        <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap', marginTop: '0.4rem' }}>
          {triPairs.map(([a, b], i) => (
            <label key={i} style={{ display: 'flex', alignItems: 'center', gap: '0.3rem', fontSize: '0.85rem', border: '1px solid var(--line)', borderRadius: '0.4rem', padding: '0.25rem 0.5rem' }}>
              <input
                type="checkbox"
                checked={edges[i]}
                onChange={(e) => setEdges((xs) => xs.map((x, j) => (j === i ? e.target.checked : x)))}
                style={{ width: 'auto' }}
              />
              {a}–{b}
            </label>
          ))}
        </div>
        <dl className="kv" style={{ marginTop: '0.8rem' }}>
          <dt>triangles in the graph</dt>
          <dd className="mono">{tri.count}</dd>
          <dt>claimed count</dt>
          <dd className="mono">{tri.claimed} {triTamper && <span className="tag warn">inflated</span>}</dd>
          <dt>Σ over 4³ triples (= 6·count)</dt>
          <dd className="mono">{fF(tri.proof.sum)}</dd>
          <dt>sum-check verdict</dt>
          <dd><Verdict ok={tri.verdict.ok}>{tri.verdict.reason}</Verdict></dd>
        </dl>
      </Panel>

      <Panel
        title="4 · GKR — a two-layer arithmetic circuit"
        sub="Eight editable inputs feed eight mixed add/mul gates, then four output gates. Edit any input and the whole proof recomputes live."
      >
        <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
          {inputs.map((c, i) => (
            <label key={i} className="field" style={{ width: '4.4rem' }}>
              <span style={{ fontSize: '0.72rem' }}>i{i}</span>
              <input type="number" value={c} onChange={(e) => setInput(i, e.target.value)} style={{ width: '100%' }} />
            </label>
          ))}
        </div>

        <div style={{ overflowX: 'auto', marginTop: '0.8rem' }}>
          <table className="data">
            <tbody>
              {gkr.values.map((layer, li) => (
                <tr key={li}>
                  <td className="mono" style={{ color: 'var(--ink-dim)' }}>{layerNames[li]}</td>
                  {layer.map((v, wi) => (
                    <td key={wi} className="mono">{fF(v)}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <WiringLegend gates={gkr.circuit.gateLayers} />
      </Panel>

      <Panel
        title="5 · Prove it — the verifier never runs a gate"
        sub="The prover reduces the output claim to the input, one sum-check per layer, fused by a line-restriction polynomial. The verifier replays the transcript and checks the algebra."
        right={
          <label style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', fontSize: '0.8rem' }}>
            <input type="checkbox" checked={tamper} onChange={(e) => setTamper(e.target.checked)} style={{ width: 'auto' }} />
            forge output[0]
          </label>
        }
      >
        <dl className="kv">
          <dt>claimed output</dt>
          <dd className="mono">
            [{gkr.shownOutput.map(fF).join(', ')}] {tamper && <span className="tag warn">forged</span>}
          </dd>
          <dt>GKR verdict</dt>
          <dd><Verdict ok={gkr.verdict.ok}>{gkr.verdict.reason}</Verdict></dd>
        </dl>

        <div className="statline" style={{ marginTop: '0.8rem' }}>
          <div className="stat"><b>{gkr.proof.gateOps}</b><span>gate ops — prover</span></div>
          <div className="stat"><b>0</b><span>gate ops — verifier</span></div>
          <div className="stat"><b>{gkr.verdict.checks}</b><span>algebraic checks — verifier</span></div>
          <div className="stat"><b>{gkr.verdict.proofElements}</b><span>field elements in proof</span></div>
        </div>
        <div className="note" style={{ marginTop: '0.6rem' }}>
          The verifier reconstructs the wiring predicates <code>add̃ᵢ</code>/<code>mul̃ᵢ</code> from the
          circuit's sparse gate list and evaluates only the <em>public input's</em> multilinear
          extension at the end — it re-executes exactly <strong>zero</strong> of the prover's{' '}
          {gkr.proof.gateOps} multiplications and additions. Forge a single output wire and the
          Fiat–Shamir challenges diverge, so the first layer's sum-check identity fails immediately.
        </div>
      </Panel>

      <Panel title="Why it matters" sub="From a 1985 idea to production zk">
        <div className="note">
          Sum-check turns any statement of the form "this exponential sum equals H" into a{' '}
          <code>{'O(n·deg)'}</code> conversation. GKR layers it into a proof that a circuit ran
          correctly with a verifier exponentially cheaper than the computation. Modern SNARKs —
          Spartan, HyperPlonk, Lasso/Jolt — are, at their core, sum-check over cleverly chosen
          multilinear polynomials. This lab implements the real protocol: multilinear extensions,
          the GKR wiring identity, the two-claim line reduction, and a Fiat–Shamir transcript, all in
          exact field arithmetic. Cross-checked live on the <a href="#/verify">Self-Test</a> page.
        </div>
      </Panel>
    </main>
  )
}

function MatrixView({ m }: { m: bigint[] }) {
  const n = Math.round(Math.sqrt(m.length))
  return (
    <div style={{ overflowX: 'auto' }}>
      <table className="data" style={{ width: 'auto' }}>
        <tbody>
          {Array.from({ length: n }, (_, i) => (
            <tr key={i}>
              {Array.from({ length: n }, (_, j) => (
                <td key={j} className="mono" style={{ textAlign: 'right' }}>{fF(m[i * n + j])}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function WiringLegend({ gates }: { gates: Gate[][] }) {
  const [output, layer1] = gates
  const fmt = (g: Gate, below: string) => `${g.op === 'add' ? '+' : '×'}(${below}${g.l},${below}${g.r})`
  return (
    <div className="note" style={{ marginTop: '0.6rem' }}>
      <strong>wiring:</strong>{' '}
      output = [{output.map((g) => fmt(g, 'w')).join(', ')}] over layer-1 wires w0…w7; layer 1 = [
      {layer1.map((g) => fmt(g, 'i')).join(', ')}] over inputs i0…i7.
    </div>
  )
}
