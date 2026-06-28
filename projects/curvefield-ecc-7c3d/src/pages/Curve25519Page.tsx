import { useMemo, useState } from 'react'
import { PageHead, Panel, Verdict } from '../ui/components'
import {
  x25519,
  x25519Public,
  ed25519Public,
  ed25519Sign,
  ed25519Verify,
  clampScalar,
} from '../ecc/ed25519'
import { bytesToHex, utf8 } from '../ecc/sha256'
import { randomBytes } from '../ecc/rng'

type Tab = 'x25519' | 'ed25519' | 'compare'

export function Curve25519Page() {
  const [tab, setTab] = useState<Tab>('x25519')
  return (
    <main className="page">
      <PageHead eyebrow="Lab 10 — a second backend" title="Curve25519 · X25519 & Ed25519">
        secp256k1 is a short-Weierstrass curve. Curve25519 is a different design point: same
        underlying idea, but engineered for speed and misuse-resistance. Its key exchange (X25519)
        runs a constant-time Montgomery ladder on x-coordinates alone, and its signatures (Ed25519)
        live on the birationally-equivalent twisted-Edwards form with a complete addition law. Both
        are built here from scratch and checked against the RFC 7748 / RFC 8032 vectors.
      </PageHead>

      <div className="seg" style={{ marginBottom: '1.2rem' }}>
        <button className={tab === 'x25519' ? 'on' : ''} onClick={() => setTab('x25519')}>
          X25519 (ECDH)
        </button>
        <button className={tab === 'ed25519' ? 'on' : ''} onClick={() => setTab('ed25519')}>
          Ed25519 (EdDSA)
        </button>
        <button className={tab === 'compare' ? 'on' : ''} onClick={() => setTab('compare')}>
          Three forms
        </button>
      </div>

      {tab === 'x25519' && <X25519Lab />}
      {tab === 'ed25519' && <Ed25519Lab />}
      {tab === 'compare' && <CompareLab />}
    </main>
  )
}

function X25519Lab() {
  const [seed, setSeed] = useState(0)
  const [aPriv, bPriv] = useMemo(() => {
    void seed
    return [randomBytes(32), randomBytes(32)]
  }, [seed])

  const aPub = useMemo(() => x25519Public(aPriv), [aPriv])
  const bPub = useMemo(() => x25519Public(bPriv), [bPriv])
  const ssA = useMemo(() => x25519(aPriv, bPub), [aPriv, bPub])
  const ssB = useMemo(() => x25519(bPriv, aPub), [bPriv, aPub])
  const agree = bytesToHex(ssA) === bytesToHex(ssB)

  return (
    <>
      <div className="statline" style={{ marginBottom: '1.4rem' }}>
        <div className="stat"><b>2²⁵⁵−19</b><span>field prime</span></div>
        <div className="stat"><b>u = 9</b><span>base point</span></div>
        <div className="stat"><b>ladder</b><span>constant-time, x-only</span></div>
        <div className="stat"><b>clamp</b><span>bits 0–2, 255 cleared; 254 set</span></div>
      </div>
      <Panel
        title="Diffie–Hellman over Curve25519"
        right={<button className="btn" onClick={() => setSeed((s) => s + 1)}>↻ new keys</button>}
        sub="Each side multiplies its scalar by the other's public u-coordinate; the ladder needs nothing but u."
      >
        <div className="cols-2">
          <div>
            <h3 style={{ color: '#5eead4' }}>Alice</h3>
            <dl className="kv">
              <dt>private (clamped)</dt>
              <dd className="hexbox" style={{ gridColumn: '1 / -1' }}>{clampScalar(aPriv).toString(16)}</dd>
              <dt>public u</dt>
              <dd className="hexbox" style={{ gridColumn: '1 / -1' }}>{bytesToHex(aPub)}</dd>
            </dl>
          </div>
          <div>
            <h3 style={{ color: '#b794f6' }}>Bob</h3>
            <dl className="kv">
              <dt>private (clamped)</dt>
              <dd className="hexbox" style={{ gridColumn: '1 / -1' }}>{clampScalar(bPriv).toString(16)}</dd>
              <dt>public u</dt>
              <dd className="hexbox" style={{ gridColumn: '1 / -1' }}>{bytesToHex(bPub)}</dd>
            </dl>
          </div>
        </div>
        <dl className="kv" style={{ marginTop: '0.8rem' }}>
          <dt>Alice computes a·B</dt>
          <dd className="hexbox" style={{ gridColumn: '1 / -1' }}>{bytesToHex(ssA)}</dd>
          <dt>Bob computes b·A</dt>
          <dd className="hexbox" style={{ gridColumn: '1 / -1' }}>{bytesToHex(ssB)}</dd>
        </dl>
        <div style={{ marginTop: '0.7rem' }}>
          <Verdict ok={agree}>{agree ? 'shared secrets match ✓' : 'mismatch'}</Verdict>
        </div>
      </Panel>
    </>
  )
}

