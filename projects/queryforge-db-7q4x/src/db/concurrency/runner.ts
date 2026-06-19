// The deterministic schedule runner. It drives the MVCC store through a
// scenario's interleaved op list, honouring the schedule order except when an op
// BLOCKS on a lock — then that transaction stalls (its later ops queue behind
// it) while the rest of the schedule proceeds, and the blocked op resumes the
// moment the lock frees. It detects deadlocks, applies SSI at commit, and emits
// a full per-step trace plus an after-each-step snapshot of the world for the UI.

import { MvccStore, type IsolationLevel, type Txn, type Val } from './mvcc'
import type { Scenario, ScheduleOp } from './scenarios'

export interface VersionView {
  xmin: string
  xmax: string
  value: Val
  deleted: boolean
  /** the currently-committed-visible version for this key */
  current: boolean
}
export interface RowView {
  key: string
  versions: VersionView[]
}
export interface TxnView {
  label: string
  status: 'active' | 'committed' | 'aborted'
}
export interface EdgeView {
  from: string
  to: string
}
export interface WorldSnapshot {
  rows: RowView[]
  txns: TxnView[]
  locks: { key: string; holder: string }[]
  rwEdges: EdgeView[]
}

export type StepStatus = 'begin' | 'ok' | 'blocked' | 'aborted' | 'committed' | 'noop'

export interface TraceStep {
  seq: number
  opIndex: number
  t: string
  /** human-readable op, e.g. "read(price)" */
  op: string
  status: StepStatus
  detail: string
  readValue?: Val
  found?: boolean
  rows?: { key: string; value: Val }[]
  blockedOn?: string
  abortReason?: string
  world: WorldSnapshot
}

export interface RunResult {
  level: IsolationLevel
  steps: TraceStep[]
  aborts: { t: string; reason: string }[]
  serializable: boolean
  cycle: string[] | null
  verdict: string
  verdictKind: 'serializable' | 'anomaly' | 'aborted'
  finalRows: { key: string; value: Val }[]
}

const opLabel = (op: ScheduleOp): string => {
  switch (op.kind) {
    case 'begin':
      return 'begin'
    case 'read':
      return `read(${op.key})`
    case 'readWhere':
      return `read*(${op.pred?.label})`
    case 'write':
      return `write(${op.key} = ${fmt(op.value)})`
    case 'delete':
      return `delete(${op.key})`
    case 'commit':
      return 'commit'
    case 'abort':
      return 'abort'
  }
}

function fmt(v: Val | undefined): string {
  if (v === null || v === undefined) return 'NULL'
  if (typeof v === 'string') return `'${v}'`
  return String(v)
}

