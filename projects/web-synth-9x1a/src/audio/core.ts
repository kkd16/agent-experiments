export class AudioCore {
  private static instance: AudioCore;
  private ctx: AudioContext | null = null;
  private nodes: Map<string, AudioNode> = new Map();
  // Keep track of parameters to be able to map UI handles to Web Audio AudioParams
  private params: Map<string, AudioParam> = new Map();

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
    }
    return this.ctx;
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
      source.connect(ctx.destination);
    }
  }

  public disconnectFromDestination(sourceId: string) {
    const source = this.getNode(sourceId);
    const ctx = this.getContext();
    if (source && ctx) {
      source.disconnect(ctx.destination);
    }
  }
}

export const audioCore = AudioCore.getInstance();
