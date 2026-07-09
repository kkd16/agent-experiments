import { useMemo, useState } from 'react'
import { PageHead, Panel, Verdict } from '../ui/components'
import { SBOX, encryptBlock, traceEncrypt, type AesStep } from '../ecc/aes'
import { gcmEncrypt, gcmDecrypt, ghash } from '../ecc/gcm'
import { gcmSivEncrypt } from '../ecc/gcmsiv'
import { cmac, cmacSubkeys } from '../ecc/cmac'
import { sivEncrypt, sivDecrypt } from '../ecc/aessiv'
import { ccmEncrypt, ccmDecrypt } from '../ecc/ccm'

// ── small byte helpers ────────────────────────────────────────────────────────

const hx = (b: Uint8Array) => [...b].map((x) => x.toString(16).padStart(2, '0')).join('')
function parseHex(s: string, len?: number): Uint8Array {
  const clean = s.replace(/[^0-9a-fA-F]/g, '')
  const pairs = clean.match(/.{1,2}/g) ?? []
  let out = Uint8Array.from(pairs.map((p) => parseInt(p.padEnd(2, '0'), 16)))
  if (len !== undefined) {
    const fixed = new Uint8Array(len)
    fixed.set(out.subarray(0, len))
    out = fixed
  }
  return out
}
function randHex(n: number): string {
  const b = new Uint8Array(n)
  for (let i = 0; i < n; i++) b[i] = Math.floor(Math.random() * 256)
  return hx(b)
}
const utf8 = (s: string) => new TextEncoder().encode(s)

const OP_LABEL: Record<AesStep['op'], string> = {
  input: 'Input block',
  start: 'Round start',
  subbytes: 'SubBytes — the S-box',
  shiftrows: 'ShiftRows — cyclic row rotations',
  mixcolumns: 'MixColumns — mix each column over GF(2⁸)',
  addroundkey: 'AddRoundKey — XOR the round key',
  output: 'Ciphertext',
}

// ── the 4×4 AES state matrix ──────────────────────────────────────────────────

function StateMatrix({ state, prev, accent }: { state: Uint8Array; prev?: Uint8Array; accent: string }) {
  // AES state is column-major: cell (row, col) is byte 4·col + row.
  return (
    <div style={{ display: 'inline-grid', gridTemplateColumns: 'repeat(4, 2.2rem)', gap: 4 }}>
      {Array.from({ length: 4 }, (_, row) =>
        Array.from({ length: 4 }, (_, col) => {
          const idx = 4 * col + row
          const changed = prev ? prev[idx] !== state[idx] : false
          return (
            <div
              key={idx}
              className="mono"
              style={{
                width: '2.2rem',
                height: '2.2rem',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                fontSize: '0.82rem',
                borderRadius: 6,
                border: '1px solid var(--line)',
                background: changed ? accent + '22' : 'var(--panel-2)',
                color: changed ? accent : 'var(--ink)',
                transition: 'background 0.15s, color 0.15s',
              }}
            >
              {state[idx].toString(16).padStart(2, '0')}
            </div>
          )
        }),
      )}
    </div>
  )
}

// ── the AES round engine ──────────────────────────────────────────────────────

