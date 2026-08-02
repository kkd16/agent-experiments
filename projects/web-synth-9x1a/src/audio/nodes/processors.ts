import { audioCore } from '../core';

export class GainWrapper {
  public node: GainNode;
  private currentGain: number = 0.5;
  private isMuted: boolean = false;
  private invertPhase: boolean = false;

  constructor(id: string) {
    const ctx = audioCore.getContext();
    this.node = ctx.createGain();
    this.node.gain.value = 0.5;

    audioCore.registerNode(id, this.node);
    audioCore.registerParam(`${id}.gain`, this.node.gain);
  }

  public setInvertPhase(invert: boolean) {
    this.invertPhase = invert;
    this.applyGain();
  }

  public setGain(value: number) {
    this.currentGain = value;
    this.applyGain();
  }

  public setMute(mute: boolean) {
    this.isMuted = mute;
    this.applyGain();
  }

  private applyGain() {
    const val = this.isMuted ? 0 : (this.invertPhase ? -this.currentGain : this.currentGain);
    this.node.gain.setValueAtTime(val, audioCore.getContext().currentTime);
  }

  public destroy(id: string) {
    audioCore.unregisterNode(id);
    audioCore.unregisterParam(`${id}.gain`);
  }
}

export class FilterWrapper {
  public inputNode: GainNode;
  public node: BiquadFilterNode;
  public dryGain: GainNode;
  public wetGain: GainNode;
  public outputNode: GainNode;

  constructor(id: string) {
    const ctx = audioCore.getContext();

    this.inputNode = ctx.createGain();
    this.node = ctx.createBiquadFilter();
    this.node.type = 'lowpass';
    this.node.frequency.value = 1000;
    this.node.Q.value = 1;
    this.dryGain = ctx.createGain();
    this.dryGain.gain.value = 0;
    this.wetGain = ctx.createGain();
    this.wetGain.gain.value = 1;
    this.outputNode = ctx.createGain();

    this.inputNode.connect(this.node);
    this.inputNode.connect(this.dryGain);
    this.node.connect(this.wetGain);
    this.dryGain.connect(this.outputNode);
    this.wetGain.connect(this.outputNode);

    (this.inputNode as any).connect = (dest: any, output?: number, input?: number) => {
      if (output !== undefined && input !== undefined) return this.outputNode.connect(dest, output, input);
      if (output !== undefined) return this.outputNode.connect(dest, output);
      return this.outputNode.connect(dest);
    };
    (this.inputNode as any).disconnect = (dest?: any, output?: number, input?: number) => {
      if (dest && output !== undefined && input !== undefined) return this.outputNode.disconnect(dest, output, input);
      if (dest && output !== undefined) return this.outputNode.disconnect(dest, output);
      if (dest) return this.outputNode.disconnect(dest);
      return this.outputNode.disconnect();
    };

    audioCore.registerNode(id, this.inputNode);
    audioCore.registerParam(`${id}.frequency`, this.node.frequency);
    audioCore.registerParam(`${id}.Q`, this.node.Q);
  }

  public setType(type: BiquadFilterType) {
    this.node.type = type;
  }

  public setFrequency(freq: number) {
    this.node.frequency.setValueAtTime(freq, audioCore.getContext().currentTime);
  }

  public setQ(q: number) {
    this.node.Q.setValueAtTime(q, audioCore.getContext().currentTime);
  }

  public setBypass(bypass: boolean) {
    this.dryGain.gain.value = bypass ? 1 : 0;
    this.wetGain.gain.value = bypass ? 0 : 1;
  }

  public destroy(id: string) {
    this.inputNode.disconnect();
    this.node.disconnect();
    this.dryGain.disconnect();
    this.wetGain.disconnect();
    this.outputNode.disconnect();
    audioCore.unregisterNode(id);
    audioCore.unregisterParam(`${id}.frequency`);
    audioCore.unregisterParam(`${id}.Q`);
  }
}

export class DelayWrapper {
  public inputNode: GainNode;
  public node: DelayNode;
  public feedbackNode: GainNode;
  public dryGain: GainNode;
  public wetGain: GainNode;
  public outputNode: GainNode;
  private isBypassed: boolean = false;

