// A binary min-heap priority queue for the simulation's event schedule.
//
// Events are ordered by (time, seq): earliest virtual time first, and within
// the same instant by insertion order, so the simulation is fully deterministic
// and never depends on JS object/array iteration quirks.

export interface Prioritized {
  /** Virtual time (ms) at which the item becomes due. */
  time: number;
  /** Monotonic insertion counter, the tie-breaker at equal times. */
  seq: number;
}

export class PriorityQueue<T extends Prioritized> {
  private heap: T[] = [];

  get size(): number {
    return this.heap.length;
  }

  peek(): T | undefined {
    return this.heap[0];
  }

  private less(a: T, b: T): boolean {
    return a.time < b.time || (a.time === b.time && a.seq < b.seq);
  }

  push(item: T): void {
    const h = this.heap;
    h.push(item);
    let i = h.length - 1;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (this.less(h[i], h[parent])) {
        [h[i], h[parent]] = [h[parent], h[i]];
        i = parent;
      } else break;
    }
  }

  pop(): T | undefined {
    const h = this.heap;
    if (h.length === 0) return undefined;
    const top = h[0];
    const last = h.pop()!;
    if (h.length > 0) {
      h[0] = last;
      this.siftDown(0);
    }
    return top;
  }

  private siftDown(start: number): void {
    const h = this.heap;
    const n = h.length;
    let i = start;
    for (;;) {
      const l = 2 * i + 1;
      const r = 2 * i + 2;
      let smallest = i;
      if (l < n && this.less(h[l], h[smallest])) smallest = l;
      if (r < n && this.less(h[r], h[smallest])) smallest = r;
      if (smallest === i) break;
      [h[i], h[smallest]] = [h[smallest], h[i]];
      i = smallest;
    }
  }

  clear(): void {
    this.heap = [];
  }

  /** A stable, time-ordered snapshot (used for rendering in-flight messages). */
  toSortedArray(): T[] {
    return this.heap.slice().sort((a, b) => a.time - b.time || a.seq - b.seq);
  }
}
