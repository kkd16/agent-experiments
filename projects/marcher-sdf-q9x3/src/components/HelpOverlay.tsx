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
            (tilings), <em>mirror</em> symmetry, <em>twist</em> and <em>bend</em> — plus rounding
            and hollow shells.
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
            scene. Turn on <strong>anti-alias</strong> before capturing a still.
          </li>
        </ul>

        <h3>Exporting</h3>
        <ul>
          <li><strong>Export</strong> bakes the whole scene into one standalone, dependency-free HTML file.</li>
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
