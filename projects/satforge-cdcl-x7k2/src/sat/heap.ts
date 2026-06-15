// A binary max-heap over variables keyed by a floating-point activity score,
// with O(log n) increase-key. This is the variable-ordering structure that
// powers the VSIDS branching heuristic (MiniSat-style).

export class VarOrderHeap {
  private heap: number[] = [] // variable indices, ordered as a binary heap
  private pos: Int32Array // pos[v] = index of v in `heap`, or -1 if absent
  private readonly activity: Float64Array

  constructor(numVars: number, activity: Float64Array) {
    this.pos = new Int32Array(numVars).fill(-1)
    this.activity = activity
  }

  get size(): number {
    return this.heap.length
  }

  contains(v: number): boolean {
    return this.pos[v] >= 0
  }

  private less(a: number, b: number): boolean {
    return this.activity[a] > this.activity[b] // max-heap: higher activity = "smaller" position
  }

  private up(i: number): void {
    const v = this.heap[i]
    while (i > 0) {
      const parent = (i - 1) >> 1
      if (!this.less(v, this.heap[parent])) break
      this.heap[i] = this.heap[parent]
      this.pos[this.heap[i]] = i
      i = parent
    }
    this.heap[i] = v
    this.pos[v] = i
  }

  private down(i: number): void {
    const v = this.heap[i]
    const n = this.heap.length
    for (;;) {
      let child = 2 * i + 1
      if (child >= n) break
      if (child + 1 < n && this.less(this.heap[child + 1], this.heap[child])) child++
      if (!this.less(this.heap[child], v)) break
      this.heap[i] = this.heap[child]
      this.pos[this.heap[i]] = i
      i = child
    }
    this.heap[i] = v
    this.pos[v] = i
  }

  insert(v: number): void {
    if (this.contains(v)) return
    this.heap.push(v)
    this.pos[v] = this.heap.length - 1
    this.up(this.heap.length - 1)
  }

  /** Re-heapify after `activity[v]` increased (VSIDS bump). */
  increase(v: number): void {
    if (this.contains(v)) this.up(this.pos[v])
  }

  /** Remove and return the max-activity variable, or -1 if empty. */
  removeMax(): number {
    if (this.heap.length === 0) return -1
    const top = this.heap[0]
    const last = this.heap.pop()!
    this.pos[top] = -1
    if (this.heap.length > 0) {
      this.heap[0] = last
      this.pos[last] = 0
      this.down(0)
    }
    return top
  }

  /** Rebuild the heap from scratch over the given variables. */
  rebuild(vars: number[]): void {
    this.heap = vars.slice()
    this.pos.fill(-1)
    for (let i = 0; i < this.heap.length; i++) this.pos[this.heap[i]] = i
    for (let i = (this.heap.length >> 1) - 1; i >= 0; i--) this.down(i)
  }
}
