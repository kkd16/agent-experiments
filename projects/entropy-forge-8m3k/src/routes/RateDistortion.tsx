import { useMemo, useState } from 'react'
import { PageHeader, Panel, Stat, SectionTitle } from '../components/ui'
import { LineChart, HBarChart, type Series } from '../components/charts'
import {
  channelCapacity,
  bscMatrix,
  becMatrix,
  zChannelMatrix,
  zChannelCapacity,
  noiselessMatrix,
  typewriterMatrix,
  rdCurve,
  bernoulliSource,
  hammingDistortion,
  binEntropy,
  bernoulliRD,
  gaussianRD,
  discreteGaussian,
  type CapacityResult,
} from '../lib/blahutArimoto'
import {
  lloydMax,
  uniformQuantizer,
  highRateSlopeDb,
  DENSITIES,
  lbg,
  sampleMixture,
  QRng,
  type Density,
  type LloydResult,
  type Vec2,
} from '../lib/quantize'
import { waterFill, reverseWaterFillTheta, gaussianVectorRD } from '../lib/waterfilling'

// ═══════════════════════════════════════════════════════════════════════════
// Section A — Blahut–Arimoto channel capacity
// ═══════════════════════════════════════════════════════════════════════════

type ChannelId = 'bsc' | 'bec' | 'z' | 'noiseless' | 'typewriter'

const CHANNELS: { id: ChannelId; name: string; hasParam: boolean; paramLabel: string }[] = [
  { id: 'bsc', name: 'BSC (flip p)', hasParam: true, paramLabel: 'crossover p' },
  { id: 'bec', name: 'BEC (erase ε)', hasParam: true, paramLabel: 'erasure ε' },
  { id: 'z', name: 'Z-channel', hasParam: true, paramLabel: 'decay p (1→0)' },
  { id: 'noiseless', name: 'Noiseless (4-ary)', hasParam: false, paramLabel: '' },
  { id: 'typewriter', name: 'Noisy typewriter (6)', hasParam: false, paramLabel: '' },
]

function buildChannel(id: ChannelId, param: number): { Q: number[][]; closed: number | null; xLabels: string[]; yLabels: string[]; note: string } {
  switch (id) {
    case 'bsc':
      return { Q: bscMatrix(param), closed: 1 - binEntropy(param), xLabels: ['0', '1'], yLabels: ['0', '1'], note: 'C = 1 − H(p). Symmetric ⇒ the optimal input is uniform.' }
    case 'bec':
      return { Q: becMatrix(param), closed: 1 - param, xLabels: ['0', '1'], yLabels: ['0', '?', '1'], note: 'C = 1 − ε. The middle output column is the erasure symbol ‘?’.' }
    case 'z':
      return { Q: zChannelMatrix(param), closed: zChannelCapacity(param), xLabels: ['0', '1'], yLabels: ['0', '1'], note: 'Asymmetric: a 0 is safe, a 1 decays. The optimal input is NOT uniform — BA finds the skew.' }
    case 'noiseless':
      return { Q: noiselessMatrix(4), closed: 2, xLabels: ['a', 'b', 'c', 'd'], yLabels: ['a', 'b', 'c', 'd'], note: 'A perfect 4-symbol channel. C = log₂4 = 2 bits, uniform input.' }
    case 'typewriter':
      return { Q: typewriterMatrix(6), closed: Math.log2(3), xLabels: ['0', '1', '2', '3', '4', '5'], yLabels: ['0', '1', '2', '3', '4', '5'], note: 'Shannon’s example: each symbol → itself or its neighbour. BA rediscovers the every-other-symbol code, C = log₂3.' }
  }
}

function QHeatMap({ Q, xLabels, yLabels }: { Q: number[][]; xLabels: string[]; yLabels: string[] }) {
  const nX = Q.length
  const nY = Q[0].length
  const cell = 34
  const padL = 26
  const padT = 20
  const W = padL + nY * cell + 8
  const H = padT + nX * cell + 8
  return (
    <div style={{ overflowX: 'auto' }}>
      <svg viewBox={`0 0 ${W} ${H}`} width={W} style={{ maxWidth: '100%' }} role="img" aria-label="channel transition matrix">
        {yLabels.map((l, j) => (
          <text key={`yl${j}`} x={padL + j * cell + cell / 2} y={14} textAnchor="middle" fontSize={11} fill="var(--text-dim)" fontFamily="var(--mono)">{l}</text>
        ))}
        {Q.map((row, i) => (
          <g key={i}>
            <text x={padL - 8} y={padT + i * cell + cell / 2 + 4} textAnchor="end" fontSize={11} fill="var(--text-dim)" fontFamily="var(--mono)">{xLabels[i]}</text>
            {row.map((v, j) => {
              const a = 0.12 + 0.85 * v
              return (
                <g key={j}>
                  <rect x={padL + j * cell} y={padT + i * cell} width={cell - 3} height={cell - 3} rx={4} fill="var(--teal)" opacity={v === 0 ? 0.06 : a} />
                  <text x={padL + j * cell + (cell - 3) / 2} y={padT + i * cell + cell / 2 + 3} textAnchor="middle" fontSize={10} fill={v > 0.55 ? '#0a0d13' : 'var(--text-mid)'} fontFamily="var(--mono)">
                    {v === 0 ? '·' : v.toFixed(2)}
                  </text>
                </g>
              )
            })}
          </g>
        ))}
      </svg>
    </div>
  )
}

