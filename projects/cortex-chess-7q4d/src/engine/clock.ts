// clock.ts — UCI-style time management. Instead of a fixed think-time per move, a
// time control gives each side a *clock* (base time + a per-move increment); the
// engine then decides how long to think on each move from the time it has left.
//
// The allocator is deliberately simple and robust (the shape most engines use):
//   • a sudden-death clock is spread over an assumed ~M remaining moves, plus most
//     of the increment, so time scales down smoothly as the clock drains;
//   • a hard cap (a fraction of the remaining time) guarantees we never flag;
//   • a soft target (~the per-move budget) is where iterative deepening stops
//     starting new plies, while the hard cap bounds an in-progress ply.

export interface TimeControl {
  label: string
  baseMs: number
  incMs: number
}

export interface TimeBudget {
  softMs: number // stop starting new iterations past this
  hardMs: number // never exceed this on one move
}

// Allocate a move's time budget from the clock. `movesToGo` > 0 selects a
// tournament time control with a known move count; 0 means sudden death.
export function allocateTime(remainingMs: number, incMs: number, movesToGo = 0): TimeBudget {
  const overhead = 40 // safety margin for message/render latency
  const rem = Math.max(0, remainingMs - overhead)
  if (rem <= 0) return { softMs: 10, hardMs: Math.max(20, incMs * 0.5) }

  const assumedMoves = movesToGo > 0 ? movesToGo : 26
  const target = rem / assumedMoves + incMs * 0.8

  // Never spend more than ~40% of what's left on a single move; cap the soft
  // budget at the per-move target so we usually finish iterations cleanly.
  const hard = Math.min(rem * 0.4, target * 3.5)
  const soft = Math.min(hard, target)
  return { softMs: Math.max(10, Math.round(soft)), hardMs: Math.max(20, Math.round(hard)) }
}

// A handful of familiar online time controls (base + increment, in seconds).
export const TIME_CONTROLS: { label: string; tc: TimeControl | null }[] = [
  { label: 'Off', tc: null },
  { label: 'Bullet 1+0', tc: { label: '1+0', baseMs: 60_000, incMs: 0 } },
  { label: 'Bullet 2+1', tc: { label: '2+1', baseMs: 120_000, incMs: 1_000 } },
  { label: 'Blitz 3+2', tc: { label: '3+2', baseMs: 180_000, incMs: 2_000 } },
  { label: 'Blitz 5+3', tc: { label: '5+3', baseMs: 300_000, incMs: 3_000 } },
  { label: 'Rapid 10+5', tc: { label: '10+5', baseMs: 600_000, incMs: 5_000 } },
]

// mm:ss(.t) for a clock display.
export function formatClock(ms: number): string {
  const clamped = Math.max(0, ms)
  const totalSec = clamped / 1000
  const m = Math.floor(totalSec / 60)
  const s = Math.floor(totalSec % 60)
  if (clamped < 10_000) {
    // Under 10s, show a tenth so the countdown reads as live.
    return `${s}.${Math.floor((clamped % 1000) / 100)}`
  }
  return `${m}:${s.toString().padStart(2, '0')}`
}
