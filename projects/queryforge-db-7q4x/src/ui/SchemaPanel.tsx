// Left sidebar: live schema browser + sample query launcher. Clicking a
// table/column inserts its name into the editor; clicking a sample loads it.

import { useState } from 'react'
import type { TableInfo } from '../db/introspect'
import { SAMPLE_QUERIES } from '../db/sampleData'

interface Props {
  schema: TableInfo[]
  onInsert: (text: string) => void
  onLoadSample: (sql: string) => void
}

function TableCard({ table, onInsert }: { table: TableInfo; onInsert: (t: string) => void }) {
  const [open, setOpen] = useState(true)
  const statFor = (name: string) => table.stats?.find((s) => s.column.toLowerCase() === name.toLowerCase())
  const con = table.constraints
  const fkCols = new Map<string, string>() // column → "parent.col"
  for (const fk of con.foreignKeys) {
    fk.columns.forEach((c, i) => fkCols.set(c.toLowerCase(), `${fk.refTable}.${fk.refColumns[i] ?? ''}`))
  }
  const actionTag = (fk: { onDelete: string; onUpdate: string }) => {
    const parts: string[] = []
    if (fk.onDelete !== 'NO ACTION') parts.push(`ON DELETE ${fk.onDelete}`)
    if (fk.onUpdate !== 'NO ACTION') parts.push(`ON UPDATE ${fk.onUpdate}`)
    return parts.join(' · ')
  }
  return (
    <div className="schema-table">
      <button className="schema-table-head" onClick={() => setOpen((o) => !o)}>
        <span className={`twisty ${open ? 'open' : ''}`}>▸</span>
        <span className="schema-table-name" onClick={(e) => (e.stopPropagation(), onInsert(table.name))}>
          {table.name}
        </span>
        <span className="schema-rowcount">{table.rowCount} rows</span>
      </button>
      {open && (
        <div className="schema-cols">
          {table.columns.map((c) => {
            const st = statFor(c.name)
            return (
            <button key={c.name} className="schema-col" onClick={() => onInsert(c.name)}>
              <span className="schema-col-name">{c.name}</span>
              <span className="schema-col-type">
                {c.type === 'DECIMAL' && c.precision !== undefined
                  ? `DECIMAL(${c.precision}${c.scale !== undefined ? `,${c.scale}` : ''})`
                  : c.type}
              </span>
              {c.primaryKey && <span className="badge pk">PK</span>}
              {c.unique && !c.primaryKey && <span className="badge uq">UQ</span>}
              {c.notNull && !c.primaryKey && <span className="badge nn">NN</span>}
              {fkCols.has(c.name.toLowerCase()) && (
                <span className="badge fk" title={`references ${fkCols.get(c.name.toLowerCase())}`}>FK</span>
              )}
              {con.defaults[c.name] && (
                <span className="badge df" title={`DEFAULT ${con.defaults[c.name]}`}>={con.defaults[c.name]}</span>
              )}
              {st && <span className="schema-colstat" title="distinct values · nulls (from ANALYZE)">{st.ndistinct}d{st.nullCount ? ` · ${st.nullCount}∅` : ''}</span>}
            </button>
            )
          })}
          {table.indexes.map((idx) => (
            <div key={idx.name} className="schema-index" title={`B+Tree on ${idx.columns.join(', ')}`}>
              <span className="idx-glyph">⌗</span>
              <span className="idx-name">
                {idx.columns.join(', ')}
                {idx.unique && <span className="badge uq">UQ</span>}
              </span>
              <span className="idx-stats">
                B+Tree h={idx.stats.height} · {idx.stats.nodes} nodes
              </span>
            </div>
          ))}
          {con.primaryKey && con.primaryKey.length > 1 && (
            <div className="schema-constraint" title="composite primary key">
              <span className="con-glyph">⚷</span> PRIMARY KEY ({con.primaryKey.join(', ')})
            </div>
          )}
          {con.foreignKeys.map((fk, i) => (
            <div key={`fk${i}`} className="schema-constraint fk" title={`foreign key${actionTag(fk) ? ` — ${actionTag(fk)}` : ''}`}>
              <span className="con-glyph">↗</span> {fk.columns.join(', ')} → {fk.refTable}({fk.refColumns.join(', ')})
              {actionTag(fk) && <span className="con-action">{actionTag(fk)}</span>}
            </div>
          ))}
          {con.checks.map((chk, i) => (
            <div key={`ck${i}`} className="schema-constraint check" title="check constraint">
              <span className="con-glyph">✓</span> CHECK ({chk.sql})
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

export function SchemaPanel({ schema, onInsert, onLoadSample }: Props) {
  return (
    <aside className="sidebar">
      <div className="sidebar-section">
        <h3 className="sidebar-title">Schema</h3>
        {schema.length === 0 && <p className="sidebar-empty">No tables. Create one to begin.</p>}
        {schema.map((t) => (
          <TableCard key={t.name} table={t} onInsert={onInsert} />
        ))}
      </div>

      <div className="sidebar-section">
        <h3 className="sidebar-title">Example queries</h3>
        <div className="sample-list">
          {SAMPLE_QUERIES.map((s) => (
            <button key={s.title} className="sample-item" onClick={() => onLoadSample(s.sql)}>
              {s.title}
            </button>
          ))}
        </div>
      </div>
    </aside>
  )
}
