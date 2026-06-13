// Minimal hash router. Hash routing is mandatory here because the app is served from a
// relative base on GitHub Pages, where History-API routes 404 on refresh.

import { useEffect, useState } from 'react'

export function currentPath(): string {
  const hash = window.location.hash.replace(/^#/, '')
  return hash || '/'
}

export function navigate(path: string): void {
  window.location.hash = path
}

export function useRoute(): string {
  const [path, setPath] = useState(currentPath())
  useEffect(() => {
    const onChange = () => setPath(currentPath())
    window.addEventListener('hashchange', onChange)
    return () => window.removeEventListener('hashchange', onChange)
  }, [])
  return path
}

/**
 * Match a path against a pattern with `:param` segments.
 * Returns the captured params, or null if it doesn't match.
 */
export function match(pattern: string, path: string): Record<string, string> | null {
  const pp = pattern.split('/').filter(Boolean)
  const ap = path.split('/').filter(Boolean)
  if (pp.length !== ap.length) return null
  const params: Record<string, string> = {}
  for (let i = 0; i < pp.length; i++) {
    if (pp[i].startsWith(':')) params[pp[i].slice(1)] = decodeURIComponent(ap[i])
    else if (pp[i] !== ap[i]) return null
  }
  return params
}
