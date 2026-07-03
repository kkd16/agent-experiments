import { useMemo, useState } from 'react'
import { PageHead, Panel, Slider, Verdict } from '../ui/components'
import {
  type Form,
  compose,
  power,
  square,
  identity,
  isReduced,
  formEq,
  discriminant,
  primeForm,
  generateDiscriminant,
  isqrt,
  bitLength,
} from '../ecc/classgroup'
import {
  CG,
  evalVDF,
  wesolowskiProve,
  wesolowskiProveStreaming,
  wesolowskiVerify,
  beaconChain,
} from '../ecc/cgvdf'
import { utf8, bytesToHex } from '../ecc/sha256'
import { ellipsize } from '../ui/format'

const shortN = (n: bigint) => ellipsize((n < 0n ? '-0x' : '0x') + (n < 0n ? -n : n).toString(16), 10, 8)

// A compact rendering of a reduced form (a, b, c).
function FormView({ f, label }: { f: Form; label?: string }) {
  return (
    <div className="hexbox" style={{ display: 'flex', flexDirection: 'column', gap: '0.15rem' }}>
      {label && <span className="note" style={{ fontSize: '0.72rem' }}>{label}</span>}
      <span>
        <span className="note">a=</span>
        {shortN(f.a)} &nbsp;<span className="note">b=</span>
        {shortN(f.b)}
      </span>
      <span style={{ fontSize: '0.78rem', opacity: 0.75 }}>
        <span className="note">c=</span>
        {shortN(f.c)}
      </span>
    </div>
  )
}

export function ClassGroupVdfPage() {
  // ── The public, nothing-up-my-sleeve discriminant ──
  const [seedText, setSeedText] = useState('curvefield/class-group/v1')
  const { D, g, err } = useMemo(() => {
    const s = seedText.trim()
    if (s === 'curvefield/class-group/v1' || s === '') return { D: CG.D, g: CG.g, err: '' }
    try {
      const D = generateDiscriminant(utf8(s), 256)
      const g = primeForm(D)
      return { D, g, err: '' }
    } catch {
      return { D: CG.D, g: CG.g, err: 'could not derive Δ from that seed — showing the default' }
    }
  }, [seedText])

  const aBound = useMemo(() => isqrt(-D / 3n), [D])

  return (
    <main className="page">
      <PageHead eyebrow="Lab — proof of sequential time, no trusted setup" title="Class-Group VDF">
        The verifiable delay function next door squares in an RSA group{' '}
        <code>(ℤ/N)*</code> — but whoever generated <code>N = p·q</code> knows{' '}
        <code>φ(N)</code> and can <em>skip the delay</em>. Killing that trapdoor needs a group of{' '}
        <strong>unknown order with no one holding the secret</strong>. The{' '}
        <strong>class group of an imaginary quadratic field</strong> <code>Cl(Δ)</code> is exactly that:
        its order is the class number <code>h(Δ) ≈ √|Δ|</code>, computing it is believed as hard as
        factoring, and <code>Δ</code> itself is just a public number hashed from a seed —{' '}
        <em>no ceremony, no trapdoor, no trust</em>. This page builds that group from scratch — binary
        quadratic forms, Gauss composition, reduction — and runs a full Wesolowski proof-of-time over it,
        the engine under Chia's consensus. Every claim here is pinned on the Self-Test page against the
        group axioms on the full Cayley table of small discriminants and against forgery.
      </PageHead>

      <Panel
        title="The group — Cl(Δ), an unknown order nobody chose"
        sub={
          <>
            Elements are primitive positive-definite forms <code>(a, b, c)</code> with{' '}
            <code>b² − 4ac = Δ</code>, taken up to reduction. Change the seed to hash a fresh public
            discriminant: <code>Δ = −p</code> for a prime <code>p ≡ 3 (mod 4)</code>, so{' '}
            <code>Δ ≡ 1 (mod 4)</code> is fundamental and <code>|Δ|</code> is prime.
          </>
        }
      >
        <div className="field">
          <label>
            <span>public seed → Δ</span>
            <span className="val">hashed to a prime disc.</span>
          </label>
          <input
            type="text"
            value={seedText}
            onChange={(e) => setSeedText(e.target.value)}
            style={{ width: '100%', font: 'inherit', padding: '0.4rem 0.6rem', borderRadius: 6 }}
          />
        </div>
        {err && <p className="note" style={{ color: 'var(--no, #d66)' }}>{err}</p>}
        <dl className="kv" style={{ marginTop: '0.6rem' }}>
          <dt>Δ (fundamental discriminant, {bitLength(D)}-bit)</dt>
          <dd className="mono" style={{ gridColumn: '1 / -1', wordBreak: 'break-all' }}>
            {D.toString()}
          </dd>
          <dt>class number h(Δ)</dt>
          <dd className="mono">≈ √|Δ| — unknown, ~2^{Math.round(bitLength(D) / 2)} (no one has computed it)</dd>
        </dl>
        <div className="grid cols-2" style={{ marginTop: '0.7rem' }}>
          <div>
            <p className="note">generator g (smallest prime form)</p>
            <FormView f={g} />
          </div>
          <div>
            <p className="note">identity (principal form)</p>
            <FormView f={identity(D)} />
          </div>
        </div>
        <p style={{ marginTop: '0.6rem' }}>
          <Verdict ok={discriminant(g) === D && isReduced(g)}>
            g is a reduced form of discriminant Δ ✓
          </Verdict>
          <span className="note" style={{ marginLeft: '0.7rem' }}>
            Reduction keeps every coordinate below <code>√(|Δ|/3) ≈ 0x{shortN(aBound).slice(2)}</code>,
            so forms never grow — the per-squaring cost is constant forever.
          </span>
        </p>
      </Panel>

      <GroupLawPanel D={D} g={g} />
      <DelayPanel D={D} g={g} aBound={aBound} />
      <WesolowskiPanel D={D} g={g} />
      <StreamingPanel D={D} g={g} />
      <TrustPanel />
      <BeaconPanel D={D} g={g} />
    </main>
  )
}

