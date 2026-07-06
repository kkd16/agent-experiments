// Node validation for the Arena statistics + game runner. Run with:
//   node tools/run-ts.mjs tools/arena-validate.ts
//
// Proves, outside the browser, that: the logistic Elo round-trips; the SPRT
// reaches the right verdict on synthetic streams drawn from a known Elo, and its
// average sample size is sane; the pentanomial variance is below the trinomial
// one for correlated pairs; the Bradley–Terry MLE recovers planted ratings; and
// the game runner actually plays a legal, terminating game between two brains.

import {
  eloFromScore,
  scoreFromElo,
  sprt,
  SPRT_DEFAULTS,
  estimate,
  emptyTally,
  addPair,
  fitRatings,
  emptyCrossTable,
  recordResult,
  losFromH2H,
  playGame,
  makeBrain,
  ADJUDICATION_DEFAULTS,
  type SprtParams,
} from '../src/engine/arena'

let failures = 0
function check(name: string, cond: boolean, detail = '') {
  const tag = cond ? '  ok ' : 'FAIL '
  if (!cond) failures++
  console.log(`${tag}${name}${detail ? ' — ' + detail : ''}`)
}

// Seeded RNG (mulberry32).
function rng(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

// ---------------------------------------------------------------------------
console.log('\n== Elo model ==')
for (const elo of [-300, -50, 0, 7, 100, 450]) {
  const s = scoreFromElo(elo)
  const back = eloFromScore(s)
  check(`round-trip elo=${elo}`, Math.abs(back - elo) < 1e-6, `score=${s.toFixed(4)} back=${back.toFixed(4)}`)
}
check('score(0)=0.5', Math.abs(scoreFromElo(0) - 0.5) < 1e-12)
check('monotone', scoreFromElo(10) > scoreFromElo(0) && scoreFromElo(0) > scoreFromElo(-10))

// ---------------------------------------------------------------------------
// Simulate a single game-pair for player A given a true per-game score p and a
// draw rate. Colour reversal is modelled by drawing two independent games at the
// same p (a fair, if conservative, model for the pentanomial machinery).
function simPair(p: number, drawRate: number, rand: () => number): [number, number] {
  const one = (): number => {
    if (rand() < drawRate) return 0.5
    // Split the non-draw mass around p.
    const winGivenDecisive = (p - drawRate / 2) / (1 - drawRate)
    return rand() < Math.max(0, Math.min(1, winGivenDecisive)) ? 1 : 0
  }
  return [one(), one()]
}

console.log('\n== SPRT verdicts (pentanomial) ==')
// H0: elo0=0, H1: elo1=10, alpha=beta=0.05.
const params: SprtParams = { ...SPRT_DEFAULTS, elo0: 0, elo1: 10, alpha: 0.05, beta: 0.05 }
function runSprt(trueElo: number, drawRate: number, seed: number, cap = 60000): { verdict: string; n: number } {
  const rand = rng(seed)
  const p = scoreFromElo(trueElo)
  const t = emptyTally()
  for (let pair = 0; pair < cap; pair++) {
    const [a, b] = simPair(p, drawRate, rand)
    addPair(t, a, b)
    if (pair >= 10) {
      const r = sprt(t, params)
      if (r.verdict !== 'continue') return { verdict: r.verdict, n: pair + 1 }
    }
  }
  return { verdict: 'continue', n: cap }
}
// Strong patch (true +30 Elo, well above elo1) → accept H1 the vast majority.
{
  let h1 = 0
  let tot = 0
  let sumN = 0
  for (let s = 0; s < 40; s++) {
    const r = runSprt(30, 0.3, 1000 + s)
    tot++
    sumN += r.n
    if (r.verdict === 'accept-h1') h1++
  }
  check('true +30 Elo ⇒ mostly accept-H1', h1 / tot >= 0.9, `${h1}/${tot}, avg pairs=${Math.round(sumN / tot)}`)
}
// Regression (true −30 Elo, below elo0) → accept H0 the vast majority.
{
  let h0 = 0
  let tot = 0
  for (let s = 0; s < 40; s++) {
    const r = runSprt(-30, 0.3, 7000 + s)
    tot++
    if (r.verdict === 'accept-h0') h0++
  }
  check('true −30 Elo ⇒ mostly accept-H0', h0 / tot >= 0.9, `${h0}/${tot}`)
}
// Wald error-rate sanity: under H0 exactly (true elo = elo0 = 0), the false
// accept-H1 rate should be near or below alpha.
{
  let h1 = 0
  let tot = 0
  for (let s = 0; s < 120; s++) {
    const r = runSprt(0, 0.3, 20000 + s)
    tot++
    if (r.verdict === 'accept-h1') h1++
  }
  check('at H0 boundary, type-I ≲ 2·alpha', h1 / tot <= 0.12, `false-H1 rate=${(h1 / tot).toFixed(3)}`)
}

// ---------------------------------------------------------------------------
console.log('\n== Exact (empirical-likelihood) pentanomial GSPRT ==')
{
  // Build a decisive tally and compare the exact LLR to the normal-approx one:
  // same sign, same verdict, and close in magnitude (they agree to first order).
  const rand = rng(9090)
  const t = emptyTally()
  const p = scoreFromElo(25)
  for (let i = 0; i < 300; i++) {
    const [a, b] = simPair(p, 0.3, rand)
    addPair(t, a, b)
  }
  const approx = sprt(t, { ...params, model: 'pentanomial' })
  const exact = sprt(t, { ...params, model: 'pentanomial-exact' })
  check('exact & approx agree in sign', Math.sign(approx.llr) === Math.sign(exact.llr), `approx=${approx.llr.toFixed(3)} exact=${exact.llr.toFixed(3)}`)
  check('exact & approx close in magnitude', Math.abs(approx.llr - exact.llr) < 0.15 * Math.abs(approx.llr) + 0.5, `Δ=${Math.abs(approx.llr - exact.llr).toFixed(3)}`)
  check('exact LLR finite', Number.isFinite(exact.llr))
  check('expectedRemaining ≥ 0', exact.expectedRemaining >= 0)
}
{
  // Exact-model verdict correctness on real streams: strong patch → accept-H1.
  const paramsExact = { ...params, model: 'pentanomial-exact' as const }
  let h1 = 0
  let tot = 0
  for (let s = 0; s < 30; s++) {
    const rand = rng(45000 + s)
    const p = scoreFromElo(30)
    const t = emptyTally()
    let done = false
    for (let pair = 0; pair < 60000 && !done; pair++) {
      const [a, b] = simPair(p, 0.3, rand)
      addPair(t, a, b)
      if (pair >= 10) {
        const r = sprt(t, paramsExact)
        if (r.verdict !== 'continue') { if (r.verdict === 'accept-h1') h1++; done = true }
      }
    }
    tot++
  }
  check('exact model: true +30 Elo ⇒ mostly accept-H1', h1 / tot >= 0.9, `${h1}/${tot}`)
}

// ---------------------------------------------------------------------------
console.log('\n== Degenerate (one-sided) result decides ==')
{
  // Every pair a double-win → all pentanomial mass in one bucket. A lopsided match
  // is decisive, not uninformative: both models must produce a large positive LLR
  // and accept H1, not stall at LLR≈0.
  const t = emptyTally()
  for (let i = 0; i < 30; i++) addPair(t, 1, 1)
  for (const model of ['pentanomial', 'pentanomial-exact', 'trinomial'] as const) {
    const r = sprt(t, { ...params, model })
    check(`${model}: all-wins ⇒ accept-H1`, r.verdict === 'accept-h1' && r.llr > r.upper, `llr=${r.llr.toFixed(2)} upper=${r.upper.toFixed(2)}`)
  }
}

// ---------------------------------------------------------------------------
console.log('\n== SPRT Wald bounds ==')
{
  const t = emptyTally()
  addPair(t, 1, 0.5)
  const r = sprt(t, params)
  check('lower = log(β/(1−α))', Math.abs(r.lower - Math.log(0.05 / 0.95)) < 1e-12)
  check('upper = log((1−β)/α)', Math.abs(r.upper - Math.log(0.95 / 0.05)) < 1e-12)
}

// ---------------------------------------------------------------------------
console.log('\n== Pentanomial vs trinomial variance ==')
{
  // Reversed-colour pairs are *negatively* correlated: a one-sided opening tends
  // to a balanced 1–0 / 0–1 pair rather than a lopsided 2–0. That negative
  // within-pair covariance is exactly what drops the pentanomial variance below
  // the trinomial one — the whole reason pairing is the tester's standard.
  const rand = rng(4242)
  const t = emptyTally()
  for (let i = 0; i < 4000; i++) {
    const u = rand()
    let a: number, b: number
    if (u < 0.4) [a, b] = [0.5, 0.5]
    else if (u < 0.6) [a, b] = [1, 0]
    else if (u < 0.8) [a, b] = [0, 1]
    else if (u < 0.9) [a, b] = [1, 1]
    else [a, b] = [0, 0]
    addPair(t, a, b)
  }
  const est = estimate(t)
  // Trinomial SE for comparison.
  const games = t.w + t.d + t.l
  const mean = (t.w + 0.5 * t.d) / games
  const e2 = (t.w + 0.25 * t.d) / games
  const triSE = Math.sqrt((e2 - mean * mean) / games)
  check('pentanomial SE < trinomial SE (correlated pairs)', est.scoreSE < triSE, `penta=${est.scoreSE.toExponential(3)} tri=${triSE.toExponential(3)}`)
  check('estimate has pairs & sane elo', est.pairs === 4000 && Number.isFinite(est.elo))
}

// ---------------------------------------------------------------------------
console.log('\n== Elo estimate CI coverage ==')
{
  // Plant a true +40 Elo edge; the 95% CI should cover it ≈95% of the time.
  let covered = 0
  const trials = 200
  for (let s = 0; s < trials; s++) {
    const rand = rng(60000 + s)
    const p = scoreFromElo(40)
    const t = emptyTally()
    for (let i = 0; i < 300; i++) {
      const [a, b] = simPair(p, 0.35, rand)
      addPair(t, a, b)
    }
    const est = estimate(t)
    if (est.eloLow <= 40 && 40 <= est.eloHigh) covered++
  }
  const cov = covered / trials
  check('≈95% CI coverage of planted +40 Elo', cov >= 0.9 && cov <= 0.995, `coverage=${(cov * 100).toFixed(1)}%`)
}

// ---------------------------------------------------------------------------
console.log('\n== Bradley–Terry MLE recovery ==')
{
  // Plant true Elos, generate a round-robin, fit, and check recovery + ordering.
  const trueElo = [0, 40, 80, 150, -60]
  const n = trueElo.length
  const labels = trueElo.map((e, i) => `E${i}(${e})`)
  const ct = emptyCrossTable(labels)
  const rand = rng(31337)
  const gamesPerPair = 400
  const drawBase = 0.3
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const p = scoreFromElo(trueElo[i] - trueElo[j])
      for (let g = 0; g < gamesPerPair; g++) {
        let sc: number
        if (rand() < drawBase) sc = 0.5
        else {
          const wgd = (p - drawBase / 2) / (1 - drawBase)
          sc = rand() < Math.max(0, Math.min(1, wgd)) ? 1 : 0
        }
        recordResult(ct, i, j, sc)
      }
    }
  }
  const st = fitRatings(ct)
  // Ordering must match the planted order.
  const order = st.map((s) => s.index)
  const trueOrder = [...trueElo.keys()].sort((a, b) => trueElo[b] - trueElo[a])
  check('MLE ordering matches planted', JSON.stringify(order) === JSON.stringify(trueOrder), order.join('>'))
  // Elo *differences* recovered within tolerance (ratings are anchored to mean 0,
  // so compare gaps relative to the top engine).
  const byIndex = new Map(st.map((s) => [s.index, s.elo]))
  const topTrue = Math.max(...trueElo)
  const topIdx = trueElo.indexOf(topTrue)
  let maxErr = 0
  for (let i = 0; i < n; i++) {
    const gotGap = byIndex.get(topIdx)! - byIndex.get(i)!
    const trueGap = topTrue - trueElo[i]
    maxErr = Math.max(maxErr, Math.abs(gotGap - trueGap))
  }
  check('MLE Elo gaps within 25 of truth', maxErr < 25, `maxErr=${maxErr.toFixed(1)}`)
  check('errors are positive & finite', st.every((s) => s.eloError > 0 && Number.isFinite(s.eloError)))
}

