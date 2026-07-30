import type { SourceKind } from '../sim/FDTD';

export type Tool = 'source' | 'paint' | 'probe' | 'erase';

export interface ToolState {
  tool: Tool;
  brushKey: string;
  brushSize: number;
  sourceKind: SourceKind;
  sourceWavelength: number;
  sourceAmplitude: number;
}
