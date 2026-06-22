// Shared palette + small color helpers used by the canvas/SVG views.

// Distinct, legible class colors (up to 4 classes in our datasets).
export const CLASS_COLORS: [number, number, number][] = [
  [56, 189, 248], // sky
  [244, 114, 182], // pink
  [163, 230, 53], // lime
  [251, 191, 36], // amber
];

// A wider palette (up to 6 classes) for the graph lab, where the SBM / blob datasets can have
// more communities than the 2-D playground's four-class maximum.
export const GRAPH_CLASS_COLORS: [number, number, number][] = [
  [56, 189, 248], // sky
  [244, 114, 182], // pink
  [163, 230, 53], // lime
  [251, 191, 36], // amber
  [167, 139, 250], // violet
  [45, 212, 191], // teal
];

export const POSITIVE_COLOR: [number, number, number] = [56, 189, 248];
export const NEGATIVE_COLOR: [number, number, number] = [244, 114, 182];

export function rgbCss(c: [number, number, number], a = 1): string {
  return `rgba(${c[0]}, ${c[1]}, ${c[2]}, ${a})`;
}

export function mix(
  a: [number, number, number],
  b: [number, number, number],
  t: number,
): [number, number, number] {
  return [
    Math.round(a[0] + (b[0] - a[0]) * t),
    Math.round(a[1] + (b[1] - a[1]) * t),
    Math.round(a[2] + (b[2] - a[2]) * t),
  ];
}

// Diverging blue→white→pink ramp for signed scalar fields (activations, weights).
// v is expected in [-1, 1]; values outside are clamped.
export function diverging(v: number): [number, number, number] {
  const x = Math.max(-1, Math.min(1, v));
  const bg: [number, number, number] = [15, 23, 42];
  if (x >= 0) return mix(bg, POSITIVE_COLOR, x);
  return mix(bg, NEGATIVE_COLOR, -x);
}
