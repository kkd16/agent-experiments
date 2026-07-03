import { useMemo, useState } from 'react'
import { PageHead, Panel, Verdict } from '../ui/components'
import { bytesToHex, utf8 } from '../ecc/sha256'
import { randomBytes, seedRng } from '../ecc/rng'
import { ellipsize } from '../ui/format'
import {
  PARAM_SETS, MLDSA44, N,
  keyGen, sign, signTrace, verify, sizes, toSigned,
  signPreHash, verifyPreHash, preHash,
  type MlDsaParams, type PreHash,
} from '../ecc/mldsa'

const hx = (b: Uint8Array, head = 8, tail = 6) => ellipsize(bytesToHex(b), head, tail)
const fmtBytes = (n: number): string =>
  n < 1024 ? `${n.toLocaleString()} B` : `${(n / 1024).toFixed(2)} KB`

// A compact byte grid — the first `n` bytes of a blob, coloured by magnitude,
// so a key or a signature reads as the pseudorandom object it is.
function ByteGrid({ bytes, n = 128, hue }: { bytes: Uint8Array; n?: number; hue: number }) {
  const cells = Array.from(bytes.subarray(0, n))
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(32, 1fr)', gap: 2, marginTop: '0.5rem' }}>
      {cells.map((v, i) => (
        <div
          key={i}
          title={`byte ${i} = ${v}`}
          style={{ aspectRatio: '1', borderRadius: 2, background: `hsl(${hue} 70% ${18 + (v / 255) * 52}%)` }}
        />
      ))}
    </div>
  )
}

// The τ-sparse ±1 challenge polynomial, as a 256-cell strip: green +1, red −1.
function ChallengeStrip({ c }: { c: Int32Array }) {
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(32, 1fr)', gap: 2, marginTop: '0.4rem' }}>
      {Array.from(c).map((v, i) => {
        const s = toSigned(v)
        const bg = s === 0 ? 'rgba(148,163,184,0.14)' : s > 0 ? '#34d399' : '#fb7185'
        return <div key={i} title={`c[${i}] = ${s}`} style={{ aspectRatio: '1', borderRadius: 2, background: bg }} />
      })}
    </div>
  )
}

