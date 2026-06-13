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
          {table.columns.map((c) => (
            <button key={c.name} className="schema-col" onClick={() => onInsert(c.name)}>
              <span className="schema-col-name">{c.name}</span>
              <span className="schema-col-type">{c.type}</span>
              {c.primaryKey && <span className="badge pk">PK</span>}
              {c.unique && !c.primaryKey && <span className="badge uq">UQ</span>}
              {c.notNull && !c.primaryKey && <span className="badge nn">NN</span>}
            </button>
          ))}
          {table.indexes.map((idx) => (
            <div key={idx.name} className="schema-index" title={`B+Tree on ${idx.column}`}>
              <span className="idx-glyph">⌗</span>
              <span className="idx-name">{idx.column}</span>
              <span className="idx-stats">
                B+Tree h={idx.stats.height} · {idx.stats.nodes} nodes
              </span>
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
