import { useMemo, useState } from 'react'
import { PageHead, Panel, Verdict } from '../ui/components'
import { runAtomicSwap } from '../ecc/adaptor'
import { N } from '../ecc/secp256k1'
import type { Point } from '../ecc/curve'
import { utf8 } from '../ecc/sha256'
import { randomScalar } from '../ecc/rng'
import { hex } from '../ui/format'

const TX_A = 'tx_A — Alice → Bob: 1.0 BTC on chain A'
const TX_B = 'tx_B — Bob → Alice: 42.0 XMR on chain B'

const px = (P: Point, w = 16): string => (P === null ? 'O' : hex(P.x, 64).slice(0, w + 2) + '…')

export function AdaptorPage() {
  const [seed, setSeed] = useState(0)
  const [step, setStep] = useState(0)

  const keys = useMemo(() => {
    void seed
    return {
      t: randomScalar(N),
      alice: randomScalar(N),
      bob: randomScalar(N),
      nA: randomScalar(N),
      nB: randomScalar(N),
    }
  }, [seed])

  const sw = useMemo(
    () => runAtomicSwap(keys.t, keys.alice, keys.bob, utf8(TX_A), utf8(TX_B), keys.nA, keys.nB),
    [keys],
  )

  const regen = () => {
    setSeed((s) => s + 1)
    setStep(0)
  }

  return (
    <main className="page">
      <PageHead eyebrow="Lab 13 — scriptless scripts" title="Schnorr Adaptor Signatures">
        An <strong>adaptor signature</strong> is a Schnorr signature with a missing piece. The signer
        publishes a <em>pre-signature</em> <code>ŝ</code> locked to an adaptor point{' '}
        <code>T = t·G</code>; on its own it does not verify. Whoever knows the secret{' '}
        <code>t</code> can <strong>adapt</strong> it into a real signature{' '}
        <code>s = ŝ + t</code> — and anyone who then sees both <code>ŝ</code> and <code>s</code> can{' '}
        <strong>extract</strong> <code>t = s − ŝ</code>. Lock two transactions to the same{' '}
        <code>T</code> and you get an <strong>atomic swap</strong>: completing one leg unavoidably
        leaks the secret that completes the other. A chain observer sees only two ordinary Schnorr
        signatures — no hash locks, no special script.
      </PageHead>

      <div className="seg" style={{ marginBottom: '1rem' }}>
        <button className="btn" onClick={regen}>↻ new swap</button>
        <span style={{ flex: 1 }} />
        <button className="btn" disabled={step === 0} onClick={() => setStep((s) => Math.max(0, s - 1))}>
          ← back
        </button>
        <button className="btn" disabled={step >= 4} onClick={() => setStep((s) => Math.min(4, s + 1))}>
          {step === 0 ? 'run the swap →' : 'next step →'}
        </button>
      </div>

      <Panel
        title="Step 0 — setup: one secret, two locked pre-signatures"
        sub="Alice picks a secret t and publishes only T = t·G. Each party pre-signs the transaction paying the other, locked to T. Both pre-signatures verify — yet neither is a usable signature yet."
      >
        <dl className="kv">
          <dt>adaptor secret t (Alice only)</dt>
          <dd className="hexbox" style={{ gridColumn: '1 / -1' }}>{step >= 2 ? hex(keys.t, 64) : '•••• hidden until revealed on-chain ••••'}</dd>
          <dt>adaptor point T = t·G (public)</dt>
          <dd className="hexbox violet" style={{ gridColumn: '1 / -1' }}>{px(sw.T, 56)}</dd>
        </dl>
        <table className="data" style={{ marginTop: '0.8rem' }}>
          <thead>
            <tr><th>leg</th><th>transaction</th><th>pre-signature ŝ</th><th>locked & valid?</th></tr>
          </thead>
          <tbody>
            <tr>
              <td style={{ color: '#5eead4' }}>Alice→Bob</td>
              <td>{TX_A}</td>
              <td className="mono">{hex(sw.preA.shat, 18)}…</td>
              <td><Verdict ok={sw.preAok}>{sw.preAok ? 'pre-valid' : 'bad'}</Verdict></td>
            </tr>
            <tr>
              <td style={{ color: '#fbbf24' }}>Bob→Alice</td>
              <td>{TX_B}</td>
              <td className="mono">{hex(sw.preB.shat, 18)}…</td>
              <td><Verdict ok={sw.preBok}>{sw.preBok ? 'pre-valid' : 'bad'}</Verdict></td>
            </tr>
          </tbody>
        </table>
        <div className="note" style={{ marginTop: '0.5rem' }}>
          A pre-signature proves <code>ŝ·G = R + e·P</code> — correct except for the missing{' '}
          <code>+t·G</code>. Bob can check Alice’s pre-sig is sound before locking up any funds.
        </div>
      </Panel>

      {step >= 1 && (
        <Panel
          title="Step 1 — Alice claims her leg, publishing a real signature"
          sub="Alice knows t, so she adapts Bob's pre-signature into a finished signature s_B = ŝ_B + t and broadcasts it to claim tx_B on chain B."
        >
          <dl className="kv">
            <dt>finished s_B = ŝ_B + t</dt>
            <dd className="hexbox lavender" style={{ gridColumn: '1 / -1' }}>{hex(sw.sigB.s, 64)}</dd>
            <dt>nonce point R̄ = R + T</dt>
            <dd className="hexbox" style={{ gridColumn: '1 / -1' }}>{px(sw.sigB.Rbar, 56)}</dd>
          </dl>
          <Verdict ok={sw.sigBok}>
            {sw.sigBok ? 'verifies as an ordinary Schnorr signature ✓' : 'invalid'}
          </Verdict>
          <div className="note" style={{ marginTop: '0.5rem' }}>
            On-chain this is indistinguishable from any other Schnorr signature. But it carries a
            hidden consequence…
          </div>
        </Panel>
      )}

      {step >= 2 && (
        <Panel
          title="Step 2 — the secret leaks: Bob extracts t"
          sub="Bob has his own pre-signature ŝ_B and now sees the finished s_B. Subtracting gives t = s_B − ŝ_B — the secret Alice never sent him."
        >
          <dl className="kv">
            <dt>t recovered by Bob</dt>
            <dd className="hexbox violet" style={{ gridColumn: '1 / -1' }}>{hex(sw.tRecovered, 64)}</dd>
          </dl>
          <Verdict ok={sw.extractedOk}>
            {sw.extractedOk ? 'recovered t equals Alice’s original secret ✓' : 'mismatch'}
          </Verdict>
        </Panel>
      )}

      {step >= 3 && (
        <Panel
          title="Step 3 — Bob claims his leg"
          sub="With t in hand, Bob adapts Alice's pre-signature s_A = ŝ_A + t and claims tx_A on chain A. Both legs are now settled."
        >
          <dl className="kv">
            <dt>finished s_A = ŝ_A + t</dt>
            <dd className="hexbox lavender" style={{ gridColumn: '1 / -1' }}>{hex(sw.sigA.s, 64)}</dd>
          </dl>
          <Verdict ok={sw.sigAok}>{sw.sigAok ? 'verifies ✓' : 'invalid'}</Verdict>
        </Panel>
      )}

      {step >= 4 && (
        <Panel title="Atomicity" sub="Either both legs settle, or neither does.">
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.8rem', flexWrap: 'wrap' }}>
            <Verdict ok={sw.atomic}>{sw.atomic ? 'swap completed atomically ✓' : 'swap broke'}</Verdict>
            <span className="note" style={{ flex: 1 }}>
              Alice could not claim tx_B <em>without</em> revealing t, and that revelation is exactly
              what lets Bob claim tx_A. There is no state of the world where one party walks away with
              both coins. The whole protocol used nothing but plain Schnorr arithmetic — no
              timelocks, no hash preimages, no on-chain scripts. That is a scriptless script.
            </span>
          </div>
        </Panel>
      )}
    </main>
  )
}
