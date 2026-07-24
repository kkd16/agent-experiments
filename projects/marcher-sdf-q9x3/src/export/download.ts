// Tiny browser-download helpers. Every DOM/Blob access is guarded so the studio
// still runs inside the sandboxed catalog thumbnail (where these can throw).

function triggerDownload(url: string, filename: string, revoke: boolean): void {
  try {
    const a = document.createElement('a')
    a.href = url
    a.download = filename
    document.body.appendChild(a)
    a.click()
    document.body.removeChild(a)
    if (revoke) setTimeout(() => URL.revokeObjectURL(url), 4000)
  } catch {
    // Sandboxed preview or download blocked — ignore.
  }
}

/** Download a text blob (e.g. the exported HTML) as a file. */
export function downloadText(text: string, filename: string, mime = 'text/html'): void {
  try {
    const blob = new Blob([text], { type: mime })
    triggerDownload(URL.createObjectURL(blob), filename, true)
  } catch {
    // Ignore.
  }
}

/** Download a data URL (e.g. a canvas PNG) as a file. */
export function downloadDataUrl(dataUrl: string, filename: string): void {
  if (!dataUrl) return
  triggerDownload(dataUrl, filename, false)
}
