import { useState } from 'react'
import type { Layer } from '../types'

interface LayerListProps {
  layers: Layer[]
  selectedId: string
  onSelect: (id: string) => void
  onToggleVisible: (id: string) => void
  onMove: (id: string, dir: -1 | 1) => void
  onDuplicate: (id: string) => void
  onDelete: (id: string) => void
  onRename: (id: string, name: string) => void
}

function gradientCss(colors: string[]): string {
  if (colors.length === 1) return colors[0]
  return `linear-gradient(90deg, ${colors.join(', ')})`
}

export function LayerList({
  layers,
  selectedId,
  onSelect,
  onToggleVisible,
  onMove,
  onDuplicate,
  onDelete,
  onRename,
}: LayerListProps) {
  const [editing, setEditing] = useState<string | null>(null)
  const [draft, setDraft] = useState('')

  // Topmost layer first in the list (it's drawn last / on top).
  const ordered = [...layers].reverse()

  return (
    <div className="layer-list">
      {ordered.map((layer) => {
        const idx = layers.indexOf(layer)
        const isTop = idx === layers.length - 1
        const isBottom = idx === 0
        return (
          <div
            key={layer.id}
            className={`layer-row ${layer.id === selectedId ? 'selected' : ''}`}
            onClick={() => onSelect(layer.id)}
          >
            <span
              className="layer-chip"
              style={{ background: gradientCss(layer.style.colors) }}
            />
            {editing === layer.id ? (
              <input
                className="layer-name-input"
                value={draft}
                autoFocus
                onClick={(e) => e.stopPropagation()}
                onChange={(e) => setDraft(e.target.value)}
                onBlur={() => {
                  onRename(layer.id, draft.trim() || layer.name)
                  setEditing(null)
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    onRename(layer.id, draft.trim() || layer.name)
                    setEditing(null)
                  }
                  if (e.key === 'Escape') setEditing(null)
                }}
              />
            ) : (
              <span
                className={`layer-name ${layer.visible ? '' : 'hidden'}`}
                onDoubleClick={(e) => {
                  e.stopPropagation()
                  setDraft(layer.name)
                  setEditing(layer.id)
                }}
                title="Double-click to rename"
              >
                {layer.name}
              </span>
            )}
            <div className="layer-actions" onClick={(e) => e.stopPropagation()}>
              <button
                title={layer.visible ? 'Hide' : 'Show'}
                onClick={() => onToggleVisible(layer.id)}
              >
                {layer.visible ? '👁' : '🚫'}
              </button>
              <button
                title="Move up"
                disabled={isTop}
                onClick={() => onMove(layer.id, 1)}
              >
                ↑
              </button>
              <button
                title="Move down"
                disabled={isBottom}
                onClick={() => onMove(layer.id, -1)}
              >
                ↓
              </button>
              <button title="Duplicate" onClick={() => onDuplicate(layer.id)}>
                ⧉
              </button>
              <button
                title="Delete"
                disabled={layers.length <= 1}
                onClick={() => onDelete(layer.id)}
              >
                ✕
              </button>
            </div>
          </div>
        )
      })}
    </div>
  )
}