function CapacitySection() {
  const [chan, setChan] = useState<ChannelId>('z')
  const [param, setParam] = useState(0.3)
  const def = CHANNELS.find((c) => c.id === chan)!
  const { Q, closed, xLabels, yLabels, note } = useMemo(() => buildChannel(chan, param), [chan, param])
  const res: CapacityResult = useMemo(() => channelCapacity(Q), [Q])

  const convSeries: Series[] = [
    { label: 'lower bound I_L (achievable)', color: 'var(--teal)', points: res.trace.map((t) => [t.iter, t.lower]) },
    { label: 'upper bound I_U = maxₓ Dₓ', color: 'var(--amber)', points: res.trace.map((t) => [t.iter, t.upper]), dashed: true },
  ]
  const maxIter = Math.max(1, res.trace.length - 1)
  const yTop = Math.max(closed ?? 0, ...res.trace.map((t) => t.upper)) * 1.1 || 1

  const inputBars = res.inputDist.map((v, i) => ({ label: `p(${xLabels[i]})`, value: v, color: 'var(--violet)' }))

  return (
    <Panel
      title="A · Channel capacity by Blahut–Arimoto"
      note="Capacity is a MAX of mutual information over input distributions. Alternating minimisation climbs to it and certifies the answer by squeezing a lower and upper bound together."
    >
      <div className="row" style={{ gap: 16, marginBottom: 14, flexWrap: 'wrap', alignItems: 'flex-end' }}>
        <div className="chip-row">
          {CHANNELS.map((c) => (
            <button
              key={c.id}
              className={`chip${chan === c.id ? ' active' : ''}`}
              onClick={() => {
                setChan(c.id)
                if (c.id === 'bsc') setParam(0.1)
                else if (c.id === 'bec') setParam(0.3)
                else if (c.id === 'z') setParam(0.3)
              }}
            >
              {c.name}
            </button>
          ))}
        </div>
        {def.hasParam && (
          <label className="field" style={{ minWidth: 230 }}>
            {def.paramLabel}: <b style={{ color: 'var(--text)' }}>{param.toFixed(2)}</b>
            <input type="range" min={0} max={chan === 'bec' ? 0.95 : 0.5} step={0.01} value={param} onChange={(e) => setParam(+e.target.value)} />
          </label>
        )}
      </div>

      <div className="grid grid-4" style={{ marginBottom: 14 }}>
        <Stat label="Capacity C (Blahut–Arimoto)" value={res.C.toFixed(4)} unit="bits" accent />
        <Stat label="Closed form" value={closed === null ? '—' : closed.toFixed(4)} unit={closed === null ? '' : 'bits'} sub={closed === null ? 'no simple form' : Math.abs(closed - res.C) < 1e-3 ? '✓ agrees' : 'converging'} />
        <Stat label="Certified gap I_U − I_L" value={res.gap.toExponential(1)} sub="squeezes to 0" />
        <Stat label="Iterations" value={res.iterations} sub="to tolerance" />
      </div>

      <div className="grid grid-2">
        <div>
          <SectionTitle>Transition matrix Q(y | x)</SectionTitle>
          <QHeatMap Q={Q} xLabels={xLabels} yLabels={yLabels} />
          <div className="panel-note" style={{ marginTop: 8 }}>{note}</div>
        </div>
        <div>
          <SectionTitle>Capacity-achieving input p*(x)</SectionTitle>
          <HBarChart bars={inputBars} max={1} height={22} valueFmt={(v) => v.toFixed(3)} />
          <div className="panel-note" style={{ marginTop: 8 }}>
            The input law that squeezes the most information through this channel. Symmetric channels want it uniform; the Z-channel and typewriter want it skewed — and BA discovers that with no hint.
          </div>
        </div>
      </div>

      <SectionTitle>Convergence — the bound sandwich</SectionTitle>
      <LineChart
        series={convSeries}
        xDomain={[0, maxIter]}
        yDomain={[0, yTop]}
        xLabel="iteration"
        yLabel="bits / use"
        height={220}
        xTicks={Math.min(6, maxIter)}
        xFmt={(v) => v.toFixed(0)}
        markers={closed !== null ? [{ y: closed, label: `C = ${closed.toFixed(3)}`, color: 'var(--green)' }] : []}
      />
      <div className="panel-note" style={{ marginTop: 6 }}>
        The lower bound is the current mutual information (always achievable); the upper bound is maxₓ D(Q(·|x)‖p_Y). At the optimum the KKT conditions force every input’s divergence to equal C, so the two bounds collide — that collision is the stopping test, not a fixed iteration count.
      </div>
    </Panel>
  )
}

// ═══════════════════════════════════════════════════════════════════════════
// Section B — The rate–distortion function R(D)
// ═══════════════════════════════════════════════════════════════════════════

