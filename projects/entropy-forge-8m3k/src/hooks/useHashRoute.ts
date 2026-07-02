import { useEffect, useState } from 'react'

// Minimal hash-based router. AGENTS.md mandates hash routing (#/page) because the
// app is served under a relative base and History-API routes 404 on refresh.
export function useHashRoute(): string {
  const read = () => {
    const h = window.location.hash.replace(/^#\/?/, '')
    return h.split('?')[0] || 'overview'
  }
  const [route, setRoute] = useState(read)
  useEffect(() => {
    const on = () => setRoute(read())
    window.addEventListener('hashchange', on)
    return () => window.removeEventListener('hashchange', on)
  }, [])
  return route
}

export function navigate(route: string) {
  window.location.hash = `#/${route}`
}
