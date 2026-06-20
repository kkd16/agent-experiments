// React binding around the SQL Engine: owns one Engine instance, exposes a
// run() that refreshes the introspected schema and persists after mutations.

import { useCallback, useState } from 'react'
import { Engine, type QueryResult } from '../db/engine'
import { Database } from '../db/catalog'
import { SqlError } from '../db/types'
import {
  describeSchema,
  describeViews,
  describeRoutines,
  describeTriggers,
  type TableInfo,
  type ViewInfo,
  type RoutineInfo,
  type TriggerInfo,
} from '../db/introspect'
import { SEED_SQL } from '../db/sampleData'
import { loadDb, saveDb, clearDb } from './persistence'

export interface RunError {
  message: string
  phase: string
}
export interface RunOutcome {
  results: QueryResult[]
  error: RunError | null
}

function freshEngine(): Engine {
  const restored = loadDb()
  if (restored) return new Engine(restored)
  const e = new Engine(new Database())
  try {
    e.execute(SEED_SQL)
  } catch {
    /* seeding should never fail, but never block startup */
  }
  return e
}

export function useEngine() {
  const [engine, setEngine] = useState<Engine>(freshEngine)
  const [schema, setSchema] = useState<TableInfo[]>(() => describeSchema(engine.db))
  const [views, setViews] = useState<ViewInfo[]>(() => describeViews(engine.db))
  const [routines, setRoutines] = useState<RoutineInfo[]>(() => describeRoutines(engine.db))
  const [triggers, setTriggers] = useState<TriggerInfo[]>(() => describeTriggers(engine.db))
  // Bumps whenever the database changes, so views like the Optimizer Lab can
  // recompute against the live schema/data.
  const [version, setVersion] = useState(0)

  const refresh = useCallback((e: Engine) => {
    setSchema(describeSchema(e.db))
    setViews(describeViews(e.db))
    setRoutines(describeRoutines(e.db))
    setTriggers(describeTriggers(e.db))
    setVersion((v) => v + 1)
    saveDb(e.db)
  }, [])

  const run = useCallback(
    (sql: string): RunOutcome => {
      try {
        const results = engine.execute(sql)
        refresh(engine)
        return { results, error: null }
      } catch (err) {
        // A failed script may have partially mutated state; reflect reality.
        refresh(engine)
        const phase = err instanceof SqlError ? err.phase : 'error'
        return { results: [], error: { message: err instanceof Error ? err.message : String(err), phase } }
      }
    },
    [engine, refresh],
  )

  const reset = useCallback(() => {
    clearDb()
    const e = new Engine(new Database())
    e.execute(SEED_SQL)
    setEngine(e)
    refresh(e)
  }, [refresh])

  return { engine, version, schema, views, routines, triggers, run, reset }
}
