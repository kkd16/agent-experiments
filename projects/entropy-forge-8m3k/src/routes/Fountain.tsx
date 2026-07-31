import { useMemo, useState } from 'react'
import { PageHeader, Panel, Stat } from '../components/ui'
import { LineChart, ColumnChart } from '../components/charts'
import { strToBytes, bytesToStr } from '../lib/bits'
import { RNG } from '../lib/channel'
import {
  idealSoliton,
  robustSoliton,
  bytesToSymbols,
  symbolsToBytes,
  ltEncode,
  peelDecode,
  geDecode,
  inactivationDecode,
  buildPrecode,
  precodeIntermediate,
  raptorDecode,
  successCurve,
  overheadSamples,
  type DegreeDist,
  type Droplet,
} from '../lib/fountain'

type DistKind = 'ideal' | 'robust'

// A droplet plus whether it survived the erasure channel.
interface Drop extends Droplet {
  erased: boolean
}

export function Fountain() {
  const [text, setText] = useState('a digital fountain')
  const [W, setW] = useState(3)
  const [kind, setKind] = useState<DistKind>('robust')
  const [cParam, setCParam] = useState(0.05)
  const [delta, setDelta] = useState(0.5)
  const [parities, setParities] = useState(6)
  const [useRaptor, setUseRaptor] = useState(false)
  const [eps, setEps] = useState(0.3)
  const [overhead, setOverhead] = useState(0.6) // sent = k·(1+overhead)/(1−ε)
  const [step, setStep] = useState(9999)
  const [chanSeed, setChanSeed] = useState(7)

  // --- Source symbols -------------------------------------------------------
  const bytes = useMemo(() => strToBytes(text.length ? text : ' '), [text])
  const sources = useMemo(() => bytesToSymbols(bytes, W), [bytes, W])
  const k = sources.length

  // --- Precode (Raptor) -----------------------------------------------------
  const pre = useMemo(() => (useRaptor ? buildPrecode(k, Math.max(1, parities), 20250731) : null), [useRaptor, k, parities])
  const encodeSymbols = useMemo(() => (pre ? precodeIntermediate(sources, pre) : sources), [pre, sources])
  const L = encodeSymbols.length

  // --- Degree distribution over the encoded-symbol count --------------------
  const dist: DegreeDist = useMemo(() => (kind === 'ideal' ? idealSoliton(L) : robustSoliton(L, cParam, delta)), [kind, L, cParam, delta])

  // --- Generate and erase a droplet stream ----------------------------------
  const targetReceived = Math.max(k + 1, Math.round(k * (1 + overhead)))
  const sent = Math.min(200, Math.max(targetReceived, Math.ceil(targetReceived / Math.max(0.05, 1 - eps))))

  const drops: Drop[] = useMemo(() => {
    const all = ltEncode(encodeSymbols, dist, sent, { startSeed: 1 })
    const rng = new RNG(0x9e37 + chanSeed * 2654435761)
    return all.map((d) => ({ ...d, erased: rng.float() < eps }))
  }, [encodeSymbols, dist, sent, eps, chanSeed])

  const received = useMemo(() => drops.filter((d) => !d.erased), [drops])
  const W0 = W

  // --- Decode the received set with every decoder (for the verdict panel) ---
  const peel = useMemo(() => peelDecode(received, L, W0), [received, L, W0])
  const ge = useMemo(() => geDecode(received, L, W0), [received, L, W0])
  const inact = useMemo(() => inactivationDecode(received, L, W0), [received, L, W0])
  const rap = useMemo(() => (pre ? raptorDecode(received, pre, W0) : null), [received, pre, W0])

  // The "official" decode uses GE (optimal); Raptor when enabled.
  const decodedSymbols = useMemo(() => {
    if (pre && rap) return rap.sources
    return ge.symbols.slice(0, k)
  }, [pre, rap, ge, k])
  const decodedOk = useMemo(() => {
    if (!decodedSymbols.every(Boolean)) return false
    const rec = symbolsToBytes(decodedSymbols, bytes.length)
    return rec.length === bytes.length && rec.every((b, i) => b === bytes[i])
  }, [decodedSymbols, bytes])
  const decodedText = useMemo(() => {
    if (!decodedSymbols.every(Boolean)) return ''
    try {
      return bytesToStr(symbolsToBytes(decodedSymbols, bytes.length))
    } catch {
      return ''
    }
  }, [decodedSymbols, bytes])

  const overheadPct = ((received.length - k) / k) * 100

  // --- Degree histograms ----------------------------------------------------
  const maxDeg = Math.min(L, 20)
  const pmfCols = useMemo(() => Array.from({ length: maxDeg }, (_, i) => ({ label: String(i + 1), value: dist.p[i + 1] ?? 0 })), [dist, maxDeg])
  const sentDegCols = useMemo(() => {
    const hist = new Array<number>(maxDeg + 1).fill(0)
    for (const d of drops) {
      const deg = Math.min(maxDeg, d.neighbors.length)
      hist[deg]++
    }
    return Array.from({ length: maxDeg }, (_, i) => ({ label: String(i + 1), value: hist[i + 1] }))
  }, [drops, maxDeg])

  // --- Peeling animation state ---------------------------------------------
  const nSteps = peel.steps.length
  const curStep = Math.min(step, nSteps)
  const knownNow = useMemo(() => {
    const s = new Set<number>()
    for (let i = 0; i < curStep; i++) s.add(peel.steps[i].symbol)
    return s
  }, [peel, curStep])
  const currentSymbol = curStep > 0 && curStep <= nSteps ? peel.steps[curStep - 1].symbol : -1
  const currentSeed = curStep > 0 && curStep <= nSteps ? peel.steps[curStep - 1].viaSeed : -1
  const rippleNow = curStep > 0 && curStep <= nSteps ? peel.steps[curStep - 1].rippleSize : 0

  // --- Overhead / success curve (Monte-Carlo, structural) -------------------
  const curve = useMemo(() => {
    const rec = Array.from({ length: 13 }, (_, i) => Math.round(k * (1 + (i * 0.1)))) // k .. 2.2k
    return successCurve(kind === 'ideal' ? idealSoliton(k) : robustSoliton(k, cParam, delta), {
      received: rec,
      trials: 90,
      salt: 11,
      precodeParities: useRaptor ? Math.max(1, parities) : 6,
    })
  }, [k, kind, cParam, delta, useRaptor, parities])

  // --- Overhead distribution (Monte-Carlo, structural) ----------------------
  const ohist = useMemo(() => {
    const s = overheadSamples(kind === 'ideal' ? idealSoliton(k) : robustSoliton(k, cParam, delta), 160, 5, 3)
    const bins = 15
    const binW = 3 / bins // overhead 0..3
    const bucket = (arr: number[]) => {
      const h = new Array<number>(bins).fill(0)
      for (const v of arr) h[Math.min(bins - 1, Math.floor(v / binW))]++
      return h
    }
    return { peel: bucket(s.peel), ge: bucket(s.ge), meanPeel: s.meanPeel, meanGE: s.meanGE, binW, bins }
  }, [k, kind, cParam, delta])

  // --- Ripple size over the peeling run -------------------------------------
  const rippleSeries = useMemo(
    () => peel.steps.map((s, i) => [i + 1, s.rippleSize] as [number, number]),
    [peel],
  )
  const maxRipple = Math.max(1, ...peel.steps.map((s) => s.rippleSize))

  const canGraph = drops.length <= 44 && L <= 26

  return (
    <div>
      <PageHeader
        kicker="Channel coding · rateless erasure coding"
        title="Fountain codes — LT & Raptor"
        lede={
          <>
            Every other code here fixes a block length up front. A <b>fountain code</b> throws it away:
            from <b>k</b> source symbols it manufactures a <b>limitless stream</b> of droplets, each the
            XOR of a random handful of sources. A receiver on a lossy channel catches whatever survives
            and, once it has just <em>slightly more than k</em> droplets, rebuilds the whole message —
            no feedback, no retransmission, no rate chosen in advance. Hold a bucket under the stream
            until it's full; <b>which</b> drops you caught never matters, only <b>how many</b>. This is
            the code behind <b>3GPP broadcast, RaptorQ (RFC 6330), and BitTorrent-style delivery</b>.
          </>
        }
      />

      <Panel
        title="The source & the stream"
        right={<button className="btn small" onClick={() => setChanSeed((s) => s + 1)}>Re-roll channel</button>}
      >
        <div className="row" style={{ gap: 18, marginBottom: 14, alignItems: 'flex-end' }}>
          <label className="field" style={{ flex: 1, minWidth: 220 }}>
            Message
            <input type="text" value={text} maxLength={64} onChange={(e) => setText(e.target.value)} />
          </label>
          <label className="field" style={{ minWidth: 150 }}>
            Symbol size W: <b style={{ color: 'var(--text)' }}>{W} B</b>
            <input type="range" min={1} max={6} step={1} value={W} onChange={(e) => setW(+e.target.value)} />
          </label>
        </div>

        <div className="chip-row" style={{ marginBottom: 12 }}>
          <span className="muted" style={{ fontSize: 12, marginRight: 4 }}>degree distribution:</span>
          <button className={`chip${kind === 'robust' ? ' active' : ''}`} onClick={() => setKind('robust')}>Robust soliton</button>
          <button className={`chip${kind === 'ideal' ? ' active' : ''}`} onClick={() => setKind('ideal')}>Ideal soliton</button>
          <span style={{ width: 14 }} />
          <button className={`chip${useRaptor ? ' active' : ''}`} onClick={() => setUseRaptor((v) => !v)}>
            {useRaptor ? '✓ ' : ''}Raptor precode
          </button>
        </div>

        <div className="row" style={{ gap: 18, marginBottom: 4 }}>
          {kind === 'robust' && (
            <>
              <label className="field" style={{ minWidth: 190 }}>
                ripple knob c: <b style={{ color: 'var(--text)' }}>{cParam.toFixed(3)}</b>
                <input type="range" min={0.01} max={0.3} step={0.005} value={cParam} onChange={(e) => setCParam(+e.target.value)} />
              </label>
              <label className="field" style={{ minWidth: 190 }}>
                target failure δ: <b style={{ color: 'var(--text)' }}>{delta.toFixed(2)}</b>
                <input type="range" min={0.01} max={0.9} step={0.01} value={delta} onChange={(e) => setDelta(+e.target.value)} />
              </label>
            </>
          )}
          {useRaptor && (
            <label className="field" style={{ minWidth: 190 }}>
              precode parities p: <b style={{ color: 'var(--text)' }}>{parities}</b>
              <input type="range" min={1} max={Math.max(2, Math.round(k / 2))} step={1} value={parities} onChange={(e) => setParities(+e.target.value)} />
            </label>
          )}
          <label className="field" style={{ minWidth: 220 }}>
            channel erasure ε: <b style={{ color: 'var(--text)' }}>{eps.toFixed(2)}</b>
            <input type="range" min={0} max={0.7} step={0.02} value={eps} onChange={(e) => setEps(+e.target.value)} />
          </label>
          <label className="field" style={{ minWidth: 220 }}>
            reception overhead: <b style={{ color: 'var(--text)' }}>+{Math.round(overhead * 100)}%</b>
            <input type="range" min={0} max={1.5} step={0.05} value={overhead} onChange={(e) => setOverhead(+e.target.value)} />
          </label>
        </div>
      </Panel>

      <div className="grid grid-4" style={{ marginBottom: 16 }}>
        <Stat label="Source symbols k" value={k} sub={useRaptor ? `+${pre?.p} parity → L=${L}` : `${bytes.length} B / ${W} B`} />
        <Stat label="Droplets sent" value={sent} sub={`${dist.meanDegree.toFixed(1)} avg degree`} />
        <Stat label="Received / erased" value={`${received.length} / ${drops.length - received.length}`} sub={`ε=${eps.toFixed(2)}`} />
        <Stat
          label="Reception overhead"
          value={`${overheadPct >= 0 ? '+' : ''}${overheadPct.toFixed(0)}%`}
          accent
          sub={`${received.length} caught, need ≥ ${k}`}
        />
      </div>

      <Panel
        title="Decoder verdict on this received set"
        note="The same caught droplets, four decoders. Peeling only ever solves degree-1 droplets and stalls early; Gaussian elimination (ML) solves the whole linear system and succeeds at far lower overhead; inactivation decoding matches GE's success but defers only a handful of stubborn symbols to a tiny dense solve (the RaptorQ trick — near-linear); Raptor's precode adds parity equations that bridge the gap. The official reconstruction below uses GE (or Raptor when enabled)."
      >
        <div className="grid grid-4" style={{ marginBottom: 12 }}>
          <Stat
            label="Peeling (ripple)"
            value={peel.success ? 'decoded ✓' : `${peel.decoded}/${L}`}
            sub={peel.success ? `${peel.steps.length} releases` : 'ripple ran dry'}
          />
          <Stat
            label="Gaussian elimination"
            value={ge.success ? 'decoded ✓' : `rank ${ge.rank}/${L}`}
            sub={ge.success ? 'full rank — ML optimal' : `need ${L - ge.rank} more independent`}
          />
          <Stat
            label="Inactivation (RaptorQ)"
            value={inact.success ? 'decoded ✓' : 'incomplete'}
            accent={inact.success && inact.inactivations <= 4}
            sub={inact.success ? `${inact.peeled} peeled · ${inact.inactivations} inactivated` : 'rank-deficient set'}
          />
          <Stat
            label={pre ? 'Raptor (precode+LT)' : 'Raptor (off)'}
            value={pre ? (rap!.success ? 'decoded ✓' : `rank ${rap!.rank}/${L}`) : '—'}
            sub={pre ? `${pre.p} parity constraints` : 'enable the precode'}
          />
        </div>
        <div className="ef-verdict" style={{ borderColor: decodedOk ? 'var(--green)' : 'var(--red)' }}>
          <span className="tag" style={{ color: decodedOk ? 'var(--green)' : 'var(--red)', borderColor: decodedOk ? 'var(--green)' : 'var(--red)' }}>
            {decodedOk ? 'exact reconstruction ✓' : 'not yet decodable'}
          </span>
          <span className="ef-decoded">{decodedOk ? `“${decodedText}”` : 'catch more droplets, lower ε, or enable Raptor'}</span>
        </div>
      </Panel>

      {canGraph ? (
        <Panel
          title="The stream, decoding live"
          note="Top row = droplets (□), dimmed if the erasure channel dropped them; bottom row = the L encoded symbols (○). An edge joins a droplet to each source it XORs. Scrub the peeling decoder: the amber droplet is the degree-1 droplet being solved; green symbols are recovered; watch the ripple carry the solution across the graph."
        >
          <div className="row" style={{ gap: 12, marginBottom: 10, alignItems: 'center' }}>
            <button className="btn small" onClick={() => setStep(0)}>Reset</button>
            <button className="btn small" onClick={() => setStep((s) => Math.max(0, Math.min(nSteps, s) - 1))}>◀</button>
            <button className="btn small" onClick={() => setStep((s) => Math.min(nSteps, s) + 1)}>▶</button>
            <input
              type="range"
              min={0}
              max={Math.max(1, nSteps)}
              step={1}
              value={curStep}
              onChange={(e) => setStep(+e.target.value)}
              style={{ flex: 1, minWidth: 160 }}
            />
            <span className="tag">{curStep} / {nSteps} released · ripple {rippleNow}</span>
          </div>
          <BipartiteGraph
            L={L}
            k={k}
            drops={drops}
            known={knownNow}
            currentSymbol={currentSymbol}
            currentSeed={currentSeed}
          />
          <div className="chip-row" style={{ marginTop: 10 }}>
            <span className="tag" style={{ color: 'var(--teal)', borderColor: 'var(--teal)' }}>received droplet</span>
            <span className="tag" style={{ color: 'var(--text-dim)' }}>erased droplet</span>
            <span className="tag" style={{ color: 'var(--amber)', borderColor: 'var(--amber)' }}>solving now (degree 1)</span>
            <span className="tag" style={{ color: 'var(--green)', borderColor: 'var(--green)' }}>recovered symbol</span>
            {useRaptor && <span className="tag" style={{ color: 'var(--violet)', borderColor: 'var(--violet)' }}>parity symbol</span>}
          </div>
        </Panel>
      ) : (
        <Panel title="The stream, decoding live" note="The live bipartite graph renders for small streams; shorten the message or drop the erasure rate to bring the droplet count down and watch the ripple animate.">
          <div className="muted" style={{ fontSize: 13 }}>Stream too large to draw ({drops.length} droplets, L={L}). The decoders and curves above/below still run.</div>
        </Panel>
      )}

      <div className="grid grid-2" style={{ gap: 16 }}>
        <Panel
          title="Degree distribution"
          note="The soliton distribution: nearly all droplets are low-degree (so peeling has degree-1 droplets to chew on), with one deliberate high-degree spike to sweep up the last few symbols. Bars = the probability mass μ(d); the histogram behind shows the degrees actually drawn for this stream."
        >
          <ColumnChart cols={pmfCols} color="var(--teal)" height={150} />
          <div className="muted" style={{ fontSize: 11, marginTop: 4 }}>μ(d), probability of degree d · mean {dist.meanDegree.toFixed(2)}</div>
          <div style={{ marginTop: 14 }}>
            <ColumnChart cols={sentDegCols} color="var(--violet)" height={110} />
            <div className="muted" style={{ fontSize: 11, marginTop: 4 }}>degrees actually sent ({drops.length} droplets)</div>
          </div>
        </Panel>

        <Panel
          title="Decode probability vs overhead"
          note="Monte-Carlo success rate as a function of how many droplets you receive (as a multiple of k). Peeling needs a big overhead; the ML (GE) decoder decodes at a sliver above k; Raptor's precode pushes the cliff even lower. This is the whole promise of rateless codes on one chart."
        >
          <LineChart
            series={[
              { label: 'peeling', color: 'var(--pink)', points: curve.map((c) => [c.received / k, c.pPeel]) },
              { label: 'Gaussian elim. (ML)', color: 'var(--teal)', points: curve.map((c) => [c.received / k, c.pGE]) },
              { label: 'Raptor (precode+LT)', color: 'var(--violet)', points: curve.map((c) => [c.received / k, c.pRaptor]) },
            ]}
            xDomain={[1, 2.2]}
            yDomain={[0, 1]}
            xLabel="received droplets ÷ k"
            yLabel="P(decode)"
            xFmt={(v) => `${v.toFixed(1)}×`}
            yFmt={(v) => v.toFixed(1)}
            markers={[{ x: 1, label: 'k', color: 'var(--amber)' }]}
          />
          <div className="muted" style={{ fontSize: 11, marginTop: 6 }}>k={k}, 90 Monte-Carlo trials per point · success depends only on the droplet↔symbol structure, not the payload</div>
        </Panel>
      </div>

      <div className="grid grid-2" style={{ gap: 16 }}>
        <Panel
          title="The ripple over the peeling run"
          note="Luby's ripple = the pool of degree-1 droplets waiting to release a fresh symbol. Each release can spawn new degree-1 droplets (a chain reaction) or shrink it; decoding succeeds only if the ripple never hits zero before the last symbol. This is that pool's size at each step of the current decode."
        >
          {rippleSeries.length > 1 ? (
            <LineChart
              series={[{ label: 'ripple size', color: 'var(--amber)', points: rippleSeries }]}
              xDomain={[1, rippleSeries.length]}
              yDomain={[0, maxRipple]}
              xLabel="release step"
              yLabel="degree-1 droplets"
              xFmt={(v) => v.toFixed(0)}
              yFmt={(v) => v.toFixed(0)}
              xTicks={Math.min(8, rippleSeries.length - 1)}
              yTicks={Math.min(5, maxRipple)}
            />
          ) : (
            <div className="muted" style={{ fontSize: 13 }}>Peeling released too few symbols to plot a ripple — lower ε or raise the overhead.</div>
          )}
          <div className="muted" style={{ fontSize: 11, marginTop: 6 }}>{peel.steps.length} of {L} symbols peeled on this received set</div>
        </Panel>

        <Panel
          title="Overhead distribution"
          note="Over many trials, the fraction of droplets beyond k needed before each decoder first succeeds. The ML (GE) decoder's overhead concentrates just above zero; peeling's has a long, heavy tail — the classic reason fountain codes pair a cheap peeler with a dense finisher."
        >
          <ColumnChart
            cols={ohist.ge.map((v, i) => ({ label: `${Math.round(i * ohist.binW * 100)}`, value: v }))}
            color="var(--teal)"
            height={110}
          />
          <div className="muted" style={{ fontSize: 11, marginTop: 4 }}>GE overhead % · mean +{(ohist.meanGE * 100).toFixed(0)}%</div>
          <div style={{ marginTop: 12 }}>
            <ColumnChart
              cols={ohist.peel.map((v, i) => ({ label: `${Math.round(i * ohist.binW * 100)}`, value: v }))}
              color="var(--pink)"
              height={110}
            />
            <div className="muted" style={{ fontSize: 11, marginTop: 4 }}>peeling overhead % · mean +{(ohist.meanPeel * 100).toFixed(0)}%</div>
          </div>
        </Panel>
      </div>

      <Panel title="Why a fountain?" note="The one-paragraph intuition.">
        <p className="lede" style={{ margin: 0 }}>
          On a broadcast or lossy link you cannot afford a feedback channel per receiver — a satellite can't
          resend the one packet each of a million dishes happened to miss. A fountain code makes every droplet{' '}
          <b>equally useful and independent</b>: a receiver needs <em>any</em> k(1+ε) of them, so the sender
          just keeps pouring and each receiver stops when its bucket is full. The magic is the degree
          distribution — enough degree-1 droplets to start the chain reaction, a fat spike to finish it — and,
          for the last fraction of a percent, an outer <b>precode</b> that turns the near-optimal LT code into
          a genuinely optimal <b>Raptor</b> code decodable in linear time.
        </p>
      </Panel>
    </div>
  )
}

