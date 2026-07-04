import { useMemo, useState } from 'react'
import { PageHeader, Panel, Stat } from '../components/ui'
import { LineChart } from '../components/charts'
import {
  constructPolar,
  polarEncode,
  polarTransform,
  scDecode,
  sclDecode,
  bhattacharyyaBEC,
  appendCrc,
  CRC8,
  type PolarCode,
} from '../lib/polar'
import { RNG, awgn, ebN0dBtoEsN0 } from '../lib/channel'

// Q(x) = P(N(0,1) > x) via a rational erfc approximation (Abramowitz & Stegun
// 7.1.26) — the uncoded-BPSK reference curve for the waterfall.
function qfunc(x: number): number {
  const z = Math.abs(x) / Math.SQRT2
  const t = 1 / (1 + 0.3275911 * z)
  const y =
    1 -
    (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) *
      t *
      Math.exp(-z * z)
  const erfc = 1 - y
  const q = 0.5 * erfc
  return x < 0 ? 1 - q : q
}

export function Polar() {
  return (
    <div>
      <PageHeader
        kicker="Channel coding · the capacity-achieving code"
        title="Polar Codes · Successive Cancellation"
        lede={
          <>
            Polar codes are the first codes <em>proven</em> to reach the Shannon limit — and the
            error-correcting code inside <b>5G-NR</b>'s control channel (LDPC carries its data). The
            trick is <b>channel polarisation</b>: combine many copies of a noisy channel with a simple
            recursive transform and the synthetic per-bit channels split apart — some become nearly{' '}
            <b>perfect</b>, the rest nearly <b>useless</b>. Put your message on the good ones, freeze
            the bad ones to zero, and decode with a depth-first <b>successive-cancellation</b> pass over
            the same butterfly. Add a list and a CRC and you get the exact 5G decoder.
          </>
        }
      />
      <PolarizationPanel />
      <ButterflyPanel />
      <PipelinePanel />
      <BerPanel />
    </div>
  )
}

// --------------------------------------------------------- polarisation figure

function PolarizationPanel() {
  const [nExp, setNExp] = useState(6)
  const [eps, setEps] = useState(0.5)
  const N = 1 << nExp

  const { Z, sorted, capacity, good, mid } = useMemo(() => {
    const Z = bhattacharyyaBEC(nExp, eps)
    const cap = Array.from(Z, (z) => 1 - z) // BEC symmetric capacity = 1 − Z
    const sorted = cap.slice().sort((a, b) => a - b)
    const capacity = cap.reduce((a, b) => a + b, 0) / N
    let good = 0
    let mid = 0
    for (const c of cap) {
      if (c > 0.99) good++
      else if (c > 0.01) mid++
    }
    return { Z, sorted, capacity, good, mid }
  }, [nExp, eps, N])
  void Z

  return (
    <Panel
      title="Channel polarisation — the good channels separate from the bad"
      note="Each of the N synthetic bit-channels, sorted by capacity. On a perfectly polarised code the curve is a step: a fraction C are capacity-1 (carry data), the rest are capacity-0 (frozen). Raise N and watch the staircase sharpen toward that step — this is why polar codes reach capacity. (Binary Erasure Channel, where construction is exact.)"
    >
      <div className="row" style={{ gap: 18, marginBottom: 12, flexWrap: 'wrap' }}>
        <label className="field" style={{ minWidth: 240 }}>
          Block length N = 2^{nExp} = <b style={{ color: 'var(--text)' }}>{N}</b>
          <input type="range" min={3} max={10} step={1} value={nExp} onChange={(e) => setNExp(+e.target.value)} />
        </label>
        <label className="field" style={{ minWidth: 240 }}>
          BEC erasure ε = <b style={{ color: 'var(--text)' }}>{eps.toFixed(2)}</b> · capacity 1−ε ={' '}
          {(1 - eps).toFixed(2)}
          <input type="range" min={0.05} max={0.95} step={0.05} value={eps} onChange={(e) => setEps(+e.target.value)} />
        </label>
      </div>
      <PolarStaircase sorted={sorted} capacity={1 - eps} />
      <div className="grid grid-4" style={{ marginTop: 12 }}>
        <Stat label="Channel capacity" value={(1 - eps).toFixed(3)} sub="bits / use (the ceiling)" />
        <Stat label="Mean synthetic cap." value={capacity.toFixed(3)} accent sub="= channel cap (conserved)" />
        <Stat label="Near-perfect channels" value={good} sub={`${((good / N) * 100).toFixed(0)}% → carry data`} />
        <Stat label="Still-mixed channels" value={mid} sub={`${((mid / N) * 100).toFixed(0)}% — shrinks with N`} />
      </div>
    </Panel>
  )
}

