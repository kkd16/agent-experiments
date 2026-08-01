import { useEffect, useRef, useState } from 'react'
import type * as React from 'react'
import type { Engine } from '../logic/engine'
import type { Comp, PinRef } from '../logic/geometry'
import { bodyHeight, bodyWidth, inputPin, outputPin, snap } from '../logic/geometry'
import { kindMeta } from '../logic/kinds'
import type { Kind } from '../logic/kinds'
import type { Selection, View } from './types'
import { selectedComps } from './types'

interface Props {
  engine: Engine
  view: View
  setView: (v: View) => void
  tool: Kind | null
  onPlace: (kind: Kind, x: number, y: number) => void
  selection: Selection
  setSelection: (s: Selection) => void
  commit: () => void
  beginMutation: () => void
  endMutation: () => void
}

const SEG7_MAP: Record<number, string> = {
  0: '1111110', 1: '0110000', 2: '1101101', 3: '1111001', 4: '0110011', 5: '1011011',
  6: '1011111', 7: '1110000', 8: '1111111', 9: '1111011', 10: '1110111', 11: '0011111',
  12: '1001110', 13: '0111101', 14: '1001111', 15: '1000111',
}

type Drag =
  | null
  | { mode: 'group'; ids: string[]; primary: string; origins: Map<string, { x: number; y: number }>; sx: number; sy: number; moved: boolean }
  | { mode: 'pan'; sx: number; sy: number; vx: number; vy: number }
  | { mode: 'box'; base: string[]; ax: number; ay: number }

interface Box { ax: number; ay: number; bx: number; by: number }

function boxHit(c: Comp, x0: number, y0: number, x1: number, y1: number): boolean {
  const w = bodyWidth(c.kind)
  const h = bodyHeight(c.kind)
  return c.x < x1 && c.x + w > x0 && c.y < y1 && c.y + h > y0
}

