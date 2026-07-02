import { useMemo, useState } from 'react'
import { PageHead, Panel, Slider, Verdict } from '../ui/components'
import {
  mulBase,
  blsagSign,
  blsagVerify,
  clsagSign,
  clsagVerify,
  imagesLinked,
  keyImage,
  stealthKeygen,
  stealthSend,
  stealthReceive,
  pubFromSecret,
} from '../ecc/ring'
import { L25519, edEncode, edEqual2, type EdPoint } from '../ecc/ed25519'
import { bytesToHex, utf8 } from '../ecc/sha256'
import { randomScalar, seedRng } from '../ecc/rng'
import { ellipsize } from '../ui/format'

const q = L25519
const ptHex = (P: EdPoint): string => bytesToHex(edEncode(P))
const COLORS = ['#b794f6', '#5eead4', '#fbbf24', '#fb7185', '#60a5fa', '#34d399', '#f472b6', '#a78bfa', '#facc15', '#4ade80']

export function RingPage() {
  const [n, setN] = useState(6)
  const [signer, setSigner] = useState(2)
  const [scheme, setScheme] = useState<'bLSAG' | 'CLSAG'>('bLSAG')
  const [msg, setMsg] = useState('spend output #1')
  const [seed, setSeed] = useState(1)
  const [tamper, setTamper] = useState(false)

  const sIdx = Math.min(signer, n - 1)

  // A ring of key pairs (deterministic in the seed for reproducibility).
  const world = useMemo(() => {
    seedRng(seed * 2654435761 + n)
    const p = Array.from({ length: n }, () => randomScalar(q)) // spend secrets
    const z = Array.from({ length: n }, () => randomScalar(q)) // commitment secrets (CLSAG)
    return {
      p,
      z,
      ringP: p.map(mulBase),
      ringC: z.map(mulBase),
    }
  }, [n, seed])

  const msgBytes = useMemo(() => utf8(msg), [msg])

  const sig = useMemo(() => {
    seedRng(seed * 40503 + sIdx * 7 + msg.length)
    if (scheme === 'bLSAG') {
      const s = blsagSign(msgBytes, world.ringP, world.p[sIdx], sIdx)
      return { kind: 'bLSAG' as const, image: s.image, c0: s.c0, s: s.s, blsag: s }
    }
    const s = clsagSign(msgBytes, world.ringP, world.ringC, world.p[sIdx], world.z[sIdx], sIdx)
    return { kind: 'CLSAG' as const, image: s.I, c0: s.c0, s: s.s, clsag: s, D: s.D }
  }, [scheme, world, sIdx, msgBytes, seed, msg])

  const verified = useMemo(() => {
    if (sig.kind === 'bLSAG') {
      const s = tamper ? { ...sig.blsag, s: sig.blsag.s.map((v, i) => (i === 0 ? v + 1n : v)) } : sig.blsag
      return blsagVerify(msgBytes, world.ringP, s)
    }
    const s = tamper ? { ...sig.clsag, s: sig.clsag.s.map((v, i) => (i === 0 ? v + 1n : v)) } : sig.clsag
    return clsagVerify(msgBytes, world.ringP, world.ringC, s)
  }, [sig, world, msgBytes, tamper])

  // ── Linkability: a second spend with the SAME key vs a DIFFERENT key ──
  const link = useMemo(() => {
    seedRng(seed * 22801 + 99)
    const again = blsagSign(utf8('a different message, same coin'), world.ringP, world.p[sIdx], sIdx)
    const otherIdx = (sIdx + 1) % n
    const other = blsagSign(msgBytes, world.ringP, world.p[otherIdx], otherIdx)
    return {
      again,
      other,
      otherIdx,
      linkedSame: imagesLinked(sig.image, again.image),
      linkedOther: imagesLinked(sig.image, other.image),
    }
  }, [world, sIdx, n, msgBytes, seed, sig.image])

  // ── Stealth addresses + a full private payment ──
  const pay = useMemo(() => {
    seedRng(seed * 6700417 + 5)
    const recipient = stealthKeygen()
    const sent = stealthSend(recipient.A, recipient.Bs, 0)
    const recovered = stealthReceive(recipient, sent.R, 0)
    const opensP = edEqual2(pubFromSecret(recovered.x), sent.P)
    const stranger = stealthReceive(stealthKeygen(), sent.R, 0)
    const strangerFails = !edEqual2(stranger.P, sent.P)
    // Spend the stealth output inside a ring of decoys.
    seedRng(seed * 6700417 + 6)
    const decoys = Array.from({ length: 9 }, () => mulBase(randomScalar(q)))
    const ring = [...decoys.slice(0, 4), sent.P, ...decoys.slice(4)]
    const realIdx = 4
    const spend = blsagSign(utf8('pay 1 coin'), ring, recovered.x, realIdx)
    const spendOk = blsagVerify(utf8('pay 1 coin'), ring, spend)
    const imageMatches = edEqual2(spend.image, keyImage(recovered.x, sent.P))
    return { recipient, sent, recovered, opensP, strangerFails, ring, realIdx, spend, spendOk, imageMatches }
  }, [seed])

  return (
    <main className="page">
      <PageHead eyebrow="Lab — anonymity & linkability" title="Linkable Ring Signatures & Stealth Addresses">
        A <strong>ring signature</strong> proves “one of these <code>n</code> keys signed this” without
        revealing which — anonymity by construction. Attach a <strong>key image</strong>{' '}
        <code>I = x·H_p(P)</code>, deterministic in the secret but leaking nothing about it, and the same
        key's signatures all carry the same image: a verifier can catch a double-spend while still not
        knowing the spender. That is the machinery behind Monero. Built here from scratch on this lab's
        Ed25519 group — <strong>bLSAG</strong> (Back's linkable SAG) and <strong>CLSAG</strong> (the
        concise scheme that signs an output key and its amount commitment with one scalar each).
      </PageHead>

      <Panel
        title="The ring"
        sub="Every member is an ordinary public key P_i = x_i·B. The signer is one of them; to a verifier all positions are equally likely."
        right={<button className="btn" onClick={() => setSeed((s) => s + 1)}>↻ new ring</button>}
      >
        <div className="grid cols-2" style={{ gap: '1rem' }}>
          <Slider label="ring size n" value={n} min={2} max={10} onChange={(v) => { setN(v); setSigner((x) => Math.min(x, v - 1)) }} />
          <Slider label="true signer index π" value={sIdx} min={0} max={n - 1} display={`#${sIdx + 1}`} onChange={setSigner} />
        </div>
        <div className="seg" style={{ flexWrap: 'wrap', marginTop: '0.7rem' }}>
          {world.ringP.map((P, i) => (
            <button key={i} className={i === sIdx ? 'on' : ''} onClick={() => setSigner(i)} title={ptHex(P)}>
              <span style={{ color: COLORS[i % COLORS.length] }}>●</span> #{i + 1}
              {i === sIdx ? ' (signer)' : ''}
            </button>
          ))}
        </div>
      </Panel>

      <Panel
        title="Sign & verify"
        sub="bLSAG carries one response scalar s_i per ring member and one key image. CLSAG additionally binds a commitment ring C_i, still with a single s_i each."
        right={
          <div className="seg">
            <button className={scheme === 'bLSAG' ? 'on' : ''} onClick={() => setScheme('bLSAG')}>bLSAG</button>
            <button className={scheme === 'CLSAG' ? 'on' : ''} onClick={() => setScheme('CLSAG')}>CLSAG</button>
          </div>
        }
      >
        <input value={msg} onChange={(e) => setMsg(e.target.value)} spellCheck={false} />
        <dl className="kv" style={{ marginTop: '0.8rem' }}>
          <dt>key image I</dt>
          <dd className="hexbox violet" style={{ gridColumn: '1 / -1' }}>{ptHex(sig.image)}</dd>
          {sig.kind === 'CLSAG' && (
            <>
              <dt>aux image D</dt>
              <dd className="hexbox" style={{ gridColumn: '1 / -1' }}>{ptHex(sig.D)}</dd>
            </>
          )}
          <dt>c₀ (ring seal)</dt>
          <dd className="mono">{ellipsize(sig.c0.toString(16).padStart(64, '0'), 20, 12)}</dd>
          <dt>responses</dt>
          <dd className="mono">{sig.s.length} scalars: {sig.s.map((v) => v.toString(16).slice(0, 4)).join(' ')}…</dd>
        </dl>
        <div style={{ marginTop: '0.7rem', display: 'flex', gap: '1rem', alignItems: 'center', flexWrap: 'wrap' }}>
          <Verdict ok={verified}>
            {verified ? `${scheme} verifies — anonymous within the ring` : 'invalid'}
          </Verdict>
          <label style={{ display: 'flex', gap: '0.4rem', alignItems: 'center' }}>
            <input type="checkbox" checked={tamper} onChange={(e) => setTamper(e.target.checked)} />
            <span>tamper with a response scalar</span>
          </label>
        </div>
        <p className="note" style={{ marginTop: '0.5rem' }}>
          The verifier walks the ring c₀ → c₁ → … → c₀, checking the challenge chain closes back on
          itself. It uses only public keys — it learns that <em>someone</em> in the ring signed, never
          which one.
        </p>
      </Panel>

      <Panel
        title="Linkability — catch a double-spend without unmasking anyone"
        sub="The key image is x·H_p(P): the same coin always produces the same image, a different coin a different one."
      >
        <table className="data">
          <thead>
            <tr><th>signature</th><th>key image</th><th>linked to the one above?</th></tr>
          </thead>
          <tbody>
            <tr>
              <td>spend of coin #{sIdx + 1}</td>
              <td className="mono">{ellipsize(ptHex(sig.image), 14, 10)}</td>
              <td>—</td>
            </tr>
            <tr>
              <td>same key, new message</td>
              <td className="mono">{ellipsize(ptHex(link.again.image), 14, 10)}</td>
              <td><Verdict ok={link.linkedSame}>{link.linkedSame ? 'LINKED — double-spend' : 'not linked'}</Verdict></td>
            </tr>
            <tr>
              <td>different key (#{link.otherIdx + 1})</td>
              <td className="mono">{ellipsize(ptHex(link.other.image), 14, 10)}</td>
              <td><Verdict ok={!link.linkedOther}>{link.linkedOther ? 'linked' : 'unlinked ✓'}</Verdict></td>
            </tr>
          </tbody>
        </table>
        <p className="note" style={{ marginTop: '0.5rem' }}>
          Both of the first key's signatures verify anonymously — but a ledger that already recorded the
          first image rejects the second as a double-spend, all without ever learning the signer's
          identity.
        </p>
      </Panel>

      <Panel
        title="Stealth addresses — a complete private payment"
        sub="CryptoNote one-time keys. The sender derives a fresh output key only the recipient can spend; the recipient later spends it inside a ring of decoys."
      >
        <div className="flow">
          <div className="flow-step">
            <div className="flow-h">1 · recipient publishes</div>
            <div className="mono small">view A = {ellipsize(ptHex(pay.recipient.A), 10, 8)}</div>
            <div className="mono small">spend B = {ellipsize(ptHex(pay.recipient.Bs), 10, 8)}</div>
          </div>
          <div className="flow-step">
            <div className="flow-h">2 · sender derives</div>
            <div className="mono small">tx key R = {ellipsize(ptHex(pay.sent.R), 10, 8)}</div>
            <div className="mono small">one-time P = {ellipsize(ptHex(pay.sent.P), 10, 8)}</div>
          </div>
          <div className="flow-step">
            <div className="flow-h">3 · recipient recovers</div>
            <div className="mono small">x·B = P: <Verdict ok={pay.opensP}>{pay.opensP ? 'yes ✓' : 'no'}</Verdict></div>
            <div className="mono small">stranger fails: <Verdict ok={pay.strangerFails}>{pay.strangerFails ? 'yes ✓' : 'no'}</Verdict></div>
          </div>
          <div className="flow-step">
            <div className="flow-h">4 · recipient spends</div>
            <div className="mono small">ring of {pay.ring.length}, real at #{pay.realIdx + 1}</div>
            <div className="mono small">ring sig: <Verdict ok={pay.spendOk}>{pay.spendOk ? 'verifies ✓' : 'bad'}</Verdict></div>
          </div>
        </div>
        <p className="note" style={{ marginTop: '0.6rem' }}>
          Only the holder of the recipient's view key can even detect the payment; only the holder of the
          spend key can produce the one-time secret <code>x</code> and spend it. The spend hides among
          decoys, and its key image <code>{ellipsize(ptHex(pay.spend.image), 12, 8)}</code>
          {' '}— matching <code>x·H_p(P)</code>: <Verdict ok={pay.imageMatches}>{pay.imageMatches ? 'ok' : 'no'}</Verdict> —
          guards against ever spending it twice.
        </p>
      </Panel>
    </main>
  )
}
