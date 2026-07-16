// audio.ts — procedural PCM sources + a WAV container, so the FLAC codec has
// something to eat and something to prove itself against.
//
// The generators are chosen to tell the compression story: a pure tone and a
// chord are almost perfectly linearly predictable (FLAC's LPC nearly annihilates
// them); a Karplus–Strong pluck is a decaying resonance; formant "speech" is the
// classic source-filter model (a glottal buzz through vocal-tract resonances);
// and white noise is the incompressible floor. WAV export lets the browser's own
// audio decoder PLAY what we made — and lets us load real audio to compress.

import type { Pcm } from './flac.ts'

export interface SignalSpec {
  id: string
  name: string
  note: string
  channels: number
  gen: (sampleRate: number, seconds: number) => Pcm
}

const TAU = Math.PI * 2

function clamp16(v: number): number {
  v = Math.round(v)
  return v < -32768 ? -32768 : v > 32767 ? 32767 : v
}

// A small deterministic PRNG so every render is reproducible (no Math.random).
function makeRng(seed: number): () => number {
  let s = seed >>> 0
  return () => {
    s = (1103515245 * s + 12345) & 0x7fffffff
    return s / 0x7fffffff
  }
}

function monoPcm(sampleRate: number, data: Int32Array): Pcm {
  return { sampleRate, bitsPerSample: 16, channels: 1, samples: [data] }
}

function stereoPcm(sampleRate: number, l: Int32Array, r: Int32Array): Pcm {
  return { sampleRate, bitsPerSample: 16, channels: 2, samples: [l, r] }
}

// ---- the generators ----

function genSine(sr: number, sec: number): Pcm {
  const n = Math.floor(sr * sec)
  const d = new Int32Array(n)
  for (let i = 0; i < n; i++) d[i] = clamp16(22000 * Math.sin((TAU * 440 * i) / sr))
  return monoPcm(sr, d)
}

function genChord(sr: number, sec: number): Pcm {
  const n = Math.floor(sr * sec)
  const d = new Int32Array(n)
  const freqs = [261.63, 329.63, 392.0, 523.25] // C major add-octave
  for (let i = 0; i < n; i++) {
    let s = 0
    for (const f of freqs) s += Math.sin((TAU * f * i) / sr)
    d[i] = clamp16((s / freqs.length) * 24000)
  }
  return monoPcm(sr, d)
}

function genChirp(sr: number, sec: number): Pcm {
  const n = Math.floor(sr * sec)
  const d = new Int32Array(n)
  const f0 = 120, f1 = 4000
  for (let i = 0; i < n; i++) {
    const t = i / sr
    const k = (f1 - f0) / sec
    const phase = TAU * (f0 * t + 0.5 * k * t * t)
    d[i] = clamp16(20000 * Math.sin(phase))
  }
  return monoPcm(sr, d)
}

function genPluck(sr: number, sec: number): Pcm {
  // Karplus–Strong: a burst of noise recirculated through a short averaging delay
  // line — a decaying string. Highly self-similar → LPC + Rice love it.
  const n = Math.floor(sr * sec)
  const d = new Int32Array(n)
  const rng = makeRng(0xf1ac)
  const notes = [220, 277, 330, 440]
  let pos = 0
  for (const f of notes) {
    const noteLen = Math.floor(n / notes.length)
    const N = Math.max(2, Math.floor(sr / f))
    const buf = new Float64Array(N)
    for (let i = 0; i < N; i++) buf[i] = (rng() * 2 - 1)
    let bi = 0
    for (let i = 0; i < noteLen && pos < n; i++, pos++) {
      const cur = buf[bi]
      const nxt = buf[(bi + 1) % N]
      const avg = 0.5 * (cur + nxt) * 0.996 // damping
      d[pos] = clamp16(cur * 26000)
      buf[bi] = avg
      bi = (bi + 1) % N
    }
  }
  return monoPcm(sr, d)
}