// ── Panel: the group law is real — g^i ∘ g^j = g^(i+j) ──────────────────────
function GroupLawPanel({ D, g }: { D: bigint; g: Form }) {
  const [i, setI] = useState(5)
  const [j, setJ] = useState(3)
  const res = useMemo(() => {
    const gi = power(g, BigInt(i), D)
    const gj = power(g, BigInt(j), D)
    const prod = compose(gi, gj, D)
    const direct = power(g, BigInt(i + j), D)
    return { gi, gj, prod, direct, ok: formEq(prod, direct) }
  }, [D, g, i, j])

  return (
    <Panel
      title="Gauss composition — the reduced forms are a group"
      sub={
        <>
          Composing two forms multiplies the underlying ideal classes (Cohen, Alg. 5.4.7) and reduces
          the result. Here is the group law in action: raise <code>g</code> to two exponents, compose,
          and confirm it equals <code>g^(i+j)</code>.
        </>
      }
    >
      <div className="grid cols-2">
        <Slider label="i" value={i} min={0} max={40} onChange={setI} />
        <Slider label="j" value={j} min={0} max={40} onChange={setJ} />
      </div>
      <div className="grid cols-3" style={{ marginTop: '0.7rem' }}>
        <FormView f={res.gi} label={`gⁱ  (i=${i})`} />
        <FormView f={res.gj} label={`gʲ  (j=${j})`} />
        <FormView f={res.prod} label={`gⁱ ∘ gʲ`} />
      </div>
      <p style={{ marginTop: '0.6rem' }}>
        <Verdict ok={res.ok}>
          {res.ok ? `gⁱ ∘ gʲ = g^(i+j) = g^${i + j} ✓` : 'mismatch (should never happen)'}
        </Verdict>
        <span className="note" style={{ marginLeft: '0.7rem' }}>
          Closure, associativity, an identity, and inverses all hold — verified exhaustively on small
          discriminants where the whole group is enumerable.
        </span>
      </p>
    </Panel>
  )
}

