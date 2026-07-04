// Generation worker. The full pipeline runs off the main thread so slider drags and
// panning stay responsive even on big worlds. The WorldMap is structured-cloned back
// to the UI (typed arrays and nested arrays clone natively). The UI keeps a
// synchronous fallback for environments where workers aren't available (e.g. the
// sandboxed catalog thumbnail), so this file never needs to guard for that itself.

import { generateWorld } from './generate'
import type { WorldParams } from './types'

interface Req {
  id: number
  params: WorldParams
}

self.onmessage = (e: MessageEvent<Req>): void => {
  const { id, params } = e.data
  try {
    const world = generateWorld(params)
    ;(self as unknown as Worker).postMessage({ id, world })
  } catch (err) {
    ;(self as unknown as Worker).postMessage({ id, error: String(err) })
  }
}
