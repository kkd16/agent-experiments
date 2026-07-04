import { useMemo, useState } from 'react'
import { PageHeader, Panel, Stat } from '../components/ui'
import { LineChart } from '../components/charts'
import {
  LDPC_DEMO,
  LDPC_BIG,
  ldpcEncode,
  bpDecodeLLR,
  bscLLR,
  ldpcMinDistance,
  ldpcSyndromeZero,
  type LdpcCode,
} from '../lib/ldpc'
import { RNG } from '../lib/channel'

export function Ldpc() {
  const code = LDPC_DEMO
  const [p, setP] = useState(0.05)
  const [seed, setSeed] = useState(179)
  const [iter, setIter] = useState(1)

  const dmin = useMemo(() => ldpcMinDistance(code), [code])

  // Deterministic message + BSC corruption.
  const { codeword, received } = useMemo(() => {
    const rng = new RNG(0xabc + seed * 2654435761)
    const message = Array.from({ length: code.k }, () => (rng.float() < 0.5 ? 0 : 1))
    const codeword = ldpcEncode(code, message)
    const received = codeword.map((b) => (rng.float() < p ? b ^ 1 : b))
    return { codeword, received }
  }, [code, p, seed])

  const channelErrors = useMemo(() => received.reduce((a, b, i) => a + (b !== codeword[i] ? 1 : 0), 0), [received, codeword])

  // Full BP run (for the convergence trace) and a truncated run (for the scrubber).
  const full = useMemo(() => bpDecodeLLR(code, bscLLR(received, p), 50), [code, received, p])
  const atIter = useMemo(() => bpDecodeLLR(code, bscLLR(received, p), Math.max(1, iter)), [code, received, p, iter])

  const succeeded = full.success
  const decodedOk = full.bits.every((b, i) => b === codeword[i])

  // Which checks are currently unsatisfied at the scrubbed iteration.
  const unsatChecks = useMemo(() => {
    const bad = new Set<number>()
    for (let c = 0; c < code.m; c++) {
      let s = 0
      for (const v of code.checkNbrs[c]) s ^= atIter.bits[v]
      if (s) bad.add(c)
    }
    return bad
  }, [code, atIter])

  const flippedNow = new Set<number>()
  for (let i = 0; i < code.n; i++) if (atIter.bits[i] !== codeword[i]) flippedNow.add(i)

  const convergence: [number, number][] = full.unsatisfiedPerIter.map((u, i) => [i + 1, u])

  return (
    <div>
      <PageHeader
        kicker="Channel coding · the capacity-approaching code"
        title="LDPC & Belief Propagation"
        lede={
          <>
            Low-Density Parity-Check codes are linear codes whose parity-check matrix is <b>sparse</b> —
            and that sparsity lets the decoder run on the code's <b>Tanner graph</b>, passing local{' '}
            <b>beliefs</b> between bit-nodes and check-nodes. Each check tells each bit what it should be
            given the <em>others</em>; each bit pools its checks and the channel. Iterated, these messages
            converge to the most-likely codeword — <b>sum-product belief propagation</b>, the algorithm
            that gets within a fraction of a dB of the Shannon limit and runs inside <b>5G, Wi-Fi 6 and
            DVB-S2</b>.
          </>
        }
      />

      <Panel title="Set up the channel" right={<button className="btn" onClick={() => setSeed((s) => s + 1)}>Re-roll</button>}>
        <div className="row" style={{ gap: 18, marginBottom: 12 }}>
          <label className="field" style={{ minWidth: 260 }}>
            BSC crossover p: <b style={{ color: 'var(--text)' }}>{p.toFixed(3)}</b>
            <input type="range" min={0} max={0.2} step={0.005} value={p} onChange={(e) => setP(+e.target.value)} />
          </label>
        </div>
        <div className="grid grid-4">
          <Stat label="Code" value={`(${code.n},${code.k})`} sub={`rate ${(code.k / code.n).toFixed(2)}`} />
          <Stat label="Min distance" value={dmin} sub={`corrects ~${Math.floor((dmin - 1) / 2)}`} />
          <Stat label="Channel errors" value={channelErrors} accent sub={`${((channelErrors / code.n) * 100).toFixed(0)}% of bits`} />
          <Stat label="BP result" value={succeeded && decodedOk ? 'decoded ✓' : succeeded ? 'valid but ≠' : 'failed'} sub={`${full.iterations} iterations`} />
        </div>
      </Panel>

      <Panel
        title="The Tanner graph, decoding live"
        note="Top row = the 12 parity checks (□); bottom row = the 24 codeword bits (○); an edge wherever the parity-check matrix has a 1. Scrub the iteration slider: red bits still disagree with the sent codeword, amber checks are still unsatisfied. Watch them clear as beliefs propagate."
      >
        <label className="field" style={{ maxWidth: 360, marginBottom: 12 }}>
          BP iteration: <b style={{ color: 'var(--text)' }}>{Math.min(iter, full.iterations)}</b> / {full.iterations}
          <input type="range" min={1} max={Math.max(2, full.iterations)} step={1} value={Math.min(iter, full.iterations)} onChange={(e) => setIter(+e.target.value)} />
        </label>
        <TannerGraph code={code} unsatChecks={unsatChecks} flippedVars={flippedNow} />
        <div className="chip-row" style={{ marginTop: 10 }}>
          <span className="tag" style={{ color: 'var(--amber)', borderColor: 'var(--amber)' }}>unsatisfied check</span>
          <span className="tag" style={{ color: 'var(--red)', borderColor: 'var(--red)' }}>bit still wrong</span>
          <span className="tag" style={{ color: 'var(--green)', borderColor: 'var(--green)' }}>satisfied / correct</span>
          <span className="muted" style={{ fontSize: 11 }}>{unsatChecks.size} checks unsatisfied · {flippedNow.size} bits wrong at this step</span>
        </div>
      </Panel>

      <div className="grid grid-2" style={{ gap: 16 }}>
        <Panel
          title="Convergence"
          note="Unsatisfied parity checks after each BP iteration. Reaching zero means every check is satisfied — a valid codeword — and decoding stops."
        >
          {convergence.length > 0 && (
            <LineChart
              series={[{ label: 'unsatisfied checks', color: 'var(--violet)', points: convergence }]}
              xDomain={[1, Math.max(2, full.iterations)]}
              yDomain={[0, Math.max(1, ...full.unsatisfiedPerIter)]}
              xLabel="iteration"
              yLabel="failing checks"
              xTicks={Math.min(8, full.iterations)}
              xFmt={(v) => v.toFixed(0)}
              yFmt={(v) => v.toFixed(0)}
              markers={[{ x: Math.min(iter, full.iterations), label: 'now' }]}
            />
          )}
        </Panel>
        <Panel
          title="Why sparse wins"
          note="The whole trick is the low density of the parity-check matrix."
        >
          <div className="prose" style={{ fontSize: 14 }}>
            <p style={{ marginTop: 0 }}>
              Belief propagation is <b>exact</b> on a graph with no cycles. A random sparse graph looks
              locally like a tree — its shortest cycles are long — so BP's local message-passing is very
              nearly exact, and it converges to the global maximum-likelihood answer in a handful of
              linear-time iterations.
            </p>
            <p style={{ marginBottom: 0 }}>
              Everything runs in the <b>log-likelihood</b> domain: the channel hands each bit a prior LLR
              (sign = its guess, magnitude = confidence), a bit-node just <em>sums</em> incoming beliefs,
              and a check-node combines them with the numerically-stable tanh "box-plus" rule. Increase p
              past the code's threshold and you'll see the convergence trace stall — the cliff Shannon's
              theorem predicts.
            </p>
          </div>
        </Panel>
      </div>

      <BerPanel />
    </div>
  )
}