type SourceId = 'bernoulli' | 'gaussian'

function RateDistortionSection() {
  const [src, setSrc] = useState<SourceId>('bernoulli')
  const [p, setP] = useState(0.5)

  const data = useMemo(() => {
    if (src === 'bernoulli') {
      const source = bernoulliSource(p)
      const d = hammingDistortion(2)
      const curve = rdCurve(source, d, { points: 70, sMax: 40 })
      const H = binEntropy(p)
      const Dmax = Math.min(p, 1 - p)
      const closed: [number, number][] = []
      for (let i = 0; i <= 80; i++) {
        const D = (Dmax * i) / 80
        closed.push([D, bernoulliRD(p, D)])
      }
      return { curve, closed, H, Dmax, xDomain: [0, Dmax * 1.05] as [number, number], distLabel: 'Hamming distortion D (bit-error rate)', unit: 'bits/sym' }
    }
    // Gaussian, unit variance, squared error, discretised.
    const { p: gp, d } = discreteGaussian(1, 71, 4)
    const curve = rdCurve(gp, d, { points: 70, sMax: 160 })
    const H = Infinity
    const Dmax = 1
    const closed: [number, number][] = []
    for (let i = 1; i <= 80; i++) {
      const D = (Dmax * i) / 80
      closed.push([D, gaussianRD(1, D)])
    }
    return { curve, closed, H, Dmax, xDomain: [0, 1.02] as [number, number], distLabel: 'squared-error distortion D (σ² = 1)', unit: 'bits/sym' }
  }, [src, p])

  const yTop = Math.max(1, ...data.curve.map((c) => c.R), ...data.closed.map((c) => c[1]).filter((v) => isFinite(v)))
  const series: Series[] = [
    { label: 'R(D) — Blahut–Arimoto', color: 'var(--teal)', points: data.curve.map((c) => [c.D, c.R]) },
    { label: 'closed form', color: 'var(--amber)', points: data.closed.filter((c) => isFinite(c[1])), dashed: true },
  ]

  return (
    <Panel
      title="B · The rate–distortion function R(D)"
      note="R(D) is the dual of capacity — a MIN of mutual information over test channels: the fewest bits/symbol that can describe the source within an allowed distortion D. Sweeping the Lagrange slope traces the whole trade-off."
    >
      <div className="row" style={{ gap: 16, marginBottom: 14, flexWrap: 'wrap', alignItems: 'flex-end' }}>
        <div className="chip-row">
          <button className={`chip${src === 'bernoulli' ? ' active' : ''}`} onClick={() => setSrc('bernoulli')}>Bernoulli(p) · Hamming</button>
          <button className={`chip${src === 'gaussian' ? ' active' : ''}`} onClick={() => setSrc('gaussian')}>Gaussian · squared error</button>
        </div>
        {src === 'bernoulli' && (
          <label className="field" style={{ minWidth: 230 }}>
            source bias p: <b style={{ color: 'var(--text)' }}>{p.toFixed(2)}</b>
            <input type="range" min={0.02} max={0.98} step={0.01} value={p} onChange={(e) => setP(+e.target.value)} />
          </label>
        )}
      </div>

      <div className="grid grid-4" style={{ marginBottom: 14 }}>
        <Stat label="R(0) — lossless corner" value={isFinite(data.H) ? data.H.toFixed(3) : '∞'} unit={isFinite(data.H) ? 'bits' : ''} sub={src === 'bernoulli' ? '= H(p), the entropy floor' : 'continuous source'} accent />
        <Stat label="D_max — free corner" value={data.Dmax.toFixed(3)} sub="R hits 0: send nothing" />
        <Stat label="curve points" value={data.curve.length} sub="each a full BA solve" />
        <Stat label="max |slope| swept" value={src === 'gaussian' ? 160 : 40} sub="→ approaches D_min" />
      </div>

      <LineChart
        series={series}
        xDomain={data.xDomain}
        yDomain={[0, yTop * 1.05]}
        xLabel={data.distLabel}
        yLabel="rate R (bits/symbol)"
        height={260}
        xFmt={(v) => v.toFixed(2)}
        markers={
          src === 'bernoulli'
            ? [
                { y: data.H, label: `H(p) = ${data.H.toFixed(3)}`, color: 'var(--green)' },
                { x: data.Dmax, label: `D_max = ${data.Dmax.toFixed(2)}`, color: 'var(--violet)' },
              ]
            : [{ x: 1, label: 'D = σ²', color: 'var(--violet)' }]
        }
      />
      <div className="panel-note" style={{ marginTop: 6 }}>
        {src === 'bernoulli' ? (
          <>The numerical BA curve lands exactly on the textbook <code>R(D) = H(p) − H(D)</code> — a source coding limit computed with no formula, only alternating minimisation. At <code>D = 0</code> it meets the entropy floor H(p); at <code>D = min(p,1−p)</code> it falls to zero, because you can always guess the majority symbol and be wrong only that often for free.</>
        ) : (
          <>The discretised Gaussian traces the celebrated <code>R(D) = ½·log₂(σ²/D)</code> — every halving of allowed distortion costs exactly ½ bit. This is the bound the Lloyd–Max quantiser below is measured against.</>
        )}
      </div>
    </Panel>
  )
}

