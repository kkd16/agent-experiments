// UI defaults and small shared helpers for persisting settings.

import type { RenderOptions } from './render/Renderer'
import type { SimParams } from './sim/types'

export const DEFAULT_PARAMS: SimParams = {
  g: 1,
  theta: 0.7,
  softening: 4,
  dt: 0.08,
  integrator: 'velocity-verlet',
  collide: false,
  collisionScale: 0.8,
}

export const DEFAULT_RENDER: RenderOptions = {
  colorMap: 'inferno',
  colorBy: 'speed',
  trails: true,
  trailFade: 0.16,
  glowSize: 2.0,
  brightness: 0.85,
  showQuadtree: false,
  showLegend: true,
  showField: false,
  background: '#05060c',
}

// Above this body count, skip the O(n²) potential-energy diagnostic to keep the
// frame budget; momentum and the rest stay exact.
export const EXACT_ENERGY_MAX = 5000

export interface PersistedSettings {
  render: RenderOptions
  subSteps: number
}

const KEY = 'helios.settings.v1'

export function loadSettings(): Partial<PersistedSettings> | null {
  // Thumbnails run sandboxed without same-origin storage — never let a throw
  // escape and blank the preview.
  try {
    const raw = localStorage.getItem(KEY)
    return raw ? (JSON.parse(raw) as PersistedSettings) : null
  } catch {
    return null
  }
}

export function saveSettings(s: PersistedSettings): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(s))
  } catch {
    /* ignore — sandboxed preview or storage disabled */
  }
}

// ---------------------------------------------------------------------------
// Permalinks. The whole reproducible scenario — preset, body count, seed,
// physics params, render options and steps/frame — is round-tripped through the
// URL hash so a configuration can be shared as a single link.
// ---------------------------------------------------------------------------

export interface ScenarioConfig {
  preset: string
  count: number
  seed: number
  params: SimParams
  render: RenderOptions
  subSteps: number
}

/** Encode a scenario into a compact, URL-safe hash fragment (without the `#`). */
export function encodeScenario(c: ScenarioConfig): string {
  const json = JSON.stringify(c)
  // base64url so the link survives copy/paste without percent-encoding noise.
  const b64 = btoa(unescape(encodeURIComponent(json)))
  return 's=' + b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

/** Parse a scenario from a hash fragment, or null if absent/invalid. */
export function decodeScenario(hash: string): Partial<ScenarioConfig> | null {
  try {
    const frag = hash.replace(/^#/, '')
    const params = new URLSearchParams(frag)
    const raw = params.get('s')
    if (!raw) return null
    const b64 = raw.replace(/-/g, '+').replace(/_/g, '/')
    const json = decodeURIComponent(escape(atob(b64)))
    const obj = JSON.parse(json) as Partial<ScenarioConfig>
    return obj && typeof obj === 'object' ? obj : null
  } catch {
    return null
  }
}
