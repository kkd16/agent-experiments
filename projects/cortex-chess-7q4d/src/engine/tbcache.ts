// tbcache.ts — persist built distance-to-mate tables to IndexedDB so they survive
// a reload and warm instantly instead of being recomputed (a KBNvK / KBBvK build
// takes ~10 s of retrograde analysis). IndexedDB is available both on the main
// thread and inside the search Web Worker, so the worker can re-hydrate a table on
// demand before searching an endgame it has a cached solution for.
//
// Everything here is best-effort and fully sandbox-safe: the catalog thumbnail runs
// the app in a sandboxed iframe where `indexedDB` can be absent or throw, so every
// entry point degrades to a no-op (build-from-scratch) rather than breaking.

const DB_NAME = 'cortex-chess-tb'
const STORE = 'tables'
// Bump FORMAT whenever the encoded table layout changes, to invalidate old records.
const FORMAT = 1

export interface CachedTable<M> {
  buffer: ArrayBuffer // the Int16Array's backing store
  meta: M // table statistics / metadata (must be structured-clonable)
}

interface Record_<M> extends CachedTable<M> {
  key: string
  format: number
}

function idb(): IDBFactory | null {
  try {
    // `indexedDB` is a global on both Window and WorkerGlobalScope.
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

function withStore<T>(
  mode: IDBTransactionMode,
  fn: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T | null> {
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

// Load a cached table by key. Returns null if absent, stale, or storage is
// unavailable. The returned Int16Array is a *view* over a fresh copy of the buffer.
export async function tbCacheLoad<M>(key: string): Promise<{ dtm: Int16Array; meta: M } | null> {
  try {
    const rec = (await withStore<Record_<M>>('readonly', (s) => s.get(key) as IDBRequest<Record_<M>>)) as
      | Record_<M>
      | null
      | undefined
    if (!rec || rec.format !== FORMAT || !rec.buffer) return null
    return { dtm: new Int16Array(rec.buffer), meta: rec.meta }
  } catch {
    return null
  }
}

// Persist a table. The Int16Array's buffer is stored verbatim (structured clone).
export async function tbCacheSave<M>(key: string, dtm: Int16Array, meta: M): Promise<boolean> {
  try {
    // Copy out so we store exactly the table's bytes (the array may be a subview).
    const buffer = (dtm.buffer as ArrayBuffer).slice(dtm.byteOffset, dtm.byteOffset + dtm.byteLength)
    const rec: Record_<M> = { key, format: FORMAT, buffer, meta }
    const ok = await withStore<IDBValidKey>('readwrite', (s) => s.put(rec))
    return ok !== null
  } catch {
    return false
  }
}

// List the keys currently cached (for the UI's "cached" badges).
export async function tbCacheKeys(): Promise<string[]> {
  try {
    const keys = await withStore<IDBValidKey[]>('readonly', (s) => s.getAllKeys())
    return (keys ?? []).map(String)
  } catch {
    return []
  }
}

// Drop one key, or the whole store when `key` is omitted.
export async function tbCacheClear(key?: string): Promise<void> {
  try {
    await withStore('readwrite', (s) => (key ? s.delete(key) : s.clear()))
  } catch {
    /* ignore */
  }
}
