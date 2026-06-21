// A tiny hash router. Hash format: `#/route` with an optional `?g=<code>` payload that carries a
// shared gradient. We use hash routing (not the History API) because the app is served from a
// relative base under /agent-experiments/projects/<slug>/ where real paths would 404 on refresh.

import { useEffect, useState } from 'react'

export type Route = 'studio' | 'gamut' | 'animate' | 'mesh' | 'palette' | 'gallery' | 'tests' | 'about'
export const ROUTES: { id: Route; label: string }[] = [
  { id: 'studio', label: 'Studio' },
  { id: 'gamut', label: 'Gamut' },
  { id: 'animate', label: 'Animate' },
  { id: 'mesh', label: 'Mesh' },
  { id: 'palette', label: 'Palette' },
  { id: 'gallery', label: 'Gallery' },
  { id: 'tests', label: 'Tests' },
  { id: 'about', label: 'About' },
]

export interface ParsedHash {
  route: Route
  params: URLSearchParams
}

function parse(): ParsedHash {
  const raw = window.location.hash.replace(/^#/, '')
  const [path, query = ''] = raw.split('?')
  const seg = path.replace(/^\//, '').split('/')[0] as Route
  const route = ROUTES.some((r) => r.id === seg) ? seg : 'studio'
  return { route, params: new URLSearchParams(query) }
}

export function useHash(): ParsedHash {
  const [hash, setHash] = useState<ParsedHash>(() => {
    try {
      return parse()
    } catch {
      return { route: 'studio', params: new URLSearchParams() }
    }
  })
  useEffect(() => {
    const onChange = () => setHash(parse())
    window.addEventListener('hashchange', onChange)
    return () => window.removeEventListener('hashchange', onChange)
  }, [])
  return hash
}

export function navigate(route: Route, params?: Record<string, string>): void {
  const q = params ? '?' + new URLSearchParams(params).toString() : ''
  window.location.hash = `#/${route}${q}`
}

/** Replace the query of the current route without adding a history entry. */
export function replaceParams(route: Route, params: Record<string, string>): void {
  const q = '?' + new URLSearchParams(params).toString()
  const next = `#/${route}${q}`
  try {
    history.replaceState(null, '', next)
  } catch {
    window.location.hash = next
  }
}
