// Browser side-effects for the export features: copy text to the clipboard, download a text file,
// and serialise a live <svg> into a standalone, self-styled SVG file. All are best-effort and wrap
// the platform APIs in try/catch so a sandboxed thumbnail preview can never throw.

export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    try {
      const ta = document.createElement('textarea')
      ta.value = text
      ta.style.position = 'fixed'
      ta.style.opacity = '0'
      document.body.appendChild(ta)
      ta.select()
      const ok = document.execCommand('copy')
      document.body.removeChild(ta)
      return ok
    } catch {
      return false
    }
  }
}

export function downloadText(filename: string, text: string, type = 'text/plain'): void {
  try {
    const blob = new Blob([text], { type })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = filename
    document.body.appendChild(a)
    a.click()
    document.body.removeChild(a)
    setTimeout(() => URL.revokeObjectURL(url), 1000)
  } catch {
    /* download blocked (e.g. sandbox) — silently ignore */
  }
}

// The on-screen SVG styles its nodes/edges via external CSS classes; a standalone file needs those
// rules baked in. This is the minimal palette the diagram actually uses, matching Graph.css.
const SVG_STYLE = `
  .edge-path { stroke: #6b78b0; stroke-width: 1.8; fill: none; }
  .start-arrow { stroke: #5cc8ff; stroke-width: 2; }
  .arrowhead { fill: #6b78b0; }
  .edge-label { fill: #c7d0ee; font-family: monospace; font-size: 13px; }
  .node-circle { fill: #2a3358; stroke: #5b6aa8; stroke-width: 2; }
  .accept-ring { fill: none; stroke: #46e0a0; stroke-width: 2; }
  .node-label { fill: #e7ecf7; font-family: monospace; font-size: 15px; font-weight: 600; }
  .node-sub { fill: #8a94b3; font-family: monospace; font-size: 10px; }
  .node.active .node-circle { fill: #ffcc66; stroke: #ffe09a; }
  .node.active .node-label { fill: #1a1300; }
`

export function downloadSvg(svg: SVGSVGElement, filename: string): void {
  try {
    const clone = svg.cloneNode(true) as SVGSVGElement
    const vb = svg.getAttribute('viewBox')
    if (vb) {
      const [, , w, h] = vb.split(/\s+/).map(Number)
      clone.setAttribute('width', String(Math.round(w)))
      clone.setAttribute('height', String(Math.round(h)))
    }
    clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg')
    // Drop the dotted background and the interactive cursor by neutralising the class.
    clone.removeAttribute('class')
    const style = document.createElementNS('http://www.w3.org/2000/svg', 'style')
    style.textContent = SVG_STYLE
    clone.insertBefore(style, clone.firstChild)
    const bg = document.createElementNS('http://www.w3.org/2000/svg', 'rect')
    bg.setAttribute('x', String(vb ? vb.split(/\s+/)[0] : 0))
    bg.setAttribute('y', String(vb ? vb.split(/\s+/)[1] : 0))
    bg.setAttribute('width', '100%')
    bg.setAttribute('height', '100%')
    bg.setAttribute('fill', '#0b0e16')
    clone.insertBefore(bg, style.nextSibling)
    const text = '<?xml version="1.0" encoding="UTF-8"?>\n' + new XMLSerializer().serializeToString(clone)
    downloadText(filename, text, 'image/svg+xml')
  } catch {
    /* serialisation blocked — ignore */
  }
}
