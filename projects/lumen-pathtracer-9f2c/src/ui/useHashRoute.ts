// useHashRoute — a minimal hash-based router. The app is served under a relative
// base in the catalog, where History-API routes 404 on refresh, so every view
// lives behind `#/route` instead.

import { useEffect, useState } from 'react'

export type Route = 'render' | 'verify' | 'about'

function parse(): Route {
  const h = window.location.hash.replace(/^#\/?/, '')
  if (h === 'verify' || h === 'about') return h
  return 'render'
}

export function useHashRoute(): [Route, (r: Route) => void] {
  const [route, setRoute] = useState<Route>(parse())
  useEffect(() => {
    const onHash = () => setRoute(parse())
    window.addEventListener('hashchange', onHash)
    return () => window.removeEventListener('hashchange', onHash)
  }, [])
  const navigate = (r: Route) => {
    window.location.hash = `#/${r}`
  }
  return [route, navigate]
}
