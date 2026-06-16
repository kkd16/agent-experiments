// settings.ts — UI-facing settings, defaults, and guarded persistence.
//
// localStorage is wrapped in try/catch because the catalog renders each app in
// a sandboxed iframe with no same-origin access — touching storage there throws.

import { DEFAULT_PARAMS, type FluidParams } from '../sim/fluid';
import type { RenderMode } from '../render/renderer';
import type { ColorMapName } from '../render/colormaps';

export type Tool = 'dye' | 'wall' | 'erase';

export interface Settings {
  params: FluidParams;
  resolution: number; // interior grid cells per side
  mode: RenderMode;
  colormap: ColorMapName;
  showArrows: boolean;
  exposure: number;
  tool: Tool;
  brushColor: string; // hex; "rainbow" sentinel for cycling hue
  brushRadius: number;
  forceScale: number;
  sceneId: string;
}

export const DEFAULT_SETTINGS: Settings = {
  params: { ...DEFAULT_PARAMS },
  resolution: 160,
  mode: 'dye',
  colormap: 'inferno',
  showArrows: false,
  exposure: 1,
  tool: 'dye',
  brushColor: 'rainbow',
  brushRadius: 4,
  forceScale: 1,
  sceneId: 'blank',
};

const KEY = 'eddy-fluid:settings:v1';

export function loadSettings(): Settings {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return { ...DEFAULT_SETTINGS };
    const parsed = JSON.parse(raw) as Partial<Settings>;
    return {
      ...DEFAULT_SETTINGS,
      ...parsed,
      params: { ...DEFAULT_SETTINGS.params, ...(parsed.params ?? {}) },
    };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export function saveSettings(s: Settings): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(s));
  } catch {
    /* sandboxed preview — ignore */
  }
}

/** Parse a hex colour to a dye RGB triple scaled by `intensity`. */
export function hexToDye(hex: string, intensity: number): [number, number, number] {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return [intensity, intensity, intensity];
  const n = parseInt(m[1], 16);
  return [
    ((n >> 16) & 255) / 255 * intensity,
    ((n >> 8) & 255) / 255 * intensity,
    (n & 255) / 255 * intensity,
  ];
}