  constructor(id: string) {
    const ctx = audioCore.getContext();

    this.inputNode = ctx.createGain();
    this.node = ctx.createDelay(5.0); // max delay 5 seconds
    this.node.delayTime.value = 0.5;

    this.feedbackNode = ctx.createGain();
    this.feedbackNode.gain.value = 0.5;

    this.dryGain = ctx.createGain();
    this.wetGain = ctx.createGain();
    this.outputNode = ctx.createGain();

    this.dryGain.gain.value = 0.5;
    this.wetGain.gain.value = 0.5;

    this.inputNode.connect(this.dryGain);
    this.inputNode.connect(this.node);

    // Connect node -> feedback -> node for the echo effect
    this.node.connect(this.feedbackNode);
    this.feedbackNode.connect(this.node);

    this.node.connect(this.wetGain);

    this.dryGain.connect(this.outputNode);
    this.wetGain.connect(this.outputNode);

    (this.inputNode as any).connect = (dest: any, output?: number, input?: number) => {
      if (output !== undefined && input !== undefined) return this.outputNode.connect(dest, output, input);
      if (output !== undefined) return this.outputNode.connect(dest, output);
      return this.outputNode.connect(dest);
    };
    (this.inputNode as any).disconnect = (dest?: any, output?: number, input?: number) => {
      if (dest && output !== undefined && input !== undefined) return this.outputNode.disconnect(dest, output, input);
      if (dest && output !== undefined) return this.outputNode.disconnect(dest, output);
      if (dest) return this.outputNode.disconnect(dest);
      return this.outputNode.disconnect();
    };

    audioCore.registerNode(id, this.inputNode);
    audioCore.registerParam(`${id}.delayTime`, this.node.delayTime);
    audioCore.registerParam(`${id}.feedback`, this.feedbackNode.gain);
  }

  public setDelayTime(time: number) {
    this.node.delayTime.setValueAtTime(time, audioCore.getContext().currentTime);
  }

  public setFeedback(gain: number) {
    this.feedbackNode.gain.setValueAtTime(gain, audioCore.getContext().currentTime);
  }

  public setMix(mix: number) {
    if (this.isBypassed) return;
    this.dryGain.gain.setValueAtTime(Math.cos(mix * 0.5 * Math.PI), audioCore.getContext().currentTime);
    this.wetGain.gain.setValueAtTime(Math.cos((1.0 - mix) * 0.5 * Math.PI), audioCore.getContext().currentTime);
  }

  public setBypass(bypass: boolean) {
    this.isBypassed = bypass;
    if (bypass) {
      this.dryGain.gain.setValueAtTime(1, audioCore.getContext().currentTime);
      this.wetGain.gain.setValueAtTime(0, audioCore.getContext().currentTime);
    } else {
      // mix was not saved, so just default to 0.5 or we'd need to store it.
      // It will jump to 0.5 on un-bypass unless setMix is called again.
      this.dryGain.gain.setValueAtTime(Math.cos(0.5 * 0.5 * Math.PI), audioCore.getContext().currentTime);
      this.wetGain.gain.setValueAtTime(Math.cos(0.5 * 0.5 * Math.PI), audioCore.getContext().currentTime);
    }
  }

  public destroy(id: string) {
    this.inputNode.disconnect();
    this.node.disconnect();
    this.feedbackNode.disconnect();
    this.dryGain.disconnect();
    this.wetGain.disconnect();
    this.outputNode.disconnect();
    audioCore.unregisterNode(id);
    audioCore.unregisterParam(`${id}.delayTime`);
    audioCore.unregisterParam(`${id}.feedback`);
  }
}

export class ReverbWrapper {
  public inputNode: GainNode;
  public convolver: ConvolverNode;
  public dryNode: GainNode;
  public wetNode: GainNode;
  public outputNode: GainNode;
  public isBypassed: boolean = false;

