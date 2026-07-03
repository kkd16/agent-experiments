import { useMemo, useState } from 'react'
import { PageHead, Panel, Verdict } from '../ui/components'
import { bytesToHex } from '../ecc/sha256'
import { randomBytes, seedRng } from '../ecc/rng'
import { ellipsize } from '../ui/format'
import {
  PARAM_SETS,
  MLKEM768,
  keyGen,
  encaps,
  decaps,
  kpkeKeyGen,
  kemSizes,
  invNtt,
  toSigned,
  type MlKemParams,
} from '../ecc/mlkem'
import { hybridClientKeyGen, hybridServerRespond, hybridClientFinish } from '../ecc/hybridkem'

const hx = (b: Uint8Array, head = 8, tail = 6) => ellipsize(bytesToHex(b), head, tail)

const fmtBytes = (n: number): string =>
  n < 1024 ? `${n.toLocaleString()} B` : `${(n / 1024).toFixed(2)} KB`

// A compact byte grid — the first `n` bytes of a blob, coloured by magnitude,
// so a key or a ciphertext reads as the pseudorandom object it is.
function ByteGrid({ bytes, n = 96, hue }: { bytes: Uint8Array; n?: number; hue: number }) {
  const cells = Array.from(bytes.subarray(0, n))
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(32, 1fr)', gap: 2, marginTop: '0.5rem' }}>
      {cells.map((v, i) => (
        <div
          key={i}
          title={`byte ${i} = ${v}`}
          style={{
            aspectRatio: '1', borderRadius: 2,
            background: `hsl(${hue} 70% ${18 + (v / 255) * 52}%)`,
          }}
        />
      ))}
    </div>
  )
}

