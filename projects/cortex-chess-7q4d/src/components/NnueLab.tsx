// The NNUE lab: train a from-scratch neural-network evaluation by distillation
// from the hand-crafted eval, watch it learn live, prove the incremental
// accumulator is bit-exact, gradient-check the hand-derived backprop, correlate the
// net against the classical eval, and race the two evaluations head-to-head.

import { useCallback, useEffect, useRef, useState } from 'react'
import {
  Game,
  Searcher,
  START_FEN,
  generateLegal,
  Accumulator,
  nnueEvalFresh,
  NnueTrainer,
  generatePositions,
  datasetLoss,
  correlation,
  gradCheck,
  mulberry32,
  serializeNnue,
  deserializeNnue,
  nnueSave,
  nnueLoad,
  nnueClear,
  type NnueWeights,
  type Correlation,
  type Example,
  type NnueMeta,
} from '../engine'

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

const H_CHOICES = [64, 128, 256]
const POS_CHOICES = [1500, 2500, 4000]
const EPOCH_CHOICES = [20, 40, 70]

interface SelfTest {
  accMaxDiff: number
  accMismatch: number
  accPositions: number
  gradErr: number
  gradChecked: number
}

interface MatchState {
  running: boolean
  done: number
  total: number
  wins: number
  draws: number
  losses: number
}

// ---- tiny inline charts ----

