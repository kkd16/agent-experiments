import type { ReactNode } from 'react'

// Small presentational primitives reused across every page. Kept deliberately
// thin — the interesting code is in src/lib; these just give it a consistent skin.

export function Stat({
  label,
  value,
  unit,
  sub,
  accent,
}: {
  label: string
  value: ReactNode
  unit?: string
  sub?: ReactNode
  accent?: boolean
}) {
  return (
    <div className={`stat${accent ? ' accent' : ''}`}>
      <div className="stat-label">{label}</div>
      <div className="stat-value">
        {value}
        {unit && <span className="unit">{unit}</span>}
      </div>
      {sub && <div className="stat-sub">{sub}</div>}
    </div>
  )
}

export function Panel({
  title,
  note,
  right,
  children,
}: {
  title?: string
  note?: string
  right?: ReactNode
  children: ReactNode
}) {
  return (
    <section className="panel">
      {(title || right) && (
        <div className="panel-head">
          <div>
            {title && <h3>{title}</h3>}
            {note && <div className="panel-note">{note}</div>}
          </div>
          {right}
        </div>
      )}
      {children}
    </section>
  )
}

export function SectionTitle({ children }: { children: ReactNode }) {
  return <div className="section-title">{children}</div>
}

export function PageHeader({
  kicker,
  title,
  lede,
}: {
  kicker: string
  title: string
  lede: ReactNode
}) {
  return (
    <header>
      <div className="page-kicker">{kicker}</div>
      <h1 className="page-title">{title}</h1>
      <p className="lede">{lede}</p>
    </header>
  )
}
