// A tiny Web Audio playback engine so the lab is *audible*, not just visible.
//
// Everything here is defensive: the AudioContext is created lazily on the first
// user gesture (browsers block autoplay), and every call is wrapped so that a
// sandboxed catalog thumbnail — where audio may be unavailable — never throws.
//
// The core trick: a computed Float64Array signal is copied into an AudioBuffer
// and looped. We pick a playback sample rate that lifts the signal's abstract
// "bin frequency" into the audible band, so dragging a frequency slider tracks
// an audible pitch. Because the test signals contain (near) whole numbers of
// cycles across the buffer, the loop is (near) seamless.

export interface PlayOptions {
  sampleRate?: number // AudioBuffer sample rate (Hz). Clamped to a valid range.
  loop?: boolean
  gain?: number // 0..1 peak gain after normalization
  fadeMs?: number // attack/release ramp to avoid clicks
}

export interface PlayHandle {
  stop: () => void
  readonly stopped: boolean
}

// The Web Audio types aren't in the default TS lib target here for the webkit
// fallback; keep a minimal structural type.
type Ctx = AudioContext

class AudioEngine {
  private ctx: Ctx | null = null
  private master: GainNode | null = null
  private active: { src: AudioBufferSourceNode; gain: GainNode; handle: PlayHandle } | null = null
  private failed = false
  private volume = 0.7

  /** Whether audio is usable in this environment (best-effort). */
  get available(): boolean {
    if (this.failed) return false
    try {
      return typeof window !== 'undefined' && 'AudioContext' in window
    } catch {
      return false
    }
  }

  private ensure(): Ctx | null {
    if (this.ctx) return this.ctx
    try {
      const Ctor = window.AudioContext
      if (!Ctor) {
        this.failed = true
        return null
      }
      this.ctx = new Ctor()
      this.master = this.ctx.createGain()
      this.master.gain.value = this.volume
      this.master.connect(this.ctx.destination)
      return this.ctx
    } catch {
      this.failed = true
      return null
    }
  }

  setVolume(v: number): void {
    this.volume = Math.max(0, Math.min(1, v))
    try {
      if (this.master && this.ctx) {
        this.master.gain.setTargetAtTime(this.volume, this.ctx.currentTime, 0.02)
      }
    } catch {
      /* ignore */
    }
  }

  get level(): number {
    return this.volume
  }

  /** Resume a suspended context (call from a user gesture). */
  resume(): void {
    try {
      this.ensure()?.resume?.()
    } catch {
      /* ignore */
    }
  }

  private stopActive(): void {
    const a = this.active
    this.active = null
    if (!a) return
    try {
      const ctx = this.ctx
      if (ctx) {
        const t = ctx.currentTime
        a.gain.gain.cancelScheduledValues(t)
        a.gain.gain.setValueAtTime(a.gain.gain.value, t)
        a.gain.gain.linearRampToValueAtTime(0.0001, t + 0.04)
        a.src.stop(t + 0.05)
      } else {
        a.src.stop()
      }
      ;(a.handle as { stopped: boolean }).stopped = true
    } catch {
      /* ignore */
    }
  }

  /** Stop whatever is currently playing. */
  stop(): void {
    this.stopActive()
  }

  /**
   * Play a real-valued signal buffer. The buffer is peak-normalized then copied
   * into an AudioBuffer and (by default) looped through a short fade envelope.
   * Returns a handle whose stop() ramps the sound down cleanly.
   */
  playSignal(samples: ArrayLike<number>, options: PlayOptions = {}): PlayHandle {
    const noop: PlayHandle = { stop: () => {}, stopped: true }
    if (!this.available) return noop
    const ctx = this.ensure()
    if (!ctx || !this.master) return noop

    this.stopActive()

    try {
      const n = samples.length
      if (n < 2) return noop
      // Clamp the requested rate to what an AudioBuffer will accept.
      const sr = Math.max(3000, Math.min(96000, Math.round(options.sampleRate ?? 8000)))
      const buf = ctx.createBuffer(1, n, sr)
      const ch = buf.getChannelData(0)
      // peak-normalize
      let peak = 1e-9
      for (let i = 0; i < n; i++) {
        const a = Math.abs(samples[i])
        if (a > peak) peak = a
      }
      const g = (options.gain ?? 0.9) / peak
      for (let i = 0; i < n; i++) ch[i] = samples[i] * g

      const src = ctx.createBufferSource()
      src.buffer = buf
      src.loop = options.loop ?? true

      const gain = ctx.createGain()
      const fade = Math.max(0.001, (options.fadeMs ?? 12) / 1000)
      const t0 = ctx.currentTime
      gain.gain.setValueAtTime(0.0001, t0)
      gain.gain.exponentialRampToValueAtTime(1, t0 + fade)

      src.connect(gain)
      gain.connect(this.master)
      ctx.resume?.()
      src.start()

      const handle: PlayHandle = {
        stopped: false,
        stop: () => this.stopActive(),
      }
      this.active = { src, gain, handle }
      src.onended = () => {
        if (this.active && this.active.handle === handle) this.active = null
        ;(handle as { stopped: boolean }).stopped = true
      }
      return handle
    } catch {
      return noop
    }
  }

  /** A short sine "beep" — handy for UI feedback / metronome ticks. */
  beep(freq = 440, durMs = 120, gain = 0.25): void {
    if (!this.available) return
    const ctx = this.ensure()
    if (!ctx || !this.master) return
    try {
      const osc = ctx.createOscillator()
      const g = ctx.createGain()
      osc.frequency.value = freq
      osc.type = 'sine'
      const t0 = ctx.currentTime
      const dur = durMs / 1000
      g.gain.setValueAtTime(0.0001, t0)
      g.gain.exponentialRampToValueAtTime(gain, t0 + 0.01)
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur)
      osc.connect(g)
      g.connect(this.master)
      ctx.resume?.()
      osc.start(t0)
      osc.stop(t0 + dur + 0.02)
    } catch {
      /* ignore */
    }
  }
}

export const audio = new AudioEngine()