  constructor(id: string) {
    const ctx = audioCore.getContext();
    this.inputNode = ctx.createGain();
    this.convolver = ctx.createConvolver();
    this.dryNode = ctx.createGain();
    this.wetNode = ctx.createGain();
    this.outputNode = ctx.createGain();

    // Default mix to 50%
    this.dryNode.gain.value = 0.5;
    this.wetNode.gain.value = 0.5;

    // Routing
    this.inputNode.connect(this.dryNode);
    this.inputNode.connect(this.convolver);
    this.convolver.connect(this.wetNode);
    this.dryNode.connect(this.outputNode);
    this.wetNode.connect(this.outputNode);

    this.generateImpulseResponse(2.0, 2.0);

    // Provide generic connect/disconnect by hooking the input node
    (this.inputNode as any).connect = (dest: any, output?: number, input?: number) => {
        if (output !== undefined && input !== undefined) return this.outputNode.connect(dest, output, input);
        if (output !== undefined) return this.outputNode.connect(dest, output);
        return this.outputNode.connect(dest);
    };
    (this.inputNode as any).disconnect = (dest?: any, output?: number, input?: number) => {
        if (dest && output !== undefined && input !== undefined) return this.outputNode.disconnect(dest, output, input);
        if (dest && output !== undefined) return this.outputNode.disconnect(dest, output);
        if (dest) return this.outputNode.disconnect(dest);
        return this.outputNode.disconnect();
    };

    audioCore.registerNode(id, this.inputNode);
  }

  public setMix(mix: number) {
    if (this.isBypassed) return;
    this.dryNode.gain.setValueAtTime(Math.cos(mix * 0.5 * Math.PI), audioCore.getContext().currentTime);
    this.wetNode.gain.setValueAtTime(Math.cos((1.0 - mix) * 0.5 * Math.PI), audioCore.getContext().currentTime);
  }

  public setBypass(bypass: boolean) {
    this.isBypassed = bypass;
    if (bypass) {
      this.dryNode.gain.setValueAtTime(1, audioCore.getContext().currentTime);
      this.wetNode.gain.setValueAtTime(0, audioCore.getContext().currentTime);
    } else {
      // Need to restore original mix, which might be lost.
      // It's handled by updateNodeData usually sending mix alongside bypass.
      // But just in case, we will let store.ts or React handle the state.
    }
  }

  public setDecay(decay: number) {
    this.generateImpulseResponse(decay, 2.0);
  }

  private generateImpulseResponse(duration: number, decay: number) {
    const ctx = audioCore.getContext();
    const sampleRate = ctx.sampleRate;
    const length = sampleRate * duration;
    const impulse = ctx.createBuffer(2, length, sampleRate);
    const left = impulse.getChannelData(0);
    const right = impulse.getChannelData(1);

    for (let i = 0; i < length; i++) {
      const n = i; // decay
      left[i] = (Math.random() * 2 - 1) * Math.pow(1 - n / length, decay);
      right[i] = (Math.random() * 2 - 1) * Math.pow(1 - n / length, decay);
    }

    // Create new convolver if needed? No, can just set buffer
    this.convolver.buffer = impulse;
  }

  public destroy(id: string) {
    this.inputNode.disconnect();
    this.convolver.disconnect();
    this.dryNode.disconnect();
    this.wetNode.disconnect();
    this.outputNode.disconnect();
    audioCore.unregisterNode(id);
  }
}

export class PanningWrapper {
  public node: StereoPannerNode;
  public lfo: OscillatorNode;
  public lfoGain: GainNode;
  private isAutoPan: boolean = false;

  constructor(id: string) {
    const ctx = audioCore.getContext();
    this.node = ctx.createStereoPanner();
    this.node.pan.value = 0;

    this.lfo = ctx.createOscillator();
    this.lfo.type = 'sine';
    this.lfo.frequency.value = 1.0;

    this.lfoGain = ctx.createGain();
    this.lfoGain.gain.value = 0.0;

    this.lfo.connect(this.lfoGain);
    this.lfoGain.connect(this.node.pan);

    this.lfo.start();

    audioCore.registerNode(id, this.node);
    audioCore.registerParam(`${id}.pan`, this.node.pan);
  }

  public setPan(value: number) {
    if (!this.isAutoPan) {
      this.node.pan.setValueAtTime(value, audioCore.getContext().currentTime);
    }
  }

