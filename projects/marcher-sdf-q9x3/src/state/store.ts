// Persistence + initial state. Autosave/restore go through localStorage but every
// access is wrapped so the app still runs in the sandboxed catalog thumbnail (where
// storage can throw) and survives malformed saved data.

import type { Scene } from '../scene/types'
import {
  defaultCamera,
  defaultEnv,
  defaultGround,
  defaultPost,
  defaultQuality,
  defaultScene,
  defaultSun,
} from '../scene/presets'
import type { EditorState } from './reducer'

const STORAGE_KEY = 'marcher.scene.v1'

/** Deep clone via JSON — every scene value is plain data. */
export function cloneScene(scene: Scene): Scene {
  return JSON.parse(JSON.stringify(scene)) as Scene
}

/** Fill in any missing global blocks so old/partial saves don't crash the renderer. */
function sanitize(raw: unknown): Scene | null {
  if (!raw || typeof raw !== 'object') return null
  const s = raw as Partial<Scene>
  if (!Array.isArray(s.nodes)) return null
  return {
    nodes: s.nodes,
    camera: { ...defaultCamera(), ...(s.camera ?? {}) },
    sun: { ...defaultSun(), ...(s.sun ?? {}) },
    env: { ...defaultEnv(), ...(s.env ?? {}) },
    ground: { ...defaultGround(), ...(s.ground ?? {}) },
    quality: { ...defaultQuality(), ...(s.quality ?? {}) },
    post: { ...defaultPost(), ...(s.post ?? {}) },
  }
}

export function loadPersisted(): Scene | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return null
    return sanitize(JSON.parse(raw))
  } catch {
    return null
  }
}

export function persist(scene: Scene): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(scene))
  } catch {
    // Ignore — sandboxed preview or storage disabled.
  }
}

export function clearPersisted(): void {
  try {
    localStorage.removeItem(STORAGE_KEY)
  } catch {
    // Ignore.
  }
}

export function initState(): EditorState {
  const restored = loadPersisted()
  const scene = restored ?? defaultScene()
  return { scene, selectedId: scene.nodes[0]?.id ?? null }
}