// ═══════════════════════════════════════════════════════════════════════════
// Section C — Optimal scalar quantization (Lloyd–Max)
// ═══════════════════════════════════════════════════════════════════════════

function QuantizerStaircase({ density, res }: { density: Density; res: LloydResult }) {
  const def = DENSITIES[density]
  const L = Math.min(def.span, 4.2)
  const W = 680
  const Hpx = 260
  const padL = 44
  const padB = 30
  const padT = 10
  const padR = 12
  const innerW = W - padL - padR
  const innerH = Hpx - padB - padT
  const yLo = -L
  const yHi = L
  const sx = (x: number) => padL + ((x - yLo) / (yHi - yLo)) * innerW
  const sy = (y: number) => padT + (1 - (y - yLo) / (yHi - yLo)) * innerH

  // The staircase Q(x): flat at each level between boundaries.
  const bnds = [yLo, ...res.boundaries.filter((b) => b > yLo && b < yHi), yHi]
  const steps: string[] = []
  for (let k = 0; k < res.levels.length; k++) {
    const x0 = k === 0 ? yLo : res.boundaries[k - 1]
    const x1 = k === res.levels.length - 1 ? yHi : res.boundaries[k]
    if (x1 < yLo || x0 > yHi) continue
    const cx0 = Math.max(x0, yLo)
    const cx1 = Math.min(x1, yHi)
    const y = res.levels[k]
    steps.push(`M ${sx(cx0).toFixed(1)} ${sy(y).toFixed(1)} L ${sx(cx1).toFixed(1)} ${sy(y).toFixed(1)}`)
  }

  // pdf silhouette (scaled to fit the lower part) for context.
  const pdfPts: string[] = []
  const pdfMax = def.pdf(0) || 1
  for (let i = 0; i <= 120; i++) {
    const x = yLo + ((yHi - yLo) * i) / 120
    const v = def.pdf(x) / pdfMax
    const py = padT + innerH - v * (innerH * 0.32)
    pdfPts.push(`${i === 0 ? 'M' : 'L'} ${sx(x).toFixed(1)} ${py.toFixed(1)}`)
  }

  return (
    <div style={{ overflowX: 'auto' }}>
      <svg viewBox={`0 0 ${W} ${Hpx}`} width="100%" style={{ minWidth: 480 }} role="img" aria-label="quantiser transfer function">
        {/* identity line y=x for reference */}
        <line x1={sx(yLo)} y1={sy(yLo)} x2={sx(yHi)} y2={sy(yHi)} stroke="var(--border-hi)" strokeDasharray="3 4" strokeWidth={1} opacity={0.5} />
        {/* axes */}
        <line x1={padL} y1={sy(0)} x2={W - padR} y2={sy(0)} stroke="var(--border)" strokeWidth={1} />
        <line x1={sx(0)} y1={padT} x2={sx(0)} y2={Hpx - padB} stroke="var(--border)" strokeWidth={1} />
        {/* pdf silhouette */}
        <path d={pdfPts.join(' ')} fill="none" stroke="var(--blue)" strokeWidth={1.4} opacity={0.5} />
        {/* decision boundaries */}
        {bnds.slice(1, -1).map((b, i) => (
          <line key={i} x1={sx(b)} y1={padT} x2={sx(b)} y2={Hpx - padB} stroke="var(--amber)" strokeDasharray="2 3" strokeWidth={1} opacity={0.55} />
        ))}
        {/* reconstruction levels (horizontal ticks) */}
        {res.levels.map((y, i) => (
          <line key={`lv${i}`} x1={padL} y1={sy(y)} x2={W - padR} y2={sy(y)} stroke="var(--violet)" strokeWidth={0.6} opacity={0.22} />
        ))}
        {/* the staircase */}
        {steps.map((d, i) => (
          <path key={`st${i}`} d={d} fill="none" stroke="var(--teal)" strokeWidth={2.4} />
        ))}
        {res.levels.map((y, i) => (
          <circle key={`c${i}`} cx={sx(Math.max(yLo, Math.min(yHi, y)))} cy={sy(y)} r={2.6} fill="var(--teal)" />
        ))}
        {/* axis labels */}
        <text x={W - padR} y={sy(0) - 6} textAnchor="end" fontSize={10} fill="var(--text-dim)">input x</text>
        <text x={sx(0) + 6} y={padT + 10} fontSize={10} fill="var(--text-dim)">Q(x)</text>
      </svg>
    </div>
  )
}

