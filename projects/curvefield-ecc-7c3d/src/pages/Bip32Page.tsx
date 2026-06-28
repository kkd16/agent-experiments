import { useMemo, useState } from 'react'
import { PageHead, Panel, Verdict } from '../ui/components'
import { derivePath, deriveChildPub, xprv, xpub, fingerprint, type HDNode } from '../ecc/bip32'
import { pointCompress, p2wpkhAddress } from '../ecc/encoding'
import { hexToBytes } from '../ecc/sha256'
import { ellipsize, hex } from '../ui/format'

const DEFAULT_SEED = '000102030405060708090a0b0c0d0e0f'
const PRESETS = ["m/0'/1/2'/2/1000000000", "m/44'/0'/0'/0/0", "m/0'/1", "m/0/1/2"]

const fpHex = (n: number) => '0x' + (n >>> 0).toString(16).padStart(8, '0')

export function Bip32Page() {
  const [seedHex, setSeedHex] = useState(DEFAULT_SEED)
  const [path, setPath] = useState("m/44'/0'/0'/0/0")

  const result = useMemo(() => {
    try {
      const clean = seedHex.trim().replace(/[^0-9a-fA-F]/g, '')
      if (clean.length < 32) return { error: 'seed needs at least 16 bytes (32 hex chars)' }
      const seed = hexToBytes(clean)
      const steps = derivePath(seed, path)
      return { steps }
    } catch (e) {
      return { error: e instanceof Error ? e.message : String(e) }
    }
  }, [seedHex, path])

  // Watch-only demonstration: take the second-to-last node's *public* half and
  // derive the final child via CKDpub, then confirm it equals the private route.
  const watchOnly = useMemo(() => {
    if (!result.steps || result.steps.length < 2) return null
    const last = result.steps[result.steps.length - 1]
    if (last.hardened) return { hardened: true }
    const parent = result.steps[result.steps.length - 2].node
    try {
      const pubParent: HDNode = { ...parent, priv: null }
      const child = deriveChildPub(pubParent, last.index)
      return { hardened: false, match: xpub(child) === xpub(last.node), childXpub: xpub(child) }
    } catch (e) {
      return { hardened: false, error: e instanceof Error ? e.message : String(e) }
    }
  }, [result])

  return (
    <main className="page">
      <PageHead eyebrow="Lab 14 — hierarchical deterministic wallets" title="BIP-32 HD Key Derivation">
        A single seed grows an entire tree of keys. Each child is the parent key plus{' '}
        <code>HMAC-SHA512(chain code, parent ‖ index)</code> — an <em>additive</em> offset, which is
        the crucial trick: a watch-only server holding only an <strong>xpub</strong> can derive every
        receiving address without ever seeing a secret. <strong>Hardened</strong> indices (marked{' '}
        <code>'</code>) feed the private key into the hash instead, breaking that public derivability
        — which is what firewalls your spending keys from a leaked xpub. Everything here is the
        secp256k1 group law plus the from-scratch SHA-512 HMAC, checked against the BIP-32 vectors.
      </PageHead>

      <Panel title="Seed & derivation path">
        <div className="field">
          <label><span>seed (hex)</span></label>
          <input value={seedHex} onChange={(e) => setSeedHex(e.target.value)} spellCheck={false} />
        </div>
        <div className="field" style={{ marginTop: '0.6rem' }}>
          <label><span>path</span></label>
          <input value={path} onChange={(e) => setPath(e.target.value)} spellCheck={false} />
        </div>
        <div className="seg" style={{ marginTop: '0.6rem', flexWrap: 'wrap' }}>
          {PRESETS.map((p) => (
            <button key={p} className={path === p ? 'on' : ''} onClick={() => setPath(p)}>
              {p}
            </button>
          ))}
        </div>
        {result.error && (
          <div className="note" style={{ marginTop: '0.6rem', color: 'var(--bad)' }}>
            {result.error}
          </div>
        )}
      </Panel>

      {result.steps && (
        <Panel
          title="The derivation chain"
          sub="Each row is one node on the path from the master key m down to your address. Hardened steps are highlighted — they can only be derived from the private key."
        >
          <div style={{ overflowX: 'auto' }}>
            <table className="data">
              <thead>
                <tr>
                  <th>node</th>
                  <th>fingerprint</th>
                  <th>xpub</th>
                  <th>address (P2WPKH)</th>
                </tr>
              </thead>
              <tbody>
                {result.steps.map((s, i) => (
                  <tr key={i}>
                    <td className="mono" style={{ color: s.hardened ? '#fbbf24' : '#5eead4' }}>
                      {s.label}
                      {s.hardened && <span title="hardened"> ⚷</span>}
                    </td>
                    <td className="mono">{fpHex(fingerprint(s.node))}</td>
                    <td className="mono">{ellipsize(xpub(s.node), 10, 6)}</td>
                    <td className="mono">{ellipsize(p2wpkhAddress(pointCompress(s.node.pub)), 12, 6)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <dl className="kv" style={{ marginTop: '1rem' }}>
            <dt>leaf xprv (the spending key)</dt>
            <dd className="hexbox lavender" style={{ gridColumn: '1 / -1', wordBreak: 'break-all' }}>
              {xprv(result.steps[result.steps.length - 1].node)}
            </dd>
            <dt>leaf xpub (safe to share)</dt>
            <dd className="hexbox violet" style={{ gridColumn: '1 / -1', wordBreak: 'break-all' }}>
              {xpub(result.steps[result.steps.length - 1].node)}
            </dd>
            <dt>leaf private scalar d</dt>
            <dd className="hexbox" style={{ gridColumn: '1 / -1' }}>
              {hex(result.steps[result.steps.length - 1].node.priv ?? 0n, 64)}
            </dd>
          </dl>
        </Panel>
      )}

      {watchOnly && (
        <Panel
          title="Watch-only derivation (CKDpub)"
          sub="The payoff of additive child keys: derive the same final public key from the parent's xpub alone — no private key in sight."
        >
          {watchOnly.hardened ? (
            <div className="note">
              The last step on this path is <strong>hardened</strong>, so it cannot be derived from a
              public key — that is the whole point of hardening. Try a path whose last element is
              non-hardened (e.g. <code>m/44'/0'/0'/0/0</code>) to watch CKDpub reproduce it.
            </div>
          ) : watchOnly.error ? (
            <div className="note" style={{ color: 'var(--bad)' }}>{watchOnly.error}</div>
          ) : (
            <>
              <Verdict ok={!!watchOnly.match}>
                {watchOnly.match
                  ? 'xpub-only derivation reproduces the leaf public key ✓'
                  : 'mismatch'}
              </Verdict>
              <div className="note" style={{ marginTop: '0.5rem' }}>
                A merchant can publish one account xpub and let an untrusted server compute a fresh
                address per customer — while the keys that can <em>spend</em> stay offline. Hardened
                derivation higher in the path keeps a leaked account xpub from ever climbing back up
                to the master secret.
              </div>
            </>
          )}
        </Panel>
      )}
    </main>
  )
}