function LossChart({ loss }: { loss: number[] }) {
  const w = 460
  const h = 150
  const pad = 28
  if (loss.length < 2) {
    return (
      <svg className="nnue-chart" viewBox={`0 0 ${w} ${h}`} role="img" aria-label="loss curve">
        <text x={w / 2} y={h / 2} textAnchor="middle" className="nnue-axis">
          loss curve appears here
        </text>
      </svg>
    )
  }
  const max = Math.max(...loss)
  const min = Math.min(...loss)
  const span = max - min || 1
  const x = (i: number) => pad + (i / (loss.length - 1)) * (w - pad - 6)
  const y = (v: number) => pad / 2 + (1 - (v - min) / span) * (h - pad - pad / 2)
  const d = loss.map((v, i) => `${i === 0 ? 'M' : 'L'}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(' ')
  return (
    <svg className="nnue-chart" viewBox={`0 0 ${w} ${h}`} role="img" aria-label="loss curve">
      <line x1={pad} y1={h - pad} x2={w - 6} y2={h - pad} className="nnue-axis-line" />
      <line x1={pad} y1={pad / 2} x2={pad} y2={h - pad} className="nnue-axis-line" />
      <path d={d} className="nnue-loss-line" />
      <text x={pad - 4} y={y(max)} textAnchor="end" className="nnue-axis">
        {max.toFixed(3)}
      </text>
      <text x={pad - 4} y={y(min) + 4} textAnchor="end" className="nnue-axis">
        {min.toFixed(3)}
      </text>
      <text x={(w + pad) / 2} y={h - 4} textAnchor="middle" className="nnue-axis">
        epoch →
      </text>
    </svg>
  )
}

function ScatterChart({ corr }: { corr: Correlation }) {
  const w = 240
  const h = 240
  const pad = 4
  const lim = 1200
  const map = (v: number) => {
    const c = Math.max(-lim, Math.min(lim, v))
    return ((c + lim) / (2 * lim)) * (w - 2 * pad) + pad
  }
  return (
    <svg className="nnue-scatter" viewBox={`0 0 ${w} ${h}`} role="img" aria-label="net vs classical scatter">
      <rect x={0} y={0} width={w} height={h} className="nnue-scatter-bg" />
      <line x1={map(-lim)} y1={h - map(-lim)} x2={map(lim)} y2={h - map(lim)} className="nnue-ideal-line" />
      {corr.points.map((p, i) => (
        <circle key={i} cx={map(p.x)} cy={h - map(p.y)} r={1.6} className="nnue-dot" />
      ))}
      <text x={w / 2} y={h - 4} textAnchor="middle" className="nnue-axis">
        classical cp →
      </text>
    </svg>
  )
}

export default function NnueLab() {
  const [h, setH] = useState(128)
  const [positions, setPositions] = useState(2500)
  const [epochs, setEpochs] = useState(40)

  const [phase, setPhase] = useState<'idle' | 'generating' | 'training'>('idle')
  const [progress, setProgress] = useState(0)
  const [lossHistory, setLossHistory] = useState<number[]>([])
  const [corr, setCorr] = useState<Correlation | null>(null)
  const [finalLoss, setFinalLoss] = useState<number | null>(null)
  const [selfTest, setSelfTest] = useState<SelfTest | null>(null)
  const [savedMeta, setSavedMeta] = useState<NnueMeta | null>(null)
  const [match, setMatch] = useState<MatchState | null>(null)
  const [status, setStatus] = useState('')
  const [hasWeights, setHasWeights] = useState(false)

  const weightsRef = useRef<NnueWeights | null>(null)
  const cancelRef = useRef(false)

  const refreshSaved = useCallback(() => {
    nnueLoad().then((r) => setSavedMeta(r?.meta ?? null))
  }, [])
  useEffect(() => {
    refreshSaved()
  }, [refreshSaved])

  const running = phase !== 'idle'

  const train = useCallback(async () => {
    cancelRef.current = false
    setPhase('generating')
    setProgress(0)
    setLossHistory([])
    setCorr(null)
    setFinalLoss(null)
    setSelfTest(null)
    setStatus('Sampling positions by self-play and labelling with the classical eval…')
    await sleep(20)

    // Generate the dataset (this is fast but synchronous; chunk it for the UI).
    const all: Example[] = generatePositions(positions, 0x51ce)
    const split = Math.floor(all.length * 0.85)
    const train = all.slice(0, split)
    const test = all.slice(split)
    await sleep(10)

    const trainer = new NnueTrainer({ h, seed: 0x2025, lr: 1.5e-3 })
    weightsRef.current = trainer.w
    setHasWeights(true)
    setPhase('training')
    const batch = 64
    const history: number[] = []
    for (let e = 0; e < epochs; e++) {
      if (cancelRef.current) break
      // Deterministic shuffle.
      const order = train.map((_, i) => i)
      const rng = mulberry32(0xabc + e)
      for (let i = order.length - 1; i > 0; i--) {
        const j = Math.floor(rng() * (i + 1))
        const t = order[i]
        order[i] = order[j]
        order[j] = t
      }
      let epochSse = 0
      let batches = 0
      for (let b = 0; b < order.length; b += batch) {
        const slice = order.slice(b, b + batch).map((i) => train[i])
        epochSse += trainer.trainBatch(slice)
        batches++
        if ((b / batch) % 6 === 0) await sleep(0)
      }
      history.push(epochSse / Math.max(1, batches))
      setLossHistory([...history])
      setProgress((e + 1) / epochs)
      await sleep(0)
    }

    // Final metrics on the held-out set.
    const fl = datasetLoss(trainer.w, test)
    const c = correlation(trainer.w, test)
    setFinalLoss(fl)
    setCorr(c)

    // Self-tests: accumulator equivalence + gradient check.
    setStatus('Verifying the incremental accumulator and gradients…')
    await sleep(10)
    const st = runSelfTests(trainer.w)
    setSelfTest(st)

    setPhase('idle')
    setStatus(
      `Trained H=${h} on ${train.length} positions — holdout R²=${c.r2.toFixed(3)}, RMSE ${c.rmse.toFixed(0)}cp.`,
    )
  }, [h, positions, epochs])

  const cancel = useCallback(() => {
    cancelRef.current = true
  }, [])

  const save = useCallback(async () => {
    const w = weightsRef.current
    if (!w || !corr || finalLoss === null) return
    const meta: NnueMeta = {
      positions: Math.floor(positions * 0.85),
      epochs,
      finalLoss,
      r2: corr.r2,
      trainedAt: new Date().toISOString().slice(0, 10),
    }
    const ok = await nnueSave(serializeNnue(w), meta)
    setStatus(ok ? 'Saved to IndexedDB — switch to Play and toggle “NNUE” to use it.' : 'Save failed (storage unavailable).')
    refreshSaved()
  }, [corr, finalLoss, positions, epochs, refreshSaved])

  const load = useCallback(async () => {
    const r = await nnueLoad()
    if (!r) {
      setStatus('No saved network found.')
      return
    }
    const w = deserializeNnue(r.blob)
    weightsRef.current = w
    setHasWeights(true)
    setStatus(`Loaded saved network (H=${w.h}, R²=${r.meta.r2.toFixed(3)}). Re-run the self-tests or a match below.`)
    setSelfTest(runSelfTests(w))
  }, [])

  const clear = useCallback(async () => {
    await nnueClear()
    setStatus('Cleared the saved network.')
    refreshSaved()
  }, [refreshSaved])

  const runMatch = useCallback(async () => {
    const w = weightsRef.current
    if (!w) return
    const games = 8
    const nodes = 8000
    const ms: MatchState = { running: true, done: 0, total: games, wins: 0, draws: 0, losses: 0 }
    setMatch({ ...ms })
    const sN = new Searcher()
    sN.setEvaluator(w)
    const sC = new Searcher()
    sC.setEvaluator(null)
    for (let game = 0; game < games; game++) {
      const nnueWhite = game % 2 === 0
      const g = new Game(START_FEN)
      for (let ply = 0; ply < 120 && g.result() === 'playing'; ply++) {
        const whiteToMove = g.pos.turn === 0
        const useNnue = whiteToMove === nnueWhite
        const s = useNnue ? sN : sC
        const r = s.search(g.pos, { maxDepth: 10, maxTime: 0, maxNodes: nodes, history: g.keyHistory() })
        if (!r.pv[0]) break
        g.apply(r.pv[0])
        if (ply % 4 === 0) await sleep(0)
      }
      const res = g.result()
      if (res === 'checkmate') {
        const loserWhite = g.pos.turn === 0
        const nnueLost = loserWhite === nnueWhite
        if (nnueLost) ms.losses++
        else ms.wins++
      } else {
        ms.draws++
      }
      ms.done = game + 1
      setMatch({ ...ms })
      await sleep(0)
    }
    ms.running = false
    setMatch({ ...ms })
  }, [])

  const score = match ? (match.wins + match.draws / 2).toFixed(1) : '0'

  return (
    <div className="lab">
      <div className="lab-intro">
        <p>
          <strong>NNUE</strong> (an efficiently-updatable neural-network evaluation) is what modern engines use
          instead of hand-written positional terms. This one is built from scratch — no ML libraries — and trained by{' '}
          <strong>knowledge distillation</strong>: positions are sampled by self-play, labelled with Cortex’s own
          classical eval, and a hand-rolled Adam-SGD loop fits a small net to reproduce that signal. Its first layer is
          the <em>accumulator</em> the search updates one move at a time — verified bit-for-bit against a full refresh.
        </p>
        <div className="nnue-controls">
          <label>
            Hidden size
            <span className="nnue-seg">
              {H_CHOICES.map((c) => (
                <button key={c} className={h === c ? 'seg active' : 'seg'} onClick={() => setH(c)} disabled={running}>
                  {c}
                </button>
              ))}
            </span>
          </label>
          <label>
            Positions
            <span className="nnue-seg">
              {POS_CHOICES.map((c) => (
                <button
                  key={c}
                  className={positions === c ? 'seg active' : 'seg'}
                  onClick={() => setPositions(c)}
                  disabled={running}
                >
                  {c}
                </button>
              ))}
            </span>
          </label>
          <label>
            Epochs
            <span className="nnue-seg">
              {EPOCH_CHOICES.map((c) => (
                <button
                  key={c}
                  className={epochs === c ? 'seg active' : 'seg'}
                  onClick={() => setEpochs(c)}
                  disabled={running}
                >
                  {c}
                </button>
              ))}
            </span>
          </label>
        </div>
        <div className="nnue-buttons">
          {!running ? (
            <button className="btn primary" onClick={train}>
              Train network
            </button>
          ) : (
            <button className="btn" onClick={cancel}>
              Stop
            </button>
          )}
          <button className="btn" onClick={save} disabled={running || !corr}>
            Save
          </button>
          <button className="btn" onClick={load} disabled={running}>
            Load saved
          </button>
          <button className="btn" onClick={clear} disabled={running || !savedMeta}>
            Clear
          </button>
          {savedMeta && (
            <span className="nnue-saved">
              saved: H·R²={savedMeta.r2.toFixed(2)}, {savedMeta.positions} pos, {savedMeta.trainedAt}
            </span>
          )}
        </div>
        {running && (
          <div className="nnue-progress">
            <div className="nnue-progress-bar" style={{ width: `${Math.round(progress * 100)}%` }} />
            <span className="nnue-progress-label">
              {phase === 'generating' ? 'sampling positions…' : `training — epoch ${lossHistory.length}/${epochs}`}
            </span>
          </div>
        )}
        {status && <p className="nnue-status">{status}</p>}
      </div>

      <div className="nnue-grid">
        <div className="nnue-panel">
          <h4>Training loss (MSE per epoch)</h4>
          <LossChart loss={lossHistory} />
        </div>
        <div className="nnue-panel">
          <h4>Net vs classical eval (holdout)</h4>
          {corr ? (
            <div className="nnue-corr">
              <ScatterChart corr={corr} />
              <div className="nnue-corr-stats">
                <div>
                  <span className="big">{corr.r2.toFixed(3)}</span>
                  <span className="lbl">R²</span>
                </div>
                <div>
                  <span className="big">{corr.r.toFixed(3)}</span>
                  <span className="lbl">Pearson r</span>
                </div>
                <div>
                  <span className="big">{corr.rmse.toFixed(0)}</span>
                  <span className="lbl">RMSE (cp)</span>
                </div>
                {finalLoss !== null && (
                  <div>
                    <span className="big">{finalLoss.toFixed(4)}</span>
                    <span className="lbl">holdout MSE</span>
                  </div>
                )}
              </div>
            </div>
          ) : (
            <p className="nnue-empty">Train a network to see how closely it reproduces the classical eval.</p>
          )}
        </div>
      </div>

      {selfTest && (
        <table className="lab-table">
          <thead>
            <tr>
              <th>Verification</th>
              <th>Result</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            <tr className={`lab-row ${selfTest.accMismatch === 0 && selfTest.accMaxDiff < 1e-3 ? 'pass' : 'fail'}`}>
              <td>Incremental accumulator == full refresh</td>
              <td>
                max Δ {selfTest.accMaxDiff.toExponential(2)}, {selfTest.accMismatch} eval mismatches over{' '}
                {selfTest.accPositions} positions
              </td>
              <td className="lab-status">{selfTest.accMismatch === 0 && selfTest.accMaxDiff < 1e-3 ? '✓' : '✗'}</td>
            </tr>
            <tr className={`lab-row ${selfTest.gradErr < 1e-2 ? 'pass' : 'fail'}`}>
              <td>Hand-derived gradients vs finite differences</td>
              <td>
                max relative error {selfTest.gradErr.toExponential(2)} over {selfTest.gradChecked} probed parameters
              </td>
              <td className="lab-status">{selfTest.gradErr < 1e-2 ? '✓' : '✗'}</td>
            </tr>
          </tbody>
        </table>
      )}

      <div className="nnue-match">
        <h4>Head-to-head: NNUE eval vs classical eval</h4>
        <p className="nnue-empty">
          Eight games (alternating colours) at a fixed node budget, both sides on the same search — only the evaluation
          differs. A score near 4/8 means the learned net plays on par with the hand-crafted eval it distilled.
        </p>
        <button className="btn primary" onClick={runMatch} disabled={!hasWeights || (match?.running ?? false)}>
          {match?.running ? `Playing… ${match.done}/${match.total}` : 'Play 8-game match'}
        </button>
        {!hasWeights && <span className="nnue-saved">train or load a network first</span>}
        {match && (
          <div className="nnue-match-result">
            <span className="big">
              {score}/{match.total}
            </span>
            <span className="lbl">
              NNUE: {match.wins}W · {match.draws}D · {match.losses}L
            </span>
          </div>
        )}
      </div>
    </div>
  )
}

// Run the deterministic self-tests against a set of weights: incremental
// accumulator equivalence over random games + a gradient check.
function runSelfTests(w: NnueWeights): SelfTest {
  const rng = mulberry32(99)
  let maxDiff = 0
  let mismatch = 0
  let positions = 0
  for (let game = 0; game < 12; game++) {
    const g = new Game(START_FEN)
    const acc = new Accumulator(w)
    acc.refresh(g.pos)
    for (let ply = 0; ply < 26; ply++) {
      const moves = generateLegal(g.pos)
      if (moves.length === 0) break
      const m = moves[Math.floor(rng() * moves.length)]
      acc.applyMove(g.pos, m, 1)
      g.apply(m)
      positions++
      const fresh = new Accumulator(w)
      fresh.refresh(g.pos)
      for (let j = 0; j < w.h; j++) {
        const dw = Math.abs(acc.white[j] - fresh.white[j])
        const db = Math.abs(acc.black[j] - fresh.black[j])
        if (dw > maxDiff) maxDiff = dw
        if (db > maxDiff) maxDiff = db
      }
      if (acc.evalScore(g.pos.turn) !== nnueEvalFresh(w, g.pos)) mismatch++
    }
  }
  const gc = gradCheck(11, 16)
  return { accMaxDiff: maxDiff, accMismatch: mismatch, accPositions: positions, gradErr: gc.maxRelErr, gradChecked: gc.checked }
}
