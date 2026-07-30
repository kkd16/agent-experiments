// A short primer on ray marching + how to drive the studio.

import Modal from './Modal'

export default function HelpOverlay({ onClose }: { onClose: () => void }) {
  return (
    <Modal title="About Marcher" onClose={onClose}>
      <div className="help">
        <h3>What is this?</h3>
        <p>
          Marcher renders 3D scenes with <em>ray marching</em> over <em>signed distance fields</em>.
          Instead of triangles, every shape is a maths function that returns the distance to its
          nearest surface. A ray steps forward by that distance until it grazes something — no
          meshes, exact curves, and CSG (boolean) operations become trivial.
        </p>

        <h3>Building a scene</h3>
        <ul>
          <li>Add primitives from the <strong>Scene</strong> panel. The first node seeds the field.</li>
          <li>
            Each later node <strong>combines</strong> with everything above it: union, subtract or
            intersect — hard-edged, or smoothly blended with a radius.
          </li>
          <li>Order matters — reorder nodes to change how the booleans fold together.</li>
          <li>Give each node a transform and a material (colour, metallic, roughness, emission).</li>
        </ul>

        <h3>Going further</h3>
        <ul>
          <li>
            <strong>Modifiers</strong> warp a node's own space: infinite/limited <em>repeat</em>
            (tilings), <em>mirror</em> symmetry, <em>twist</em>, <em>bend</em>, <em>elongate</em>
            (stretch along each axis) and <em>polar</em> (fold into N kaleidoscopic sectors) — plus
            rounding and hollow shells.
          </li>
          <li>
            <strong>Textures</strong> weave procedural checker / noise / marble / wood / grid into a
            material's colour.
          </li>
          <li>
            <strong>Animation</strong> channels spin, bob and pulse a node over time (flip the
            master switch in the World tab).
          </li>
          <li>
            Reflective materials cast <strong>real second-bounce reflections</strong> of the actual
            scene.
          </li>
        </ul>

        <h3>Progressive rendering</h3>
        <ul>
          <li>
            With <strong>accumulation</strong> on (World → Render), the image averages many jittered
            samples while the view holds still, converging to a clean result — watch the
            <strong> spp</strong> readout climb, then freeze. Orbiting or animating resets it to stay live.
          </li>
          <li>
            <strong>Depth of field</strong> — give the camera an <em>aperture</em> and a
            <em> focus distance</em>; near and far shapes melt into bokeh.
          </li>
          <li>
            A non-zero sun <strong>angular size</strong> gives physically soft shadow penumbrae; a
            sub-pixel jitter anti-aliases every edge for free.
          </li>
          <li>
            <strong>Emissive lighting</strong> (World → Emissive lighting) makes glowing nodes act as
            coloured area lights that illuminate everything around them.
          </li>
        </ul>

        <h3>Path-traced global illumination</h3>
        <p>
          Switch <strong>World → Render → Lighting</strong> to <strong>Path trace</strong> and the
          studio becomes a real Monte-Carlo path tracer. Instead of faking indirect light with an
          ambient term, it fires stochastic rays that bounce between surfaces — each one picks up
          the colour of what it hit, so light genuinely <em>bleeds</em> from one object onto the
          next. That gives you soft indirect lighting, physically correct contact shadows and the
          colour bleeding you can't get any other way (try the <strong>Cornell Box</strong> and
          <strong> Radiance</strong> presets).
        </p>
        <ul>
          <li>
            <strong>Bounces</strong> sets how many times a ray may scatter — 1 is direct-only, 4–6 is
            a rich look, higher deepens indirect light in enclosed scenes at more cost.
          </li>
          <li>
            The sun and every emitter are sampled directly each bounce (<em>next-event
            estimation</em>), so lighting is clean; diffuse and glossy surfaces scatter the rest.
          </li>
          <li>
            <strong>Firefly clamp</strong> caps a single sample's brightness to kill the odd bright
            speckle. Path tracing needs <strong>accumulation</strong> on to converge.
          </li>
        </ul>

        <h3>Glass &amp; dispersion</h3>
        <p>
          Turn up a material's <strong>Transmission</strong> (Node → Glass) and it becomes a
          dielectric: the path tracer splits every hit into a Fresnel-weighted reflection and a
          refraction, tracing the ray through the solid and out the far side (the fast preview
          approximates the same see-through).
        </p>
        <ul>
          <li><strong>IOR</strong> sets how hard the light bends — 1.33 water, 1.5 glass, 2.4 diamond.</li>
          <li>
            <strong>Absorption</strong> tints thick glass by eating light as it travels through
            (Beer–Lambert), so a coloured absorbing glass glows from the inside.
          </li>
          <li>
            <strong>Dispersion</strong> splits the spectrum by wavelength, throwing a prism rainbow
            along refracting edges as the frame accumulates (try <strong>Prism</strong> and
            <strong> Crystal</strong>).
          </li>
        </ul>

        <h3>Bloom</h3>
        <p>
          <strong>World → Post → Bloom</strong> adds a soft HDR glare: the genuinely-bright parts of
          the linear image (emitters, hot highlights, the sun) are isolated above a
          <strong> threshold</strong>, blurred by a separable Gaussian at a chosen <strong>radius</strong>,
          and added back before tonemapping. Accumulation only — try <strong>Supernova</strong>.
        </p>

        <h3>Exporting</h3>
        <ul>
          <li>
            <strong>Export</strong> bakes the whole scene into one standalone, dependency-free HTML
            file — including the progressive path tracer, so a shared page converges to the same
            global-illumination image (with bloom) the studio shows.
          </li>
          <li><strong>Save</strong> / <strong>Load</strong> round-trip the scene as a JSON file you can share or version.</li>
          <li><strong>PNG</strong> saves the current frame straight from the canvas.</li>
        </ul>

        <h3>Camera</h3>
        <ul>
          <li><strong>Drag</strong> to orbit · <strong>Shift-drag</strong> (or right-drag) to pan · <strong>Scroll</strong> to zoom.</li>
          <li>Toggle auto-rotate in the <strong>World</strong> tab.</li>
        </ul>

        <h3>Shortcuts</h3>
        <ul className="keys">
          <li><kbd>A</kbd> add a sphere</li>
          <li><kbd>D</kbd> duplicate selected · <kbd>Delete</kbd> remove selected</li>
          <li><kbd>R</kbd> toggle auto-rotate · <kbd>G</kbd> view GLSL</li>
          <li><kbd>P</kbd> capture PNG · <kbd>E</kbd> export HTML</li>
          <li><kbd>S</kbd> save scene JSON · <kbd>O</kbd> open scene JSON</li>
          <li><kbd>1</kbd>–<kbd>9</kbd> load a preset</li>
        </ul>

        <p className="help-foot">
          Everything is generated GLSL — open the <strong>GLSL</strong> panel to read the distance
          function your scene compiles to. Scenes autosave to your browser.
        </p>
      </div>
    </Modal>
  )
}
