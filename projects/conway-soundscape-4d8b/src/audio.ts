// Base frequency for the scale (e.g., C3)
const BASE_FREQ = 130.81;

// Pentatonic scale ratios (C, D, E, G, A)
const PENTATONIC_RATIOS = [1, 9/8, 5/4, 3/2, 5/3];

export class AudioEngine {
  private ctx: AudioContext | null = null;
  private masterGain: GainNode | null = null;
  private totalRows: number;

  constructor(totalRows: number) {
    this.totalRows = totalRows;
  }

  init() {
    if (!this.ctx) {
      this.ctx = new (window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext)();
      this.masterGain = this.ctx.createGain();
      this.masterGain.gain.value = 0.15; // Keep overall volume low
      this.masterGain.connect(this.ctx.destination);
    }

    if (this.ctx.state === 'suspended') {
      this.ctx.resume();
    }
  }

  private getFrequencyForRow(row: number): number {
    // Map the row to a note in the pentatonic scale
    // Lower rows (bottom of grid) = lower pitch
    // Higher rows (top of grid) = higher pitch
    const scaleIndex = (this.totalRows - 1 - row) % PENTATONIC_RATIOS.length;
    const octave = Math.floor((this.totalRows - 1 - row) / PENTATONIC_RATIOS.length);

    return BASE_FREQ * PENTATONIC_RATIOS[scaleIndex] * Math.pow(2, octave);
  }

  playNote(row: number, col: number) {
    if (!this.ctx || !this.masterGain) return;

    const freq = this.getFrequencyForRow(row);

    const osc = this.ctx.createOscillator();
    const gainNode = this.ctx.createGain();

    // Alternate waveform based on column for slight timbre variation
    osc.type = col % 2 === 0 ? 'sine' : 'triangle';
    osc.frequency.setValueAtTime(freq, this.ctx.currentTime);

    // Envelope
    gainNode.gain.setValueAtTime(0, this.ctx.currentTime);
    gainNode.gain.linearRampToValueAtTime(1, this.ctx.currentTime + 0.05); // Attack
    gainNode.gain.exponentialRampToValueAtTime(0.001, this.ctx.currentTime + 0.5); // Decay

    osc.connect(gainNode);
    gainNode.connect(this.masterGain);

    osc.start(this.ctx.currentTime);
    osc.stop(this.ctx.currentTime + 0.6);
  }
}
