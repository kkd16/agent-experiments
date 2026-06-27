import { useEffect, useRef, useState } from 'react'

// localStorage-backed state. Catalog thumbnails render the app in a sandboxed
// iframe with no same-origin access, so localStorage can throw — every access is
// guarded and silently falls back to in-memory state there.
export function usePersistentState<T>(key: string, initial: T): [T, (v: T | ((p: T) => T)) => void] {
  const storageKey = `mosaic:${key}`
  const [value, setValue] = useState<T>(() => {
    try {
      const raw = localStorage.getItem(storageKey)
      return raw != null ? (JSON.parse(raw) as T) : initial
    } catch {
      return initial
    }
  })

  const first = useRef(true)
  useEffect(() => {
    if (first.current) {
      first.current = false
      return
    }
    try {
      localStorage.setItem(storageKey, JSON.stringify(value))
    } catch {
      /* sandboxed preview — ignore */
    }
  }, [storageKey, value])

  return [value, setValue]
}