export function MlDsaPage() {
  const [params, setParams] = useState<MlDsaParams>(MLDSA44)
  const [seedNonce, setSeedNonce] = useState(0)
  const [message, setMessage] = useState('The quick brown fox jumps over the lazy dog')
  const [tamperMsg, setTamperMsg] = useState(false)
  const [tamperSig, setTamperSig] = useState(false)
  const [phKind, setPhKind] = useState<PreHash>('SHA-512')

  const seed = useMemo(() => {
    seedRng(0xd1_5a + seedNonce * 2654435761)
    return randomBytes(32)
  }, [seedNonce])

  const run = useMemo(() => {
    const { pk, sk } = keyGen(params, seed)
    const msgBytes = utf8(message)

    const { sig, trace } = signTrace(params, sk, msgBytes)

    // The verifier's view: optionally maul the message or a signature byte.
    const vMsg = tamperMsg ? utf8(message + '.') : msgBytes
    const vSig = sig.slice()
    if (tamperSig) vSig[params.lambda / 4 + 5] ^= 0x01
    const accepted = verify(params, pk, vMsg, vSig)

    // Histogram of the response z[0]'s coefficients — spread across (−γ1, γ1] by
    // rejection sampling, which is what keeps z from leaking the short secret s1.
    const zc = trace.z[0]
    const zHist = new Array<number>(41).fill(0)
    for (let i = 0; i < N; i++) {
      const bucket = Math.min(40, Math.max(0, Math.round(((toSigned(zc[i]) + params.gamma1) / (2 * params.gamma1)) * 40)))
      zHist[bucket]++
    }

    return { pk, sk, sig, trace, accepted, zHist }
  }, [params, seed, message, tamperMsg, tamperSig])

  // Pre-hash (HashML-DSA) — sign a digest of the message under a domain byte of
  // 1 and the hash's OID, so a SHA-512 signature can't be replayed as a SHAKE-256
  // one (or as a pure-message signature). Recomputed only when the inputs change.
  const ph = useMemo(() => {
    const { pk, sk } = keyGen(params, seed)
    const msgBytes = utf8(message)
    const digest = preHash(msgBytes, phKind)
    const sig = signPreHash(params, sk, msgBytes, phKind)
    const acceptsRight = verifyPreHash(params, pk, msgBytes, sig, phKind)
    const otherPh: PreHash = phKind === 'SHA-512' ? 'SHAKE-256' : 'SHA-512'
    const acceptsWrongPh = verifyPreHash(params, pk, msgBytes, sig, otherPh)
    const acceptsAsPure = verify(params, pk, msgBytes, sig)
    return { digest, sig, acceptsRight, acceptsWrongPh, acceptsAsPure, otherPh }
  }, [params, seed, message, phKind])

  // Hedged vs deterministic — two randomised (rnd ≠ 0) signatures over the same
  // message differ byte-for-byte yet both verify; the deterministic one (rnd = 0)
  // is reproducible. Independent of the message box so typing stays snappy.
  const hedge = useMemo(() => {
    const { pk, sk } = keyGen(params, seed)
    const m = utf8('hedged-vs-deterministic demonstration')
    seedRng(0xbeef + seedNonce)
    const r1 = randomBytes(32)
    const r2 = randomBytes(32)
    const det1 = sign(params, sk, m)
    const det2 = sign(params, sk, m)
    const h1 = sign(params, sk, m, { rnd: r1 })
    const h2 = sign(params, sk, m, { rnd: r2 })
    const eq = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((x, i) => x === b[i])
    return {
      detReproducible: eq(det1, det2),
      hedgedDiffer: !eq(h1, h2),
      bothVerify: verify(params, pk, m, h1) && verify(params, pk, m, h2),
      det: det1, h1, h2,
    }
  }, [params, seed, seedNonce])

  // Rejection-loop iteration distribution — sign a batch of distinct messages and
  // tally how many Fiat–Shamir attempts each needed. This is the "with aborts"
  // cost made visible; the mean sits near the parameter set's target.
  const aborts = useMemo(() => {
    const { sk } = keyGen(params, seed)
    const BATCH = 40
    const buckets = [0, 0, 0, 0, 0] // 1, 2, 3, 4, 5+ iterations
    let total = 0
    for (let i = 0; i < BATCH; i++) {
      const { trace } = signTrace(params, sk, utf8(`abort-sample-${i}`))
      total += trace.iterations
      buckets[Math.min(4, trace.iterations - 1)]++
    }
    return { buckets, mean: total / BATCH, batch: BATCH }
  }, [params, seed])

  const sz = sizes(params)
  const zMaxHist = Math.max(...run.zHist, 1)
  const secBits = params.name === 'ML-DSA-44' ? '≈128' : params.name === 'ML-DSA-65' ? '≈192' : '≈256'
  const nistLevel = params.name === 'ML-DSA-44' ? '2' : params.name === 'ML-DSA-65' ? '3' : '5'
  const anyTamper = tamperMsg || tamperSig

  return (
    <div className="page">
      <PageHead eyebrow="Post-Quantum · Lattices" title="ML-DSA — the signature that outlives Shor">
        ML-KEM gave this lab a quantum-safe way to <em>agree on a key</em>; ML-DSA is the other
        half — a quantum-safe way to <em>sign</em>. It is the standard that retires ECDSA, Ed25519,
        and the BLS signatures elsewhere in Curvefield the day a large quantum computer boots.{' '}
        <strong>ML-DSA</strong> (FIPS&nbsp;204, the standardised CRYSTALS-Dilithium) is a{' '}
        <em>Fiat–Shamir&nbsp;with&nbsp;aborts</em> scheme over{' '}
        <code>Z₈₃₈₀₄₁₇[X]/(X²⁵⁶+1)</code>: it hides a short secret <code>s</code> inside{' '}
        <code>t = A·s₁ + s₂</code> (Module-LWE, like ML-KEM) and proves knowledge of it with a{' '}
        commitment–challenge–response whose response is <em>rejection-sampled</em> so the transcript
        leaks nothing. Every byte below — the Keccak sponge, the full 256-point NTT, the samplers,
        the rounding, and the hint machinery — is computed live by a from-scratch engine, zero
        dependencies.
      </PageHead>

      <div className="seg" style={{ marginBottom: '1rem', flexWrap: 'wrap' }}>
        {PARAM_SETS.map((p) => (
          <button key={p.name} className={params.name === p.name ? 'on' : ''} onClick={() => setParams(p)}>
            {p.name}
          </button>
        ))}
        <button className="ghost" onClick={() => setSeedNonce((n) => n + 1)} style={{ marginLeft: 'auto' }}>
          ↻ fresh key
        </button>
      </div>

      <div className="statline" style={{ marginBottom: '1rem' }}>
        <div className="stat"><b>{params.k}×{params.l}</b><span>matrix A (k×l)</span></div>
        <div className="stat"><b>8380417</b><span>modulus q = 2²³−2¹³+1</span></div>
        <div className="stat"><b>{params.tau}</b><span>challenge weight τ</span></div>
        <div className="stat"><b>±{params.eta}</b><span>secret bound η</span></div>
        <div className="stat"><b>{secBits}</b><span>classical security bits</span></div>
        <div className="stat"><b>{nistLevel}</b><span>NIST level</span></div>
      </div>

      <Panel
        title="1 · KeyGen — bury a short secret under a noisy linear system"
        sub="Expand a public matrix A from a 32-byte seed ρ, sample a short (s1, s2) with |coeff| ≤ η, publish t = A·s1 + s2 — then drop t's low 13 bits into t0 (kept secret) and ship only the top bits t1. Recovering s1 from (A, t) is Module-LWE."
      >
        <div className="grid cols-2" style={{ gridTemplateColumns: '1fr 1fr', gap: '1.2rem', alignItems: 'start' }}>
          <div>
            <dl className="kv">
              <dt>seed ξ</dt>
              <dd className="hexbox" style={{ gridColumn: '1 / -1' }}>{hx(seed, 12, 8)}</dd>
              <dt>pk — public key</dt>
              <dd className="hexbox lavender" style={{ gridColumn: '1 / -1' }}>{hx(run.pk, 14, 8)}</dd>
              <dt>sk — secret key</dt>
              <dd className="hexbox violet" style={{ gridColumn: '1 / -1' }}>{hx(run.sk, 14, 8)}</dd>
            </dl>
            <div className="note" style={{ marginTop: '0.6rem' }}>
              <code>pk = ρ ‖ t1</code> = {fmtBytes(sz.pk)}; <code>sk</code> = {fmtBytes(sz.sk)} carries ρ,
              a signing seed K, a hash tr of the public key, and the short (s1, s2, t0). No 32-byte
              curve point here — the price of a hardness assumption no quantum computer is known to
              break.
            </div>
          </div>
          <div>
            <div className="sub" style={{ marginBottom: '0.4rem' }}>The public key as bytes — a wall of pseudorandom noise.</div>
            <ByteGrid bytes={run.pk} hue={265} n={96} />
          </div>
        </div>
      </Panel>

      <Panel
        title="2 · Sign — commit, challenge, respond… and abort until it's safe"
        sub="Draw a masking vector y, commit to w1 = HighBits(A·y), hash a sparse ±1 challenge c = H(μ ‖ w1), and answer z = y + c·s1. If z or the leftover low bits stray too far, the whole attempt is thrown away and retried — that abort is exactly what makes z reveal nothing about s1."
        right={<span className="tag ok">{run.trace.iterations} iteration{run.trace.iterations > 1 ? 's' : ''}</span>}
      >
        <label className="field" style={{ marginBottom: '0.8rem' }}>
          <span style={{ display: 'flex', justifyContent: 'space-between' }}>
            <span>message</span>
            <span className="dim mono">{utf8(message).length} bytes</span>
          </span>
          <input
            type="text"
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            style={{
              width: '100%', padding: '0.5rem 0.7rem', borderRadius: 8,
              border: '1px solid var(--line, #334155)', background: 'var(--panel, #0b1220)',
              color: 'inherit', font: 'inherit',
            }}
          />
        </label>

        <div className="flow-h" style={{ marginBottom: '0.9rem' }}>
          <div className="flow-step">
            <b>Commit</b>
            <div className="dim">w1 = HighBits(A·y)</div>
            <div className="mono">mask y ∈ (−γ1, γ1]</div>
          </div>
          <div className="flow-step">
            <b>Challenge</b>
            <div className="dim">c̃ = H(μ ‖ w1)</div>
            <div className="mono">{run.trace.hintCount} hint bits</div>
          </div>
          <div className="flow-step">
            <b>Respond</b>
            <div className="dim">z = y + c·s1</div>
            <div className="mono">‖z‖∞ = {run.trace.zNorm.toLocaleString()}</div>
          </div>
        </div>

        <div className="sub" style={{ marginBottom: '0.3rem' }}>
          The challenge c — a sparse polynomial with exactly τ={params.tau} entries, each ±1
          (<span style={{ color: '#34d399' }}>+1</span> / <span style={{ color: '#fb7185' }}>−1</span>),
          the rest zero. It is derived <em>only</em> from the public commitment, so the signer cannot
          steer it.
        </div>
        <ChallengeStrip c={run.trace.challenge} />

        {run.trace.rejects.length > 0 && (
          <div className="note" style={{ marginTop: '0.7rem' }}>
            <b>Rejected attempts before success:</b>{' '}
            {run.trace.rejects.map((r, i) => (
              <span key={i} className="pill" style={{ marginRight: 4 }}>{r}</span>
            ))}
            <br />
            Each rejection is a fresh mask y and a fresh challenge — the loop repeats until the
            response is provably safe to publish. On average it takes a handful of tries.
          </div>
        )}

        <div className="sub" style={{ margin: '0.9rem 0 0.3rem' }}>
          The response z₀'s coefficients — spread across the full (−γ1, γ1] band with the top slice
          (|z| ≥ γ1−β) rejected. This near-uniform spread is what hides the short secret s1 inside z.
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(41, 1fr)', gap: 1, alignItems: 'end', height: 70 }}>
          {run.zHist.map((c, i) => (
            <div key={i} title={`${c}`} style={{ height: `${(c / zMaxHist) * 100}%`, background: '#a78bfa', borderRadius: 1, minHeight: c > 0 ? 2 : 0 }} />
          ))}
        </div>

        <dl className="kv" style={{ marginTop: '0.9rem' }}>
          <dt>challenge c̃</dt>
          <dd className="hexbox" style={{ gridColumn: '1 / -1' }}>{hx(run.trace.cTilde, 14, 10)}</dd>
          <dt>signature σ</dt>
          <dd className="hexbox violet" style={{ gridColumn: '1 / -1' }}>{hx(run.sig, 16, 10)}</dd>
        </dl>
        <ByteGrid bytes={run.sig} hue={280} />
        <div className="note" style={{ marginTop: '0.6rem' }}>
          <code>σ = c̃ ‖ z ‖ h</code> = {fmtBytes(sz.sig)}.
          The hint <code>h</code> is one bit per coefficient (≤ ω={params.omega} set) — the compressed
          instructions the verifier needs to undo the 13 low bits KeyGen threw away.
        </div>
      </Panel>

      <Panel
        title="3 · Verify — rebuild the commitment and check the challenge"
        sub="From (A, z, c, t1) the verifier recomputes A·z − c·t1·2¹³, uses the hint to recover HighBits, re-hashes the challenge, and accepts only if it reproduces c̃ and z is short. No secret needed."
        right={<Verdict ok={run.accepted}>{run.accepted ? 'valid' : 'rejected'}</Verdict>}
      >
        <div style={{ display: 'flex', gap: '1.2rem', flexWrap: 'wrap', marginBottom: '0.7rem' }}>
          <label style={{ display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
            <input type="checkbox" checked={tamperMsg} onChange={(e) => setTamperMsg(e.target.checked)} />
            Alter the message after signing
          </label>
          <label style={{ display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
            <input type="checkbox" checked={tamperSig} onChange={(e) => setTamperSig(e.target.checked)} />
            Flip one signature byte
          </label>
        </div>
        {run.accepted ? (
          <div className="note">
            The recomputed <code>w1′</code> reproduced the challenge <code>c̃</code> and{' '}
            <code>‖z‖∞ &lt; γ1−β</code>, so the signature is accepted — using only the public key.
            The hint let the verifier undo the discarded low bits <em>without</em> ever seeing{' '}
            <code>t0</code>.
          </div>
        ) : (
          <div className="warn">
            {anyTamper ? (
              <>Tampering broke the Fiat–Shamir binding: the recomputed commitment no longer hashes to{' '}
              <code>c̃</code>, so verification fails closed. A single changed message byte or signature
              byte is enough — there is no way to repair the challenge without the secret.</>
            ) : (
              <>Rejected.</>
            )}
          </div>
        )}
      </Panel>

      <Panel
        title="4 · HashML-DSA — sign a digest, bound to its hash function"
        sub="For huge messages (or when the message is streamed and hashed elsewhere) FIPS 204 §5.4 defines a pre-hash mode: sign PH(M) instead of M, under domain byte 1 and the DER OID of the hash. The OID is what stops a signature over a SHA-512 digest from being replayed as a SHAKE-256 one."
        right={<Verdict ok={ph.acceptsRight && !ph.acceptsWrongPh && !ph.acceptsAsPure}>{ph.acceptsRight && !ph.acceptsWrongPh && !ph.acceptsAsPure ? 'bound' : 'leak'}</Verdict>}
      >
        <div className="seg" style={{ marginBottom: '0.8rem' }}>
          {(['SHA-512', 'SHAKE-256'] as PreHash[]).map((k) => (
            <button key={k} className={phKind === k ? 'on' : ''} onClick={() => setPhKind(k)}>{k}</button>
          ))}
        </div>
        <dl className="kv">
          <dt>PH(M) — {phKind} digest</dt>
          <dd className="hexbox violet" style={{ gridColumn: '1 / -1' }}>{hx(ph.digest, 16, 10)}</dd>
          <dt>M′ prefix</dt>
          <dd className="hexbox" style={{ gridColumn: '1 / -1' }}>01 ‖ len(ctx) ‖ ctx ‖ OID({phKind}) ‖ PH(M)</dd>
          <dt>signature σ</dt>
          <dd className="hexbox lavender" style={{ gridColumn: '1 / -1' }}>{hx(ph.sig, 16, 10)}</dd>
        </dl>
        <div className="statline" style={{ marginTop: '0.9rem' }}>
          <div className="stat"><b>{ph.acceptsRight ? '✓' : '✗'}</b><span>verifies under {phKind}</span></div>
          <div className="stat"><b>{ph.acceptsWrongPh ? '✗' : '✓'}</b><span>rejected under {ph.otherPh}</span></div>
          <div className="stat"><b>{ph.acceptsAsPure ? '✗' : '✓'}</b><span>rejected as pure ML-DSA</span></div>
          <div className="stat"><b>{fmtBytes(sz.sig)}</b><span>same signature size</span></div>
        </div>
        <div className="note" style={{ marginTop: '0.7rem' }}>
          The signature bytes are the ordinary ML-DSA object — only the message representative fed to{' '}
          <code>μ = H(tr ‖ M′)</code> changed. Because <code>M′</code> carries the hash's OID, the
          three verdicts above show the signature is inseparable from the exact pre-hash it was made
          under: swap the hash function and it fails closed.
        </div>
      </Panel>

      <Panel
        title="5 · Deterministic vs hedged — same key, two safe randomness modes"
        sub="ML-DSA can sign with rnd = 0 (deterministic, fully reproducible — the mode this whole page uses) or with a fresh 32-byte rnd (hedged, so a faulty RNG or a fault-injection glitch can't repeat a mask). Both are FIPS 204; both verify."
        right={<Verdict ok={hedge.detReproducible && hedge.hedgedDiffer && hedge.bothVerify}>{hedge.detReproducible && hedge.hedgedDiffer && hedge.bothVerify ? 'both valid' : 'error'}</Verdict>}
      >
        <dl className="kv">
          <dt>deterministic (rnd = 0)</dt>
          <dd className="hexbox" style={{ gridColumn: '1 / -1' }}>{hx(hedge.det, 16, 10)}</dd>
          <dt>hedged #1 (random rnd)</dt>
          <dd className="hexbox violet" style={{ gridColumn: '1 / -1' }}>{hx(hedge.h1, 16, 10)}</dd>
          <dt>hedged #2 (random rnd)</dt>
          <dd className="hexbox lavender" style={{ gridColumn: '1 / -1' }}>{hx(hedge.h2, 16, 10)}</dd>
        </dl>
        <div className="statline" style={{ marginTop: '0.9rem' }}>
          <div className="stat"><b>{hedge.detReproducible ? '✓' : '✗'}</b><span>deterministic reproducible</span></div>
          <div className="stat"><b>{hedge.hedgedDiffer ? '✓' : '✗'}</b><span>hedged sigs differ</span></div>
          <div className="stat"><b>{hedge.bothVerify ? '✓' : '✗'}</b><span>both hedged verify</span></div>
        </div>
        <div className="note" style={{ marginTop: '0.7rem' }}>
          Unlike ECDSA — where a <em>repeated</em> nonce leaks the private key outright — ML-DSA's
          security doesn't hinge on rnd being unique, so both modes are safe. Hedging just adds
          defence-in-depth against a stuck RNG; determinism buys reproducibility and testability.
        </div>
      </Panel>

      <Panel
        title="6 · The cost of aborts — the rejection-loop distribution"
        sub={`Signing retries until the response is safe to publish. Signing ${aborts.batch} distinct messages and tallying attempts shows the geometric-ish distribution the parameters are tuned for — most signatures land on the first or second try.`}
        right={<span className="tag ok">mean {aborts.mean.toFixed(2)} iters</span>}
      >
        <div className="bars">
          {aborts.buckets.map((count, i) => (
            <div className="bar" key={i}>
              <span style={{ color: 'var(--ink-dim)', minWidth: 80 }}>{i === 4 ? '5+ tries' : `${i + 1} tr${i === 0 ? 'y' : 'ies'}`}</span>
              <div className="track">
                <div className="fill" style={{ width: `${(count / aborts.batch) * 100}%`, background: i === 0 ? '#34d399' : i < 3 ? '#a78bfa' : '#fb7185' }} />
              </div>
              <span className="mono" style={{ minWidth: 40, textAlign: 'right' }}>{count}</span>
            </div>
          ))}
        </div>
        <div className="note" style={{ marginTop: '0.7rem' }}>
          Each abort is cheap relative to the whole signature, and the acceptance probability per
          attempt is bounded below by the parameter choice, so the loop terminates fast with
          overwhelming probability — the expected number of tries is a small constant, not a function
          of the message.
        </div>
      </Panel>

      <Panel
        title="Why the aborts — and why the size"
        sub="Two design choices set ML-DSA apart from the curves: rejection sampling for zero-knowledge, and a hint that shrinks the public key by discarding low bits the verifier can reconstruct."
      >
        <div className="bars">
          {[
            { label: 'Ed25519 signature', bytes: 64, color: '#5eead4' },
            { label: `${params.name} signature`, bytes: sz.sig, color: '#fb7185' },
            { label: 'Ed25519 public key', bytes: 32, color: '#5eead4' },
            { label: `${params.name} public key`, bytes: sz.pk, color: '#a78bfa' },
          ].map((r) => (
            <div className="bar" key={r.label}>
              <span style={{ color: 'var(--ink-dim)', minWidth: 170 }}>{r.label}</span>
              <div className="track">
                <div className="fill" style={{ width: `${(r.bytes / sz.sig) * 100}%`, background: r.color }} />
              </div>
              <span className="mono" style={{ minWidth: 74, textAlign: 'right' }}>{fmtBytes(r.bytes)}</span>
            </div>
          ))}
        </div>
        <div className="statline" style={{ marginTop: '1rem' }}>
          <div className="stat"><b>{Math.round(sz.sig / 64)}×</b><span>bigger sig than Ed25519</span></div>
          <div className="stat"><b>{Math.round(sz.pk / 32)}×</b><span>bigger key than Ed25519</span></div>
          <div className="stat"><b>2¹³</b><span>low bits dropped via hint</span></div>
          <div className="stat"><b>2024</b><span>FIPS 204 finalised</span></div>
        </div>
        <div className="note" style={{ marginTop: '0.8rem' }}>
          Without rejection sampling, <code>z = y + c·s1</code> would leak <code>s1</code> a little on
          every signature; the abort keeps <code>z</code> in a distribution independent of the secret,
          which is what makes the scheme <em>EUF-CMA</em> secure. Without the hint, the public key would
          have to carry all 23 bits of every coefficient of <code>t</code>; dropping the low 13 and
          letting the verifier rebuild them from one bit per coefficient is the trick that keeps the
          key merely large instead of enormous.
        </div>
      </Panel>

      <div className="note" style={{ marginTop: '0.4rem' }}>
        Engine verified in the live self-test: the 256-point NTT inverts exactly and its pointwise
        product reproduces a schoolbook negacyclic convolution; Power2Round and the
        Decompose / MakeHint / UseHint identities round-trip on random input; SampleInBall yields
        exactly τ signed units; full KeyGen→Sign→Verify succeeds for all three parameter sets; the
        key and signature byte-lengths match the FIPS&nbsp;204 Table&nbsp;2 sizes to the byte;
        deterministic signing is byte-for-byte reproducible; and a tampered message, a mauled
        signature, or a wrong key is always rejected.
      </div>
    </div>
  )
}
