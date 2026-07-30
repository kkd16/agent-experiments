// The inspector (right column, upper): every property of the selected node —
// primitive kind, CSG combine op, primitive params, transform and material.

import type { Dispatch } from 'react'
import type { DomainMod, PrimitiveKind, SdfNode, TextureKind } from '../scene/types'
import type { Action } from '../state/reducer'
import {
  DOMAIN_LABELS,
  DOMAIN_LIST,
  OP_LABELS,
  OP_LIST,
  PRIMITIVES,
  PRIMITIVE_LIST,
  TEXTURE_LABELS,
  TEXTURE_LIST,
} from '../scene/primitives'
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
        <Segmented<TextureKind>
          label="Texture"
          value={node.material.texture}
          options={TEXTURE_LIST.map((t) => ({ value: t, label: TEXTURE_LABELS[t] }))}
          onChange={(texture) => dispatch({ type: 'patchMaterial', id, patch: { texture } })}
        />
        {node.material.texture !== 'none' ? (
          <>
            <Slider
              label="Texture scale"
              value={node.material.texScale}
              min={0.2}
              max={12}
              step={0.1}
              onChange={(texScale) => dispatch({ type: 'patchMaterial', id, patch: { texScale } })}
            />
            <Slider
              label="Texture strength"
              value={node.material.texStrength}
              min={0}
              max={1}
              step={0.01}
              onChange={(texStrength) => dispatch({ type: 'patchMaterial', id, patch: { texStrength } })}
            />
          </>
        ) : null}
      </Section>

      <Section title="Glass">
        <Slider
          label="Transmission"
          value={node.material.transmission}
          min={0}
          max={1}
          step={0.01}
          onChange={(transmission) => dispatch({ type: 'patchMaterial', id, patch: { transmission } })}
        />
        {node.material.transmission > 0 ? (
          <>
            <p className="hint">
              A dielectric surface: the path tracer splits each hit into a Fresnel reflection and a
              refraction (and the fast preview approximates a see-through). Best under Path trace.
            </p>
            <Slider
              label="IOR"
              value={node.material.ior}
              min={1}
              max={2.6}
              step={0.01}
              onChange={(ior) => dispatch({ type: 'patchMaterial', id, patch: { ior } })}
            />
            <Slider
              label="Absorption"
              value={node.material.absorption}
              min={0}
              max={6}
              step={0.05}
              format={(v) => (v <= 0 ? 'clear' : v.toFixed(2))}
              onChange={(absorption) => dispatch({ type: 'patchMaterial', id, patch: { absorption } })}
            />
            {node.material.absorption > 0 ? (
              <p className="hint">Thick glass eats light toward the colour's complement — tint it here via the material Colour.</p>
            ) : null}
            <Slider
              label="Dispersion"
              value={node.material.dispersion}
              min={0}
              max={1}
              step={0.01}
              format={(v) => (v <= 0 ? 'off' : v.toFixed(2))}
              onChange={(dispersion) => dispatch({ type: 'patchMaterial', id, patch: { dispersion } })}
            />
            {node.material.dispersion > 0 ? (
              <p className="hint">Splits wavelengths into a prism rainbow at refractive edges — resolves under accumulation.</p>
            ) : null}
          </>
        ) : (
          <p className="hint">Turn up Transmission to make this node glass.</p>
        )}
      </Section>

      <ModifierSection node={node} dispatch={dispatch} />
      <AnimationSection node={node} dispatch={dispatch} />
    </div>
  )
}

interface SubProps {
  node: SdfNode
  dispatch: Dispatch<Action>
}

