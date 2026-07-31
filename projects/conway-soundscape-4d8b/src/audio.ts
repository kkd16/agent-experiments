// Pentatonic scale ratios (C, D, E, G, A)
const PENTATONIC_RATIOS = [1, 9/8, 5/4, 3/2, 5/3];
const MAJOR_RATIOS = [1, 9/8, 5/4, 4/3, 3/2, 5/3, 15/8];
const MINOR_RATIOS = [1, 9/8, 6/5, 4/3, 3/2, 8/5, 9/5];
const CHROMATIC_RATIOS = [1, 1.05946, 1.12246, 1.18921, 1.25992, 1.33484, 1.41421, 1.49831, 1.58740, 1.68179, 1.78180, 1.88775];

export class AudioEngine {
  private ctx: AudioContext | null = null;
  private masterGain: GainNode | null = null;
  private totalRows: number;
  private totalCols: number;

  public baseFreq: number = 130.81; // C3
  public waveShape: OscillatorType = 'sine';
  public scaleType: 'pentatonic' | 'major' | 'minor' | 'chromatic' = 'pentatonic';

  constructor(totalRows: number, totalCols: number = 30) {
    this.totalRows = totalRows;
    this.totalCols = totalCols;
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

  setVolume(volume: number) {
    if (this.masterGain) {
      // Linear volume mapping 0-100 to 0-0.5
      this.masterGain.gain.value = (volume / 100) * 0.5;
    }
  }

  private getFrequencyForRow(row: number): number {
    let ratios = PENTATONIC_RATIOS;
    if (this.scaleType === 'major') ratios = MAJOR_RATIOS;
    else if (this.scaleType === 'minor') ratios = MINOR_RATIOS;
    else if (this.scaleType === 'chromatic') ratios = CHROMATIC_RATIOS;

    const scaleIndex = (this.totalRows - 1 - row) % ratios.length;
    const octave = Math.floor((this.totalRows - 1 - row) / ratios.length);

    return this.baseFreq * ratios[scaleIndex] * Math.pow(2, octave);
  }

  playNote(row: number, col: number) {
    if (!this.ctx || !this.masterGain) return;

    const freq = this.getFrequencyForRow(row);

    const osc = this.ctx.createOscillator();
    const gainNode = this.ctx.createGain();

    osc.type = this.waveShape;
    osc.frequency.setValueAtTime(freq, this.ctx.currentTime);

    // Stereo Panning
    const panner = this.ctx.createStereoPanner();
    // Map column index to panning value: left (-1) to right (1)
    const panValue = ((col / (this.totalCols - 1)) * 2) - 1;
    panner.pan.value = panValue;

    // Envelope
    gainNode.gain.setValueAtTime(0, this.ctx.currentTime);
    gainNode.gain.linearRampToValueAtTime(1, this.ctx.currentTime + 0.05); // Attack
    gainNode.gain.exponentialRampToValueAtTime(0.001, this.ctx.currentTime + 0.5); // Decay

    osc.connect(gainNode);
    gainNode.connect(panner);
    panner.connect(this.masterGain);

    osc.start(this.ctx.currentTime);
    osc.stop(this.ctx.currentTime + 0.6);
  }
}
