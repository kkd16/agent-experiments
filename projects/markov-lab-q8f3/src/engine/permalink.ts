// Round-trip the entire studio configuration through the URL hash, so any
// experiment — target, seed, burn-in, mode, and every lane's sampler + params —
// is reproducible by link. Encoding is base64url of compact JSON (all-ASCII
// here), kept resilient: any malformed hash simply yields null and the app
// falls back to its defaults.

export type Mode = 'single' | 'race'

export interface LaneConfig {
  samplerId: string
  params: Record<string, number>
}

export interface StudioConfig {
  mode: Mode
  targetId: string
  seed: number
  burnInFrac: number
  lanes: LaneConfig[]
}

function b64urlEncode(s: string): string {
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function b64urlDecode(s: string): string {
  const pad = s.length % 4 === 0 ? '' : '='.repeat(4 - (s.length % 4))
  return atob(s.replace(/-/g, '+').replace(/_/g, '/') + pad)
}

export function encodeConfig(cfg: StudioConfig): string {
  try {
    return b64urlEncode(JSON.stringify(cfg))
  } catch {
    return ''
  }
}

/** Parse a hash payload into a config, or null if it's absent/invalid. */
export function decodeConfig(hash: string): StudioConfig | null {
  const raw = hash.replace(/^#/, '').trim()
  if (!raw) return null
  try {
    const obj = JSON.parse(b64urlDecode(raw)) as Partial<StudioConfig>
    if (!obj || typeof obj !== 'object') return null
    if (obj.mode !== 'single' && obj.mode !== 'race') return null
    if (typeof obj.targetId !== 'string') return null
    if (!Array.isArray(obj.lanes) || obj.lanes.length < 1) return null
    // Validate each lane shallowly; drop anything that isn't a clean {id, params}.
    const lanes: LaneConfig[] = []
    for (const l of obj.lanes) {
      if (!l || typeof l.samplerId !== 'string' || typeof l.params !== 'object' || !l.params) return null
      const params: Record<string, number> = {}
      for (const k in l.params) {
        const v = (l.params as Record<string, unknown>)[k]
        if (typeof v === 'number' && isFinite(v)) params[k] = v
      }
      lanes.push({ samplerId: l.samplerId, params })
    }
    return {
      mode: obj.mode,
      targetId: obj.targetId,
      seed: typeof obj.seed === 'number' && isFinite(obj.seed) ? obj.seed : 1234,
      burnInFrac: typeof obj.burnInFrac === 'number' && isFinite(obj.burnInFrac) ? obj.burnInFrac : 0.1,
      lanes,
    }
  } catch {
    return null
  }
}

/** Write the config into the address bar without adding a history entry. */
export function writeHash(cfg: StudioConfig): void {
  try {
    const payload = encodeConfig(cfg)
    const url = `${window.location.pathname}${window.location.search}#${payload}`
    window.history.replaceState(null, '', url)
  } catch {
    /* history blocked (e.g. sandboxed preview) — ignore */
  }
}

/** The full shareable URL for the current config. */
export function shareUrl(cfg: StudioConfig): string {
  return `${window.location.origin}${window.location.pathname}${window.location.search}#${encodeConfig(cfg)}`
}
