import { useMemo, useState } from 'react'
import { PageHeader, Panel, Stat } from '../components/ui'
import { InputPanel } from '../components/InputPanel'
import { HBarChart, ColumnChart } from '../components/charts'
import { strToBytes } from '../lib/bits'
import { seriesColor } from '../lib/format'
import { CORPUS } from '../lib/corpus'
import { cmEncode, cmAnalyze, ORDERS } from '../lib/cm'
import { ppmEncode } from '../lib/ppm'
import { gzipEncode } from '../lib/gzip'
import { arithEncode, Order1Adaptive } from '../lib/arithmetic'
import { order0Entropy } from '../lib/entropy'

const DEFAULT = CORPUS.find((c) => c.id === 'source')?.text ?? 'the quick brown fox jumps over the lazy dog '

// A signed, diverging bar — mixer weights swing negative (this model votes "0")
// and positive (votes "1"); its magnitude is how loudly the mixer trusts it.
function WeightBars({ items }: { items: { label: string; value: number }[] }) {
  const max = Math.max(1, ...items.map((i) => Math.abs(i.value)))
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      {items.map((it) => {
        const frac = it.value / max
        const pos = frac >= 0
        return (
          <div key={it.label} style={{ display: 'grid', gridTemplateColumns: '92px 1fr 64px', alignItems: 'center', gap: 8 }}>
            <span style={{ fontSize: 12, color: 'var(--text-mid)', textAlign: 'right' }}>{it.label}</span>
            <div style={{ position: 'relative', height: 18, background: 'var(--panel-2)', borderRadius: 4 }}>
              <div style={{ position: 'absolute', left: '50%', top: 0, bottom: 0, width: 1, background: 'var(--border-hi)' }} />
              <div
                style={{
                  position: 'absolute',
                  top: 2,
                  bottom: 2,
                  borderRadius: 3,
                  background: pos ? 'var(--teal)' : 'var(--violet)',
                  left: pos ? '50%' : `${50 + frac * 50}%`,
                  width: `${Math.abs(frac) * 50}%`,
                }}
              />
            </div>
            <span style={{ fontSize: 12, fontFamily: 'var(--mono)', color: 'var(--text)', textAlign: 'right' }}>
              {it.value >= 0 ? '+' : ''}
              {it.value}
            </span>
          </div>
        )
      })}
    </div>
  )
}

