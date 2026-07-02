import { useMemo, useState } from 'react'
import { PageHead, Panel, Verdict } from '../ui/components'
import {
  ecvrfKeygen,
  ecvrfProve,
  ecvrfVerify,
  proofToBytes,
  proofToHash,
  encodeToCurveTAI,
  type Suite,
  type VrfProof,
} from '../ecc/ecvrf'
import { sha512 } from '../ecc/sha512'
import { bytesToHex, hexToBytes, utf8 } from '../ecc/sha256'
import { randomBytes } from '../ecc/rng'
import { ellipsize } from '../ui/format'

// A deterministic 32-byte seed for a demo participant, stable across renders.
const derive = (label: string): Uint8Array => sha512(utf8('curvefield-vrf|' + label)).slice(0, 32)

// First 6 bytes of β as a fraction in [0,1) — the "lottery ticket".
const ticket = (beta: Uint8Array): number => {
  let n = 0
  for (let i = 0; i < 6; i++) n = n * 256 + beta[i]
  return n / 2 ** 48
}

const COLORS = ['#b794f6', '#5eead4', '#fbbf24', '#fb7185', '#60a5fa', '#34d399', '#f472b6', '#a78bfa']

// RFC 9381 Appendix B — the first Edwards25519 example (SK/PK from RFC 8032 §7.1).
const RFC_SK = '9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60'
const RFC_PI: Record<Suite, string> = {
  TAI: '8657106690b5526245a92b003bb079ccd1a92130477671f6fc01ad16f26f723f26f8a57ccaed74ee1b190bed1f479d9727d2d0f9b005a6e456a35d4fb0daab1268a1b0db10836d9826a528ca76567805',
  ELL2: '7d9c633ffeee27349264cf5c667579fc583b4bda63ab71d001f89c10003ab46f14adf9a3cd8b8412d9038531e865c341cafa73589b023d14311c331a9ad15ff2fb37831e00f0acaa6d73bc9997b06501',
}

