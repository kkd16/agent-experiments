// Encode/decode a circuit into a compact, URL-safe string carried in the hash
// (`#c=...`). Everything here is wrapped so a blocked/oddball environment (e.g. the
// sandboxed catalog thumbnail) degrades to "no share" rather than throwing.
import type { SavedCircuit } from './factory'

// URL-safe base64 (RFC 4648 §5): +/ -> -_ and no padding.
function bytesToBase64Url(bytes: Uint8Array): string {
  let bin = ''
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i])
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function base64UrlToBytes(s: string): Uint8Array {
  const pad = s.length % 4 === 0 ? '' : '='.repeat(4 - (s.length % 4))
  const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/') + pad)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

/** Serialise a saved circuit to a URL-safe token, or '' if encoding is impossible. */
export function encodeCircuit(saved: SavedCircuit): string {
  try {
    const json = JSON.stringify(saved)
    return bytesToBase64Url(new TextEncoder().encode(json))
  } catch {
    return ''
  }
}

/** Parse a token back into a saved circuit, or null if it's missing/corrupt. */
export function decodeCircuit(token: string): SavedCircuit | null {
  try {
    const json = new TextDecoder().decode(base64UrlToBytes(token))
    const data = JSON.parse(json) as SavedCircuit
    if (!data || data.v !== 1 || !Array.isArray(data.comps) || !Array.isArray(data.wires)) return null
    return data
  } catch {
    return null
  }
}

/** Read a `#c=...` circuit token out of the current location hash, if present. */
export function readHashCircuit(): SavedCircuit | null {
  try {
    const h = window.location.hash.replace(/^#/, '')
    const m = /(?:^|&)c=([^&]+)/.exec(h)
    return m ? decodeCircuit(m[1]) : null
  } catch {
    return null
  }
}

/** Build a full shareable URL for a circuit (falls back to just the hash on error). */
export function shareUrl(saved: SavedCircuit): string {
  const token = encodeCircuit(saved)
  try {
    const base = window.location.href.split('#')[0]
    return `${base}#c=${token}`
  } catch {
    return `#c=${token}`
  }
}