function ScalarQuantizerSection() {
  const [density, setDensity] = useState<Density>('gaussian')
  const [N, setN] = useState(8)
  const res = useMemo(() => lloydMax(DENSITIES[density], N), [density, N])
  const uniD = useMemo(() => uniformQuantizer(DENSITIES[density], N, 4), [density, N])
  const gainDb = 10 * Math.log10(uniD / res.distortion)

  // SNR-vs-rate: Lloyd, uniform, and the R(D) bound (Gaussian) for N=2..32.
  const rateCurve = useMemo(() => {
    const lloyd: [number, number][] = []
    const uni: [number, number][] = []
    const bound: [number, number][] = []
    const hi: [number, number][] = []
    for (let n = 2; n <= 32; n++) {
      const R = Math.log2(n)
      const lr = lloydMax(DENSITIES[density], n, { grid: 4000 })
      lloyd.push([R, lr.snrDb])
      uni.push([R, 10 * Math.log10(1 / uniformQuantizer(DENSITIES[density], n, 4))])
      // R(D) bound: for the Gaussian, D(R) = σ²·2^{−2R} ⇒ SNR = 6.02·R.
      bound.push([R, 6.0206 * R])
      hi.push([R, highRateSlopeDb(R, density)])
    }
    return { lloyd, uni, bound, hi }
  }, [density])

  const rateSeries: Series[] = [
    { label: 'Lloyd–Max (optimal)', color: 'var(--teal)', points: rateCurve.lloyd },
    { label: 'uniform quantiser', color: 'var(--red)', points: rateCurve.uni, dashed: true },
    { label: 'high-rate asymptote 6.02R+c', color: 'var(--violet)', points: rateCurve.hi, dashed: true },
    { label: 'R(D) bound 6.02R (Gaussian)', color: 'var(--green)', points: rateCurve.bound, dashed: true },
  ]

  return (
    <Panel
      title="C · Optimal scalar quantisation — Lloyd–Max"
      note="The constructive side. A quantiser spends the bits R(D) promises. Lloyd's algorithm alternates the two optimality conditions — nearest-neighbour cells, centroid levels — until it lands on the best fixed-rate scalar quantiser for the source. It is exactly what JPEG does to each DCT coefficient."
    >
      <div className="row" style={{ gap: 16, marginBottom: 14, flexWrap: 'wrap', alignItems: 'flex-end' }}>
        <div className="chip-row">
          {(['gaussian', 'laplacian', 'uniform'] as Density[]).map((d) => (
            <button key={d} className={`chip${density === d ? ' active' : ''}`} onClick={() => setDensity(d)}>{DENSITIES[d].label}</button>
          ))}
        </div>
        <label className="field" style={{ minWidth: 230 }}>
          levels N = <b style={{ color: 'var(--text)' }}>{N}</b> (rate {Math.log2(N).toFixed(2)} bits)
          <input type="range" min={2} max={32} step={1} value={N} onChange={(e) => setN(+e.target.value)} />
        </label>
      </div>

      <div className="grid grid-4" style={{ marginBottom: 14 }}>
        <Stat label="Distortion D (MSE)" value={res.distortion.toFixed(4)} accent sub={`SNR ${res.snrDb.toFixed(2)} dB`} />
        <Stat label="Fixed rate" value={res.rateFixed.toFixed(2)} unit="bits" sub={`log₂${N}, indices sent raw`} />
        <Stat label="Output entropy H" value={res.entropy.toFixed(3)} unit="bits" sub="rate if indices entropy-coded" />
        <Stat label="Gain over uniform" value={`${gainDb >= 0 ? '+' : ''}${gainDb.toFixed(2)}`} unit="dB" sub={density === 'uniform' ? 'uniform is already optimal' : 'Lloyd–Max advantage'} />
      </div>

      <SectionTitle>Quantiser transfer function Q(x)</SectionTitle>
      <QuantizerStaircase density={density} res={res} />
      <div className="panel-note" style={{ marginTop: 6 }}>
        Teal is the staircase the quantiser applies; the blue silhouette is the source density; amber dashes are the decision boundaries, violet the reconstruction levels. Notice the levels crowd toward the peak of the density — Lloyd–Max puts resolution where the probability is, the whole point of a non-uniform quantiser.
      </div>

      <SectionTitle>Fidelity vs rate — the operational R–D against the bound</SectionTitle>
      <LineChart
        series={rateSeries}
        xDomain={[1, 5]}
        yDomain={[0, Math.max(30, ...rateCurve.lloyd.map((p) => p[1])) * 1.05]}
        xLabel="rate R (bits/sample)"
        yLabel="SNR (dB)"
        height={240}
        xFmt={(v) => v.toFixed(1)}
        yFmt={(v) => v.toFixed(0)}
      />
      <div className="panel-note" style={{ marginTop: 6 }}>
        Every extra bit buys ≈ 6.02 dB — the famous “6 dB per bit”. The Lloyd–Max curve rides parallel to and below the Gaussian R(D) bound; the persistent gap (≈ 1.53 dB for the Gaussian, the “space-filling loss”) is exactly what a VECTOR quantiser recovers by quantising several samples jointly — Section D. Entropy-coding the indices (output entropy H above) claws back part of the rate too.
      </div>
    </Panel>
  )
}

// ═══════════════════════════════════════════════════════════════════════════
// Section D — Vector quantization (LBG)
// ═══════════════════════════════════════════════════════════════════════════