function genSpeech(sr: number, sec: number): Pcm {
  // Source–filter "vowel": a band-limited glottal pulse train driven through a
  // pair of formant resonators, the formants gliding a→i→u.
  const n = Math.floor(sr * sec)
  const d = new Int32Array(n)
  const f0 = 120 // pitch
  const vowels = [
    [700, 1220], [400, 2000], [350, 800], // ah, ee, oo
  ]
  // two 2-pole resonators, state per formant
  const y1 = [0, 0], y2 = [0, 0]
  let phase = 0
  for (let i = 0; i < n; i++) {
    const t = i / n
    const vi = Math.min(vowels.length - 1, Math.floor(t * vowels.length))
    const [F1, F2] = vowels[vi]
    // glottal source: a narrow pulse each pitch period
    phase += f0 / sr
    let src = 0
    if (phase >= 1) { phase -= 1; src = 1 }
    src -= 0.5 / (sr / f0) // remove DC-ish
    // resonators (biquad-ish, integer-friendly floats)
    const formants = [F1, F2]
    let out = 0
    for (let k = 0; k < 2; k++) {
      const w = TAU * formants[k] / sr
      const r = 0.97
      const a1 = 2 * r * Math.cos(w)
      const a2 = -r * r
      const yk = src + a1 * y1[k] + a2 * y2[k]
      y2[k] = y1[k]; y1[k] = yk
      out += yk
    }
    d[i] = clamp16(out * 1600)
  }
  return monoPcm(sr, d)
}

function genNoise(sr: number, sec: number): Pcm {
  const n = Math.floor(sr * sec)
  const d = new Int32Array(n)
  const rng = makeRng(0xbeef)
  for (let i = 0; i < n; i++) d[i] = clamp16((rng() * 2 - 1) * 30000)
  return monoPcm(sr, d)
}

function genStereoPad(sr: number, sec: number): Pcm {
  // A detuned two-oscillator pad, panned — the channels are near-identical (a
  // small phase offset), the case mid/side stereo decorrelation was built for.
  const n = Math.floor(sr * sec)
  const l = new Int32Array(n), r = new Int32Array(n)
  const freqs = [146.83, 220, 293.66]
  for (let i = 0; i < n; i++) {
    let sl = 0, srr = 0
    for (const f of freqs) {
      sl += Math.sin((TAU * f * i) / sr)
      srr += Math.sin((TAU * f * 1.003 * i) / sr) // slight detune → subtle side signal
    }
    l[i] = clamp16((sl / freqs.length) * 21000)
    r[i] = clamp16((srr / freqs.length) * 21000)
  }
  return stereoPcm(sr, l, r)
}

export const SIGNALS: SignalSpec[] = [
  { id: 'sine', name: 'Pure tone (440 Hz)', note: 'a single sinusoid — order-2 LPC nearly annihilates it', channels: 1, gen: genSine },
  { id: 'chord', name: 'C-major chord', note: 'four sinusoids — still deeply linear-predictable', channels: 1, gen: genChord },
  { id: 'chirp', name: 'Sweep (120→4k Hz)', note: 'a gliding tone — the predictor tracks the frequency', channels: 1, gen: genChirp },
  { id: 'pluck', name: 'Plucked string', note: 'Karplus–Strong resonance, four notes — decaying + periodic', channels: 1, gen: genPluck },
  { id: 'speech', name: 'Vowel glide (a→i→u)', note: 'source–filter "speech" — glottal buzz through formants', channels: 1, gen: genSpeech },
  { id: 'pad', name: 'Detuned pad (stereo)', note: 'near-identical channels — the mid/side case', channels: 2, gen: genStereoPad },
  { id: 'noise', name: 'White noise', note: 'the incompressible floor — LPC finds no structure', channels: 1, gen: genNoise },
]

// ---------------------------------------------------------------------------
// WAV (RIFF/PCM) container — 16-bit, mono or stereo. Encode for playback and
// download; decode to accept uploaded audio.
// ---------------------------------------------------------------------------

