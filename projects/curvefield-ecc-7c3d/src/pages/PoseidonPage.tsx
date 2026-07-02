import { useEffect, useMemo, useState } from 'react'
import { PageHead, Panel, Verdict } from '../ui/components'
import { hex, ellipsize } from '../ui/format'
import {
  T_WIDTH,
  RATE,
  CAPACITY,
  R_F,
  R_P,
  ROUNDS,
  ALPHA,
  isFullRound,
  permuteTrace,
} from '../ecc/poseidon'
import {
  poseidonStarkProve,
  poseidonStarkVerify,
  digestOf,
  TRACE_LEN,
  OUT_ROW,
  DEFAULT_CONFIG,
  domainSize,
  type PoseidonStarkProof,
  type PoseidonStarkInfo,
  type PoseidonStarkVerdict,
} from '../ecc/poseidon_stark'
import { P as GOLD_P } from '../ecc/goldilocks'

const PRESETS: { label: string; pre: bigint[] }[] = [
  { label: '1·2·3·4', pre: [1n, 2n, 3n, 4n] },
  { label: 'the answer', pre: [42n, 42n, 42n, 42n] },
  { label: 'π digits', pre: [31415926n, 53589793n, 23846264n, 33832795n] },
  { label: 'near p', pre: [GOLD_P - 1n, GOLD_P - 2n, GOLD_P - 3n, GOLD_P - 4n] },
]

interface Computed {
  key: string
  digest: bigint[]
  states: bigint[][]
  proof: PoseidonStarkProof
  info: PoseidonStarkInfo
  verdict: PoseidonStarkVerdict
  forgeVerdict: PoseidonStarkVerdict
  corruptVerdict: PoseidonStarkVerdict
}

function compute(pre: bigint[]): Computed {
  const initial = new Array<bigint>(T_WIDTH).fill(0n)
  for (let i = 0; i < RATE; i++) initial[i] = pre[i]
  const states = permuteTrace(initial)
  const digest = digestOf(pre)

  const { proof, info } = poseidonStarkProve(pre, DEFAULT_CONFIG)
  const verdict = poseidonStarkVerify(digest, DEFAULT_CONFIG, proof)

  // Soundness demo 1: prove against a digest that is NOT the real hash.
  const forged = digest.slice()
  forged[0] = (forged[0] + 1n) % GOLD_P
  const forgeProof = poseidonStarkProve(pre, DEFAULT_CONFIG, { forgeDigest: forged }).proof
  const forgeVerdict = poseidonStarkVerify(forged, DEFAULT_CONFIG, forgeProof)

  // Soundness demo 2: fudge one interior round of the permutation.
  const corruptProof = poseidonStarkProve(pre, DEFAULT_CONFIG, {
    corruptRow: Math.floor(OUT_ROW / 2),
  }).proof
  const corruptVerdict = poseidonStarkVerify(digest, DEFAULT_CONFIG, corruptProof)

  return {
    key: pre.map(String).join(','),
    digest,
    states,
    proof,
    info,
    verdict,
    forgeVerdict,
    corruptVerdict,
  }
}

function parseField(s: string): bigint | null {
  const t = s.trim()
  if (!/^[0-9]+$/.test(t)) return null
  try {
    return ((BigInt(t) % GOLD_P) + GOLD_P) % GOLD_P
  } catch {
    return null
  }
}

