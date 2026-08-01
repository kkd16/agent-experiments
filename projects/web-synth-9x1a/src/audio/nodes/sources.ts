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

  public setDetune(cents: number) {
    this.node.detune.setValueAtTime(cents, audioCore.getContext().currentTime);
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
  public node: AudioBufferSourceNode | null = null;
  private output: GainNode;
  private type: 'white' | 'pink' | 'brown' = 'white';
  private ctx: AudioContext;

  constructor(id: string) {
    this.ctx = audioCore.getContext();
    this.bufferSize = this.ctx.sampleRate * 2; // 2 seconds of noise

    this.output = this.ctx.createGain();
    this.output.gain.value = 1.0;

    audioCore.registerNode(id, this.output);

    this.generateAndPlayNoise();
  }

  private generateAndPlayNoise() {
    if (this.node) {
      this.node.stop();
      this.node.disconnect();
    }

    const buffer = this.ctx.createBuffer(1, this.bufferSize, this.ctx.sampleRate);
    const outputData = buffer.getChannelData(0);

    if (this.type === 'white') {
      for (let i = 0; i < this.bufferSize; i++) {
        outputData[i] = Math.random() * 2 - 1;
      }
    } else if (this.type === 'pink') {
      let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0;
      for (let i = 0; i < this.bufferSize; i++) {
        const white = Math.random() * 2 - 1;
        b0 = 0.99886 * b0 + white * 0.0555179;
        b1 = 0.99332 * b1 + white * 0.0750759;
        b2 = 0.96900 * b2 + white * 0.1538520;
        b3 = 0.86650 * b3 + white * 0.3104856;
        b4 = 0.55000 * b4 + white * 0.5329522;
        b5 = -0.7616 * b5 - white * 0.0168980;
        outputData[i] = b0 + b1 + b2 + b3 + b4 + b5 + b6 + white * 0.5362;
        outputData[i] *= 0.11; // compensation
        b6 = white * 0.115926;
      }
    } else if (this.type === 'brown') {
      let lastOut = 0;
      for (let i = 0; i < this.bufferSize; i++) {
        const white = Math.random() * 2 - 1;
        outputData[i] = (lastOut + (0.02 * white)) / 1.02;
        lastOut = outputData[i];
        outputData[i] *= 3.5; // compensate gain
      }
    }

    this.node = this.ctx.createBufferSource();
    this.node.buffer = buffer;
    this.node.loop = true;
    this.node.connect(this.output);
    this.node.start();
  }

  public setType(type: 'white' | 'pink' | 'brown') {
    if (this.type !== type) {
      this.type = type;
      this.generateAndPlayNoise();
    }
  }

  public destroy(id: string) {
    if (this.node) {
      this.node.stop();
      this.node.disconnect();
    }
    this.output.disconnect();
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
