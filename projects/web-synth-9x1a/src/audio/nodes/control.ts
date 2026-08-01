import { audioCore } from '../core';

export class EnvelopeWrapper {
  private targetParamId: string | null = null;
  public attack: number = 0.1;
  public decay: number = 0.2;
  public sustain: number = 0.5;
  public release: number = 0.5;
  public id: string;

  constructor(id: string) {
    this.id = id;
  }

  public connectTarget(targetId: string) {
    this.targetParamId = targetId;
  }

  public disconnectTarget() {
    this.targetParamId = null;
  }

  public triggerAttack() {
    if (!this.targetParamId) return;
    const param = audioCore.getParam(this.targetParamId);
    if (!param) return;

    const ctx = audioCore.getContext();
    const now = ctx.currentTime;

    param.cancelScheduledValues(now);
    param.setValueAtTime(0, now);
    param.linearRampToValueAtTime(1, now + this.attack);
    param.linearRampToValueAtTime(this.sustain, now + this.attack + this.decay);
  }

  public triggerRelease() {
    if (!this.targetParamId) return;
    const param = audioCore.getParam(this.targetParamId);
    if (!param) return;

    const ctx = audioCore.getContext();
    const now = ctx.currentTime;

    param.cancelScheduledValues(now);
    param.setValueAtTime(param.value, now);
    param.linearRampToValueAtTime(0, now + this.release);
  }

  public destroy() {
    this.disconnectTarget();
  }
}

export class SequencerWrapper {
  public steps: number[] = new Array(16).fill(0); // 0 or frequency
  public currentStep: number = 0;
  public tempo: number = 120; // BPM
  public isPlaying: boolean = false;
  private intervalId: number | null = null;
  private targetParamId: string | null = null;
  public id: string;

  constructor(id: string) {
    this.id = id;
  }

  public connectTarget(targetId: string) {
    this.targetParamId = targetId;
  }

  public setStep(index: number, freq: number) {
    this.steps[index] = freq;
  }

  public play() {
    if (this.isPlaying) return;
    this.isPlaying = true;
    this.currentStep = 0;
    this.scheduleNextStep();
  }

  public stop() {
    this.isPlaying = false;
    if (this.intervalId !== null) {
      clearTimeout(this.intervalId);
      this.intervalId = null;
    }
  }

  private scheduleNextStep() {
    if (!this.isPlaying) return;

    const stepDuration = 60 / this.tempo / 4; // 16th notes

    // Process current step
    const freq = this.steps[this.currentStep];
    if (freq > 0) {
      if (this.targetParamId) {
        const param = audioCore.getParam(this.targetParamId);
        if (param) {
            param.setValueAtTime(freq, audioCore.getContext().currentTime);
        }
      }
    }

    this.currentStep = (this.currentStep + 1) % 16;

    this.intervalId = window.setTimeout(() => this.scheduleNextStep(), stepDuration * 1000);
  }

  public destroy() {
    this.stop();
  }
}

export class AdsrWrapper {
  public constantSource: ConstantSourceNode;
  public gainNode: GainNode;
  public id: string;
  public attack: number = 0.1;
  public decay: number = 0.1;
  public sustain: number = 0.5;
  public release: number = 0.3;

  constructor(id: string) {
    this.id = id;
    const ctx = audioCore.getContext();
    this.constantSource = ctx.createConstantSource();
    this.constantSource.offset.value = 1.0;

    this.gainNode = ctx.createGain();
    this.gainNode.gain.value = 0; // Starts at 0

    this.constantSource.connect(this.gainNode);
    this.constantSource.start();

    // Register gain node as output
    audioCore.registerNode(id, this.gainNode);
  }

  public setAttack(val: number) { this.attack = val; }
  public setDecay(val: number) { this.decay = val; }
  public setSustain(val: number) { this.sustain = val; }
  public setRelease(val: number) { this.release = val; }

  public triggerAttack() {
    const ctx = audioCore.getContext();
    const now = ctx.currentTime;
    const gain = this.gainNode.gain;

    gain.cancelScheduledValues(now);
    gain.setValueAtTime(0, now);
    gain.linearRampToValueAtTime(1, now + this.attack);
    gain.linearRampToValueAtTime(this.sustain, now + this.attack + this.decay);
  }

  public triggerRelease() {
    const ctx = audioCore.getContext();
    const now = ctx.currentTime;
    const gain = this.gainNode.gain;

    gain.cancelScheduledValues(now);
    gain.setValueAtTime(gain.value, now);
    gain.linearRampToValueAtTime(0, now + this.release);
  }

  public destroy(id: string) {
    this.constantSource.stop();
    this.constantSource.disconnect();
    this.gainNode.disconnect();
    audioCore.unregisterNode(id);
  }
}
