// Persist the database between sessions via localStorage.
//
// Every access is wrapped in try/catch: the catalog thumbnail renders in a
// sandboxed iframe with no same-origin access, so localStorage throws there.
// We degrade gracefully to an in-memory-only database in that case.

import { Database, type SerializedDb } from '../db/catalog'

const KEY = 'queryforge.db.v1'

export function saveDb(db: Database): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(db.snapshot()))
  } catch {
    /* sandboxed / quota — ignore */
  }
}

export function loadDb(): Database | null {
  try {
    const raw = localStorage.getItem(KEY)
    if (!raw) return null
    const snap = JSON.parse(raw) as SerializedDb
    if (!snap || snap.version !== 1) return null
    return Database.restore(snap)
  } catch {
    return null
  }
}

export function clearDb(): void {
  try {
    localStorage.removeItem(KEY)
  } catch {
    /* ignore */
  }
}
