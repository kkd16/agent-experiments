// The inspector (right column, upper): every property of the selected node —
// primitive kind, CSG combine op, primitive params, transform and material.

import type { Dispatch } from 'react'
import type { PrimitiveKind, SdfNode } from '../scene/types'
import type { Action } from '../state/reducer'
import { OP_LABELS, OP_LIST, PRIMITIVES, PRIMITIVE_LIST } from '../scene/primitives'
import { ColorField, Section, Segmented, Slider, Toggle, Vec3Field } from './controls'

interface InspectorProps {
  node: SdfNode | null
  isBase: boolean
  dispatch: Dispatch<Action>
}

export default function Inspector({ node, isBase, dispatch }: InspectorProps) {
  if (!node) {
    return (
      <div className="inspector empty-panel">
        <p>Select a node to edit it, or add a primitive from the scene panel.</p>
      </div>
    )
  }

  const spec = PRIMITIVES[node.kind]
  const id = node.id

  return (
    <div className="inspector">
      <div className="panel-head">
        <input
          className="name-input"
          value={node.name}
          aria-label="Node name"
          onChange={(e) => dispatch({ type: 'rename', id, name: e.target.value })}
        />
      </div>

      <Section title="Primitive">
        <Segmented<PrimitiveKind>
          value={node.kind}
          options={PRIMITIVE_LIST.map((k) => ({ value: k, label: PRIMITIVES[k].label }))}
          onChange={(kind) => dispatch({ type: 'setKind', id, kind })}
        />
        {spec.params.map((p) => (
          <Slider
            key={p.key}
            label={p.label}
            value={node.params[p.slot] ?? 0}
            min={p.min}
            max={p.max}
            step={p.step}
            onChange={(v) => dispatch({ type: 'setParam', id, slot: p.slot, value: v })}
          />
        ))}
        {spec.params.length === 0 ? <p className="hint">This primitive has no size parameters.</p> : null}
      </Section>

      {!isBase ? (
        <Section title="Combine with field above">
          <Segmented
            value={node.combine.op}
            options={OP_LIST.map((op) => ({ value: op, label: OP_LABELS[op] }))}
            onChange={(op) => dispatch({ type: 'patchCombine', id, patch: { op } })}
          />
          <Toggle
            label="Smooth blend"
            value={node.combine.smooth}
            onChange={(smooth) => dispatch({ type: 'patchCombine', id, patch: { smooth } })}
          />
          {node.combine.smooth ? (
            <Slider
              label="Blend radius"
              value={node.combine.radius}
              min={0.01}
              max={1.5}
              step={0.01}
              onChange={(radius) => dispatch({ type: 'patchCombine', id, patch: { radius } })}
            />
          ) : null}
        </Section>
      ) : (
        <Section title="Combine">
          <p className="hint">This is the base node — it seeds the field, so it has no combine op.</p>
        </Section>
      )}

      <Section title="Transform">
        <Vec3Field
          label="Position"
          value={node.transform.position}
          min={-10}
          max={10}
          step={0.05}
          onChange={(position) => dispatch({ type: 'patchTransform', id, patch: { position } })}
        />
        <Vec3Field
          label="Rotation°"
          value={node.transform.rotation}
          min={-360}
          max={360}
          step={1}
          onChange={(rotation) => dispatch({ type: 'patchTransform', id, patch: { rotation } })}
        />
        <Slider
          label="Scale"
          value={node.transform.scale}
          min={0.1}
          max={4}
          step={0.01}
          onChange={(scale) => dispatch({ type: 'patchTransform', id, patch: { scale } })}
        />
      </Section>

      <Section title="Material">
        <ColorField
          label="Colour"
          value={node.material.color}
          onChange={(color) => dispatch({ type: 'patchMaterial', id, patch: { color } })}
        />
        <Slider
          label="Metallic"
          value={node.material.metallic}
          min={0}
          max={1}
          step={0.01}
          onChange={(metallic) => dispatch({ type: 'patchMaterial', id, patch: { metallic } })}
        />
        <Slider
          label="Roughness"
          value={node.material.roughness}
          min={0}
          max={1}
          step={0.01}
          onChange={(roughness) => dispatch({ type: 'patchMaterial', id, patch: { roughness } })}
        />
        <Slider
          label="Reflectivity"
          value={node.material.reflectivity}
          min={0}
          max={1}
          step={0.01}
          onChange={(reflectivity) => dispatch({ type: 'patchMaterial', id, patch: { reflectivity } })}
        />
        <Slider
          label="Emission"
          value={node.material.emission}
          min={0}
          max={1}
          step={0.01}
          onChange={(emission) => dispatch({ type: 'patchMaterial', id, patch: { emission } })}
        />
      </Section>
    </div>
  )
}
