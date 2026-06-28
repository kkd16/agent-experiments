import { useEffect, useMemo, useState } from 'react'
import { PageHead, Panel, Verdict } from '../ui/components'
import {
  expandMessageXmd,
  hashToFieldFp,
  hashToFieldFp2,
  hashToCurveG1,
  hashToCurveG2,
} from '../ecc/hash2curve'
import { compressG1, compressG2, decompressG1, decompressG2 } from '../ecc/blsenc'
import {
  keyGen,
  skToPk,
  sign as blsSign,
  verify as blsVerify,
  popProve,
  popVerify,
  ikmFromLabel,
} from '../ecc/blssig'
import { R, g1, g2, type G1, type G2 } from '../ecc/bls12381'
import { utf8, bytesToHex } from '../ecc/sha256'
import { hex, ellipsize } from '../ui/format'

const DST_G1 = 'QUUX-V01-CS02-with-BLS12381G1_XMD:SHA-256_SSWU_RO_'
const DST_G2 = 'QUUX-V01-CS02-with-BLS12381G2_XMD:SHA-256_SSWU_RO_'

// The published RFC 9380 J.9.1 / J.10.1 outputs for msg = "abc".
const RFC_G1_ABC_X =
  0x03567bc5ef9c690c2ab2ecdf6a96ef1c139cc0b2f284dca0a9a7943388a49a3aee664ba5379a7655d3c68900be2f6903n
const RFC_G2_ABC_X0 =
  0x02c2d18e033b960562aae3cab37a27ce00d80ccd5ba4b7fe0e7a210245129dbec7780ccc7954725f4168aff2787776e6n

