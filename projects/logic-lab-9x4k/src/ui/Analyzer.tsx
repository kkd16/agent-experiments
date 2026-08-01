import { useRef, useState } from 'react'
import type * as React from 'react'
import type { Engine, Probe } from '../logic/engine'
import { traceToCsv } from '../logic/exporter'

interface Props {
  engine: Engine
  onClose: () => void
  onClear: () => void
}

const ROW_H = 30
const GUTTER = 96
const PLOT_W = 1200
const PAD = 12
const HI = 6 // y offset of a logic-1 level within a row
const LO = ROW_H - 10 // y offset of a logic-0 level

const ROLE_LABEL: Record<Probe['role'], string> = { in: 'input', clk: 'clock', q: 'flip-flop', out: 'LED' }

/** Disambiguate repeated probe labels ("Q", "Q") into "Q", "Q·2", … */
function displayLabels(probes: Probe[]): string[] {
  const seen = new Map<string, number>()
  return probes.map((p) => {
    const n = (seen.get(p.label) ?? 0) + 1
    seen.set(p.label, n)
    return n === 1 ? p.label : `${p.label}·${n}`
  })
}

/** Build a stepped digital-waveform path for one probe across the trace. */
function wavePath(samples: { t: number; v: boolean[] }[], idx: number, x0: number, x1: number, tStart: number, tSpan: number): string {
  if (samples.length === 0) return ''
  const xOf = (t: number) => x0 + ((t - tStart) / tSpan) * (x1 - x0)
  const yOf = (on: boolean) => (on ? HI : LO)
  let d = ''
  let prevY = yOf(samples[0].v[idx])
  d += `M ${xOf(samples[0].t).toFixed(1)} ${prevY}`
  for (let i = 1; i < samples.length; i++) {
    const x = xOf(samples[i].t)
    const y = yOf(samples[i].v[idx])
    d += ` L ${x.toFixed(1)} ${prevY}`
    if (y !== prevY) d += ` L ${x.toFixed(1)} ${y}`
    prevY = y
  }
  d += ` L ${x1.toFixed(1)} ${prevY}`
  return d
}

/** Trigger a client-side download; silently no-ops if the environment blocks it. */
function download(name: string, text: string) {
  try {
    const blob = new Blob([text], { type: 'text/csv' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = name
    a.click()
    setTimeout(() => URL.revokeObjectURL(url), 0)
  } catch {
    // downloads may be blocked (e.g. sandboxed preview) — ignore
  }
}

export default function Analyzer({ engine, onClose, onClear }: Props) {
  const probes = engine.traceProbes
  const samples = engine.trace
  const labels = displayLabels(probes)
  const svgRef = useRef<SVGSVGElement | null>(null)
  const [cursor, setCursor] = useState<number | null>(null) // viewBox x, or null

  const tStart = samples.length ? samples[0].t : 0
  const tEnd = samples.length ? samples[samples.length - 1].t : 1
  const tSpan = Math.max(1e-3, tEnd - tStart)
  const x0 = GUTTER + PAD
  const x1 = PLOT_W - PAD
  const totalH = Math.max(ROW_H, probes.length * ROW_H) + 8

  function onScopeMove(e: React.PointerEvent) {
    const el = svgRef.current
    if (!el) return
    const r = el.getBoundingClientRect()
    const vbX = ((e.clientX - r.left) / r.width) * PLOT_W
    setCursor(vbX >= GUTTER && vbX <= PLOT_W ? vbX : null)
  }
  const cursorTime = cursor != null ? tStart + ((cursor - x0) / (x1 - x0)) * tSpan : null

  return (
    <div className="analyzer">
      <header>
        <h3>Logic analyzer</h3>
        <span className="meta">
          {probes.length === 0
            ? 'no signals yet'
            : `${probes.length} signal${probes.length > 1 ? 's' : ''} · ${samples.length} samples · ${tEnd.toFixed(2)}s`}
          {cursorTime != null && probes.length > 0 && ` · cursor ${Math.max(0, cursorTime).toFixed(2)}s`}
        </span>
        <div className="spacer" />
        <button
          className="btn ghost"
          disabled={probes.length === 0 || samples.length === 0}
          onClick={() => download('logiclab-trace.csv', traceToCsv(probes, samples))}
          title="Download the recorded waveforms as CSV"
        >
          ⤓ CSV
        </button>
        <button className="btn ghost" onClick={onClear} title="Erase recorded waveforms">
          Clear trace
        </button>
        <button className="btn ghost close" onClick={onClose} title="Hide the analyzer">
          ✕
        </button>
      </header>
      <div className="analyzer-body">
        {probes.length === 0 ? (
          <p className="msg" style={{ padding: '0 4px' }}>
            Press <b>Run</b> (or <b>Step</b>) with at least one input, clock, flip-flop or LED on the board and
            their waveforms are recorded here — a live timing diagram of the circuit.
          </p>
        ) : (
          <svg
            ref={svgRef}
            className="scope"
            viewBox={`0 0 ${PLOT_W} ${totalH}`}
            preserveAspectRatio="none"
            width="100%"
            height={totalH}
            onPointerMove={onScopeMove}
            onPointerLeave={() => setCursor(null)}
          >
            {probes.map((p, r) => {
              const on = samples.length ? samples[samples.length - 1].v[r] : false
              // Row-local coordinates: the whole group is translated down by r*ROW_H,
              // so the waveform's HI/LO levels land inside this row rather than the first.
              return (
                <g key={p.id} transform={`translate(0 ${r * ROW_H})`}>
                  <rect x={0} y={0} width={PLOT_W} height={ROW_H} className={r % 2 ? 'scope-row alt' : 'scope-row'} />
                  <line x1={GUTTER} y1={0} x2={PLOT_W} y2={0} className="scope-grid" />
                  <text x={10} y={15} className={`scope-name role-${p.role}`}>
                    {labels[r]}
                  </text>
                  <text x={10} y={26} className="scope-role">
                    {ROLE_LABEL[p.role]}
                  </text>
                  <path d={wavePath(samples, r, x0, x1, tStart, tSpan)} className={`scope-wave${on ? ' hot' : ''}`} />
                </g>
              )
            })}
            <line x1={GUTTER} y1={0} x2={GUTTER} y2={totalH} className="scope-axis" />
            {cursor != null && <line x1={cursor} y1={0} x2={cursor} y2={totalH} className="scope-cursor" />}
          </svg>
        )}
      </div>
    </div>
  )
}
