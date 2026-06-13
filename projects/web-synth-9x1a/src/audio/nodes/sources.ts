import { audioCore } from '../core';

export class OscillatorWrapper {
  public node: OscillatorNode;

  constructor(id: string) {
    const ctx = audioCore.getContext();
    this.node = ctx.createOscillator();
    this.node.type = 'sawtooth';
    this.node.frequency.value = 440;
    this.node.start();

    audioCore.registerNode(id, this.node);
    audioCore.registerParam(`${id}.frequency`, this.node.frequency);
    audioCore.registerParam(`${id}.detune`, this.node.detune);
  }

  public setType(type: OscillatorType) {
    this.node.type = type;
  }

  public setFrequency(freq: number) {
    this.node.frequency.setValueAtTime(freq, audioCore.getContext().currentTime);
  }

  public destroy(id: string) {
    this.node.stop();
    audioCore.unregisterNode(id);
    audioCore.unregisterParam(`${id}.frequency`);
    audioCore.unregisterParam(`${id}.detune`);
  }
}

export class NoiseWrapper {
  private bufferSize: number;
  public node: AudioBufferSourceNode;
  private buffer: AudioBuffer;

  constructor(id: string) {
    const ctx = audioCore.getContext();
    this.bufferSize = ctx.sampleRate * 2; // 2 seconds of noise
    this.buffer = ctx.createBuffer(1, this.bufferSize, ctx.sampleRate);

    // Fill buffer with white noise
    const output = this.buffer.getChannelData(0);
    for (let i = 0; i < this.bufferSize; i++) {
      output[i] = Math.random() * 2 - 1;
    }

    this.node = ctx.createBufferSource();
    this.node.buffer = this.buffer;
    this.node.loop = true;
    this.node.start();

    audioCore.registerNode(id, this.node);
  }

  public destroy(id: string) {
    this.node.stop();
    audioCore.unregisterNode(id);
  }
}