export function HashToCurvePage() {
  const [msg, setMsg] = useState('abc')
  const [group, setGroup] = useState<'G1' | 'G2'>('G1')
  const [label, setLabel] = useState('alice')

  const bytes = useMemo(() => utf8(msg), [msg])
  const dst = group === 'G1' ? DST_G1 : DST_G2
  const dstBytes = useMemo(() => utf8(dst), [dst])

  const fieldL = group === 'G1' ? 64 : 128 // bytes consumed per element

  const expanded = useMemo(
    () => bytesToHex(expandMessageXmd(bytes, dstBytes, 2 * fieldL)),
    [bytes, dstBytes, fieldL],
  )

  const point = useMemo(() => {
    if (group === 'G1') {
      const u = hashToFieldFp(bytes, dstBytes, 2)
      const P = hashToCurveG1(bytes, dstBytes)
      return { kind: 'G1' as const, u, P }
    }
    const u = hashToFieldFp2(bytes, dstBytes, 2)
    const P = hashToCurveG2(bytes, dstBytes)
    return { kind: 'G2' as const, u, P }
  }, [bytes, dstBytes, group])

  const onCurve =
    point.kind === 'G1' ? g1.isOnCurve(point.P as G1) : g2.isOnCurve(point.P as G2)
  const inSubgroup =
    point.kind === 'G1'
      ? g1.mulRaw(R, point.P as G1) === null
      : g2.mul(R, point.P as G2) === null

  const serialized =
    point.kind === 'G1' ? compressG1(point.P as G1) : compressG2(point.P as G2)
  const roundTrips =
    point.kind === 'G1'
      ? g1.eq(decompressG1(serialized), point.P as G1)
      : g2.eq(decompressG2(serialized), point.P as G2)

  const matchesRfc =
    msg === 'abc' &&
    (point.kind === 'G1'
      ? (point.P as G1)?.x === RFC_G1_ABC_X
      : (point.P as G2)?.x.a === RFC_G2_ABC_X0)

  // ── standard BLS signature over the same message (pairings deferred) ──
  const sk = useMemo(() => keyGen(ikmFromLabel(label)), [label])
  const pk = useMemo(() => skToPk(sk), [sk])
  const sig = useMemo(() => blsSign(sk, bytes), [sk, bytes])

  const key = `${label}|${msg}`
  const [bls, setBls] = useState<{ key: string; ok: boolean; pop: boolean } | null>(null)
  useEffect(() => {
    let alive = true
    const id = setTimeout(() => {
      const ok = blsVerify(pk, bytes, sig)
      const pop = popVerify(pk, popProve(sk))
      if (alive) setBls({ key, ok, pop })
    }, 30)
    return () => {
      alive = false
      clearTimeout(id)
    }
  }, [pk, sig, sk, bytes, key])
  const blsFresh = bls !== null && bls.key === key

  const fieldHex = (e: bigint) => ellipsize(hex(e, 96), 12, 8)

  return (
    <main className="page">
      <PageHead eyebrow="Lab 20 — turn any message into a curve point" title="Hash-to-Curve (RFC 9380)">
        Every BLS signature begins by hashing a message <em>onto the curve</em> — and doing it badly
        leaks keys. RFC 9380's constant-shape map replaces naïve "try-and-increment" with a fixed
        pipeline: <code>expand_message_xmd</code> stretches the message to uniform bytes, those become
        field elements, the Simplified SWU map sends each onto an <em>isogenous</em> curve (BLS12-381's
        own curves have <code>A=0</code>, so SSWU can't run directly), an 11- or 3-isogeny carries them
        back, and a cofactor multiply lands the sum in the prime-order subgroup. This is the exact map
        Ethereum's consensus uses — verified here against the RFC's own test vectors.
      </PageHead>

      <Panel title="Message" sub="Pick the target group and type a message. Everything below recomputes live.">
        <div className="grid cols-2" style={{ gap: '1rem' }}>
          <label className="field">
            <span>message</span>
            <input value={msg} onChange={(e) => setMsg(e.target.value)} />
          </label>
          <div className="field">
            <span>target group</span>
            <div className="seg">
              {(['G1', 'G2'] as const).map((g) => (
                <button
                  key={g}
                  className={group === g ? 'on' : ''}
                  onClick={() => setGroup(g)}
                >
                  𝔾{g === 'G1' ? '₁' : '₂'}
                </button>
              ))}
            </div>
          </div>
        </div>
        <dl className="kv" style={{ marginTop: '0.6rem' }}>
          <dt>DST</dt>
          <dd className="mono" style={{ gridColumn: '1 / -1', wordBreak: 'break-all' }}>{dst}</dd>
        </dl>
      </Panel>

      <Panel
        title="1 · expand_message_xmd"
        sub="MD-strengthened SHA-256 stretches (msg, DST) into 2·L uniform bytes (L = 64 for 𝔾₁, 128 for 𝔾₂)."
      >
        <div className="hexbox" style={{ wordBreak: 'break-all' }}>{ellipsize(expanded, 64, 16)}</div>
      </Panel>

      <Panel title="2 · hash_to_field → u₀, u₁" sub="Each L-byte block is reduced mod p into a field element.">
        <dl className="kv">
          {point.u.map((u, i) =>
            point.kind === 'G1' ? (
              <FieldRow key={i} name={`u${i}`} value={fieldHex(u as bigint)} />
            ) : (
              <FieldRow
                key={i}
                name={`u${i}`}
                value={`${fieldHex((u as { a: bigint; b: bigint }).a)} + ${fieldHex((u as { a: bigint; b: bigint }).b)}·u`}
              />
            ),
          )}
        </dl>
      </Panel>

      <Panel
        title="3 · map_to_curve + 4 · clear_cofactor → P"
        sub="SSWU onto E′, the isogeny back to E, then the two field points summed and cofactor-cleared."
        right={
          matchesRfc ? <span className="tag ok">matches RFC 9380 ✓</span> : undefined
        }
      >
        {point.P === null ? (
          <div className="note">point at infinity</div>
        ) : point.kind === 'G1' ? (
          <dl className="kv">
            <FieldRow name="P.x" value={ellipsize(hex((point.P as G1)!.x, 96), 16, 12)} />
            <FieldRow name="P.y" value={ellipsize(hex((point.P as G1)!.y, 96), 16, 12)} />
          </dl>
        ) : (
          <dl className="kv">
            <FieldRow name="P.x.c₀" value={ellipsize(hex((point.P as G2)!.x.a, 96), 16, 12)} />
            <FieldRow name="P.x.c₁" value={ellipsize(hex((point.P as G2)!.x.b, 96), 16, 12)} />
          </dl>
        )}
        <dl className="kv" style={{ marginTop: '0.5rem' }}>
          <dt>on the curve</dt>
          <dd><Verdict ok={onCurve}>{onCurve ? 'y² = x³ + b ✓' : 'no'}</Verdict></dd>
          <dt>in the prime-order subgroup (r·P = O)</dt>
          <dd><Verdict ok={inSubgroup}>{inSubgroup ? 'cofactor cleared ✓' : 'no'}</Verdict></dd>
        </dl>
      </Panel>

      <Panel
        title="5 · serialize (ZCash / Ethereum wire format)"
        sub="x-only with three flag bits; 𝔾₂ packs imaginary-part-first. Decompression recovers y from its sign bit."
      >
        <div className="hexbox violet" style={{ wordBreak: 'break-all' }}>
          {ellipsize(bytesToHex(serialized), 48, 12)}
        </div>
        <dl className="kv" style={{ marginTop: '0.5rem' }}>
          <dt>{serialized.length} bytes · compress → decompress</dt>
          <dd><Verdict ok={roundTrips}>{roundTrips ? 'round-trips ✓' : 'failed'}</Verdict></dd>
        </dl>
      </Panel>

      <Panel
        title="A standard BLS signature on this message"
        sub="Key derived from a label with HKDF KeyGen; signed in 𝔾₁ with the ciphersuite DST; verified by a pairing."
        right={blsFresh ? undefined : <span className="tag warn">computing…</span>}
      >
        <label className="field" style={{ maxWidth: '16rem' }}>
          <span>key label (→ HKDF KeyGen)</span>
          <input value={label} onChange={(e) => setLabel(e.target.value)} />
        </label>
        <dl className="kv" style={{ marginTop: '0.5rem' }}>
          <dt>secret key</dt>
          <dd className="mono">{ellipsize(hex(sk, 64), 12, 8)}</dd>
          <dt>public key (𝔾₂, 96 B)</dt>
          <dd className="hexbox lavender" style={{ gridColumn: '1 / -1' }}>{ellipsize(bytesToHex(compressG2(pk)), 40, 10)}</dd>
          <dt>signature (𝔾₁, 48 B)</dt>
          <dd className="hexbox" style={{ gridColumn: '1 / -1' }}>{ellipsize(bytesToHex(compressG1(sig)), 40, 10)}</dd>
          {blsFresh && bls && (
            <>
              <dt>verify e(σ,G₂) = e(H(m),pk)</dt>
              <dd><Verdict ok={bls.ok}>{bls.ok ? 'valid ✓' : 'invalid'}</Verdict></dd>
              <dt>proof-of-possession</dt>
              <dd><Verdict ok={bls.pop}>{bls.pop ? 'verified ✓' : 'failed'}</Verdict></dd>
            </>
          )}
        </dl>
        <div className="note" style={{ marginTop: '0.6rem' }}>
          This is the full "minimal-signature-size" ciphersuite: a 32-byte seed becomes a key via the
          draft's salted HKDF (it reproduces the EIP-2333 master-key vector), the message is mapped into
          𝔾₁ above, and one pairing verifies it.
        </div>
      </Panel>
    </main>
  )
}

function FieldRow({ name, value }: { name: string; value: string }) {
  return (
    <>
      <dt>{name}</dt>
      <dd className="mono" style={{ wordBreak: 'break-all' }}>{value}</dd>
    </>
  )
}
