import { useMemo, useState } from 'react'
import { PageHeader, Panel, Stat } from '../components/ui'
import { InputPanel } from '../components/InputPanel'
import { HBarChart } from '../components/charts'
import { ppmEncode, type PPMStep } from '../lib/ppm'
import { arithEncode, Order0Adaptive, Order1Adaptive } from '../lib/arithmetic'
import { analyze } from '../lib/entropy'
import { strToBytes } from '../lib/bits'
import { byteGlyph, seriesColor } from '../lib/format'

const MAX_ORDER = 5
const DEFAULT =
  'the rain in spain falls mainly on the plain. the plain rain in spain is plainly the main thing. ' +
  'she sells sea shells by the sea shore; the shells she sells are surely sea shells.'

// A colour per "order that finally coded a symbol": warmer = longer context (a
// confident, cheap prediction); grey = the uniform order-−1 fallback (a brand-new
// byte). Reading the strip left-to-right shows the model "warming up".
function orderColor(order: number): string {
  if (order < 0) return 'var(--text-dim)'
  return seriesColor(order)
}

export function Ppm() {
  const [text, setText] = useState(DEFAULT)
  const [order, setOrder] = useState(3)
  const data = useMemo(() => strToBytes(text), [text])

  // Encode at every order 0..MAX so we can draw the diminishing-returns curve, and
  // keep the full result for the currently selected order.
  const perOrder = useMemo(() => {
    return Array.from({ length: MAX_ORDER + 1 }, (_, o) => {
      const r = ppmEncode(data, o)
      return { order: o, bytes: Math.ceil(r.encodedBits / 8), bits: r.encodedBits, result: r }
    })
  }, [data])

  const current = perOrder[order]
  const floor = useMemo(() => analyze(data), [data])

  // Reference coders for context: order-0 and order-1 adaptive arithmetic.
  const refs = useMemo(() => {
    if (data.length === 0) return { a0: 0, a1: 0 }
    const a0 = Math.ceil(arithEncode(data, () => new Order0Adaptive(256)).encodedBits / 8)
    const a1 = Math.ceil(arithEncode(data, () => new Order1Adaptive(256)).encodedBits / 8)
    return { a0, a1 }
  }, [data])

  const ratioBars = perOrder.map((p) => ({
    label: `order ${p.order}`,
    value: data.length > 0 ? (p.bits / data.length) : 0,
    color: p.order === order ? 'var(--teal)' : 'var(--blue)',
    caption: `${p.bytes}B`,
  }))

  // Breakdown: at the selected order, how many symbols were finally coded at each
  // context length? perOrderCoded index 0 = order −1 (uniform), 1 = order 0, …
  const breakdown = useMemo(() => {
    const pc = current.result.perOrderCoded
    const bars: { label: string; value: number; color?: string }[] = []
    for (let i = pc.length - 1; i >= 0; i--) {
      const o = i - 1
      if (pc[i] === 0 && o !== order && o !== -1) continue
      bars.push({
        label: o < 0 ? 'uniform (−1)' : `order ${o}`,
        value: pc[i],
        color: orderColor(o),
      })
    }
    return bars
  }, [current, order])

  const steps: PPMStep[] = current.result.steps
  const totalEscapes = steps.reduce((s, x) => s + x.escapes, 0)
  const best = perOrder.reduce((a, b) => (b.bytes < a.bytes ? b : a))

  return (
    <div>
      <PageHeader
        kicker="Module 04 · context modelling"
        title="PPM — prediction by partial matching"
        lede={
          <>
            PPM keeps a stack of models of orders 0…N and codes each byte in the{' '}
            <strong>longest context</strong> that has seen it — falling back through an{' '}
            <strong>escape</strong> to shorter contexts when it hasn't. Raise the order and watch
            compression improve with <strong>sharply diminishing returns</strong>: the point where
            more context stops paying is exactly where a corpus runs out of predictable structure.
          </>
        }
      />

      <Panel title="Input">
        <InputPanel value={text} onChange={setText} rows={4} />
        <div className="controls" style={{ marginTop: 14 }}>
          <label className="field" style={{ minWidth: 260 }}>
            maximum context order — {order}
            <input
              type="range"
              min={0}
              max={MAX_ORDER}
              value={order}
              onChange={(e) => setOrder(Number(e.target.value))}
            />
          </label>
          <span className="tag">PPMC · escape + full exclusion · range-coded</span>
        </div>
      </Panel>

      <div className="grid grid-4" style={{ marginTop: 16 }}>
        <Stat label="Input" value={data.length} unit="B" />
        <Stat
          label={`PPM order-${order}`}
          value={current.bytes}
          unit="B"
          accent
          sub={data.length > 0 ? `${((current.bytes / data.length) * 100).toFixed(0)}% of original` : undefined}
        />
        <Stat
          label="bits / symbol"
          value={data.length > 0 ? (current.bits / data.length).toFixed(2) : '0'}
          sub={`order-0 entropy ${floor.order0.toFixed(2)}`}
        />
        <Stat label="escapes emitted" value={totalEscapes} sub={`${current.result.perOrderCoded[0]} uniform fallbacks`} />
      </div>

      <Panel
        title="Diminishing returns"
        note="bits per symbol as the maximum context order grows — lower is better"
        right={<span className="pill ok">best: order {best.order} · {best.bytes}B</span>}
      >
        <HBarChart
          bars={ratioBars}
          unit=" b/sym"
          valueFmt={(v) => v.toFixed(2)}
          marker={{ value: floor.order0, label: 'order-0 entropy' }}
        />
        <div className="legend" style={{ marginTop: 12 }}>
          <span>
            For comparison — adaptive arithmetic order-0: <strong>{refs.a0}B</strong>, order-1:{' '}
            <strong>{refs.a1}B</strong>. PPM's higher orders reach well past what a single-byte
            context can.
          </span>
        </div>
      </Panel>

      <Panel
        title={`Where symbols got coded · order-${order}`}
        note="how many bytes were finally coded at each context length (after any escapes)"
      >
        <HBarChart bars={breakdown} valueFmt={(v) => v.toFixed(0)} unit=" sym" />
      </Panel>

      <Panel
        title="Coding trace"
        note="each cell is one input byte, tinted by the order that coded it; a taller notch = more escapes it cost first"
      >
        <TraceStrip steps={steps} />
        <div className="legend" style={{ marginTop: 12 }}>
          {Array.from({ length: order + 1 }, (_, o) => (
            <span key={o}>
              <span className="swatch" style={{ background: orderColor(o) }} />
              order {o}
            </span>
          ))}
          <span>
            <span className="swatch" style={{ background: orderColor(-1) }} />
            uniform (−1)
          </span>
        </div>
      </Panel>
    </div>
  )
}

