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
