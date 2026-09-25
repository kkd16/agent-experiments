import type { GameInput } from './types'

/** Independent input sources prevent one released finger/key from cancelling another. */
export class FlightInput {
  private dive = new Set<string>()
  private boost = new Set<string>()
  private burstUntil = 0
  set(action: keyof GameInput, source: string, pressed: boolean): void {
    const held = action === 'dive' ? this.dive : this.boost
    if (pressed) held.add(source)
    else held.delete(source)
  }
  release(source: string): void {
    this.dive.delete(source)
    this.boost.delete(source)
  }
  pulse(now: number): void {
    this.burstUntil = now + 140
  }
  value(now: number): GameInput {
    return {
      dive: this.dive.size > 0,
      boost: this.boost.size > 0 || now < this.burstUntil,
    }
  }
  clear(): void {
    this.dive.clear()
    this.boost.clear()
    this.burstUntil = 0
  }
}
