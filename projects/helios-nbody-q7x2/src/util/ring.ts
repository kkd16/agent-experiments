// Fixed-capacity ring buffer of numbers, for rolling diagnostic plots.

import type { Series } from '../components/Plot'

export class Ring {
  data: Float64Array
  length = 0
  capacity: number
  private head = 0 // next write position

  constructor(capacity: number) {
    this.capacity = capacity
    this.data = new Float64Array(capacity)
  }

  push(v: number): void {
    this.data[this.head] = v
    this.head = (this.head + 1) % this.capacity
    if (this.length < this.capacity) this.length++
  }

  clear(): void {
    this.length = 0
    this.head = 0
  }

  /** Build a Plot series view (oldest → newest) for a given colour. */
  series(color: string): Series {
    const start = this.length < this.capacity ? 0 : this.head
    return { color, data: this.data, length: this.length, start }
  }

  get last(): number {
    if (this.length === 0) return NaN
    return this.data[(this.head - 1 + this.capacity) % this.capacity]
  }
}