function Ed25519Lab() {
  const [seedNonce, setSeedNonce] = useState(0)
  const [msg, setMsg] = useState('signed on the twisted Edwards curve')
  const seed = useMemo(() => {
    void seedNonce
    return randomBytes(32)
  }, [seedNonce])

  const pub = useMemo(() => ed25519Public(seed), [seed])
  const msgBytes = useMemo(() => utf8(msg), [msg])
  const sig = useMemo(() => ed25519Sign(seed, msgBytes), [seed, msgBytes])
  const ok = useMemo(() => ed25519Verify(pub, msgBytes, sig), [pub, msgBytes, sig])
  const tamperOk = useMemo(() => {
    const t = utf8(msg + '.')
    return ed25519Verify(pub, t, sig)
  }, [pub, msg, sig])

  return (
    <>
      <div className="statline" style={{ marginBottom: '1.4rem' }}>
        <div className="stat"><b>SHA-512</b><span>internal hash</span></div>
        <div className="stat"><b>complete</b><span>Edwards addition law</span></div>
        <div className="stat"><b>deterministic</b><span>nonce from key ‖ msg</span></div>
        <div className="stat"><b>64 bytes</b><span>signature (R ‖ S)</span></div>
      </div>
      <Panel
        title="EdDSA signing"
        right={<button className="btn" onClick={() => setSeedNonce((s) => s + 1)}>↻ new key</button>}
        sub="The nonce r = SHA-512(prefix ‖ m) is a deterministic function of the secret and message — no RNG at signing time, so a bad RNG can't leak the key."
      >
        <div className="field" style={{ marginBottom: '0.8rem' }}>
          <label><span>message</span></label>
          <input value={msg} onChange={(e) => setMsg(e.target.value)} />
        </div>
        <dl className="kv">
          <dt>seed (private)</dt>
          <dd className="hexbox" style={{ gridColumn: '1 / -1' }}>{bytesToHex(seed)}</dd>
          <dt>public key A</dt>
          <dd className="hexbox violet" style={{ gridColumn: '1 / -1' }}>{bytesToHex(pub)}</dd>
          <dt>signature (R ‖ S)</dt>
          <dd className="hexbox lavender" style={{ gridColumn: '1 / -1' }}>{bytesToHex(sig)}</dd>
        </dl>
        <div style={{ marginTop: '0.7rem', display: 'flex', gap: '0.8rem', flexWrap: 'wrap' }}>
          <Verdict ok={ok}>{ok ? 'verifies ✓' : 'invalid'}</Verdict>
          <Verdict ok={!tamperOk}>{tamperOk ? 'tamper slipped through!' : 'altered message rejected ✓'}</Verdict>
        </div>
      </Panel>
    </>
  )
}

function CompareLab() {
  return (
    <Panel title="One group, three coordinate systems" sub="Why the same security can wear very different clothes.">
      <table className="data">
        <thead>
          <tr>
            <th>form</th>
            <th>equation</th>
            <th>used by</th>
            <th>strength</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td>short Weierstrass</td>
            <td className="mono">y² = x³ + ax + b</td>
            <td>secp256k1, NIST P-256</td>
            <td>universal; the classical form, but addition has special cases</td>
          </tr>
          <tr>
            <td>Montgomery</td>
            <td className="mono">Bv² = u³ + Au² + u</td>
            <td>X25519 (key exchange)</td>
            <td>x-only ladder is fast and constant-time by construction</td>
          </tr>
          <tr>
            <td>twisted Edwards</td>
            <td className="mono">−x² + y² = 1 + d·x²y²</td>
            <td>Ed25519 (signatures)</td>
            <td>one complete addition formula — no branches, no exceptions</td>
          </tr>
        </tbody>
      </table>
      <div className="note" style={{ marginTop: '0.8rem' }}>
        Curve25519's Montgomery and Ed25519's twisted-Edwards curves are <em>birationally
        equivalent</em> — the same abstract group, re-coordinatized. The choice of form is an
        engineering decision about side channels and code simplicity, not a change of security
        assumption. secp256k1 keeps the Weierstrass form for historical and Bitcoin-consensus
        reasons; both are believed to offer ~128-bit security.
      </div>
    </Panel>
  )
}
