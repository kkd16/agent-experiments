import { useMemo } from 'react'
import type { BoardView } from '../view'
import { orderedSquares, pieceAt } from '../view'
import { GLYPH } from '../pieces'
import { WHITE, fileOf, rankOf } from '../engine'

interface BoardProps {
  view: BoardView
  whiteOnBottom: boolean
  selected: number | null
  targets: number[]
  arrow: { from: number; to: number } | null
  interactive: boolean
  onSquareClick: (square: number) => void
  onDragStartSquare: (square: number) => void
  onDropSquare: (square: number) => void
}

function center(square: number, whiteOnBottom: boolean): { x: number; y: number } {
  const f = fileOf(square)
  const r = rankOf(square)
  const col = whiteOnBottom ? f : 7 - f
  const row = whiteOnBottom ? 7 - r : r
  return { x: col + 0.5, y: row + 0.5 }
}

export default function Board({
  view,
  whiteOnBottom,
  selected,
  targets,
  arrow,
  interactive,
  onSquareClick,
  onDragStartSquare,
  onDropSquare,
}: BoardProps) {
  const squares = useMemo(() => orderedSquares(whiteOnBottom), [whiteOnBottom])
  const targetSet = useMemo(() => new Set(targets), [targets])

  return (
    <div className="board-wrap">
      <div className="board" role="grid" aria-label="chess board">
        {squares.map((sq) => {
          const f = fileOf(sq)
          const r = rankOf(sq)
          const dark = (f + r) % 2 === 0
          const piece = pieceAt(view.board, sq)
          const isSelected = selected === sq
          const isTarget = targetSet.has(sq)
          const isCapture = isTarget && piece !== null
          const isLast = view.lastMove && (view.lastMove.from === sq || view.lastMove.to === sq)
          const isCheck = view.checkSquare === sq
          const showFile = whiteOnBottom ? r === 0 : r === 7
          const showRank = whiteOnBottom ? f === 0 : f === 7

          const classes = ['sq', dark ? 'dark' : 'light']
          if (isSelected) classes.push('selected')
          if (isLast) classes.push('last')
          if (isCheck) classes.push('check')

          return (
            <div
              key={sq}
              className={classes.join(' ')}
              role="gridcell"
              onClick={() => onSquareClick(sq)}
              onDragOver={(e) => {
                if (interactive) e.preventDefault()
              }}
              onDrop={(e) => {
                e.preventDefault()
                onDropSquare(sq)
              }}
            >
              {showRank && <span className="coord rank">{r + 1}</span>}
              {showFile && <span className="coord file">{'abcdefgh'[f]}</span>}
              {isTarget && !isCapture && <span className="dot" />}
              {isCapture && <span className="capture-ring" />}
              {piece && (
                <span
                  className={`piece ${piece.color === WHITE ? 'white' : 'black'}`}
                  draggable={interactive}
                  onDragStart={(e) => {
                    if (!interactive) {
                      e.preventDefault()
                      return
                    }
                    onDragStartSquare(sq)
                  }}
                >
                  {GLYPH[piece.type]}
                </span>
              )}
            </div>
          )
        })}
      </div>

      {arrow && (
        <svg className="arrow-layer" viewBox="0 0 8 8" preserveAspectRatio="none" aria-hidden>
          <defs>
            <marker id="ah" markerWidth="4" markerHeight="4" refX="2.2" refY="2" orient="auto">
              <path d="M0,0 L4,2 L0,4 Z" fill="rgba(80,200,120,0.85)" />
            </marker>
          </defs>
          {(() => {
            const a = center(arrow.from, whiteOnBottom)
            const b = center(arrow.to, whiteOnBottom)
            return (
              <line
                x1={a.x}
                y1={a.y}
                x2={b.x}
                y2={b.y}
                stroke="rgba(80,200,120,0.85)"
                strokeWidth={0.16}
                strokeLinecap="round"
                markerEnd="url(#ah)"
              />
            )
          })()}
        </svg>
      )}
    </div>
  )
}