function PolarStaircase({ sorted, capacity }: { sorted: number[]; capacity: number }) {
  const N = sorted.length
  const W = 720
  const H = 220
  const padL = 40
  const padB = 26
  const padT = 10
  const innerW = W - padL - 12
  const innerH = H - padB - padT
  const sx = (i: number) => padL + (i / (N - 1)) * innerW
  const sy = (v: number) => padT + (1 - v) * innerH
  const pts = sorted.map((v, i) => `${sx(i).toFixed(1)},${sy(v).toFixed(1)}`).join(' ')
  const cutX = padL + (1 - capacity) * innerW // fraction frozen ≈ 1 − capacity
  return (
    <div style={{ overflowX: 'auto' }}>
      <svg viewBox={`0 0 ${W} ${H}`} width="100%" style={{ minWidth: 560 }}>
        {[0, 0.25, 0.5, 0.75, 1].map((g) => (
          <g key={g}>
            <line x1={padL} x2={padL + innerW} y1={sy(g)} y2={sy(g)} stroke="var(--border)" strokeWidth={0.5} opacity={0.5} />
            <text x={padL - 6} y={sy(g) + 3} textAnchor="end" fontSize={9} fill="var(--text-dim)">
              {g}
            </text>
          </g>
        ))}
        {/* target step at capacity */}
        <line x1={cutX} x2={cutX} y1={padT} y2={padT + innerH} stroke="var(--amber)" strokeDasharray="4 4" strokeWidth={1.2} opacity={0.8} />
        <text x={cutX + 4} y={padT + 10} fontSize={9} fill="var(--amber)">
          ← freeze · data →
        </text>
        <polyline points={pts} fill="none" stroke="var(--teal)" strokeWidth={2} />
        <text x={padL} y={H - 6} fontSize={9} fill="var(--text-dim)">
          channels sorted by capacity →
        </text>
      </svg>
    </div>
  )
}

// ------------------------------------------------------------ encoder butterfly