export default function Canvas(props: Props) {
  const { engine, view, setView, tool, onPlace, selection, setSelection, commit, beginMutation, endMutation } = props
  const svgRef = useRef<SVGSVGElement | null>(null)
  const [pending, setPending] = useState<PinRef | null>(null)
  const [cursor, setCursor] = useState({ x: 0, y: 0 })
  const [panning, setPanning] = useState(false)
  const [box, setBox] = useState<Box | null>(null)
  const drag = useRef<Drag>(null)

  const selIds = selectedComps(selection)

  function toWorld(clientX: number, clientY: number) {
    const r = svgRef.current!.getBoundingClientRect()
    return { x: (clientX - r.left - view.x) / view.scale, y: (clientY - r.top - view.y) / view.scale }
  }

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') setPending(null)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  // ---- background pointer handlers ------------------------------------------
  function onBgDown(e: React.PointerEvent) {
    if (e.button === 1 || e.button === 2) return
    const w = toWorld(e.clientX, e.clientY)
    if (tool) {
      onPlace(tool, snap(w.x - bodyWidth(tool) / 2), snap(w.y - bodyHeight(tool) / 2))
      return
    }
    setPending(null)
    if (e.shiftKey) {
      // Shift-drag on empty space rubber-bands a selection box (additive).
      drag.current = { mode: 'box', base: selIds, ax: w.x, ay: w.y }
      setBox({ ax: w.x, ay: w.y, bx: w.x, by: w.y })
      svgRef.current?.setPointerCapture(e.pointerId)
      return
    }
    setSelection(null)
    drag.current = { mode: 'pan', sx: e.clientX, sy: e.clientY, vx: view.x, vy: view.y }
    setPanning(true)
    svgRef.current?.setPointerCapture(e.pointerId)
  }

  function onMove(e: React.PointerEvent) {
    const w = toWorld(e.clientX, e.clientY)
    setCursor(w)
    const d = drag.current
    if (!d) return
    if (d.mode === 'pan') {
      setView({ ...view, x: d.vx + (e.clientX - d.sx), y: d.vy + (e.clientY - d.sy) })
    } else if (d.mode === 'box') {
      const x0 = Math.min(d.ax, w.x), x1 = Math.max(d.ax, w.x)
      const y0 = Math.min(d.ay, w.y), y1 = Math.max(d.ay, w.y)
      setBox({ ax: d.ax, ay: d.ay, bx: w.x, by: w.y })
      const hits = new Set(d.base)
      for (const c of engine.comps.values()) if (boxHit(c, x0, y0, x1, y1)) hits.add(c.id)
      setSelection(hits.size ? { kind: 'comp', ids: [...hits] } : null)
    } else {
      const dx = (e.clientX - d.sx) / view.scale
      const dy = (e.clientY - d.sy) / view.scale
      if (Math.abs(dx) > 2 || Math.abs(dy) > 2) d.moved = true
      for (const id of d.ids) {
        const c = engine.comps.get(id)
        const o = d.origins.get(id)
        if (c && o) {
          c.x = o.x + dx
          c.y = o.y + dy
        }
      }
      commit()
    }
  }

  function onUp(e: React.PointerEvent) {
    const d = drag.current
    if (d && d.mode === 'group') {
      const primary = engine.comps.get(d.primary)
      if (!d.moved && d.ids.length === 1 && primary && primary.kind === 'INPUT') {
        primary.outs[0] = !primary.outs[0]
        engine.solve()
      } else if (d.moved) {
        for (const id of d.ids) {
          const c = engine.comps.get(id)
          if (c) {
            c.x = snap(c.x)
            c.y = snap(c.y)
          }
        }
      }
      commit()
      endMutation()
    }
    drag.current = null
    setPanning(false)
    setBox(null)
    try {
      svgRef.current?.releasePointerCapture(e.pointerId)
    } catch {
      // capture may not be held
    }
  }

  // ---- element handlers -----------------------------------------------------
  function onCompDown(e: React.PointerEvent, c: Comp) {
    if (tool) return
    e.stopPropagation()
    setPending(null)
    const inSel = selIds.includes(c.id)
    if (e.shiftKey) {
      // toggle membership, no drag
      const next = inSel ? selIds.filter((id) => id !== c.id) : [...selIds, c.id]
      setSelection(next.length ? { kind: 'comp', ids: next } : null)
      return
    }
    const groupIds = inSel && selIds.length > 1 ? selIds : [c.id]
    if (!inSel) setSelection({ kind: 'comp', ids: [c.id] })
    const origins = new Map<string, { x: number; y: number }>()
    for (const id of groupIds) {
      const g = engine.comps.get(id)
      if (g) origins.set(id, { x: g.x, y: g.y })
    }
    beginMutation()
    drag.current = { mode: 'group', ids: groupIds, primary: c.id, origins, sx: e.clientX, sy: e.clientY, moved: false }
    svgRef.current?.setPointerCapture(e.pointerId)
  }

  function onPinDown(e: React.PointerEvent, ref: PinRef, isOutput: boolean) {
    e.stopPropagation()
    if (pending) {
      if (!isOutput) {
        beginMutation()
        engine.addWire(pending, ref)
        endMutation()
        commit()
        setPending(null)
      } else {
        setPending(ref)
      }
    } else if (isOutput) {
      setPending(ref)
    }
  }

  function onWireDown(e: React.PointerEvent, id: string) {
    e.stopPropagation()
    setSelection({ kind: 'wire', id })
    setPending(null)
  }

  function onWheel(e: React.WheelEvent) {
    const r = svgRef.current!.getBoundingClientRect()
    const cx = e.clientX - r.left
    const cy = e.clientY - r.top
    const factor = e.deltaY < 0 ? 1.12 : 1 / 1.12
    const ns = Math.max(0.35, Math.min(2.6, view.scale * factor))
    const wx = (cx - view.x) / view.scale
    const wy = (cy - view.y) / view.scale
    setView({ scale: ns, x: cx - wx * ns, y: cy - wy * ns })
  }

  // ---- render ---------------------------------------------------------------
  const comps = Array.from(engine.comps.values())
  const cls = `board${tool ? ' placing' : ''}${panning ? ' panning' : ''}`
  const selWire = selection?.kind === 'wire' ? selection.id : null

  return (
    <svg
      ref={svgRef}
      className={cls}
      onPointerDown={onBgDown}
      onPointerMove={onMove}
      onPointerUp={onUp}
      onWheel={onWheel}
      onContextMenu={(e) => e.preventDefault()}
    >
      <defs>
        <pattern id="grid" width={24} height={24} patternUnits="userSpaceOnUse" patternTransform={`translate(${view.x} ${view.y}) scale(${view.scale})`}>
          <circle cx={1} cy={1} r={1} fill="#1b2230" />
        </pattern>
      </defs>
      <rect x={0} y={0} width="100%" height="100%" fill="url(#grid)" />

      <g transform={`translate(${view.x} ${view.y}) scale(${view.scale})`}>
        {/* wires */}
        {engine.wires.map((w) => {
          const src = engine.comps.get(w.from.comp)
          const dst = engine.comps.get(w.to.comp)
          if (!src || !dst) return null
          const a = outputPin(src, w.from.pin)
          const b = inputPin(dst, w.to.pin)
          const on = src.outs[w.from.pin] ?? false
          const dx = Math.max(30, Math.abs(b.x - a.x) * 0.5)
          const path = `M ${a.x} ${a.y} C ${a.x + dx} ${a.y}, ${b.x - dx} ${b.y}, ${b.x} ${b.y}`
          const sel = selWire === w.id
          return (
            <g key={w.id}>
              <path className="wire hit" d={path} onPointerDown={(e) => onWireDown(e, w.id)} />
              <path className={`wire${sel ? ' sel' : ''}`} d={path} stroke={on ? 'var(--wire-on)' : 'var(--wire-off)'} style={on ? { filter: 'drop-shadow(0 0 3px var(--on-glow))' } : undefined} />
            </g>
          )
        })}

        {/* pending rubber-band wire */}
        {pending &&
          (() => {
            const src = engine.comps.get(pending.comp)
            if (!src) return null
            const a = outputPin(src, pending.pin)
            const dx = Math.max(30, Math.abs(cursor.x - a.x) * 0.5)
            const path = `M ${a.x} ${a.y} C ${a.x + dx} ${a.y}, ${cursor.x - dx} ${cursor.y}, ${cursor.x} ${cursor.y}`
            return <path className="wire" d={path} stroke="var(--accent)" strokeDasharray="5 5" pointerEvents="none" />
          })()}

        {/* components */}
        {comps.map((c) => (
          <CompView
            key={c.id}
            c={c}
            engine={engine}
            selected={selIds.includes(c.id)}
            pendingActive={!!pending}
            onCompDown={onCompDown}
            onPinDown={onPinDown}
          />
        ))}

        {/* selection box */}
        {box && (
          <rect
            className="selbox"
            x={Math.min(box.ax, box.bx)}
            y={Math.min(box.ay, box.by)}
            width={Math.abs(box.bx - box.ax)}
            height={Math.abs(box.by - box.ay)}
            pointerEvents="none"
          />
        )}
      </g>
    </svg>
  )
}

