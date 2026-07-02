import { useEffect, useMemo, useRef, useState } from 'react'
import { PageHead, Panel, Verdict } from '../ui/components'
import { ellipsize } from '../ui/format'
import { bytesToHex, utf8 } from '../ecc/sha256'
import { seedRng, randomBytes } from '../ecc/rng'
import * as lamport from '../ecc/lamport'
import { wotsParams, wotsKeypair, wotsSign, wotsVerify, wotsSizes, WOTS_W16 } from '../ecc/wots'
import {
  xmssKeygen,
  xmssSign,
  xmssVerify,
  xmssSizes,
  type XmssPublicKey,
  type XmssSecretKey,
  type XmssSignature,
  type XmssParams,
} from '../ecc/xmss'
import {
  sphincsKeygen,
  sphincsSign,
  sphincsVerify,
  sphincsSizes,
  splitDigest,
  SPHINCS_TOY,
  type SphincsPublicKey,
  type SphincsSecretKey,
} from '../ecc/sphincs'
import { Hmsg } from '../ecc/hashaddr'

const hx = (b: Uint8Array, head = 10, tail = 6) => ellipsize(bytesToHex(b), head, tail)

function fmtBytes(n: number): string {
  if (n < 1024) return `${n.toLocaleString()} B`
  return `${(n / 1024).toFixed(n < 10240 ? 2 : 1)} KB`
}

// ── Lamport ──────────────────────────────────────────────────────────────────

function LamportSection() {
  const [msg, setMsg] = useState('Alice pays Bob 10 coins')
  const [reuse, setReuse] = useState(0)

  // A fixed key for the whole demo, generated once (seeded for determinism).
  const key = useMemo(() => {
    seedRng(0xa11ce)
    return lamport.keygen()
  }, [])

  const verified = useMemo(() => lamport.verify(key.pk, utf8(msg), lamport.sign(key, utf8(msg))), [key, msg])

  // Attacker knowledge after `reuse` reused signatures, and whether a fresh
  // target message becomes forgeable.
  const attack = useMemo(() => {
    const f = lamport.newForger()
    for (let i = 0; i < reuse; i++) {
      const m = utf8('reused-message-' + i)
      lamport.observe(f, m, lamport.sign(key, m))
    }
    const target = utf8('!! attacker-chosen forgery !!')
    const forged = lamport.forge(f, target)
    const ok = !!forged && lamport.verify(key.pk, target, forged)
    return { leaked: lamport.leaked(f), total: lamport.sizes.bits * 2, forgeable: ok }
  }, [key, reuse])

  return (
    <Panel
      title="1 · Lamport — a signature you could check by hand"
      sub="Keep 2·256 random secrets; publish their hashes. Sign by revealing the secret each digest bit selects."
    >
      <label className="field">
        <span>message</span>
        <input value={msg} onChange={(e) => setMsg(e.target.value)} />
      </label>
      <div style={{ margin: '0.5rem 0' }}>
        signature status <Verdict ok={verified}>{verified ? 'verifies' : 'invalid'}</Verdict>{' '}
        <span className="dim">— reveal one of two preimages at each of 256 bit positions</span>
      </div>

      <div className="note" style={{ marginTop: '0.5rem' }}>
        <strong>The catch: it signs exactly once.</strong> Reuse the key and secrets from both rows
        leak at the same positions — then anyone can mix-and-match revealed strings to forge messages.
      </div>
      <label className="field" style={{ marginTop: '0.7rem' }}>
        <span>times the key is reused</span>
        <span className="val">{reuse}</span>
      </label>
      <input type="range" min={0} max={24} value={reuse} onChange={(e) => setReuse(Number(e.target.value))} />
      <div className="bars" style={{ margin: '0.5rem 0' }}>
        <div className="track">
          <div
            className="fill"
            style={{ width: `${(attack.leaked / attack.total) * 100}%`, background: 'var(--accent-3)' }}
          />
        </div>
      </div>
      <div className="statline" style={{ marginTop: '0.4rem' }}>
        <div className="stat">
          <b>{attack.leaked} / {attack.total}</b>
          <span>secret halves leaked</span>
        </div>
        <div className="stat">
          <b style={{ color: attack.forgeable ? 'var(--bad, #ff6b6b)' : 'var(--accent)' }}>
            {attack.forgeable ? 'FORGEABLE' : 'safe'}
          </b>
          <span>arbitrary-message forgery</span>
        </div>
      </div>
      <SizeLine sizes={{ 'public key': lamport.sizes.publicKey, signature: lamport.sizes.signature }} />
    </Panel>
  )
}