function VectorScatter({ data, codebook, assign }: { data: Vec2[]; codebook: Vec2[]; assign: number[] }) {
  const W = 400
  const Hpx = 400
  const pad = 16
  const ext = 4
  const sx = (x: number) => pad + ((x + ext) / (2 * ext)) * (W - 2 * pad)
  const sy = (y: number) => pad + (1 - (y + ext) / (2 * ext)) * (Hpx - 2 * pad)
  const colors = ['var(--teal)', 'var(--amber)', 'var(--violet)', 'var(--blue)', 'var(--green)', 'var(--red)', '#e28ad6', '#8ad6c0', '#d6c08a', '#8a9ad6', '#c0d68a', '#d68a9a', '#7ad0e2', '#e2b07a', '#b07ae2', '#7ae2a0']
  return (
    <svg viewBox={`0 0 ${W} ${Hpx}`} width="100%" style={{ maxWidth: 420 }} role="img" aria-label="vector quantiser cells">
      <rect x={0} y={0} width={W} height={Hpx} fill="var(--panel-2)" rx={8} />
      {data.map((p, i) => (
        <circle key={i} cx={sx(p[0])} cy={sy(p[1])} r={1.7} fill={colors[assign[i] % colors.length]} opacity={0.55} />
      ))}
      {codebook.map((c, k) => (
        <g key={`cw${k}`}>
          <circle cx={sx(c[0])} cy={sy(c[1])} r={6} fill="none" stroke={colors[k % colors.length]} strokeWidth={2} />
          <circle cx={sx(c[0])} cy={sy(c[1])} r={2.4} fill={colors[k % colors.length]} />
        </g>
      ))}
    </svg>
  )
}

function VectorQuantizerSection() {
  const [N, setN] = useState(8)
  const [blobs, setBlobs] = useState(4)
  const data = useMemo(() => sampleMixture(700, blobs, new QRng(0x51ed7 + blobs * 2654435761)), [blobs])
  const res = useMemo(() => lbg(data, N), [data, N])

  const traceSeries: Series[] = [{ label: 'distortion per Lloyd step', color: 'var(--teal)', points: res.trace.map((d, i) => [i, d]) }]
  const traceTop = Math.max(...res.trace, 0.001) * 1.05

  return (
    <Panel
      title="D · Vector quantisation — Linde–Buzo–Gray"
      note="Lloyd–Max in the plane. Quantising several samples jointly beats quantising each alone — even for independent data — because cells can tile space more efficiently (the space-filling gain) and follow correlation (the shape gain). This is why R(D) is only reachable in the large-block limit."
    >
      <div className="row" style={{ gap: 16, marginBottom: 14, flexWrap: 'wrap', alignItems: 'flex-end' }}>
        <label className="field" style={{ minWidth: 200 }}>
          codewords N = <b style={{ color: 'var(--text)' }}>{N}</b> (rate {(Math.log2(N) / 2).toFixed(2)} bits/dim)
          <input type="range" min={2} max={16} step={1} value={N} onChange={(e) => setN(+e.target.value)} />
        </label>
        <label className="field" style={{ minWidth: 200 }}>
          source clusters = <b style={{ color: 'var(--text)' }}>{blobs}</b>
          <input type="range" min={1} max={6} step={1} value={blobs} onChange={(e) => setBlobs(+e.target.value)} />
        </label>
      </div>

      <div className="grid grid-4" style={{ marginBottom: 14 }}>
        <Stat label="Distortion (per-dim MSE)" value={(res.distortion / 2).toFixed(4)} accent />
        <Stat label="Codewords" value={res.codebook.length} sub="grown by splitting" />
        <Stat label="Lloyd steps" value={res.iterations} sub="monotone descent" />
        <Stat label="Rate" value={(Math.log2(N) / 2).toFixed(3)} unit="bits/dim" />
      </div>

      <div className="grid grid-2">
        <div>
          <SectionTitle>Codebook & Voronoi assignment</SectionTitle>
          <VectorScatter data={data} codebook={res.codebook} assign={res.assign} />
          <div className="panel-note" style={{ marginTop: 6 }}>Points coloured by nearest codeword (ringed). LBG grows the book by splitting each codeword and re-settling — a robust route to a good local optimum.</div>
        </div>
        <div>
          <SectionTitle>Distortion falls monotonically</SectionTitle>
          <LineChart
            series={traceSeries}
            xDomain={[0, Math.max(1, res.trace.length - 1)]}
            yDomain={[0, traceTop]}
            xLabel="Lloyd step (across all splits)"
            yLabel="distortion"
            height={220}
            xFmt={(v) => v.toFixed(0)}
            xTicks={Math.min(6, res.trace.length)}
          />
          <div className="panel-note" style={{ marginTop: 6 }}>Both operations — splitting and generalised Lloyd — can only lower distortion, so the curve never rises. The steps down at each new split are the codebook doubling.</div>
        </div>
      </div>
    </Panel>
  )
}

// ═══════════════════════════════════════════════════════════════════════════
// Section E — Water-filling (parallel Gaussian channels / vector sources)
// ═══════════════════════════════════════════════════════════════════════════

