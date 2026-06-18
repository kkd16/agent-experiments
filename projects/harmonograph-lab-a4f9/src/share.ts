// Persistence: encode a whole Project into the URL hash (shareable links) and
// save / load named pieces in localStorage. Everything that touches the URL or
// storage is wrapped in try/catch so the sandboxed catalog thumbnail still
// renders if those APIs throw.

import type { Layer, Project } from './types'

// Older links / saved pieces predate multi-source layers — default them to the
// harmonograph kind so they keep rendering exactly as before.
function migrate(project: Project): Project {
  return {
    ...project,
    layers: project.layers.map((l) => ({
      ...l,
      kind: (l as Partial<Layer>).kind ?? 'harmonograph',
    })),
  }
}

// Round numbers to keep encoded links short.
function compact(project: Project): string {
  return JSON.stringify(project, (_k, v) =>
    typeof v === 'number' ? Math.round(v * 1e4) / 1e4 : v,
  )
}

function b64encode(str: string): string {
  const bytes = new TextEncoder().encode(str)
  let bin = ''
  for (const b of bytes) bin += String.fromCharCode(b)
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function b64decode(b64: string): string {
  let s = b64.replace(/-/g, '+').replace(/_/g, '/')
  while (s.length % 4) s += '='
  const bin = atob(s)
  const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0))
  return new TextDecoder().decode(bytes)
}

// Light structural validation — enough to reject garbage from the URL.
function isProject(v: unknown): v is Project {
  if (!v || typeof v !== 'object') return false
  const p = v as Record<string, unknown>
  return (
    typeof p.background === 'string' &&
    typeof p.vignette === 'number' &&
    Array.isArray(p.layers)
  )
}

export function encodeProject(project: Project): string {
  return b64encode(compact(project))
}

export function decodeProject(code: string): Project | null {
  try {
    const obj = JSON.parse(b64decode(code)) as unknown
    return isProject(obj) ? migrate(obj) : null
  } catch {
    return null
  }
}

export function projectToHash(project: Project): string {
  return `#/c/${encodeProject(project)}`
}

export function readHashProject(): Project | null {
  try {
    const h = window.location.hash
    const m = h.match(/^#\/c\/(.+)$/)
    if (!m) return null
    return decodeProject(m[1])
  } catch {
    return null
  }
}

export function writeHashProject(project: Project) {
  try {
    history.replaceState(null, '', projectToHash(project))
  } catch {
    /* ignore (sandbox) */
  }
}

export function shareUrl(project: Project): string {
  try {
    const base = window.location.href.split('#')[0]
    return base + projectToHash(project)
  } catch {
    return projectToHash(project)
  }
}

// ---- local gallery --------------------------------------------------------

const GALLERY_KEY = 'harmonograph.gallery.v2'

export interface GalleryItem {
  id: string
  name: string
  thumb: string // small PNG data URL
  project: Project
  createdAt: number
}

export function loadGallery(): GalleryItem[] {
  try {
    const raw = localStorage.getItem(GALLERY_KEY)
    if (!raw) return []
    const arr = JSON.parse(raw) as unknown
    if (!Array.isArray(arr)) return []
    return (arr.filter((it) => it && isProject((it as GalleryItem).project)) as GalleryItem[]).map(
      (it) => ({ ...it, project: migrate(it.project) }),
    )
  } catch {
    return []
  }
}

function persist(items: GalleryItem[]) {
  try {
    localStorage.setItem(GALLERY_KEY, JSON.stringify(items))
  } catch {
    /* ignore (sandbox / quota) */
  }
}

export function saveToGallery(item: GalleryItem): GalleryItem[] {
  const items = [item, ...loadGallery()].slice(0, 60)
  persist(items)
  return items
}

export function deleteFromGallery(id: string): GalleryItem[] {
  const items = loadGallery().filter((it) => it.id !== id)
  persist(items)
  return items
}