export function MlKemPage() {
  const [params, setParams] = useState<MlKemParams>(MLKEM768)
  // 32-byte seeds; deterministic outputs so the whole page is reproducible.
  const [seedNonce, setSeedNonce] = useState(0)
  const [tamper, setTamper] = useState(false)

  const seeds = useMemo(() => {
    seedRng(0xc0ffee + seedNonce)
    return { d: randomBytes(32), z: randomBytes(32), m: randomBytes(32) }
  }, [seedNonce])

  const run = useMemo(() => {
    const { d, z, m } = seeds
    // The K-PKE core, kept around so we can peek at the "short" secret and t̂.
    const pke = kpkeKeyGen(params, d)
    const s0 = invNtt(pke.sHat[0]) // back to coefficient form → small ±values
    const { ek, dk } = keyGen(params, d, z)
    const enc = encaps(params, ek, m)
    // Optionally maul one ciphertext byte to exercise implicit rejection.
    const ct = enc.ciphertext.slice()
    if (tamper) ct[7] ^= 0x01
    const dec = decaps(params, dk, ct)
    const agree = bytesToHex(dec.sharedSecret) === bytesToHex(enc.sharedSecret)

    // Histogram of the short secret's coefficients (centered binomial, η1).
    const eta = params.eta1
    const hist = new Array<number>(2 * eta + 1).fill(0)
    for (let i = 0; i < 256; i++) hist[toSigned(s0[i]) + eta]++

    // Hybrid X25519MLKEM768 handshake — reuse the page's seeds, and derive the
    // server's independent X25519 secret + encaps message deterministically so
    // the whole demo stays reproducible.
    const derive = (a: Uint8Array, tag: number): Uint8Array => {
      const out = new Uint8Array(32)
      for (let i = 0; i < 32; i++) out[i] = a[i] ^ (tag * 37 + i) & 0xff
      return out
    }
    const client = hybridClientKeyGen(d, z, m)
    const server = hybridServerRespond(client.clientShare, derive(m, 1), derive(z, 2))
    const hClient = hybridClientFinish(client, server.serverShare)
    const hybrid = {
      clientShare: client.clientShare,
      serverShare: server.serverShare,
      combined: server.sharedSecret,
      sessionKey: server.sessionKey,
      agree: bytesToHex(server.sessionKey) === bytesToHex(hClient.sessionKey),
    }

    return { d, z, m, ek, dk, rho: pke.rho, enc, dec, agree, hist, eta, s0, hybrid }
  }, [params, seeds, tamper])

  const sizes = kemSizes(params)
  const maxHist = Math.max(...run.hist)

  return (
    <div className="page">
      <PageHead eyebrow="Post-Quantum · Lattices" title="ML-KEM — the standard that outlives Shor">
        Everything else in this lab dies the day a large quantum computer boots: Shor's algorithm
        breaks every discrete log, so ECDH, ECDSA, Schnorr, and the pairings all fall at once.{' '}
        <strong>ML-KEM</strong> (FIPS&nbsp;203, the standardised CRYSTALS-Kyber) rests on a different
        rock — <em>Module-LWE</em>: recovering a short secret <code>s</code> from a noisy{' '}
        <code>t = A·s + e</code> over the ring <code>Z₃₃₂₉[X]/(X²⁵⁶+1)</code>, which no known quantum
        algorithm solves. Every byte below is computed live by a from-scratch engine — Keccak, the
        number-theoretic transform, the noise sampler, and the Fujisaki–Okamoto transform — with zero
        dependencies.
      </PageHead>

      <div className="seg" style={{ marginBottom: '1rem', flexWrap: 'wrap' }}>
        {PARAM_SETS.map((p) => (
          <button
            key={p.name}
            className={params.name === p.name ? 'on' : ''}
            onClick={() => setParams(p)}
          >
            {p.name}
          </button>
        ))}
        <button className="ghost" onClick={() => setSeedNonce((n) => n + 1)} style={{ marginLeft: 'auto' }}>
          ↻ fresh randomness
        </button>
      </div>

      <div className="statline" style={{ marginBottom: '1rem' }}>
        <div className="stat">
          <b>{params.k}</b>
          <span>module rank k</span>
        </div>
        <div className="stat">
          <b>3329</b>
          <span>modulus q</span>
        </div>
        <div className="stat">
          <b>256</b>
          <span>ring degree n</span>
        </div>
        <div className="stat">
          <b>{Math.round(params.k * 256 * Math.log2(3329))}</b>
          <span>lattice dim (bits)</span>
        </div>
        <div className="stat">
          <b>{params.name === 'ML-KEM-512' ? '≈128' : params.name === 'ML-KEM-768' ? '≈192' : '≈256'}</b>
          <span>NIST security bits</span>
        </div>
      </div>

      <Panel
        title="1 · KeyGen — hide a short secret behind a noisy linear system"
        sub="Expand a matrix Â from a 32-byte seed, sample a short secret ŝ and noise ê, publish t̂ = Â∘ŝ + ê. Recovering ŝ from (Â, t̂) is Module-LWE — believed hard even for a quantum computer."
      >
        <div className="grid cols-2" style={{ gridTemplateColumns: '1fr 1fr', gap: '1.2rem', alignItems: 'start' }}>
          <div>
            <dl className="kv">
              <dt>seed d</dt>
              <dd className="hexbox" style={{ gridColumn: '1 / -1' }}>{hx(run.d, 12, 8)}</dd>
              <dt>ρ (matrix seed)</dt>
              <dd className="hexbox violet" style={{ gridColumn: '1 / -1' }}>{hx(run.rho, 12, 8)}</dd>
              <dt>ek — public key</dt>
              <dd className="hexbox lavender" style={{ gridColumn: '1 / -1' }}>{hx(run.ek, 14, 8)}</dd>
              <dt>dk — secret key</dt>
              <dd className="hexbox" style={{ gridColumn: '1 / -1' }}>{hx(run.dk, 14, 8)}</dd>
            </dl>
            <div className="note" style={{ marginTop: '0.6rem' }}>
              <code>ek = ByteEncode₁₂(t̂) ‖ ρ</code> = {fmtBytes(sizes.ek)}. The public key is a full{' '}
              <code>k</code>-vector of 256 twelve-bit coefficients plus the 32-byte matrix seed — no
              32-byte curve point here, which is the price of quantum resistance.
            </div>
          </div>
          <div>
            <div className="sub" style={{ marginBottom: '0.4rem' }}>
              The short secret ŝ₀, back in coefficient form — a centered binomial (η={run.eta}). These
              tiny ±values are what the noise hides.
            </div>
            <div className="bars">
              {run.hist.map((count, i) => {
                const val = i - run.eta
                return (
                  <div className="bar" key={i}>
                    <span style={{ color: 'var(--ink-dim)', minWidth: 24, textAlign: 'right' }}>
                      {val > 0 ? `+${val}` : val}
                    </span>
                    <div className="track">
                      <div
                        className="fill"
                        style={{
                          width: `${(count / maxHist) * 100}%`,
                          background: val === 0 ? '#5eead4' : Math.abs(val) === run.eta ? '#fb7185' : '#a78bfa',
                        }}
                      />
                    </div>
                    <span className="mono" style={{ minWidth: 34, textAlign: 'right' }}>{count}</span>
                  </div>
                )
              })}
            </div>
          </div>
        </div>
      </Panel>

      <Panel
        title="2 · Encaps — mask a random message under the lattice, hash out a key"
        sub="Sample a fresh 32-byte m, derive all randomness as (K, r) = G(m ‖ H(ek)), encrypt m under ek, and ship the ciphertext. The shared secret is K — never transmitted, only re-derivable by the holder of dk."
      >
        <dl className="kv">
          <dt>message m</dt>
          <dd className="hexbox" style={{ gridColumn: '1 / -1' }}>{hx(run.m, 12, 8)}</dd>
          <dt>ciphertext c</dt>
          <dd className="hexbox violet" style={{ gridColumn: '1 / -1' }}>{hx(run.enc.ciphertext, 16, 10)}</dd>
          <dt>shared secret K</dt>
          <dd className="hexbox lavender" style={{ gridColumn: '1 / -1' }}>{bytesToHex(run.enc.sharedSecret)}</dd>
        </dl>
        <ByteGrid bytes={run.enc.ciphertext} hue={265} />
        <div className="note" style={{ marginTop: '0.6rem' }}>
          <code>c = (Compress_du(u), Compress_dv(v))</code> = {fmtBytes(sizes.ct)}. The coefficients of{' '}
          <code>u, v</code> are lossily rounded to <code>d_u={params.du}</code> / <code>d_v={params.dv}</code>{' '}
          bits — the noise budget absorbs the rounding error, and shrinking the ciphertext is exactly
          what those <code>Compress</code> steps buy.
        </div>
      </Panel>

      <Panel
        title="3 · Decaps — cancel the mask, then re-encrypt to catch a cheat"
        sub="The holder of dk peels A·s off the ciphertext and rounds back to m′, re-derives (K′, r′) = G(m′ ‖ h), and re-encrypts. If the ciphertext doesn't reproduce exactly, it returns a secret pseudorandom key instead — implicit rejection. That Fujisaki–Okamoto step is what turns IND-CPA into IND-CCA2."
        right={<Verdict ok={run.agree}>{run.agree ? 'K′ = K' : run.dec.rejected ? 'rejected' : 'mismatch'}</Verdict>}
      >
        <label className="field" style={{ marginBottom: '0.8rem' }}>
          <span style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
            <input type="checkbox" checked={tamper} onChange={(e) => setTamper(e.target.checked)} />
            Maul one ciphertext byte before decapsulation (active attack)
          </span>
        </label>
        <dl className="kv">
          <dt>recovered K′</dt>
          <dd className={`hexbox ${run.agree ? 'lavender' : 'violet'}`} style={{ gridColumn: '1 / -1' }}>
            {bytesToHex(run.dec.sharedSecret)}
          </dd>
        </dl>
        {tamper ? (
          <div className="warn" style={{ marginTop: '0.7rem' }}>
            The mauled ciphertext failed the re-encryption check, so Decaps returned{' '}
            <code>J(z ‖ c)</code> — a key bound to the secret <code>z</code> that the attacker can
            neither predict nor distinguish from the real one. The two parties simply end up with
            different keys and the session fails closed. No decryption oracle leaks.
          </div>
        ) : (
          <div className="note" style={{ marginTop: '0.7rem' }}>
            Honest ciphertext: the re-encryption matched to the byte, so <code>K′ = K</code>. Both sides
            now hold the same 32-byte secret without it ever crossing the wire.
          </div>
        )}
      </Panel>

      <Panel
        title="Why it's bigger — and why that's the deal"
        sub="Post-quantum security trades compactness for a hardness assumption no quantum computer is known to break."
      >
        <div className="bars">
          {[
            { label: 'X25519 public key', bytes: 32, color: '#5eead4' },
            { label: `${params.name} ek`, bytes: sizes.ek, color: '#a78bfa' },
            { label: `${params.name} ciphertext`, bytes: sizes.ct, color: '#fb7185' },
            { label: `${params.name} secret key`, bytes: sizes.dk, color: '#fbbf24' },
          ].map((r) => (
            <div className="bar" key={r.label}>
              <span style={{ color: 'var(--ink-dim)', minWidth: 160 }}>{r.label}</span>
              <div className="track">
                <div className="fill" style={{ width: `${(r.bytes / sizes.dk) * 100}%`, background: r.color }} />
              </div>
              <span className="mono" style={{ minWidth: 74, textAlign: 'right' }}>{fmtBytes(r.bytes)}</span>
            </div>
          ))}
        </div>
        <div className="statline" style={{ marginTop: '1rem' }}>
          <div className="stat">
            <b>{Math.round(sizes.ek / 32)}×</b>
            <span>bigger key than X25519</span>
          </div>
          <div className="stat">
            <b>{fmtBytes(sizes.ct)}</b>
            <span>ciphertext on the wire</span>
          </div>
          <div className="stat">
            <b>32 B</b>
            <span>shared secret (same as ECDH)</span>
          </div>
          <div className="stat">
            <b>2024</b>
            <span>FIPS 203 finalised</span>
          </div>
        </div>
        <div className="note" style={{ marginTop: '0.8rem' }}>
          This is why the internet is going <em>hybrid</em>: TLS 1.3 now runs <code>X25519MLKEM768</code>,
          concatenating a classical ECDH secret with an ML-KEM one so a break of either alone is
          survivable. Curvefield now holds both halves of that handshake, each built from scratch.
        </div>
      </Panel>

      <Panel
        title="The handshake the internet actually ships — X25519MLKEM768"
        sub="TLS 1.3 doesn't bet on lattices alone. It runs a classical X25519 ECDH and an ML-KEM-768 encapsulation side by side and concatenates the two secrets, so the session survives a break of either one. This is IANA group 0x11ec, on by default in Chrome and OpenSSL 3.5 — and both halves below are this lab's own from-scratch code."
        right={<Verdict ok={run.hybrid.agree}>{run.hybrid.agree ? 'client = server' : 'mismatch'}</Verdict>}
      >
        <div className="flow-h" style={{ marginBottom: '0.8rem' }}>
          <div className="flow-step">
            <b>Client → Server</b>
            <div className="dim">ek ‖ X25519pub</div>
            <div className="mono">{fmtBytes(run.hybrid.clientShare.length)}</div>
          </div>
          <div className="flow-step">
            <b>Server → Client</b>
            <div className="dim">ct ‖ X25519pub</div>
            <div className="mono">{fmtBytes(run.hybrid.serverShare.length)}</div>
          </div>
          <div className="flow-step">
            <b>Both derive</b>
            <div className="dim">ss_mlkem ‖ ss_x25519</div>
            <div className="mono">{fmtBytes(run.hybrid.combined.length)}</div>
          </div>
        </div>
        <dl className="kv">
          <dt>combined secret</dt>
          <dd className="hexbox violet" style={{ gridColumn: '1 / -1' }}>{hx(run.hybrid.combined, 16, 12)}</dd>
          <dt>session key = SHA3-256(·)</dt>
          <dd className="hexbox lavender" style={{ gridColumn: '1 / -1' }}>{bytesToHex(run.hybrid.sessionKey)}</dd>
        </dl>
        <div className="note" style={{ marginTop: '0.6rem' }}>
          The combined secret is <code>32 + 32 = 64</code> bytes — the ML-KEM secret first, then the
          X25519 secret, exactly as the draft specifies. A future quantum computer that breaks X25519
          still faces the lattice; a cryptanalytic break of ML-KEM still leaves 128-bit X25519. You
          only lose when <em>both</em> fall.
        </div>
      </Panel>

      <div className="note" style={{ marginTop: '0.4rem' }}>
        Engine verified in the live self-test: the number-theoretic transform inverts exactly and its
        base multiply reproduces a schoolbook negacyclic convolution; full KeyGen→Encaps→Decaps
        round-trips for all three parameter sets; the key and ciphertext byte-lengths match the
        FIPS&nbsp;203 tables to the byte; and a mauled ciphertext triggers implicit rejection without
        leaking the real key.
      </div>
    </div>
  )
}
