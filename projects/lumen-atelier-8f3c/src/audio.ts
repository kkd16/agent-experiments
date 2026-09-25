type GardenEvent = 'rotate' | 'hint' | 'complete' | 'reset'
type AudioWindow = Window & { webkitAudioContext?: typeof AudioContext }

/** A tiny procedural instrument. All audio starts with a player interaction. */
export class GardenAudio {
  private context: AudioContext | null = null
  private effects: GainNode | null = null
  private droneGain: GainNode | null = null
  private drones: OscillatorNode[] = []
  private voices = new Set<OscillatorNode>()
  private sound = true
  private ambience = false
  private noteIndex = 0
  private disposed = false

  setSound(enabled: boolean): void {
    this.sound = enabled
    if (this.context && this.effects) {
      this.effects.gain.setTargetAtTime(enabled ? 0.24 : 0, this.context.currentTime, 0.025)
    }
  }

  setAmbience(enabled: boolean): void {
    this.ambience = enabled
    // Loading a saved preference may call this before any click. Defer that case.
    if (enabled && typeof navigator !== 'undefined' && navigator.userActivation?.isActive) {
      this.ensureContext()
    }
    this.updateAmbience()
  }

  play(event: GardenEvent): void {
    if (!this.sound && !this.ambience) return
    const context = this.ensureContext()
    if (!context) return
    this.updateAmbience()
    if (!this.sound) return
    const now = context.currentTime + 0.012
    if (event === 'rotate') {
      const notes = [293.66, 329.63, 369.99, 440, 493.88]
      this.pluck(notes[this.noteIndex++ % notes.length], now, 0.65, 0.23)
    } else if (event === 'hint') {
      this.pluck(440, now, 0.95, 0.22)
      this.pluck(659.25, now + 0.16, 1.1, 0.16)
    } else if (event === 'complete') {
      for (const [index, frequency] of [293.66, 369.99, 440, 587.33, 739.99].entries()) {
        this.pluck(frequency, now + index * 0.14, 1.8, 0.21)
      }
    } else {
      this.pluck(220, now, 0.7, 0.16)
      this.pluck(293.66, now + 0.08, 0.8, 0.12)
    }
  }

  private ensureContext(): AudioContext | null {
    if (this.disposed || typeof window === 'undefined') return null
    try {
      if (!this.context) {
        // Browser activation prevents preference restoration from causing autoplay.
        if (typeof navigator !== 'undefined' && navigator.userActivation && !navigator.userActivation.isActive) return null
        const Constructor = window.AudioContext ?? (window as AudioWindow).webkitAudioContext
        if (!Constructor) return null
        this.context = new Constructor()
        this.effects = this.context.createGain()
        this.effects.gain.value = this.sound ? 0.24 : 0
        this.effects.connect(this.context.destination)
      }
      if (this.context.state === 'suspended') void this.context.resume().catch(() => {})
      return this.context
    } catch {
      return null
    }
  }

  private pluck(frequency: number, start: number, duration: number, volume: number): void {
    const context = this.context
    if (!context || !this.effects) return
    try {
      // A quiet second partial adds the wooden, bell-like attack.
      for (const [partial, strength] of [[1, 1], [2, 0.16]]) {
        const oscillator = context.createOscillator()
        const envelope = context.createGain()
        oscillator.type = 'sine'
        oscillator.frequency.value = frequency * partial
        envelope.gain.setValueAtTime(0, start)
        envelope.gain.linearRampToValueAtTime(volume * strength, start + 0.012)
        envelope.gain.exponentialRampToValueAtTime(0.0001, start + duration)
        oscillator.connect(envelope)
        envelope.connect(this.effects)
        this.voices.add(oscillator)
        oscillator.onended = () => {
          oscillator.disconnect()
          envelope.disconnect()
          this.voices.delete(oscillator)
        }
        oscillator.start(start)
        oscillator.stop(start + duration + 0.02)
      }
    } catch {
      // Unsupported or closing audio hardware should never interrupt a move.
    }
  }

  private updateAmbience(): void {
    const context = this.context
    if (!context || context.state === 'closed') return
    try {
      if (this.ambience && !this.droneGain) {
        this.droneGain = context.createGain()
        this.droneGain.gain.value = 0
        this.droneGain.connect(context.destination)
        for (const frequency of [110, 164.81, 220.25]) {
          const oscillator = context.createOscillator()
          oscillator.type = 'sine'
          oscillator.frequency.value = frequency
          oscillator.connect(this.droneGain)
          oscillator.start()
          this.drones.push(oscillator)
        }
      }
      this.droneGain?.gain.setTargetAtTime(this.ambience ? 0.009 : 0, context.currentTime, 0.6)
    } catch {
      // Audio is an enhancement, never a game requirement.
    }
  }

  dispose(): void {
    this.disposed = true
    for (const oscillator of [...this.voices, ...this.drones]) {
      try { oscillator.stop() } catch { /* Already stopped. */ }
      oscillator.disconnect()
    }
    this.voices.clear()
    this.drones = []
    this.effects?.disconnect()
    this.droneGain?.disconnect()
    if (this.context && this.context.state !== 'closed') void this.context.close().catch(() => {})
    this.context = null
    this.effects = null
    this.droneGain = null
  }
}
