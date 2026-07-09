import { useState } from 'react'
import { PageHead, Panel, Verdict } from '../ui/components'
import { bytesToHex } from '../ecc/sha256'
import { ellipsize } from '../ui/format'
import {
  createParticipant,
  publishBundle,
  encryptText,
  decryptText,
  runOutOfOrderDemo,
  runForwardSecrecyDemo,
  runPostCompromiseDemo,
  type Session,
  type Participant,
} from '../ecc/signal'
import { generateKeyPair, dh, x3dhInitiate, type KeyPair, type InitialMessage } from '../ecc/x3dh'
import { initAlice, cloneState, CHACHA20_POLY1305, AES_256_GCM, type RatchetMessage, type AeadSuite } from '../ecc/doubleratchet'
import { beginResponder } from '../ecc/signal'
import { xeddsaVerify } from '../ecc/xeddsa'

const b16 = (b: Uint8Array, n = 6) => ellipsize(bytesToHex(b), n * 2 + 2, 4)
const hexAll = (b: Uint8Array) => bytesToHex(b)

interface ChatMsg {
  from: 'alice' | 'bob'
  text: string
  header: RatchetMessage['header']
  ciphertext: Uint8Array
  plaintext: string | null
  newChain: boolean
}

interface HandshakeInfo {
  alice: Participant
  bob: Participant
  aliceEph: KeyPair
  bundle: ReturnType<typeof publishBundle>
  message: InitialMessage
  dh1: Uint8Array
  dh2: Uint8Array
  dh3: Uint8Array
  dh4: Uint8Array
  sharedSecret: Uint8Array
  sigOk: boolean
}

interface ChatState {
  info: HandshakeInfo
  alice: Session
  bob: Session
  convo: ChatMsg[]
}

function build(suite: AeadSuite = CHACHA20_POLY1305): ChatState {
  const alice = createParticipant('Alice')
  const bob = createParticipant('Bob')
  const bundle = publishBundle(bob, 0)
  const aliceEph = generateKeyPair()
  const { result, message } = x3dhInitiate(alice.identity, aliceEph, bundle)

  const info: HandshakeInfo = {
    alice,
    bob,
    aliceEph,
    bundle,
    message,
    dh1: dh(alice.identity.priv, bundle.signedPreKey),
    dh2: dh(aliceEph.priv, bundle.identityKey),
    dh3: dh(aliceEph.priv, bundle.signedPreKey),
    dh4: dh(aliceEph.priv, bundle.oneTimePreKey as Uint8Array),
    sharedSecret: result.sharedSecret,
    sigOk: xeddsaVerify(bundle.identityKey, bundle.signedPreKey, bundle.signedPreKeySignature),
  }

  const aliceSession: Session = {
    state: initAlice(result.sharedSecret, bundle.signedPreKey),
    ad: result.associatedData,
    suite,
  }
  const bobSession = beginResponder(bob, 0, message)
  bobSession.suite = suite
  return { info, alice: aliceSession, bob: bobSession, convo: [] }
}

