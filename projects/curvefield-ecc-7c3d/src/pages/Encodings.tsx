import { useMemo, useState } from 'react'
import { PageHead, Panel, Verdict } from '../ui/components'
import {
  deriveAll,
  pointCompress,
  pointUncompress,
  pointDecode,
  derEncode,
  derDecode,
  hash160,
  wifDecode,
} from '../ecc/encoding'
import { publicKey, ecdsaSign, N, secp256k1 } from '../ecc/secp256k1'
import { type Point } from '../ecc/curve'
import { bytesToHex, hexToBytes, utf8 } from '../ecc/sha256'
import { randomScalar } from '../ecc/rng'
import { hex } from '../ui/format'

type Tab = 'keys' | 'points' | 'der'

export function Encodings() {
  const [tab, setTab] = useState<Tab>('keys')
  return (
    <main className="page">
      <PageHead eyebrow="Lab 06 — serialization" title="Encodings & Addresses">
        A key is a number; a signature is a pair of numbers. Everything you actually{' '}
        <em>see</em> — a <code>bc1…</code> address, a <code>5H…</code> private key, a hex blob of
        DER — is that math wrapped in an encoding. This lab builds every layer from scratch:{' '}
        SEC point compression, Base58Check, Bech32/Bech32m, WIF, DER, and the HASH160 addresses on
        top, each one validated against published vectors on the Self-Test page.
      </PageHead>

      <div className="seg" style={{ marginBottom: '1.2rem' }}>
        <button className={tab === 'keys' ? 'on' : ''} onClick={() => setTab('keys')}>
          Keys & Addresses
        </button>
        <button className={tab === 'points' ? 'on' : ''} onClick={() => setTab('points')}>
          Point Compression
        </button>
        <button className={tab === 'der' ? 'on' : ''} onClick={() => setTab('der')}>
          DER Signatures
        </button>
      </div>

      {tab === 'keys' && <KeysLab />}
      {tab === 'points' && <PointLab />}
      {tab === 'der' && <DerLab />}
    </main>
  )
}

// ── Keys → WIF + addresses ───────────────────────────────────────────────────

function Row({ label, value, accent }: { label: string; value: string; accent?: string }) {
  return (
    <>
      <dt>{label}</dt>
      <dd className={'hexbox' + (accent ? ' ' + accent : '')} style={{ gridColumn: '1 / -1' }}>
        {value}
      </dd>
    </>
  )
}

function KeysLab() {
  const [d, setD] = useState(() => randomScalar(N))
  const [text, setText] = useState('')
  const [err, setErr] = useState('')
  const derived = useMemo(() => deriveAll(d), [d])

  const importWif = () => {
    setErr('')
    try {
      const { d: dd } = wifDecode(text.trim())
      setD(dd)
      setText('')
    } catch (e) {
      setErr((e as Error).message)
    }
  }

  return (
    <>
      <div className="statline" style={{ marginBottom: '1.4rem' }}>
        <div className="stat"><b>0x80</b><span>WIF version byte</span></div>
        <div className="stat"><b>0x00</b><span>P2PKH version</span></div>
        <div className="stat"><b>bc1q</b><span>P2WPKH (v0)</span></div>
        <div className="stat"><b>bc1p</b><span>P2TR (v1)</span></div>
      </div>

      <Panel
        title="One private key, every public form"
        sub="A single 256-bit secret fans out into the keys, WIFs, and addresses a wallet would store."
        right={
          <button className="btn" onClick={() => setD(randomScalar(N))}>
            ↻ new key
          </button>
        }
      >
        <dl className="kv">
          <Row label="private d" value={hex(d, 64)} />
          <Row label="WIF (compressed)" value={derived.wifCompressed} accent="lavender" />
          <Row label="WIF (uncompressed)" value={derived.wifUncompressed} />
          <Row label="pubkey (compressed, 33B)" value={bytesToHex(derived.pubCompressed)} accent="violet" />
          <Row label="pubkey (uncompressed, 65B)" value={bytesToHex(derived.pubUncompressed)} />
          <Row label="HASH160(compressed)" value={bytesToHex(hash160(derived.pubCompressed))} />
          <Row label="P2PKH  (1…, compressed)" value={derived.p2pkhCompressed} accent="lavender" />
          <Row label="P2PKH  (1…, uncompressed)" value={derived.p2pkhUncompressed} />
          <Row label="P2WPKH (bc1q…, SegWit v0)" value={derived.p2wpkh} accent="violet" />
        </dl>

        <div style={{ marginTop: '1rem' }}>
          <input
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder="import a WIF private key (5…, K…, or L…)"
          />
          <div className="btn-row" style={{ marginTop: '0.5rem' }}>
            <button className="btn" onClick={importWif}>
              import WIF
            </button>
            {err && <span className="tag no">{err}</span>}
          </div>
        </div>
      </Panel>

      <Panel title="How an address is built" sub="Every arrow below is a function in this lab.">
        <div className="mono note" style={{ lineHeight: 1.9 }}>
          d (scalar) ──[×G]──▸ Q (point)
          <br />
          Q ──[SEC compress]──▸ 02/03‖x ──[SHA-256]──▸ ──[RIPEMD-160]──▸ HASH160 (20 bytes)
          <br />
          HASH160 ──[0x00 ‖ h ‖ checksum]──[Base58]──▸ <b>P2PKH</b> (legacy “1…”)
          <br />
          HASH160 ──[witness v0 ‖ convertbits 8→5]──[Bech32]──▸ <b>P2WPKH</b> (“bc1q…”)
        </div>
      </Panel>
    </>
  )
}

