import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { PageHead, Panel, Verdict } from '../ui/components'
import {
  keyGen,
  encaps,
  decapsInternal,
  ntt,
  invNtt,
  baseMul,
  sizes,
  PARAM_SETS,
  ML_KEM_768,
  Q,
  type Params,
} from '../ecc/mlkem'
import {
  runKat512,
  KAT_512,
  AccumulatedRun,
  ACC_EXPECTED_10K,
} from '../ecc/mlkem-vectors'
import { randomBytes } from '../ecc/rng'

const bh = (b: Uint8Array, head = 12, tail = 8): string => {
  const s = Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('')
  return s.length <= (head + tail) * 2 + 1 ? s : `${s.slice(0, head * 2)}…${s.slice(-tail * 2)}`
}
const fmtBytes = (n: number): string => `${n.toLocaleString()} B`

// A random ring element with small coefficients, for the NTT demonstration.
function randPoly(): number[] {
  const b = randomBytes(512)
  return Array.from({ length: 256 }, (_, i) => ((b[2 * i] | (b[2 * i + 1] << 8)) % Q))
}

// Schoolbook multiplication in R_q = ℤ_q[X]/(X²⁵⁶+1): X²⁵⁶ folds back as −1.
function negacyclicMul(a: number[], b: number[]): number[] {
  const c = new Array<number>(256).fill(0)
  for (let i = 0; i < 256; i++) {
    for (let j = 0; j < 256; j++) {
      const v = a[i] * b[j]
      const k = i + j
      if (k < 256) c[k] = (c[k] + v) % Q
      else c[k - 256] = (c[k - 256] - v) % Q
    }
  }
  return c.map((x) => ((x % Q) + Q) % Q)
}

// ── the accumulated (10,000-round) test, driven in the UI ────────────────────

interface RunState {
  status: 'idle' | 'running' | 'done'
  i: number
  total: number
  elapsed: number
  digest?: string
  match?: boolean
  consistent?: boolean
}
const idleRun = (): RunState => ({ status: 'idle', i: 0, total: 10000, elapsed: 0 })

