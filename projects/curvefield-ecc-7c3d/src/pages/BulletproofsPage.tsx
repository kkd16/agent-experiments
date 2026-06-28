import { useMemo, useState } from 'react'
import { PageHead, Panel, Verdict } from '../ui/components'
import {
  proveRange,
  verifyRange,
  proofSize,
  buildConfidentialTx,
  verifyConfidentialTx,
  type RangeProof,
} from '../ecc/bulletproofs'
import { secp256k1, N, G } from '../ecc/secp256k1'
import { seedRng, randomScalar } from '../ecc/rng'
import { hex } from '../ui/format'

// Byte accounting: a compressed point is 33 bytes, a scalar 32.
const POINT_BYTES = 33
const SCALAR_BYTES = 32

/** Size of the linear, one-OR-proof-per-bit construction in `sigma.ts`: each bit
 *  carries a commitment + two announcement points (3 points) and four scalars,
 *  plus one value commitment per aggregated value. */
function linearSize(n: number, m: number) {
  const points = n * m * 3 + m
  const scalars = n * m * 4
  return { points, scalars, bytes: points * POINT_BYTES + scalars * SCALAR_BYTES }
}

function bulletproofBytes(n: number, m: number) {
  const { points, scalars } = proofSize(n, m)
  // proofSize counts the m value commitments as a base "+? "—V is reported separately.
  const totalPoints = points + m // + the m value commitments
  return { points: totalPoints, scalars, bytes: totalPoints * POINT_BYTES + scalars * SCALAR_BYTES }
}

function Seg<T extends string | number>({
  value,
  options,
  onChange,
}: {
  value: T
  options: { label: string; value: T }[]
  onChange: (v: T) => void
}) {
  return (
    <div className="seg">
      {options.map((o) => (
        <button key={String(o.value)} className={o.value === value ? 'on' : ''} onClick={() => onChange(o.value)}>
          {o.label}
        </button>
      ))}
    </div>
  )
}

export function BulletproofsPage() {
  const [seed, setSeed] = useState(1)

  return (
    <main className="page">
      <PageHead eyebrow="Lab 22 — short proofs, big numbers" title="Bulletproofs — logarithmic range proofs">
        The range proof on the Σ-protocols page is honest but <em>linear</em>: one OR-proof per bit,
        so a 64-bit amount costs hundreds of group elements. <strong>Bulletproofs</strong> prove the
        very same statement — "this committed value is in <code>[0, 2ⁿ)</code>" — in only{' '}
        <code>2·⌈log₂(n·m)⌉ + O(1)</code> elements, by recasting the bit constraints as a single
        inner-product relation and compressing it with a <em>folding</em> argument that halves the
        witness each round. Everything below is computed live on secp256k1 with zero crypto
        dependencies; nothing is mocked.
      </PageHead>

      <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: '0.8rem' }}>
        <button className="btn" onClick={() => setSeed((s) => s + 1)}>↻ new randomness</button>
      </div>

      <SizeComparison />
      <RangeProofLab seed={seed} />
      <FoldingView seed={seed} />
      <ConfidentialTxLab seed={seed} />
    </main>
  )
}

