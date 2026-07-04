import { useMemo, useState } from 'react'
import { PageHead, Panel, Verdict } from '../ui/components'
import {
  bbsKeygen,
  bbsSign,
  bbsProofGen,
  bbsProofVerify,
  createGenerators,
  messagesToScalars,
  messageToScalar,
  type BbsProof,
} from '../ecc/bbs'
import { g1 } from '../ecc/bls12381'
import { utf8 } from '../ecc/sha256'
import { seedRng } from '../ecc/rng'
import { hex } from '../ui/format'

// A worked mobile driver's licence (mDL) — the exact use case BBS was standardised
// for. The issuer signs the whole set once; the holder discloses a chosen subset.
const ATTRIBUTES = [
  { name: 'Full name', value: 'Ada Lovelace', hint: 'personally identifying' },
  { name: 'Date of birth', value: '1815-12-10', hint: 'the bar never needs this' },
  { name: 'Licence no.', value: 'UK-DL-8150', hint: 'a linkable identifier' },
  { name: 'Address', value: '12 St James Sq, London', hint: 'sensitive' },
  { name: 'Expiry', value: '2035-06-01', hint: 'often required' },
  { name: 'Over 21', value: 'true', hint: 'the only thing a bar needs' },
]

const HEADER = 'gov.uk/dvla · mDL v1'