function ButterflyPanel() {
  const N = 8
  const nExp = 3
  const code = useMemo(() => constructPolar(N, 4, { construction: 'ga', designSnrDb: 2 }), [])
  // Column-by-column XOR network: stage s (0..n) has N nodes. Edges implement the
  // in-place butterfly x[i] ^= x[i+len] used by polarTransform.
  const W = 640
  const H = 300
  const padX = 70
  const padY = 26
  const colX = (s: number) => padX + (s / nExp) * (W - 2 * padX)
  const rowY = (r: number) => padY + (r / (N - 1)) * (H - 2 * padY)

  const edges: { s: number; a: number; b: number }[] = []
  let len = 1
  const stages: number[] = []
  while (len < N) {
    stages.push(len)
    len <<= 1
  }
  stages.forEach((L, si) => {
    for (let i = 0; i < N; i += L << 1) {
      for (let j = 0; j < L; j++) {
        edges.push({ s: si, a: i + j, b: i + j + L })
      }
    }
  })

  return (
    <Panel
      title="The encoder is a butterfly — an XOR network shaped like an FFT"
      note="A (8,4) code. The message rides the 4 most reliable inputs (teal u-nodes); the other 4 are frozen to 0 (grey). Each ⊕ combines two wires with the kernel [[1,0],[1,1]]; three stages of them realise G₃ = F⊗³, turning u on the left into the codeword x on the right — O(N log N), no matrix."
    >
      <div style={{ overflowX: 'auto' }}>
        <svg viewBox={`0 0 ${W} ${H}`} width="100%" style={{ minWidth: 560 }}>
          {/* horizontal wires */}
          {Array.from({ length: N }, (_, r) => (
            <line key={`w${r}`} x1={colX(0)} x2={colX(nExp)} y1={rowY(r)} y2={rowY(r)} stroke="var(--border)" strokeWidth={1} opacity={0.5} />
          ))}
          {/* butterfly edges (vertical XOR couplings) */}
          {edges.map((e, i) => {
            const x = colX(e.s + 1)
            return (
              <g key={`e${i}`}>
                <line x1={x} x2={x} y1={rowY(e.a)} y2={rowY(e.b)} stroke="var(--violet)" strokeWidth={1.3} opacity={0.7} />
                <circle cx={x} cy={rowY(e.a)} r={4.5} fill="var(--panel-2)" stroke="var(--violet)" strokeWidth={1.4} />
                <text x={x} y={rowY(e.a) + 3.2} textAnchor="middle" fontSize={9} fill="var(--violet)">
                  ⊕
                </text>
                <circle cx={x} cy={rowY(e.b)} r={2.4} fill="var(--violet)" />
              </g>
            )
          })}
          {/* input u nodes */}
          {Array.from({ length: N }, (_, r) => {
            const info = code.frozen[r] === 0
            return (
              <g key={`u${r}`}>
                <circle cx={colX(0)} cy={rowY(r)} r={8} fill={info ? 'var(--teal)' : 'var(--panel-hi)'} stroke={info ? 'var(--teal)' : 'var(--border-hi)'} strokeWidth={1.4} />
                <text x={colX(0) - 26} y={rowY(r) + 3.5} fontSize={11} fill="var(--text-mid)" fontFamily="var(--mono)">
                  u{r}
                </text>
                {!info && (
                  <text x={colX(0)} y={rowY(r) + 3.2} textAnchor="middle" fontSize={9} fill="var(--text-dim)">
                    0
                  </text>
                )}
              </g>
            )
          })}
          {/* output x nodes */}
          {Array.from({ length: N }, (_, r) => (
            <g key={`x${r}`}>
              <circle cx={colX(nExp)} cy={rowY(r)} r={6} fill="var(--amber)" opacity={0.9} />
              <text x={colX(nExp) + 22} y={rowY(r) + 3.5} fontSize={11} fill="var(--text-mid)" fontFamily="var(--mono)">
                x{r}
              </text>
            </g>
          ))}
        </svg>
      </div>
      <div className="chip-row" style={{ marginTop: 8 }}>
        <span className="tag" style={{ color: 'var(--teal)', borderColor: 'var(--teal)' }}>info bit (u)</span>
        <span className="tag" style={{ color: 'var(--text-dim)', borderColor: 'var(--border-hi)' }}>frozen = 0</span>
        <span className="tag" style={{ color: 'var(--violet)', borderColor: 'var(--violet)' }}>⊕ XOR</span>
        <span className="tag" style={{ color: 'var(--amber)', borderColor: 'var(--amber)' }}>codeword (x)</span>
      </div>
    </Panel>
  )
}

// ---------------------------------------------------------- live decode pipeline

const N_CHOICES = [64, 128, 256]