function TannerGraph({ code, unsatChecks, flippedVars }: { code: LdpcCode; unsatChecks: Set<number>; flippedVars: Set<number> }) {
  const n = code.n
  const m = code.m
  const W = 720
  const H = 200
  const padX = 20
  const vx = (i: number) => padX + (i / (n - 1)) * (W - 2 * padX)
  const cx = (j: number) => padX + (j / (m - 1)) * (W - 2 * padX)
  const vy = H - 30
  const cy = 30

  return (
    <div style={{ overflowX: 'auto' }}>
      <svg viewBox={`0 0 ${W} ${H}`} width="100%" style={{ minWidth: 560 }}>
        {/* edges */}
        {code.checkNbrs.map((nbrs, c) =>
          nbrs.map((v) => {
            const bad = unsatChecks.has(c)
            return (
              <line
                key={`${c}-${v}`}
                x1={cx(c)}
                y1={cy}
                x2={vx(v)}
                y2={vy}
                stroke={bad ? 'var(--amber)' : 'var(--border)'}
                strokeWidth={bad ? 1.4 : 0.7}
                opacity={bad ? 0.7 : 0.35}
              />
            )
          }),
        )}
        {/* check nodes (squares) */}
        {Array.from({ length: m }, (_, c) => {
          const bad = unsatChecks.has(c)
          return (
            <g key={`c${c}`}>
              <rect x={cx(c) - 6} y={cy - 6} width={12} height={12} rx={2} fill={bad ? 'var(--amber)' : 'var(--panel-hi)'} stroke={bad ? 'var(--amber)' : 'var(--green)'} strokeWidth={1.4} />
            </g>
          )
        })}
        {/* variable nodes (circles) */}
        {Array.from({ length: n }, (_, v) => {
          const bad = flippedVars.has(v)
          const isInfo = code.infoCols.includes(v)
          return (
            <circle key={`v${v}`} cx={vx(v)} cy={vy} r={5} fill={bad ? 'var(--red)' : isInfo ? 'var(--teal)' : 'var(--panel-hi)'} stroke={bad ? 'var(--red)' : 'var(--border-hi)'} strokeWidth={1.2} />
          )
        })}
        <text x={padX} y={cy - 12} fontSize={10} fill="var(--text-dim)">checks (parity equations)</text>
        <text x={padX} y={vy + 20} fontSize={10} fill="var(--text-dim)">codeword bits · teal = message</text>
      </svg>
    </div>
  )
}