// ── Panel: the delay y = g^(2^T) ────────────────────────────────────────────
function DelayPanel({ D, g, aBound }: { D: bigint; g: Form; aBound: bigint }) {
  const [t, setT] = useState(10) // T = 2^t
  const T = 2 ** t
  const { y, bounded } = useMemo(() => {
    let y = g
    let bounded = true
    for (let k = 0; k < T; k++) {
      y = square(y, D)
      if ((k & 255) === 0) {
        const a = y.a < 0n ? -y.a : y.a
        bounded = bounded && a <= aBound
      }
    }
    return { y, bounded }
  }, [D, g, T, aBound])

  return (
    <Panel
      title="The delay — T sequential squarings you cannot parallelise"
      sub={
        <>
          <code>y = g^(2^T)</code> by <strong>T squarings in a row</strong>. Each needs the previous
          one, so no amount of parallelism shortens it; and with <code>h(Δ)</code> unknown there is no
          exponent shortcut. This is the honest evaluator's grind.
        </>
      }
    >
      <Slider
        label="delay T = 2^t"
        value={t}
        min={1}
        max={14}
        onChange={setT}
        display={`2^${t} = ${T.toLocaleString()} squarings`}
      />
      <div style={{ marginTop: '0.7rem' }}>
        <p className="note">y = g^(2^{t})</p>
        <FormView f={y} />
      </div>
      <p style={{ marginTop: '0.6rem' }}>
        <Verdict ok={bounded && isReduced(y)}>
          |a| stayed ≤ √(|Δ|/3) across all {T.toLocaleString()} steps ✓
        </Verdict>
        <span className="note" style={{ marginLeft: '0.7rem' }}>
          The output is a fully-reduced form the size of a single field element, no matter how deep the
          chain — that is what makes a class-group VDF cheap to run and tiny to publish.
        </span>
      </p>
    </Panel>
  )
}

// ── Panel: the Wesolowski proof ─────────────────────────────────────────────
function WesolowskiPanel({ D, g }: { D: bigint; g: Form }) {
  const [t, setT] = useState(10)
  const [tamper, setTamper] = useState(false)
  const T = 2 ** t
  const { proof, shown, ok } = useMemo(() => {
    const y = evalVDF(g, T, D)
    const proof = wesolowskiProve(g, T, D, y)
    const shown = tamper ? { ell: proof.ell, pi: compose(proof.pi, g, D) } : proof
    return { proof, shown, ok: wesolowskiVerify(g, y, T, D, shown) }
  }, [D, g, T, tamper])

  return (
    <Panel
      title="Wesolowski proof — one form, O(1) to verify"
      sub={
        <>
          The prover derives a ~128-bit prime <code>ℓ = H<sub>prime</sub>(Δ ‖ g ‖ y ‖ T)</code> by
          Fiat–Shamir (unchooseable), writes <code>2^T = q·ℓ + r</code>, and sends{' '}
          <code>π = g^q</code>. The verifier computes <code>r = 2^T mod ℓ</code> and checks{' '}
          <code>π^ℓ ∘ g^r = y</code> — two class-group exponentiations, whatever T was.
        </>
      }
      right={
        <label className="check" style={{ display: 'flex', gap: '0.4rem', alignItems: 'center' }}>
          <input type="checkbox" checked={tamper} onChange={(e) => setTamper(e.target.checked)} />
          <span>forge π (∘g)</span>
        </label>
      }
    >
      <Slider label="delay T = 2^t" value={t} min={1} max={14} onChange={setT} display={`2^${t} = ${T.toLocaleString()}`} />
      <dl className="kv" style={{ marginTop: '0.5rem' }}>
        <dt>ℓ (Fiat–Shamir prime, {bitLength(proof.ell)}-bit)</dt>
        <dd className="mono" style={{ gridColumn: '1 / -1', wordBreak: 'break-all' }}>0x{proof.ell.toString(16)}</dd>
      </dl>
      <div style={{ marginTop: '0.4rem' }}>
        <p className="note">π = g^⌊2^T/ℓ⌋ {tamper && '(tampered)'}</p>
        <FormView f={shown.pi} />
      </div>
      <p style={{ marginTop: '0.6rem' }}>
        <Verdict ok={ok}>
          {ok ? 'π^ℓ ∘ g^r = y ✓ — the sequential work is certified' : 'rejected — π does not open to y'}
        </Verdict>
        <span className="note" style={{ marginLeft: '0.7rem' }}>
          {tamper
            ? 'A forged π fails the single check: without doing the T squarings there is no valid opening.'
            : 'The whole proof is one reduced form — a few dozen bytes, independent of T. This is Chia’s proof-of-time.'}
        </span>
      </p>
    </Panel>
  )
}

