// Map a frequency (Hz) to the nearest musical note, plus how many cents sharp or
// flat it sits. Standard 12-tone equal temperament, A4 = 440 Hz = MIDI 69.

const NAMES = ['C', 'C♯', 'D', 'D♯', 'E', 'F', 'F♯', 'G', 'G♯', 'A', 'A♯', 'B']

export interface NoteReading {
  name: string // e.g. "A4"
  cents: number // −50..+50, signed distance to the nearest note
  midi: number // rounded MIDI number
  freq: number // the input frequency
}

/** Nearest note + cents deviation for a frequency. Returns null for silence. */
export function freqToNote(freq: number): NoteReading | null {
  if (!(freq > 0) || !Number.isFinite(freq)) return null
  const midiFloat = 69 + 12 * Math.log2(freq / 440)
  const midi = Math.round(midiFloat)
  const cents = Math.round((midiFloat - midi) * 100)
  const name = NAMES[((midi % 12) + 12) % 12]
  const octave = Math.floor(midi / 12) - 1
  return { name: `${name}${octave}`, cents, midi, freq }
}

/**
 * Refine a spectral peak's frequency with parabolic interpolation over the
 * magnitude of the peak bin and its two neighbours — sub-bin accuracy without a
 * finer transform.
 */
export function refinePeak(mag: ArrayLike<number>, k: number, binHz: number): number {
  if (k <= 0 || k >= mag.length - 1) return k * binHz
  const a = mag[k - 1]
  const b = mag[k]
  const c = mag[k + 1]
  const denom = a - 2 * b + c
  const delta = denom !== 0 ? (0.5 * (a - c)) / denom : 0
  return (k + Math.max(-0.5, Math.min(0.5, delta))) * binHz
}
