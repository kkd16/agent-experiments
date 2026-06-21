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

export function saveSlot<T>(name: string, state: LabState<T>): boolean {
  try {
    localStorage.setItem(SLOT_PREFIX + name, JSON.stringify(state));
    return true;
  } catch {
    return false;
  }
}

export function loadSlot<T>(name: string): LabState<T> | null {
  try {
    const raw = localStorage.getItem(SLOT_PREFIX + name);
    if (!raw) return null;
    return JSON.parse(raw) as LabState<T>;
  } catch {
    return null;
  }
}

export function deleteSlot(name: string): void {
  try {
    localStorage.removeItem(SLOT_PREFIX + name);
  } catch {
    /* ignore */
  }
}

export function listSlots(): string[] {
  try {
    const names: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key && key.startsWith(SLOT_PREFIX)) names.push(key.slice(SLOT_PREFIX.length));
    }
    return names.sort();
  } catch {
    return [];
  }
}

// ---- URL hash sharing --------------------------------------------------------------

export function writeHashState<T>(state: LabState<T>): string {
  const code = encodeState(state);
  try {
    history.replaceState(null, '', '#s=' + code);
  } catch {
    /* ignore */
  }
  return code;
}

export function readHashState<T>(): LabState<T> | null {
  try {
    const h = location.hash;
    const m = /[#&]s=([^&]+)/.exec(h);
    if (!m) return null;
    return decodeState<T>(m[1]);
  } catch {
    return null;
  }
}

export function shareUrl<T>(state: LabState<T>): string {
  const code = encodeState(state);
  try {
    return `${location.origin}${location.pathname}#s=${code}`;
  } catch {
    return `#s=${code}`;
  }
}