export function SealedPage() {
  const [suite, setSuite] = useState<AeadSuite>(CHACHA20_POLY1305)
  const [state, setState] = useState<ChatState>(() => build(CHACHA20_POLY1305))
  const [draft, setDraft] = useState('the eagle lands at dawn')
  const [tamper, setTamper] = useState(false)
  const [ooo, setOoo] = useState<ReturnType<typeof runOutOfOrderDemo> | null>(null)
  const [fs, setFs] = useState<ReturnType<typeof runForwardSecrecyDemo> | null>(null)
  const [pcs, setPcs] = useState<ReturnType<typeof runPostCompromiseDemo> | null>(null)

  const { info } = state

  const send = (from: 'alice' | 'bob') => {
    const sender = from === 'alice' ? state.alice : state.bob
    const receiver = from === 'alice' ? state.bob : state.alice
    const text = draft.trim() || '(empty)'
    const msg = encryptText(sender, text)
    const wire: RatchetMessage = tamper
      ? { header: msg.header, ciphertext: msg.ciphertext.slice() }
      : msg
    if (tamper) wire.ciphertext[0] ^= 0x01
    const plaintext = decryptText(receiver, wire)
    const newChain = msg.header.n === 0 && state.convo.length > 0
    setState({
      ...state,
      convo: [
        ...state.convo,
        { from, text, header: msg.header, ciphertext: wire.ciphertext, plaintext, newChain },
      ],
    })
    setTamper(false)
  }

  const reset = (nextSuite: AeadSuite = suite) => {
    setSuite(nextSuite)
    setState(build(nextSuite))
    setOoo(null)
    setFs(null)
    setPcs(null)
  }

  const aliceReady = state.alice.state.cks !== null
  const bobReady = state.bob.state.cks !== null

  return (
    <main className="page">
      <PageHead eyebrow="Lab 24 — the secure channel" title="Sealed · End-to-End Encrypted Messaging">
        The one thing this lab could not yet do: keep a message <em>secret</em>. Every other page
        proves who signed something, or that a statement is true. Here the pieces come together into
        the actual <strong>Signal protocol</strong> — the end-to-end encryption behind WhatsApp and
        Signal — built entirely from this lab's own X25519, HKDF/HMAC-SHA256, and a from-scratch{' '}
        <code>ChaCha20-Poly1305</code>. <strong>X3DH</strong> agrees a shared secret with an offline
        recipient; the <strong>Double Ratchet</strong> then gives the conversation forward secrecy and
        self-healing after a compromise. Type a message and watch the ciphertext, the keys turning,
        and the guarantees hold.
      </PageHead>

      {/* ── X3DH handshake ─────────────────────────────────────────────── */}
      <Panel
        title="Handshake · X3DH (Extended Triple Diffie–Hellman)"
        sub="Bob publishes a prekey bundle to an untrusted server. Alice fetches it, checks the signed prekey, and mixes 3–4 Diffie–Hellman outputs into one root secret — the identity DHs authenticate, the ephemeral DHs give forward secrecy."
        right={
          <button className="btn" onClick={() => reset()}>
            ↻ new identities
          </button>
        }
      >
        <div className="grid cols-2">
          <div>
            <div className="sub" style={{ marginBottom: '0.4rem' }}>
              Bob's published bundle{' '}
              <Verdict ok={info.sigOk}>
                {info.sigOk ? 'prekey signature valid (XEdDSA)' : 'signature invalid'}
              </Verdict>
            </div>
            <dl className="kv">
              <dt>identity key IK_B</dt>
              <dd className="mono">{b16(info.bundle.identityKey)}</dd>
              <dt>signed prekey SPK_B</dt>
              <dd className="mono">{b16(info.bundle.signedPreKey)}</dd>
              <dt>SPK signature</dt>
              <dd className="mono">{b16(info.bundle.signedPreKeySignature)}</dd>
              <dt>one-time prekey OPK_B</dt>
              <dd className="mono">{info.bundle.oneTimePreKey ? b16(info.bundle.oneTimePreKey) : '—'}</dd>
            </dl>
            <div className="sub" style={{ margin: '0.6rem 0 0.4rem' }}>Alice's keys</div>
            <dl className="kv">
              <dt>identity key IK_A</dt>
              <dd className="mono">{b16(info.alice.identity.pub)}</dd>
              <dt>ephemeral EK_A</dt>
              <dd className="mono">{b16(info.aliceEph.pub)}</dd>
            </dl>
          </div>
          <div>
            <div className="sub" style={{ marginBottom: '0.4rem' }}>The four Diffie–Hellman outputs</div>
            <table className="data">
              <tbody>
                <tr>
                  <td className="mono" style={{ color: 'var(--accent)' }}>DH1</td>
                  <td>IK_A · SPK_B</td>
                  <td className="mono">{b16(info.dh1, 5)}</td>
                </tr>
                <tr>
                  <td className="mono" style={{ color: 'var(--accent)' }}>DH2</td>
                  <td>EK_A · IK_B</td>
                  <td className="mono">{b16(info.dh2, 5)}</td>
                </tr>
                <tr>
                  <td className="mono" style={{ color: 'var(--accent)' }}>DH3</td>
                  <td>EK_A · SPK_B</td>
                  <td className="mono">{b16(info.dh3, 5)}</td>
                </tr>
                <tr>
                  <td className="mono" style={{ color: 'var(--accent)' }}>DH4</td>
                  <td>EK_A · OPK_B</td>
                  <td className="mono">{b16(info.dh4, 5)}</td>
                </tr>
              </tbody>
            </table>
            <dl className="kv" style={{ marginTop: '0.6rem' }}>
              <dt>SK = HKDF(F ‖ DH1‖…‖DH4)</dt>
              <dd className="hexbox violet" style={{ gridColumn: '1 / -1' }}>{hexAll(info.sharedSecret)}</dd>
            </dl>
            <div className="note" style={{ marginTop: '0.4rem' }}>
              Both sides derive this identical 32-byte root secret — Alice from her private keys, Bob
              from his — without either private key ever crossing the wire.
            </div>
          </div>
        </div>
      </Panel>

      {/* ── live conversation ──────────────────────────────────────────── */}
      <Panel
        title="Conversation"
        sub="Each message advances the symmetric ratchet by one click (a fresh, single-use key). Switching who speaks turns the Diffie–Hellman ratchet — a brand-new ephemeral reseeds the root. The header (ratchet public key, chain lengths) is sent in the clear but authenticated as associated data."
        right={
          <span className="seg" style={{ gap: '0.35rem', alignItems: 'center' }}>
            <span className="note" style={{ fontSize: '0.72rem' }}>record cipher</span>
            {[CHACHA20_POLY1305, AES_256_GCM].map((s) => (
              <button
                key={s.name}
                className={'btn' + (suite.name === s.name ? '' : ' ghost')}
                style={{ padding: '0.2rem 0.5rem', fontSize: '0.72rem' }}
                onClick={() => reset(s)}
              >
                {s.name}
              </button>
            ))}
          </span>
        }
      >
        <div className="note" style={{ marginBottom: '0.6rem' }}>
          The record layer is cipher-agnostic. Signal ships{' '}
          <strong>ChaCha20-Poly1305</strong>; switch to <strong>AES-256-GCM</strong> (TLS 1.3's cipher)
          and the exact same X3DH + Double Ratchet runs over this lab's{' '}
          <a href="#/aesgcm">from-scratch AES-GCM</a> — every guarantee below still holds. Switching
          starts a fresh session.
        </div>
        <div className="seg" style={{ marginBottom: '0.7rem', flexWrap: 'wrap' }}>
          <input
            style={{ flex: '1 1 260px' }}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder="type a message…"
          />
          <button className="btn" disabled={!aliceReady} onClick={() => send('alice')}>
            send as Alice →
          </button>
          <button className="btn" disabled={!bobReady} onClick={() => send('bob')}>
            ← send as Bob
          </button>
          <label className="note" style={{ display: 'flex', alignItems: 'center', gap: '0.35rem' }}>
            <input type="checkbox" checked={tamper} onChange={(e) => setTamper(e.target.checked)} />
            flip a ciphertext bit (forge)
          </label>
        </div>
        {!bobReady && (
          <div className="note" style={{ marginBottom: '0.5rem' }}>
            Bob cannot speak until he receives Alice's first message — that is what bootstraps his
            side of the ratchet.
          </div>
        )}

        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.55rem' }}>
          {state.convo.length === 0 && (
            <div className="note">No messages yet. Send one as Alice to begin.</div>
          )}
          {state.convo.map((m, i) => (
            <Bubble key={i} m={m} />
          ))}
        </div>
      </Panel>

      {/* ── ratchet state ──────────────────────────────────────────────── */}
      <Panel
        title="Ratchet state — live"
        sub="The two chains turning. The root key (RK) is reseeded on every direction change; the chain keys (CK) click forward per message and are then thrown away."
      >
        <div className="grid cols-2">
          <StateView label="Alice" session={state.alice} />
          <StateView label="Bob" session={state.bob} />
        </div>
      </Panel>

      {/* ── guarantees ─────────────────────────────────────────────────── */}
      <Panel
        title="The guarantees, demonstrated"
        sub="Each button runs a fresh, self-contained scenario end to end and reports the outcome."
      >
        <div className="grid cols-3">
          <DemoCard
            title="Out-of-order delivery"
            run={() => setOoo(runOutOfOrderDemo())}
            ok={ooo?.ok ?? null}
            body="Alice sends three messages; the network delivers them 3, 1, 2. The receiver stashes the keys of skipped messages, so every one still decrypts."
            detail={ooo ? ooo.delivered.map((d) => `#${d.n} → ${d.plaintext ?? '✗'}`).join('  ') : ''}
          />
          <DemoCard
            title="Forward secrecy"
            run={() => setFs(runForwardSecrecyDemo())}
            ok={fs?.ok ?? null}
            body="A message key is derived by a one-way step and deleted after use. Stealing today's state cannot decrypt yesterday's messages — replaying a delivered message just fails."
            detail={fs?.detail ?? ''}
          />
          <DemoCard
            title="Post-compromise security"
            run={() => setPcs(runPostCompromiseDemo())}
            ok={pcs?.ok ?? null}
            body="An attacker steals Bob's entire state. It reads the next message — but one round trip later, a fresh ratchet key it never saw reseeds the root, and the stale state is locked back out."
            detail={
              pcs
                ? `stolen state reads before-heal: ${pcs.stolenCanReadBefore ? 'yes' : 'no'} · after-heal: ${pcs.stolenCanReadAfter ? 'yes' : 'no'}`
                : ''
            }
          />
        </div>
      </Panel>
    </main>
  )
}

function Bubble({ m }: { m: ChatMsg }) {
  const mine = m.from === 'alice'
  const failed = m.plaintext === null
  return (
    <div style={{ display: 'flex', justifyContent: mine ? 'flex-end' : 'flex-start' }}>
      <div
        style={{
          maxWidth: '78%',
          border: '1px solid var(--line)',
          borderRadius: 10,
          padding: '0.55rem 0.7rem',
          background: mine ? 'rgba(167,139,250,0.10)' : 'rgba(94,234,212,0.08)',
        }}
      >
        <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center', marginBottom: '0.3rem' }}>
          <strong style={{ color: mine ? 'var(--lavender, #a78bfa)' : 'var(--accent)' }}>
            {mine ? 'Alice' : 'Bob'}
          </strong>
          {m.newChain && <span className="tag">↻ DH ratchet</span>}
          <span className="tag">PN {m.header.pn} · N {m.header.n}</span>
          <Verdict ok={!failed}>{failed ? 'rejected' : 'decrypted'}</Verdict>
        </div>
        <div style={{ marginBottom: '0.3rem' }}>
          {failed ? (
            <span className="warn">⚠ authentication failed — forged bytes discarded</span>
          ) : (
            <span>“{m.plaintext}”</span>
          )}
        </div>
        <div className="mono small" style={{ opacity: 0.75, wordBreak: 'break-all' }}>
          hdr.dh {b16(m.header.dh, 5)} · ct {ellipsize(hexAll(m.ciphertext), 22, 8)} ({m.ciphertext.length} B, 16-B tag)
        </div>
      </div>
    </div>
  )
}

function StateView({ label, session }: { label: string; session: Session }) {
  const s = cloneState(session.state)
  return (
    <div>
      <div className="sub" style={{ marginBottom: '0.4rem' }}>{label}</div>
      <dl className="kv">
        <dt>root key RK</dt>
        <dd className="mono">{b16(s.rk)}</dd>
        <dt>sending CK</dt>
        <dd className="mono">{s.cks ? b16(s.cks) : '— (none yet)'}</dd>
        <dt>receiving CK</dt>
        <dd className="mono">{s.ckr ? b16(s.ckr) : '— (none yet)'}</dd>
        <dt>our ratchet key</dt>
        <dd className="mono">{b16(s.dhs.pub)}</dd>
        <dt>their ratchet key</dt>
        <dd className="mono">{s.dhr ? b16(s.dhr) : '—'}</dd>
        <dt>sent / recv / prev</dt>
        <dd className="mono">Ns {s.ns} · Nr {s.nr} · PN {s.pn}</dd>
        <dt>stashed skipped keys</dt>
        <dd className="mono">{s.skipped.size}</dd>
      </dl>
    </div>
  )
}

function DemoCard({
  title,
  body,
  detail,
  run,
  ok,
}: {
  title: string
  body: string
  detail: string
  run: () => void
  ok: boolean | null
}) {
  return (
    <div className="panel" style={{ margin: 0 }}>
      <h2 style={{ fontSize: '1rem', justifyContent: 'space-between' }}>
        <span>{title}</span>
        {ok !== null && <Verdict ok={ok}>{ok ? 'holds' : 'FAILED'}</Verdict>}
      </h2>
      <p className="note" style={{ minHeight: '4.5em' }}>{body}</p>
      {detail && (
        <div className="mono small" style={{ opacity: 0.8, marginBottom: '0.5rem', wordBreak: 'break-word' }}>
          {detail}
        </div>
      )}
      <button className="btn" onClick={run}>
        run scenario
      </button>
    </div>
  )
}
