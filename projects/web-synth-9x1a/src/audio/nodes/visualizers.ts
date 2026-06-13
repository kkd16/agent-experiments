import { audioCore } from '../core';

export class AnalyserWrapper {
  public node: AnalyserNode;
  public dataArray: Uint8Array;

  constructor(id: string) {
    const ctx = audioCore.getContext();
    this.node = ctx.createAnalyser();

    // Configure analyser
    this.node.fftSize = 2048; // determines buffer size
    const bufferLength = this.node.frequencyBinCount;
    this.dataArray = new Uint8Array(bufferLength);

    audioCore.registerNode(id, this.node);
  }

  // Returns current time-domain data (waveform)
  public getWaveformData(): Uint8Array {
    this.node.getByteTimeDomainData(this.dataArray as any);
    return this.dataArray;
  }

  // Returns current frequency data (spectrum)
  public getFrequencyData(): Uint8Array {
    this.node.getByteFrequencyData(this.dataArray as any);
    return this.dataArray;
  }

  public destroy(id: string) {
    this.node.disconnect();
    audioCore.unregisterNode(id);
  }
}