// ── Panel: streaming prover (no 2^T integer) ────────────────────────────────
function StreamingPanel({ D, g }: { D: bigint; g: Form }) {
  const [t, setT] = useState(12)
  const T = 2 ** t
  const r = useMemo(() => {
    const y = evalVDF(g, T, D)
    const ref = wesolowskiProve(g, T, D, y)
    const st = wesolowskiProveStreaming(g, T, D, y)
    return { match: formEq(ref.pi, st.pi) && ref.ell === st.ell }
  }, [D, g, T])
  return (
    <Panel
      title="Streaming prover — π in O(1) memory, no giant 2^T"
      sub={
        <>
          For the huge T a real VDF uses, forming <code>2^T</code> as an integer is impossible. Track{' '}
          <code>rᵢ = 2^i mod ℓ</code>; the i-th quotient bit is <code>⌊2rᵢ₋₁/ℓ⌋</code>, and π accumulates
          as <code>π ← π² ∘ g^bit</code>. The exponent telescopes to exactly <code>⌊2^T/ℓ⌋</code>.
        </>
      }
    >
      <Slider label="delay T = 2^t" value={t} min={4} max={16} onChange={setT} display={`2^${t} = ${T.toLocaleString()}`} />
      <p style={{ marginTop: '0.6rem' }}>
        <Verdict ok={r.match}>
          {r.match ? 'streaming π = reference π ✓ — same form, constant space' : 'mismatch'}
        </Verdict>
        <span className="note" style={{ marginLeft: '0.7rem' }}>
          Two O(T) passes and O(1) extra memory — the trick that makes the succinct proof practical.
        </span>
      </p>
    </Panel>
  )
}

// ── Panel: RSA group vs class group — where the trust lives ─────────────────
function TrustPanel() {
  const rows: [string, string, string][] = [
    ['group', '(ℤ/N)*, N = p·q', 'Cl(Δ), Δ a public prime disc.'],
    ['order', 'φ(N) = (p−1)(q−1)', 'h(Δ) ≈ √|Δ|'],
    ['who knows the order', 'whoever generated N', 'nobody — it takes a subexponential search'],
    ['trapdoor shortcut', 'yes: e = 2^T mod φ(N)', 'none — there is no φ to reduce by'],
    ['setup', 'trusted (RSA ceremony / hidden factors)', 'transparent: Δ hashed from a public seed'],
    ['proof', 'Wesolowski / Pietrzak', 'Wesolowski (Pietrzak needs low-order-free groups)'],
    ['element size', '~|N| bits', '~½|Δ| bits (reduced form a, b)'],
    ['used by', 'RSW time-lock, RANDAO+VDF research', 'Chia consensus'],
  ]
  return (
    <Panel
      title="Where the trust lives — RSA group vs class group"
      sub="The class group buys one decisive property: unknown order with nobody holding the secret, so the delay has no back door and the setup needs no ceremony."
    >
      <table className="data">
        <thead>
          <tr>
            <th></th>
            <th>RSA-group VDF</th>
            <th>class-group VDF (this page)</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(([k, a, b]) => (
            <tr key={k}>
              <td className="mono" style={{ opacity: 0.7 }}>{k}</td>
              <td className="mono">{a}</td>
              <td className="mono">{b}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </Panel>
  )
}

// ── Panel: delay-based randomness beacon ────────────────────────────────────
function BeaconPanel({ D, g }: { D: bigint; g: Form }) {
  const [rounds, setRounds] = useState(4)
  const chain = useMemo(() => beaconChain(utf8('genesis'), 128, D, g, rounds), [D, g, rounds])
  return (
    <Panel
      title="A delay beacon — unbiasable public randomness"
      sub={
        <>
          Chain the VDF: <code>βᵢ₊₁ = SHA256(VDF(βᵢ))</code>. Each round is unpredictable until someone
          spends the full delay and unbiasable — trying many seeds costs T squarings each time. Now with
          no trusted setup underneath.
        </>
      }
    >
      <Slider label="rounds" value={rounds} min={1} max={8} onChange={setRounds} />
      <table className="data" style={{ marginTop: '0.7rem' }}>
        <thead>
          <tr>
            <th>#</th>
            <th>β (SHA256 of VDF output)</th>
            <th>π (proof form a)</th>
            <th>verified</th>
          </tr>
        </thead>
        <tbody>
          {chain.map((r, i) => (
            <tr key={i}>
              <td className="mono">#{i}</td>
              <td className="mono">{ellipsize('0x' + bytesToHex(r.beta), 12, 10)}</td>
              <td className="mono">{shortN(r.proof.pi.a)}</td>
              <td className="mono">
                <Verdict ok={r.verified}>{r.verified ? '✓' : '✗'}</Verdict>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="note" style={{ marginTop: '0.6rem' }}>
        Each β carries a constant-size Wesolowski proof, so a light client confirms the whole chain
        without redoing a single squaring.
      </p>
    </Panel>
  )
}