// An illustrative "spectrum": a handful of parallel sub-channels / source
// components whose noise (or variance) decays geometrically — the shape a
// transform like the DCT produces from natural signals.
const SPECTRUM = [0.25, 0.5, 0.9, 1.5, 2.4, 3.6, 5.0, 6.5]

function WaterBars({
  floor,
  level,
  capColor,
  waterColor,
  floorLabel,
  waterLabel,
  active,
}: {
  floor: number[]
  level: number
  capColor: string
  waterColor: string
  floorLabel: string
  waterLabel: string
  active: boolean[]
}) {
  const n = floor.length
  const W = 420
  const H = 220
  const padL = 30
  const padB = 22
  const padT = 12
  const innerH = H - padB - padT
  const top = Math.max(level, ...floor) * 1.08
  const sy = (v: number) => padT + (1 - v / top) * innerH
  const bw = (W - padL - 8) / n
  return (
    <div style={{ overflowX: 'auto' }}>
      <svg viewBox={`0 0 ${W} ${H}`} width="100%" style={{ minWidth: 360 }} role="img" aria-label="water-filling diagram">
        {/* water level line */}
        <line x1={padL} y1={sy(level)} x2={W - 4} y2={sy(level)} stroke="var(--blue)" strokeDasharray="4 3" strokeWidth={1.4} opacity={0.85} />
        <text x={W - 6} y={sy(level) - 4} textAnchor="end" fontSize={10} fill="var(--blue)">level {level.toFixed(2)}</text>
        {floor.map((f, i) => {
          const x = padL + i * bw + 2
          const w = bw - 4
          const isActive = active[i]
          return (
            <g key={i}>
              {/* the poured water / spent budget, from floor up to level */}
              {isActive && f < level && (
                <rect x={x} y={sy(level)} width={w} height={sy(f) - sy(level)} fill={waterColor} opacity={0.75} />
              )}
              {/* the fixed floor block */}
              <rect x={x} y={sy(f)} width={w} height={H - padB - sy(f)} fill={capColor} opacity={0.85} />
              <text x={x + w / 2} y={H - padB + 14} textAnchor="middle" fontSize={9} fill="var(--text-dim)" fontFamily="var(--mono)">{i + 1}</text>
            </g>
          )
        })}
      </svg>
      <div className="chip-row" style={{ marginTop: 4 }}>
        <span className="chip" style={{ cursor: 'default', borderColor: capColor, color: capColor }}><span style={{ display: 'inline-block', width: 10, height: 10, background: capColor, marginRight: 6, verticalAlign: 'middle', borderRadius: 2 }} />{floorLabel}</span>
        <span className="chip" style={{ cursor: 'default', borderColor: waterColor, color: waterColor }}><span style={{ display: 'inline-block', width: 10, height: 10, background: waterColor, marginRight: 6, verticalAlign: 'middle', borderRadius: 2 }} />{waterLabel}</span>
      </div>
    </div>
  )
}

