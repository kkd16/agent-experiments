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

export class LfoWrapper {
  public node: OscillatorNode;
  public depthNode: GainNode;

  constructor(id: string) {
    const ctx = audioCore.getContext();
    this.node = ctx.createOscillator();
    this.node.type = 'sine';
    this.node.frequency.value = 5; // Low frequency for LFO

    // Depth control using a Gain node
    this.depthNode = ctx.createGain();
    this.depthNode.gain.value = 100; // Modulation depth amount

    this.node.connect(this.depthNode);
    this.node.start();

    // Register depth node as the main output of the LFO
    audioCore.registerNode(id, this.depthNode);

    // Register parameters for control
    audioCore.registerParam(`${id}.frequency`, this.node.frequency);
    audioCore.registerParam(`${id}.depth`, this.depthNode.gain);
  }

  public setType(type: OscillatorType) {
    this.node.type = type;
  }

  public setFrequency(freq: number) {
    this.node.frequency.setValueAtTime(freq, audioCore.getContext().currentTime);
  }

  public setDepth(depth: number) {
    this.depthNode.gain.setValueAtTime(depth, audioCore.getContext().currentTime);
  }

  public destroy(id: string) {
    this.node.stop();
    this.node.disconnect();
    this.depthNode.disconnect();
    audioCore.unregisterNode(id);
    audioCore.unregisterParam(`${id}.frequency`);
    audioCore.unregisterParam(`${id}.depth`);
  }
}
