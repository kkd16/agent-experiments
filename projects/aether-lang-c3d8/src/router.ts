// Minimal hash router. History-API routes break under a relative base on GitHub
// Pages, so the whole app navigates via `#/path` only.

import { useEffect, useState } from 'react'

export function currentPath(): string {
  const h = window.location.hash.replace(/^#/, '')
  return h.length === 0 ? '/' : h
}

export function navigate(path: string): void {
  window.location.hash = path
}

export function useHashRoute(): string {
  const [path, setPath] = useState(currentPath())
  useEffect(() => {
    const onHash = (): void => setPath(currentPath())
    window.addEventListener('hashchange', onHash)
    return () => window.removeEventListener('hashchange', onHash)
  }, [])
  return path
}