export function ContextMixing() {
  const [text, setText] = useState(DEFAULT)
  const data = useMemo(() => strToBytes(text), [text])

  const cm = useMemo(() => cmEncode(data).encoded, [data])
  const trace = useMemo(() => cmAnalyze(data), [data])

  // How CM stacks up against the lab's other strong general coders, coded payload
  // (containers/tables included where they have them — a fair "what ships" size).
  const sizes = useMemo(() => {
    if (data.length === 0) return { cm: cm.length, ppm: 0, gzip: 0, arith: 0, floor: 0 }
    return {
      cm: cm.length,
      ppm: Math.ceil(ppmEncode(data, 4).encodedBits / 8),
      gzip: gzipEncode(data).length,
      arith: arithEncode(data, () => new Order1Adaptive(256)).encoded.length,
      floor: Math.ceil((order0Entropy(data) * data.length) / 8),
    }
  }, [data, cm])

  const inBytes = data.length
  const savings = inBytes > 0 ? 1 - cm.length / inBytes : 0
  const others = [sizes.ppm, sizes.gzip, sizes.arith].filter((v) => v > 0)
  const bestOther = others.length ? Math.min(...others) : 0
  const beatsBest = bestOther > 0 && cm.length <= bestOther

  const modelNames = useMemo(() => [...ORDERS.map((o) => `order-${o}`), 'word', 'match'], [])
  const weightItems = trace.finalWeights.map((w, i) => ({ label: modelNames[i], value: w }))
  const accItems = trace.modelAccuracy.map((m, i) => ({
    label: m.name,
    value: m.acc * 100,
    color: seriesColor(i),
  }))

  return (
    <div>
      <PageHeader
        kicker="Modelling coder · the state of the art"
        title="Context mixing (PAQ)"
        lede={
          <>
            The strongest general-purpose compressors ever measured — <b>PAQ</b>, <b>cmix</b>, <b>lpaq</b> —
            all share one idea: to code the next <b>bit</b>, poll a panel of models (one per context — the
            last {ORDERS.filter((o) => o > 0).join(', ')} bytes, the current word, the longest repeat), then
            blend their opinions with a <b>logistic mixer</b> that <i>learns</i> which models to trust. Two{' '}
            <b>SSE</b> stages sharpen the blend and a <b>binary arithmetic coder</b> spends the bits. Nothing
            is transmitted but the stream — the decoder rebuilds the identical panel and replays every update,
            so it round-trips by construction.
          </>
        }
      />

      <InputPanel value={text} onChange={setText} rows={5} maxNote="live" />

      <div className="grid grid-4" style={{ margin: '18px 0' }}>
        <Stat label="Input" value={inBytes} unit="B" />
        <Stat
          label="CM stream"
          value={cm.length}
          unit="B"
          accent
          sub={inBytes > 0 ? `${(savings * 100).toFixed(0)}% smaller` : '—'}
        />
        <Stat label="Bits / char" value={trace.bpc.toFixed(3)} sub={`8.000 = no compression`} />
        <Stat
          label="vs best other"
          value={bestOther > 0 ? (beatsBest ? 'wins' : `+${cm.length - bestOther}B`) : '—'}
          sub={bestOther > 0 ? `best of PPM/gzip/arith = ${bestOther}B` : ''}
          accent={beatsBest}
        />
      </div>

      <Panel
        title="Usually the best all-rounder"
        note="CM's coded size against the lab's other strong general coders. It rarely wins every corpus outright — PPM can edge it on the shortest, most repetitive inputs — but across a mix it is the most consistent, because the mixer falls back on whichever model happens to fit."
      >
        <HBarChart
          bars={[
            { label: 'order-0 floor', value: sizes.floor, color: 'var(--text-dim)' },
            { label: 'context mixing', value: sizes.cm, color: 'var(--teal)' },
            { label: 'PPM · order-4', value: sizes.ppm, color: 'var(--violet)' },
            { label: 'gzip (DEFLATE)', value: sizes.gzip, color: 'var(--blue)' },
            { label: 'arithmetic · order-1', value: sizes.arith, color: 'var(--amber)' },
          ]}
          unit=" B"
        />
      </Panel>

      <Panel
        title="Watch it learn — bits per byte across the file"
        note="Early bytes are expensive: every context is fresh, the mixer weights are flat. As the same contexts recur, the models sharpen and the mixer learns whom to trust, so the cost per byte falls. This downward slope is the whole game."
      >
        {trace.perByteBpc.length > 0 ? (
          <ColumnChart cols={trace.perByteBpc} color="var(--teal)" height={200} />
        ) : (
          <div className="muted">Type something to see the learning curve.</div>
        )}
        <div className="muted" style={{ fontSize: 12, marginTop: 6 }}>
          File split left-to-right into buckets; bar height is mean bits/byte in that bucket (8 = incompressible).
        </div>
      </Panel>

      <div className="grid grid-2" style={{ gap: 16 }}>
        <Panel
          title="The mixer's current trust"
          note="The logistic mixer's weight for each model, in the weight set active at the end of the input. Positive (teal) = this model is currently voting the next bit is 1; negative (violet) = voting 0; magnitude = how loudly the mixer trusts it. Weights are context-selected, so they differ bit to bit."
        >
          <WeightBars items={weightItems} />
        </Panel>

        <Panel
          title="How often each model is right"
          note="Per model, the share of bits where the sign of its vote matched the actual bit (counting only bits it had an opinion on). The match model, when it fires, is almost always right — that is why it earns a big weight on repetitive data."
        >
          <HBarChart bars={accItems} unit="%" max={100} valueFmt={(v) => v.toFixed(0)} />
        </Panel>
      </div>

      <Panel
        title="Prediction ribbon"
        note="The first bits of the stream. Each cell is one bit: its height is the model's confidence in the value that actually occurred, green when the model bet correctly and red when it was surprised. A wall of tall green cells is a stream being crushed; ragged red is the coder paying for bits it did not see coming."
      >
        <Ribbon ribbon={trace.ribbon} />
      </Panel>

      {trace.matchTrace.length > 1 && (
        <Panel
          title="Match model — longest repeat over position"
          note="The match model finds where the current context last occurred and predicts the byte that followed. On repetitive input the match length climbs into the hundreds; each long match is a run of near-free bits."
        >
          <ColumnChart cols={trace.matchTrace} color="var(--amber)" height={160} />
        </Panel>
      )}

      <Panel title="The architecture, end to end">
        <ol className="prose-list">
          <li>
            <b>The panel.</b> {ORDERS.length} byte-context models (orders {ORDERS.join(', ')}), a word model and
            a match model each predict P(next bit = 1). Each keeps an adaptive estimate per context — a 22-bit
            probability with a saturating count, so a fresh context adapts fast and a well-seen one holds steady.
          </li>
          <li>
            <b>The logistic mixer.</b> Predictions are combined in the log-odds domain (stretch), weighted by an
            online logistic-regression step: after each bit the weights move to reduce the error, so useful
            models gain influence and noisy ones fade. The weight set is chosen by context, so the mixer trusts
            different models in different places.
          </li>
          <li>
            <b>Two SSE stages.</b> Adaptive probability maps take the mixed estimate and a context and correct
            its calibration by interpolating over learned buckets — the secondary-symbol-estimation trick that
            squeezes out the last few percent.
          </li>
          <li>
            <b>The coder.</b> A carryless 32-bit binary arithmetic coder spends exactly −log₂ p bits on the bit
            that occurs. Encoder and decoder run this identical pipeline, so the compressed stream needs no
            transmitted model at all.
          </li>
        </ol>
      </Panel>
    </div>
  )
}

// A compact bit-by-bit ribbon: each column is one coded bit, coloured by whether
// the panel bet correctly and how confident it was.
function Ribbon({ ribbon }: { ribbon: { p: number; bit: number }[] }) {
  if (ribbon.length === 0) return <div className="muted">Type something to see the bit stream.</div>
  const W = 5
  const GAP = 1
  const H = 46
  const total = ribbon.length * (W + GAP)
  return (
    <div style={{ overflowX: 'auto' }}>
      <svg viewBox={`0 0 ${total} ${H}`} width="100%" style={{ minWidth: Math.min(total, 640) }} role="img">
        {ribbon.map((r, i) => {
          const pTrue = r.bit ? r.p : 4096 - r.p // model's probability of what happened
          const conf = pTrue / 4096 // in [0,1]
          const correct = pTrue >= 2048
          const h = Math.max(2, conf * H)
          return (
            <rect
              key={i}
              x={i * (W + GAP)}
              y={H - h}
              width={W}
              height={h}
              rx={1}
              fill={correct ? 'var(--teal)' : 'var(--red)'}
              opacity={0.35 + conf * 0.6}
            />
          )
        })}
      </svg>
    </div>
  )
}