function WaterFillingSection() {
  const [power, setPower] = useState(8)
  const [theta, setTheta] = useState(1.0)

  const fwd = useMemo(() => waterFill(SPECTRUM, power), [power])
  const rev = useMemo(() => reverseWaterFillTheta(SPECTRUM, theta), [theta])
  const vecCurve = useMemo(() => gaussianVectorRD(SPECTRUM, 90), [])
  // The "flat" allocation: spread the same total distortion evenly across all
  // components (no bit allocation) — always worse than reverse water-filling.
  const flatCurve = useMemo(() => {
    const n = SPECTRUM.length
    const out: [number, number][] = []
    for (let i = 1; i <= 90; i++) {
      const D = (SPECTRUM.reduce((a, b) => a + b, 0) * i) / 90
      const dEach = D / n
      let R = 0
      for (const v of SPECTRUM) if (v > dEach) R += 0.5 * Math.log2(v / dEach)
      out.push([D, R])
    }
    return out
  }, [])

  const rdSeries: Series[] = [
    { label: 'reverse water-filling R(D) (optimal)', color: 'var(--teal)', points: vecCurve.map((p) => [p.D, p.R]) },
    { label: 'flat allocation (no bit budgeting)', color: 'var(--red)', points: flatCurve, dashed: true },
  ]
  const totVar = SPECTRUM.reduce((a, b) => a + b, 0)

  return (
    <Panel
      title="E · Water-filling — the Gaussian twin, and why transform coding works"
      note="The Gaussian case of both theorems has a closed form with one vivid picture: pour a fixed budget over a terrain and it settles to a flat level, filling the low bins more. Forwards it allocates POWER to maximise capacity; in reverse it allocates DISTORTION to minimise rate — the exact theory behind JPEG’s bit budget."
    >
      <div className="grid grid-2">
        <div>
          <SectionTitle>Forward — power over parallel Gaussian channels</SectionTitle>
          <label className="field" style={{ maxWidth: 300, marginBottom: 8 }}>
            total power budget P = <b style={{ color: 'var(--text)' }}>{power.toFixed(1)}</b>
            <input type="range" min={0.5} max={20} step={0.5} value={power} onChange={(e) => setPower(+e.target.value)} />
          </label>
          <WaterBars floor={SPECTRUM} level={fwd.level} capColor="var(--amber)" waterColor="var(--blue)" floorLabel="noise floor Nᵢ" waterLabel="allocated power pᵢ" active={fwd.active} />
          <div className="grid grid-2" style={{ marginTop: 10 }}>
            <Stat label="Capacity" value={fwd.capacity.toFixed(3)} unit="bits/use" accent />
            <Stat label="Sub-channels used" value={`${fwd.active.filter(Boolean).length} / ${SPECTRUM.length}`} sub="noisier ones starved" />
          </div>
          <div className="panel-note" style={{ marginTop: 6 }}>Water rises to one level μ; each channel gets pᵢ = max(0, μ − Nᵢ). The noisiest channels sit above the waterline and get <b>no power at all</b> — capacity is maximised by pouring bits where the channel is clean.</div>
        </div>
        <div>
          <SectionTitle>Reverse — distortion over a Gaussian vector source</SectionTitle>
          <label className="field" style={{ maxWidth: 300, marginBottom: 8 }}>
            distortion level θ = <b style={{ color: 'var(--text)' }}>{theta.toFixed(2)}</b>
            <input type="range" min={0.02} max={6.5} step={0.02} value={theta} onChange={(e) => setTheta(+e.target.value)} />
          </label>
          <WaterBars floor={SPECTRUM.map((v) => Math.min(theta, v))} level={theta} capColor="var(--violet)" waterColor="var(--teal)" floorLabel="kept distortion dᵢ" waterLabel="coded variance (bits)" active={SPECTRUM.map((v) => v > theta)} />
          <div className="grid grid-2" style={{ marginTop: 10 }}>
            <Stat label="Rate R" value={rev.totalRate.toFixed(3)} unit="bits" accent />
            <Stat label="Distortion D" value={rev.totalDist.toFixed(3)} sub={`of Σσ² = ${totVar.toFixed(1)}`} />
          </div>
          <div className="panel-note" style={{ marginTop: 6 }}>Below the waterline θ a component is <b>not coded at all</b> — you keep its whole variance as distortion. Above it, bits are spent proportional to log(σ²/θ). This is precisely a transform coder discarding the high-frequency DCT coefficients and spending its budget on the low ones.</div>
        </div>
      </div>

      <SectionTitle>Bit allocation beats blind splitting</SectionTitle>
      <LineChart
        series={rdSeries}
        xDomain={[0, totVar]}
        yDomain={[0, Math.max(...vecCurve.map((p) => p.R)) * 1.05]}
        xLabel="total distortion D"
        yLabel="rate R (bits)"
        height={230}
        xFmt={(v) => v.toFixed(1)}
      />
      <div className="panel-note" style={{ marginTop: 6 }}>
        The optimal reverse-water-filling curve is the true R(D) of this Gaussian vector. Splitting the same distortion <i>evenly</i> across components — ignoring that they carry different amounts of energy — always costs more bits. That gap is the entire reason a codec first decorrelates with a transform and then allocates bits by variance: JPEG’s quantisation table is a hand-tuned reverse water-filling.
      </div>
    </Panel>
  )
}

// ═══════════════════════════════════════════════════════════════════════════

export function RateDistortion() {
  return (
    <div>
      <PageHeader
        kicker="Information theory · the limits themselves"
        title="Rate–Distortion & Quantisation"
        lede={
          <>
            Every other page here <b>reaches</b> for a limit — the entropy floor, a channel’s capacity — that it already
            knows in closed form. This page <b>computes the limits</b>. The{' '}
            <b>Blahut–Arimoto</b> algorithm is Shannon’s theory made numerical: run one way it finds the exact{' '}
            <b>capacity</b> of any channel; run the other it traces the exact <b>rate–distortion function</b> R(D) of any
            source — the fewest bits per symbol to describe it within a tolerated distortion. Then, on the constructive
            side, <b>Lloyd–Max</b> and <b>LBG</b> build the optimal quantisers that actually spend those bits — the very
            machinery inside JPEG, only here measured against the theory it can only approach. Two dual optimisations, one
            algorithm, both halves of Shannon at once.
          </>
        }
      />

      <CapacitySection />
      <RateDistortionSection />
      <ScalarQuantizerSection />
      <VectorQuantizerSection />
      <WaterFillingSection />

      <Panel title="Why this is the keystone">
        <p className="lede" style={{ marginTop: 0 }}>
          The lab’s two pillars finally meet their common source. <b>Source coding</b> removes redundancy to reach the
          entropy floor H(X); <b>channel coding</b> adds redundancy to stay under capacity C — and Blahut–Arimoto computes{' '}
          <i>both</i> H-side and C-side limits with the same alternating minimisation. <b>Rate–distortion</b> generalises
          the entropy floor to lossy description, and the JPEG page is one operational point on the R(D) curve this page
          draws in full: the DCT decorrelates, and a scalar quantiser — a Lloyd–Max design — spends the bits, always a
          fixed gap above the bound that a vector quantiser would close. Capacity, R(D), and the optimal quantiser are the
          three theorems this entire lab has been circling; here they are, computed from scratch.
        </p>
      </Panel>
    </div>
  )
}