// ── headline: proof size, log vs linear ──────────────────────────────────────
function SizeComparison() {
  const [n, setN] = useState<number>(64)
  const [m, setM] = useState<number>(1)
  const lin = linearSize(n, m)
  const bp = bulletproofBytes(n, m)
  const max = Math.max(lin.bytes, bp.bytes)
  const shrink = (lin.bytes / bp.bytes).toFixed(1)

  return (
    <Panel
      title="Proof size — O(log) vs O(n)"
      sub="The whole point of Bulletproofs. Pick a bit width and a number of aggregated values; watch the linear proof explode while the Bulletproof barely moves."
    >
      <div className="btn-row" style={{ gap: '1.2rem', marginBottom: '1rem' }}>
        <label style={{ display: 'flex', flexDirection: 'column', gap: 6, fontSize: '0.82rem', color: 'var(--ink-faint)' }}>
          bit width n
          <Seg value={n} onChange={setN} options={[16, 32, 64].map((v) => ({ label: String(v), value: v }))} />
        </label>
        <label style={{ display: 'flex', flexDirection: 'column', gap: 6, fontSize: '0.82rem', color: 'var(--ink-faint)' }}>
          aggregated values m
          <Seg value={m} onChange={setM} options={[1, 2, 4, 8].map((v) => ({ label: `×${v}`, value: v }))} />
        </label>
      </div>

      <div className="bars">
        <div className="bar">
          <span>Linear (Σ-protocol)</span>
          <div className="track">
            <div className="fill" style={{ width: `${(lin.bytes / max) * 100}%`, background: 'linear-gradient(90deg,#f0709a,#e0567a)' }} />
          </div>
          <span className="mono">{lin.bytes.toLocaleString()} B</span>
        </div>
        <div className="bar">
          <span>Bulletproof</span>
          <div className="track">
            <div className="fill" style={{ width: `${(bp.bytes / max) * 100}%`, background: 'linear-gradient(90deg,#5eead4,#a78bfa)' }} />
          </div>
          <span className="mono">{bp.bytes.toLocaleString()} B</span>
        </div>
      </div>

      <div className="statline" style={{ marginTop: '1.1rem' }}>
        <div className="stat">
          <b>{shrink}×</b>
          <span>smaller</span>
        </div>
        <div className="stat">
          <b>{bp.points}+{bp.scalars}</b>
          <span>points + scalars</span>
        </div>
        <div className="stat">
          <b>{lin.points + lin.scalars}</b>
          <span>elements, linear</span>
        </div>
        <div className="stat">
          <b>{Math.log2(n * m)}</b>
          <span>folding rounds</span>
        </div>
      </div>
      <div className="note" style={{ marginTop: '0.7rem' }}>
        A Bulletproof grows by exactly two points whenever you double the number of bits; the linear
        proof grows by hundreds. Aggregating <code>m</code> values shares one inner-product argument,
        so a confidential transaction with several outputs is barely larger than one with a single
        output.
      </div>
    </Panel>
  )
}

// ── interactive range proof ───────────────────────────────────────────────────
function useRangeProof(value: bigint, bits: number, seed: number) {
  return useMemo(() => {
    seedRng(seed * 977 + bits + Number(value % 100000n))
    const gamma = randomScalar(N) || 1n
    const proof = proveRange([value], [gamma], bits)
    const okNaive = verifyRange(proof, false)
    const okFast = verifyRange(proof, true)
    // Soundness demo: maul t̂ and watch the proof collapse.
    const forged: RangeProof = { ...proof, tHat: (proof.tHat + 1n) % N }
    const forgeRejected = !verifyRange(forged)
    return { gamma, proof, okNaive, okFast, forgeRejected }
  }, [value, bits, seed])
}

function RangeProofLab({ seed }: { seed: number }) {
  const [bits, setBits] = useState<number>(32)
  const [value, setValue] = useState<string>('1000000')
  const v = (() => {
    try {
      const n = BigInt(value || '0')
      return n < 0n ? 0n : n
    } catch {
      return 0n
    }
  })()
  const inRange = v < 1n << BigInt(bits)
  const r = useRangeProof(inRange ? v : 0n, bits, seed)

  return (
    <Panel
      title="① A single range proof"
      sub="Commit to a secret amount, then prove it fits in n bits — without revealing it. The proof carries only A, S, T₁, T₂, three scalars, and a logarithmic inner-product argument."
    >
      <div className="btn-row" style={{ gap: '1.2rem', marginBottom: '0.8rem', alignItems: 'flex-end' }}>
        <label style={{ display: 'flex', flexDirection: 'column', gap: 6, fontSize: '0.82rem', color: 'var(--ink-faint)' }}>
          bit width n
          <Seg value={bits} onChange={setBits} options={[8, 16, 32, 64].map((x) => ({ label: String(x), value: x }))} />
        </label>
        <label style={{ display: 'flex', flexDirection: 'column', gap: 6, fontSize: '0.82rem', color: 'var(--ink-faint)' }}>
          secret value v
          <input
            className="hexbox"
            style={{ fontFamily: 'var(--mono)', width: 220 }}
            value={value}
            onChange={(e) => setValue(e.target.value.replace(/[^0-9]/g, ''))}
          />
        </label>
        {!inRange && <span className="tag warn">v ≥ 2^{bits} — out of range</span>}
      </div>

      <dl className="kv">
        <dt>commitment V = v·G + γ·H</dt>
        <dd className="hexbox lavender" style={{ gridColumn: '1 / -1' }}>{r.proof.V[0] ? hex(r.proof.V[0].x, 64) : '—'}</dd>
        <dt>A (bit-vector commitment)</dt>
        <dd className="hexbox">{r.proof.A ? hex(r.proof.A.x, 18) : '—'}…</dd>
        <dt>S (blinding commitment)</dt>
        <dd className="hexbox">{r.proof.S ? hex(r.proof.S.x, 18) : '—'}…</dd>
        <dt>t̂ = ⟨l, r⟩</dt>
        <dd className="hexbox">{hex(r.proof.tHat, 18)}…</dd>
        <dt>inner-product rounds</dt>
        <dd>{r.proof.ipa.L.length} (proof carries {r.proof.ipa.L.length} × L,R)</dd>
        <dt>range proof valid</dt>
        <dd><Verdict ok={r.okNaive}>{r.okNaive ? `0 ≤ v < 2^${bits} ✓` : 'no'}</Verdict></dd>
        <dt>transparent ≡ optimised verifier</dt>
        <dd><Verdict ok={r.okNaive === r.okFast && r.okFast}>{r.okFast ? 'both accept ✓' : 'mismatch'}</Verdict></dd>
        <dt>soundness: mauled t̂</dt>
        <dd><Verdict ok={r.forgeRejected}>{r.forgeRejected ? 'rejected ✓' : 'accepted (!)'}</Verdict></dd>
      </dl>
      <div className="note" style={{ marginTop: '0.6rem' }}>
        The verifier never learns <code>v</code>. It only learns that some opening exists with the
        value confined to <code>{bits}</code> bits — the exact guarantee a confidential transaction
        needs so an amount can be hidden yet provably non-negative.
      </div>
    </Panel>
  )
}

