import { useEffect, useState } from 'react'
import './App.css'
import type { Gradient } from './color/types'
import { decodeGradient, defaultGradient, encodeGradient } from './state/store'
import { navigate, replaceParams, ROUTES, useHash } from './state/router'
import { Studio } from './ui/Studio'
import { Gamut } from './ui/Gamut'
import { Animate } from './ui/Animate'
import { Mesh } from './ui/Mesh'
import { Palette } from './ui/Palette'
import { Gallery } from './ui/Gallery'
import { Tests } from './ui/Tests'
import { About } from './ui/About'

function initialGradient(): Gradient {
  try {
    const raw = window.location.hash.replace(/^#/, '')
    const query = raw.split('?')[1] ?? ''
    const code = new URLSearchParams(query).get('g')
    if (code) {
      const g = decodeGradient(code)
      if (g) return g
    }
  } catch {
    /* fall through */
  }
  return defaultGradient()
}

export default function App() {
  const { route } = useHash()
  const [gradient, setGradient] = useState<Gradient>(initialGradient)

  // Keep the studio URL shareable: mirror the current gradient into ?g= while on the studio route.
  useEffect(() => {
    if (route === 'studio') replaceParams('studio', { g: encodeGradient(gradient) })
  }, [gradient, route])

  return (
    <div className="app">
      <header className="topbar">
        <button className="brand" onClick={() => navigate('studio')}>
          <span className="brand-mark" aria-hidden="true" />
          Gradient<span className="brand-accent">Lab</span>
        </button>
        <nav className="nav">
          {ROUTES.map((r) => (
            <button key={r.id} className={r.id === route ? 'is-active' : ''} onClick={() => navigate(r.id)}>
              {r.label}
            </button>
          ))}
        </nav>
      </header>

      <main className="content">
        {route === 'studio' && <Studio gradient={gradient} setGradient={setGradient} />}
        {route === 'gamut' && <Gamut gradient={gradient} setGradient={setGradient} />}
        {route === 'animate' && <Animate gradient={gradient} />}
        {route === 'mesh' && <Mesh />}
        {route === 'palette' && <Palette onUse={setGradient} />}
        {route === 'gallery' && <Gallery onUse={setGradient} />}
        {route === 'tests' && <Tests />}
        {route === 'about' && <About />}
      </main>
    </div>
  )
}
