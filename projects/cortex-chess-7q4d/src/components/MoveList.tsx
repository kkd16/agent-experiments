import { useEffect, useRef } from 'react'

interface MoveListProps {
  sans: string[]
}

export default function MoveList({ sans }: MoveListProps) {
  const endRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: 'end' })
  }, [sans.length])

  const rows: { num: number; white: string; black: string }[] = []
  for (let i = 0; i < sans.length; i += 2) {
    rows.push({ num: i / 2 + 1, white: sans[i], black: sans[i + 1] ?? '' })
  }

  return (
    <div className="movelist">
      {rows.length === 0 && <div className="movelist-empty">No moves yet.</div>}
      {rows.map((row) => (
        <div className="move-row" key={row.num}>
          <span className="move-num">{row.num}.</span>
          <span className="move-cell">{row.white}</span>
          <span className="move-cell">{row.black}</span>
        </div>
      ))}
      <div ref={endRef} />
    </div>
  )
}
