// The world panel (right column, "World" tab): camera, sun, environment, ground,
// render quality and post-processing — everything that isn't a single node.

import type { Dispatch } from 'react'
import type { Scene } from '../scene/types'
import type { Action } from '../state/reducer'
import { ColorField, Section, Slider, Toggle, Vec3Field } from './controls'

interface GlobalPanelProps {
  scene: Scene
  dispatch: Dispatch<Action>
}

export default function GlobalPanel({ scene, dispatch }: GlobalPanelProps) {
  const { camera, sun, env, ground, quality, post, render } = scene

  return (
    <div className="global-panel">
      <Section title="Render">
        <Toggle
          label="Progressive accumulation"
          value={render.accumulate}
          onChange={(accumulate) => dispatch({ type: 'patchRender', patch: { accumulate } })}
        />
        <p className="hint">
          Averages many jittered samples while the view holds still — depth-of-field, soft
          shadows and anti-aliasing sharpen over a second or two, then freeze.
        </p>
        {render.accumulate ? (
          <Slider
            label="Max samples"
            value={render.maxSamples}
            min={16}
            max={1024}
            step={16}
            format={(v) => v.toFixed(0)}
            onChange={(maxSamples) => dispatch({ type: 'patchRender', patch: { maxSamples } })}
          />
        ) : null}
      </Section>

      <Section title="Motion">
        <Toggle
          label="Animate scene"
          value={scene.animate}
          onChange={(value) => dispatch({ type: 'setAnimate', value })}
        />
        <p className="hint">Master switch for per-node animation channels (set them in the Node tab).</p>
      </Section>

      <Section title="Camera">
        <Vec3Field
          label="Target"
          value={camera.target}
          min={-10}
          max={10}
          step={0.05}
          onChange={(target) => dispatch({ type: 'patchCamera', patch: { target } })}
        />
        <Slider
          label="Distance"
          value={camera.distance}
          min={1.2}
          max={45}
          step={0.1}
          onChange={(distance) => dispatch({ type: 'patchCamera', patch: { distance } })}
        />
        <Slider
          label="Azimuth°"
          value={camera.azimuth}
          min={-180}
          max={180}
          step={1}
          format={(v) => v.toFixed(0)}
          onChange={(azimuth) => dispatch({ type: 'patchCamera', patch: { azimuth } })}
        />
        <Slider
          label="Elevation°"
          value={camera.elevation}
          min={-85}
          max={85}
          step={1}
          format={(v) => v.toFixed(0)}
          onChange={(elevation) => dispatch({ type: 'patchCamera', patch: { elevation } })}
        />
        <Slider
          label="FOV°"
          value={camera.fov}
          min={20}
          max={90}
          step={1}
          format={(v) => v.toFixed(0)}
          onChange={(fov) => dispatch({ type: 'patchCamera', patch: { fov } })}
        />
        <Toggle
          label="Auto-rotate"
          value={camera.autoRotate}
          onChange={(autoRotate) => dispatch({ type: 'patchCamera', patch: { autoRotate } })}
        />
        {camera.autoRotate ? (
          <Slider
            label="Spin speed"
            value={camera.autoRotateSpeed}
            min={-40}
            max={40}
            step={1}
            format={(v) => v.toFixed(0)}
            onChange={(autoRotateSpeed) => dispatch({ type: 'patchCamera', patch: { autoRotateSpeed } })}
          />
        ) : null}
        <Slider
          label="Aperture (DoF)"
          value={camera.aperture}
          min={0}
          max={0.4}
          step={0.005}
          format={(v) => v.toFixed(3)}
          onChange={(aperture) => dispatch({ type: 'patchCamera', patch: { aperture } })}
        />
        {camera.aperture > 0 ? (
          <Slider
            label="Focus distance"
            value={camera.focusDistance}
            min={0.5}
            max={30}
            step={0.1}
            onChange={(focusDistance) => dispatch({ type: 'patchCamera', patch: { focusDistance } })}
          />
        ) : null}
        {camera.aperture > 0 && !render.accumulate ? (
          <p className="hint">Depth-of-field needs progressive accumulation on (Render section).</p>
        ) : null}
      </Section>

      <Section title="Sun">
        <Slider
          label="Azimuth°"
          value={sun.azimuth}
          min={-180}
          max={180}
          step={1}
          format={(v) => v.toFixed(0)}
          onChange={(azimuth) => dispatch({ type: 'patchSun', patch: { azimuth } })}
        />
        <Slider
          label="Elevation°"
          value={sun.elevation}
          min={2}
          max={88}
          step={1}
          format={(v) => v.toFixed(0)}
          onChange={(elevation) => dispatch({ type: 'patchSun', patch: { elevation } })}
        />
        <ColorField
          label="Colour"
          value={sun.color}
          onChange={(color) => dispatch({ type: 'patchSun', patch: { color } })}
        />
        <Slider
          label="Intensity"
          value={sun.intensity}
          min={0}
          max={3}
          step={0.01}
          onChange={(intensity) => dispatch({ type: 'patchSun', patch: { intensity } })}
        />
        <Slider
          label="Angular size°"
          value={sun.angle}
          min={0}
          max={20}
          step={0.5}
          format={(v) => v.toFixed(1)}
          onChange={(angle) => dispatch({ type: 'patchSun', patch: { angle } })}
        />
        {sun.angle > 0 && render.accumulate ? (
          <p className="hint">A wider sun softens shadow penumbrae as the frame accumulates.</p>
        ) : null}
      </Section>

      <Section title="Environment">
        <ColorField label="Sky" value={env.skyColor} onChange={(skyColor) => dispatch({ type: 'patchEnv', patch: { skyColor } })} />
        <ColorField
          label="Horizon"
          value={env.horizonColor}
          onChange={(horizonColor) => dispatch({ type: 'patchEnv', patch: { horizonColor } })}
        />
        <ColorField
          label="Ground bounce"
          value={env.groundColor}
          onChange={(groundColor) => dispatch({ type: 'patchEnv', patch: { groundColor } })}
        />
        <Slider
          label="Ambient"
          value={env.ambient}
          min={0}
          max={1.5}
          step={0.01}
          onChange={(ambient) => dispatch({ type: 'patchEnv', patch: { ambient } })}
        />
        <Slider
          label="Fog density"
          value={env.fogDensity}
          min={0}
          max={0.12}
          step={0.001}
          format={(v) => v.toFixed(3)}
          onChange={(fogDensity) => dispatch({ type: 'patchEnv', patch: { fogDensity } })}
        />
        <ColorField label="Fog colour" value={env.fogColor} onChange={(fogColor) => dispatch({ type: 'patchEnv', patch: { fogColor } })} />
      </Section>

      <Section title="Emissive lighting">
        <Toggle
          label="Emitters light the scene"
          value={env.emissive}
          onChange={(emissive) => dispatch({ type: 'patchEnv', patch: { emissive } })}
        />
        <p className="hint">
          Nodes with an Emission value act as coloured area lights, spilling onto everything
          nearby with inverse-square falloff.
        </p>
        {env.emissive ? (
          <>
            <Slider
              label="Strength"
              value={env.emissiveStrength}
              min={0}
              max={4}
              step={0.05}
              onChange={(emissiveStrength) => dispatch({ type: 'patchEnv', patch: { emissiveStrength } })}
            />
            <Toggle
              label="Emissive shadows"
              value={env.emissiveShadows}
              onChange={(emissiveShadows) => dispatch({ type: 'patchEnv', patch: { emissiveShadows } })}
            />
            <p className="hint">Shadows from emitters are costlier but give crisp contact darkening.</p>
          </>
        ) : null}
      </Section>

      <Section title="Ground">
        <Toggle label="Enabled" value={ground.enabled} onChange={(enabled) => dispatch({ type: 'patchGround', patch: { enabled } })} />
        <Slider
          label="Height"
          value={ground.height}
          min={-4}
          max={2}
          step={0.05}
          onChange={(height) => dispatch({ type: 'patchGround', patch: { height } })}
        />
        <Toggle label="Checker" value={ground.checker} onChange={(checker) => dispatch({ type: 'patchGround', patch: { checker } })} />
        <ColorField label="Colour A" value={ground.color1} onChange={(color1) => dispatch({ type: 'patchGround', patch: { color1 } })} />
        <ColorField label="Colour B" value={ground.color2} onChange={(color2) => dispatch({ type: 'patchGround', patch: { color2 } })} />
      </Section>

      <Section title="Quality">
        <Slider
          label="Max steps"
          value={quality.maxSteps}
          min={40}
          max={400}
          step={5}
          format={(v) => v.toFixed(0)}
          onChange={(maxSteps) => dispatch({ type: 'patchQuality', patch: { maxSteps } })}
        />
        <Slider
          label="Far distance"
          value={quality.maxDist}
          min={20}
          max={200}
          step={1}
          format={(v) => v.toFixed(0)}
          onChange={(maxDist) => dispatch({ type: 'patchQuality', patch: { maxDist } })}
        />
        <Slider
          label="Surface ε"
          value={quality.surfaceEps}
          min={0.0004}
          max={0.01}
          step={0.0002}
          format={(v) => v.toFixed(4)}
          onChange={(surfaceEps) => dispatch({ type: 'patchQuality', patch: { surfaceEps } })}
        />
        <Slider
          label="Shadow softness"
          value={quality.shadowSoftness}
          min={2}
          max={48}
          step={1}
          format={(v) => v.toFixed(0)}
          onChange={(shadowSoftness) => dispatch({ type: 'patchQuality', patch: { shadowSoftness } })}
        />
        <Slider
          label="Shadow strength"
          value={quality.shadowStrength}
          min={0}
          max={1}
          step={0.01}
          onChange={(shadowStrength) => dispatch({ type: 'patchQuality', patch: { shadowStrength } })}
        />
        <Slider
          label="AO strength"
          value={quality.aoStrength}
          min={0}
          max={1}
          step={0.01}
          onChange={(aoStrength) => dispatch({ type: 'patchQuality', patch: { aoStrength } })}
        />
        <Toggle
          label="Reflections"
          value={quality.reflections}
          onChange={(reflections) => dispatch({ type: 'patchQuality', patch: { reflections } })}
        />
        <Toggle
          label="Anti-alias (2×2)"
          value={quality.antialias}
          onChange={(antialias) => dispatch({ type: 'patchQuality', patch: { antialias } })}
        />
        <Slider
          label="Resolution"
          value={quality.resolutionScale}
          min={0.25}
          max={1}
          step={0.05}
          format={(v) => `${Math.round(v * 100)}%`}
          onChange={(resolutionScale) => dispatch({ type: 'patchQuality', patch: { resolutionScale } })}
        />
      </Section>

      <Section title="Post">
        <Slider
          label="Exposure"
          value={post.exposure}
          min={0.2}
          max={3}
          step={0.01}
          onChange={(exposure) => dispatch({ type: 'patchPost', patch: { exposure } })}
        />
        <Slider
          label="Gamma"
          value={post.gamma}
          min={1}
          max={3}
          step={0.01}
          onChange={(gamma) => dispatch({ type: 'patchPost', patch: { gamma } })}
        />
        <Slider
          label="Vignette"
          value={post.vignette}
          min={0}
          max={1}
          step={0.01}
          onChange={(vignette) => dispatch({ type: 'patchPost', patch: { vignette } })}
        />
        <Slider
          label="Saturation"
          value={post.saturation}
          min={0}
          max={2}
          step={0.01}
          onChange={(saturation) => dispatch({ type: 'patchPost', patch: { saturation } })}
        />
      </Section>
    </div>
  )
}
