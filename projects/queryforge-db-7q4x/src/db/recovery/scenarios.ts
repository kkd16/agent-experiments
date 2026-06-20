// A library of canonical crash-recovery scenarios. Each one is a short workload
// over a handful of pages — a sequence of updates, flushes, commits and (crucially)
// a CRASH at a chosen point — picked to isolate one pillar of ARIES: why NO-FORCE
// demands REDO, why STEAL demands UNDO, how a fuzzy checkpoint bounds the work, and
// how CLRs make recovery itself restartable.

import type { Cell, PageId } from './wal'

export type WlOp =
  | { kind: 'begin'; t: string }
  | { kind: 'update'; t: string; page: PageId; value: Cell }
  | { kind: 'commit'; t: string }
  | { kind: 'abort'; t: string }
  | { kind: 'flushPage'; page: PageId }
  | { kind: 'flushLog' }
  | { kind: 'checkpoint' }
  | { kind: 'crash' }

/** Which idea the scenario foregrounds (drives a small UI badge). */
export type Highlight = 'redo' | 'undo' | 'both' | 'checkpoint' | 'idempotence'

export interface RecScenario {
  id: string
  title: string
  tagline: string
  blurb: string
  lesson: string
  highlight: Highlight
  initial: { page: PageId; value: Cell }[]
  ops: WlOp[]
  /**
   * If set, simulate a *second* crash during the undo pass after this many CLRs
   * have been written, then restart recovery — demonstrating that ARIES recovery
   * is itself restartable (no work is lost or repeated).
   */
  recoveryCrash?: number
}

// --- tiny op builders -------------------------------------------------------
const begin = (t: string): WlOp => ({ kind: 'begin', t })
const upd = (t: string, page: PageId, value: Cell): WlOp => ({ kind: 'update', t, page, value })
const commit = (t: string): WlOp => ({ kind: 'commit', t })
const abort = (t: string): WlOp => ({ kind: 'abort', t })
const flush = (page: PageId): WlOp => ({ kind: 'flushPage', page })
const ckpt = (): WlOp => ({ kind: 'checkpoint' })
const crash = (): WlOp => ({ kind: 'crash' })

export const REC_SCENARIOS: RecScenario[] = [
  {
    id: 'redo-after-commit',
    title: 'Committed, not yet on disk',
    tagline: 'NO-FORCE ⟹ REDO',
    highlight: 'redo',
    blurb:
      'T1 updates two pages and commits — so the commit record is forced to the log — but the dirty pages never get written to disk before the power fails. The committed data lives only in the log.',
    lesson:
      'Under NO-FORCE a commit does not flush the changed pages, only the log. REDO replays the logged after-images, so a committed transaction survives even though its pages never reached disk. Lose REDO and you lose durability.',
    initial: [
      { page: 'A', value: 100 },
      { page: 'B', value: 50 },
    ],
    ops: [begin('T1'), upd('T1', 'A', 200), upd('T1', 'B', 75), commit('T1'), crash()],
  },
  {
    id: 'undo-uncommitted',
    title: 'Uncommitted page stolen to disk',
    tagline: 'STEAL ⟹ UNDO',
    highlight: 'undo',
    blurb:
      'T1 updates page A, and the buffer manager STEALS that dirty frame — writing the uncommitted A to disk to reclaim memory — and then the machine crashes before T1 ever commits.',
    lesson:
      'STEAL lets an uncommitted change reach disk, so after a crash the disk holds data no committed transaction ever sanctioned. UNDO walks the loser backward, restoring the before-image and logging a CLR. Lose UNDO and you lose atomicity.',
    initial: [{ page: 'A', value: 10 }],
    ops: [begin('T1'), upd('T1', 'A', 99), flush('A'), crash()],
  },
  {
    id: 'winners-and-losers',
    title: 'Winners and losers, interleaved',
    tagline: 'repeat history, then undo',
    highlight: 'both',
    blurb:
      'T1 (which commits) and T2 (which does not) run concurrently across three pages, and T2’s dirty page B is stolen to disk. The crash catches T2 mid-flight.',
    lesson:
      'REDO repeats *all* history — T1’s and T2’s changes alike — restoring the exact crash state. Only then does UNDO roll back the single loser T2. Repeating history first is what gives UNDO a known starting point.',
    initial: [
      { page: 'A', value: 1 },
      { page: 'B', value: 2 },
      { page: 'C', value: 3 },
    ],
    ops: [
      begin('T1'),
      begin('T2'),
      upd('T1', 'A', 10),
      upd('T2', 'B', 20),
      upd('T1', 'C', 30),
      flush('B'),
      commit('T1'),
      crash(),
    ],
  },
  {
    id: 'checkpoint',
    title: 'A fuzzy checkpoint bounds the work',
    tagline: 'start REDO at the checkpoint',
    highlight: 'checkpoint',
    blurb:
      'T1 commits and its page A is flushed, then the system takes a fuzzy checkpoint, then T2 commits a change to B that never reaches disk. The crash follows.',
    lesson:
      'Analysis begins at the begin_checkpoint and installs its dirty-page-table snapshot, so REDO starts at B — A’s long-since-flushed change is never re-examined. Checkpoints cap how far back recovery must read.',
    initial: [
      { page: 'A', value: 1 },
      { page: 'B', value: 1 },
      { page: 'C', value: 1 },
    ],
    ops: [
      begin('T1'),
      upd('T1', 'A', 5),
      commit('T1'),
      flush('A'),
      ckpt(),
      begin('T2'),
      upd('T2', 'B', 7),
      commit('T2'),
      crash(),
    ],
  },
  {
    id: 'crash-during-recovery',
    title: 'A crash during recovery',
    tagline: 'CLRs make recovery restartable',
    highlight: 'idempotence',
    blurb:
      'T1 dirties two pages, both of which are stolen to disk, and never commits. Recovery starts to roll it back — but the machine crashes *again* after the first compensation. Then it restarts once more.',
    lesson:
      'Because every undo is itself logged as a redo-only CLR carrying an undoNextLSN, the restart redoes the CLRs (repeating history) and resumes undo exactly where it stopped — page B is not rolled back twice. ARIES recovery is restartable to any depth.',
    initial: [
      { page: 'A', value: 1 },
      { page: 'B', value: 1 },
    ],
    ops: [begin('T1'), upd('T1', 'A', 11), upd('T1', 'B', 22), flush('A'), flush('B'), crash()],
    recoveryCrash: 1,
  },
  {
    id: 'normal-rollback',
    title: 'Rollback is just undo',
    tagline: 'CLRs outside of recovery',
    highlight: 'undo',
    blurb:
      'During normal operation T1 makes two changes and then explicitly ROLLs BACK — logging CLRs as it goes — while T2 commits a change to the same page X. Later, the system crashes.',
    lesson:
      'A normal rollback uses the identical CLR machinery as crash recovery: T1’s end record means it is no loser at restart. REDO faithfully replays the original updates *and* the CLRs that cancelled them, leaving only T2’s committed write.',
    initial: [
      { page: 'X', value: 0 },
      { page: 'Y', value: 0 },
    ],
    ops: [
      begin('T1'),
      upd('T1', 'X', 5),
      upd('T1', 'Y', 6),
      abort('T1'),
      begin('T2'),
      upd('T2', 'X', 9),
      commit('T2'),
      crash(),
    ],
  },
]

export function recScenarioById(id: string): RecScenario {
  return REC_SCENARIOS.find((s) => s.id === id) ?? REC_SCENARIOS[0]
}