// A compact strip: one column per byte (up to a cap), coloured by coding order,
// with a small red tick per escape so "surprising" bytes stand out visually.
function TraceStrip({ steps }: { steps: PPMStep[] }) {
  const cap = 220
  const shown = steps.slice(0, cap)
  const cw = 13
  const h = 34
  const W = Math.max(1, shown.length) * cw
  return (
    <div style={{ overflowX: 'auto' }}>
      <svg viewBox={`0 0 ${W} ${h + 18}`} width="100%" style={{ minWidth: Math.min(W, 640) }}>
        {shown.map((s, i) => {
          const x = i * cw
          return (
            <g key={i}>
              <rect x={x + 1} y={2} width={cw - 2} height={h - 4} rx={3} fill={orderColor(s.codedAtOrder)} opacity={0.85} />
              <text x={x + cw / 2} y={h / 2 + 4} textAnchor="middle" fontSize={10} fill="#0a0d13">
                {byteGlyph(s.symbol)}
              </text>
              {Array.from({ length: Math.min(s.escapes, 3) }, (_, e) => (
                <rect key={e} x={x + 2 + e * 3} y={h + 2} width={2} height={5} fill="var(--red)" />
              ))}
            </g>
          )
        })}
      </svg>
      {steps.length > cap && <div className="muted" style={{ marginTop: 6, fontSize: 12 }}>showing first {cap} of {steps.length} bytes</div>}
    </div>
  )
}