function AesEngine() {
  const [bits, setBits] = useState<128 | 192 | 256>(128)
  const [keyHex, setKeyHex] = useState('000102030405060708090a0b0c0d0e0f')
  const [ptHex, setPtHex] = useState('00112233445566778899aabbccddeeff')
  const [step, setStep] = useState(0)

  const keyBytes = useMemo(() => parseHex(keyHex, bits / 8), [keyHex, bits])
  const ptBytes = useMemo(() => parseHex(ptHex, 16), [ptHex])
  const steps = useMemo(() => traceEncrypt(keyBytes, ptBytes), [keyBytes, ptBytes])
  const cur = steps[Math.min(step, steps.length - 1)]
  const prev = step > 0 ? steps[step - 1].state : undefined
  const ct = steps[steps.length - 1].state
  const rounds = bits === 128 ? 10 : bits === 192 ? 12 : 14

  const setSize = (b: 128 | 192 | 256) => {
    setBits(b)
    setKeyHex(randHex(b / 8))
    setStep(0)
  }

  return (
    <Panel
      title="The round engine — AES as a substitution–permutation network"
      sub={`A 128-bit block is a 4×4 byte matrix pushed through ${rounds} rounds of SubBytes · ShiftRows · MixColumns · AddRoundKey. Scrub the ${steps.length - 1}-step trace and watch each transformation move the state; changed bytes light up. Pinned to the FIPS-197 worked examples.`}
    >
      <div className="seg" style={{ marginBottom: '0.7rem', flexWrap: 'wrap', gap: '0.5rem' }}>
        {([128, 192, 256] as const).map((b) => (
          <button key={b} className={'btn' + (bits === b ? '' : ' ghost')} onClick={() => setSize(b)}>
            AES-{b}
          </button>
        ))}
        <button className="btn ghost" onClick={() => { setKeyHex(randHex(bits / 8)); setStep(0) }}>
          ↻ random key
        </button>
        <button className="btn ghost" onClick={() => { setPtHex(randHex(16)); setStep(0) }}>
          ↻ random block
        </button>
      </div>

      <div className="grid cols-2" style={{ alignItems: 'start' }}>
        <div>
          <label className="sub">key ({bits / 8} bytes)</label>
          <input className="mono" style={{ width: '100%', marginBottom: '0.5rem' }} value={keyHex} onChange={(e) => { setKeyHex(e.target.value); setStep(0) }} />
          <label className="sub">plaintext block (16 bytes)</label>
          <input className="mono" style={{ width: '100%' }} value={ptHex} onChange={(e) => { setPtHex(e.target.value); setStep(0) }} />
          <dl className="kv" style={{ marginTop: '0.7rem' }}>
            <dt>rounds Nr</dt>
            <dd className="mono">{rounds}</dd>
            <dt>ciphertext</dt>
            <dd className="hexbox violet" style={{ gridColumn: '1 / -1' }}>{hx(ct)}</dd>
          </dl>
        </div>

        <div style={{ textAlign: 'center' }}>
          <div className="sub" style={{ marginBottom: '0.5rem' }}>
            step {step} / {steps.length - 1} · round {cur.round} · <span style={{ color: 'var(--accent)' }}>{OP_LABEL[cur.op]}</span>
          </div>
          <div style={{ display: 'flex', gap: '1.2rem', justifyContent: 'center', alignItems: 'center' }}>
            <StateMatrix state={cur.state} prev={prev} accent="#5eead4" />
            {cur.roundKey && (
              <div>
                <div className="mono small" style={{ opacity: 0.7, marginBottom: 4 }}>round key</div>
                <StateMatrix state={cur.roundKey} accent="#a78bfa" />
              </div>
            )}
          </div>
          <input
            type="range"
            min={0}
            max={steps.length - 1}
            value={step}
            onChange={(e) => setStep(Number(e.target.value))}
            style={{ width: '100%', marginTop: '0.9rem' }}
          />
          <div className="seg" style={{ justifyContent: 'center', marginTop: '0.4rem' }}>
            <button className="btn ghost" onClick={() => setStep(Math.max(0, step - 1))}>‹ prev</button>
            <button className="btn ghost" onClick={() => setStep(0)}>reset</button>
            <button className="btn ghost" onClick={() => setStep(Math.min(steps.length - 1, step + 1))}>next ›</button>
          </div>
        </div>
      </div>

      {cur.op === 'subbytes' && (
        <div className="note" style={{ marginTop: '0.7rem' }}>
          SubBytes replaces each byte <span className="mono">b</span> with its multiplicative inverse in GF(2⁸)
          followed by a fixed affine map — e.g. <span className="mono">0x00→0x{SBOX[0].toString(16).padStart(2, '0')}</span>,{' '}
          <span className="mono">0x53→0x{SBOX[0x53].toString(16).padStart(2, '0')}</span>. It is the cipher's only
          nonlinear step, computed here, not tabled.
        </div>
      )}
    </Panel>
  )
}