// ── Point compression / decompression ────────────────────────────────────────

function PointLab() {
  const [k, setK] = useState('12345')
  const [xText, setXText] = useState('')
  const [decoded, setDecoded] = useState<{ ok: boolean; msg: string }>({ ok: true, msg: '' })

  const Q: Point = useMemo(() => {
    try {
      const v = BigInt(k.trim() || '1')
      return publicKey(((v % N) + N) % N || 1n)
    } catch {
      return null
    }
  }, [k])

  const comp = Q ? bytesToHex(pointCompress(Q)) : '—'
  const uncomp = Q ? bytesToHex(pointUncompress(Q)) : '—'

  const tryDecode = () => {
    try {
      const pt = pointDecode(hexToBytes(xText.trim()))
      const onCurve = secp256k1.isOnCurve(pt)
      setDecoded({
        ok: onCurve,
        msg: pt === null ? 'O (point at infinity)' : `(${hex(pt.x, 64)}, ${hex(pt.y, 64)})`,
      })
    } catch (e) {
      setDecoded({ ok: false, msg: (e as Error).message })
    }
  }

  return (
    <>
      <Panel
        title="Compress a point"
        sub="A curve point has two coordinates, but x plus a single parity bit is enough — y is one of two roots of x³+7, and the 02/03 prefix says which."
      >
        <div className="field" style={{ maxWidth: 320 }}>
          <label>
            <span>scalar k (so Q = k·G)</span>
          </label>
          <input value={k} onChange={(e) => setK(e.target.value)} placeholder="e.g. 12345" />
        </div>
        <dl className="kv" style={{ marginTop: '0.8rem' }}>
          <Row label="x" value={Q ? hex(Q.x, 64) : '—'} />
          <Row label="y" value={Q ? hex(Q.y, 64) : '—'} />
          <Row label="y parity" value={Q ? (Q.y % 2n === 0n ? 'even → prefix 02' : 'odd → prefix 03') : '—'} />
          <Row label="compressed (33 bytes)" value={comp} accent="violet" />
          <Row label="uncompressed (65 bytes)" value={uncomp} />
        </dl>
        <div className="note" style={{ marginTop: '0.6rem' }}>
          Compression halves the on-the-wire size of every public key — the reason modern wallets
          and Bitcoin transactions use it everywhere.
        </div>
      </Panel>

      <Panel
        title="Decompress — recover y from x"
        sub="Paste a SEC encoding (02/03‖x compressed, or 04‖x‖y uncompressed). Decoding solves y² = x³ + 7 with Tonelli–Shanks and selects the parity."
      >
        <div className="btn-row">
          <input
            value={xText}
            onChange={(e) => setXText(e.target.value)}
            placeholder="02… / 03… / 04…"
            style={{ flex: 1 }}
          />
          <button className="btn" onClick={tryDecode}>
            decode
          </button>
          {Q && (
            <button className="btn ghost" onClick={() => setXText(comp)}>
              use compressed above
            </button>
          )}
        </div>
        {decoded.msg && (
          <div style={{ marginTop: '0.8rem' }}>
            <Verdict ok={decoded.ok}>{decoded.ok ? 'on curve' : 'invalid'}</Verdict>
            <div className="hexbox" style={{ marginTop: '0.5rem' }}>
              {decoded.msg}
            </div>
          </div>
        )}
      </Panel>
    </>
  )
}

// ── DER signatures ───────────────────────────────────────────────────────────