function BerPanel() {
  const [seed, setSeed] = useState(1)
  const data = useMemo(() => {
    const ps = [0.02, 0.04, 0.06, 0.08, 0.1, 0.12, 0.14]
    const small: [number, number][] = []
    const big: [number, number][] = []
    const uncoded: [number, number][] = []
    for (const p of ps) {
      uncoded.push([p, p])
      small.push([p, Math.max(berOf(LDPC_DEMO, p, seed), 1e-4)])
      big.push([p, Math.max(berOf(LDPC_BIG, p, seed + 7), 1e-4)])
    }
    return { ps, small, big, uncoded }
  }, [seed])
  return (
    <Panel
      title="BER waterfall — longer blocks, steeper cliff"
      note="Post-decode bit-error rate vs raw channel crossover p. Both LDPC curves dive below the uncoded diagonal; the longer (96,48) code has a sharper threshold — the finite-length echo of the capacity cliff. Below threshold, errors vanish; above it, BP can't keep up."
      right={<button className="btn" onClick={() => setSeed((s) => s + 1)}>Re-run trials</button>}
    >
      <LineChart
        series={[
          { label: 'uncoded (BER = p)', color: 'var(--text-dim)', points: data.uncoded, dashed: true },
          { label: 'LDPC (24,12)', color: 'var(--violet)', points: data.small },
          { label: 'LDPC (96,48)', color: 'var(--teal)', points: data.big },
        ]}
        xDomain={[0.02, 0.14]}
        yDomain={[1e-4, 1]}
        logY
        xLabel="channel crossover p"
        yLabel="bit error rate"
        xFmt={(v) => v.toFixed(2)}
        yFmt={(v) => (v >= 0.01 ? v.toFixed(2) : v.toExponential(0))}
      />
    </Panel>
  )
}

function berOf(code: LdpcCode, p: number, seed: number): number {
  const rng = new RNG(0x5eed + seed * 40503 + Math.round(p * 1000))
  const N = 120
  let ne = 0
  let nc = 0
  for (let blk = 0; blk < N; blk++) {
    const msg = Array.from({ length: code.k }, () => (rng.float() < 0.5 ? 0 : 1))
    const cw = ldpcEncode(code, msg)
    const rx = cw.map((b) => (rng.float() < p ? b ^ 1 : b))
    const dec = bpDecodeLLR(code, bscLLR(rx, p), 40)
    for (let i = 0; i < code.k; i++) {
      nc++
      if (dec.message[i] !== msg[i]) ne++
    }
    void ldpcSyndromeZero
  }
  return ne / nc
}