function ModifierSection({ node, dispatch }: SubProps) {
  const id = node.id
  const m = node.modifier
  return (
    <Section title="Modifier">
      <Segmented<DomainMod>
        label="Domain warp"
        value={m.domain}
        options={DOMAIN_LIST.map((d) => ({ value: d, label: DOMAIN_LABELS[d] }))}
        onChange={(domain) => dispatch({ type: 'patchModifier', id, patch: { domain } })}
      />

      {m.domain === 'repeat' ? (
        <>
          <Vec3Field
            label="Cell spacing (0 = off)"
            value={m.repeat}
            min={0}
            max={6}
            step={0.05}
            onChange={(repeat) => dispatch({ type: 'patchModifier', id, patch: { repeat } })}
          />
          <Slider
            label="Cell limit (0 = ∞)"
            value={m.repeatLimit}
            min={0}
            max={8}
            step={1}
            format={(v) => (v === 0 ? '∞' : v.toFixed(0))}
            onChange={(repeatLimit) => dispatch({ type: 'patchModifier', id, patch: { repeatLimit } })}
          />
        </>
      ) : null}

      {m.domain === 'mirror' ? (
        <Vec3Field
          label="Fold axes (0/1)"
          value={m.mirror}
          min={0}
          max={1}
          step={1}
          onChange={(mirror) => dispatch({ type: 'patchModifier', id, patch: { mirror } })}
        />
      ) : null}

      {m.domain === 'twist' ? (
        <Slider
          label="Twist / height"
          value={m.twist}
          min={-4}
          max={4}
          step={0.05}
          onChange={(twist) => dispatch({ type: 'patchModifier', id, patch: { twist } })}
        />
      ) : null}

      {m.domain === 'bend' ? (
        <Slider
          label="Bend"
          value={m.bend}
          min={-2}
          max={2}
          step={0.02}
          onChange={(bend) => dispatch({ type: 'patchModifier', id, patch: { bend } })}
        />
      ) : null}

      {m.domain === 'elongate' ? (
        <Vec3Field
          label="Stretch per axis"
          value={m.elongate}
          min={0}
          max={2}
          step={0.02}
          onChange={(elongate) => dispatch({ type: 'patchModifier', id, patch: { elongate } })}
        />
      ) : null}

      {m.domain === 'polar' ? (
        <Slider
          label="Sectors"
          value={m.polar}
          min={2}
          max={24}
          step={1}
          format={(v) => v.toFixed(0)}
          onChange={(polar) => dispatch({ type: 'patchModifier', id, patch: { polar } })}
        />
      ) : null}

      <Slider
        label="Round edges"
        value={m.round}
        min={0}
        max={0.6}
        step={0.005}
        format={(v) => v.toFixed(3)}
        onChange={(round) => dispatch({ type: 'patchModifier', id, patch: { round } })}
      />
      <Toggle
        label="Hollow shell"
        value={m.shellOn}
        onChange={(shellOn) => dispatch({ type: 'patchModifier', id, patch: { shellOn } })}
      />
      {m.shellOn ? (
        <Slider
          label="Shell thickness"
          value={m.shell}
          min={0.01}
          max={0.4}
          step={0.005}
          format={(v) => v.toFixed(3)}
          onChange={(shell) => dispatch({ type: 'patchModifier', id, patch: { shell } })}
        />
      ) : null}
    </Section>
  )
}

function AnimationSection({ node, dispatch }: SubProps) {
  const id = node.id
  const a = node.anim
  return (
    <Section title="Animation">
      <Toggle
        label="Animate this node"
        value={a.enabled}
        onChange={(enabled) => dispatch({ type: 'patchAnim', id, patch: { enabled } })}
      />
      {a.enabled ? (
        <>
          <Vec3Field
            label="Spin °/s"
            value={a.spin}
            min={-180}
            max={180}
            step={1}
            onChange={(spin) => dispatch({ type: 'patchAnim', id, patch: { spin } })}
          />
          <Vec3Field
            label="Bob amplitude"
            value={a.posAmp}
            min={0}
            max={3}
            step={0.05}
            onChange={(posAmp) => dispatch({ type: 'patchAnim', id, patch: { posAmp } })}
          />
          <Vec3Field
            label="Bob speed"
            value={a.posSpeed}
            min={0}
            max={6}
            step={0.05}
            onChange={(posSpeed) => dispatch({ type: 'patchAnim', id, patch: { posSpeed } })}
          />
          <Slider
            label="Scale pulse"
            value={a.scalePulse}
            min={0}
            max={0.6}
            step={0.01}
            onChange={(scalePulse) => dispatch({ type: 'patchAnim', id, patch: { scalePulse } })}
          />
          <Slider
            label="Pulse speed"
            value={a.scaleSpeed}
            min={0}
            max={6}
            step={0.05}
            onChange={(scaleSpeed) => dispatch({ type: 'patchAnim', id, patch: { scaleSpeed } })}
          />
          <p className="hint">Needs the global Animate switch (World tab) on.</p>
        </>
      ) : null}
    </Section>
  )
}
