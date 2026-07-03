import type { CSSProperties, ReactNode } from 'react'

// A titled card that hosts a canvas. The inner `.canvas-wrap` is the sized parent
// that useDprCanvas observes; pass the canvas as children with its ref attached.

export function CanvasCard({
  title,
  note,
  height,
  aspect,
  children,
}: {
  title: string
  note?: ReactNode
  height?: number
  aspect?: number
  children: ReactNode
}) {
  const wrapStyle: CSSProperties = aspect
    ? { aspectRatio: String(aspect) }
    : { height: height ?? 320 }
  return (
    <div className="canvas-card">
      <div className="canvas-head">
        <span className="canvas-title">{title}</span>
        {note && <span className="canvas-note">{note}</span>}
      </div>
      <div className="canvas-wrap" style={wrapStyle}>
        {children}
      </div>
    </div>
  )
}
