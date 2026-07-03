// A shared, physically-motivated source generator for the audio modes.
//
// Real voiced sounds (a sung vowel, a bowed string, a brass note) are a
// harmonic *source* — a buzzy, band-limited pulse train rich in overtones —
// shaped by *resonances* that carve broad peaks into the spectrum. For a voice
// those peaks are the vowel formants; for an instrument they are the body/bore
// resonances. Modelling the two separately is exactly what the phase vocoder
// (which moves the whole spectrum) and the cepstrum (which pulls the two apart)
// are built to expose, so every audio mode draws its test signals from here.
//
// Everything is a plain additive sum of sinusoids — no filters, no libraries —
// so the spectrum is analytic and the self-tests can predict it exactly.

export interface Formant {
  freq: number // centre frequency (Hz)
  bw: number // bandwidth (Hz) — controls how sharp the resonance is
  gain: number // linear peak gain
}

// A handful of canonical vowels (first three formants, rough averages of an
// adult voice). Enough to make the timbre change audibly between presets.
export const VOWELS: { id: string; label: string; formants: Formant[] }[] = [
  { id: 'ah', label: 'Vowel “ah”', formants: f3(730, 1090, 2440) },
  { id: 'ee', label: 'Vowel “ee”', formants: f3(270, 2290, 3010) },
  { id: 'oo', label: 'Vowel “oo”', formants: f3(300, 870, 2240) },
  { id: 'oh', label: 'Vowel “oh”', formants: f3(570, 840, 2410) },
  { id: 'brass', label: 'Brass', formants: [f1(1200, 1400, 1.0), f1(2400, 1600, 0.5)] },
]

function f1(freq: number, bw: number, gain: number): Formant {
  return { freq, bw, gain }
}
function f3(f1v: number, f2v: number, f3v: number): Formant[] {
  return [
    { freq: f1v, bw: 90, gain: 1.0 },
    { freq: f2v, bw: 110, gain: 0.55 },
    { freq: f3v, bw: 170, gain: 0.28 },
  ]
}

/** Resonant (Lorentzian) envelope of a set of formants, evaluated at f Hz. */
export function formantEnvelope(f: number, formants: Formant[]): number {
  let g = 0.02 // a small tilt/noise floor so between-formant valleys aren't zero
  for (const fmt of formants) {
    const half = fmt.bw / 2
    // A single-pole resonance magnitude: peak = gain at centre, −3 dB at ±bw/2.
    const d = (f - fmt.freq) / half
    g += fmt.gain / (1 + d * d)
    // Mirror a little of the resonance for the negative-frequency image so very
    // low formants still lift the fundamental.
    const dm = (f + fmt.freq) / half
    g += 0.15 * fmt.gain / (1 + dm * dm)
  }
  return g
}

export interface VoiceOptions {
  f0: number // fundamental (Hz)
  fs: number // sample rate (Hz)
  formants: Formant[]
  vibratoHz?: number // vibrato rate (0 = off)
  vibratoCents?: number // vibrato depth in cents
  tilt?: number // spectral tilt exponent for the source (default −1: 1/n rolloff)
}

/**
 * Synthesise `n` samples of a voiced sound: a harmonic series (the glottal
 * source, amplitude ∝ harmonic^tilt) whose partials are scaled by the formant
 * envelope. Optional vibrato modulates the fundamental. Peak-normalised.
 */
export function voicedSignal(n: number, opts: VoiceOptions): Float64Array {
  const { f0, fs, formants } = opts
  const tilt = opts.tilt ?? -1
  const vibHz = opts.vibratoHz ?? 0
  const vibDepth = (opts.vibratoCents ?? 0) / 1200 // fraction of an octave
  const nyq = fs / 2
  const maxH = Math.max(1, Math.floor((nyq - 1) / f0))

  // Precompute per-harmonic amplitudes (source tilt × formant shaping).
  const amp = new Float64Array(maxH + 1)
  for (let h = 1; h <= maxH; h++) {
    const f = h * f0
    const source = Math.pow(h, tilt)
    amp[h] = source * formantEnvelope(f, formants)
  }

  const out = new Float64Array(n)
  // Integrate instantaneous phase so vibrato is smooth and continuous.
  let phase0 = 0
  const twoPi = 2 * Math.PI
  for (let i = 0; i < n; i++) {
    const t = i / fs
    const vib = vibHz > 0 ? Math.exp(Math.LN2 * vibDepth * Math.sin(twoPi * vibHz * t)) : 1
    const inst = f0 * vib
    phase0 += (twoPi * inst) / fs
    let v = 0
    for (let h = 1; h <= maxH; h++) {
      v += amp[h] * Math.sin(h * phase0)
    }
    out[i] = v
  }

  // Peak-normalise.
  let peak = 1e-9
  for (let i = 0; i < n; i++) {
    const a = Math.abs(out[i])
    if (a > peak) peak = a
  }
  const g = 0.98 / peak
  for (let i = 0; i < n; i++) out[i] *= g
  return out
}

/**
 * A band-limited impulse (pulse) train of the given period — the archetypal
 * "excitation" whose cepstrum has a single clean peak at the period. Used by
 * the cepstrum self-tests and as a raw-source preset.
 */
export function pulseTrain(n: number, period: number, harmonics: number): Float64Array {
  const out = new Float64Array(n)
  const w = (2 * Math.PI) / period
  for (let i = 0; i < n; i++) {
    let v = 0
    for (let h = 1; h <= harmonics; h++) v += Math.cos(w * h * i)
    out[i] = v
  }
  let peak = 1e-9
  for (let i = 0; i < n; i++) peak = Math.max(peak, Math.abs(out[i]))
  for (let i = 0; i < n; i++) out[i] /= peak
  return out
}