  public setAutoPan(enabled: boolean) {
    this.isAutoPan = enabled;
    if (enabled) {
      // lfo gain is non-zero, let it run
    } else {
      this.lfoGain.gain.setValueAtTime(0, audioCore.getContext().currentTime);
    }
  }

  public setAutoPanRate(rate: number) {
    this.lfo.frequency.setValueAtTime(rate, audioCore.getContext().currentTime);
  }

  public setAutoPanDepth(depth: number) {
    if (this.isAutoPan) {
      this.lfoGain.gain.setValueAtTime(depth, audioCore.getContext().currentTime);
    }
  }

  public destroy(id: string) {
    this.lfo.stop();
    this.lfo.disconnect();
    this.lfoGain.disconnect();
    this.node.disconnect();
    audioCore.unregisterNode(id);
    audioCore.unregisterParam(`${id}.pan`);
  }
}

export class DistortionWrapper {
  public inputNode: GainNode;
  public node: WaveShaperNode;
  public dryGain: GainNode;
  public wetGain: GainNode;
  public outputNode: GainNode;
  private isBypassed: boolean = false;

  constructor(id: string) {
    const ctx = audioCore.getContext();
    this.inputNode = ctx.createGain();
    this.node = ctx.createWaveShaper();
    this.node.oversample = '4x';

    this.dryGain = ctx.createGain();
    this.wetGain = ctx.createGain();
    this.outputNode = ctx.createGain();

    this.dryGain.gain.value = 0; // Default mix 100% wet
    this.wetGain.gain.value = 1;

    this.inputNode.connect(this.dryGain);
    this.inputNode.connect(this.node);
    this.node.connect(this.wetGain);

    this.dryGain.connect(this.outputNode);
    this.wetGain.connect(this.outputNode);

    (this.inputNode as any).connect = (dest: any, output?: number, input?: number) => {
      if (output !== undefined && input !== undefined) return this.outputNode.connect(dest, output, input);
      if (output !== undefined) return this.outputNode.connect(dest, output);
      return this.outputNode.connect(dest);
    };
    (this.inputNode as any).disconnect = (dest?: any, output?: number, input?: number) => {
      if (dest && output !== undefined && input !== undefined) return this.outputNode.disconnect(dest, output, input);
      if (dest && output !== undefined) return this.outputNode.disconnect(dest, output);
      if (dest) return this.outputNode.disconnect(dest);
      return this.outputNode.disconnect();
    };

    this.setDrive(50); // Default drive

    audioCore.registerNode(id, this.inputNode);
  }

  // Uses a polynomial curve for soft clipping/distortion
  public setDrive(amount: number) {
    const ctx = audioCore.getContext();
    const k = typeof amount === 'number' ? amount : 50;
    const n_samples = ctx.sampleRate;
    const curve = new Float32Array(n_samples);
    const deg = Math.PI / 180;

    for (let i = 0; i < n_samples; ++i) {
      const x = i * 2 / n_samples - 1;
      curve[i] = (3 + k) * x * 20 * deg / (Math.PI + k * Math.abs(x));
    }
    this.node.curve = curve;
  }

  public setMix(mix: number) {
    if (this.isBypassed) return;
    this.dryGain.gain.setValueAtTime(Math.cos(mix * 0.5 * Math.PI), audioCore.getContext().currentTime);
    this.wetGain.gain.setValueAtTime(Math.cos((1.0 - mix) * 0.5 * Math.PI), audioCore.getContext().currentTime);
  }

  public setBypass(bypass: boolean) {
    this.isBypassed = bypass;
    if (bypass) {
      this.dryGain.gain.setValueAtTime(1, audioCore.getContext().currentTime);
      this.wetGain.gain.setValueAtTime(0, audioCore.getContext().currentTime);
    } else {
      this.dryGain.gain.setValueAtTime(0, audioCore.getContext().currentTime);
      this.wetGain.gain.setValueAtTime(1, audioCore.getContext().currentTime);
    }
  }