// ---------------------------------------------------------------------------
// The bipartite droplet ↔ symbol graph with the peeling animation.
// ---------------------------------------------------------------------------
function BipartiteGraph({
  L,
  k,
  drops,
  known,
  currentSymbol,
  currentSeed,
}: {
  L: number
  k: number
  drops: Drop[]
  known: Set<number>
  currentSymbol: number
  currentSeed: number
}) {
  const N = drops.length
  const width = 720
  const padX = 24
  const topY = 40
  const botY = 210
  const dropX = (i: number) => padX + (N <= 1 ? width / 2 - padX : (i * (width - 2 * padX)) / (N - 1))
  const symX = (i: number) => padX + (L <= 1 ? width / 2 - padX : (i * (width - 2 * padX)) / (L - 1))
  const dropR = 9
  const symR = 10

  return (
    <div style={{ overflowX: 'auto' }}>
      <svg viewBox={`0 0 ${width} 250`} width="100%" style={{ minWidth: 560 }} role="img">
        {/* edges */}
        {drops.map((d, j) => {
          const isCur = d.seed === currentSeed
          return d.neighbors.map((s, e) => {
            const active = isCur
            return (
              <line
                key={`${j}-${e}`}
                x1={dropX(j)}
                y1={topY + dropR}
                x2={symX(s)}
                y2={botY - symR}
                stroke={active ? 'var(--amber)' : d.erased ? 'var(--border)' : 'var(--border-hi)'}
                strokeWidth={active ? 2 : 1}
                opacity={d.erased ? 0.25 : active ? 0.95 : 0.5}
              />
            )
          })
        })}
        {/* droplets */}
        {drops.map((d, j) => {
          const isCur = d.seed === currentSeed
          const fill = isCur ? 'var(--amber)' : d.erased ? 'var(--panel-2)' : 'var(--teal)'
          return (
            <g key={`d${j}`}>
              <rect
                x={dropX(j) - dropR}
                y={topY - dropR}
                width={dropR * 2}
                height={dropR * 2}
                rx={3}
                fill={fill}
                opacity={d.erased ? 0.4 : 0.9}
                stroke={d.erased ? 'var(--border)' : 'none'}
                strokeDasharray={d.erased ? '2 2' : undefined}
              />
            </g>
          )
        })}
        {/* symbols */}
        {Array.from({ length: L }, (_, s) => {
          const isKnown = known.has(s)
          const isParity = s >= k
          const isCur = s === currentSymbol
          const fill = isCur ? 'var(--amber)' : isKnown ? 'var(--green)' : isParity ? 'color-mix(in srgb, var(--violet) 30%, var(--panel-2))' : 'var(--panel-2)'
          const stroke = isParity ? 'var(--violet)' : isKnown ? 'var(--green)' : 'var(--border-hi)'
          return (
            <g key={`s${s}`}>
              <circle cx={symX(s)} cy={botY} r={symR} fill={fill} stroke={stroke} strokeWidth={1.3} opacity={0.95} />
              {L <= 20 && (
                <text x={symX(s)} y={botY + 24} textAnchor="middle" fontSize={9} fill="var(--text-dim)" fontFamily="var(--mono)">
                  {isParity ? `p${s - k}` : s}
                </text>
              )}
            </g>
          )
        })}
        <text x={padX} y={16} fontSize={10} fill="var(--text-dim)">droplets ({N})</text>
        <text x={padX} y={botY + 40} fontSize={10} fill="var(--text-dim)">encoded symbols ({L})</text>
      </svg>
    </div>
  )
}
