import { useEffect, useMemo, useState } from 'react'
import { PageHead, Panel, Verdict } from '../ui/components'
import { bytesToHex, hexToBytes, utf8 } from '../ecc/sha256'
import { seedRng, randomBytes } from '../ecc/rng'
import { ellipsize } from '../ui/format'
import {
  PARAM_SETS,
  SLHDSA_128F,
  keyGenFromSeeds,
  signTrace,
  verify,
  newStats,
  totalHashes,
  encodePk,
  encodeSk,
  decodeSk,
  KEYGEN_KAT,
  SIGGEN_KAT,
  type SlhParams,
  type SlhPublicKey,
  type SlhSecretKey,
  type SignTrace,
  type Stats,
} from '../ecc/slhdsa'
import { sha256 } from '../ecc/sha256'

const hx = (b: Uint8Array, head = 8, tail = 6) => ellipsize(bytesToHex(b), head, tail)
const fmtBytes = (n: number) => (n < 1024 ? `${n.toLocaleString()} B` : `${(n / 1024).toFixed(2)} KB`)
const fmtNum = (n: number) => n.toLocaleString()

// A compact byte grid — the first `n` bytes of a blob, coloured by magnitude.
function ByteGrid({ bytes, n = 128, hue }: { bytes: Uint8Array; n?: number; hue: number }) {
  const cells = Array.from(bytes.subarray(0, n))
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(32, 1fr)', gap: 2, marginTop: '0.5rem' }}>
      {cells.map((v, i) => (
        <div
          key={i}
          title={`byte ${i} = ${v}`}
          style={{ aspectRatio: '1', borderRadius: 2, background: `hsl(${hue} 70% ${18 + (v / 255) * 52}%)` }}
        />
      ))}
    </div>
  )
}

// The signature's three parts, as a stacked proportional bar.
function SigComposition({ p }: { p: SlhParams }) {
  const rB = p.n
  const forsB = p.k * (p.a + 1) * p.n
  const htB = (p.h + p.d * p.len) * p.n
  const total = rB + forsB + htB
  const seg = (label: string, bytes: number, color: string) => (
    <div
      style={{ width: `${(bytes / total) * 100}%`, background: color, padding: '0.35rem 0.5rem', color: '#0b0f14', fontWeight: 600, fontSize: '0.72rem', whiteSpace: 'nowrap', overflow: 'hidden' }}
      title={`${label}: ${fmtBytes(bytes)}`}
    >
      {label}
    </div>
  )
  return (
    <div>
      <div style={{ display: 'flex', borderRadius: 6, overflow: 'hidden', border: '1px solid rgba(148,163,184,0.25)' }}>
        {seg(`R · ${rB} B`, rB, '#f4a261')}
        {seg(`FORS · ${fmtBytes(forsB)}`, forsB, '#e76f51')}
        {seg(`hypertree · ${fmtBytes(htB)}`, htB, '#8ecae6')}
      </div>
      <div className="small dim" style={{ marginTop: '0.35rem' }}>
        signature = R (n) ‖ SIG_FORS (k·(a+1)·n = {p.k}·{p.a + 1}·{p.n}) ‖ SIG_HT ((h + d·len)·n = ({p.h} + {p.d}·{p.len})·{p.n}) = {fmtBytes(total)}
      </div>
    </div>
  )
}

// The k FORS trees, each height a, with the digest-selected leaf marked. Drawn as
// k narrow columns; the marker's vertical position encodes index / 2^a.
function ForsView({ p, indices }: { p: SlhParams; indices: number[] }) {
  const leaves = 1 << p.a
  return (
    <div style={{ marginTop: '0.5rem' }}>
      <div style={{ display: 'flex', gap: 3, alignItems: 'flex-end', height: 72, overflowX: 'auto', paddingBottom: 2 }}>
        {indices.map((ix, i) => {
          const frac = ix / (leaves - 1)
          return (
            <div key={i} title={`FORS tree ${i}: leaf ${ix} / ${leaves}`} style={{ position: 'relative', flex: '0 0 8px', height: '100%', background: 'linear-gradient(180deg, rgba(139,211,230,0.10), rgba(139,211,230,0.03))', borderRadius: 2 }}>
              <div style={{ position: 'absolute', left: 0, right: 0, bottom: `${frac * 92}%`, height: 3, background: '#e76f51', borderRadius: 2 }} />
            </div>
          )
        })}
      </div>
      <div className="small dim" style={{ marginTop: '0.35rem' }}>
        {p.k} trees × 2<sup>{p.a}</sup> = {leaves} leaves each · the message digest picks one leaf per tree (orange). Revealing those {p.k} leaves (a FORS signature) is a <em>few</em>-time act — safe only because the leaf address itself is chosen pseudo-randomly from R.
      </div>
    </div>
  )
}

