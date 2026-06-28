import { useMemo, useState } from 'react'
import { PageHead, Panel, Verdict } from '../ui/components'
import {
  publicKey,
  ecdh,
  ecdsaSign,
  ecdsaVerify,
  schnorrSign,
  schnorrVerify,
  schnorrPubkey,
  N,
  type EcdsaSig,
} from '../ecc/secp256k1'
import { bytesToHex, bigToBytes, utf8 } from '../ecc/sha256'
import { randomScalar, randomBytes, hasSecureRandom } from '../ecc/rng'
import { hex } from '../ui/format'
import type { Point } from '../ecc/curve'

type Tab = 'keys' | 'ecdsa' | 'schnorr'

function compressed(Q: Point): string {
  if (Q === null) return '—'
  const prefix = Q.y % 2n === 0n ? '02' : '03'
  return prefix + bytesToHex(bigToBytes(Q.x, 32))
}

export function Secp256k1Page() {
  const [tab, setTab] = useState<Tab>('keys')
  const [dA, setDA] = useState(() => randomScalar(N))
  const [dB, setDB] = useState(() => randomScalar(N))

  const QA = useMemo(() => publicKey(dA), [dA])
  const QB = useMemo(() => publicKey(dB), [dB])

  return (
    <main className="page">
      <PageHead eyebrow="Lab 04 — the real thing" title="secp256k1 Cryptosystem">
        This is the production curve: <code>y² = x³ + 7</code> over a 256-bit prime, the group behind
        Bitcoin, Ethereum, and much of TLS. Below, real keys are generated and real signatures are
        produced and verified entirely in your browser — by the same engine you just watched on toy
        curves, only with bigger numbers.
      </PageHead>

      <div className="statline" style={{ marginBottom: '1.4rem' }}>
        <div className="stat"><b>{hasSecureRandom() ? 'CSPRNG' : 'seeded'}</b><span>randomness source</span></div>
        <div className="stat"><b>RFC 6979</b><span>deterministic ECDSA nonce</span></div>
        <div className="stat"><b>BIP-340</b><span>Schnorr scheme</span></div>
        <div className="stat"><b>SHA-256</b><span>from scratch</span></div>
      </div>

      <div className="seg" style={{ marginBottom: '1.2rem' }}>
        <button className={tab === 'keys' ? 'on' : ''} onClick={() => setTab('keys')}>Keys & ECDH</button>
        <button className={tab === 'ecdsa' ? 'on' : ''} onClick={() => setTab('ecdsa')}>ECDSA</button>
        <button className={tab === 'schnorr' ? 'on' : ''} onClick={() => setTab('schnorr')}>Schnorr (BIP-340)</button>
      </div>

      {tab === 'keys' && (
        <KeysAndEcdh dA={dA} dB={dB} QA={QA} QB={QB} setDA={setDA} setDB={setDB} />
      )}
      {tab === 'ecdsa' && <EcdsaLab dA={dA} QA={QA} regen={() => setDA(randomScalar(N))} />}
      {tab === 'schnorr' && <SchnorrLab dA={dA} regen={() => setDA(randomScalar(N))} />}
    </main>
  )
}

function KeyCard({
  name,
  d,
  Q,
  color,
  onRegen,
  onEdit,
}: {
  name: string
  d: bigint
  Q: Point
  color: string
  onRegen: () => void
  onEdit: (d: bigint) => void
}) {
  const [editing, setEditing] = useState(false)
  const [text, setText] = useState('')
  return (
    <Panel title={<span style={{ color }}>{name}</span>}>
      <dl className="kv">
        <dt>private d</dt>
        <dd className="hexbox" style={{ gridColumn: '1 / -1' }}>{hex(d, 64)}</dd>
        <dt>public x</dt>
        <dd className="hexbox" style={{ gridColumn: '1 / -1' }}>{Q ? hex(Q.x, 64) : '—'}</dd>
        <dt>public y</dt>
        <dd className="hexbox" style={{ gridColumn: '1 / -1' }}>{Q ? hex(Q.y, 64) : '—'}</dd>
        <dt>compressed</dt>
        <dd className="hexbox lavender" style={{ gridColumn: '1 / -1' }}>{compressed(Q)}</dd>
      </dl>
      <div className="btn-row" style={{ marginTop: '0.8rem' }}>
        <button className="btn" onClick={onRegen}>↻ new random key</button>
        <button className="btn ghost" onClick={() => { setEditing((e) => !e); setText(hex(d, 64)) }}>
          {editing ? 'cancel' : 'enter key'}
        </button>
      </div>
      {editing && (
        <div style={{ marginTop: '0.7rem' }}>
          <input value={text} onChange={(e) => setText(e.target.value)} placeholder="0x… private scalar (hex)" />
          <button
            className="btn"
            style={{ marginTop: '0.5rem' }}
            onClick={() => {
              try {
                let v = BigInt(text.startsWith('0x') ? text : '0x' + text.replace(/[^0-9a-fA-F]/g, ''))
                v = ((v % N) + N) % N
                if (v === 0n) v = 1n
                onEdit(v)
                setEditing(false)
              } catch {
                /* ignore malformed input */
              }
            }}
          >
            use this key
          </button>
        </div>
      )}
    </Panel>
  )
}