export function encodeWav(pcm: Pcm): Uint8Array {
  const n = pcm.samples[0].length
  const ch = pcm.channels
  const bytesPerSample = 2
  const blockAlign = ch * bytesPerSample
  const dataSize = n * blockAlign
  const buf = new Uint8Array(44 + dataSize)
  const dv = new DataView(buf.buffer)
  let o = 0
  const str = (s: string) => { for (let i = 0; i < s.length; i++) buf[o++] = s.charCodeAt(i) }
  str('RIFF'); dv.setUint32(o, 36 + dataSize, true); o += 4
  str('WAVE')
  str('fmt '); dv.setUint32(o, 16, true); o += 4
  dv.setUint16(o, 1, true); o += 2 // PCM
  dv.setUint16(o, ch, true); o += 2
  dv.setUint32(o, pcm.sampleRate, true); o += 4
  dv.setUint32(o, pcm.sampleRate * blockAlign, true); o += 4
  dv.setUint16(o, blockAlign, true); o += 2
  dv.setUint16(o, 16, true); o += 2
  str('data'); dv.setUint32(o, dataSize, true); o += 4
  for (let i = 0; i < n; i++) {
    for (let c = 0; c < ch; c++) {
      let v = pcm.samples[c][i]
      if (v < -32768) v = -32768; else if (v > 32767) v = 32767
      dv.setInt16(o, v, true); o += 2
    }
  }
  return buf
}

export function decodeWav(data: Uint8Array): Pcm {
  const dv = new DataView(data.buffer, data.byteOffset, data.byteLength)
  if (String.fromCharCode(data[0], data[1], data[2], data[3]) !== 'RIFF') throw new Error('not a WAV (no RIFF)')
  let o = 12
  let sampleRate = 44100, channels = 1, bits = 16
  let dataOff = -1, dataLen = 0
  while (o + 8 <= data.length) {
    const id = String.fromCharCode(data[o], data[o + 1], data[o + 2], data[o + 3])
    const size = dv.getUint32(o + 4, true)
    const body = o + 8
    if (id === 'fmt ') {
      channels = dv.getUint16(body + 2, true)
      sampleRate = dv.getUint32(body + 4, true)
      bits = dv.getUint16(body + 14, true)
    } else if (id === 'data') {
      dataOff = body; dataLen = size
    }
    o = body + size + (size & 1)
  }
  if (dataOff < 0) throw new Error('WAV has no data chunk')
  const bytesPerSample = bits >> 3
  const blockAlign = channels * bytesPerSample
  const n = Math.floor(dataLen / blockAlign)
  const out: Int32Array[] = []
  for (let c = 0; c < channels; c++) out.push(new Int32Array(n))
  for (let i = 0; i < n; i++) {
    for (let c = 0; c < channels; c++) {
      const p = dataOff + i * blockAlign + c * bytesPerSample
      let v: number
      if (bits === 16) v = dv.getInt16(p, true)
      else if (bits === 8) v = data[p] - 128 // 8-bit WAV is unsigned
      else if (bits === 24) { v = data[p] | (data[p + 1] << 8) | (data[p + 2] << 16); if (v & 0x800000) v -= 0x1000000 }
      else if (bits === 32) v = dv.getInt32(p, true)
      else v = 0
      out[c][i] = v
    }
  }
  return { sampleRate, bitsPerSample: bits === 8 || bits === 24 || bits === 32 ? bits : 16, channels, samples: out }
}

/** Peak-preserving downsample of one channel to at most `width` points, for
 *  drawing a waveform. Returns [min,max] pairs so transients stay visible. */
export function waveformBins(ch: Int32Array, width: number): { min: number; max: number }[] {
  const bins: { min: number; max: number }[] = []
  const n = ch.length
  if (n === 0) return bins
  const per = Math.max(1, Math.floor(n / width))
  for (let x = 0; x < n; x += per) {
    let mn = Infinity, mx = -Infinity
    const end = Math.min(n, x + per)
    for (let i = x; i < end; i++) { if (ch[i] < mn) mn = ch[i]; if (ch[i] > mx) mx = ch[i] }
    bins.push({ min: mn, max: mx })
  }
  return bins
}
