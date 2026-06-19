// Audio-reactive driving. We tap the microphone through the Web Audio API and
// expose a single smoothed 0..1 "level" plus a low-frequency "bass" band, which
// the app uses to pulse glow and line width in time with sound. Everything is
// feature-detected and try/caught: if the API is missing, permission is denied,
// or we're in the sandboxed catalog thumbnail, start() simply resolves to false
// and the rest of the app carries on, silent.

type AudioCtor = typeof AudioContext

function audioContextCtor(): AudioCtor | undefined {
  try {
    const w = window as unknown as { AudioContext?: AudioCtor; webkitAudioContext?: AudioCtor }
    return w.AudioContext ?? w.webkitAudioContext
  } catch {
    return undefined
  }
}

export function canAudio(): boolean {
  try {
    return (
      typeof navigator !== 'undefined' &&
      !!navigator.mediaDevices &&
      typeof navigator.mediaDevices.getUserMedia === 'function' &&
      audioContextCtor() !== undefined
    )
  } catch {
    return false
  }
}

export class AudioReactor {
  private ctx: AudioContext | null = null
  private analyser: AnalyserNode | null = null
  private stream: MediaStream | null = null
  private freq: Uint8Array<ArrayBuffer> | null = null
  private level = 0
  private bass = 0

  // Resolves true once the mic is live and analysing, false if anything along
  // the way is unavailable or refused. Never throws.
  async start(): Promise<boolean> {
    if (!canAudio()) return false
    try {
      const Ctor = audioContextCtor()
      if (!Ctor) return false
      this.stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      this.ctx = new Ctor()
      // Some browsers start the context suspended until a user gesture.
      if (this.ctx.state === 'suspended') {
        try {
          await this.ctx.resume()
        } catch {
          /* ignore */
        }
      }
      const src = this.ctx.createMediaStreamSource(this.stream)
      this.analyser = this.ctx.createAnalyser()
      this.analyser.fftSize = 512
      this.analyser.smoothingTimeConstant = 0.75
      src.connect(this.analyser)
      this.freq = new Uint8Array(this.analyser.frequencyBinCount)
      return true
    } catch {
      this.stop()
      return false
    }
  }

  // Sample the current spectrum and update the smoothed envelopes. Returns the
  // overall level; call once per animation frame.
  sample(): number {
    if (!this.analyser || !this.freq) return 0
    try {
      this.analyser.getByteFrequencyData(this.freq)
    } catch {
      return this.level
    }
    const bins = this.freq.length
    let sum = 0
    let bassSum = 0
    const bassBins = Math.max(1, Math.floor(bins * 0.12))
    for (let i = 0; i < bins; i++) {
      const v = this.freq[i] / 255
      sum += v
      if (i < bassBins) bassSum += v
    }
    const overall = sum / bins
    const bassNow = bassSum / bassBins
    // Asymmetric smoothing: snap up to transients, ease back down — reads as a
    // musical pulse rather than a jitter.
    this.level += (overall - this.level) * (overall > this.level ? 0.6 : 0.12)
    this.bass += (bassNow - this.bass) * (bassNow > this.bass ? 0.7 : 0.14)
    return this.level
  }

  getLevel(): number {
    return this.level
  }
  getBass(): number {
    return this.bass
  }

  stop() {
    try {
      this.stream?.getTracks().forEach((t) => t.stop())
    } catch {
      /* ignore */
    }
    try {
      this.ctx?.close()
    } catch {
      /* ignore */
    }
    this.stream = null
    this.ctx = null
    this.analyser = null
    this.freq = null
    this.level = 0
    this.bass = 0
  }
}