function KeysAndEcdh({
  dA,
  dB,
  QA,
  QB,
  setDA,
  setDB,
}: {
  dA: bigint
  dB: bigint
  QA: Point
  QB: Point
  setDA: (d: bigint) => void
  setDB: (d: bigint) => void
}) {
  let sharedA: bigint | null = null
  let sharedB: bigint | null = null
  try {
    sharedA = ecdh(dA, QB)
    sharedB = ecdh(dB, QA)
  } catch {
    /* identity edge case */
  }
  const agree = sharedA !== null && sharedA === sharedB

  return (
    <>
      <div className="grid cols-2">
        <KeyCard name="Alice" d={dA} Q={QA} color="#5eead4" onRegen={() => setDA(randomScalar(N))} onEdit={setDA} />
        <KeyCard name="Bob" d={dB} Q={QB} color="#a78bfa" onRegen={() => setDB(randomScalar(N))} onEdit={setDB} />
      </div>
      <Panel title={<>Elliptic-Curve Diffie–Hellman <Verdict ok={agree}>{agree ? 'secrets match' : 'mismatch'}</Verdict></>}
        sub="Alice computes d_A · Q_B; Bob computes d_B · Q_A. Both equal d_A·d_B·G — a shared secret never sent over the wire."
      >
        <dl className="kv">
          <dt>Alice: x(d_A · Q_B)</dt>
          <dd className="hexbox" style={{ gridColumn: '1 / -1' }}>{sharedA !== null ? hex(sharedA, 64) : '—'}</dd>
          <dt>Bob: x(d_B · Q_A)</dt>
          <dd className="hexbox" style={{ gridColumn: '1 / -1' }}>{sharedB !== null ? hex(sharedB, 64) : '—'}</dd>
        </dl>
        <div className="note">
          An eavesdropper sees Q_A and Q_B but, lacking either private key, would have to solve the
          discrete log to recover the secret — the ECDLP, ~2¹²⁸ work.
        </div>
      </Panel>
    </>
  )
}