// The d-layer hypertree, bottom (leaf key that signs the FORS pk) to top (PK.root),
// with the active subtree index shown per layer.
function HyperTreeView({ p, idxTree, idxLeaf }: { p: SlhParams; idxTree: bigint; idxLeaf: number }) {
  // reconstruct the per-layer (tree, leaf) walk the signer took
  const rows: { layer: number; tree: bigint; leaf: number }[] = []
  let it = idxTree
  let leaf = idxLeaf
  const mask = (1n << BigInt(p.hp)) - 1n
  for (let j = 0; j < p.d; j++) {
    rows.push({ layer: j, tree: it, leaf })
    leaf = Number(it & mask)
    it = it >> BigInt(p.hp)
  }
  return (
    <div style={{ marginTop: '0.5rem', display: 'flex', flexDirection: 'column-reverse', gap: 3, maxHeight: 260, overflowY: 'auto' }}>
      {rows.map((r) => (
        <div key={r.layer} style={{ display: 'flex', alignItems: 'center', gap: '0.6rem', fontSize: '0.72rem' }}>
          <span className="mono dim" style={{ width: 62, flex: '0 0 auto' }}>{r.layer === p.d - 1 ? 'top' : `layer ${r.layer}`}</span>
          <div style={{ flex: 1, display: 'flex', gap: 2 }}>
            {Array.from({ length: 1 << p.hp }).map((_, li) => (
              <div key={li} style={{ flex: 1, height: 12, borderRadius: 2, background: li === r.leaf ? '#8ecae6' : 'rgba(148,163,184,0.16)' }} title={li === r.leaf ? `active leaf ${li}` : `leaf ${li}`} />
            ))}
          </div>
          <span className="mono dim" style={{ width: 92, flex: '0 0 auto', textAlign: 'right' }}>tree {ellipsize(r.tree.toString(), 6, 4)}</span>
        </div>
      ))}
    </div>
  )
}

interface RunResult {
  key: string
  pk: SlhPublicKey
  sk: SlhSecretKey
  keygenStats: Stats
  sig?: Uint8Array
  trace?: SignTrace
  signStats?: Stats
  accepted?: boolean
  verifyStats?: Stats
}

