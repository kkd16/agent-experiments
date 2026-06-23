import { useEffect, useRef, useState } from 'react'
import type { SheetMeta } from '../engine/workbook'

interface Props {
  sheets: SheetMeta[]
  activeId: string
  onSelect: (id: string) => void
  onAdd: () => void
  onRename: (id: string, name: string) => void
  onDelete: (id: string) => void
  onDuplicate: (id: string) => void
  onReorder: (id: string, toIndex: number) => void
}

/** The bottom sheet-tab bar: switch, add, rename (double-click), duplicate, delete,
 *  and drag to reorder — the workbook's table of contents. */
export default function SheetTabs(props: Props) {
  const { sheets, activeId } = props
  const [editing, setEditing] = useState<string | null>(null)
  const [draft, setDraft] = useState('')
  const dragId = useRef<string | null>(null)
  const inputRef = useRef<HTMLInputElement | null>(null)

  useEffect(() => {
    if (editing) inputRef.current?.select()
  }, [editing])

  const startRename = (s: SheetMeta) => {
    setEditing(s.id)
    setDraft(s.name)
  }
  const commitRename = () => {
    if (editing) props.onRename(editing, draft)
    setEditing(null)
  }

  return (
    <div className="sheet-tabs">
      <button className="sheet-add" title="New sheet" onClick={props.onAdd}>
        +
      </button>
      <div className="sheet-tab-scroll">
        {sheets.map((s, i) => {
          const active = s.id === activeId
          return (
            <div
              key={s.id}
              className={'sheet-tab' + (active ? ' active' : '')}
              draggable={editing !== s.id}
              onDragStart={() => (dragId.current = s.id)}
              onDragOver={(e) => e.preventDefault()}
              onDrop={(e) => {
                e.preventDefault()
                if (dragId.current && dragId.current !== s.id) props.onReorder(dragId.current, i)
                dragId.current = null
              }}
              onClick={() => props.onSelect(s.id)}
              onDoubleClick={() => startRename(s)}
            >
              {editing === s.id ? (
                <input
                  ref={inputRef}
                  className="sheet-rename"
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  onBlur={commitRename}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') commitRename()
                    else if (e.key === 'Escape') setEditing(null)
                    e.stopPropagation()
                  }}
                  spellCheck={false}
                />
              ) : (
                <>
                  <span className="sheet-name">{s.name}</span>
                  {active ? (
                    <span className="sheet-actions">
                      <button
                        className="sheet-mini"
                        title="Duplicate sheet"
                        onClick={(e) => {
                          e.stopPropagation()
                          props.onDuplicate(s.id)
                        }}
                      >
                        ⧉
                      </button>
                      {sheets.length > 1 ? (
                        <button
                          className="sheet-mini"
                          title="Delete sheet"
                          onClick={(e) => {
                            e.stopPropagation()
                            if (confirmDelete(s.name)) props.onDelete(s.id)
                          }}
                        >
                          ✕
                        </button>
                      ) : null}
                    </span>
                  ) : null}
                </>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}

function confirmDelete(name: string): boolean {
  try {
    return window.confirm(`Delete sheet "${name}"? This can be undone with Ctrl+Z.`)
  } catch {
    return true
  }
}