  public destroy(id: string) {
    this.inputNode.disconnect();
    this.node.disconnect();
    this.dryGain.disconnect();
    this.wetGain.disconnect();
    this.outputNode.disconnect();
    audioCore.unregisterNode(id);
  }
}

export class CompressorWrapper {
  public node: DynamicsCompressorNode;

  constructor(id: string) {
    const ctx = audioCore.getContext();
    this.node = ctx.createDynamicsCompressor();
    this.node.threshold.value = -24;
    this.node.knee.value = 30;
    this.node.ratio.value = 12;
    this.node.attack.value = 0.003;
    this.node.release.value = 0.25;

    audioCore.registerNode(id, this.node);
    audioCore.registerParam(`${id}.threshold`, this.node.threshold);
    audioCore.registerParam(`${id}.knee`, this.node.knee);
    audioCore.registerParam(`${id}.ratio`, this.node.ratio);
    audioCore.registerParam(`${id}.attack`, this.node.attack);
    audioCore.registerParam(`${id}.release`, this.node.release);
  }

  public setThreshold(value: number) {
    this.node.threshold.setValueAtTime(value, audioCore.getContext().currentTime);
  }

  public setKnee(value: number) {
    this.node.knee.setValueAtTime(value, audioCore.getContext().currentTime);
  }

  public setRatio(value: number) {
    this.node.ratio.setValueAtTime(value, audioCore.getContext().currentTime);
  }

  public setAttack(value: number) {
    this.node.attack.setValueAtTime(value, audioCore.getContext().currentTime);
  }

  public setRelease(value: number) {
    this.node.release.setValueAtTime(value, audioCore.getContext().currentTime);
  }

  public destroy(id: string) {
    this.node.disconnect();
    audioCore.unregisterNode(id);
    audioCore.unregisterParam(`${id}.threshold`);
    audioCore.unregisterParam(`${id}.knee`);
    audioCore.unregisterParam(`${id}.ratio`);
    audioCore.unregisterParam(`${id}.attack`);
    audioCore.unregisterParam(`${id}.release`);
  }
}

export class ChorusWrapper {
  public inputNode: GainNode;
  public delayNode: DelayNode;
  public lfo: OscillatorNode;
  public lfoGain: GainNode;
  public dryNode: GainNode;
  public wetNode: GainNode;
  public outputNode: GainNode;

  constructor(id: string) {
    const ctx = audioCore.getContext();

    this.inputNode = ctx.createGain();
    this.delayNode = ctx.createDelay();
    this.lfo = ctx.createOscillator();
    this.lfoGain = ctx.createGain();
    this.dryNode = ctx.createGain();
    this.wetNode = ctx.createGain();
    this.outputNode = ctx.createGain();

    // Setup initial values
    this.delayNode.delayTime.value = 0.03; // 30ms base delay
    this.lfo.type = 'sine';
    this.lfo.frequency.value = 1.5; // 1.5Hz rate
    this.lfoGain.gain.value = 0.005; // Mod depth

    this.dryNode.gain.value = 0.5;
    this.wetNode.gain.value = 0.5;

    // Routing
    this.inputNode.connect(this.dryNode);
    this.inputNode.connect(this.delayNode);
    this.delayNode.connect(this.wetNode);
    this.dryNode.connect(this.outputNode);
    this.wetNode.connect(this.outputNode);

    // Modulation
    this.lfo.connect(this.lfoGain);
    this.lfoGain.connect(this.delayNode.delayTime);
    this.lfo.start();

    // Expose output node using the Reverb hack methodology
    (this.inputNode as any).connect = (destination: any) => {
        return this.outputNode.connect(destination);
    };

    (this.inputNode as any).disconnect = (destination?: any) => {
        if (destination) {
            this.outputNode.disconnect(destination);
        } else {
            this.outputNode.disconnect();
        }
    };

    audioCore.registerNode(id, this.inputNode);
  }

  public setRate(rate: number) {
    this.lfo.frequency.setValueAtTime(rate, audioCore.getContext().currentTime);
  }

  public setDepth(depth: number) {
    this.lfoGain.gain.setValueAtTime(depth, audioCore.getContext().currentTime);
  }