// ── WOTS+ ─────────────────────────────────────────────────────────────────────

const W_CHOICES = [4, 16, 256]

function WotsSection() {
  const [w, setW] = useState(16)
  const [msg, setMsg] = useState('one-time Winternitz message')

  const data = useMemo(() => {
    const p = wotsParams(w)
    seedRng(0x3077 + w)
    const skSeed = randomBytes(32)
    const pubSeed = randomBytes(32)
    const { adrs, pk } = wotsKeypair(skSeed, pubSeed, p)
    const m = utf8(msg).length ? sha256Trunc(msg) : new Uint8Array(32)
    const sig = wotsSign(m, skSeed, pubSeed, adrs.clone(), p)
    const ok = wotsVerify(m, sig, pk, pubSeed, adrs.clone(), p)
    // A forger who bumps the message can walk chains forward — but the checksum
    // digits move the opposite way, so at least one becomes unreachable.
    const tampered = wotsVerify(new Uint8Array(32).fill(0xab), sig, pk, pubSeed, adrs.clone(), p)
    return { p, ok, tampered, sizes: wotsSizes(p) }
  }, [w, msg])

  return (
    <Panel
      title="2 · WOTS⁺ — Winternitz collapses Lamport into hash chains"
      sub="One hash chain of length w per base-w digit; reveal each chain at the digit's height. A checksum blocks forward-walking."
    >
      <div className="seg" role="group" aria-label="Winternitz parameter">
        {W_CHOICES.map((c) => (
          <button key={c} className={w === c ? 'on' : ''} onClick={() => setW(c)}>
            w = {c}
          </button>
        ))}
      </div>
      <label className="field" style={{ marginTop: '0.7rem' }}>
        <span>message (hashed to 32 bytes)</span>
        <input value={msg} onChange={(e) => setMsg(e.target.value)} />
      </label>
      <div style={{ margin: '0.5rem 0' }}>
        <Verdict ok={data.ok}>{data.ok ? 'verifies' : 'invalid'}</Verdict>{' '}
        <span className="dim">— every chain finishes to the published public key</span>
        <br />
        <span style={{ marginTop: '0.3rem', display: 'inline-block' }}>
          checksum guard <Verdict ok={!data.tampered}>forward-walk forgery rejected</Verdict>
        </span>
      </div>
      <div className="statline">
        <div className="stat">
          <b>{data.p.len}</b>
          <span>chains (len₁ {data.p.len1} + len₂ {data.p.len2})</span>
        </div>
        <div className="stat">
          <b>{Math.log2(w)}</b>
          <span>bits per chain (lg w)</span>
        </div>
        <div className="stat">
          <b>{fmtBytes(data.sizes.signature)}</b>
          <span>signature = public key</span>
        </div>
      </div>
      <div className="note" style={{ marginTop: '0.6rem' }}>
        Larger <code>w</code> ⇒ fewer, longer chains ⇒ smaller signatures but more hashing. Same
        security, a pure size/speed dial. Still one-time — XMSS below makes it reusable.
      </div>
    </Panel>
  )
}

