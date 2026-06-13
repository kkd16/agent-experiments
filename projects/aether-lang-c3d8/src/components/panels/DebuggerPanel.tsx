import { useEffect, useRef, useState } from 'react'
import type { Snapshot } from '../../lang/vm.ts'
import type { Span } from '../../lang/lexer.ts'
import { valueToString } from '../../lang/values.ts'

interface Props {
  snapshots: Snapshot[] | null
  output: string[]
  onSpanChange: (span: Span | null) => void
  onRequestTrace: () => void
}

export default function DebuggerPanel({ snapshots, output, onSpanChange, onRequestTrace }: Props) {
  const [idx, setIdx] = useState(0)
  const [playing, setPlaying] = useState(false)
  const timer = useRef<number>(0)

  const count = snapshots?.length ?? 0
  const clamped = Math.min(idx, Math.max(0, count - 1))

  useEffect(() => {
    if (!snapshots || snapshots.length === 0) {
      onSpanChange(null)
      return
    }
    onSpanChange(snapshots[clamped]?.span ?? null)
  }, [snapshots, clamped, onSpanChange])

  useEffect(() => {
    if (!playing || !snapshots) return
    timer.current = window.setInterval(() => {
      setIdx((i) => {
        if (i >= snapshots.length - 1) {
          setPlaying(false)
          return i
        }
        return i + 1
      })
    }, 60)
    return () => window.clearInterval(timer.current)
  }, [playing, snapshots])

  if (!snapshots) {
    return (
      <div className="debugger-panel">
        <p className="panel-note">
          The time-travel debugger records every VM instruction so you can scrub through execution —
          watch the stack and call frames evolve step by step.
        </p>
        <button className="btn primary" onClick={onRequestTrace}>
          ⏺ Record a trace
        </button>
      </div>
    )
  }

  if (count === 0) {
    return <div className="panel-empty">Nothing executed.</div>
  }

  const snap = snapshots[clamped]
  const shownOutput = output.slice(0, snap.outputLen)
  const atEnd = clamped >= count - 1

  return (
    <div className="debugger-panel">
      <div className="dbg-controls">
        <button className="btn" onClick={() => setIdx(0)} title="Reset">
          ⏮
        </button>
        <button className="btn" onClick={() => setIdx((i) => Math.max(0, i - 1))} title="Step back">
          ◀
        </button>
        <button
          className="btn"
          onClick={() => setIdx((i) => Math.min(count - 1, i + 1))}
          title="Step forward"
        >
          ▶
        </button>
        <button className="btn" onClick={() => setIdx(count - 1)} title="Jump to end">
          ⏭
        </button>
        <button
          className={`btn ${playing ? 'active' : ''}`}
          onClick={() => setPlaying((p) => !p)}
          disabled={atEnd}
        >
          {playing ? '⏸ pause' : '▶ play'}
        </button>
        <span className="dbg-step">
          step {clamped + 1} / {count}
        </span>
      </div>

      <input
        className="dbg-slider"
        type="range"
        min={0}
        max={count - 1}
        value={clamped}
        onChange={(e) => setIdx(Number(e.target.value))}
      />

      <div className="dbg-current">
        <span className="dbg-proto">{snap.protoName}</span>
        <span className="dbg-ip">@{snap.ip}</span>
        <code className="dbg-op">{snap.opName}</code>
      </div>

      <div className="dbg-cols">
        <div className="dbg-col">
          <div className="dbg-col-head">value stack</div>
          <div className="dbg-stack">
            {snap.stack.length === 0 && <div className="dbg-empty">empty</div>}
            {snap.stack
              .map((v, i) => ({ v, i }))
              .reverse()
              .map(({ v, i }) => (
                <div className="dbg-slot" key={i}>
                  <span className="dbg-slot-i">{i}</span>
                  <code>{truncate(valueToString(v), 36)}</code>
                </div>
              ))}
          </div>
        </div>

        <div className="dbg-col">
          <div className="dbg-col-head">call frames</div>
          <div className="dbg-frames">
            {snap.frames
              .slice()
              .reverse()
              .map((f, i) => (
                <div className="dbg-frame" key={i}>
                  <code>{f.name}</code>
                  <span className="dbg-frame-meta">
                    ip {f.ip} · base {f.base}
                  </span>
                </div>
              ))}
          </div>
        </div>
      </div>

      {shownOutput.length > 0 && (
        <div className="dbg-output">
          <div className="dbg-col-head">output so far</div>
          <pre>{shownOutput.join('\n')}</pre>
        </div>
      )}
    </div>
  )
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 1) + '…' : s
}
