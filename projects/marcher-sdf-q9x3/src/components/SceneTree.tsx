// The scene tree (left column): the ordered node list with select / visibility /
// reorder / duplicate / delete, plus the add-primitive menu. Node order matters —
// it is the order the CSG operators fold in — so reordering is a first-class action.

import { useState } from 'react'
import type { Dispatch } from 'react'
import type { BooleanOp, SdfNode } from '../scene/types'
import type { Action } from '../state/reducer'
import { PRIMITIVES, PRIMITIVE_LIST } from '../scene/primitives'
import { rgbToHex } from './color'

const OP_GLYPH: Record<BooleanOp, string> = { union: '∪', subtract: '−', intersect: '∩' }

interface SceneTreeProps {
  nodes: SdfNode[]
  selectedId: string | null
  dispatch: Dispatch<Action>
}

export default function SceneTree({ nodes, selectedId, dispatch }: SceneTreeProps) {
  const [adding, setAdding] = useState(false)

  return (
    <div className="scene-tree">
      <div className="panel-head">
        <h2>Scene</h2>
        <span className="count">{nodes.length}</span>
      </div>

      <ul className="node-list">
        {nodes.map((node, i) => {
          const selected = node.id === selectedId
          return (
            <li key={node.id} className={`node-row ${selected ? 'selected' : ''}`}>
              <button
                type="button"
                className="vis"
                title={node.visible ? 'Hide' : 'Show'}
                aria-label={node.visible ? 'Hide node' : 'Show node'}
                onClick={() => dispatch({ type: 'toggleVisible', id: node.id })}
              >
                {node.visible ? '👁' : '·'}
              </button>
              <button
                type="button"
                className="node-main"
                onClick={() => dispatch({ type: 'select', id: node.id })}
              >
                <span className="swatch" style={{ background: rgbToHex(node.material.color) }} />
                <span className="node-name">{node.name}</span>
                <span className="node-meta">
                  {i > 0 ? (
                    <span className="op">
                      {OP_GLYPH[node.combine.op]}
                      {node.combine.smooth ? '~' : ''}
                    </span>
                  ) : (
                    <span className="op base">base</span>
                  )}
                  <span className="kind">{PRIMITIVES[node.kind].label}</span>
                </span>
              </button>
            </li>
          )
        })}
        {nodes.length === 0 ? <li className="empty">No nodes — add a primitive below.</li> : null}
      </ul>

      <div className="tree-actions">
        <button
          type="button"
          disabled={!selectedId}
          title="Move up"
          onClick={() => selectedId && dispatch({ type: 'move', id: selectedId, dir: -1 })}
        >
          ↑
        </button>
        <button
          type="button"
          disabled={!selectedId}
          title="Move down"
          onClick={() => selectedId && dispatch({ type: 'move', id: selectedId, dir: 1 })}
        >
          ↓
        </button>
        <button
          type="button"
          disabled={!selectedId}
          title="Duplicate"
          onClick={() => selectedId && dispatch({ type: 'duplicate', id: selectedId })}
        >
          ⧉
        </button>
        <button
          type="button"
          disabled={!selectedId}
          className="danger"
          title="Delete"
          onClick={() => selectedId && dispatch({ type: 'delete', id: selectedId })}
        >
          ✕
        </button>
      </div>

      <div className="add-zone">
        <button type="button" className="add-btn" onClick={() => setAdding((v) => !v)}>
          {adding ? 'Close' : '+ Add primitive'}
        </button>
        {adding ? (
          <div className="add-grid">
            {PRIMITIVE_LIST.map((kind) => (
              <button
                key={kind}
                type="button"
                onClick={() => {
                  dispatch({ type: 'add', kind })
                  setAdding(false)
                }}
              >
                {PRIMITIVES[kind].label}
              </button>
            ))}
          </div>
        ) : null}
      </div>
    </div>
  )
}
