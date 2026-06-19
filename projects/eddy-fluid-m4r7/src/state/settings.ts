// settings.ts — UI-facing settings, defaults, and guarded persistence.
//
// localStorage is wrapped in try/catch because the catalog renders each app in
// a sandboxed iframe with no same-origin access — touching storage there throws.

import { DEFAULT_PARAMS, type FluidParams } from '../sim/fluid';
import type { RenderMode } from '../render/renderer';
import type { ColorMapName } from '../render/colormaps';

export type Tool = 'dye' | 'heat' | 'fuel' | 'wall' | 'erase';

export interface Settings {
  params: FluidParams;
  resolution: number; // interior grid cells per side
  mode: RenderMode;
  colormap: ColorMapName;
  showArrows: boolean;
  showStreamlines: boolean;
  showParticles: boolean;
  showProbe: boolean;
  exposure: number;
  tool: Tool;
  brushColor: string; // hex; "rainbow" sentinel for cycling hue
  brushRadius: number;
  forceScale: number;
  sceneId: string;
  /** FTLE/LCS integration horizon (seconds) for the `ftle` render mode. */
  ftleTime: number;
  /** Integrate the FTLE flow map backward (attracting LCS) instead of forward. */
  ftleBackward: boolean;
}

export const DEFAULT_SETTINGS: Settings = {
  params: { ...DEFAULT_PARAMS },
  resolution: 160,
  mode: 'dye',
  colormap: 'inferno',
  showArrows: false,
  showStreamlines: false,
  showParticles: false,
  showProbe: true,
  exposure: 1,
  tool: 'dye',
  brushColor: 'rainbow',
  brushRadius: 4,
  forceScale: 1,
  sceneId: 'blank',
  ftleTime: 1.2,
  ftleBackward: true,
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

/** Encode settings into a URL-safe string for shareable permalinks. */
export function encodeSettings(s: Settings): string {
  try {
    return btoa(encodeURIComponent(JSON.stringify(s)));
  } catch {
    return '';
  }
}

/** Decode settings from a permalink fragment; returns null if invalid. */
export function decodeSettings(raw: string): Settings | null {
  try {
    const parsed = JSON.parse(decodeURIComponent(atob(raw))) as Partial<Settings>;
    return {
      ...DEFAULT_SETTINGS,
      ...parsed,
      params: { ...DEFAULT_SETTINGS.params, ...(parsed.params ?? {}) },
    };
  } catch {
    return null;
  }
}

/** Read a `cfg` permalink payload out of the current location hash, if any. */
export function settingsFromHash(): Settings | null {
  const m = /[?&]cfg=([^&]+)/.exec(window.location.hash);
  return m ? decodeSettings(m[1]) : null;
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
