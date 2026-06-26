// Small formatting + color helpers shared across labs.

export function fmtTime(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(2)}s`;
}

/** Stable, pleasant color for a node index (used for the ring + space-time diagrams). */
export function nodeColor(i: number): string {
  const hues = [210, 160, 35, 280, 0, 120, 320, 50, 190, 260];
  const h = hues[i % hues.length];
  return `hsl(${h} 70% 60%)`;
}

export function nodeColorDim(i: number): string {
  const hues = [210, 160, 35, 280, 0, 120, 320, 50, 190, 260];
  const h = hues[i % hues.length];
  return `hsl(${h} 45% 28%)`;
}

/** Color for an event-log line by its kind. */
export function logColor(kind: string): string {
  switch (kind) {
    case 'send':
      return '#7c9cff';
    case 'recv':
      return '#8be9c0';
    case 'state':
      return '#ffd479';
    case 'commit':
      return '#73e08a';
    case 'drop':
      return '#ff7a7a';
    case 'crash':
      return '#ff5d6c';
    case 'timer':
      return '#b08bff';
    default:
      return '#9aa2b1';
  }
}

export function clamp(x: number, lo: number, hi: number): number {
  return x < lo ? lo : x > hi ? hi : x;
}
