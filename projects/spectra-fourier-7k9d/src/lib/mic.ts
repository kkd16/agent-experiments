// A tiny, defensive real-time microphone tap.
//
// Web Audio's AnalyserNode is used here *only* as a rolling time-domain buffer —
// we pull raw samples out with `getFloatTimeDomainData` and run them through our
// own from-scratch FFT, so the "no math libraries" promise holds even for the
// live analyser. Everything is wrapped so a denied permission or a sandboxed
// catalog thumbnail (where there is no microphone) simply reports unavailable
// instead of throwing; the Live mode then falls back to a synthetic source.

class MicEngine {
  private ctx: AudioContext | null = null
  private stream: MediaStream | null = null
  private source: MediaStreamAudioSourceNode | null = null
  private analyser: AnalyserNode | null = null
  private buf: Float32Array<ArrayBuffer> | null = null
  private failed = false
  running = false

  /** Whether the browser exposes the APIs we need (best-effort, never throws). */
  get available(): boolean {
    if (this.failed) return false
    try {
      return (
        typeof navigator !== 'undefined' &&
        !!navigator.mediaDevices &&
        typeof navigator.mediaDevices.getUserMedia === 'function' &&
        typeof window !== 'undefined' &&
        'AudioContext' in window
      )
    } catch {
      return false
    }
  }

  /**
   * Request the microphone and wire up the tap. Must be called from a user
   * gesture. Resolves true on success, false if unavailable or denied.
   */
  async start(fftSize = 2048): Promise<boolean> {
    if (!this.available) return false
    if (this.running) return true
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
      })
      const Ctor = window.AudioContext
      const ctx = new Ctor()
      const source = ctx.createMediaStreamSource(stream)
      const analyser = ctx.createAnalyser()
      analyser.fftSize = fftSize
      analyser.smoothingTimeConstant = 0
      source.connect(analyser)
      // Deliberately NOT connected to ctx.destination — no monitoring, no feedback.
      await ctx.resume?.()
      this.ctx = ctx
      this.stream = stream
      this.source = source
      this.analyser = analyser
      this.buf = new Float32Array(analyser.fftSize)
      this.running = true
      return true
    } catch {
      this.failed = true
      this.stop()
      return false
    }
  }

  /** Copy the latest time-domain samples into `out`. Returns false if not running. */
  read(out: Float32Array): boolean {
    const a = this.analyser
    const b = this.buf
    if (!a || !b) return false
    try {
      a.getFloatTimeDomainData(b)
      const n = Math.min(out.length, b.length)
      out.set(b.subarray(0, n))
      return true
    } catch {
      return false
    }
  }

  get sampleRate(): number {
    return this.ctx?.sampleRate ?? 44100
  }

  stop(): void {
    this.running = false
    try {
      this.source?.disconnect()
    } catch {
      /* ignore */
    }
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
    this.ctx = null
    this.stream = null
    this.source = null
    this.analyser = null
    this.buf = null
  }
}

export const mic = new MicEngine()