export function SlhDsaPage() {
  const [params, setParams] = useState<SlhParams>(SLHDSA_128F)
  const [seedNonce, setSeedNonce] = useState(0)
  const [message, setMessage] = useState('The quick brown fox jumps over the lazy dog')
  const [context, setContext] = useState('')
  const [tamperMsg, setTamperMsg] = useState(false)
  const [tamperSig, setTamperSig] = useState(false)
  const [deterministic, setDeterministic] = useState(true)
  const [allowSlowSign, setAllowSlowSign] = useState(false)

  const [result, setResult] = useState<RunResult | null>(null)

  const seed = useMemo(() => {
    seedRng(0x5104_da5a + seedNonce * 2654435761)
    return randomBytes(3 * params.n)
  }, [seedNonce, params.n])

  // Live signing is fast for -128f (~10⁵ hashes) but heavy for -128s (~2·10⁶).
  const slow = params.name.endsWith('128s')
  const doSign = !slow || allowSlowSign

  // A key identifying exactly what the current inputs ask to compute. `busy` is
  // derived (result stale ⇒ show the spinner); the effect only writes state from
  // inside a deferred callback, never synchronously, so no cascading renders.
  const computeKey = `${params.name}|${seedNonce}|${message}|${context}|${deterministic}|${tamperMsg}|${tamperSig}|${doSign ? 1 : 0}`
  const busy = !result || result.key !== computeKey

  useEffect(() => {
    if (result && result.key === computeKey) return
    let cancelled = false
    const handle = setTimeout(() => {
      const keygenStats = newStats()
      const { pk, sk } = keyGenFromSeeds(params, seed.slice(0, params.n), seed.slice(params.n, 2 * params.n), seed.slice(2 * params.n, 3 * params.n), keygenStats)
      const out: RunResult = { key: computeKey, pk, sk, keygenStats }
      if (doSign) {
        const signStats = newStats()
        const { sig, trace } = signTrace(params, sk, utf8(message), { ctx: utf8(context), deterministic, stats: signStats })
        const vMsg = tamperMsg ? utf8(message + '.') : utf8(message)
        const vSig = sig.slice()
        if (tamperSig) vSig[params.n + 7] ^= 0x01
        const verifyStats = newStats()
        const accepted = verify(params, pk, vMsg, vSig, utf8(context))
        // count verify hashes on a clean pass (independent of the tamper toggles)
        verify(params, pk, utf8(message), sig, utf8(context))
        out.sig = sig
        out.trace = trace
        out.signStats = signStats
        out.accepted = accepted
        out.verifyStats = verifyStats
      }
      if (!cancelled) setResult(out)
    }, 24)
    return () => {
      cancelled = true
      clearTimeout(handle)
    }
  }, [computeKey, result, params, seed, message, context, deterministic, tamperMsg, tamperSig, doSign])

  return (
    <div className="page">
      <PageHead eyebrow="post-quantum · hash-based signatures · FIPS 205" title="SLH-DSA — a signature from a hash alone">
        The lab already carries a <em>toy</em> SPHINCS⁺ (see <a href="#/pqsig">Hash-Based Signatures</a>). This is the
        real one: NIST's <strong>SLH-DSA</strong>, standardised in <strong>FIPS 205</strong> (August 2024), built here
        from scratch on the lab's own SHA-256 — byte-exact ADRSc address compression, the SHA-2 tweakable-hash
        instantiation, the MGF1 message digest, and the precise key/signature packing. It reproduces NIST's own ACVP
        known-answer vectors <strong>byte-for-byte</strong>. SLH-DSA is the <em>conservative</em> post-quantum
        signature: unlike lattice-based <a href="#/mldsa">ML-DSA</a>, it rests on nothing but the collision/pre-image
        resistance of a hash — the same, and only, assumption the lab's <a href="#/stark">STARK</a> already makes.
      </PageHead>

      <Panel title="The stack" sub="four hash-based constructions, each built on the one below">
        <div className="cols-2" style={{ gap: '1rem' }}>
          <div>
            <ul className="small" style={{ lineHeight: 1.7, margin: 0, paddingLeft: '1.1rem' }}>
              <li><strong>WOTS⁺</strong> — a <em>one</em>-time signature. Reveal a checkpoint of a hash chain for each base-w digit of the message; the checksum digits stop an attacker from walking a chain forward.</li>
              <li><strong>XMSS</strong> — a Merkle tree of 2<sup>h′</sup> WOTS⁺ keys behind a single root, so one public key authenticates many one-time keys via an O(h′) auth path.</li>
              <li><strong>hypertree (HT)</strong> — <em>d</em> layers of XMSS, each layer's tree signing the root of the tree below, so one top root (PK.root) certifies 2<sup>h</sup> leaf keys without ever building the whole tree.</li>
              <li><strong>FORS</strong> — a <em>few</em>-time signature of the message digest. A pseudo-random leaf choice (from the randomiser R) is what makes the whole scheme <strong>stateless</strong> — there is no counter to lose, unlike XMSS.</li>
            </ul>
          </div>
          <div className="note small">
            A SLH-DSA signature is one FORS signature of the message digest, plus a hypertree signature that carries the
            FORS public key up <em>d</em> layers to PK.root. Verification re-derives the FORS pk from the signature and
            re-climbs the hypertree; it accepts iff the climb lands exactly on PK.root. No secret is ever needed to
            verify, and no number-theoretic assumption is ever made.
          </div>
        </div>
      </Panel>

      <Panel title="Parameter set" sub="the size ⇄ speed trade the two category-1 sets make">
        <div className="btn-row" style={{ marginBottom: '0.75rem' }}>
          {PARAM_SETS.map((ps) => (
            <button key={ps.name} className={`btn ${params.name === ps.name ? '' : 'ghost'}`} onClick={() => setParams(ps)}>
              {ps.name}
            </button>
          ))}
        </div>
        <div style={{ overflowX: 'auto' }}>
          <table className="plonk-table" style={{ minWidth: 520 }}>
            <thead>
              <tr>
                <th>set</th><th>n</th><th>h</th><th>d</th><th>h′</th><th>a</th><th>k</th><th>pk</th><th>sk</th><th>signature</th>
              </tr>
            </thead>
            <tbody>
              {PARAM_SETS.map((ps) => (
                <tr key={ps.name} style={{ fontWeight: ps.name === params.name ? 700 : 400 }}>
                  <td>{ps.name.replace('SLH-DSA-SHA2-', '')}</td>
                  <td>{ps.n}</td><td>{ps.h}</td><td>{ps.d}</td><td>{ps.hp}</td><td>{ps.a}</td><td>{ps.k}</td>
                  <td>{ps.pkBytes} B</td><td>{ps.skBytes} B</td><td>{fmtBytes(ps.sigBytes)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="small dim" style={{ marginTop: '0.5rem' }}>
          Both give 128-bit security from a 32-byte public key. <strong>-128s</strong> ("small") makes a 7.8 KB signature
          but signs slowly; <strong>-128f</strong> ("fast") signs quicker at the cost of a 17 KB signature. The whole
          difference is the shape of the tree: a taller hypertree (bigger d) means each layer is short, so signing
          touches fewer leaves — faster, but more XMSS signatures to carry.
        </div>
      </Panel>

      <Panel
        title="Keys & signature"
        sub={<>a fresh random keypair, one live signature over your message, verified — all on the from-scratch SHA-256</>}
        right={<button className="btn ghost" onClick={() => setSeedNonce((n) => n + 1)}>↻ new key</button>}
      >
        <div className="field">
          <label><span>message</span></label>
          <input value={message} onChange={(e) => setMessage(e.target.value)} style={{ width: '100%' }} />
        </div>
        <div className="field">
          <label><span>context string (FIPS 205 §10.2 — bound into the signature, may be empty)</span></label>
          <input value={context} onChange={(e) => setContext(e.target.value)} placeholder="(empty)" style={{ width: '100%' }} />
        </div>

        {slow && (
          <div className="warn small" style={{ margin: '0.5rem 0' }}>
            <strong>-128s</strong> signing is deliberately slow (~2.2 million hash evaluations — a few seconds in your
            browser).{' '}
            <label style={{ display: 'inline-flex', gap: '0.35rem', alignItems: 'center', cursor: 'pointer' }}>
              <input type="checkbox" checked={allowSlowSign} onChange={(e) => setAllowSlowSign(e.target.checked)} />
              sign live anyway
            </label>
          </div>
        )}

        {busy ? (
          <div className="note" style={{ textAlign: 'center', padding: '1.5rem' }}>
            computing on the from-scratch SHA-256 — {slow && doSign ? 'this set signs slowly, hang tight…' : 'one moment…'}
          </div>
        ) : result ? (
          <>
            <div className="cols-2" style={{ gap: '1rem', marginTop: '0.5rem' }}>
              <div className="kv small">
                <div><span className="dim">PK.seed</span><span className="mono">{hx(result.pk.pkSeed)}</span></div>
                <div><span className="dim">PK.root</span><span className="mono">{hx(result.pk.pkRoot)}</span></div>
                <div><span className="dim">public key</span><span className="mono">{fmtBytes(encodePk(result.pk).length)}</span></div>
                <div><span className="dim">secret key</span><span className="mono">{fmtBytes(encodeSk(result.sk).length)}</span></div>
                <div><span className="dim">keygen cost</span><span className="mono">{fmtNum(totalHashes(result.keygenStats))} hashes</span></div>
              </div>
              {result.trace && (
                <div className="kv small">
                  <div><span className="dim">R (randomiser)</span><span className="mono">{hx(result.trace.R)}</span></div>
                  <div><span className="dim">idx_tree</span><span className="mono">{ellipsize(result.trace.idxTree.toString(), 10, 6)}</span></div>
                  <div><span className="dim">idx_leaf</span><span className="mono">{result.trace.idxLeaf}</span></div>
                  <div><span className="dim">sign cost</span><span className="mono">{fmtNum(totalHashes(result.signStats!))} hashes</span></div>
                  <div><span className="dim">verify cost</span><span className="mono">{fmtNum(totalHashes(result.verifyStats!))} hashes</span></div>
                </div>
              )}
            </div>

            {result.sig && result.trace ? (
              <>
                <div style={{ marginTop: '1rem' }}>
                  <div className="small dim" style={{ marginBottom: '0.35rem' }}>signature ({fmtBytes(result.sig.length)}) — the first 256 bytes, coloured by value</div>
                  <ByteGrid bytes={result.sig} n={256} hue={18} />
                </div>

                <div style={{ marginTop: '1rem' }}>
                  <div className="small dim" style={{ marginBottom: '0.35rem' }}>what it costs to store — the three parts</div>
                  <SigComposition p={params} />
                </div>

                <div style={{ marginTop: '1rem' }}>
                  <div className="small dim" style={{ marginBottom: '0.1rem' }}>FORS — the digest selects one leaf in each of the {params.k} trees</div>
                  <ForsView p={params} indices={result.trace.forsIndices} />
                </div>

                <div style={{ marginTop: '1rem' }}>
                  <div className="small dim" style={{ marginBottom: '0.1rem' }}>hypertree — the FORS pk climbs {params.d} XMSS layers to PK.root (active leaf highlighted)</div>
                  <HyperTreeView p={params} idxTree={result.trace.idxTree} idxLeaf={result.trace.idxLeaf} />
                </div>

                <div className="btn-row" style={{ marginTop: '1rem', flexWrap: 'wrap', gap: '0.75rem' }}>
                  <label style={{ display: 'inline-flex', gap: '0.4rem', alignItems: 'center', cursor: 'pointer' }}>
                    <input type="checkbox" checked={tamperMsg} onChange={(e) => setTamperMsg(e.target.checked)} /> tamper message
                  </label>
                  <label style={{ display: 'inline-flex', gap: '0.4rem', alignItems: 'center', cursor: 'pointer' }}>
                    <input type="checkbox" checked={tamperSig} onChange={(e) => setTamperSig(e.target.checked)} /> flip a signature byte
                  </label>
                  <label style={{ display: 'inline-flex', gap: '0.4rem', alignItems: 'center', cursor: 'pointer' }}>
                    <input type="checkbox" checked={deterministic} onChange={(e) => setDeterministic(e.target.checked)} /> deterministic (opt_rand = PK.seed)
                  </label>
                </div>

                <div style={{ marginTop: '0.75rem' }}>
                  <Verdict ok={!!result.accepted}>
                    {result.accepted ? 'signature VERIFIES' : 'signature REJECTED'}
                  </Verdict>{' '}
                  <span className="small dim">
                    {tamperMsg || tamperSig
                      ? 'a mauled message or signature reaches a different PK.root — the climb misses, so verification fails, as it must.'
                      : 'the recovered FORS pk climbs the hypertree to exactly PK.root.'}
                  </span>
                </div>
              </>
            ) : (
              <div className="note small" style={{ marginTop: '1rem' }}>
                Keygen shown above. Live signing is skipped for -128s to keep the page responsive — tick "sign live anyway"
                to run the full ~2.2M-hash signing operation, or verify -128s against NIST's own vector in the panel below.
              </div>
            )}
          </>
        ) : null}
      </Panel>

      <StandardsPanel />

      <Panel title="Two post-quantum signatures, two hardness assumptions" sub="SLH-DSA and ML-DSA side by side">
        <div style={{ overflowX: 'auto' }}>
          <table className="plonk-table" style={{ minWidth: 560 }}>
            <thead>
              <tr><th></th><th>SLH-DSA (FIPS 205)</th><th>ML-DSA (FIPS 204)</th></tr>
            </thead>
            <tbody>
              <tr><td>rests on</td><td>a hash (collision/pre-image)</td><td>Module-LWE / Module-SIS (lattices)</td></tr>
              <tr><td>family</td><td>hash-based (SPHINCS⁺)</td><td>lattice (CRYSTALS-Dilithium)</td></tr>
              <tr><td>public key</td><td>32 B</td><td>1.3 KB</td></tr>
              <tr><td>signature (cat 1)</td><td>7.8–17 KB</td><td>2.4 KB</td></tr>
              <tr><td>speed</td><td>slow (10⁵–10⁶ hashes)</td><td>fast</td></tr>
              <tr><td>appeal</td><td>most conservative — no new hardness</td><td>small + fast — the default</td></tr>
            </tbody>
          </table>
        </div>
        <div className="small dim" style={{ marginTop: '0.5rem' }}>
          NIST standardised both on the same day. ML-DSA is the workhorse; SLH-DSA is the hedge — if lattice
          cryptanalysis ever advances, a signature that trusts only a hash still stands. Both are built from scratch in
          this lab, on the same from-scratch SHA-256 / Keccak engine.
        </div>
      </Panel>
    </div>
  )
}

// Reproduce NIST's ACVP FIPS 205 vectors live. keyGen is quick; the -128s sigGen
// re-runs a full (slow) signing, so it is gated behind a button.
function StandardsPanel() {
  const [ran, setRan] = useState<{ label: string; ok: boolean; detail: string }[] | null>(null)
  const [running, setRunning] = useState(false)
  const [includeSlow, setIncludeSlow] = useState(false)

  const run = () => {
    setRunning(true)
    setTimeout(() => {
      const rows: { label: string; ok: boolean; detail: string }[] = []
      for (const kv of KEYGEN_KAT) {
        const { pk } = keyGenFromSeeds(kv.params, hexToBytes(kv.skSeed), hexToBytes(kv.skPrf), hexToBytes(kv.pkSeed))
        const got = bytesToHex(encodePk(pk)).toUpperCase()
        rows.push({ label: `${kv.name} · keyGen`, ok: got === kv.pk.toUpperCase(), detail: `PK.root = ${ellipsize(bytesToHex(pk.pkRoot), 12, 8)}` })
      }
      for (const sv of SIGGEN_KAT) {
        const isSlow = sv.name.endsWith('128s')
        if (isSlow && !includeSlow) {
          rows.push({ label: `${sv.name} · sigGen`, ok: true, detail: 'skipped (slow) — enable below to run the full signing' })
          continue
        }
        const sk = decodeSk(sv.params, hexToBytes(sv.sk))
        const { sig } = signTrace(sv.params, sk, hexToBytes(sv.message), { ctx: hexToBytes(sv.context), deterministic: true })
        const digest = bytesToHex(sha256(sig))
        rows.push({ label: `${sv.name} · sigGen`, ok: digest === sv.sigSha256 && sig.length === sv.params.sigBytes, detail: `SHA-256(sig) = ${digest.slice(0, 16)}… · ${fmtBytes(sig.length)}` })
      }
      setRan(rows)
      setRunning(false)
    }, 24)
  }

  return (
    <Panel title="Standards conformance — NIST ACVP FIPS 205 vectors, live" sub="keyGen maps three seeds to a public root; sigGen reproduces a deterministic signature whose SHA-256 is pinned">
      <div className="btn-row" style={{ marginBottom: '0.5rem', flexWrap: 'wrap', gap: '0.75rem' }}>
        <button className="btn" disabled={running} onClick={run}>{running ? 'running…' : ran ? '↻ re-run' : 'run vectors'}</button>
        <label style={{ display: 'inline-flex', gap: '0.4rem', alignItems: 'center', cursor: 'pointer' }}>
          <input type="checkbox" checked={includeSlow} onChange={(e) => setIncludeSlow(e.target.checked)} /> include -128s sigGen (~2.2M hashes)
        </label>
      </div>
      {ran ? (
        <div className="kv small">
          {ran.map((r) => (
            <div key={r.label} style={{ display: 'flex', justifyContent: 'space-between', gap: '0.75rem' }}>
              <span><Verdict ok={r.ok}>{r.ok ? 'PASS' : 'FAIL'}</Verdict> {r.label}</span>
              <span className="mono dim" style={{ textAlign: 'right' }}>{r.detail}</span>
            </div>
          ))}
          <div className="small dim" style={{ marginTop: '0.5rem' }}>
            Vectors from NIST's ACVP FIPS 205 test suite. The keyGen root and the signature bytes are reproduced by this
            page's engine with zero external code — the same hand-written SHA-256 the rest of the lab uses.
          </div>
        </div>
      ) : (
        <div className="note small">Click <strong>run vectors</strong> to recompute NIST's own keyGen roots and signature digests in your browser.</div>
      )}
    </Panel>
  )
}