interface CompProps {
  c: Comp
  engine: Engine
  selected: boolean
  pendingActive: boolean
  onCompDown: (e: React.PointerEvent, c: Comp) => void
  onPinDown: (e: React.PointerEvent, ref: PinRef, isOutput: boolean) => void
}

function CompView({ c, engine, selected, pendingActive, onCompDown, onPinDown }: CompProps) {
  const m = kindMeta(c.kind)
  const w = bodyWidth(c.kind)
  const h = bodyHeight(c.kind)
  const clickable = c.kind === 'INPUT'

  return (
    <g transform={`translate(${c.x} ${c.y})`}>
      <rect
        className={`comp-body${selected ? ' sel' : ''}`}
        width={w}
        height={h}
        rx={9}
        style={{ cursor: clickable ? 'pointer' : 'grab' }}
        onPointerDown={(e) => onCompDown(e, c)}
      />
      <CompContent c={c} engine={engine} w={w} h={h} />
      {c.kind !== 'INPUT' && c.kind !== 'OUTPUT' && c.kind !== 'SEG7' && c.kind !== 'CONST0' && c.kind !== 'CONST1' && (
        <text className="comp-title" x={w / 2} y={15}>
          {m.short}
        </text>
      )}

      {/* input pins */}
      {Array.from({ length: m.numIn }).map((_, i) => {
        const p = inputPin(c, i)
        const on = engine.inputValue(c, i)
        return (
          <g key={`i${i}`}>
            <circle className={`pin${pendingActive ? ' hot' : ''}`} cx={p.x - c.x} cy={p.y - c.y} r={5} fill={on ? 'var(--on)' : 'var(--off)'} onPointerDown={(e) => onPinDown(e, { comp: c.id, pin: i }, false)} />
            {m.inLabels[i] && (
              <text className="pin-label" x={p.x - c.x + 9} y={p.y - c.y + 3}>
                {m.inLabels[i]}
              </text>
            )}
          </g>
        )
      })}

      {/* output pins */}
      {Array.from({ length: m.numOut }).map((_, i) => {
        const p = outputPin(c, i)
        const on = c.outs[i] ?? false
        return (
          <g key={`o${i}`}>
            <circle className="pin hot" cx={p.x - c.x} cy={p.y - c.y} r={5} fill={on ? 'var(--on)' : 'var(--off)'} onPointerDown={(e) => onPinDown(e, { comp: c.id, pin: i }, true)} />
            {m.outLabels[i] && (
              <text className="pin-label" x={p.x - c.x - 14} y={p.y - c.y + 3}>
                {m.outLabels[i]}
              </text>
            )}
          </g>
        )
      })}
    </g>
  )
}

