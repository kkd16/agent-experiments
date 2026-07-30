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

/**
 * Open a native file picker and resolve with the chosen file's text contents.
 * Resolves with `null` if the user cancels or file reading is unavailable
 * (e.g. the sandboxed catalog thumbnail).
 */
export function pickTextFile(accept = 'application/json,.json'): Promise<string | null> {
  return new Promise((resolve) => {
    try {
      const input = document.createElement('input')
      input.type = 'file'
      input.accept = accept
      input.style.display = 'none'
      input.addEventListener('change', () => {
        const file = input.files?.[0]
        input.remove()
        if (!file) {
          resolve(null)
          return
        }
        file
          .text()
          .then((t) => resolve(t))
          .catch(() => resolve(null))
      })
      // If the dialog is dismissed we simply never resolve; callers treat that as a no-op.
      document.body.appendChild(input)
      input.click()
    } catch {
      resolve(null)
    }
  })
}
