// The saved-gradient gallery, mirrored in localStorage. Each card decodes its compact code back
// into a live gradient preview. Load one into the studio, or delete it.

import { useState } from 'react'
import { toCSS } from '../color/gradient'
import { museGradient } from '../color/random'
import { decodeGradient, encodeGradient, loadGallery, saveGallery } from '../state/store'
import type { SavedItem } from '../state/store'
import type { Gradient } from '../color/types'
import { navigate } from '../state/router'

export function Gallery({ onUse }: { onUse: (g: Gradient) => void }) {
  const [items, setItems] = useState<SavedItem[]>(() => loadGallery())

  const remove = (id: string) => {
    const next = items.filter((i) => i.id !== id)
    setItems(next)
    saveGallery(next)
  }

  const seedSamples = () => {
    const samples: SavedItem[] = [11, 222, 3003, 40404, 7, 99, 1234].map((seed, i) => ({
      id: `seed${i}`,
      code: encodeGradient(museGradient(seed)),
      createdAt: Date.now() - i,
    }))
    setItems(samples)
    saveGallery(samples)
  }

  return (
    <div className="gallery-page">
      <div className="gallery-head">
        <p className="muted">{items.length ? `${items.length} saved gradient${items.length === 1 ? '' : 's'}.` : 'Nothing saved yet — hit ☆ Save in the studio, or seed a few.'}</p>
        {items.length === 0 && (
          <button className="btn" onClick={seedSamples}>
            ✦ Seed sample gradients
          </button>
        )}
      </div>
      <div className="gallery-grid">
        {items.map((item) => {
          const g = decodeGradient(item.code)
          if (!g) return null
          return (
            <div className="gallery-card" key={item.id}>
              <button
                className="gallery-thumb"
                style={{ background: toCSS(g) }}
                onClick={() => {
                  onUse(g)
                  navigate('studio')
                }}
                aria-label="Load this gradient"
              />
              <div className="gallery-meta">
                <span>{g.type} · {g.space}</span>
                <button className="link-btn" onClick={() => remove(item.id)}>
                  Delete
                </button>
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}
