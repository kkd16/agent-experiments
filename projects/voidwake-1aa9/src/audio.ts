let context: AudioContext | null = null
export function playSound(kind: 'click' | 'jump' | 'attack' | 'end' | 'reward', enabled: boolean) {
  if (!enabled) return
  try {
    context ??= new AudioContext()
    if (context.state === 'suspended') void context.resume()
    const now = context.currentTime
    const notes = kind === 'jump' ? [110, 165, 220, 330] : kind === 'reward' ? [330, 440, 550] : kind === 'attack' ? [95, 50] : kind === 'end' ? [180, 120] : [550]
    notes.forEach((frequency, i) => {
      const oscillator = context!.createOscillator(), gain = context!.createGain()
      oscillator.type = kind === 'attack' ? 'triangle' : 'sine'; oscillator.frequency.setValueAtTime(frequency, now + i * .07)
      gain.gain.setValueAtTime(0, now + i * .07); gain.gain.linearRampToValueAtTime(.045, now + i * .07 + .015); gain.gain.exponentialRampToValueAtTime(.001, now + i * .07 + .2)
      oscillator.connect(gain); gain.connect(context!.destination); oscillator.start(now + i * .07); oscillator.stop(now + i * .07 + .21)
    })
  } catch { /* Audio is optional when unavailable in the browser. */ }
}