function CompContent({ c, engine, w, h }: { c: Comp; engine: Engine; w: number; h: number }) {
  if (c.kind === 'INPUT' || c.kind === 'CONST0' || c.kind === 'CONST1') {
    const on = c.outs[0] ?? false
    return (
      <>
        <text x={w / 2} y={h / 2 + 8} textAnchor="middle" fontSize={22} fontWeight={800} fill={on ? 'var(--on)' : '#5b6577'} pointerEvents="none">
          {on ? '1' : '0'}
        </text>
        {c.label && c.kind === 'INPUT' && (
          <text x={w / 2} y={14} textAnchor="middle" fontSize={10} fill="#8a93a6" pointerEvents="none">
            {c.label}
          </text>
        )}
      </>
    )
  }
  if (c.kind === 'CLOCK') {
    const on = c.outs[0] ?? false
    return (
      <>
        <path d={`M 14 ${h - 16} h 10 v -16 h 10 v 16 h 10`} fill="none" stroke={on ? 'var(--on)' : '#5b6577'} strokeWidth={2} pointerEvents="none" />
        <text x={w / 2} y={16} textAnchor="middle" fontSize={10} fill="#8a93a6" pointerEvents="none">
          {c.label ?? '1'}s
        </text>
      </>
    )
  }
  if (c.kind === 'OUTPUT') {
    const on = engine.inputValue(c, 0)
    return (
      <circle className={on ? 'led-on' : 'led-off'} cx={w / 2 + 8} cy={h / 2} r={11} strokeWidth={2} style={on ? { filter: 'drop-shadow(0 0 7px var(--on-glow))' } : undefined} pointerEvents="none" />
    )
  }
  if (c.kind === 'SEG7') {
    const val = (Number(engine.inputValue(c, 0)) << 0) | (Number(engine.inputValue(c, 1)) << 1) | (Number(engine.inputValue(c, 2)) << 2) | (Number(engine.inputValue(c, 3)) << 3)
    const seg = SEG7_MAP[val] ?? '0000000'
    const L = 26, R = 46, Tp = 30, Md = 68, Bt = 106
    const segs: [number, number, number, number][] = [
      [L, Tp, R, Tp], // a
      [R, Tp, R, Md], // b
      [R, Md, R, Bt], // c
      [L, Bt, R, Bt], // d
      [L, Md, L, Bt], // e
      [L, Tp, L, Md], // f
      [L, Md, R, Md], // g
    ]
    return (
      <g pointerEvents="none">
        {segs.map(([x1, y1, x2, y2], i) => (
          <line key={i} className={`seg${seg[i] === '1' ? ' on' : ''}`} x1={x1} y1={y1} x2={x2} y2={y2} strokeWidth={5} strokeLinecap="round" />
        ))}
      </g>
    )
  }
  return null
}
