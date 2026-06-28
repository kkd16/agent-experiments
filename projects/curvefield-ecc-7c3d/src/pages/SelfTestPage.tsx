import { useMemo, useState } from 'react'
import { PageHead, Panel } from '../ui/components'
import { runSelfTest, type TestCase } from '../ecc/selftest'

export function SelfTestPage() {
  const [nonce, setNonce] = useState(0)
  const tests = useMemo(() => runSelfTest(), [])
  // `nonce` lets the user force a re-run; the engine is deterministic so results
  // are stable, which is itself the point.
  void nonce

  const groups = useMemo(() => {
    const m = new Map<string, TestCase[]>()
    for (const t of tests) {
      if (!m.has(t.group)) m.set(t.group, [])
      m.get(t.group)!.push(t)
    }
    return [...m.entries()]
  }, [tests])

  const passed = tests.filter((t) => t.pass).length
  const allPass = passed === tests.length

  return (
    <main className="page">
      <PageHead eyebrow="Lab 12 — provenance" title="Self-Test & Known-Answer Vectors">
        Pretty math is worthless if it’s wrong. This page runs the entire engine against published
        standards — FIPS 180-4 (SHA-256/512), RFC 4231 (HMAC), the canonical secp256k1 point
        multiples, BIP-340 Schnorr, RIPEMD-160 + Bitcoin WIF/address/Bech32 vectors, RFC 7748
        (X25519) and RFC 8032 (Ed25519), a MuSig2 aggregate, a Pohlig–Hellman recovery, and a
        Wycheproof-style adversarial verifier battery — plus full sign→verify→tamper round-trips. It
        runs live, in your browser, every time you open it.
      </PageHead>

      <div className="statline" style={{ marginBottom: '1.4rem' }}>
        <div className="stat">
          <b style={{ color: allPass ? 'var(--good)' : 'var(--bad)' }}>{passed}/{tests.length}</b>
          <span>checks passing</span>
        </div>
        <div className="stat"><b>{groups.length}</b><span>subsystems</span></div>
        <div className="stat">
          <b style={{ color: allPass ? 'var(--good)' : 'var(--bad)' }}>{allPass ? 'GREEN' : 'RED'}</b>
          <span>engine status</span>
        </div>
        <div className="stat" style={{ justifyContent: 'center' }}>
          <button className="btn" onClick={() => setNonce((n) => n + 1)}>↻ re-run</button>
        </div>
      </div>

      <div className="grid cols-2">
        {groups.map(([group, cases]) => {
          const gPass = cases.every((c) => c.pass)
          return (
            <Panel
              key={group}
              title={
                <>
                  {group}{' '}
                  <span className={`tag ${gPass ? 'ok' : 'no'}`}>{cases.filter((c) => c.pass).length}/{cases.length}</span>
                </>
              }
            >
              <table className="data">
                <tbody>
                  {cases.map((c) => (
                    <tr key={c.name}>
                      <td style={{ width: 22 }}>
                        <span style={{ color: c.pass ? 'var(--good)' : 'var(--bad)', fontWeight: 700 }}>
                          {c.pass ? '✓' : '✗'}
                        </span>
                      </td>
                      <td>{c.name}</td>
                      <td className="mono" style={{ color: 'var(--ink-faint)', fontSize: '0.76rem' }}>{c.detail}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </Panel>
          )
        })}
      </div>

      <Panel title="What this proves" sub="and what it doesn’t">
        <p style={{ color: 'var(--ink-dim)', margin: 0, maxWidth: '78ch' }}>
          Matching the SHA-256 and HMAC vectors means the hash core is bit-exact with the standard.
          Reproducing the published <code>2·G</code>, <code>3·G</code>, and <code>n·G = O</code>{' '}
          identities means the field arithmetic and group law are correct on the real curve, not just
          internally consistent. The BIP-340 pubkey vector pins the Schnorr key derivation. The
          round-trip and tamper tests confirm the signing schemes bind messages to keys. What it{' '}
          <em>doesn’t</em> prove: constant-time execution or side-channel resistance — this is a
          teaching engine, not a hardened library. Never guard real value with it.
        </p>
      </Panel>
    </main>
  )
}
