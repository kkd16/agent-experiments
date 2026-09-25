import type { EventKind, GameState } from './types'

/** A small, gesture-unlocked instrument: no downloads, timers, or unbounded voices. */
export class SunwakeAudio {
  private context: AudioContext | null = null
  private master: GainNode | null = null
  private windGain: GainNode | null = null
  private windFilter: BiquadFilterNode | null = null
  private continuous: AudioScheduledSourceNode[] = []
  private voices = new Set<OscillatorNode>()
  private enabled = false
  private running = false
  private disposed = false
  private lastEventId = -1
  private lastGameTime = -1
  private lastUpdate = -1
  private lastSparks = 0

  async unlock(): Promise<void> {
    // React StrictMode deliberately disposes and reuses the instance in development.
    // A new user gesture may safely revive it after that cleanup.
    this.disposed = false
    try {
      if (!this.context) this.create()
      if (this.enabled && this.context?.state === 'suspended')
        await this.context.resume()
    } catch {
      // Sound is optional; browser audio policies must never interrupt a run.
    }
  }

  setEnabled(enabled: boolean): void {
    this.enabled = enabled
    const context = this.context
    if (!context || this.disposed) return
    const now = context.currentTime
    this.master?.gain.cancelScheduledValues(now)
    this.master?.gain.setValueAtTime(enabled && this.running ? 0.5 : 0, now)
    if (!enabled) {
      for (const voice of this.voices) {
        try {
          voice.stop()
        } catch {
          /* A voice may already have reached its stop time. */
        }
      }
      this.voices.clear()
      if (context.state === 'running') void context.suspend().catch(() => {})
    } else if (context.state === 'suspended') {
      void context.resume().catch(() => {})
    }
  }

  update(state: GameState): void {
    if (this.disposed) return
    if (state.time < this.lastGameTime) this.lastEventId = -1
    this.lastGameTime = state.time
    const collectedSpark = state.sparks > this.lastSparks
    this.lastSparks = state.sparks
    const freshEvents = state.events.filter(
      (event) => event.id > this.lastEventId,
    )
    for (const event of freshEvents)
      this.lastEventId = Math.max(this.lastEventId, event.id)
    const running = state.phase === 'running'
    const context = this.context
    if (context && this.master && running !== this.running) {
      const now = context.currentTime
      this.master.gain.cancelScheduledValues(now)
      this.master.gain.setTargetAtTime(
        this.enabled && running ? 0.5 : 0,
        now,
        0.06,
      )
    }
    this.running = running
    if (!this.enabled || !context || context.state !== 'running') return
    if (running && context.currentTime - this.lastUpdate >= 0.12) {
      this.lastUpdate = context.currentTime
      const speed = Math.min(
        1,
        Math.max(0, Math.hypot(state.player.vx, state.player.vy) / 600),
      )
      const now = context.currentTime
      this.windGain?.gain.cancelScheduledValues(now)
      this.windGain?.gain.setTargetAtTime(0.035 + speed * 0.11, now, 0.14)
      this.windFilter?.frequency.cancelScheduledValues(now)
      this.windFilter?.frequency.setTargetAtTime(250 + speed * 1050, now, 0.2)
    }
    if (running) {
      if (collectedSpark) this.event('spark', state.combo)
      for (const event of freshEvents.slice(-6))
        this.event(event.kind, state.combo)
    }
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.enabled = false
    for (const source of [...this.continuous, ...this.voices]) {
      try {
        source.stop()
      } catch {
        /* Sources have a single lifetime. */
      }
      source.disconnect()
    }
    this.continuous = []
    this.voices.clear()
    this.master?.disconnect()
    this.windGain?.disconnect()
    this.windFilter?.disconnect()
    if (this.context && this.context.state !== 'closed')
      void this.context.close().catch(() => {})
    this.context = null
    this.master = null
    this.windGain = null
    this.windFilter = null
  }

  private create(): void {
    const context = new AudioContext()
    this.lastUpdate = -1
    this.context = context
    this.master = context.createGain()
    this.master.gain.value = this.enabled && this.running ? 0.5 : 0
    this.master.connect(context.destination)
    const noise = context.createBuffer(
      1,
      context.sampleRate * 3,
      context.sampleRate,
    )
    const data = noise.getChannelData(0)
    let previous = 0
    for (let i = 0; i < data.length; i++) {
      previous = (previous + (Math.random() * 2 - 1) * 0.025) / 1.025
      data[i] = previous * 5
    }
    const wind = context.createBufferSource()
    wind.buffer = noise
    wind.loop = true
    this.windFilter = context.createBiquadFilter()
    this.windFilter.type = 'lowpass'
    this.windFilter.frequency.value = 500
    this.windFilter.Q.value = 0.5
    this.windGain = context.createGain()
    this.windGain.gain.value = 0.05
    wind.connect(this.windFilter).connect(this.windGain).connect(this.master)
    wind.start()
    this.continuous.push(wind)
    for (const [frequency, volume] of [
      [110, 0.024],
      [164.81, 0.012],
      [220.16, 0.007],
    ]) {
      const note = context.createOscillator()
      const gain = context.createGain()
      note.type = 'sine'
      note.frequency.value = frequency
      gain.gain.value = volume
      note.connect(gain).connect(this.master)
      note.start()
      this.continuous.push(note)
    }
    if (!this.enabled && context.state === 'running')
      void context.suspend().catch(() => {})
  }

  private event(kind: EventKind, combo: number): void {
    const scale = [440, 493.88, 554.37, 659.25, 739.99, 880]
    switch (kind) {
      case 'spark':
        this.tone(
          scale[Math.min(scale.length - 1, Math.max(0, Math.floor(combo) - 1))],
          0.35,
          0.09,
        )
        break
      case 'ring':
        this.tone(554.37, 0.65, 0.1)
        this.tone(739.99, 0.8, 0.065, 0.09)
        this.tone(1108.73, 0.8, 0.04, 0.17)
        break
      case 'landing':
        this.tone(220, 0.45, 0.1)
        this.tone(440, 0.4, 0.03, 0.025)
        break
      case 'boost':
        this.tone(329.63, 0.9, 0.11)
        this.tone(659.25, 0.9, 0.08, 0.13)
        break
      case 'hit':
        this.tone(82.41, 0.3, 0.12)
        this.tone(87.31, 0.25, 0.045)
        break
      case 'near':
        this.tone(987.77, 0.25, 0.045)
        break
      case 'biome':
        ;[440, 554.37, 659.25].forEach((frequency, index) =>
          this.tone(frequency, 1.8, 0.065, index * 0.2),
        )
        break
      case 'end':
        break
    }
  }

  private tone(
    frequency: number,
    duration: number,
    volume: number,
    delay = 0,
  ): void {
    const context = this.context
    if (!context || !this.master || !this.enabled || this.voices.size >= 24)
      return
    const oscillator = context.createOscillator()
    const envelope = context.createGain()
    const start = context.currentTime + delay
    oscillator.type = 'sine'
    oscillator.frequency.setValueAtTime(frequency, start)
    envelope.gain.setValueAtTime(0, context.currentTime)
    envelope.gain.setValueAtTime(0, start)
    envelope.gain.linearRampToValueAtTime(volume, start + 0.014)
    envelope.gain.exponentialRampToValueAtTime(0.0001, start + duration)
    oscillator.connect(envelope).connect(this.master)
    this.voices.add(oscillator)
    oscillator.onended = () => {
      this.voices.delete(oscillator)
      oscillator.disconnect()
      envelope.disconnect()
    }
    oscillator.start(start)
    oscillator.stop(start + duration + 0.03)
  }
}