export function MlKemPage() {
  const [param, setParam] = useState<Params>(ML_KEM_768)
  const [keyNonce, setKeyNonce] = useState(0)
  const [encNonce, setEncNonce] = useState(0)
  const [flip, setFlip] = useState(3)
  const [polyNonce, setPolyNonce] = useState(0)

  const sz = sizes(param)

  // Live keygen / encaps / decaps in the shipped FIPS 203 final variant.
  // keyNonce / encNonce are re-roll triggers, referenced to force recomputation.
  const keys = useMemo(() => { void keyNonce; return keyGen(param) }, [param, keyNonce])
  const enc = useMemo(() => { void encNonce; return encaps(keys.ek, param) }, [keys, param, encNonce])
  const dec = useMemo(() => decapsInternal(keys.dk, enc.c, param), [keys, enc, param])
  const agree = dec.valid && bh(dec.K, 32, 0) === bh(enc.K, 32, 0)

  // Tamper: flip one ciphertext byte and watch implicit rejection fire.
  const tampered = useMemo(() => {
    const c = enc.c.slice()
    c[flip % c.length] ^= 0xff
    return decapsInternal(keys.dk, c, param)
  }, [enc, keys, param, flip])
  const rejectedWell = !tampered.valid && bh(tampered.K, 32, 0) !== bh(enc.K, 32, 0)

  // The published ML-KEM-512 known-answer test.
  const kat = useMemo(() => runKat512(), [])

  // NTT ⇒ cheap ring multiplication, proven against the schoolbook product.
  const nttDemo = useMemo(() => {
    void polyNonce
    const a = randPoly()
    const b = randPoly()
    const viaNtt = invNtt(baseMul(ntt(a), ntt(b)))
    const school = negacyclicMul(a, b)
    const equal = viaNtt.every((x, i) => x === school[i])
    return { a, b, viaNtt, school, equal }
  }, [polyNonce])

  // ── accumulated-test runner ────────────────────────────────────────────────
  const [runs, setRuns] = useState<Record<string, RunState>>({})
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const busy = Object.values(runs).some((r) => r.status === 'running')

  useEffect(() => () => { if (timer.current) clearTimeout(timer.current) }, [])

  const startRun = useCallback((p: Params) => {
    if (busy) return
    const total = 10000
    const run = new AccumulatedRun(p, total, 'ipd')
    const chunk = p.k <= 2 ? 12 : p.k === 3 ? 8 : 5
    const start = Date.now()
    setRuns((r) => ({ ...r, [p.name]: { status: 'running', i: 0, total, elapsed: 0 } }))
    const tick = () => {
      const prog = run.step(chunk)
      const elapsed = Date.now() - start
      if (prog.done) {
        const digest = run.digest()
        setRuns((r) => ({
          ...r,
          [p.name]: {
            status: 'done',
            i: prog.i,
            total,
            elapsed,
            digest,
            match: digest === ACC_EXPECTED_10K[p.name],
            consistent: run.decapsConsistent,
          },
        }))
      } else {
        setRuns((r) => ({ ...r, [p.name]: { status: 'running', i: prog.i, total, elapsed } }))
        timer.current = setTimeout(tick, 0)
      }
    }
    tick()
  }, [busy])

  return (
    <main className="page">
      <PageHead eyebrow="Lab 27 — lattice post-quantum" title="ML-KEM · Module-Lattice Key Encapsulation">
        The other branch of the post-quantum standards. Everything else on this lab's PQ shelf —
        Lamport, WOTS⁺, XMSS, SPHINCS⁺ — is <em>hash-based</em>; <b>ML-KEM</b> (FIPS 203, the
        standardised form of <em>Kyber</em>) is the <em>lattice</em> KEM that NIST picked for key
        establishment and that already ships in TLS 1.3 hybrids. Its hardness is <b>Module-LWE</b>:
        a public key is a noisy linear system <code>t = A·s + e</code> over the ring{' '}
        <code>R_q = ℤ_q[X]/(X²⁵⁶+1)</code>, <code>q = 3329</code>, and recovering the small secret{' '}
        <code>s</code> is believed hard even for a quantum computer. An IND-CPA core (K-PKE) is
        wrapped in the <b>Fujisaki–Okamoto</b> transform to reach IND-CCA2. Everything here — the
        Keccak sponge, the number-theoretic transform, the whole KEM — is from scratch, and pinned
        below to the community's published <b>10,000-round</b> test vector.
      </PageHead>

      <Panel
        title="Parameter set"
        sub="Higher k stacks more Module-LWE samples for more security margin. The engine, and every panel below, follows your choice."
      >
        <div className="seg" role="tablist">
          {PARAM_SETS.map((p) => (
            <button key={p.name} className={p.name === param.name ? 'on' : ''} onClick={() => setParam(p)}>
              {p.name}
            </button>
          ))}
        </div>
        <dl className="kv" style={{ marginTop: '0.9rem' }}>
          <dt>module rank k</dt>
          <dd>{param.k} &nbsp;·&nbsp; A is {param.k}×{param.k} over R_q</dd>
          <dt>noise η₁ / η₂</dt>
          <dd>{param.eta1} / {param.eta2} &nbsp;·&nbsp; centred-binomial width</dd>
          <dt>compression d_u / d_v</dt>
          <dd>{param.du} / {param.dv} bits</dd>
          <dt>NIST category</dt>
          <dd>{param.k === 2 ? '1 (≈ AES-128)' : param.k === 3 ? '3 (≈ AES-192)' : '5 (≈ AES-256)'}</dd>
        </dl>
      </Panel>

      <Panel
        title="Key establishment, live"
        sub="Bob publishes an encapsulation key. Alice encapsulates to it, producing a ciphertext and a shared secret; Bob decapsulates the ciphertext back to the same secret."
        right={<button className="btn" onClick={() => setKeyNonce((n) => n + 1)}>↻ new keypair</button>}
      >
        <div className="grid cols-3" style={{ gap: '0.8rem', marginBottom: '0.8rem' }}>
          <Stat label="encapsulation key" value={fmtBytes(sz.ek)} sub="t̂ ‖ ρ" />
          <Stat label="decapsulation key" value={fmtBytes(sz.dk)} sub="ŝ ‖ ek ‖ H(ek) ‖ z" />
          <Stat label="ciphertext" value={fmtBytes(sz.ct)} sub="Compress(u) ‖ Compress(v)" />
        </div>
        <dl className="kv">
          <dt>Bob · ek</dt>
          <dd className="hexbox">{bh(keys.ek, 16, 8)}</dd>
          <dt>Alice · ciphertext</dt>
          <dd className="hexbox">{bh(enc.c, 16, 8)}</dd>
          <dt>Alice · shared secret</dt>
          <dd className="hexbox lavender">{bh(enc.K, 32, 0)}</dd>
          <dt>Bob · decapsulated</dt>
          <dd className="hexbox lavender">{bh(dec.K, 32, 0)}</dd>
          <dt>secrets agree?</dt>
          <dd><Verdict ok={agree}>{agree ? 'identical ✓ — a shared key over an open channel' : 'mismatch'}</Verdict></dd>
        </dl>
        <div className="btn-row" style={{ marginTop: '0.7rem' }}>
          <button className="btn" onClick={() => setEncNonce((n) => n + 1)}>↻ re-encapsulate</button>
          <span className="note">Each encapsulation draws a fresh 32-byte message m; the secret is <code>K = G(m ‖ H(ek))</code>.</span>
        </div>
      </Panel>

      <Panel
        title="Chosen-ciphertext security — implicit rejection"
        sub="The FO transform re-encrypts on decapsulation and compares. On any mismatch ML-KEM does not error — it returns a secret pseudorandom key J(z ‖ c), so an attacker probing with mauled ciphertexts learns nothing."
      >
        <div className="field" style={{ maxWidth: 420 }}>
          <label><span>flip ciphertext byte #</span><span className="val">{flip}</span></label>
          <input type="range" min={0} max={Math.min(63, enc.c.length - 1)} value={flip} onChange={(e) => setFlip(Number(e.target.value))} />
        </div>
        <dl className="kv" style={{ marginTop: '0.4rem' }}>
          <dt>honest decapsulation</dt>
          <dd className="hexbox lavender">{bh(enc.K, 32, 0)}</dd>
          <dt>after tampering</dt>
          <dd className="hexbox">{bh(tampered.K, 32, 0)}</dd>
          <dt>re-encryption matched?</dt>
          <dd><Verdict ok={tampered.valid}>{tampered.valid ? 'yes (collided)' : 'no → rejected'}</Verdict></dd>
          <dt>rejection is silent + pseudorandom</dt>
          <dd><Verdict ok={rejectedWell}>{rejectedWell ? 'yes ✓ — a different, unpredictable key' : '—'}</Verdict></dd>
        </dl>
      </Panel>

      <Panel
        title="Why the NTT is the whole trick"
        sub="X²⁵⁶+1 splits mod q into 128 quadratics, so the number-theoretic transform turns a polynomial into 128 independent pairs and ring multiplication into cheap base-case products — O(n log n), not O(n²)."
        right={<button className="btn" onClick={() => setPolyNonce((n) => n + 1)}>↻ new polynomials</button>}
      >
        <dl className="kv">
          <dt>a·b via NTT</dt>
          <dd className="mono">[{nttDemo.viaNtt.slice(0, 6).join(', ')}, …]</dd>
          <dt>a·b schoolbook (X²⁵⁶ = −1)</dt>
          <dd className="mono">[{nttDemo.school.slice(0, 6).join(', ')}, …]</dd>
          <dt>identical for all 256 coefficients?</dt>
          <dd><Verdict ok={nttDemo.equal}>{nttDemo.equal ? 'INTT(â ⊙ b̂) = a·b ✓' : 'mismatch'}</Verdict></dd>
        </dl>
        <div className="note" style={{ marginTop: '0.5rem' }}>
          The forward transform, the 128 base-case products, and the inverse transform are all
          hand-written mod 3329 — and the self-test confirms the transform is an exact involution
          with its inverse.
        </div>
      </Panel>

      <Panel
        title="Known-answer test — ML-KEM-512 (C2SP CCTV)"
        sub="A single published intermediate vector, reproduced end to end: seed → key → ciphertext → shared secret."
      >
        <dl className="kv">
          <dt>seed d</dt>
          <dd className="hexbox">{KAT_512.d}</dd>
          <dt>ρ = G(d)</dt>
          <dd><Verdict ok={kat.rhoOk}>{kat.rhoOk ? 'matches ✓' : 'differs'}</Verdict></dd>
          <dt>encapsulation key prefix</dt>
          <dd><Verdict ok={kat.ekOk}>{kat.ekOk ? 'matches ✓' : 'differs'}</Verdict></dd>
          <dt>ciphertext prefix</dt>
          <dd><Verdict ok={kat.ctOk}>{kat.ctOk ? 'matches ✓' : 'differs'}</Verdict></dd>
          <dt>shared secret K</dt>
          <dd className="hexbox lavender">{KAT_512.K}</dd>
          <dt>our K equals published K?</dt>
          <dd><Verdict ok={kat.kOk}>{kat.kOk ? 'byte-for-byte ✓' : 'differs'}</Verdict></dd>
        </dl>
      </Panel>

      <Panel
        title="The 10,000-round accumulated test"
        sub="The strongest proof of correctness here. One empty-seeded SHAKE-128 stream drives 10,000 randomised rounds of KeyGen → Encaps → Decaps (with a random-ciphertext implicit rejection each round); every ek, dk, ciphertext and both shared secrets are folded into a running SHAKE-128 tag. Matching the community-published constant certifies the whole KEM byte-for-byte."
      >
        <div className="note" style={{ marginBottom: '0.8rem' }}>
          Runs in your browser, chunked so the page stays responsive — a few seconds for ML-KEM-512,
          up to ~2 minutes for ML-KEM-1024. The vectors follow FIPS&nbsp;203&nbsp;<b>ipd</b> (seed
          hashed as <code>G(d)</code>); the lab otherwise ships FIPS&nbsp;203&nbsp;<b>final</b>
          (<code>G(d‖k)</code>), which differs by exactly one domain-separation byte.
        </div>
        <div className="bars">
          {PARAM_SETS.map((p) => {
            const r = runs[p.name] ?? idleRun()
            const pct = (r.i / r.total) * 100
            const color = r.status === 'done' ? (r.match ? 'var(--good)' : 'var(--bad)') : 'var(--accent)'
            return (
              <div className="bar" key={p.name}>
                <span>
                  <button className="btn" disabled={busy && r.status !== 'running'} onClick={() => startRun(p)} style={{ minWidth: 118 }}>
                    {r.status === 'running' ? `${((r.i / r.total) * 100) | 0}%` : r.status === 'done' ? '↻ re-run' : `run ${p.name.slice(7)}`}
                  </button>
                </span>
                <span className="track"><span className="fill" style={{ width: `${pct}%`, background: color }} /></span>
                <span className="mono" style={{ fontSize: '0.76rem' }}>
                  {r.status === 'done'
                    ? <Verdict ok={!!r.match}>{r.match ? `published ✓ · ${(r.elapsed / 1000).toFixed(1)}s` : 'MISMATCH'}</Verdict>
                    : r.status === 'running'
                      ? `${r.i.toLocaleString()} / ${r.total.toLocaleString()}`
                      : 'idle'}
                </span>
              </div>
            )
          })}
        </div>
        {PARAM_SETS.map((p) => {
          const r = runs[p.name]
          if (!r || r.status !== 'done') return null
          return (
            <dl className="kv" key={p.name} style={{ marginTop: '0.8rem' }}>
              <dt>{p.name} · SHAKE-128 tag</dt>
              <dd className="hexbox" style={{ color: r.match ? 'var(--good)' : 'var(--bad)' }}>{r.digest}</dd>
              <dt>published</dt>
              <dd className="hexbox">{ACC_EXPECTED_10K[p.name]}</dd>
              <dt>10,000 decaps round-trips consistent?</dt>
              <dd><Verdict ok={!!r.consistent}>{r.consistent ? 'every round agreed ✓' : 'a round disagreed'}</Verdict></dd>
            </dl>
          )
        })}
      </Panel>

      <div className="note" style={{ opacity: 0.75, marginTop: '0.5rem' }}>
        Educational lab — do not use these keys to protect anything real.
      </div>
    </main>
  )
}

function Stat({ label, value, sub }: { label: string; value: string; sub: string }) {
  return (
    <div style={{ background: '#080d18', border: '1px solid var(--line-soft)', borderRadius: 10, padding: '0.7rem 0.8rem' }}>
      <div className="note" style={{ fontSize: '0.72rem', textTransform: 'uppercase', letterSpacing: '0.04em' }}>{label}</div>
      <div style={{ fontSize: '1.15rem', fontWeight: 700, margin: '0.15rem 0' }}>{value}</div>
      <div className="mono" style={{ fontSize: '0.72rem', color: 'var(--ink-faint)' }}>{sub}</div>
    </div>
  )
}