// ── folding visualization ─────────────────────────────────────────────────────
function FoldingView({ seed }: { seed: number }) {
  const data = useMemo(() => {
    seedRng(seed * 53 + 11)
    const bits = 16
    const proof = proveRange([0xbeefn], [randomScalar(N) || 1n], bits)
    const rounds = proof.ipa.L.map((Lp, i) => ({
      round: i + 1,
      len: bits >> i,
      next: bits >> (i + 1),
      L: Lp,
      R: proof.ipa.R[i],
    }))
    return { bits, rounds, a: proof.ipa.a, b: proof.ipa.b }
  }, [seed])

  const W = 720
  const rowH = 46
  const H = (data.rounds.length + 1) * rowH + 20

  return (
    <Panel
      title="② The folding argument, drawn"
      sub="Each round the prover sends one L and one R point, the verifier replies with a challenge x, and both sides fold the length-k vectors into length k/2. After ⌈log₂ n⌉ rounds a single scalar pair (a, b) remains."
    >
      <div className="plotwrap" style={{ padding: '0.6rem' }}>
        <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label="inner-product folding">
          <defs>
            <linearGradient id="bpbar" x1="0" y1="0" x2="1" y2="0">
              <stop offset="0" stopColor="#5eead4" />
              <stop offset="1" stopColor="#a78bfa" />
            </linearGradient>
          </defs>
          {data.rounds.map((r, i) => {
            const y = 14 + i * rowH
            const barW = (r.len / data.bits) * 300
            const nextW = (r.next / data.bits) * 300
            return (
              <g key={i}>
                <text x="8" y={y + 18} fill="#64769a" fontSize="12" fontFamily="monospace">
                  round {r.round}
                </text>
                <rect x="92" y={y} width={barW} height="22" rx="5" fill="url(#bpbar)" opacity="0.85" />
                <text x={92 + barW + 8} y={y + 16} fill="#9fb0d0" fontSize="12" fontFamily="monospace">
                  {r.len} → {r.next}
                </text>
                <text x="470" y={y + 16} fill="#5eead4" fontSize="11" fontFamily="monospace">
                  L {r.L ? hex(r.L.x, 6) : '—'}…
                </text>
                <text x="600" y={y + 16} fill="#a78bfa" fontSize="11" fontFamily="monospace">
                  R {r.R ? hex(r.R.x, 6) : '—'}…
                </text>
                {i < data.rounds.length - 1 && (
                  <rect x="92" y={y + rowH} width={nextW} height="0" fill="none" />
                )}
              </g>
            )
          })}
          <g>
            <text x="8" y={H - 10} fill="#64769a" fontSize="12" fontFamily="monospace">
              final
            </text>
            <text x="92" y={H - 10} fill="#e9eefb" fontSize="12" fontFamily="monospace">
              a = {hex(data.a, 8)}…  b = {hex(data.b, 8)}…  (length 1)
            </text>
          </g>
        </svg>
      </div>
      <div className="legend">
        <span><i style={{ background: '#5eead4' }} /> L points (one per round)</span>
        <span><i style={{ background: '#a78bfa' }} /> R points (one per round)</span>
        <span>16-bit witness folds 16 → 8 → 4 → 2 → 1 in {data.rounds.length} rounds</span>
      </div>
    </Panel>
  )
}

