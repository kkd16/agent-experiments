// Scene persistence: autosave to localStorage, shareable URL hash, and JSON
// export/import. Every storage/URL access is wrapped so the app keeps working
// in the sandboxed catalog thumbnail (where localStorage and history can throw).

import type { FrameModel } from './engine/frame'
import type { DriveType } from './engine/harmonic'
import type { GroundRecord } from './engine/seismic'
import type { Colormap } from './ui/colormap'

export type FrameAnalysis = 'static' | 'modal' | 'buckling' | 'response' | 'harmonic' | 'pushover' | 'seismic'

export interface Display {
  deformScale: number
  autoDeform: boolean
  colorBy: 'force' | 'stress'
  field: 'vm' | 'disp'
  colormap: Colormap
  showUndeformed: boolean
  showLoads: boolean
  showReactions: boolean
  showLabels: boolean
  showMesh: boolean
  analysis?: FrameAnalysis
  respZeta?: number // damping ratio for transient response
  harmZeta?: number // damping ratio for the forced-harmonic FRF
  driveHz?: number // drive frequency (Hz) for the forced-harmonic sweep
  driveType?: DriveType // force / rotating unbalance / base excitation
  pushSecondOrder?: boolean // include P-Δ geometric stiffness in the pushover
  seisRecord?: GroundRecord // ground-motion record for the seismic time-history
  seisPga?: number // target peak ground acceleration (g)
  seisZeta?: number // modal damping ratio for the seismic response
}

export interface Scene {
  version: 1
  tab: 'frame' | 'continuum'
  frame: FrameModel
  continuum: { presetId: string; density: number }
  display: Display
}

const KEY = 'keystone.scene.v1'

export function saveLocal(scene: Scene): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(scene))
  } catch {
    /* sandboxed preview — ignore */
  }
}

export function loadLocal(): Scene | null {
  try {
    const raw = localStorage.getItem(KEY)
    if (!raw) return null
    return JSON.parse(raw) as Scene
  } catch {
    return null
  }
}

// URL-safe base64 of the JSON, kept in the hash so a scene is a link.
function toB64(s: string): string {
  const bytes = new TextEncoder().encode(s)
  let bin = ''
  for (const b of bytes) bin += String.fromCharCode(b)
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}
function fromB64(s: string): string {
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/')
  const bin = atob(b64)
  const bytes = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
  return new TextDecoder().decode(bytes)
}

export function encodeHash(scene: Scene): string {
  try {
    return toB64(JSON.stringify(scene))
  } catch {
    return ''
  }
}

export function decodeHash(hash: string): Scene | null {
  try {
    const h = hash.replace(/^#/, '')
    if (!h) return null
    return JSON.parse(fromB64(h)) as Scene
  } catch {
    return null
  }
}

export function writeHash(scene: Scene): void {
  try {
    const enc = encodeHash(scene)
    if (enc) history.replaceState(null, '', `#${enc}`)
  } catch {
    /* ignore */
  }
}

export function readHash(): Scene | null {
  try {
    return decodeHash(location.hash)
  } catch {
    return null
  }
}

export function downloadJSON(scene: Scene, name = 'keystone-model.json'): void {
  try {
    const blob = new Blob([JSON.stringify(scene, null, 2)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = name
    a.click()
    setTimeout(() => URL.revokeObjectURL(url), 1000)
  } catch {
    /* ignore */
  }
}

export function cloneFrame(m: FrameModel): FrameModel {
  return {
    type: m.type,
    nodes: m.nodes.map((n) => ({ ...n })),
    members: m.members.map((mm) => ({ ...mm })),
    loads: m.loads.map((l) => ({ ...l })),
  }
}