// hash the text to 32 bytes without importing sha256 twice at top-level
function sha256Trunc(s: string): Uint8Array {
  // Hmsg over an empty key is a convenient 32-byte digest of arbitrary input.
  return Hmsg(new Uint8Array(96), utf8(s))
}

// ── XMSS ───────────────────────────────────────────────────────────────────────

const H_CHOICES = [2, 3, 4]

interface XmssState {
  pk: XmssPublicKey
  sk: XmssSecretKey
  keygenMs: number
  history: { msg: string; sig: XmssSignature; ok: boolean }[]
  exhausted: boolean
}

function XmssSection() {
  const [h, setH] = useState(3)
  const [state, setState] = useState<XmssState | null>(null)
  const [msg, setMsg] = useState('transfer #1')
  const counter = useRef(0)

  // Deferred keygen: setState only inside the timer (never synchronously in the
  // effect body), and freshness is derived from the built tree's height.
  useEffect(() => {
    let alive = true
    const id = setTimeout(() => {
      const params: XmssParams = { h, wots: WOTS_W16 }
      const t0 = performance.now()
      seedRng(0x88 + h)
      const { pk, sk } = xmssKeygen(randomBytes(32), randomBytes(32), randomBytes(32), params)
      if (!alive) return
      counter.current = 1
      setState({ pk, sk, keygenMs: Math.round(performance.now() - t0), history: [], exhausted: false })
    }, 20)
    return () => {
      alive = false
      clearTimeout(id)
    }
  }, [h])

  const busy = state === null || state.sk.params.h !== h

  const signNext = () => {
    if (!state || state.exhausted) return
    const text = msg || `transfer #${counter.current}`
    try {
      const sig = xmssSign(state.sk, utf8(text))
      const ok = xmssVerify(state.pk, utf8(text), sig)
      const exhausted = state.sk.idx >= 1 << state.sk.params.h
      counter.current += 1
      setMsg(`transfer #${counter.current}`)
      setState({ ...state, history: [...state.history, { msg: text, sig, ok }], exhausted })
    } catch {
      setState({ ...state, exhausted: true })
    }
  }

  const sizes = state ? xmssSizes(state.sk.params) : null
  const last = state?.history[state.history.length - 1]

  return (
    <Panel
      title="3 · XMSS — a Merkle tree of WOTS⁺ keys makes it reusable"
      sub="2^h one-time keys hashed into the leaves of one Merkle tree. The public key is the root; a signature carries its authentication path."
    >
      <div className="seg" role="group" aria-label="tree height">
        {H_CHOICES.map((c) => (
          <button key={c} className={h === c ? 'on' : ''} onClick={() => setH(c)} disabled={busy}>
            h = {c} ({1 << c} keys)
          </button>
        ))}
      </div>

      {busy && <div className="note" style={{ marginTop: '0.7rem' }}>building {1 << h} WOTS⁺ keys and hashing the tree…</div>}

      {!busy && state && (
        <>
          <dl className="kv" style={{ marginTop: '0.8rem' }}>
            <dt>public key (root)</dt>
            <dd className="hexbox lavender" style={{ gridColumn: '1 / -1' }}>{bytesToHex(state.pk.root)}</dd>
            <dt>keys used</dt>
            <dd>{state.sk.idx} / {1 << state.sk.params.h}{state.exhausted ? '  — exhausted' : ''}</dd>
            <dt>keygen</dt>
            <dd>{state.keygenMs} ms</dd>
          </dl>

          <div className="btn-row" style={{ marginTop: '0.6rem', display: 'flex', gap: '0.6rem', alignItems: 'center', flexWrap: 'wrap' }}>
            <input value={msg} onChange={(e) => setMsg(e.target.value)} style={{ flex: '1 1 12rem' }} />
            <button className="btn" onClick={signNext} disabled={state.exhausted}>
              {state.exhausted ? 'key exhausted' : 'sign with next leaf →'}
            </button>
          </div>

          {state.exhausted && (
            <div className="note warn" style={{ marginTop: '0.5rem' }}>
              All {1 << state.sk.params.h} one-time keys are spent. Signing again would reuse a WOTS⁺
              key — a break — so the signer <strong>refuses</strong>. This statefulness is exactly what
              SPHINCS⁺ removes.
            </div>
          )}

          {state.history.length > 0 && (
            <div style={{ overflowX: 'auto', marginTop: '0.7rem' }}>
              <table className="data">
                <thead>
                  <tr><th>leaf</th><th>message</th><th>WOTS⁺ sig</th><th>auth path</th><th></th></tr>
                </thead>
                <tbody>
                  {state.history.map((e, i) => (
                    <tr key={i}>
                      <td className="mono">{e.sig.idx}</td>
                      <td>{e.msg}</td>
                      <td className="mono">{e.sig.wots.length}×32 B</td>
                      <td className="mono">{e.sig.auth.length} nodes</td>
                      <td><Verdict ok={e.ok}>{e.ok ? '✓' : '✗'}</Verdict></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {last && (
            <div style={{ marginTop: '0.7rem' }}>
              <div className="sub">authentication path for leaf {last.sig.idx} — siblings hashed bottom-up to the root</div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '0.25rem', marginTop: '0.35rem' }}>
                {last.sig.auth.map((node, lvl) => (
                  <div key={lvl} className="acc-row" style={{ display: 'flex', gap: '0.6rem', alignItems: 'center' }}>
                    <span className="ix" style={{ minWidth: '3.5rem' }}>lvl {lvl}</span>
                    <span className="mono" style={{ fontSize: '0.75rem' }}>{hx(node, 14, 8)}</span>
                  </div>
                ))}
                <div className="acc-row" style={{ display: 'flex', gap: '0.6rem', alignItems: 'center' }}>
                  <span className="ix" style={{ minWidth: '3.5rem', color: 'var(--accent-3)' }}>root</span>
                  <span className="mono" style={{ fontSize: '0.75rem', color: 'var(--accent-3)' }}>{hx(state.pk.root, 14, 8)}</span>
                </div>
              </div>
            </div>
          )}

          {sizes && (
            <SizeLine
              sizes={{ 'public key': sizes.publicKey, signature: sizes.signature, 'one-time keys': sizes.oneTimeKeys }}
              raw={{ 'one-time keys': true }}
            />
          )}
        </>
      )}
    </Panel>
  )
}

// ── SPHINCS+ ───────────────────────────────────────────────────────────────────

interface SphincsResult {
  pk: SphincsPublicKey
  sk: SphincsSecretKey
  keygenMs: number
  signMs: number
  verifyMs: number
  ok: boolean
  split: ReturnType<typeof splitDigest>
  msg: string
  extra: { msg: string; ok: boolean }[]
}

function SphincsSection() {
  const [result, setResult] = useState<SphincsResult | null>(null)
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState('SPHINCS⁺: no state to lose')

  const run = () => {
    setBusy(true)
    setTimeout(() => {
      const p = SPHINCS_TOY
      seedRng(0x5f)
      let t = performance.now()
      const { pk, sk } = sphincsKeygen(randomBytes(32), randomBytes(32), randomBytes(32), p)
      const keygenMs = Math.round(performance.now() - t)
      t = performance.now()
      const sig = sphincsSign(sk, utf8(msg))
      const signMs = Math.round(performance.now() - t)
      t = performance.now()
      const ok = sphincsVerify(pk, utf8(msg), sig)
      const verifyMs = Math.round(performance.now() - t)
      // recover the digest split for display
      const digest = Hmsg(concatSeedRootR(sig.r, pk), utf8(msg))
      const split = splitDigest(digest, p)
      // statelessness: two more messages under the same key
      const extra = [1, 2].map((i) => {
        const m = `stateless proof #${i}`
        return { msg: m, ok: sphincsVerify(pk, utf8(m), sphincsSign(sk, utf8(m))) }
      })
      setResult({ pk, sk, keygenMs, signMs, verifyMs, ok, split, msg, extra })
      setBusy(false)
    }, 20)
  }

  const sizes = sphincsSizes(SPHINCS_TOY)

  return (
    <Panel
      title="4 · SPHINCS⁺ — remove the state entirely"
      sub="A FORS few-time signature under a d-layer hypertree of XMSS trees. The leaf is chosen pseudo-randomly from the message, so there is no counter to keep."
    >
      <div className="note">
        Params (scaled for the browser): height <code>h = {sizes.totalHeight}</code> over{' '}
        <code>d = {SPHINCS_TOY.d}</code> hypertree layers, FORS <code>k = {SPHINCS_TOY.k}</code> trees of{' '}
        height <code>a = {SPHINCS_TOY.a}</code>. Real SLH-DSA-128s (FIPS&nbsp;205) uses h=63, d=7, k=14,
        a=12 for 128-bit security — the same construction, larger numbers.
      </div>
      <div className="btn-row" style={{ marginTop: '0.7rem', display: 'flex', gap: '0.6rem', alignItems: 'center', flexWrap: 'wrap' }}>
        <input value={msg} onChange={(e) => setMsg(e.target.value)} style={{ flex: '1 1 14rem' }} />
        <button className="btn" onClick={run} disabled={busy}>
          {busy ? 'keygen + FORS + hypertree…' : 'keygen · sign · verify'}
        </button>
      </div>

      {result && !busy && (
        <>
          <div style={{ margin: '0.7rem 0' }}>
            <Verdict ok={result.ok}>{result.ok ? 'signature verifies' : 'invalid'}</Verdict>{' '}
            <span className="dim">— FORS public key climbs {SPHINCS_TOY.d} hypertree layers to PK.root</span>
          </div>
          <dl className="kv">
            <dt>public key (root)</dt>
            <dd className="hexbox lavender" style={{ gridColumn: '1 / -1' }}>{bytesToHex(result.pk.root)}</dd>
            <dt>chosen leaf</dt>
            <dd>tree {result.split.idxTree}, leaf {result.split.idxLeaf} (pseudo-random from the digest)</dd>
            <dt>FORS indices</dt>
            <dd className="mono">[{result.split.md.join(', ')}]</dd>
          </dl>
          <div className="statline" style={{ marginTop: '0.6rem' }}>
            <div className="stat"><b>{result.keygenMs} ms</b><span>keygen</span></div>
            <div className="stat"><b>{result.signMs} ms</b><span>sign</span></div>
            <div className="stat"><b>{result.verifyMs} ms</b><span>verify</span></div>
          </div>
          <div className="statline" style={{ marginTop: '0.5rem' }}>
            <div className="stat"><b>{fmtBytes(sizes.forsBytes)}</b><span>FORS</span></div>
            <div className="stat"><b>{fmtBytes(sizes.htBytes)}</b><span>hypertree</span></div>
            <div className="stat"><b>{fmtBytes(sizes.signature)}</b><span>total signature</span></div>
            <div className="stat"><b>{fmtBytes(sizes.publicKey)}</b><span>public key</span></div>
          </div>
          <div className="note" style={{ marginTop: '0.6rem' }}>
            <strong>Stateless proof:</strong> the same key signs more messages, each verifying, with no
            counter advanced —{' '}
            {result.extra.map((e, i) => (
              <span key={i}>
                “{e.msg}” <Verdict ok={e.ok}>{e.ok ? '✓' : '✗'}</Verdict>{i < result.extra.length - 1 ? '  ·  ' : ''}
              </span>
            ))}
          </div>
        </>
      )}
    </Panel>
  )
}

// H_msg key for the SPHINCS digest display: R ‖ PK.seed ‖ PK.root.
function concatSeedRootR(r: Uint8Array, pk: SphincsPublicKey): Uint8Array {
  const out = new Uint8Array(3 * 32)
  out.set(r, 0)
  out.set(pk.pubSeed, 32)
  out.set(pk.root, 64)
  return out
}

// ── shared size line ─────────────────────────────────────────────────────────

function SizeLine({ sizes, raw }: { sizes: Record<string, number>; raw?: Record<string, boolean> }) {
  return (
    <div className="statline" style={{ marginTop: '0.7rem' }}>
      {Object.entries(sizes).map(([k, v]) => (
        <div className="stat" key={k}>
          <b>{raw?.[k] ? v.toLocaleString() : fmtBytes(v)}</b>
          <span>{k}</span>
        </div>
      ))}
    </div>
  )
}

// ── comparison table ───────────────────────────────────────────────────────────

function ComparisonTable() {
  const wotsSz = wotsSizes(WOTS_W16)
  const xmssSz = xmssSizes({ h: 10, wots: WOTS_W16 })
  const sphSz = sphincsSizes(SPHINCS_TOY)
  const rows = [
    ['Lamport OTS', fmtBytes(lamport.sizes.publicKey), fmtBytes(lamport.sizes.signature), 'one-time', 'hash only'],
    ['WOTS⁺ (w=16)', fmtBytes(wotsSz.publicKey), fmtBytes(wotsSz.signature), 'one-time', 'hash only'],
    ['XMSS (h=10)', fmtBytes(xmssSz.publicKey), fmtBytes(xmssSz.signature), 'stateful, 2¹⁰ sigs', 'hash only'],
    ['SPHINCS⁺ (toy)', fmtBytes(sphSz.publicKey), fmtBytes(sphSz.signature), 'stateless', 'hash only'],
    ['ECDSA / Schnorr', '33 B', '64 B', 'unlimited', 'discrete log — broken by Shor'],
    ['BLS', '48 B', '96 B', 'unlimited', 'pairing — broken by Shor'],
  ]
  return (
    <Panel title="Where the bytes go — and what the assumption costs" sub="Hash-based schemes trade size for a post-quantum assumption. Curves are tiny but Shor-breakable.">
      <div style={{ overflowX: 'auto' }}>
        <table className="data">
          <thead>
            <tr><th>scheme</th><th>public key</th><th>signature</th><th>uses</th><th>assumption</th></tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={i} style={i >= 4 ? { color: 'var(--ink-dim)' } : undefined}>
                <td>{r[0]}</td>
                <td className="mono">{r[1]}</td>
                <td className="mono">{r[2]}</td>
                <td>{r[3]}</td>
                <td>{r[4]}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Panel>
  )
}

// ── page ───────────────────────────────────────────────────────────────────────

export function HashSigPage() {
  return (
    <main className="page">
      <PageHead eyebrow="Lab 27 — signing on a hash alone" title="Post-Quantum Hash-Based Signatures">
        Every other signature in this lab — ECDSA, Schnorr, MuSig, BLS — rests on the hardness of a
        discrete log or a pairing, which Shor's algorithm breaks on a quantum computer. These do not.
        A hash-based signature rests on <em>nothing but a collision-resistant hash</em> — the same
        minimal assumption the STARK makes — so it is plausibly <strong>post-quantum</strong>. Follow
        one idea, a hash chain, from a signature you could verify with pencil and paper
        (<strong>Lamport</strong>) through the Winternitz size collapse (<strong>WOTS⁺</strong>), a
        reusable Merkle key (<strong>XMSS</strong>, RFC&nbsp;8391), all the way to the{' '}
        <strong>stateless</strong> scheme NIST standardised as SLH-DSA (<strong>SPHINCS⁺</strong>,
        FIPS&nbsp;205) — every byte flowing through this lab's own from-scratch SHA-256.
      </PageHead>

      <LamportSection />
      <WotsSection />
      <XmssSection />
      <SphincsSection />
      <ComparisonTable />
    </main>
  )
}
