import { useEffect, useState } from 'react'

// Hash-based routing (required: history-API routes break under the relative base
// the catalog serves from). Routes look like "#/studio", "#/learn".
export function useHashRoute(defaultRoute = '/studio'): [string, (r: string) => void] {
  const read = () => {
    const h = window.location.hash.replace(/^#/, '')
    return h || defaultRoute
  }
  const [route, setRoute] = useState<string>(read)

  useEffect(() => {
    const onChange = () => setRoute(read())
    window.addEventListener('hashchange', onChange)
    if (!window.location.hash) window.location.hash = defaultRoute
    return () => window.removeEventListener('hashchange', onChange)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const navigate = (r: string) => {
    window.location.hash = r
  }
  return [route, navigate]
}
