// Undo/redo over serialised circuit snapshots. States are JSON strings of a
// SavedCircuit; a gesture calls begin() before mutating and commit() after, and
// only a snapshot that actually changed is pushed — so a click that selects but
// doesn't edit never litters the timeline.

const CAP = 100

export class History {
  private past: string[] = []
  private future: string[] = []
  private pending: string | null = null

  /** Remember the pre-mutation state. Nested begins keep the outermost snapshot. */
  begin(current: string) {
    if (this.pending === null) this.pending = current
  }

  /** Close a gesture, pushing the checkpoint only if the state really changed. */
  commit(current: string) {
    if (this.pending !== null && this.pending !== current) {
      this.past.push(this.pending)
      if (this.past.length > CAP) this.past.shift()
      this.future = []
    }
    this.pending = null
  }

  /** Abandon a gesture without recording anything. */
  cancel() {
    this.pending = null
  }

  /** Convenience for a discrete edit whose before-state is already known. */
  record(before: string, after: string) {
    if (before === after) return
    this.past.push(before)
    if (this.past.length > CAP) this.past.shift()
    this.future = []
    this.pending = null
  }

  canUndo(): boolean {
    return this.past.length > 0
  }
  canRedo(): boolean {
    return this.future.length > 0
  }

  /** Step back one state, banking `current` for redo. Returns the state to restore. */
  undo(current: string): string | null {
    const prev = this.past.pop()
    if (prev === undefined) return null
    this.future.push(current)
    return prev
  }

  /** Step forward one state, banking `current` for undo. */
  redo(current: string): string | null {
    const next = this.future.pop()
    if (next === undefined) return null
    this.past.push(current)
    return next
  }

  clear() {
    this.past = []
    this.future = []
    this.pending = null
  }
}
