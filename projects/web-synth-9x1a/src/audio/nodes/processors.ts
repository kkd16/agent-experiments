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