// ── confidential transaction ──────────────────────────────────────────────────
function ConfidentialTxLab({ seed }: { seed: number }) {
  const [attack, setAttack] = useState(false)
  const tx = useMemo(() => {
    seedRng(seed * 191 + (attack ? 1 : 0))
    const inB = [randomScalar(N) || 1n, randomScalar(N) || 1n]
    const built = buildConfidentialTx([100n, 50n], inB, [90n, 55n], 5n, 16)
    // The attack: a malicious relay inflates output #0 by 1000 units, trying to
    // steal value. The kernel-excess balance no longer holds.
    const shown = attack
      ? { ...built, outputs: built.outputs.map((o, i) => (i === 0 ? secp256k1.add(o, secp256k1.multiply(1000n, G)) : o)) }
      : built
    const res = verifyConfidentialTx(shown)
    return { tx: shown, res }
  }, [seed, attack])

  return (
    <Panel
      title="③ A confidential transaction"
      sub="Amounts live only inside commitments. Two checks keep it honest: the kernel excess proves Σinputs = Σoutputs + fee (money is conserved), and one aggregated Bulletproof proves every output is non-negative (no money minted from a negative coin)."
      right={
        <label className="btn-row" style={{ gap: 6 }}>
          <input type="checkbox" checked={attack} onChange={(e) => setAttack(e.target.checked)} />
          <span style={{ fontSize: '0.82rem', color: 'var(--ink-dim)' }}>inflate an output (attack)</span>
        </label>
      }
    >
      <div className="grid cols-2" style={{ gap: '1rem' }}>
        <div>
          <div className="sub" style={{ marginBottom: 6 }}>inputs (amounts hidden)</div>
          {tx.tx.inputs.map((c, i) => (
            <div key={i} className="hexbox" style={{ marginBottom: 6 }}>{c ? hex(c.x, 22) : '—'}…</div>
          ))}
          <div className="sub" style={{ margin: '8px 0 6px' }}>public fee</div>
          <div className="hexbox">{tx.tx.fee.toString()} units</div>
        </div>
        <div>
          <div className="sub" style={{ marginBottom: 6 }}>outputs (amounts hidden, range-proven)</div>
          {tx.tx.outputs.map((c, i) => (
            <div key={i} className="hexbox" style={{ marginBottom: 6 }}>{c ? hex(c.x, 22) : '—'}…</div>
          ))}
        </div>
      </div>

      <dl className="kv" style={{ marginTop: '0.9rem' }}>
        <dt>outputs in range [0, 2¹⁶)</dt>
        <dd><Verdict ok={tx.res.rangeOk}>{tx.res.rangeOk ? 'all proven ✓' : 'rejected'}</Verdict></dd>
        <dt>balance: Σin = Σout + fee</dt>
        <dd><Verdict ok={tx.res.balanceOk}>{tx.res.balanceOk ? 'kernel excess = 0·G ✓' : 'broken'}</Verdict></dd>
        <dt>transaction accepted</dt>
        <dd><Verdict ok={tx.res.ok}>{tx.res.ok ? 'valid ✓' : 'INVALID'}</Verdict></dd>
      </dl>
      <div className="note" style={{ marginTop: '0.6rem' }}>
        {attack
          ? 'The attacker added value to an output without matching inputs. The hidden amounts still look like random points, but the kernel excess picks up a stray G-component — the balance proof fails and the transaction is rejected.'
          : 'This is the kernel + range-proof structure behind Monero and Mimblewimble: a verifier confirms conservation of money and non-negativity of every output while learning none of the amounts. Toggle the attack to watch it break.'}
      </div>
    </Panel>
  )
}
