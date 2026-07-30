// Scene ⇄ file JSON. A thin, versioned wrapper over the same sanitiser the
// autosave uses, so a scene saved to disk round-trips cleanly and an old or
// hand-edited file still loads (missing fields are backfilled, junk is rejected).

import type { Scene } from './types'
import { sanitize } from '../state/store'

const FORMAT = 'marcher-scene'
const VERSION = 1

interface SceneFile {
  format: string
  version: number
  scene: Scene
}

/** Serialise a scene to a pretty-printed JSON document for download. */
export function serializeScene(scene: Scene): string {
  const doc: SceneFile = { format: FORMAT, version: VERSION, scene }
  return JSON.stringify(doc, null, 2)
}

/**
 * Parse a scene document produced by {@link serializeScene}. Accepts both the
 * wrapped `{format, version, scene}` shape and a bare scene object, and runs the
 * result through the shared sanitiser. Returns `null` if the text isn't usable.
 */
export function parseScene(text: string): Scene | null {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    return null
  }
  if (raw && typeof raw === 'object' && 'scene' in raw) {
    const doc = raw as Partial<SceneFile>
    if (doc.format && doc.format !== FORMAT) return null
    return sanitize(doc.scene)
  }
  return sanitize(raw)
}
