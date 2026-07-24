// Shows the live GLSL that the current scene compiles to — specifically the
// generated `map()` distance function that gets embedded in the full raymarcher.

import { useState } from 'react'
import Modal from './Modal'

interface GlslViewerProps {
  glsl: string
  onClose: () => void
}

export default function GlslViewer({ glsl, onClose }: GlslViewerProps) {
  const [copied, setCopied] = useState(false)

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(glsl)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1400)
    } catch {
      setCopied(false)
    }
  }

  return (
    <Modal title="Generated GLSL — map()" onClose={onClose} wide>
      <p className="modal-intro">
        Your scene is compiled to this signed-distance function on the fly. It is embedded in a
        full WebGL2 raymarcher (camera, soft shadows, ambient occlusion, tonemapping) alongside a
        library of primitive SDFs. Per-node numbers arrive as uniforms, so editing a slider updates
        this function's inputs without recompiling.
      </p>
      <div className="glsl-actions">
        <button type="button" onClick={copy}>
          {copied ? 'Copied ✓' : 'Copy'}
        </button>
      </div>
      <pre className="glsl-code">
        <code>{glsl || '// add a node to generate a distance field'}</code>
      </pre>
    </Modal>
  )
}