function PipelinePanel() {
  const [nSel, setNSel] = useState(128)
  const [rate, setRate] = useState(0.5)
  const [ebno, setEbno] = useState(2.0)
  const [designSnr, setDesignSnr] = useState(2.5)
  const [L, setL] = useState(8)
  const [seed, setSeed] = useState(1)

  const K = Math.max(9, Math.round(nSel * rate))
  const code = useMemo(
    () => constructPolar(nSel, K, { construction: 'ga', designSnrDb: designSnr }),
    [nSel, K, designSnr],
  )

  const run = useMemo(() => {
    const rng = new RNG(0x9e37 + seed * 2654435761 + nSel * 131 + K)
    const payloadLen = K - CRC8.width
    const payload = Array.from({ length: payloadLen }, () => (rng.float() < 0.5 ? 0 : 1))
    const info = appendCrc(payload, CRC8)
    const cw = polarEncode(code, info)
    const esno = ebN0dBtoEsN0(ebno, K / nSel)
    const { llr, hard, flipped } = awgn(Array.from(cw), esno, rng)
    const sc = scDecode(code, llr)
    const scl = sclDecode(code, llr, L)
    const ca = sclDecode(code, llr, L, CRC8)
    const scOk = sc.message.slice(0, payloadLen).join('') === payload.join('')
    const sclOk = scl.message.slice(0, payloadLen).join('') === payload.join('')
    const caOk = ca.message.slice(0, payloadLen).join('') === payload.join('')
    return { cw, hard, flipped, payload, scOk, sclOk, caOk, caPassed: ca.crcPassed, channelErrors: flipped.length }
  }, [code, ebno, L, seed, nSel, K])

  const rateActual = K / nSel

  return (
    <Panel
      title="Encode → BI-AWGN channel → decode, live"
      note="A random payload is CRC-8-appended, polar-encoded, fired through a Gaussian channel at the chosen Eb/N0, and decoded three ways: plain SC, SC-List, and CRC-aided SC-List (the 5G decoder). Drop the SNR and watch SC fall first, the list hold on, and the CRC rescue the survivor the list already contains."
      right={<button className="btn" onClick={() => setSeed((s) => s + 1)}>Re-roll noise</button>}
    >
      <div className="row" style={{ gap: 18, marginBottom: 12, flexWrap: 'wrap' }}>
        <label className="field">
          Block N
          <select className="btn" value={nSel} onChange={(e) => setNSel(+e.target.value)} style={{ marginTop: 4 }}>
            {N_CHOICES.map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>
        </label>
        <label className="field" style={{ minWidth: 200 }}>
          Rate K/N ≈ <b style={{ color: 'var(--text)' }}>{rateActual.toFixed(2)}</b> (K={K})
          <input type="range" min={0.25} max={0.75} step={0.05} value={rate} onChange={(e) => setRate(+e.target.value)} />
        </label>
        <label className="field" style={{ minWidth: 220 }}>
          Channel Eb/N0 = <b style={{ color: 'var(--text)' }}>{ebno.toFixed(1)} dB</b>
          <input type="range" min={0} max={5} step={0.25} value={ebno} onChange={(e) => setEbno(+e.target.value)} />
        </label>
        <label className="field" style={{ minWidth: 200 }}>
          Design Eb/N0 = <b style={{ color: 'var(--text)' }}>{designSnr.toFixed(1)} dB</b>
          <input type="range" min={0} max={5} step={0.5} value={designSnr} onChange={(e) => setDesignSnr(+e.target.value)} />
        </label>
        <label className="field" style={{ minWidth: 160 }}>
          List size L = <b style={{ color: 'var(--text)' }}>{L}</b>
          <input type="range" min={1} max={16} step={1} value={L} onChange={(e) => setL(+e.target.value)} />
        </label>
      </div>

      <BitStrip cw={run.cw} flipped={new Set(run.flipped)} />
      <div className="grid grid-4" style={{ marginTop: 12 }}>
        <Stat label="Channel bit errors" value={run.channelErrors} accent sub={`${((run.channelErrors / nSel) * 100).toFixed(1)}% of ${nSel} bits`} />
        <DecodeStat label="SC" ok={run.scOk} />
        <DecodeStat label={`SCL · L=${L}`} ok={run.sclOk} />
        <DecodeStat label="CA-SCL (5G)" ok={run.caOk} sub={run.caPassed ? 'CRC ✓ survivor' : 'no CRC-valid path'} />
      </div>
    </Panel>
  )
}

function DecodeStat({ label, ok, sub }: { label: string; ok: boolean; sub?: string }) {
  return (
    <div className={`stat${ok ? '' : ' accent'}`}>
      <div className="stat-label">{label}</div>
      <div className="stat-value" style={{ color: ok ? 'var(--green)' : 'var(--red)' }}>
        {ok ? 'recovered ✓' : 'failed ✗'}
      </div>
      {sub && <div className="stat-sub">{sub}</div>}
    </div>
  )
}

function BitStrip({ cw, flipped }: { cw: Uint8Array; flipped: Set<number> }) {
  const N = cw.length
  const cols = Math.min(N, 64)
  const cell = 680 / cols
  const rows = Math.ceil(N / cols)
  const H = rows * (cell + 2)
  return (
    <div style={{ overflowX: 'auto' }}>
      <svg viewBox={`0 0 680 ${H}`} width="100%" style={{ minWidth: 480 }}>
        {Array.from({ length: N }, (_, i) => {
          const r = Math.floor(i / cols)
          const c = i % cols
          const bad = flipped.has(i)
          return (
            <rect
              key={i}
              x={c * cell + 1}
              y={r * (cell + 2)}
              width={cell - 1.5}
              height={cell - 1.5}
              rx={1.5}
              fill={bad ? 'var(--red)' : cw[i] ? 'var(--blue)' : 'var(--panel-2)'}
              opacity={bad ? 0.95 : 0.85}
            />
          )
        })}
      </svg>
      <div className="chip-row" style={{ marginTop: 6 }}>
        <span className="muted" style={{ fontSize: 11 }}>codeword bits · </span>
        <span className="tag" style={{ color: 'var(--red)', borderColor: 'var(--red)' }}>flipped by channel</span>
      </div>
    </div>
  )
}

// ------------------------------------------------------------- BLER waterfall

function BerPanel() {
  const [seed, setSeed] = useState(1)
  const data = useMemo(() => runWaterfall(seed), [seed])
  return (
    <Panel
      title="Block-error waterfall — the list and the CRC each buy dB"
      note="Frame-error rate vs Eb/N0 for a (128,64) polar code, decoded three ways, against the uncoded-BPSK reference. Plain SC already dives below uncoded; SC-List (L=8) picks up ~0.5 dB by keeping runners-up; CRC-aided SCL — the 5G decoder — steepens the cliff by letting the CRC choose among them. This gap is exactly why 5G uses CA-SCL."
      right={<button className="btn" onClick={() => setSeed((s) => s + 1)}>Re-run trials</button>}
    >
      <LineChart
        series={[
          { label: 'uncoded BPSK', color: 'var(--text-dim)', points: data.uncoded, dashed: true },
          { label: 'SC', color: 'var(--amber)', points: data.sc },
          { label: 'SCL · L=8', color: 'var(--violet)', points: data.scl },
          { label: 'CA-SCL · L=8 (5G)', color: 'var(--teal)', points: data.ca },
        ]}
        xDomain={[data.xs[0], data.xs[data.xs.length - 1]]}
        yDomain={[1e-3, 1]}
        logY
        xLabel="Eb/N0 (dB)"
        yLabel="block error rate"
        xFmt={(v) => v.toFixed(1)}
        yFmt={(v) => (v >= 0.01 ? v.toFixed(2) : v.toExponential(0))}
      />
    </Panel>
  )
}

function runWaterfall(seed: number) {
  const N = 128
  const K = 64
  const code = constructPolar(N, K, { construction: 'ga', designSnrDb: 2.5 })
  const payloadLen = K - CRC8.width
  const xs = [0.5, 1, 1.5, 2, 2.5, 3, 3.5]
  const T = 140
  const sc: [number, number][] = []
  const scl: [number, number][] = []
  const ca: [number, number][] = []
  const uncoded: [number, number][] = []
  for (const ebno of xs) {
    const rng = new RNG(0x51ed + seed * 40503 + Math.round(ebno * 100))
    const esno = ebN0dBtoEsN0(ebno, K / N)
    let scErr = 0
    let sclErr = 0
    let caErr = 0
    for (let t = 0; t < T; t++) {
      const payload = Array.from({ length: payloadLen }, () => (rng.float() < 0.5 ? 0 : 1))
      const info = appendCrc(payload, CRC8)
      const cw = polarEncode(code, info)
      const { llr } = awgn(Array.from(cw), esno, rng)
      if (scDecode(code, llr).message.slice(0, payloadLen).join('') !== payload.join('')) scErr++
      if (sclDecode(code, llr, 8).message.slice(0, payloadLen).join('') !== payload.join('')) sclErr++
      if (sclDecode(code, llr, 8, CRC8).message.slice(0, payloadLen).join('') !== payload.join('')) caErr++
    }
    sc.push([ebno, Math.max(scErr / T, 5e-4)])
    scl.push([ebno, Math.max(sclErr / T, 5e-4)])
    ca.push([ebno, Math.max(caErr / T, 5e-4)])
    // uncoded block (K bits) error: 1 − (1 − p)^K, p = Q(sqrt(2·Eb/N0))
    const p = qfunc(Math.sqrt(2 * Math.pow(10, ebno / 10)))
    uncoded.push([ebno, Math.max(1 - Math.pow(1 - p, K), 5e-4)])
  }
  return { xs, sc, scl, ca, uncoded }
}

export type { PolarCode }
void polarTransform