export function VrfPage() {
  const [suite, setSuite] = useState<Suite>('ELL2')
  const [seedHex, setSeedHex] = useState('c5aa8df43f9f837bedb7442f31dcb7b166d38535076f094b85ce3a2e0b4458f7')
  const [alpha, setAlpha] = useState('leader election, epoch 42')
  const [tamper, setTamper] = useState(false)
  const [nPlayers, setNPlayers] = useState(6)
  const [epoch, setEpoch] = useState('block #820000 seed')

  const seed = useMemo(() => {
    try {
      const b = hexToBytes(seedHex.trim())
      return b.length === 32 ? b : derive(seedHex)
    } catch {
      return derive(seedHex)
    }
  }, [seedHex])

  const alphaBytes = useMemo(() => utf8(alpha), [alpha])
  const pk = useMemo(() => ecvrfKeygen(seed), [seed])

  const result = useMemo(() => {
    const pi = ecvrfProve(suite, seed, alphaBytes)
    const beta = proofToHash(suite, pi)
    return { pi, beta, piBytes: proofToBytes(pi) }
  }, [suite, seed, alphaBytes])

  // The proof the verifier actually checks (optionally corrupted).
  const verified = useMemo(() => {
    const checked: VrfProof = tamper ? { ...result.pi, s: result.pi.s ^ 1n } : result.pi
    return ecvrfVerify(suite, pk, alphaBytes, checked)
  }, [suite, pk, alphaBytes, result, tamper])

  // The try-and-increment counter (only meaningful for TAI).
  const taiCtr = useMemo(() => {
    try {
      return encodeToCurveTAI(pk, alphaBytes).ctr
    } catch {
      return -1
    }
  }, [pk, alphaBytes])

  // Does this exact (seed, α, suite) reproduce the published RFC 9381 proof?
  const matchesRfc =
    seedHex.trim().toLowerCase() === RFC_SK && alpha === '' && bytesToHex(result.piBytes) === RFC_PI[suite]

  // ── Verifiable lottery / leader election ──
  const lottery = useMemo(() => {
    const epochBytes = utf8(epoch)
    const players = Array.from({ length: nPlayers }, (_, i) => {
      const s = derive('player-' + i)
      const P = ecvrfKeygen(s)
      const pi = ecvrfProve(suite, s, epochBytes)
      const beta = proofToHash(suite, pi)
      const ok = ecvrfVerify(suite, P, epochBytes, pi)
      return { i, pk: P, pi, beta, t: ticket(beta), ok }
    })
    const winner = players.reduce((a, b) => (b.t < a.t ? b : a), players[0])
    return { players, winnerIdx: winner.i }
  }, [suite, nPlayers, epoch])

  return (
    <main className="page">
      <PageHead eyebrow="Lab — verifiable randomness (RFC 9381)" title="ECVRF — Verifiable Random Functions">
        A VRF is a public-key function whose output is <em>unpredictable</em> yet <em>publicly
        verifiable</em>. The key holder computes <code>β = VRF(sk, α)</code> together with a proof{' '}
        <code>π</code>; anyone with the public key checks <code>π</code> and is convinced <code>β</code>{' '}
        is the one true output for <code>(pk, α)</code> — but nobody can predict or bias it without the
        key. It is, in effect, a signature whose hash is unique and uniformly random. That is what runs
        leader election in Algorand, randomness beacons in Chainlink and Cardano, and hashed-name
        privacy (NSEC5) in DNSSEC. This is a from-scratch implementation of the two Edwards25519
        ciphersuites of <strong>RFC 9381</strong>, pinned byte-for-byte to the standard's own vectors on
        the Self-Test page.
      </PageHead>

      <Panel
        title="Ciphersuite"
        sub="Both hash α to a curve point, then prove Γ = x·H in zero knowledge. TAI does it by try-and-increment; ELL2 by the constant-time Elligator2 map."
      >
        <div className="seg">
          <button className={suite === 'TAI' ? 'on' : ''} onClick={() => setSuite('TAI')}>
            ECVRF-EDWARDS25519-SHA512-TAI
          </button>
          <button className={suite === 'ELL2' ? 'on' : ''} onClick={() => setSuite('ELL2')}>
            ECVRF-EDWARDS25519-SHA512-ELL2
          </button>
        </div>
      </Panel>

      <Panel
        title="Key & input"
        sub="The secret is a 32-byte Ed25519 seed; the public key is Y = x·B. α is any message."
        right={
          <button className="btn" onClick={() => setSeedHex(bytesToHex(randomBytes(32)))}>
            ↻ new key
          </button>
        }
      >
        <div className="field">
          <label><span>secret seed (32-byte hex)</span></label>
          <input value={seedHex} onChange={(e) => setSeedHex(e.target.value)} spellCheck={false} />
        </div>
        <div className="field" style={{ marginTop: '0.6rem' }}>
          <label><span>input α</span></label>
          <input value={alpha} onChange={(e) => setAlpha(e.target.value)} spellCheck={false} />
        </div>
        <dl className="kv" style={{ marginTop: '0.8rem' }}>
          <dt>public key Y</dt>
          <dd className="hexbox violet" style={{ gridColumn: '1 / -1' }}>{bytesToHex(pk)}</dd>
        </dl>
        <div style={{ marginTop: '0.6rem' }}>
          <button className="btn" onClick={() => { setSeedHex(RFC_SK); setAlpha('') }}>
            load RFC 9381 vector (α = empty)
          </button>
          {matchesRfc && (
            <span style={{ marginLeft: '0.7rem' }}>
              <Verdict ok>π matches RFC 9381 byte-for-byte ✓</Verdict>
            </span>
          )}
        </div>
      </Panel>

      <Panel
        title="Prove — β and its proof π"
        sub={
          suite === 'TAI'
            ? `H = encode_to_curve(Y, α) found at try-and-increment counter ${taiCtr}. Γ = x·H; the proof is a Fiat–Shamir NIZK that logₕ Γ = log_B Y.`
            : 'H = Elligator2(Y ‖ α), a constant-time hash-to-curve. Γ = x·H; the proof is a Fiat–Shamir NIZK that logₕ Γ = log_B Y.'
        }
      >
        <dl className="kv">
          <dt>β = VRF output (64 B)</dt>
          <dd className="hexbox lavender" style={{ gridColumn: '1 / -1' }}>{bytesToHex(result.beta)}</dd>
          <dt>Γ (gamma point)</dt>
          <dd className="hexbox" style={{ gridColumn: '1 / -1' }}>{bytesToHex(result.pi.gamma)}</dd>
          <dt>c (challenge, 16 B)</dt>
          <dd className="mono">{result.pi.c.toString(16).padStart(32, '0')}</dd>
          <dt>s (response, 32 B)</dt>
          <dd className="mono">{ellipsize(result.pi.s.toString(16).padStart(64, '0'), 20, 12)}</dd>
          <dt>π = proof (80 B)</dt>
          <dd className="hexbox" style={{ gridColumn: '1 / -1' }}>{bytesToHex(result.piBytes)}</dd>
        </dl>
      </Panel>

      <Panel
        title="Verify"
        sub="The verifier re-derives H from (Y, α), recomputes the commitment, and checks the challenge closes. It never sees the secret."
        right={
          <label className="check" style={{ display: 'flex', gap: '0.4rem', alignItems: 'center' }}>
            <input type="checkbox" checked={tamper} onChange={(e) => setTamper(e.target.checked)} />
            <span>tamper with π (flip 1 bit of s)</span>
          </label>
        }
      >
        <Verdict ok={verified}>
          {verified
            ? 'valid — π proves β is the unique VRF output for (Y, α)'
            : 'invalid — the proof does not verify under (Y, α)'}
        </Verdict>
        <p className="note" style={{ marginTop: '0.6rem' }}>
          {tamper
            ? 'A single flipped bit of the response scalar makes c′ ≠ c, and verification rejects — the proof is non-malleable.'
            : 'Exactly one β verifies per (pk, α): the signer cannot present two different outputs, and cannot steer the one output — that is the “unique provability” a VRF gives you over an ordinary signature.'}
        </p>
      </Panel>

      <Panel
        title="Application — a verifiable lottery / leader election"
        sub="Every participant evaluates the VRF on the same epoch seed. The smallest ticket wins. Because each β is unpredictable before the epoch, unbiasable by its owner, and checkable by everyone, no one can grind their key to win — yet all can verify the winner."
      >
        <div className="grid cols-2" style={{ gap: '1rem', alignItems: 'end' }}>
          <div className="field">
            <label><span>participants</span><span className="val">{nPlayers}</span></label>
            <input type="range" min={2} max={8} value={nPlayers} onChange={(e) => setNPlayers(Number(e.target.value))} />
          </div>
          <div className="field">
            <label><span>epoch randomness (public α)</span></label>
            <input value={epoch} onChange={(e) => setEpoch(e.target.value)} spellCheck={false} />
          </div>
        </div>
        <table className="data" style={{ marginTop: '0.9rem' }}>
          <thead>
            <tr>
              <th>participant</th>
              <th>ticket = β mod 1</th>
              <th style={{ width: '40%' }}>&nbsp;</th>
              <th>proof</th>
            </tr>
          </thead>
          <tbody>
            {lottery.players.map((p) => (
              <tr key={p.i} style={p.i === lottery.winnerIdx ? { background: 'rgba(183,148,246,0.12)' } : undefined}>
                <td style={{ color: COLORS[p.i % COLORS.length] }}>
                  {p.i === lottery.winnerIdx ? '★ ' : ''}player #{p.i + 1}
                </td>
                <td className="mono">{p.t.toFixed(6)}</td>
                <td>
                  <div style={{ height: '10px', borderRadius: '5px', background: COLORS[p.i % COLORS.length], width: `${Math.max(2, p.t * 100)}%`, opacity: p.i === lottery.winnerIdx ? 1 : 0.5 }} />
                </td>
                <td><Verdict ok={p.ok}>{p.ok ? 'verifies' : 'bad'}</Verdict></td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="note" style={{ marginTop: '0.6rem' }}>
          Player #{lottery.winnerIdx + 1} is the elected leader for this epoch. Anyone can re-run each
          VRF proof against that player's public key and the public epoch seed to confirm the election
          was fair — no trusted beacon, no way to bias the draw.
        </p>
      </Panel>
    </main>
  )
}