// ---------------------------------------------------------------------------
console.log('\n== LOS from head-to-head ==')
{
  check('big lead ⇒ LOS≈1', losFromH2H({ wins: 90, draws: 10, losses: 0 }) > 0.999)
  check('big deficit ⇒ LOS≈0', losFromH2H({ wins: 0, draws: 10, losses: 90 }) < 0.001)
  check('dead even ⇒ LOS≈0.5', Math.abs(losFromH2H({ wins: 20, draws: 60, losses: 20 }) - 0.5) < 1e-9)
}

// ---------------------------------------------------------------------------
console.log('\n== Game runner ==')
{
  // A tiny AB-vs-AB game from the standard opening. Must terminate with a legal
  // result and a non-empty movetext.
  const strong = makeBrain({ search: 'ab', budget: 6000, eval: 'classical', label: 'strong' }, null)
  const weak = makeBrain({ search: 'ab', budget: 800, eval: 'classical', label: 'weak' }, null)
  const fen = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1'
  const g = playGame(strong, weak, fen, { ...ADJUDICATION_DEFAULTS, maxPlies: 120 }, 1)
  check('game terminates with a score in {0,½,1}', g.white === 0 || g.white === 0.5 || g.white === 1, `white=${g.white} reason=${g.reason} plies=${g.plies}`)
  check('movetext non-empty', g.san.split(' ').length >= 2, `${g.plies} plies, reason=${g.reason}`)

  // The much stronger side should not *lose* a short game from the start (allow a draw).
  let wins = 0
  let losses = 0
  for (let k = 0; k < 4; k++) {
    const s = makeBrain({ search: 'ab', budget: 10000, eval: 'classical', label: 's' }, null)
    const w = makeBrain({ search: 'ab', budget: 500, eval: 'classical', label: 'w' }, null)
    const r = playGame(s, w, fen, { ...ADJUDICATION_DEFAULTS, maxPlies: 160 }, 100 + k)
    if (r.white === 1) wins++
    if (r.white === 0) losses++
  }
  check('strong AB never loses to weak AB (4 games)', losses === 0, `wins=${wins} losses=${losses}`)
}

console.log(`\n${failures === 0 ? 'ALL PASS' : failures + ' FAILURE(S)'}\n`)
if (failures > 0) process.exit(1)