export function runScenario(scenario: Scenario, level: IsolationLevel): RunResult {
  const store = new MvccStore()
  for (const row of scenario.initial) store.seed(row.key, row.value)

  const txnByLabel = new Map<string, Txn>()
  const idToLabel = new Map<number, string>()
  idToLabel.set(0, 'init')

  const steps: TraceStep[] = []
  const aborts: { t: string; reason: string }[] = []
  let seq = 0

  const labelOf = (id: number): string => idToLabel.get(id) ?? `#${id}`

  const snapshotWorld = (): WorldSnapshot => {
    const committed = new Set<number>([0])
    for (const t of store.txns.values()) if (t.status === 'committed') committed.add(t.id)
    const rows: RowView[] = []
    for (const [key, chain] of store.table) {
      // which version is the current committed-visible one?
      let currentSeq = -1
      for (let i = chain.length - 1; i >= 0; i--) {
        if (committed.has(chain[i].xmin)) {
          currentSeq = chain[i].deleted ? -1 : chain[i].seq
          break
        }
      }
      rows.push({
        key,
        versions: chain.map((v) => ({
          xmin: labelOf(v.xmin),
          xmax: v.xmax === 0 ? '—' : labelOf(v.xmax),
          value: v.value,
          deleted: v.deleted,
          current: v.seq === currentSeq,
        })),
      })
    }
    rows.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
    const txns: TxnView[] = [...txnByLabel.values()].map((t) => ({
      label: t.label,
      status: t.status,
    }))
    const locks: { key: string; holder: string }[] = []
    for (const [key, holder] of store.writeLocks) locks.push({ key, holder: labelOf(holder) })
    const rwEdges: EdgeView[] = store
      .liveRwEdges()
      .map((e) => ({ from: labelOf(e.from), to: labelOf(e.to) }))
    return { rows, txns, locks, rwEdges }
  }

  const emit = (
    opIndex: number,
    op: ScheduleOp,
    status: StepStatus,
    detail: string,
    extra: Partial<TraceStep> = {},
  ) => {
    steps.push({
      seq: seq++,
      opIndex,
      t: op.t,
      op: opLabel(op),
      status,
      detail,
      world: snapshotWorld(),
      ...extra,
    })
  }

  // --- scheduling state -----------------------------------------------------
  type Item = { op: ScheduleOp; i: number }
  const stalled = new Set<string>()
  const blocked = new Map<string, { item: Item; waitsFor: string }>()
  const queue = new Map<string, Item[]>()

  const enqueue = (label: string, item: Item) => {
    const q = queue.get(label) ?? []
    q.push(item)
    queue.set(label, q)
  }

  // Dispatch one op. Returns 'blocked' (with waitsFor id) | 'finished' | 'done'.
  type Dispatch =
    | { kind: 'blocked'; waitsFor: number }
    | { kind: 'finished' }
    | { kind: 'done' }

  const dispatch = (op: ScheduleOp, i: number, isResume: boolean): Dispatch => {
    const txn = txnByLabel.get(op.t)

    if (op.kind === 'begin') {
      if (txn) {
        emit(i, op, 'noop', `${op.t} already started`)
        return { kind: 'done' }
      }
      const t = store.begin(op.t, level)
      txnByLabel.set(op.t, t)
      idToLabel.set(t.id, op.t)
      emit(i, op, 'begin', `${op.t} begins at ${level}`)
      return { kind: 'done' }
    }

    if (!txn) {
      emit(i, op, 'noop', `${op.t} has not begun`)
      return { kind: 'done' }
    }
    if (txn.status !== 'active') {
      emit(i, op, 'noop', `${op.t} is ${txn.status}; ${opLabel(op)} skipped`)
      return { kind: 'done' }
    }

    switch (op.kind) {
      case 'read': {
        const out = store.read(txn, op.key!)
        emit(
          i,
          op,
          'ok',
          out.found ? `${op.t} reads ${op.key} = ${fmt(out.value)}` : `${op.t} finds ${op.key} absent`,
          { readValue: out.value, found: out.found },
        )
        return { kind: 'done' }
      }
      case 'readWhere': {
        const out = store.readWhere(txn, op.pred!.label, op.pred!.test)
        emit(i, op, 'ok', `${op.t} reads ${out.rows.length} row(s) where ${op.pred!.label}`, {
          rows: out.rows,
        })
        return { kind: 'done' }
      }
      case 'write':
      case 'delete': {
        const out =
          op.kind === 'write' ? store.write(txn, op.key!, op.value!) : store.del(txn, op.key!)
        if (out.status === 'blocked') {
          if (!isResume) {
            emit(i, op, 'blocked', `${op.t} waits for ${labelOf(out.waitsFor)} to release ${op.key}`, {
              blockedOn: labelOf(out.waitsFor),
            })
          }
          return { kind: 'blocked', waitsFor: out.waitsFor }
        }
        if (out.status === 'abort') {
          store.abort(txn, out.reason)
          aborts.push({ t: op.t, reason: out.reason })
          emit(i, op, 'aborted', `${op.t} aborts — ${out.reason}`, { abortReason: out.reason })
          return { kind: 'finished' }
        }
        emit(i, op, 'ok', `${op.t} ${op.kind === 'delete' ? 'deletes' : 'writes'} ${op.key}${op.kind === 'write' ? ` = ${fmt(op.value)}` : ''}`)
        return { kind: 'done' }
      }
      case 'commit': {
        const out = store.commit(txn)
        if (out.status === 'abort') {
          aborts.push({ t: op.t, reason: out.reason })
          emit(i, op, 'aborted', `${op.t} cannot commit — ${out.reason}`, { abortReason: out.reason })
          return { kind: 'finished' }
        }
        emit(i, op, 'committed', `${op.t} commits`)
        return { kind: 'finished' }
      }
      case 'abort': {
        store.abort(txn, 'rolled back')
        aborts.push({ t: op.t, reason: 'rolled back' })
        emit(i, op, 'aborted', `${op.t} rolls back`)
        return { kind: 'finished' }
      }
    }
  }

  // Detect a cycle in the waits-for graph reachable from `start`. Each txn waits
  // on at most one other, so we just walk the chain.
  const waitsForCycle = (start: string): boolean => {
    const seen = new Set<string>()
    let cur: string | undefined = start
    while (cur !== undefined) {
      if (seen.has(cur)) return true
      seen.add(cur)
      cur = blocked.get(cur)?.waitsFor
    }
    return false
  }

  const runItem = (item: Item, isResume: boolean): Dispatch => {
    const res = dispatch(item.op, item.i, isResume)
    if (res.kind === 'blocked') {
      const waitsFor = labelOf(res.waitsFor)
      blocked.set(item.op.t, { item, waitsFor })
      stalled.add(item.op.t)
      if (waitsForCycle(item.op.t)) {
        // Break the deadlock: the transaction that closed the cycle is the victim.
        const victim = txnByLabel.get(item.op.t)!
        store.abort(victim, 'deadlock detected')
        aborts.push({ t: item.op.t, reason: 'deadlock detected' })
        blocked.delete(item.op.t)
        stalled.delete(item.op.t)
        emit(item.i, item.op, 'aborted', `${item.op.t} aborts — deadlock detected`, {
          abortReason: 'deadlock detected',
        })
        return { kind: 'finished' }
      }
    }
    return res
  }

  // After a transaction finishes, retry blocked ops (their locks may be free)
  // and drain anything queued behind them, until no further progress is made.
  const wake = () => {
    let changed = true
    while (changed) {
      changed = false
      for (const [label, entry] of [...blocked]) {
        const res = runItem(entry.item, true)
        if (res.kind === 'blocked') continue // still waiting
        // unblocked (done/finished or aborted via deadlock)
        blocked.delete(label)
        stalled.delete(label)
        changed = true
        if (drainQueue(label)) changed = true
      }
    }
  }

  // Run queued ops for a now-unstalled txn until one blocks or the queue empties.
  const drainQueue = (label: string): boolean => {
    let finishedAny = false
    const q = queue.get(label)
    if (!q) return false
    while (q.length && !stalled.has(label)) {
      const item = q.shift()!
      const res = runItem(item, false)
      if (res.kind === 'blocked') break
      if (res.kind === 'finished') finishedAny = true
    }
    return finishedAny
  }

  // --- main pass over the schedule -----------------------------------------
  scenario.ops.forEach((op, i) => {
    if (stalled.has(op.t) || (queue.get(op.t)?.length ?? 0) > 0) {
      enqueue(op.t, { op, i })
      return
    }
    const res = runItem({ op, i }, false)
    if (res.kind === 'finished') wake()
  })
  // Drain any remaining wakeups (e.g. a commit that frees the last lock).
  wake()

  // Any op still queued/blocked never got to run (its txn is permanently stuck
  // on a lock that never released). Surface it so the trace is complete.
  for (const [, entry] of blocked) {
    emit(entry.item.i, entry.item.op, 'noop', `${entry.item.op.t} never resumes (still waiting on ${entry.waitsFor})`)
  }

  const cycleIds = store.serializabilityCycle()
  const cycle = cycleIds ? cycleIds.map(labelOf) : null
  const serializable = cycle === null

  let verdict: string
  let verdictKind: RunResult['verdictKind']
  const systemAborts = aborts.filter(
    (a) => a.reason !== 'rolled back' && a.reason !== 'user abort',
  )
  const names = systemAborts.map((a) => a.t).join(', ')
  if (!serializable) {
    const tail = `(${cycle!.join(' → ')} → ${cycle![0]})`
    verdict =
      systemAborts.length > 0
        ? `An abort occurred (${names}), but the committed transactions still form a cycle ${tail}.`
        : `Not serializable — the committed transactions form a dependency cycle ${tail}.`
    verdictKind = 'anomaly'
  } else if (systemAborts.length > 0) {
    verdict = `Serializable — the engine aborted ${names} to keep the schedule correct.`
    verdictKind = 'aborted'
  } else {
    verdict = 'Serializable — the committed transactions admit a valid serial order.'
    verdictKind = 'serializable'
  }

  return {
    level,
    steps,
    aborts,
    serializable,
    cycle,
    verdict,
    verdictKind,
    finalRows: store.committedRows(),
  }
}