export function PoseidonPage() {
  const [inputs, setInputs] = useState<string[]>(['1', '2', '3', '4'])
  const [data, setData] = useState<Computed | null>(null)

  const parsed = useMemo(() => inputs.map(parseField), [inputs])
  const valid = parsed.every((p) => p !== null)
  const pre = useMemo(() => (valid ? (parsed as bigint[]) : null), [valid, parsed])
  const key = pre ? pre.map(String).join(',') : 'invalid'

  useEffect(() => {
    if (!pre) return
    let alive = true
    const id = setTimeout(() => {
      const c = compute(pre)
      if (alive) setData(c)
    }, 60)
    return () => {
      alive = false
      clearTimeout(id)
    }
  }, [key, pre])

  const fresh = data !== null && data.key === key
  const cfg = DEFAULT_CONFIG
  const N = domainSize(cfg)

  const foldRows = useMemo(() => {
    if (!data) return []
    const rows: { size: number; deg: number; label: string }[] = []
    for (let i = 0; i < data.info.friLayers; i++) {
      rows.push({ size: N >> i, deg: data.info.degreeBound >> i, label: `layer ${i}` })
    }
    rows.push({ size: N >> data.info.friLayers, deg: 1, label: 'final (constant)' })
    return rows
  }, [data, N])

  return (
    <main className="page">
      <PageHead
        eyebrow="Lab 26 — an arithmetic hash, and a proof you know its preimage"
        title="Poseidon — a Hash You Can Prove"
      >
        Every other hash in this lab — SHA-256, SHA-512, RIPEMD-160 — is a <em>bit</em> function:
        rotations, xors, and 32/64-bit adds. Wonderful for a CPU, miserable for a proof, because one
        xor becomes dozens of field constraints. <strong>Poseidon</strong> is built the other way: it
        is <em>nothing but field arithmetic</em> over the Goldilocks prime{' '}
        <code>p = 2⁶⁴ − 2³² + 1</code> — add a constant, raise to the 7<sup>th</sup> power, multiply by
        an MDS matrix. So its whole computation is already a short list of low-degree polynomial
        identities, which is exactly what a <a href="#/stark">STARK</a> can prove you executed. Below,
        the hash runs live — and then a from-scratch STARK proves <em>"I know a secret preimage m with
        Poseidon(m) = d"</em> without revealing m.
      </PageHead>

      <Panel
        title="The construction"
        sub="The Hades strategy: full rounds (S-box on every lane) at each end, cheap partial rounds (S-box on lane 0 only) in the middle. Diffusion by an MDS matrix; constants nothing-up-my-sleeve from the lab's own SHA-256."
      >
        <div className="statline">
          <div className="stat"><b>{T_WIDTH}</b><span>state width t (rate {RATE} + cap {CAPACITY})</span></div>
          <div className="stat"><b>x^{ALPHA.toString()}</b><span>S-box (gcd(7, p−1)=1)</span></div>
          <div className="stat"><b>{R_F} + {R_P}</b><span>full + partial rounds</span></div>
          <div className="stat"><b>Cauchy</b><span>MDS diffusion matrix</span></div>
        </div>
        <div className="note" style={{ marginTop: '0.8rem' }}>
          The round schedule — <span style={{ color: 'var(--accent)' }}>■</span> full,{' '}
          <span className="dim">■</span> partial:
        </div>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 3, marginTop: '0.4rem' }}>
          {Array.from({ length: ROUNDS }, (_, r) => (
            <span
              key={r}
              title={`round ${r} — ${isFullRound(r) ? 'full' : 'partial'}`}
              style={{
                width: 16,
                height: 16,
                borderRadius: 3,
                background: isFullRound(r) ? 'var(--accent)' : '#2a3550',
                display: 'inline-block',
              }}
            />
          ))}
        </div>
      </Panel>

      <Panel
        title="The statement"
        sub="Pick a 4-element preimage. The hash of it is public; the STARK below proves you know it."
      >
        <div className="seg" role="group" aria-label="preset preimage" style={{ flexWrap: 'wrap' }}>
          {PRESETS.map((p) => (
            <button
              key={p.label}
              className={pre && p.pre.every((v, i) => v === pre[i]) ? 'on' : ''}
              onClick={() => setInputs(p.pre.map((v) => v.toString()))}
            >
              {p.label}
            </button>
          ))}
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: '0.6rem', marginTop: '0.8rem' }}>
          {inputs.map((v, i) => (
            <label key={i} className="field" style={{ margin: 0 }}>
              <span style={{ fontSize: '0.8rem' }}>m{sub(i)} <span className="dim">(secret)</span></span>
              <input
                value={v}
                onChange={(e) => setInputs((prev) => prev.map((x, j) => (j === i ? e.target.value : x)))}
                spellCheck={false}
                style={{ fontFamily: 'var(--mono, monospace)', width: '100%' }}
              />
            </label>
          ))}
        </div>
        {!valid && <div className="note" style={{ marginTop: '0.5rem', color: 'var(--no, #f87171)' }}>Each lane must be a non-negative integer.</div>}
        {fresh && data && (
          <dl className="kv" style={{ marginTop: '0.9rem' }}>
            <dt>public digest d = Poseidon(m)</dt>
            <dd className="mono" style={{ gridColumn: '1 / -1', wordBreak: 'break-all' }}>
              {data.digest.map((d, i) => (
                <div key={i}>
                  d{sub(i)} = {hex(d, 16)}
                </div>
              ))}
            </dd>
          </dl>
        )}
      </Panel>

      {fresh && data ? (
        <>
          <Panel
            title="The permutation, round by round"
            sub={`${ROUNDS} rounds carry the ${T_WIDTH}-lane state from the input (row 0) to the output (row ${OUT_ROW}). The STARK lays this table out as its execution trace — one row per state.`}
          >
            <div style={{ overflowX: 'auto', maxHeight: 340, overflowY: 'auto' }}>
              <table className="data" style={{ fontSize: '0.72rem' }}>
                <thead>
                  <tr>
                    <th>row</th>
                    <th>round</th>
                    {Array.from({ length: T_WIDTH }, (_, j) => (
                      <th key={j}>s{sub(j)}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {data.states.map((st, r) => (
                    <tr key={r} style={r === OUT_ROW ? { background: 'rgba(94,234,212,0.08)' } : undefined}>
                      <td className="dim">{r}</td>
                      <td className="dim" style={{ whiteSpace: 'nowrap' }}>
                        {r === 0 ? 'input' : (
                          <span style={{ color: isFullRound(r - 1) ? 'var(--accent)' : 'var(--ink-dim)' }}>
                            {isFullRound(r - 1) ? 'full' : 'partial'}
                          </span>
                        )}
                      </td>
                      {st.map((v, j) => (
                        <td key={j} className="mono">
                          {ellipsize(v.toString(), 5, 3)}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="note" style={{ marginTop: '0.6rem' }}>
              Lanes 0–{RATE - 1} of row 0 are the secret <code>m</code>; lanes {RATE}–{T_WIDTH - 1} are
              the zero capacity IV. The highlighted output row's first {RATE} lanes are the public
              digest.
            </div>
          </Panel>

          <Panel
            title="1 · Arithmetization + commitment"
            sub="Each of the 8 state lanes becomes a trace column, interpolated over the size-32 trace domain and re-evaluated on a much larger coset (the low-degree extension), then committed by one Merkle root."
          >
            <dl className="kv">
              <dt>trace domain |H|</dt>
              <dd>{TRACE_LEN} rows × {T_WIDTH} columns</dd>
              <dt>LDE domain |D|</dt>
              <dd>{data.info.domainSize} points ({cfg.blowup}× the degree bound, coset of ⟨ω⟩)</dd>
              <dt>FRI degree bound</dt>
              <dd>&lt; {data.info.degreeBound} (the x⁷ S-box pushes the composition to ≈ degree 218)</dd>
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
            sub="The Poseidon round map becomes 8 transition constraints (one per lane); the sponge IV and the public digest become boundary constraints. Round constants and the full/partial selector are public polynomials the verifier evaluates itself."
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
                  <td>transition (×{T_WIDTH})</td>
                  <td className="mono">colⱼ(g·x) − Σₖ MDS[j][k]·Yₖ(x) = 0</td>
                  <td className="dim">rows 0 … {ROUNDS - 1}</td>
                </tr>
                <tr>
                  <td>S-box (full)</td>
                  <td className="mono">Yₖ = (colₖ + rcₖ)⁷</td>
                  <td className="dim">full rounds</td>
                </tr>
                <tr>
                  <td>S-box (partial)</td>
                  <td className="mono">Y₀ = a₀⁷, Yₖ₌₁… = aₖ</td>
                  <td className="dim">partial rounds</td>
                </tr>
                <tr>
                  <td>boundary (IV)</td>
                  <td className="mono">colₖ(1) = 0, k = {RATE}…{T_WIDTH - 1}</td>
                  <td className="dim">row 0 capacity</td>
                </tr>
                <tr>
                  <td>boundary (digest)</td>
                  <td className="mono">colₖ(g³⁰) = dₖ, k = 0…{RATE - 1}</td>
                  <td className="dim">output row</td>
                </tr>
              </tbody>
            </table>
          </Panel>

          <Panel
            title="3 · DEEP — the out-of-domain query"
            sub="Sample a random point ζ outside the domain, reveal every column there (and at the shifted ζ·g), and re-check the whole round identity. Because ζ is random over a 64-bit field, an identity that holds at ζ holds as a polynomial."
          >
            <dl className="kv">
              <dt>ζ (Fiat–Shamir)</dt>
              <dd className="mono" style={{ gridColumn: '1 / -1', wordBreak: 'break-all' }}>
                {hex(data.info.zeta, 16)}
              </dd>
              {data.proof.ood.cols.map((v, i) => (
                <div key={i} style={{ display: 'contents' }}>
                  <dt>col{sub(i)}(ζ)</dt>
                  <dd className="mono">{ellipsize(v.toString(), 10, 6)}</dd>
                </div>
              ))}
            </dl>
          </Panel>

          <Panel
            title="4 · FRI — the low-degree test"
            sub="Fold the DEEP codeword in half with a fresh random challenge each round. A degree-bound claim over a size-N domain collapses to a single constant; a few random queries per round catch any cheat."
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
                {cfg.numQueries} · ≈ {cfg.numQueries * Math.log2(cfg.blowup)} bits of soundness
              </dd>
            </dl>
          </Panel>

          <Panel
            title="Verification"
            sub="The proof that you know a preimage, checked in a few hundred milliseconds — never re-running the hash, never seeing m."
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
            sub="Two cheating provers, both caught live — the reason this is a proof of knowledge and not just a claim."
          >
            <dl className="kv">
              <dt>lies about the statement (wrong digest)</dt>
              <dd>
                <Verdict ok={!data.forgeVerdict.ok}>
                  {!data.forgeVerdict.ok ? 'rejected ✓' : 'accepted (!)'}
                </Verdict>
              </dd>
              <dt>fudges one interior round</dt>
              <dd>
                <Verdict ok={!data.corruptVerdict.ok}>
                  {!data.corruptVerdict.ok ? 'rejected ✓' : 'accepted (!)'}
                </Verdict>
              </dd>
            </dl>
            <div className="note" style={{ marginTop: '0.6rem' }}>
              Claim a digest that isn't the real hash and the output-boundary constraint no longer
              vanishes; fudge a round and a transition quotient stops being a polynomial. Either way the
              composition is no longer low degree — and FRI notices:{' '}
              <em>{data.corruptVerdict.reason}</em>
            </div>
          </Panel>

          <div className="note" style={{ marginTop: '0.4rem' }}>
            This closes a loop the lab has been building toward: a STARK's only cryptographic assumption
            is a collision-resistant hash, and here it proves knowledge of a preimage of a hash — over
            the Goldilocks field <code className="mono">{GOLD_P.toString()}</code>, with a from-scratch
            NTT, Merkle commitments, DEEP sampling, and FRI, and zero dependencies. The security
            parameters (t = {T_WIDTH}, R_P = {R_P}) follow the published Goldilocks instantiations, but
            treat this as a teaching hash — the point is that it is <em>arithmetic</em>, and therefore
            provable.
          </div>
        </>
      ) : (
        <Panel title="Proving…">
          <div className="note">Running the Poseidon permutation, committing the trace, and building the FRI proof…</div>
        </Panel>
      )}
    </main>
  )
}

function sub(n: number): string {
  return String(n)
    .split('')
    .map((d) => '₀₁₂₃₄₅₆₇₈₉'[Number(d)])
    .join('')
}
