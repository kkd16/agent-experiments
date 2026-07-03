// Deep-linkable mode state. Each mode serialises its controls into the hash
// query string (`#/spectrum?sig=square&freq=24`) so a link reproduces the exact
// scene. Kept tiny and dependency-free; the router (useHashRoute) already strips
// the query when matching routes.

export type ParamValue = string | number | boolean

/** Read the `?a=b&c=d` params of the current hash into a Map of strings. */
export function readHashParams(): URLSearchParams {
  try {
    const hash = window.location.hash
    const q = hash.indexOf('?')
    return new URLSearchParams(q >= 0 ? hash.slice(q + 1) : '')
  } catch {
    return new URLSearchParams('')
  }
}

/** The route portion of the hash (text after `#/`, before any `?`). */
export function currentRouteName(fallback: string): string {
  try {
    const raw = window.location.hash.replace(/^#\/?/, '')
    const route = raw.split('?')[0]
    return route || fallback
  } catch {
    return fallback
  }
}

function encode(params: Record<string, ParamValue>): string {
  const sp = new URLSearchParams()
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null) continue
    sp.set(k, typeof v === 'boolean' ? (v ? '1' : '0') : String(v))
  }
  return sp.toString()
}

/** Build a full deep-link URL for a route + params (absolute, shareable). */
export function buildShareUrl(route: string, params: Record<string, ParamValue>): string {
  const q = encode(params)
  const base = `${window.location.origin}${window.location.pathname}${window.location.search}`
  return `${base}#/${route}${q ? `?${q}` : ''}`
}

/**
 * Write the params into the current hash (without reloading) and copy the full
 * link to the clipboard. Returns a promise resolving true on a successful copy.
 * Never throws — a sandboxed context simply gets `false`.
 */
export async function shareLink(route: string, params: Record<string, ParamValue>): Promise<boolean> {
  const url = buildShareUrl(route, params)
  try {
    const q = encode(params)
    // Update the address bar in place so a manual copy also works.
    window.history.replaceState(null, '', `#/${route}${q ? `?${q}` : ''}`)
  } catch {
    /* ignore */
  }
  try {
    await navigator.clipboard.writeText(url)
    return true
  } catch {
    return false
  }
}

// ---- typed readers for restoring state from the query on mount ----

export function readNum(sp: URLSearchParams, key: string, fallback: number): number {
  const v = sp.get(key)
  if (v === null) return fallback
  const n = Number(v)
  return Number.isFinite(n) ? n : fallback
}

export function readBool(sp: URLSearchParams, key: string, fallback: boolean): boolean {
  const v = sp.get(key)
  if (v === null) return fallback
  return v === '1' || v === 'true'
}

export function readStr<T extends string>(sp: URLSearchParams, key: string, fallback: T, allowed?: readonly T[]): T {
  const v = sp.get(key) as T | null
  if (v === null) return fallback
  if (allowed && !allowed.includes(v)) return fallback
  return v
}
