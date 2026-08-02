export class AudioCore {
  private static instance: AudioCore;
  private ctx: AudioContext | null = null;
  private nodes: Map<string, AudioNode> = new Map();
  // Keep track of parameters to be able to map UI handles to Web Audio AudioParams
  private params: Map<string, AudioParam> = new Map();
  private masterGain: GainNode | null = null;
  private masterLimiter: DynamicsCompressorNode | null = null;
  private masterAnalyser: AnalyserNode | null = null;
  private analyserData: Float32Array | null = null;

  private constructor() {}

  public static getInstance(): AudioCore {
    if (!AudioCore.instance) {
      AudioCore.instance = new AudioCore();
    }
    return AudioCore.instance;
  }

  public getContext(): AudioContext {
    if (!this.ctx) {
      this.ctx = new (window.AudioContext || (window as unknown as Record<string, unknown>).webkitAudioContext)();
      this.masterGain = this.ctx.createGain();
      this.masterGain.gain.value = 1.0;

      this.masterLimiter = this.ctx.createDynamicsCompressor();
      this.masterLimiter.threshold.value = -3;
      this.masterLimiter.knee.value = 12;
      this.masterLimiter.ratio.value = 20;
      this.masterLimiter.attack.value = 0.005;
      this.masterLimiter.release.value = 0.050;

      this.masterGain.connect(this.masterLimiter);
      this.masterAnalyser = this.ctx.createAnalyser();
      this.masterLimiter.connect(this.masterAnalyser);
      this.masterAnalyser.connect(this.ctx.destination);
      this.analyserData = new Float32Array(this.masterAnalyser.fftSize);
    }
    return this.ctx;
  }

  public getMasterAnalyserData(): Float32Array | null {
    if (this.masterAnalyser && this.analyserData) {
      this.masterAnalyser.getFloatTimeDomainData(this.analyserData as any);
      return this.analyserData;
    }
    return null;
  }

  public async resumeContext() {
    const ctx = this.getContext();
    if (ctx.state === 'suspended') {
      await ctx.resume();
    }
  }

  public registerNode(id: string, node: AudioNode) {
    this.nodes.set(id, node);
  }

  public unregisterNode(id: string) {
    const node = this.nodes.get(id);
    if (node) {
      node.disconnect();
      this.nodes.delete(id);
    }
  }

  public registerParam(id: string, param: AudioParam) {
    this.params.set(id, param);
  }

  public unregisterParam(id: string) {
    this.params.delete(id);
  }

  public getNode(id: string): AudioNode | undefined {
    return this.nodes.get(id);
  }

  public getParam(id: string): AudioParam | undefined {
    return this.params.get(id);
  }

  public connect(sourceId: string, targetId: string) {
    const source = this.getNode(sourceId);
    if (!source) return;

    // Check if target is a param (e.g. connecting LFO to Oscillator Frequency)
    const targetParam = this.getParam(targetId);
    if (targetParam) {
      source.connect(targetParam);
      return;
    }

    // Check if target is a node
    const targetNode = this.getNode(targetId);
    if (targetNode) {
      source.connect(targetNode);
      return;
    }
  }

  public disconnect(sourceId: string, targetId: string) {
    const source = this.getNode(sourceId);
    if (!source) return;

    const targetParam = this.getParam(targetId);
    if (targetParam) {
      source.disconnect(targetParam);
      return;
    }

    const targetNode = this.getNode(targetId);
    if (targetNode) {
      source.disconnect(targetNode);
      return;
    }
  }

  // Master output
  public connectToDestination(sourceId: string) {
    const source = this.getNode(sourceId);
    const ctx = this.getContext();
    if (source && ctx) {
      if (this.masterGain) { source.connect(this.masterGain); } else { source.connect(ctx.destination); }
    }
  }

  public setMasterVolume(vol: number) {
    if (this.masterGain && this.ctx) {
      this.masterGain.gain.setValueAtTime(vol, this.ctx.currentTime);
    }
  }

  public disconnectFromDestination(sourceId: string) {
    const source = this.getNode(sourceId);
    const ctx = this.getContext();
    if (source && ctx) {
      if (this.masterGain) { source.disconnect(this.masterGain); } else { source.disconnect(ctx.destination); }
    }
  }
}

export const audioCore = AudioCore.getInstance();
