import { type Color, WHITE } from '../engine'

interface EvalBarProps {
  score: number // side-to-move perspective (centipawns)
  mate: number | null
  turn: Color
  whiteOnBottom: boolean
  hasEval: boolean
}

export default function EvalBar({ score, mate, turn, whiteOnBottom, hasEval }: EvalBarProps) {
  // Convert to White's perspective.
  const whiteScore = turn === WHITE ? score : -score
  const whiteMate = mate === null ? null : turn === WHITE ? mate : -mate

  let fill: number // fraction filled white (0..1)
  let label: string
  if (!hasEval) {
    fill = 0.5
    label = '—'
  } else if (whiteMate !== null) {
    fill = whiteMate > 0 ? 1 : 0
    label = `M${Math.abs(whiteMate)}`
  } else {
    fill = 1 / (1 + Math.exp(-whiteScore / 400))
    const pawns = whiteScore / 100
    label = (pawns >= 0 ? '+' : '') + pawns.toFixed(1)
  }

  // White fills from the side White is on.
  const whitePct = Math.round(fill * 100)
  const gradient = whiteOnBottom
    ? `linear-gradient(to top, #eef1f7 ${whitePct}%, #20242e ${whitePct}%)`
    : `linear-gradient(to bottom, #eef1f7 ${whitePct}%, #20242e ${whitePct}%)`

  const labelOnTop = whiteOnBottom ? fill < 0.5 : fill >= 0.5

  return (
    <div className="evalbar" style={{ background: gradient }} title={`Evaluation: ${label}`}>
      <span className={`eval-label ${labelOnTop ? 'top' : 'bottom'} ${fill >= 0.5 ? 'dark-text' : 'light-text'}`}>
        {label}
      </span>
    </div>
  )
}
