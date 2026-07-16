// The generic, deterministic schedule runner. It drives *any* concurrency-control
// engine through a scenario's interleaved op list, honouring the schedule order
// except when an op BLOCKS on a lock (2PL) — then that transaction stalls (its
// later ops queue behind it) while the rest of the schedule proceeds, and the
// blocked op resumes the moment the lock frees. It detects deadlocks on the
// waits-for graph, handles protocol- and cascade-aborts, records the global
// access log, and finally runs the conflict-serializability oracle over the
// committed projection.
//
// It is the exact analogue of the MVCC `runner.ts`, generalised so 2PL, OCC and
// T/O all share one driver — which is what makes the head-to-head comparison
// apples-to-apples: the *only* thing that varies between columns is the engine.

import type { Scenario, ScheduleOp } from '../concurrency/scenarios'
import type { Val } from '../concurrency/mvcc'
import { analyzeHistory } from './history'
import type { Access, EngineStep, ProtocolEngine } from './types'
import type {
  ProtocolStepStatus,
  ProtocolRunResult,
  ProtocolStep,
  TxnOutcome,
} from './result'

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

export function runProtocol(engine: ProtocolEngine, scenario: Scenario): ProtocolRunResult {
  for (const row of scenario.initial) engine.seed(row.key, row.value)

  const steps: ProtocolStep[] = []
  const accessLog: Access[] = []
  const outcomes = new Map<string, TxnOutcome>()
  const started = new Set<string>()
  let seq = 0
  let accessSeq = 0
  const metrics = { aborts: 0, deadlocks: 0, blocks: 0, committed: 0, validationFails: 0 }

  const setOutcome = (label: string, status: TxnOutcome['status'], reason?: string) => {
    outcomes.set(label, { label, status, reason })
  }

  const emit = (
    opIndex: number,
    op: ScheduleOp,
    status: ProtocolStepStatus,
    detail: string,
    extra: Partial<ProtocolStep> = {},
  ) => {
    steps.push({ seq: seq++, opIndex, t: op.t, op: opLabel(op), status, detail, ...extra })
  }

  const record = (label: string, step: EngineStep) => {
    if (step.status !== 'ok') return
    for (const tch of step.touched) accessLog.push({ txn: label, kind: tch.kind, item: tch.item, seq: accessSeq++ })
  }

  // Mark a set of cascade-aborted transactions (T/O) as aborted with a note.
  const applyCascade = (labels: string[], sourceIndex: number) => {
    for (const l of labels) {
      if (outcomes.get(l)?.status === 'aborted') continue
      metrics.aborts++
      setOutcome(l, 'aborted', 'cascade abort')
      blocked.delete(l)
      stalled.delete(l)
      queue.delete(l)
      steps.push({
        seq: seq++,
        opIndex: sourceIndex,
        t: l,
        op: 'cascade',
        status: 'aborted',
        detail: `${l} cascade-aborts — it read data from an aborted transaction`,
        abortReason: 'cascade abort',
      })
    }
  }

  // --- scheduling state -----------------------------------------------------
  type Item = { op: ScheduleOp; i: number }
  const stalled = new Set<string>()
  const blocked = new Map<string, { item: Item; waitsFor: string[] }>()
  const queue = new Map<string, Item[]>()

  const enqueue = (label: string, item: Item) => {
    const q = queue.get(label) ?? []
    q.push(item)
    queue.set(label, q)
  }

  type Dispatch = { kind: 'blocked'; waitsFor: string[] } | { kind: 'finished' } | { kind: 'done' }

  const dispatch = (op: ScheduleOp, i: number, isResume: boolean): Dispatch => {
    const active = started.has(op.t) && outcomes.get(op.t)?.status === 'active'

    if (op.kind === 'begin') {
      if (started.has(op.t)) {
        emit(i, op, 'noop', `${op.t} already started`)
        return { kind: 'done' }
      }
      engine.begin(op.t)
      started.add(op.t)
      setOutcome(op.t, 'active')
      emit(i, op, 'begin', `${op.t} begins`)
      return { kind: 'done' }
    }

    if (!started.has(op.t)) {
      emit(i, op, 'noop', `${op.t} has not begun`)
      return { kind: 'done' }
    }
    if (!active) {
      emit(i, op, 'noop', `${op.t} is ${outcomes.get(op.t)?.status}; ${opLabel(op)} skipped`)
      return { kind: 'done' }
    }

    switch (op.kind) {
      case 'read':
      case 'readWhere': {
        const step =
          op.kind === 'read' ? engine.read(op.t, op.key!) : engine.readWhere(op.t, op.pred!)
        if (step.status === 'blocked') {
          if (!isResume) {
            metrics.blocks++
            emit(i, op, 'blocked', `${op.t} waits for ${step.waitsFor.join(', ')}`, {
              blockedOn: step.waitsFor.join(', '),
            })
          }
          return { kind: 'blocked', waitsFor: step.waitsFor }
        }
        if (step.status === 'abort') return abortHere(op, i, step.reason)
        record(op.t, step)
        if (op.kind === 'read') {
          emit(
            i,
            op,
            'ok',
            step.read?.found
              ? `${op.t} reads ${op.key} = ${fmt(step.read.value)}`
              : `${op.t} finds ${op.key} absent`,
            { readValue: step.read?.value, found: step.read?.found },
          )
        } else {
          emit(i, op, 'ok', `${op.t} reads ${step.rows?.length ?? 0} row(s) where ${op.pred!.label}`, {
            rows: step.rows,
          })
        }
        return { kind: 'done' }
      }
      case 'write':
      case 'delete': {
        const step =
          op.kind === 'write' ? engine.write(op.t, op.key!, op.value!) : engine.del(op.t, op.key!)
        if (step.status === 'blocked') {
          if (!isResume) {
            metrics.blocks++
            emit(i, op, 'blocked', `${op.t} waits for ${step.waitsFor.join(', ')} to release ${op.key}`, {
              blockedOn: step.waitsFor.join(', '),
            })
          }
          return { kind: 'blocked', waitsFor: step.waitsFor }
        }
        if (step.status === 'abort') return abortHere(op, i, step.reason)
        record(op.t, step)
        emit(
          i,
          op,
          'ok',
          step.note ??
            `${op.t} ${op.kind === 'delete' ? 'deletes' : 'writes'} ${op.key}${op.kind === 'write' ? ` = ${fmt(op.value)}` : ''}`,
        )
        return { kind: 'done' }
      }
      case 'commit': {
        const step = engine.commit(op.t)
        if (step.status === 'abort') {
          metrics.validationFails++
          return abortHere(op, i, step.reason, true)
        }
        record(op.t, step)
        setOutcome(op.t, 'committed')
        metrics.committed++
        emit(i, op, 'committed', `${op.t} commits`)
        return { kind: 'finished' }
      }
      case 'abort': {
        const cascade = engine.abort(op.t, 'rolled back')
        metrics.aborts++
        setOutcome(op.t, 'aborted', 'rolled back')
        emit(i, op, 'aborted', `${op.t} rolls back`, { abortReason: 'rolled back' })
        applyCascade(cascade, i)
        return { kind: 'finished' }
      }
    }
  }

  // Abort the current op's transaction (protocol- or validation-initiated).
  const abortHere = (op: ScheduleOp, i: number, reason: string, isCommit = false): Dispatch => {
    const cascade = engine.abort(op.t, reason)
    metrics.aborts++
    setOutcome(op.t, 'aborted', reason)
    emit(i, op, 'aborted', isCommit ? `${op.t} cannot commit — ${reason}` : `${op.t} aborts — ${reason}`, {
      abortReason: reason,
    })
    applyCascade(cascade, i)
    return { kind: 'finished' }
  }

  // Is there a cycle in the waits-for graph reachable from `start`?
  const waitsForCycle = (start: string): boolean => {
    const stack = [start]
    const seen = new Set<string>()
    while (stack.length) {
      const cur = stack.pop()!
      for (const nxt of blocked.get(cur)?.waitsFor ?? []) {
        if (nxt === start) return true
        if (!seen.has(nxt)) {
          seen.add(nxt)
          if (blocked.has(nxt)) stack.push(nxt)
        }
      }
    }
    return false
  }

  const runItem = (item: Item, isResume: boolean): Dispatch => {
    const res = dispatch(item.op, item.i, isResume)
    if (res.kind === 'blocked') {
      blocked.set(item.op.t, { item, waitsFor: res.waitsFor })
      stalled.add(item.op.t)
      if (waitsForCycle(item.op.t)) {
        const cascade = engine.abort(item.op.t, 'deadlock detected')
        metrics.aborts++
        metrics.deadlocks++
        setOutcome(item.op.t, 'aborted', 'deadlock detected')
        blocked.delete(item.op.t)
        stalled.delete(item.op.t)
        emit(item.i, item.op, 'aborted', `${item.op.t} aborts — deadlock detected`, {
          abortReason: 'deadlock detected',
        })
        applyCascade(cascade, item.i)
        return { kind: 'finished' }
      }
    }
    return res
  }

  const wake = () => {
    let changed = true
    while (changed) {
      changed = false
      for (const [label, entry] of [...blocked]) {
        const res = runItem(entry.item, true)
        if (res.kind === 'blocked') continue
        blocked.delete(label)
        stalled.delete(label)
        changed = true
        if (drainQueue(label)) changed = true
      }
    }
  }

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
    if (outcomes.get(op.t)?.status === 'aborted') {
      emit(i, op, 'noop', `${op.t} is aborted; ${opLabel(op)} skipped`)
      return
    }
    if (stalled.has(op.t) || (queue.get(op.t)?.length ?? 0) > 0) {
      enqueue(op.t, { op, i })
      return
    }
    const res = runItem({ op, i }, false)
    if (res.kind === 'finished') wake()
  })
  wake()

  for (const [, entry] of blocked) {
    emit(entry.item.i, entry.item.op, 'noop', `${entry.item.op.t} never resumes (still waiting on ${entry.waitsFor.join(', ')})`)
  }

  // --- verdict from the ground-truth oracle --------------------------------
  const committedSet = new Set<string>(
    [...outcomes.values()].filter((o) => o.status === 'committed').map((o) => o.label),
  )
  const oracle = analyzeHistory(accessLog, committedSet)
  const outcomeList = orderOutcomes(scenario, outcomes)

  let verdict: string
  const abortNames = outcomeList.filter((o) => o.status === 'aborted').map((o) => o.label)
  if (!oracle.serializable) {
    verdict = `Not serializable — the committed transactions form a dependency cycle (${oracle.cycle!.join(' → ')} → ${oracle.cycle![0]}).`
  } else if (abortNames.length > 0) {
    verdict = `Serializable — equivalent to the serial order ${oracle.order!.join(' → ') || '∅'} (aborted: ${abortNames.join(', ')}).`
  } else {
    verdict = `Serializable — equivalent to running ${oracle.order!.join(' → ') || 'nothing'} one at a time.`
  }

  return {
    protocol: engine.meta.id,
    meta: engine.meta,
    steps,
    outcomes: outcomeList,
    committedRows: engine.committedRows(),
    serializable: oracle.serializable,
    cycle: oracle.cycle,
    order: oracle.order,
    metrics,
    accessLog,
    verdict,
    verdictKind: oracle.serializable ? 'serializable' : 'nonserializable',
  }
}

/** Order the outcomes by first appearance in the schedule for stable rendering. */
function orderOutcomes(scenario: Scenario, outcomes: Map<string, TxnOutcome>): TxnOutcome[] {
  const order: string[] = []
  const seen = new Set<string>()
  for (const op of scenario.ops) {
    if (!seen.has(op.t)) {
      seen.add(op.t)
      order.push(op.t)
    }
  }
  return order.map((l) => outcomes.get(l) ?? { label: l, status: 'active' as const })
}
