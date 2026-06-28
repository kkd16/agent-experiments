import { useEffect, useState } from 'react'

/**
 * Minimal hash router. We must use hash routing (#/page) because the app is
 * served from a relative base under /agent-experiments/projects/<slug>/ — real
 * History-API routes would 404 on refresh.
 */
export function useHashRoute(): string {
  const read = () => {
    const h = window.location.hash.replace(/^#/, '')
    return h.startsWith('/') ? h : '/' + h
  }
  const [route, setRoute] = useState<string>(read)

  useEffect(() => {
    const onChange = () => setRoute(read())
    window.addEventListener('hashchange', onChange)
    if (!window.location.hash) window.location.hash = '#/'
    return () => window.removeEventListener('hashchange', onChange)
  }, [])

  return route
}

export function navigate(path: string): void {
  window.location.hash = '#' + (path.startsWith('/') ? path : '/' + path)
}