function EcdsaLab({ dA, QA, regen }: { dA: bigint; QA: Point; regen: () => void }) {
  const [msg, setMsg] = useState('Transfer 0.5 BTC to Alice.')
  const [verifyMsg, setVerifyMsg] = useState('Transfer 0.5 BTC to Alice.')

  const sig: EcdsaSig = useMemo(() => ecdsaSign(dA, utf8(msg)), [dA, msg])
  const sig2 = useMemo(() => ecdsaSign(dA, utf8(msg)), [dA, msg])
  const ok = useMemo(() => ecdsaVerify(QA, utf8(verifyMsg), sig), [QA, verifyMsg, sig])
  const deterministic = sig.r === sig2.r && sig.s === sig2.s
  const tampered = verifyMsg !== msg

  return (
    <div className="grid cols-2" style={{ gridTemplateColumns: '1fr 1fr', alignItems: 'start' }}>
      <Panel title="Sign" sub="ECDSA over SHA-256, with an RFC 6979 deterministic nonce">
        <div className="field">
          <label><span>signer key (Alice)</span><button className="btn ghost" style={{ padding: '0.15rem 0.5rem', fontSize: '0.75rem' }} onClick={regen}>↻</button></label>
          <div className="hexbox">{hex(dA, 64)}</div>
        </div>
        <div className="field">
          <label><span>message</span></label>
          <textarea value={msg} onChange={(e) => { setMsg(e.target.value); setVerifyMsg(e.target.value) }} />
        </div>
        <dl className="kv">
          <dt>r</dt><dd className="hexbox" style={{ gridColumn: '1 / -1' }}>{hex(sig.r, 64)}</dd>
          <dt>s</dt><dd className="hexbox" style={{ gridColumn: '1 / -1' }}>{hex(sig.s, 64)}</dd>
        </dl>
        <div style={{ marginTop: '0.7rem', display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
          <Verdict ok={deterministic}>{deterministic ? 'reproducible (RFC 6979)' : 'non-deterministic'}</Verdict>
          <Verdict ok={sig.s <= N / 2n}>low-s canonical</Verdict>
        </div>
      </Panel>

      <Panel title={<>Verify <Verdict ok={ok}>{ok ? 'VALID' : 'INVALID'}</Verdict></>}
        sub="anyone with Alice’s public key can check the signature — and only her key produces a valid one"
      >
        <div className="field">
          <label><span>message presented to verifier</span></label>
          <textarea value={verifyMsg} onChange={(e) => setVerifyMsg(e.target.value)} />
        </div>
        {tampered && (
          <div className="note" style={{ borderColor: ok ? 'var(--bad)' : 'var(--good)', color: ok ? 'var(--bad)' : 'var(--good)' }}>
            The verifier’s message differs from what was signed — and verification {ok ? 'unexpectedly passed' : 'correctly fails'}.
          </div>
        )}
        <div className="kv" style={{ marginTop: '0.6rem' }}>
          <dt>public x</dt>
          <dd className="hexbox" style={{ gridColumn: '1 / -1' }}>{QA ? hex(QA.x, 64) : '—'}</dd>
        </div>
        <div className="note">
          Edit either message box to see binding in action: change one character of the verifier’s
          copy and the signature no longer matches. Re-sign and the nonce — hence r, s — is identical,
          because RFC 6979 derives it deterministically from key + message.
        </div>
      </Panel>
    </div>
  )
}

function SchnorrLab({ dA, regen }: { dA: bigint; regen: () => void }) {
  const [msg, setMsg] = useState('aggregate me')
  const [verifyMsg, setVerifyMsg] = useState('aggregate me')
  const [aux, setAux] = useState(() => randomBytes(32))

  const px = useMemo(() => schnorrPubkey(dA), [dA])
  const sig = useMemo(() => schnorrSign(dA, utf8(msg), aux), [dA, msg, aux])
  const ok = useMemo(() => schnorrVerify(px, utf8(verifyMsg), sig), [px, verifyMsg, sig])
  const sigHex = bytesToHex(sig)

  return (
    <div className="grid cols-2" style={{ gridTemplateColumns: '1fr 1fr', alignItems: 'start' }}>
      <Panel title="Sign" sub="BIP-340 Schnorr: x-only keys, tagged hashes, a 64-byte signature">
        <div className="field">
          <label><span>signer key</span><button className="btn ghost" style={{ padding: '0.15rem 0.5rem', fontSize: '0.75rem' }} onClick={regen}>↻</button></label>
          <div className="hexbox">{hex(dA, 64)}</div>
        </div>
        <div className="field">
          <label><span>x-only public key</span></label>
          <div className="hexbox lavender">{hex(px, 64)}</div>
        </div>
        <div className="field">
          <label><span>message</span></label>
          <textarea value={msg} onChange={(e) => { setMsg(e.target.value); setVerifyMsg(e.target.value) }} />
        </div>
        <div className="field">
          <label><span>aux randomness (32 bytes)</span><button className="btn ghost" style={{ padding: '0.15rem 0.5rem', fontSize: '0.75rem' }} onClick={() => setAux(randomBytes(32))}>↻</button></label>
          <div className="hexbox" style={{ fontSize: '0.72rem' }}>{bytesToHex(aux)}</div>
        </div>
      </Panel>

      <Panel title={<>Verify <Verdict ok={ok}>{ok ? 'VALID' : 'INVALID'}</Verdict></>}
        sub="signature (R, s) packed as 64 bytes; verification recomputes s·G − e·P and checks the x-coordinate"
      >
        <div className="field">
          <label><span>64-byte signature</span></label>
          <div className="hexbox">{sigHex.slice(0, 64)}<br />{sigHex.slice(64)}</div>
        </div>
        <div className="field">
          <label><span>message presented to verifier</span></label>
          <textarea value={verifyMsg} onChange={(e) => setVerifyMsg(e.target.value)} />
        </div>
        <div className="note">
          Schnorr is <em>linear</em> in the secret, so keys and signatures aggregate cleanly —
          several signers can collapse to one key and one signature. That algebraic simplicity (and a
          clean security proof) is why Bitcoin’s Taproot upgrade adopted it. ECDSA, by contrast, hides
          the secret inside a modular inverse and resists aggregation.
        </div>
      </Panel>
    </div>
  )
}
