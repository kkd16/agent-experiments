// nnue-cache.ts — persist a trained NNUE to IndexedDB so it survives a reload and
// can be re-hydrated by the search Web Worker. Same sandbox-safe, best-effort
// pattern as tbcache.ts: every entry point degrades to a no-op when `indexedDB` is
// unavailable (e.g. inside the sandboxed catalog thumbnail).

import { type NnueBlob } from './nnue'

const DB_NAME = 'cortex-chess-nnue'
const STORE = 'nets'
const FORMAT = 1
export const NNUE_KEY = 'trained'

interface Record_ {
  key: string
  format: number
  blob: NnueBlob
  meta: NnueMeta
}

export interface NnueMeta {
  positions: number
  epochs: number
  finalLoss: number
  r2: number
  trainedAt: string
}

function idb(): IDBFactory | null {
  try {
    const g = (typeof self !== 'undefined' ? self : globalThis) as unknown as { indexedDB?: IDBFactory }
    return g.indexedDB ?? null
  } catch {
    return null
  }
}

function openDb(): Promise<IDBDatabase | null> {
  return new Promise((resolve) => {
    const factory = idb()
    if (!factory) {
      resolve(null)
      return
    }
    try {
      const req = factory.open(DB_NAME, 1)
      req.onupgradeneeded = () => {
        const db = req.result
        if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: 'key' })
      }
      req.onsuccess = () => resolve(req.result)
      req.onerror = () => resolve(null)
      req.onblocked = () => resolve(null)
    } catch {
      resolve(null)
    }
  })
}

function withStore<T>(mode: IDBTransactionMode, fn: (store: IDBObjectStore) => IDBRequest<T>): Promise<T | null> {
  return openDb().then(
    (db) =>
      new Promise<T | null>((resolve) => {
        if (!db) {
          resolve(null)
          return
        }
        try {
          const tx = db.transaction(STORE, mode)
          const req = fn(tx.objectStore(STORE))
          req.onsuccess = () => resolve(req.result)
          req.onerror = () => resolve(null)
          tx.oncomplete = () => db.close()
          tx.onabort = () => resolve(null)
        } catch {
          resolve(null)
        }
      }),
  )
}

export async function nnueSave(blob: NnueBlob, meta: NnueMeta): Promise<boolean> {
  try {
    const rec: Record_ = { key: NNUE_KEY, format: FORMAT, blob, meta }
    const ok = await withStore<IDBValidKey>('readwrite', (s) => s.put(rec))
    return ok !== null
  } catch {
    return false
  }
}

export async function nnueLoad(): Promise<{ blob: NnueBlob; meta: NnueMeta } | null> {
  try {
    const rec = (await withStore<Record_>('readonly', (s) => s.get(NNUE_KEY) as IDBRequest<Record_>)) as
      | Record_
      | null
      | undefined
    if (!rec || rec.format !== FORMAT || !rec.blob) return null
    return { blob: rec.blob, meta: rec.meta }
  } catch {
    return null
  }
}

export async function nnueClear(): Promise<void> {
  try {
    await withStore('readwrite', (s) => s.delete(NNUE_KEY))
  } catch {
    /* ignore */
  }
}
