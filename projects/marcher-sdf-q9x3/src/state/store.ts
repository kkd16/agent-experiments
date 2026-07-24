// Persistence + initial state. Autosave/restore go through localStorage but every
// access is wrapped so the app still runs in the sandboxed catalog thumbnail (where
// storage can throw) and survives malformed saved data.

import type { Material, Modifier, Anim, Scene, SdfNode } from '../scene/types'
import {
  defaultCamera,
  defaultEnv,
  defaultGround,
  defaultPost,
  defaultQuality,
  defaultScene,
  defaultSun,
} from '../scene/presets'
import { defaultAnim, defaultMaterial, defaultModifier } from '../scene/primitives'
import type { EditorState } from './reducer'

const STORAGE_KEY = 'marcher.scene.v1'

/** Deep clone via JSON — every scene value is plain data. */
export function cloneScene(scene: Scene): Scene {
  return JSON.parse(JSON.stringify(scene)) as Scene
}

/** Backfill fields added after a scene was saved, so old nodes keep working. */
function sanitizeNode(raw: unknown): SdfNode {
  const n = (raw ?? {}) as Partial<SdfNode>
  const material: Material = { ...defaultMaterial(), ...(n.material ?? {}) }
  const modifier: Modifier = { ...defaultModifier(), ...(n.modifier ?? {}) }
  const anim: Anim = { ...defaultAnim(), ...(n.anim ?? {}) }
  return { ...(n as SdfNode), material, modifier, anim }
}

/** Fill in any missing global blocks so old/partial saves don't crash the renderer. */
function sanitize(raw: unknown): Scene | null {
  if (!raw || typeof raw !== 'object') return null
  const s = raw as Partial<Scene>
  if (!Array.isArray(s.nodes)) return null
  return {
    nodes: s.nodes.map(sanitizeNode),
    camera: { ...defaultCamera(), ...(s.camera ?? {}) },
    sun: { ...defaultSun(), ...(s.sun ?? {}) },
    env: { ...defaultEnv(), ...(s.env ?? {}) },
    ground: { ...defaultGround(), ...(s.ground ?? {}) },
    quality: { ...defaultQuality(), ...(s.quality ?? {}) },
    post: { ...defaultPost(), ...(s.post ?? {}) },
    animate: s.animate ?? true,
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