export function BbsPage() {
  const [seed, setSeed] = useState(1)
  // Default: disclose only "Over 21" and "Expiry" — the mDL bar scenario.
  const [disclose, setDisclose] = useState<boolean[]>([false, false, false, false, true, true])
  const [ph, setPh] = useState('bar:The Analytical Engine · 2026-07-04')

  const disclosedIndexes = useMemo(
    () => disclose.map((d, i) => (d ? i : -1)).filter((i) => i >= 0),
    [disclose],
  )

  // ── Issue the credential once (stable across presentations). ──
  const issued = useMemo(() => {
    const key = bbsKeygen(0x00c0ffee_1815_1210n)
    const gens = createGenerators(ATTRIBUTES.length)
    const msgs = messagesToScalars(ATTRIBUTES.map((a) => a.value))
    const sig = bbsSign(key, utf8(HEADER), msgs, gens)
    return { key, gens, msgs, sig }
  }, [])

  // ── Present: fresh randomness each time seed / disclosure / ph changes. ──
  const present = useMemo(() => {
    seedRng(seed * 7919 + 13)
    const { key, gens, msgs, sig } = issued
    const proof = bbsProofGen({ pk: key.pk }, sig, utf8(HEADER), utf8(ph), msgs, disclosedIndexes, gens)
    const disMsgs = disclosedIndexes.map((i) => msgs[i])
    const ok = bbsProofVerify(key.pk, proof, utf8(HEADER), utf8(ph), disMsgs, gens)

    // Soundness demo 1: the holder lies about a disclosed value (if any disclosed).
    let lieRejected = true
    if (disclosedIndexes.length > 0) {
      const lie = [...disMsgs]
      lie[0] = messageToScalar(disMsgs.length ? '### forged ###' : 'x')
      lieRejected = !bbsProofVerify(key.pk, proof, utf8(HEADER), utf8(ph), lie, gens)
    }
    // Soundness demo 2: replay this proof to a different verifier session.
    const replayRejected = !bbsProofVerify(key.pk, proof, utf8(HEADER), utf8(ph + ' (other)'), disMsgs, gens)
    // Soundness demo 3: a tampered signature element.
    const tampered: BbsProof = { ...proof, Abar: g1.add(proof.Abar, gens.P1) }
    const tamperRejected = !bbsProofVerify(key.pk, tampered, utf8(HEADER), utf8(ph), disMsgs, gens)

    return { proof, ok, lieRejected, replayRejected, tamperRejected, hidden: proof.mHat.length }
  }, [issued, disclosedIndexes, seed, ph])

  // ── Unlinkability: two independent presentations of the same disclosure. ──
  const unlink = useMemo(() => {
    const { key, gens, msgs, sig } = issued
    const idx = disclosedIndexes
    seedRng(seed * 104729 + 1)
    const a = bbsProofGen({ pk: key.pk }, sig, utf8(HEADER), utf8(ph), msgs, idx, gens)
    seedRng(seed * 104729 + 2)
    const b = bbsProofGen({ pk: key.pk }, sig, utf8(HEADER), utf8(ph), msgs, idx, gens)
    const disMsgs = idx.map((i) => msgs[i])
    const bothOk =
      bbsProofVerify(key.pk, a, utf8(HEADER), utf8(ph), disMsgs, gens) &&
      bbsProofVerify(key.pk, b, utf8(HEADER), utf8(ph), disMsgs, gens)
    const differ = !g1.eq(a.Abar, b.Abar) && !g1.eq(a.D, b.D)
    return { a, b, bothOk, differ }
  }, [issued, disclosedIndexes, seed, ph])

  const pkHex = issued.key.pk ? hex(issued.key.pk.x.a, 20) : '—'
  const nDisclosed = disclosedIndexes.length

  return (
    <main className="page">
      <PageHead eyebrow="Lab 40 — proving a credential while hiding it" title="BBS — Anonymous Credentials">
        An ordinary signature is all-or-nothing: to prove your driver's licence is genuine you hand
        over the whole thing, and every verifier can link every use. <strong>BBS</strong> breaks that.
        An issuer signs a <em>vector</em> of attributes once; later the holder proves — in zero
        knowledge — that they hold a valid signature over the full set while <strong>disclosing only a
        chosen subset</strong>, hiding the rest, and making every presentation <strong>unlinkable</strong>
        to every other. It is the cryptography under W3C Verifiable Credentials, the ISO mobile
        driver's licence, and the EU Digital Identity Wallet — built here from scratch on the lab's own{' '}
        <a href="#/bls">BLS12-381 pairing</a> and a Fiat–Shamir Σ-proof.
      </PageHead>

      <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: '0.8rem' }}>
        <button className="btn" onClick={() => setSeed((s) => s + 1)}>↻ new presentation</button>
      </div>

      <Panel
        title="① The issued credential"
        sub={
          <>
            The issuer (the DVLA) signs all {ATTRIBUTES.length} attributes with one BBS signature{' '}
            <code>(A, e)</code>. <code>A = (P1 + domain·Q₁ + Σ mᵢ·Hᵢ) · 1/(sk + e)</code> — every
            attribute rides its own NUMS generator <code>Hᵢ</code>. Public key{' '}
            <code>PK = sk·P₂ ∈ 𝔾₂</code>: <code>{pkHex}…</code>
          </>
        }
      >
        <div className="grid cols-2" style={{ gap: '0.5rem 1.4rem' }}>
          {ATTRIBUTES.map((a, i) => (
            <label
              key={a.name}
              className="field"
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: '0.7rem',
                cursor: 'pointer',
                opacity: 1,
                padding: '0.5rem 0.7rem',
                borderRadius: 8,
                border: '1px solid var(--line, #2a2a3a)',
                background: disclose[i] ? 'rgba(120,200,140,0.10)' : 'transparent',
              }}
            >
              <input
                type="checkbox"
                checked={disclose[i]}
                onChange={() =>
                  setDisclose((d) => d.map((v, k) => (k === i ? !v : v)))
                }
                style={{ width: 16, height: 16 }}
              />
              <span style={{ display: 'flex', flexDirection: 'column', flex: 1 }}>
                <span style={{ fontWeight: 600 }}>{a.name}</span>
                <span style={{ fontFamily: 'var(--mono, monospace)', fontSize: '0.85em' }}>
                  {disclose[i] ? a.value : '•••••• (hidden)'}
                </span>
              </span>
              <span className={`tag ${disclose[i] ? 'ok' : 'no'}`} style={{ minWidth: 'unset' }}>
                {disclose[i] ? 'disclosed' : 'hidden'}
              </span>
            </label>
          ))}
        </div>
        <div className="note" style={{ marginTop: '0.7rem' }}>
          Tick the attributes to reveal. The classic scenario: a bar needs only <strong>Over 21</strong>.
          Everything unticked is proven-present but never seen — not the name, not the date of birth,
          not the licence number that would let two bars recognise you.
        </div>
      </Panel>

      <Panel
        title="② The zero-knowledge presentation"
        sub={
          <>
            Presenting randomizes the signature (<code>Ā = r·A</code>, <code>D̂ = r·B − e·Ā</code>) and
            attaches a Σ-proof that <code>D̂ = r·C − e·Ā + Σ uⱼ·Hⱼ</code> over the hidden attributes.
            The verifier checks one pairing <code>e(Ā, PK) = e(D̂, P₂)</code> and the proof — learning
            nothing but the {nDisclosed} disclosed value{nDisclosed === 1 ? '' : 's'}.
          </>
        }
      >
        <dl className="kv">
          <dt>disclosed attributes</dt>
          <dd>
            {nDisclosed === 0 ? (
              <em>none — a pure proof of possession</em>
            ) : (
              disclosedIndexes.map((i) => (
                <span key={i} className="tag ok" style={{ minWidth: 'unset', marginRight: 4 }}>
                  {ATTRIBUTES[i].name}: {ATTRIBUTES[i].value}
                </span>
              ))
            )}
          </dd>
          <dt>hidden attributes (in ZK)</dt>
          <dd>{present.hidden} — each carries a blinded response <code>m̂ⱼ</code>, never the value</dd>
          <dt>randomized Ā = r·A (x)</dt>
          <dd className="hexbox" style={{ gridColumn: '1 / -1' }}>
            {present.proof.Abar ? hex(present.proof.Abar.x, 64) : '—'}
          </dd>
          <dt>D̂ = r·B − e·Ā (x)</dt>
          <dd className="hexbox" style={{ gridColumn: '1 / -1' }}>
            {present.proof.D ? hex(present.proof.D.x, 64) : '—'}
          </dd>
          <dt>Fiat–Shamir challenge c</dt>
          <dd className="hexbox">{hex(present.proof.c, 20)}…</dd>
          <dt>verifier accepts</dt>
          <dd>
            <Verdict ok={present.ok}>{present.ok ? 'valid credential ✓' : 'no'}</Verdict>
          </dd>
        </dl>
        <div className="field" style={{ marginTop: '0.8rem' }}>
          <label>
            <span>presentation header (verifier session / nonce)</span>
          </label>
          <input
            type="text"
            value={ph}
            onChange={(e) => setPh(e.target.value)}
            style={{
              width: '100%',
              fontFamily: 'var(--mono, monospace)',
              padding: '0.4rem 0.6rem',
              borderRadius: 6,
              border: '1px solid var(--line, #2a2a3a)',
              background: 'transparent',
              color: 'inherit',
            }}
          />
        </div>
      </Panel>

      <Panel
        title="③ Soundness — the things a cheat cannot do"
        sub="Fiat–Shamir binds the proof to every disclosed value, the verifier's session, and the randomized signature. Break any one and it dies."
      >
        <dl className="kv">
          <dt>lie about a disclosed value</dt>
          <dd>
            <Verdict ok={present.lieRejected}>
              {present.lieRejected ? 'rejected ✓' : nDisclosed === 0 ? 'n/a (nothing disclosed)' : 'accepted (!)'}
            </Verdict>
          </dd>
          <dt>replay to another verifier session</dt>
          <dd>
            <Verdict ok={present.replayRejected}>{present.replayRejected ? 'rejected ✓' : 'accepted (!)'}</Verdict>
          </dd>
          <dt>tamper the randomized Ā</dt>
          <dd>
            <Verdict ok={present.tamperRejected}>{present.tamperRejected ? 'rejected ✓' : 'accepted (!)'}</Verdict>
          </dd>
        </dl>
        <div className="note" style={{ marginTop: '0.5rem' }}>
          The pairing <code>e(Ā, PK) = e(D̂, P₂)</code> forces <code>D̂ = sk·Ā</code>; substituting the
          Σ-relation and dividing by the (nonzero) randomizer extracts a genuine signature{' '}
          <code>(Ā/r, e)</code> over the disclosed attributes — so a proof that verifies certifies a
          real, issuer-signed credential.
        </div>
      </Panel>

      <Panel
        title="④ Unlinkability — the privacy that ordinary signatures cannot give"
        sub="Two presentations of the very same credential, disclosing the very same attributes. A colluding pair of verifiers still cannot tell they came from one holder."
      >
        <dl className="kv">
          <dt>presentation A — Ā (x)</dt>
          <dd className="hexbox">{unlink.a.Abar ? hex(unlink.a.Abar.x, 22) : '—'}…</dd>
          <dt>presentation B — Ā (x)</dt>
          <dd className="hexbox">{unlink.b.Abar ? hex(unlink.b.Abar.x, 22) : '—'}…</dd>
          <dt>both verify</dt>
          <dd>
            <Verdict ok={unlink.bothOk}>{unlink.bothOk ? 'valid ✓' : 'no'}</Verdict>
          </dd>
          <dt>are the two presentations linkable?</dt>
          <dd>
            <Verdict ok={unlink.differ}>{unlink.differ ? 'no — every element differs ✓' : 'linkable (!)'}</Verdict>
          </dd>
        </dl>
        <div className="note" style={{ marginTop: '0.5rem' }}>
          A fresh randomizer <code>r</code> per presentation makes <code>Ā</code> a uniformly random
          group element every time. The same licence looks like a brand-new object at every door —
          the property RSA/ECDSA signatures, whose bytes are fixed, can never offer.
        </div>
      </Panel>

      <Panel title="Why this matters" sub="BBS is the multi-message signature the identity world is standardising on.">
        <div className="note">
          A government issues one signed credential; you carry it in a wallet. To a bar you reveal a
          single bit (<em>over 21</em>); to a car-rental you reveal the licence class and expiry; to a
          bank, your name — each time proving the whole thing is genuine and issued to you, each time
          revealing nothing else, and never leaving a trail that ties those visits together. The
          issuer is offline the entire time. Every group operation on this page —{' '}
          <code>{ATTRIBUTES.length}</code> message generators, the BLS12-381 pairing, the Σ-proof —
          runs from scratch in your browser with zero crypto dependencies. See the{' '}
          <a href="#/verify">self-test</a> for the full battery of correctness and soundness checks.
        </div>
      </Panel>
    </main>
  )
}
