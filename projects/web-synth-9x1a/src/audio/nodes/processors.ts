import { audioCore } from '../core';

export class GainWrapper {
  public node: GainNode;

  constructor(id: string) {
    const ctx = audioCore.getContext();
    this.node = ctx.createGain();
    this.node.gain.value = 0.5;

    audioCore.registerNode(id, this.node);
    audioCore.registerParam(`${id}.gain`, this.node.gain);
  }

  public setGain(value: number) {
    this.node.gain.setValueAtTime(value, audioCore.getContext().currentTime);
  }

  public destroy(id: string) {
    audioCore.unregisterNode(id);
    audioCore.unregisterParam(`${id}.gain`);
  }
}

export class FilterWrapper {
  public node: BiquadFilterNode;

  constructor(id: string) {
    const ctx = audioCore.getContext();
    this.node = ctx.createBiquadFilter();
    this.node.type = 'lowpass';
    this.node.frequency.value = 1000;
    this.node.Q.value = 1;

    audioCore.registerNode(id, this.node);
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

  public destroy(id: string) {
    audioCore.unregisterNode(id);
    audioCore.unregisterParam(`${id}.frequency`);
    audioCore.unregisterParam(`${id}.Q`);
  }
}

export class DelayWrapper {
  public node: DelayNode;
  public feedbackNode: GainNode;

  constructor(id: string) {
    const ctx = audioCore.getContext();
    this.node = ctx.createDelay(5.0); // max delay 5 seconds
    this.node.delayTime.value = 0.5;

    this.feedbackNode = ctx.createGain();
    this.feedbackNode.gain.value = 0.5;

    // Connect node -> feedback -> node for the echo effect
    this.node.connect(this.feedbackNode);
    this.feedbackNode.connect(this.node);

    audioCore.registerNode(id, this.node);
    audioCore.registerParam(`${id}.delayTime`, this.node.delayTime);
    audioCore.registerParam(`${id}.feedback`, this.feedbackNode.gain);
  }

  public setDelayTime(time: number) {
    this.node.delayTime.setValueAtTime(time, audioCore.getContext().currentTime);
  }

  public setFeedback(gain: number) {
    this.feedbackNode.gain.setValueAtTime(gain, audioCore.getContext().currentTime);
  }

  public destroy(id: string) {
    this.node.disconnect(this.feedbackNode);
    this.feedbackNode.disconnect(this.node);
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

    // Generate a simple impulse response for default reverb
    this.setDecay(2.0); // 2 seconds decay default

    // Register node (input -> inputNode, output is outputNode conceptually,
    // but audioCore's connect assumes a single AudioNode interface.
    // To support input and output from this wrapper, we register inputNode
    // and rely on our audioCore.connect logic to handle single nodes or params.
    // We actually need to expose outputNode to be connected *from*.
    // Wait, the current audioCore registerNode stores *one* node per ID which
    // is used for both input and output. We can work around this by registering
    // the outputNode as the main node, and overriding how connections are made,
    // or we can register inputNode and override disconnect.
    // Actually, in our current architecture, registerNode stores ONE AudioNode.
    // Let's create a custom interface or wrapper logic in audioCore? No, we
    // can just register the input node for incoming connections, but we must
    // make sure outgoing connections come from the outputNode.
    // Wait, audioCore.getNode(id) is used for BOTH source and target.
    // So if source.connect is called, we need source to be outputNode.
    // If we register outputNode, incoming connections will hit outputNode.
    // Let's register inputNode, and we'll need to update audioCore or we can
    // hack it by exposing a connect method.
    // Wait, if we register inputNode, then incoming edges connect to inputNode.
    // If outgoing edges connect from Reverb, audioCore will call source.connect,
    // meaning inputNode.connect. This is a flaw in the current AudioCore for
    // composite nodes.
    // Let's modify audioCore slightly to handle composite nodes, or we can just
    // expose outputNode by patching its connect/disconnect methods.

    // Hack for now: Register inputNode, but override its connect/disconnect methods
    // to act on the outputNode.

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

  // Generate a synthetic impulse response
  public setDecay(decay: number) {
    const ctx = audioCore.getContext();
    const length = ctx.sampleRate * decay;
    const impulse = ctx.createBuffer(2, length, ctx.sampleRate);
    const left = impulse.getChannelData(0);
    const right = impulse.getChannelData(1);

    for (let i = 0; i < length; i++) {
        const n = i; // decay envelope
        const envelope = Math.pow(1 - n / length, 2.0); // exponential decay
        left[i] = (Math.random() * 2 - 1) * envelope;
        right[i] = (Math.random() * 2 - 1) * envelope;
    }

    this.convolver.buffer = impulse;
  }

  public setMix(mix: number) { // 0.0 to 1.0
    // Equal power crossfade
    this.dryNode.gain.setValueAtTime(Math.cos(mix * 0.5 * Math.PI), audioCore.getContext().currentTime);
    this.wetNode.gain.setValueAtTime(Math.cos((1.0 - mix) * 0.5 * Math.PI), audioCore.getContext().currentTime);
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

  constructor(id: string) {
    const ctx = audioCore.getContext();
    this.node = ctx.createStereoPanner();
    this.node.pan.value = 0;

    audioCore.registerNode(id, this.node);
    audioCore.registerParam(`${id}.pan`, this.node.pan);
  }

  public setPan(value: number) {
    this.node.pan.setValueAtTime(value, audioCore.getContext().currentTime);
  }

  public destroy(id: string) {
    this.node.disconnect();
    audioCore.unregisterNode(id);
    audioCore.unregisterParam(`${id}.pan`);
  }
}

export class DistortionWrapper {
  public node: WaveShaperNode;

  constructor(id: string) {
    const ctx = audioCore.getContext();
    this.node = ctx.createWaveShaper();
    this.node.oversample = '4x';
    this.setDrive(50); // Default drive

    audioCore.registerNode(id, this.node);
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

  public destroy(id: string) {
    this.node.disconnect();
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
