// Save / load / share the full lab state: the experiment config plus the trained weights.
// localStorage and the URL hash are both wrapped in try/catch so the sandboxed catalog
// thumbnail (no same-origin storage) still renders if they throw.

export interface LabState<TConfig> {
  v: number; // schema version
  config: TConfig;
  weights: number[];
  step: number;
}

const VERSION = 2;
const SLOT_PREFIX = 'synapse:slot:';

// Round weights so the shared URL stays short without visibly changing behavior.
function roundWeights(w: number[]): number[] {
  return w.map((x) => Math.round(x * 1e5) / 1e5);
}

export function encodeState<T>(state: LabState<T>): string {
  const json = JSON.stringify({ ...state, weights: roundWeights(state.weights) });
  // base64url so it's safe in a URL hash.
  const b64 = btoa(unescape(encodeURIComponent(json)));
  return b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function decodeState<T>(s: string): LabState<T> | null {
  try {
    const b64 = s.replace(/-/g, '+').replace(/_/g, '/');
    const json = decodeURIComponent(escape(atob(b64)));
    const obj = JSON.parse(json);
    if (!obj || typeof obj !== 'object' || !('config' in obj) || !Array.isArray(obj.weights)) return null;
    return obj as LabState<T>;
  } catch {
    return null;
  }
}

export function makeState<T>(config: T, weights: number[], step: number): LabState<T> {
  return { v: VERSION, config, weights, step };
}

// ---- localStorage slots ------------------------------------------------------------

// The slot prefix and hash key are parameterized (with the original defaults) so a second
// lab — the CNN/vision track — can persist and share independently without clobbering the
// 2-D playground's saves.
export function saveSlot<T>(name: string, state: LabState<T>, prefix = SLOT_PREFIX): boolean {
  try {
    localStorage.setItem(prefix + name, JSON.stringify(state));
    return true;
  } catch {
    return false;
  }
}

export function loadSlot<T>(name: string, prefix = SLOT_PREFIX): LabState<T> | null {
  try {
    const raw = localStorage.getItem(prefix + name);
    if (!raw) return null;
    return JSON.parse(raw) as LabState<T>;
  } catch {
    return null;
  }
}

export function deleteSlot(name: string, prefix = SLOT_PREFIX): void {
  try {
    localStorage.removeItem(prefix + name);
  } catch {
    /* ignore */
  }
}

export function listSlots(prefix = SLOT_PREFIX): string[] {
  try {
    const names: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key && key.startsWith(prefix)) names.push(key.slice(prefix.length));
    }
    return names.sort();
  } catch {
    return [];
  }
}

export const VISION_SLOT_PREFIX = 'synapse:vslot:';
export const GEN_SLOT_PREFIX = 'synapse:gslot:';
export const RL_SLOT_PREFIX = 'synapse:rslot:';
export const DIFF_SLOT_PREFIX = 'synapse:dslot:';

// ---- URL hash sharing --------------------------------------------------------------

export function writeHashState<T>(state: LabState<T>, key = 's'): string {
  const code = encodeState(state);
  try {
    history.replaceState(null, '', `#${key}=` + code);
  } catch {
    /* ignore */
  }
  return code;
}

export function readHashState<T>(key = 's'): LabState<T> | null {
  try {
    const h = location.hash;
    const m = new RegExp(`[#&]${key}=([^&]+)`).exec(h);
    if (!m) return null;
    return decodeState<T>(m[1]);
  } catch {
    return null;
  }
}

export function shareUrl<T>(state: LabState<T>, key = 's'): string {
  const code = encodeState(state);
  try {
    return `${location.origin}${location.pathname}#${key}=${code}`;
  } catch {
    return `#${key}=${code}`;
  }
}
