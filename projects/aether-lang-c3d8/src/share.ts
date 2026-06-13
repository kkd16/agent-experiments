// One-shot hand-off used when the Examples gallery opens a program in the
// playground. The playground consumes it once on mount.

let pending: string | null = null

export function setPendingCode(code: string): void {
  pending = code
}

export function consumePendingCode(): string | null {
  const c = pending
  pending = null
  return c
}

const STORAGE_KEY = 'aether.code'

export function saveCode(code: string): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, code)
  } catch {
    // storage unavailable (private mode, etc.) — ignore
  }
}

export function loadSavedCode(): string | null {
  try {
    return window.localStorage.getItem(STORAGE_KEY)
  } catch {
    return null
  }
}

// base64 of UTF-8, URL-safe enough to live in the hash
export function encodeShareParam(code: string): string {
  return btoa(encodeURIComponent(code))
}

function decodeShareParam(param: string): string | null {
  try {
    return decodeURIComponent(atob(param))
  } catch {
    return null
  }
}

/** Read `?c=…` out of the current hash, if present. */
export function readShareParam(): string | null {
  const hash = window.location.hash
  const qi = hash.indexOf('?')
  if (qi === -1) return null
  const c = new URLSearchParams(hash.slice(qi + 1)).get('c')
  return c ? decodeShareParam(c) : null
}

/** Build a shareable URL that opens the playground with this code. */
export function buildShareUrl(code: string): string {
  const { origin, pathname } = window.location
  return `${origin}${pathname}#/?c=${encodeShareParam(code)}`
}
