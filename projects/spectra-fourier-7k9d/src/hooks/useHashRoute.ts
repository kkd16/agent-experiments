import { useCallback, useEffect, useState } from 'react'

// Minimal hash router. History-API routes break under a relative base on GitHub
// Pages, so the whole app navigates via `#/route`. Returns the current route (the
// text after `#/`) and a setter that updates the hash.

function currentRoute(): string {
  // Strip any `?query` used for deep-linkable mode state so it never leaks into
  // the route name (see lib/urlState).
  const h = window.location.hash.replace(/^#\/?/, '').split('?')[0]
  return h || ''
}

export function useHashRoute(fallback: string): [string, (r: string) => void] {
  const [route, setRoute] = useState<string>(() => currentRoute() || fallback)

  useEffect(() => {
    const onChange = () => setRoute(currentRoute() || fallback)
    window.addEventListener('hashchange', onChange)
    // Normalize an empty hash to the fallback on first load.
    if (!window.location.hash) window.location.hash = `#/${fallback}`
    return () => window.removeEventListener('hashchange', onChange)
  }, [fallback])

  const navigate = useCallback((r: string) => {
    window.location.hash = `#/${r}`
  }, [])

  return [route, navigate]
}
