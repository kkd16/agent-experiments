// UI defaults and small shared helpers for persisting settings.

import type { RenderOptions } from './render/Renderer'
import type { SimParams } from './sim/types'

export const DEFAULT_PARAMS: SimParams = {
  g: 1,
  theta: 0.7,
  softening: 4,
  dt: 0.08,
  integrator: 'velocity-verlet',
}

export const DEFAULT_RENDER: RenderOptions = {
  colorMap: 'inferno',
  colorBy: 'speed',
  trails: true,
  trailFade: 0.16,
  glowSize: 2.0,
  brightness: 0.85,
  showQuadtree: false,
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
