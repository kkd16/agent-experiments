import { useEffect, useMemo, useRef, useState } from 'react'
import { PageHead, Panel, Verdict } from '../ui/components'
import {
  RSA,
  toGenerator,
  evalVDF,
  evalTrapdoor,
  bitLength,
  wesolowskiProve,
  wesolowskiVerify,
  pietrzakProve,
  pietrzakVerify,
  timeLock,
  openWith,
  beaconChain,
  type TimeLockPuzzle,
} from '../ecc/vdf'
import { bytesToHex, utf8 } from '../ecc/sha256'
import { ellipsize } from '../ui/format'

const N = RSA.N
const PHI = RSA.phi
const hexN = (v: bigint) => v.toString(16).padStart(128, '0')

// A short hex preview for a group element.
const short = (v: bigint) => ellipsize('0x' + v.toString(16), 12, 8)

export function VdfPage() {
  // ── Shared statement: x = seed² mod N (a QR generator), T = 2^t ──
  const [seedText, setSeedText] = useState('curvefield')
  const [t, setT] = useState(12) // T = 2^t, capped so the interactive proofs stay snappy
  const T = 2 ** t

  const x = useMemo(() => {
    let s = 0n
    for (const ch of utf8(seedText)) s = (s * 257n + BigInt(ch) + 1n) % N
    return toGenerator(s + 2n, N)
  }, [seedText])

  // Honest evaluation (T squarings) and the trapdoor shortcut — must agree.
  const evald = useMemo(() => {
    const yHonest = evalVDF(x, T, N)
    const yTrap = evalTrapdoor(x, T, N, PHI)
    return { yHonest, yTrap, agree: yHonest === yTrap }
  }, [x, T])
  const y = evald.yHonest

  // ── Wesolowski proof ──
  const [wTamper, setWTamper] = useState(false)
  const weso = useMemo(() => {
    const proof = wesolowskiProve(x, T, N, y)
    const shown = wTamper ? { ...proof, pi: (proof.pi + 1n) % N } : proof
    const ok = wesolowskiVerify(x, y, T, N, shown)
    return { proof: shown, ok }
  }, [x, y, T, wTamper])

  // ── Pietrzak proof ──
  const [pTamper, setPTamper] = useState(false)
  const piet = useMemo(() => {
    const proof = pietrzakProve(x, T, N, y)
    const shown = pTamper
      ? { mus: proof.mus.map((m, i) => (i === Math.floor(proof.mus.length / 2) ? (m + 1n) % N : m)) }
      : proof
    const ok = pietrzakVerify(x, y, T, N, shown)
    return { proof: shown, ok, full: proof }
  }, [x, y, T, pTamper])

  return (
    <main className="page">
      <PageHead eyebrow="Lab — proof of sequential time" title="Verifiable Delay Functions">
        A VDF is the time-analogue of the VRF next door: where a VRF makes randomness{' '}
        <em>unpredictable yet checkable</em>, a VDF makes <em>elapsed sequential work</em>{' '}
        <em>unforgeable yet checkable</em>. You compute <code>y = x^(2^T) mod N</code> by{' '}
        <strong>T squarings in a row</strong> — a chain no parallel machine can shorten, because each
        square needs the one before it — and then anyone verifies <code>y</code> in a heartbeat. That
        gap between <em>slow to make, fast to check</em> is what powers an unbiasable randomness beacon:
        a value nobody can grind out early and nobody can bias, because every candidate output costs the
        full delay. This is a from-scratch construction in an RSA group, with <strong>both</strong> the
        succinct Wesolowski proof and the log-size Pietrzak halving proof, a Rivest–Shamir–Wagner
        time-lock puzzle, and a delay beacon — all pinned against the trapdoor evaluation and against
        forgery on the Self-Test page.
      </PageHead>

      <Panel
        title="The statement"
        sub={
          <>
            The group is (ℤ/Nℤ)<sup>×</sup> for a fixed 512-bit Blum modulus N = p·q. The input is a
            quadratic residue x = seed² mod N (squaring lands in QR<sub>N</sub>, where −1 has no square
            root — the cleanest setting for the halving proof). T = 2<sup>{t}</sup> = {T.toLocaleString()}.
          </>
        }
      >
        <div className="grid cols-2" style={{ gap: '1rem', alignItems: 'end' }}>
          <div className="field">
            <label>
              <span>seed → input x</span>
            </label>
            <input value={seedText} onChange={(e) => setSeedText(e.target.value)} spellCheck={false} />
          </div>
          <div className="field">
            <label>
              <span>delay T = 2^t</span>
              <span className="val">2^{t} = {T.toLocaleString()}</span>
            </label>
            <input type="range" min={1} max={16} value={t} onChange={(e) => setT(Number(e.target.value))} />
          </div>
        </div>
        <dl className="kv" style={{ marginTop: '0.8rem' }}>
          <dt>N (modulus, 512-bit)</dt>
          <dd className="hexbox" style={{ gridColumn: '1 / -1' }}>{hexN(N)}</dd>
          <dt>x = input (QR generator)</dt>
          <dd className="hexbox violet" style={{ gridColumn: '1 / -1' }}>{hexN(x)}</dd>
          <dt>y = x^(2^T) mod N</dt>
          <dd className="hexbox lavender" style={{ gridColumn: '1 / -1' }}>{hexN(y)}</dd>
        </dl>
      </Panel>

      <Panel
        title="Sequentiality — the honest grind vs the trapdoor shortcut"
        sub="Squaring T times is inherently serial. But whoever knows the factorisation can leap to the answer: e = 2^T mod φ(N), then y = x^e in log-time. That shortcut is exactly why a real VDF modulus must be a number nobody has factored."
      >
        <div className="flow-h" style={{ flexWrap: 'wrap', gap: '0.8rem' }}>
          <div className="flow-step" style={{ flex: '1 1 260px' }}>
            <strong>Honest evaluator</strong>
            <p className="note">
              Knows only (x, T, N). Must do all {T.toLocaleString()} squarings in sequence — no
              parallelism helps. This is the <em>delay</em>.
            </p>
            <div className="hexbox">{short(evald.yHonest)}</div>
          </div>
          <div className="flow-step" style={{ flex: '1 1 260px' }}>
            <strong>Trapdoor holder (setup authority)</strong>
            <p className="note">
              Knows φ(N) = (p−1)(q−1). Computes e = 2<sup>T</sup> mod φ(N), a small exponent, then
              y = x<sup>e</sup> — instantly. No delay at all.
            </p>
            <div className="hexbox">{short(evald.yTrap)}</div>
          </div>
        </div>
        <p style={{ marginTop: '0.7rem' }}>
          <Verdict ok={evald.agree}>
            {evald.agree
              ? 'both paths reach the same y — the shortcut is real'
              : 'mismatch (should never happen)'}
          </Verdict>
          <span className="note" style={{ marginLeft: '0.7rem' }}>
            In production the modulus is an RSA-2048 challenge number or a{' '}
            <strong>class group of an imaginary quadratic order</strong> (unknown order with{' '}
            <em>no trusted setup</em>), so this shortcut is available to no one.
          </span>
        </p>
      </Panel>

      <Panel
        title="Wesolowski proof — one group element, O(1) to verify"
        sub={
          <>
            The prover derives a ~128-bit prime ℓ = H<sub>prime</sub>(N ‖ x ‖ y ‖ T) by Fiat–Shamir
            (it cannot be chosen), writes 2<sup>T</sup> = q·ℓ + r, and sends π = x<sup>q</sup>. The
            verifier computes r = 2<sup>T</sup> mod ℓ (fast) and checks π<sup>ℓ</sup>·x<sup>r</sup> = y.
            One exponentiation — no matter how large T is.
          </>
        }
        right={
          <label className="check" style={{ display: 'flex', gap: '0.4rem', alignItems: 'center' }}>
            <input type="checkbox" checked={wTamper} onChange={(e) => setWTamper(e.target.checked)} />
            <span>tamper (π+1)</span>
          </label>
        }
      >
        <dl className="kv">
          <dt>ℓ (Fiat–Shamir prime, {bitLength(weso.proof.ell)}-bit)</dt>
          <dd className="mono" style={{ gridColumn: '1 / -1' }}>0x{weso.proof.ell.toString(16)}</dd>
          <dt>π = x^⌊2^T/ℓ⌋</dt>
          <dd className="hexbox" style={{ gridColumn: '1 / -1' }}>{hexN(weso.proof.pi)}</dd>
        </dl>
        <p style={{ marginTop: '0.6rem' }}>
          <Verdict ok={weso.ok}>
            {weso.ok ? 'π^ℓ · x^r = y ✓ — the delay is certified' : 'rejected — π does not certify y'}
          </Verdict>
          <span className="note" style={{ marginLeft: '0.7rem' }}>
            {wTamper
              ? 'A forged π fails the single check: there is no shortcut to a valid opening without doing the work.'
              : 'The proof is a constant 64 bytes whatever T is — this is the version Chia and Ethereum research favour.'}
          </span>
        </p>
      </Panel>

      <Panel
        title="Pietrzak proof — the halving protocol, O(log T) elements"
        sub={
          <>
            Repeatedly halve the claim. Send the midpoint μ = x^(2^(T/2)); a Fiat–Shamir challenge r
            folds (x, y, T) into (x<sup>r</sup>·μ, μ<sup>r</sup>·y, T/2), a smaller claim that is true
            iff the original was. After {t} halving{t === 1 ? '' : 's'} the claim is just y = x², checked
            directly. The proof is these {piet.full.mus.length} midpoint{piet.full.mus.length === 1 ? '' : 's'}.
          </>
        }
        right={
          <label className="check" style={{ display: 'flex', gap: '0.4rem', alignItems: 'center' }}>
            <input type="checkbox" checked={pTamper} onChange={(e) => setPTamper(e.target.checked)} />
            <span>tamper (flip a μ)</span>
          </label>
        }
      >
        <table className="data">
          <thead>
            <tr>
              <th>level</th>
              <th>remaining T</th>
              <th>midpoint μ = x^(2^(T/2))</th>
            </tr>
          </thead>
          <tbody>
            {piet.proof.mus.map((m, i) => (
              <tr key={i}>
                <td className="mono">{i}</td>
                <td className="mono">2^{t - i} = {(2 ** (t - i)).toLocaleString()}</td>
                <td className="mono">{short(m)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <p style={{ marginTop: '0.6rem' }}>
          <Verdict ok={piet.ok}>
            {piet.ok ? 'all challenges re-derive and y = x² closes ✓' : 'rejected — a midpoint is inconsistent'}
          </Verdict>
          <span className="note" style={{ marginLeft: '0.7rem' }}>
            {pTamper
              ? 'One altered midpoint breaks the folded equality at that level and every level after.'
              : 'Bigger proof than Wesolowski, but the prover only pays ~2× the evaluation — no giant-exponent step.'}
          </span>
        </p>
      </Panel>

      <ProofSizePanel maxT={16} />
      <TimeLockPanel />
      <BeaconPanel />
    </main>
  )
}

// ── Panel: proof-size / cost comparison across T ─────────────────────────────
function ProofSizePanel({ maxT }: { maxT: number }) {
  const rows = useMemo(() => {
    const out: { t: number; weso: number; piet: number }[] = []
    for (let t = 4; t <= maxT + 8; t += 4) out.push({ t, weso: 1, piet: t })
    return out
  }, [maxT])
  return (
    <Panel
      title="Two proofs, two trade-offs"
      sub="Both certify the same delay. Wesolowski is a single element (64 B) regardless of T; Pietrzak grows as log₂T but skips the big-exponent division. Group elements in each proof:"
    >
      <table className="data">
        <thead>
          <tr>
            <th>T</th>
            <th>Wesolowski</th>
            <th>Pietrzak (log₂T)</th>
            <th style={{ width: '45%' }}>&nbsp;</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.t}>
              <td className="mono">2^{r.t}</td>
              <td className="mono">{r.weso} elt</td>
              <td className="mono">{r.piet} elts</td>
              <td>
                <div style={{ display: 'flex', gap: '3px', alignItems: 'center' }}>
                  <div style={{ height: '10px', width: `${r.weso * 8}px`, background: '#b794f6', borderRadius: '3px' }} />
                  <div style={{ height: '10px', width: `${r.piet * 8}px`, background: '#5eead4', borderRadius: '3px' }} />
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="note" style={{ marginTop: '0.6rem' }}>
        <span style={{ color: '#b794f6' }}>■ Wesolowski</span> &nbsp;
        <span style={{ color: '#5eead4' }}>■ Pietrzak</span> — verification is O(1) exponentiations for
        Wesolowski and O(log T) for Pietrzak; neither verifier repeats the T squarings.
      </p>
    </Panel>
  )
}

// ── Panel: RSW time-lock puzzle with a live grind ────────────────────────────
const CHUNK = 3000 // squarings per animation tick

function TimeLockPanel() {
  const [message, setMessage] = useState('The vault opens in the future, not before. 🔒')
  const [lockT, setLockT] = useState(17) // 2^17 ≈ a visible grind
  const [puzzle, setPuzzle] = useState<TimeLockPuzzle | null>(null)
  const [progress, setProgress] = useState(0) // squarings done
  const [running, setRunning] = useState(false)
  const [revealed, setRevealed] = useState<string | null>(null)
  const stateRef = useRef<{ value: bigint; step: number } | null>(null)

  const T = 2 ** lockT

  const lock = () => {
    const p = timeLock(utf8(message), T, N, PHI, 3n)
    setPuzzle(p)
    setProgress(0)
    setRevealed(null)
    setRunning(false)
    stateRef.current = null
  }

  const grind = () => {
    if (!puzzle) return
    stateRef.current = { value: puzzle.a % N, step: 0 }
    setProgress(0)
    setRevealed(null)
    setRunning(true)
  }

  useEffect(() => {
    if (!running || !puzzle) return
    let cancelled = false
    const tick = () => {
      if (cancelled) return
      const st = stateRef.current
      if (!st) return
      const end = Math.min(st.step + CHUNK, puzzle.T)
      let v = st.value
      for (let i = st.step; i < end; i++) v = (v * v) % N
      st.value = v
      st.step = end
      setProgress(end)
      if (end >= puzzle.T) {
        const msg = openWith(puzzle, v)
        try {
          setRevealed(new TextDecoder().decode(msg))
        } catch {
          setRevealed(bytesToHex(msg))
        }
        setRunning(false)
      } else {
        setTimeout(tick, 0)
      }
    }
    const id = setTimeout(tick, 0)
    return () => {
      cancelled = true
      clearTimeout(id)
    }
  }, [running, puzzle])

  const pct = puzzle ? Math.round((progress / puzzle.T) * 100) : 0

  return (
    <Panel
      title="Application — a time-lock puzzle (encrypt to the future)"
      sub="Rivest–Shamir–Wagner, 1996 — the LCS35 “time capsule”. The creator, who knows φ, locks a message in an instant via the trapdoor; anyone opening it must grind the full squaring chain. Same delay, security flipped: here the wait IS the lock."
    >
      <div className="grid cols-2" style={{ gap: '1rem', alignItems: 'end' }}>
        <div className="field">
          <label>
            <span>secret message</span>
          </label>
          <input value={message} onChange={(e) => setMessage(e.target.value)} spellCheck={false} />
        </div>
        <div className="field">
          <label>
            <span>work factor T = 2^t</span>
            <span className="val">2^{lockT} = {T.toLocaleString()}</span>
          </label>
          <input type="range" min={12} max={20} value={lockT} onChange={(e) => setLockT(Number(e.target.value))} />
        </div>
      </div>
      <div className="btn-row" style={{ marginTop: '0.8rem', display: 'flex', gap: '0.6rem', flexWrap: 'wrap' }}>
        <button className="btn" onClick={lock}>🔒 Lock (creator, trapdoor — instant)</button>
        <button className="btn" onClick={grind} disabled={!puzzle || running}>
          {running ? '⏳ grinding…' : '🔓 Grind to open (T squarings)'}
        </button>
      </div>

      {puzzle && (
        <>
          <dl className="kv" style={{ marginTop: '0.8rem' }}>
            <dt>ciphertext ({puzzle.ct.length} B)</dt>
            <dd className="hexbox" style={{ gridColumn: '1 / -1' }}>{bytesToHex(puzzle.ct)}</dd>
          </dl>
          <div className="track" style={{ marginTop: '0.7rem', height: '14px', borderRadius: '7px', background: 'rgba(255,255,255,0.08)', overflow: 'hidden' }}>
            <div
              className="fill"
              style={{ height: '100%', width: `${pct}%`, background: 'linear-gradient(90deg,#b794f6,#5eead4)', transition: 'width 0.05s linear' }}
            />
          </div>
          <p className="note" style={{ marginTop: '0.4rem' }}>
            {progress.toLocaleString()} / {puzzle.T.toLocaleString()} squarings ({pct}%)
            {running ? ' — each one depends on the last; no shortcut without φ.' : ''}
          </p>
          {revealed !== null && (
            <p style={{ marginTop: '0.6rem' }}>
              <Verdict ok>opened</Verdict>{' '}
              <span className="mono" style={{ marginLeft: '0.5rem' }}>{revealed}</span>
            </p>
          )}
        </>
      )}
    </Panel>
  )
}

// ── Panel: delay-based randomness beacon ─────────────────────────────────────
function BeaconPanel() {
  const [rounds, setRounds] = useState(4)
  const [bt, setBt] = useState(10) // T per round = 2^bt
  const [seed, setSeed] = useState('block #820000')

  const chain = useMemo(
    () => beaconChain(utf8(seed), 2 ** bt, N, rounds),
    [seed, bt, rounds],
  )

  return (
    <Panel
      title="Application — an unbiasable randomness beacon"
      sub="Chain the VDF: βᵢ₊₁ = SHA256(VDF(βᵢ)). Each round's output is unknowable until someone spends the delay, and unbiasable — a manipulator cannot try many seeds and keep a favourable one, because every attempt costs the full T squarings. This is the RANDAO+VDF shape (Ethereum) and the heart of Chia's proof-of-time."
    >
      <div className="grid cols-3" style={{ gap: '1rem', alignItems: 'end' }}>
        <div className="field">
          <label>
            <span>genesis seed</span>
          </label>
          <input value={seed} onChange={(e) => setSeed(e.target.value)} spellCheck={false} />
        </div>
        <div className="field">
          <label>
            <span>rounds</span>
            <span className="val">{rounds}</span>
          </label>
          <input type="range" min={2} max={8} value={rounds} onChange={(e) => setRounds(Number(e.target.value))} />
        </div>
        <div className="field">
          <label>
            <span>delay / round</span>
            <span className="val">2^{bt}</span>
          </label>
          <input type="range" min={6} max={14} value={bt} onChange={(e) => setBt(Number(e.target.value))} />
        </div>
      </div>
      <table className="data" style={{ marginTop: '0.9rem' }}>
        <thead>
          <tr>
            <th>round</th>
            <th>β (beacon output)</th>
            <th>Wesolowski π</th>
            <th>proof</th>
          </tr>
        </thead>
        <tbody>
          {chain.map((r, i) => (
            <tr key={i}>
              <td className="mono">#{i}</td>
              <td className="mono">{ellipsize('0x' + bytesToHex(r.beta), 12, 10)}</td>
              <td className="mono">{short(r.proof.pi)}</td>
              <td><Verdict ok={r.verified}>{r.verified ? 'verified' : 'bad'}</Verdict></td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="note" style={{ marginTop: '0.6rem' }}>
        Every β carries a proof that its delay was actually spent, so a light client trusts the beacon
        without redoing the work — and no producer can grind ahead to bias tomorrow's draw.
      </p>
    </Panel>
  )
}
