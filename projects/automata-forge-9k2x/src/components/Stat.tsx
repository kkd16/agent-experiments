// A single labelled stat chip shown in the stats line of each view.
export function Stat({ k, v, title }: { k: string; v: number; title: string }) {
  return (
    <span className="stat" title={title}>
      <span className="stat-k">{k}</span>
      <span className="stat-v">{v}</span>
    </span>
  )
}