function annotateDer(der: Uint8Array): { hex: string; note: string }[] {
  const rows: { hex: string; note: string }[] = []
  const h = (a: Uint8Array) => bytesToHex(a)
  rows.push({ hex: h(der.slice(0, 1)), note: '0x30 — SEQUENCE tag' })
  rows.push({ hex: h(der.slice(1, 2)), note: `length of body = ${der[1]} bytes` })
  let i = 2
  rows.push({ hex: h(der.slice(i, i + 1)), note: '0x02 — INTEGER tag (r)' })
  const rlen = der[i + 1]
  rows.push({ hex: h(der.slice(i + 1, i + 2)), note: `r length = ${rlen}` })
  rows.push({ hex: h(der.slice(i + 2, i + 2 + rlen)), note: 'r (big-endian, sign-padded)' })
  i = i + 2 + rlen
  rows.push({ hex: h(der.slice(i, i + 1)), note: '0x02 — INTEGER tag (s)' })
  const slen = der[i + 1]
  rows.push({ hex: h(der.slice(i + 1, i + 2)), note: `s length = ${slen}` })
  rows.push({ hex: h(der.slice(i + 2, i + 2 + slen)), note: 's (big-endian, low-s canonical)' })
  return rows
}

function DerLab() {
  const [msg, setMsg] = useState('Pay 0.05 BTC to Alice')
  const [d] = useState(() => randomScalar(N))
  const [raw, setRaw] = useState('')
  const [parse, setParse] = useState<{ ok: boolean; msg: string }>({ ok: true, msg: '' })

  const sig = useMemo(() => ecdsaSign(d, utf8(msg)), [d, msg])
  const der = useMemo(() => derEncode(sig), [sig])
  const rows = useMemo(() => annotateDer(der), [der])

  const checkStrict = () => {
    try {
      const parsed = derDecode(hexToBytes(raw.trim()))
      setParse({ ok: true, msg: `r = ${hex(parsed.r, 16)}…  s = ${hex(parsed.s, 16)}…` })
    } catch (e) {
      setParse({ ok: false, msg: (e as Error).message })
    }
  }

  // A malleated-but-mathematically-equal encoding: pad r with a leading 0x00.
  const malleate = () => {
    // Rebuild with a non-minimal r (extra 00) to demonstrate strict rejection.
    const body = der.slice(2)
    const rlen = body[1]
    const rBytes = body.slice(2, 2 + rlen)
    const sPart = body.slice(2 + rlen)
    const rPadded = new Uint8Array([0x02, rlen + 1, 0x00, ...rBytes])
    const newBody = new Uint8Array([...rPadded, ...sPart])
    const mauled = new Uint8Array([0x30, newBody.length, ...newBody])
    setRaw(bytesToHex(mauled))
  }

  return (
    <>
      <Panel
        title="Anatomy of a DER signature"
        sub="ECDSA signs to a pair (r, s). On the wire it becomes ASN.1 DER — the exact bytes a node parses, byte for byte."
      >
        <div className="field" style={{ marginBottom: '0.8rem' }}>
          <label>
            <span>message</span>
          </label>
          <input value={msg} onChange={(e) => setMsg(e.target.value)} />
        </div>
        <div className="hexbox violet" style={{ marginBottom: '0.8rem' }}>
          {bytesToHex(der)}
        </div>
        <table className="data">
          <thead>
            <tr>
              <th>bytes</th>
              <th>meaning</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r, idx) => (
              <tr key={idx}>
                <td className="mono">{r.hex}</td>
                <td>{r.note}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Panel>

      <Panel
        title="Strict DER — the malleability gate"
        sub="Bitcoin's BIP-66 accepts only one canonical encoding. A re-padded but numerically-equal signature is rejected; that strictness is what removes a whole class of transaction-malleability bugs."
      >
        <div className="btn-row">
          <input
            value={raw}
            onChange={(e) => setRaw(e.target.value)}
            placeholder="paste a DER signature (hex)"
            style={{ flex: 1 }}
          />
          <button className="btn" onClick={checkStrict}>
            validate
          </button>
        </div>
        <div className="btn-row" style={{ marginTop: '0.5rem' }}>
          <button className="btn ghost" onClick={() => setRaw(bytesToHex(der))}>
            load canonical
          </button>
          <button className="btn ghost" onClick={malleate}>
            load malleated (extra 0x00 in r)
          </button>
        </div>
        {parse.msg && (
          <div style={{ marginTop: '0.8rem' }}>
            <Verdict ok={parse.ok}>{parse.ok ? 'valid strict DER' : 'rejected'}</Verdict>
            <div className="note" style={{ marginTop: '0.4rem' }}>
              {parse.msg}
            </div>
          </div>
        )}
      </Panel>
    </>
  )
}