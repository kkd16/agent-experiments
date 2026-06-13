// Minimal hash router. History-API routing breaks under the relative base the
// catalog serves apps from, so we use `#/route` everywhere.

import { useEffect, useState } from 'react'

export function useHashRoute(): [string, (r: string) => void] {
  const read = () => {
    const h = window.location.hash.replace(/^#\/?/, '')
    return h || 'playground'
  }
  const [route, setRoute] = useState(read)
  useEffect(() => {
    const onHash = () => setRoute(read())
    window.addEventListener('hashchange', onHash)
    return () => window.removeEventListener('hashchange', onHash)
  }, [])
  const navigate = (r: string) => {
    window.location.hash = `/${r}`
  }
  return [route, navigate]
}
