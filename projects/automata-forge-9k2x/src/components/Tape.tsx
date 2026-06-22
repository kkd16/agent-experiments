// A windowed view of a Turing machine's two-way-infinite tape, with a head marker. The contiguous
// written region is passed in as `cells` starting at index `min`; we pad a couple of blank cells on
// each side and an ellipsis to suggest the infinite blank tape stretching away in both directions.

import './Tape.css'

interface Props {
  cells: string[]
  min: number
  head: number // absolute index
  blank: string
  /** Render one tape symbol (blank already mapped to a glyph by the caller). */
  show: (sym: string) => string
  /** Extra blank cells to pad on each side. */
  pad?: number
}

export default function Tape({ cells, min, head, blank, show, pad = 2 }: Props) {
  const left = Array.from({ length: pad }, () => blank)
  const right = Array.from({ length: pad }, () => blank)
  const all = [...left, ...cells, ...right]
  const headOffset = head - (min - pad)

  return (
    <div className="tm-tape-strip">
      <span className="tm-inf">…</span>
      <div className="tm-tape-cells">
        {all.map((sym, i) => {
          const isHead = i === headOffset
          const idx = min - pad + i
          return (
            <div key={i} className={`tm-tape-cell${isHead ? ' head' : ''}${sym === blank ? ' blank' : ''}`}>
              <span className="tm-tape-sym">{show(sym)}</span>
              {isHead && <span className="tm-head-tri" aria-label="head" />}
              <span className="tm-tape-idx">{idx}</span>
            </div>
          )
        })}
      </div>
      <span className="tm-inf">…</span>
    </div>
  )
}
