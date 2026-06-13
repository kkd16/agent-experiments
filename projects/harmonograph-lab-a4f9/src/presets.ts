import type { HarmonographParams } from './harmonograph'

export interface Preset {
  name: string
  params: HarmonographParams
}

const STEPS = 6000

// Hand-picked figures — good starting points that show off the range of the
// instrument. Near-integer frequency ratios keep them coherent; the phases and
// damping shape how each one winds inward.
export const PRESETS: Preset[] = [
  {
    name: 'Rosette',
    params: {
      x1: { freq: 2, phase: 0, amp: 1, damp: 0.0032 },
      x2: { freq: 4, phase: Math.PI / 2, amp: 0.5, damp: 0.0032 },
      y1: { freq: 3, phase: 0, amp: 1, damp: 0.0032 },
      y2: { freq: 5, phase: Math.PI / 3, amp: 0.5, damp: 0.0032 },
      duration: 260,
      steps: STEPS,
    },
  },
  {
    name: 'Knot',
    params: {
      x1: { freq: 3, phase: Math.PI / 4, amp: 1, damp: 0.0045 },
      x2: { freq: 2, phase: 0, amp: 0.8, damp: 0.0045 },
      y1: { freq: 2, phase: Math.PI / 2, amp: 1, damp: 0.0045 },
      y2: { freq: 3, phase: 0, amp: 0.8, damp: 0.0045 },
      duration: 220,
      steps: STEPS,
    },
  },
  {
    name: 'Spiral',
    params: {
      x1: { freq: 1, phase: 0, amp: 1, damp: 0.012 },
      x2: { freq: 5, phase: Math.PI / 2, amp: 0.35, damp: 0.004 },
      y1: { freq: 1, phase: Math.PI / 2, amp: 1, damp: 0.012 },
      y2: { freq: 5, phase: 0, amp: 0.35, damp: 0.004 },
      duration: 300,
      steps: STEPS,
    },
  },
  {
    name: 'Lattice',
    params: {
      x1: { freq: 4, phase: 0, amp: 1, damp: 0.0018 },
      x2: { freq: 5, phase: Math.PI / 6, amp: 0.6, damp: 0.0018 },
      y1: { freq: 5, phase: 0, amp: 1, damp: 0.0018 },
      y2: { freq: 4, phase: Math.PI / 4, amp: 0.6, damp: 0.0018 },
      duration: 340,
      steps: STEPS,
    },
  },
]
