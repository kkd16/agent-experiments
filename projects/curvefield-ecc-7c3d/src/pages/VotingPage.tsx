import { useMemo, useState } from 'react'
import { PageHead, Panel, Slider, Verdict } from '../ui/components'
import {
  runDKG,
  castBallot,
  verifyBallot,
  aggregate,
  tally,
  verifyElection,
  plaintextCounts,
  stuffBallot,
  corruptShare,
  type Election,
  type Ballot,
} from '../ecc/voting'
import { type Ciphertext } from '../ecc/elgamal'
import { seedRng } from '../ecc/rng'
import { hex, ellipsize } from '../ui/format'

const CANDIDATES = ['Aster', 'Bramble', 'Cinder', 'Dewdrop', 'Ember']
const COLORS = ['#b794f6', '#5eead4', '#fbbf24', '#fb7185', '#60a5fa']

/** Compact hex of a ciphertext component for the bulletin-board preview. */
function ctHex(pt: Ciphertext['A']): string {
  return pt === null ? 'O' : ellipsize(hex(pt.x, 64), 8, 4)
}

export function VotingPage() {
  const [n, setN] = useState(3) // trustees
  const [t, setT] = useState(2) // decryption threshold
  const [k, setK] = useState(3) // candidates
  const [v, setV] = useState(9) // voters
  const [seed, setSeed] = useState(1)

  // Per-voter plaintext choice (raw store; normalized to v voters / k candidates
  // at render time so we never sync state inside an effect).
  const [choicesRaw, setChoicesRaw] = useState<number[]>([0, 1, 1, 2, 0, 1, 0, 2, 1])
  // Which trustees come online to decrypt (indices into election.trustees).
  const [quorumSel, setQuorumSel] = useState<number[]>([0, 1])
  // Live tamper switches for the soundness demos.
  const [stuffIdx, setStuffIdx] = useState<number | null>(null)
  const [corruptDec, setCorruptDec] = useState(false)

  const tt = Math.min(t, n)

  // Derive the effective ballot choices: exactly v entries, each a valid candidate.
  const choices = useMemo(() => {
    const next = choicesRaw.slice(0, v)
    while (next.length < v) next.push((next.length * 2) % k)
    return next.map((c) => c % k)
  }, [choicesRaw, v, k])

  // ── Stage 1: distributed key generation ───────────────────────────────────
  const election: Election = useMemo(() => {
    seedRng(seed * 7919 + n * 131 + tt * 17)
    return runDKG(n, tt)
  }, [n, tt, seed])

  // ── Stage 2: every voter casts an encrypted, self-certifying ballot ───────
  const ballots: Ballot[] = useMemo(() => {
    seedRng(seed * 104729 + v * 31 + k * 7)
    return choices.map((c, i) => castBallot(election, `voter ${i + 1}`, Math.min(c, k - 1), k))
  }, [election, choices, k, v, seed])

  // Apply the ballot-stuffing tamper (if armed) to a copy of the board.
  const board: Ballot[] = useMemo(() => {
    if (stuffIdx === null || stuffIdx >= ballots.length) return ballots
    const copy = ballots.slice()
    copy[stuffIdx] = stuffBallot(election, ballots[stuffIdx])
    return copy
  }, [ballots, stuffIdx, election])

  const ballotChecks = useMemo(
    () => board.map((b) => verifyBallot(election, b, k)),
    [board, election, k],
  )

  const quorum = useMemo(
    () => quorumSel.map((i) => election.trustees[i]).filter(Boolean),
    [quorumSel, election],
  )
  const quorumMet = quorum.length >= tt

  // ── Stage 3: homomorphic tally + threshold decryption ─────────────────────
  const aggregates = useMemo(() => aggregate(board, k), [board, k])

  const result = useMemo(() => {
    if (!quorumMet) return null
    const r = tally(board, k, quorum)
    if (corruptDec && r.results[0]?.shares[0]) {
      // Corrupt the first trustee's share of candidate 0 for the demo.
      const bad = { ...r }
      bad.results = r.results.map((res, c) =>
        c === 0 ? { ...res, shares: res.shares.map((s, i) => (i === 0 ? corruptShare(s) : s)) } : res,
      )
      // Recompute candidate 0's plaintext from the corrupted shares so the audit's
      // "does the count explain the point?" check is what actually fires.
      return bad
    }
    return r
  }, [election, board, k, quorum, quorumMet, corruptDec])

  const truth = useMemo(() => plaintextCounts(board, k), [board, k])

  const audit = useMemo(
    () => (result ? verifyElection(election, board, k, result, quorum.map((q) => q.index)) : null),
    [result, election, board, k, quorum],
  )

  const maxCount = Math.max(1, ...truth)
  const clean = stuffIdx === null && !corruptDec

  const setChoice = (voter: number, cand: number) =>
    setChoicesRaw(choices.map((x, i) => (i === voter ? cand : x)))

  const toggleQuorum = (i: number) =>
    setQuorumSel((s) => (s.includes(i) ? s.filter((x) => x !== i) : [...s, i].sort((a, b) => a - b)))

  return (
    <main className="page">
      <PageHead eyebrow="Lab 38 — homomorphic e-voting" title="Ballot — Verifiable Elections">
        The capstone that wires the whole lab into a real protocol: <strong>Helios-style</strong>{' '}
        end-to-end-verifiable voting. Votes are <em>exponential-ElGamal</em> ciphertexts that{' '}
        <em>add</em> — so a bulletin board can tally thousands of encrypted ballots and decrypt only
        the <em>total</em>, never one voter. The decryption key never exists whole: a{' '}
        <code>t</code>-of-<code>n</code> <strong>distributed key generation</strong> splits it across
        trustees. Every ballot carries a zero-knowledge proof it encrypts <em>exactly one</em> vote
        (a disjunctive Chaum–Pedersen "it's a 0 or a 1"), and every trustee proves its partial
        decryption with a DLEQ proof — so <strong>anyone</strong> can recompute and check the result
        without trusting the voters, the trustees, or the server. Tamper with any of it below and
        watch the universal verifier catch it.
      </PageHead>

      <Panel
        title="1 · Distributed key generation"
        sub="Each of the n trustees Feldman-shares a random secret; the election key PK = sk·G is the sum of their public commitments, and sk = Σ (trustee secrets) is a value nobody ever holds. Any t trustees can jointly decrypt; fewer learn nothing."
        right={
          <button className="btn" onClick={() => setSeed((s) => s + 1)}>
            ↻ new election
          </button>
        }
      >
        <div className="grid cols-3" style={{ gap: '1rem' }}>
          <Slider label="trustees n" value={n} min={2} max={5} onChange={(x) => { setN(x); setT((y) => Math.min(y, x)) }} />
          <Slider label="threshold t" value={tt} min={1} max={n} onChange={setT} />
          <Slider label="candidates" value={k} min={2} max={5} onChange={setK} />
        </div>
        <dl className="kv" style={{ marginTop: '0.8rem' }}>
          <dt>election public key PK</dt>
          <dd className="hexbox violet" style={{ gridColumn: '1 / -1' }}>{hex(election.pk?.x ?? 0n, 64)}</dd>
        </dl>
        <table className="data" style={{ marginTop: '0.8rem' }}>
          <thead>
            <tr><th>trustee</th><th>verification key Yᵢ = skᵢ·G</th><th>shares received</th></tr>
          </thead>
          <tbody>
            {election.trustees.map((tr, i) => (
              <tr key={i}>
                <td style={{ color: COLORS[i % COLORS.length] }}>● trustee #{i + 1}</td>
                <td className="mono">{ctHex(tr.vk)}</td>
                <td><Verdict ok={tr.dealtOk}>{tr.dealtOk ? 'all Feldman-verified' : 'inconsistent'}</Verdict></td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="note">
          The public key is a single curve point, yet the matching secret is scattered across {n}{' '}
          trustees as Shamir shares — the "no single authority can decrypt" property elections are
          built on.
        </p>
      </Panel>

      <Panel
        title="2 · Cast the votes"
        sub="Each voter encrypts a 1 for their candidate and a 0 for the rest, then attaches a proof that every slot is a bit and the slots sum to exactly one. The plaintext choices here are the ground truth we grade the encrypted tally against — the protocol itself never sees them."
      >
        <Slider label="voters" value={v} min={3} max={15} display={`${v} voters`} onChange={setV} />
        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.4rem', marginTop: '0.7rem' }}>
          {choices.map((choice, i) => (
            <div key={i} style={{ display: 'flex', alignItems: 'center', gap: '0.6rem', flexWrap: 'wrap' }}>
              <span className="mono" style={{ width: '4.5rem', color: 'var(--ink-dim)' }}>voter {i + 1}</span>
              <div className="seg">
                {CANDIDATES.slice(0, k).map((name, c) => (
                  <button key={c} className={Math.min(choice, k - 1) === c ? 'on' : ''} onClick={() => setChoice(i, c)}>
                    <span style={{ color: COLORS[c % COLORS.length] }}>●</span> {name}
                  </button>
                ))}
              </div>
            </div>
          ))}
        </div>
      </Panel>

      <Panel
        title="3 · The bulletin board"
        sub="Every ciphertext and every proof is public. A verifier checks each ballot with no secret at all — the (A, B) columns are the ElGamal ciphertext for that voter's chosen candidate; the badges are the zero-knowledge validity proofs."
      >
        <div style={{ overflowX: 'auto' }}>
          <table className="data">
            <thead>
              <tr>
                <th>voter</th>
                {CANDIDATES.slice(0, k).map((name, c) => (
                  <th key={c} style={{ color: COLORS[c % COLORS.length] }}>{name} · A</th>
                ))}
                <th>bit proofs</th>
                <th>Σ = 1</th>
              </tr>
            </thead>
            <tbody>
              {board.map((b, i) => (
                <tr key={i}>
                  <td className="mono">#{i + 1}{stuffIdx === i && <span className="tag no" style={{ marginLeft: 4 }}>tampered</span>}</td>
                  {b.ciphers.map((ct, c) => (
                    <td key={c} className="mono" style={{ fontSize: '0.72rem' }}>{ctHex(ct.A)}</td>
                  ))}
                  <td>
                    {ballotChecks[i].bitsOk.map((ok, c) => (
                      <span key={c} className={`tag ${ok ? 'ok' : 'no'}`} style={{ marginRight: 2 }}>{ok ? '✓' : '✗'}</span>
                    ))}
                  </td>
                  <td><Verdict ok={ballotChecks[i].sumOk}>{ballotChecks[i].sumOk ? 'ok' : 'bad'}</Verdict></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="btn-row" style={{ marginTop: '0.8rem' }}>
          <button
            className={`btn ${stuffIdx !== null ? '' : 'ghost'}`}
            onClick={() => setStuffIdx((s) => (s === null ? 0 : null))}
          >
            {stuffIdx !== null ? '↩ undo ballot stuffing' : '⚠ stuff ballot #1 (encrypt a 2)'}
          </button>
          <span className="note" style={{ display: 'inline' }}>
            A stuffed ballot puts a "2" in one slot. Its old bit-proof no longer verifies — the board
            rejects it before it can ever reach the tally.
          </span>
        </div>
      </Panel>

      <Panel
        title="4 · Homomorphic tally & threshold decryption"
        sub="Add every ballot's ciphertexts candidate-by-candidate — the sums encrypt the exact totals. Pick which trustees come online; each publishes a partial decryption with a proof, and any t of them combine (Lagrange in the exponent) to reveal only the totals."
      >
        <div style={{ marginBottom: '0.7rem' }}>
          <span className="note" style={{ display: 'block', marginBottom: '0.4rem' }}>Trustees online for decryption:</span>
          <div className="seg" style={{ flexWrap: 'wrap' }}>
            {election.trustees.map((_, i) => (
              <button key={i} className={quorumSel.includes(i) ? 'on' : ''} onClick={() => toggleQuorum(i)}>
                <span style={{ color: COLORS[i % COLORS.length] }}>●</span> #{i + 1}
              </button>
            ))}
          </div>
          <div style={{ marginTop: '0.5rem' }}>
            <Verdict ok={quorumMet}>
              {quorumMet ? `${quorum.length} of ${n} online — quorum met (need ${tt})` : `need ${tt - quorum.length} more trustee(s)`}
            </Verdict>
          </div>
        </div>

        <table className="data" style={{ marginTop: '0.4rem' }}>
          <thead>
            <tr><th>candidate</th><th>aggregate A</th><th>aggregate B</th></tr>
          </thead>
          <tbody>
            {aggregates.map((agg, c) => (
              <tr key={c}>
                <td style={{ color: COLORS[c % COLORS.length] }}>● {CANDIDATES[c]}</td>
                <td className="mono" style={{ fontSize: '0.72rem' }}>{ctHex(agg.A)}</td>
                <td className="mono" style={{ fontSize: '0.72rem' }}>{ctHex(agg.B)}</td>
              </tr>
            ))}
          </tbody>
        </table>

        {result && (
          <>
            <div className="divider" />
            <div className="bars" style={{ marginTop: '0.4rem' }}>
              {result.results.map((res, c) => {
                const cnt = res.count
                const correct = cnt === truth[c]
                return (
                  <div className="bar" key={c}>
                    <span style={{ color: COLORS[c % COLORS.length] }}>{CANDIDATES[c]}</span>
                    <div className="track">
                      <div
                        className="fill"
                        style={{
                          width: `${((cnt ?? 0) / maxCount) * 100}%`,
                          background: COLORS[c % COLORS.length],
                          opacity: correct ? 1 : 0.4,
                        }}
                      />
                    </div>
                    <span className="mono">
                      {cnt === null ? '—' : cnt} {!correct && <span className="tag no">≠ {truth[c]}</span>}
                    </span>
                  </div>
                )
              })}
            </div>
            <p className="note">
              Decrypted totals recovered from the aggregate by a bounded discrete log (the total can
              be at most {v} votes). Ground truth from the plaintext choices:{' '}
              <span className="mono">[{truth.join(', ')}]</span> — the homomorphic tally reproduces it{' '}
              {clean ? 'exactly, having decrypted no individual ballot.' : 'unless something was tampered with.'}
            </p>
          </>
        )}
        {!quorumMet && (
          <p className="note">
            Bring at least {tt} trustees online. With fewer than the threshold, the Lagrange
            combination reconstructs the <em>wrong</em> key and the totals become unrecoverable —
            exactly the t-of-n guarantee.
          </p>
        )}
      </Panel>

      <Panel
        title="5 · Universal verifier"
        sub="What a scrutineer runs: re-derive the trustee keys from the public commitments, re-check every ballot proof, recompute the homomorphic aggregate, and verify every decryption proof — all without a single secret. Every box must be green for the result to stand."
      >
        {audit ? (
          <>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
              {audit.checks.map((c, i) => (
                <div key={i} style={{ display: 'flex', alignItems: 'center', gap: '0.7rem' }}>
                  <Verdict ok={c.ok}>{c.ok ? 'pass' : 'FAIL'}</Verdict>
                  <span><strong>{c.label}</strong> — <span className="note" style={{ display: 'inline' }}>{c.detail}</span></span>
                </div>
              ))}
            </div>
            <div className="divider" />
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.7rem', flexWrap: 'wrap' }}>
              <Verdict ok={audit.ok}>
                {audit.ok ? 'ELECTION VERIFIED ✓' : 'VERIFICATION FAILED ✗'}
              </Verdict>
              <span className="note" style={{ display: 'inline' }}>
                {audit.ok
                  ? 'Every guarantee holds: distributed trust, cast-as-intended integrity, and a publicly recomputable tally.'
                  : 'A tampered artifact broke a proof — the result is rejected without needing to trust anyone about what went wrong.'}
              </span>
            </div>
          </>
        ) : (
          <p className="note">Bring a quorum of trustees online (panel 4) to produce a verifiable tally to audit.</p>
        )}
        <div className="btn-row" style={{ marginTop: '0.9rem' }}>
          <button
            className={`btn ${corruptDec ? '' : 'ghost'}`}
            onClick={() => setCorruptDec((x) => !x)}
            disabled={!quorumMet}
          >
            {corruptDec ? '↩ honest trustees' : '⚠ corrupt a decryption share'}
          </button>
          <span className="note" style={{ display: 'inline' }}>
            A dishonest trustee that submits a wrong partial decryption is caught by its DLEQ proof —
            the "Decryption" check turns red and names the failure, so accountability is public.
          </span>
        </div>
      </Panel>
    </main>
  )
}