  public setMix(mix: number) {
    this.dryNode.gain.setValueAtTime(Math.cos(mix * 0.5 * Math.PI), audioCore.getContext().currentTime);
    this.wetNode.gain.setValueAtTime(Math.cos((1.0 - mix) * 0.5 * Math.PI), audioCore.getContext().currentTime);
  }

  public destroy(id: string) {
    this.inputNode.disconnect();
    this.delayNode.disconnect();
    this.lfo.stop();
    this.lfo.disconnect();
    this.lfoGain.disconnect();
    this.dryNode.disconnect();
    this.wetNode.disconnect();
    this.outputNode.disconnect();
    audioCore.unregisterNode(id);
  }
}

export class BitcrusherWrapper {
  public node: WaveShaperNode;

  constructor(id: string) {
    const ctx = audioCore.getContext();
    this.node = ctx.createWaveShaper();
    this.setBitDepth(8);

    audioCore.registerNode(id, this.node);
  }

  public setBitDepth(bits: number) {
    const ctx = audioCore.getContext();
    const steps = Math.pow(2, bits);
    const n_samples = ctx.sampleRate;
    const curve = new Float32Array(n_samples);

    for (let i = 0; i < n_samples; ++i) {
      const x = (i * 2) / n_samples - 1;
      // Quantize
      curve[i] = Math.round(x * steps) / steps;
    }
    this.node.curve = curve;
  }

  public destroy(id: string) {
    this.node.disconnect();
    audioCore.unregisterNode(id);
  }
}

export class TremoloWrapper {
  public inputNode: GainNode;
  public lfo: OscillatorNode;
  public lfoGain: GainNode;

  constructor(id: string) {
    const ctx = audioCore.getContext();
    this.inputNode = ctx.createGain();
    this.lfo = ctx.createOscillator();
    this.lfoGain = ctx.createGain();

    this.inputNode.gain.value = 1.0;
    this.lfo.type = 'sine';

    // Modulation values
    this.lfo.frequency.value = 5.0; // rate
    this.lfoGain.gain.value = 0.5; // depth

    this.lfo.connect(this.lfoGain);

    // Modulate the gain of inputNode
    this.lfoGain.connect(this.inputNode.gain);

    this.lfo.start();

    audioCore.registerNode(id, this.inputNode);
  }

  public setRate(rate: number) {
    this.lfo.frequency.setValueAtTime(rate, audioCore.getContext().currentTime);
  }

  public setDepth(depth: number) {
    this.lfoGain.gain.setValueAtTime(depth, audioCore.getContext().currentTime);
  }

  public destroy(id: string) {
    this.lfo.stop();
    this.lfo.disconnect();
    this.lfoGain.disconnect();
    this.inputNode.disconnect();
    audioCore.unregisterNode(id);
  }
}

export class RingModulatorWrapper {
  public inputNode: GainNode;
  public modOsc: OscillatorNode;
  public modGain: GainNode;

  constructor(id: string) {
    const ctx = audioCore.getContext();
    this.inputNode = ctx.createGain();
    this.modOsc = ctx.createOscillator();
    this.modGain = ctx.createGain();

    // We want to multiply the input signal by the modulator.
    // In Web Audio API, if an oscillator connects to a gain parameter,
    // it adds to the gain's value.
    // The oscillator goes from -1 to 1.
    // If we set gain.value to 0, it will go from -1 to 1, perfectly multiplying the input (Ring Modulation).
    this.inputNode.gain.value = 0;

    this.modOsc.type = 'sine';
    this.modOsc.frequency.value = 400; // Carrier freq

    this.modOsc.connect(this.inputNode.gain);

    this.modOsc.start();

    audioCore.registerNode(id, this.inputNode);
  }

  public setFrequency(freq: number) {
    this.modOsc.frequency.setValueAtTime(freq, audioCore.getContext().currentTime);
  }

  public setType(type: OscillatorType) {
    this.modOsc.type = type;
  }

  public destroy(id: string) {
    this.modOsc.stop();
    this.modOsc.disconnect();
    this.modGain.disconnect();
    this.inputNode.disconnect();
    audioCore.unregisterNode(id);
  }
}