// ── AES-GCM AEAD + the GHASH accumulator ──────────────────────────────────────

function GcmPanel() {
  const [keyHex, setKeyHex] = useState('feffe9928665731c6d6a8f9467308308')
  const [nonceHex, setNonceHex] = useState('cafebabefacedbaddecaf888')
  const [msg, setMsg] = useState('attack at dawn — via AES-GCM')
  const [aad, setAad] = useState('header:v1')
  const [tamper, setTamper] = useState(false)

  const res = useMemo(() => {
    try {
      const key = parseHex(keyHex, keyHex.replace(/[^0-9a-fA-F]/g, '').length >= 64 ? 32 : 16)
      const iv = parseHex(nonceHex, 12)
      const pt = utf8(msg)
      const ad = utf8(aad)
      const { ciphertext, tag } = gcmEncrypt(key, iv, pt, ad)

      // GHASH accumulation trace, block by block (over AAD ‖ CT ‖ lengths).
      const H = encryptBlock(key, new Uint8Array(16))
      const pad = (n: number) => (n % 16 === 0 ? 0 : 16 - (n % 16))
      const be64 = (n: number) => { const b = new Uint8Array(8); let v = BigInt(n); for (let i = 7; i >= 0; i--) { b[i] = Number(v & 0xffn); v >>= 8n } return b }
      const framed = new Uint8Array(ad.length + pad(ad.length) + ciphertext.length + pad(ciphertext.length) + 16)
      let o = 0
      framed.set(ad, o); o += ad.length + pad(ad.length)
      framed.set(ciphertext, o); o += ciphertext.length + pad(ciphertext.length)
      framed.set(be64(ad.length * 8), o); o += 8
      framed.set(be64(ciphertext.length * 8), o)
      const accum: { block: Uint8Array; y: Uint8Array }[] = []
      for (let off = 0; off < framed.length; off += 16) {
        const block = framed.slice(off, off + 16)
        accum.push({ block, y: ghash(H, framed.slice(0, off + 16)) })
      }

      // decrypt (optionally tampered)
      const ct2 = ciphertext.slice()
      if (tamper && ct2.length) ct2[0] ^= 0x01
      const dec = gcmDecrypt(key, iv, ct2, tag, ad)

      return { H, ciphertext, tag, accum, dec, keyBytes: key }
    } catch {
      return null
    }
  }, [keyHex, nonceHex, msg, aad, tamper])

  return (
    <Panel
      title="AES-GCM — the AEAD that runs TLS 1.3"
      sub="Counter-mode encryption for secrecy, GHASH (a polynomial in GF(2¹²⁸)) for authentication. The tag is E_K(J0) ⊕ GHASH; watch the hash accumulate one block at a time. Flip a ciphertext bit and the tag stops verifying."
    >
      <div className="grid cols-2" style={{ alignItems: 'start' }}>
        <div>
          <label className="sub">key (16 or 32 bytes hex)</label>
          <input className="mono" style={{ width: '100%', marginBottom: '0.5rem' }} value={keyHex} onChange={(e) => setKeyHex(e.target.value)} />
          <label className="sub">nonce (12 bytes hex)</label>
          <input className="mono" style={{ width: '100%', marginBottom: '0.5rem' }} value={nonceHex} onChange={(e) => setNonceHex(e.target.value)} />
          <label className="sub">plaintext</label>
          <input style={{ width: '100%', marginBottom: '0.5rem' }} value={msg} onChange={(e) => setMsg(e.target.value)} />
          <label className="sub">associated data (authenticated, not encrypted)</label>
          <input style={{ width: '100%' }} value={aad} onChange={(e) => setAad(e.target.value)} />
          <label className="note" style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', marginTop: '0.6rem' }}>
            <input type="checkbox" checked={tamper} onChange={(e) => setTamper(e.target.checked)} />
            flip a ciphertext bit before decrypting
          </label>
        </div>
        <div>
          {res ? (
            <>
              <dl className="kv">
                <dt>H = E_K(0)</dt>
                <dd className="mono small">{hx(res.H)}</dd>
                <dt>ciphertext</dt>
                <dd className="hexbox" style={{ gridColumn: '1 / -1', wordBreak: 'break-all' }}>{hx(res.ciphertext)}</dd>
                <dt>tag (16 B)</dt>
                <dd className="hexbox violet" style={{ gridColumn: '1 / -1' }}>{hx(res.tag)}</dd>
              </dl>
              <div style={{ marginTop: '0.6rem' }}>
                <Verdict ok={res.dec !== null}>
                  {res.dec !== null ? 'tag verifies — decrypts' : 'authentication FAILED — rejected'}
                </Verdict>
                {res.dec !== null && (
                  <span className="mono small" style={{ marginLeft: '0.5rem', opacity: 0.8 }}>
                    “{new TextDecoder().decode(res.dec)}”
                  </span>
                )}
              </div>
            </>
          ) : (
            <div className="warn">invalid hex input</div>
          )}
        </div>
      </div>

      {res && (
        <div style={{ marginTop: '0.9rem' }}>
          <div className="sub" style={{ marginBottom: '0.4rem' }}>GHASH accumulator — Yᵢ = (Yᵢ₋₁ ⊕ blockᵢ) · H, over AAD ‖ ciphertext ‖ lengths</div>
          <div style={{ overflowX: 'auto' }}>
            <table className="data" style={{ minWidth: 520 }}>
              <thead>
                <tr><th>i</th><th>block (16 B)</th><th>running Yᵢ</th></tr>
              </thead>
              <tbody>
                {res.accum.map((a, i) => (
                  <tr key={i}>
                    <td className="mono" style={{ color: 'var(--accent)' }}>{i + 1}</td>
                    <td className="mono small">{hx(a.block)}</td>
                    <td className="mono small">{hx(a.y)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </Panel>
  )
}

// ── the nonce-reuse cliff: GCM vs GCM-SIV ─────────────────────────────────────

const REUSE_KEY = parseHex('01000000000000000000000000000000', 16)
const REUSE_NONCE = parseHex('030000000000000000000000', 12)

function NonceReusePanel() {
  const [m1, setM1] = useState('transfer $100 to alice')
  const [m2, setM2] = useState('transfer $900 to eve!!')

  const data = useMemo(() => {
    const p1 = utf8(m1)
    const p2 = utf8(m2)
    const n = Math.min(p1.length, p2.length)

    // GCM, SAME nonce twice — the classic catastrophe.
    const g1 = gcmEncrypt(REUSE_KEY, REUSE_NONCE, p1)
    const g2 = gcmEncrypt(REUSE_KEY, REUSE_NONCE, p2)
    // XOR of the two ciphertexts equals XOR of the two plaintexts: keystream cancels.
    const ctXor = new Uint8Array(n)
    const ptXor = new Uint8Array(n)
    for (let i = 0; i < n; i++) { ctXor[i] = g1.ciphertext[i] ^ g2.ciphertext[i]; ptXor[i] = p1[i] ^ p2[i] }
    let leak = true
    for (let i = 0; i < n; i++) if (ctXor[i] !== ptXor[i]) leak = false

    // GCM-SIV, SAME nonce twice — degrades gracefully.
    const s1 = gcmSivEncrypt(REUSE_KEY, REUSE_NONCE, p1)
    const s2 = gcmSivEncrypt(REUSE_KEY, REUSE_NONCE, p2)
    const sivCtXor = new Uint8Array(n)
    for (let i = 0; i < n; i++) sivCtXor[i] = s1.ciphertext[i] ^ s2.ciphertext[i]
    let sivLeak = true
    for (let i = 0; i < n; i++) if (sivCtXor[i] !== ptXor[i]) sivLeak = false
    // identical plaintext under the reused nonce is deterministic (the only leak)
    const sSame = gcmSivEncrypt(REUSE_KEY, REUSE_NONCE, p1)
    const sivDeterministic = hx(sSame.ciphertext) === hx(s1.ciphertext) && hx(sSame.tag) === hx(s1.tag)

    return { g1, g2, ctXor, ptXor, leak, s1, s2, sivCtXor, sivLeak, sivDeterministic }
  }, [m1, m2])

  return (
    <Panel
      title="The nonce-reuse cliff — GCM vs GCM-SIV"
      sub="Encrypt two different messages under the SAME (key, nonce). GCM's keystream repeats, so XOR of the two ciphertexts reveals the XOR of the two plaintexts — a total break. GCM-SIV derives its counter from the plaintext itself, so nothing lines up. This is why misuse-resistant AEAD exists."
    >
      <div className="grid cols-2" style={{ marginBottom: '0.8rem' }}>
        <div>
          <label className="sub">message 1</label>
          <input style={{ width: '100%' }} value={m1} onChange={(e) => setM1(e.target.value)} />
        </div>
        <div>
          <label className="sub">message 2 (same length reads best)</label>
          <input style={{ width: '100%' }} value={m2} onChange={(e) => setM2(e.target.value)} />
        </div>
      </div>

      <div className="grid cols-2">
        <div className="panel" style={{ margin: 0, borderColor: 'var(--bad)' }}>
          <h2 style={{ fontSize: '1rem', justifyContent: 'space-between' }}>
            <span>AES-GCM (nonce reused)</span>
            <Verdict ok={!data.leak}>{data.leak ? 'BROKEN — plaintext XOR leaked' : 'ok'}</Verdict>
          </h2>
          <dl className="kv">
            <dt>C₁ ⊕ C₂</dt>
            <dd className="mono small">{hx(data.ctXor)}</dd>
            <dt>P₁ ⊕ P₂</dt>
            <dd className="mono small">{hx(data.ptXor)}</dd>
          </dl>
          <div className="note" style={{ marginTop: '0.4rem' }}>
            The two rows are <strong>identical</strong>: the shared keystream cancels, so anyone who sees both
            ciphertexts recovers P₁ ⊕ P₂ — and with any known plaintext, the other message outright.
          </div>
        </div>

        <div className="panel" style={{ margin: 0, borderColor: 'var(--good)' }}>
          <h2 style={{ fontSize: '1rem', justifyContent: 'space-between' }}>
            <span>AES-GCM-SIV (nonce reused)</span>
            <Verdict ok={!data.sivLeak}>{data.sivLeak ? 'leak' : 'safe — no keystream reuse'}</Verdict>
          </h2>
          <dl className="kv">
            <dt>C₁ ⊕ C₂</dt>
            <dd className="mono small">{hx(data.sivCtXor ?? new Uint8Array(0)) || hx(new Uint8Array(0))}</dd>
            <dt>≟ P₁ ⊕ P₂</dt>
            <dd className="mono small">{hx(data.ptXor)}</dd>
          </dl>
          <div className="note" style={{ marginTop: '0.4rem' }}>
            The rows <strong>differ</strong>: the synthetic IV makes each message's keystream depend on its own
            content. Identical plaintext under the same nonce is deterministic{' '}
            <Verdict ok={data.sivDeterministic}>{data.sivDeterministic ? 'confirmed' : '—'}</Verdict> — the minimum any
            deterministic scheme must leak, and nothing more.
          </div>
        </div>
      </div>
    </Panel>
  )
}

// ── AES-CCM (RFC 3610) ────────────────────────────────────────────────────────

const CCM_KEY = parseHex('c0c1c2c3c4c5c6c7c8c9cacbcccdcecf', 16)
const CCM_NONCE = parseHex('00000003020100a0a1a2a3a4a5', 13)

function CcmPanel() {
  const [msg, setMsg] = useState('the WPA2 / Bluetooth-LE cipher')
  const [adText, setAdText] = useState('frame-header')
  const data = useMemo(() => {
    const pt = utf8(msg)
    const ad = utf8(adText)
    const r = ccmEncrypt(CCM_KEY, CCM_NONCE, pt, ad, 8)
    const dec = ccmDecrypt(CCM_KEY, CCM_NONCE, r.ciphertext, r.tag, ad)
    return { r, dec }
  }, [msg, adText])
  return (
    <Panel
      title="AES-CCM — Counter with CBC-MAC (RFC 3610)"
      sub="The other major AES AEAD: the mandatory cipher of Wi-Fi WPA2 (CCMP), Bluetooth LE, Zigbee/Thread, and the TLS AES-CCM suites. It authenticates with a plain CBC-MAC and encrypts with CTR — no field multiply, so it runs on the smallest radios. Here with an 8-byte tag."
    >
      <div className="grid cols-2">
        <div>
          <label className="sub">plaintext</label>
          <input style={{ width: '100%', marginBottom: '0.5rem' }} value={msg} onChange={(e) => setMsg(e.target.value)} />
          <label className="sub">associated data</label>
          <input style={{ width: '100%' }} value={adText} onChange={(e) => setAdText(e.target.value)} />
        </div>
        <div>
          <dl className="kv">
            <dt>ciphertext</dt>
            <dd className="hexbox" style={{ gridColumn: '1 / -1', wordBreak: 'break-all' }}>{hx(data.r.ciphertext)}</dd>
            <dt>tag (8 B)</dt>
            <dd className="hexbox violet" style={{ gridColumn: '1 / -1' }}>{hx(data.r.tag)}</dd>
          </dl>
          <div style={{ marginTop: '0.5rem' }}>
            <Verdict ok={data.dec !== null}>{data.dec !== null ? 'CBC-MAC verifies + decrypts' : 'rejected'}</Verdict>
          </div>
        </div>
      </div>
    </Panel>
  )
}

// ── AES-CMAC ──────────────────────────────────────────────────────────────────

function CmacPanel() {
  const [keyHex] = useState('2b7e151628aed2a6abf7158809cf4f3c')
  const [msg, setMsg] = useState('authenticate me with a block cipher')
  const key = parseHex(keyHex, 16)
  const sk = cmacSubkeys(key)
  const tag = cmac(key, utf8(msg))
  const forged = cmac(key, utf8(msg + '.'))

  return (
    <Panel
      title="AES-CMAC — a MAC from the block cipher (RFC 4493)"
      sub="CBC-MAC is insecure for variable-length messages; CMAC fixes it with two subkeys K1, K2 derived by a GF(2¹²⁸) shift, XORed into the final block. This is the authenticator inside AES-CCM (WPA2) and AES-SIV."
    >
      <label className="sub">message</label>
      <input style={{ width: '100%', marginBottom: '0.6rem' }} value={msg} onChange={(e) => setMsg(e.target.value)} />
      <dl className="kv">
        <dt>key</dt>
        <dd className="mono small">{keyHex}</dd>
        <dt>subkey K1</dt>
        <dd className="mono small">{hx(sk.K1)}</dd>
        <dt>subkey K2</dt>
        <dd className="mono small">{hx(sk.K2)}</dd>
        <dt>CMAC tag</dt>
        <dd className="hexbox violet" style={{ gridColumn: '1 / -1' }}>{hx(tag)}</dd>
      </dl>
      <div className="note" style={{ marginTop: '0.4rem' }}>
        Append one character and the tag changes completely (avalanche):{' '}
        <span className="mono small">{hx(forged).slice(0, 24)}…</span>
      </div>
    </Panel>
  )
}

// ── AES-SIV (RFC 5297) ────────────────────────────────────────────────────────

const SIV_KEY = parseHex('fffefdfcfbfaf9f8f7f6f5f4f3f2f1f0f0f1f2f3f4f5f6f7f8f9fafbfcfdfeff', 32)

function SivPanel() {
  const [msg, setMsg] = useState('deterministic AEAD — same input, same output')
  const [adText, setAdText] = useState('header')
  const data = useMemo(() => {
    const pt = utf8(msg)
    const ad = [utf8(adText)]
    const r = sivEncrypt(SIV_KEY, pt, ad)
    const dec = sivDecrypt(SIV_KEY, r.v, r.ciphertext, ad)
    const again = sivEncrypt(SIV_KEY, pt, ad)
    const deterministic = hx(again.v) === hx(r.v) && hx(again.ciphertext) === hx(r.ciphertext)
    return { r, dec, deterministic }
  }, [msg, adText])

  return (
    <Panel
      title="AES-SIV — the CMAC-based deterministic AEAD (RFC 5297)"
      sub="GCM-SIV's sibling: nonce-misuse resistance built on the block-cipher MAC instead of a polynomial hash. S2V folds the associated data and plaintext into a synthetic IV that is also the tag; there is no nonce at all, so identical inputs encrypt identically — the property that makes it useful for deterministic / searchable encryption and key wrapping (RFC 8291 Web Push)."
    >
      <div className="grid cols-2">
        <div>
          <label className="sub">plaintext</label>
          <input style={{ width: '100%', marginBottom: '0.5rem' }} value={msg} onChange={(e) => setMsg(e.target.value)} />
          <label className="sub">associated data</label>
          <input style={{ width: '100%' }} value={adText} onChange={(e) => setAdText(e.target.value)} />
        </div>
        <div>
          <dl className="kv">
            <dt>synthetic IV = tag V</dt>
            <dd className="hexbox violet" style={{ gridColumn: '1 / -1' }}>{hx(data.r.v)}</dd>
            <dt>ciphertext</dt>
            <dd className="hexbox" style={{ gridColumn: '1 / -1', wordBreak: 'break-all' }}>{hx(data.r.ciphertext)}</dd>
          </dl>
          <div style={{ marginTop: '0.5rem' }}>
            <Verdict ok={data.dec !== null}>{data.dec !== null ? 'verifies + decrypts' : 'rejected'}</Verdict>{' '}
            <Verdict ok={data.deterministic}>{data.deterministic ? 'deterministic' : 'non-deterministic'}</Verdict>
          </div>
        </div>
      </div>
    </Panel>
  )
}

// ── the page ──────────────────────────────────────────────────────────────────

export function AesGcmPage() {
  return (
    <main className="page">
      <PageHead eyebrow="Lab 35 — the symmetric layer" title="AES & the Authenticated Modes">
        The lab had one symmetric cipher — ChaCha20 — and none of the standard the rest of the world
        actually runs on. This is <strong>AES</strong> (FIPS-197), built from the GF(2⁸) field up: the
        S-box computed from a multiplicative inverse, the key schedule, the round transformations — then
        the authenticated modes that ride on it. <strong>AES-GCM</strong> is the default AEAD in TLS 1.3; <strong>AES-CCM</strong> is the one on every
        Wi-Fi and Bluetooth radio; <strong>AES-GCM-SIV</strong> and <strong>AES-SIV</strong> are the
        nonce-misuse-resistant successors (one polynomial-hash, one CMAC-based); <strong>AES-CMAC</strong>{' '}
        is the block-cipher MAC underneath.
        Every byte here is computed in your browser and pinned to the FIPS / NIST / RFC test vectors on
        the Self-Test page.
      </PageHead>

      <AesEngine />
      <GcmPanel />
      <NonceReusePanel />
      <SivPanel />
      <CcmPanel />
      <CmacPanel />

      <Panel title="Why this matters">
        <p style={{ color: 'var(--ink-dim)', maxWidth: '74ch' }}>
          AES-GCM secures the overwhelming majority of TLS traffic on the internet, plus SSH, IPsec, and
          disk encryption. Its Achilles' heel is the nonce: repeat one and the authentication key leaks.
          GCM-SIV — deployed by Google and standardised as RFC 8452 — trades a second pass over the data
          for graceful degradation, so a rebooted VM or a bad RNG no longer ends the world. Seeing both
          side by side, on the same from-scratch AES core, is the whole argument for misuse resistance in
          one screen. This same AES-256-GCM is wired into the{' '}
          <a href="#/sealed">Sealed channel</a> as an alternative to ChaCha20-Poly1305 — the Double Ratchet
          is cipher-agnostic.
        </p>
      </Panel>
    </main>
  )
}
