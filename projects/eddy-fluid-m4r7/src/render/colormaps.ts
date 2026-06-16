// colormaps.ts — perceptual colour ramps for scalar field visualisation.
//
// Each map takes t ∈ [0, 1] and returns [r, g, b] in 0..255. The ramps are
// piecewise-linear interpolations of hand-picked control points (the inferno
// and viridis anchors are sampled from the well-known matplotlib maps).

export type RGB = [number, number, number];
export type ColorMap = (t: number) => RGB;

function ramp(stops: RGB[]): ColorMap {
  const n = stops.length - 1;
  return (t: number): RGB => {
    const x = t <= 0 ? 0 : t >= 1 ? 1 : t;
    const f = x * n;
    const i = Math.min(n - 1, Math.floor(f));
    const local = f - i;
    const a = stops[i];
    const b = stops[i + 1];
    return [
      a[0] + (b[0] - a[0]) * local,
      a[1] + (b[1] - a[1]) * local,
      a[2] + (b[2] - a[2]) * local,
    ];
  };
}

export const inferno = ramp([
  [0, 0, 4],
  [40, 11, 84],
  [101, 21, 110],
  [159, 42, 99],
  [212, 72, 66],
  [245, 125, 21],
  [250, 193, 39],
  [252, 255, 164],
]);

export const viridis = ramp([
  [68, 1, 84],
  [72, 40, 120],
  [62, 74, 137],
  [49, 104, 142],
  [38, 130, 142],
  [31, 158, 137],
  [53, 183, 121],
  [109, 205, 89],
  [180, 222, 44],
  [253, 231, 37],
]);

export const ice = ramp([
  [3, 5, 25],
  [10, 30, 80],
  [20, 80, 160],
  [60, 150, 220],
  [150, 220, 250],
  [240, 255, 255],
]);

export const magma = ramp([
  [0, 0, 4],
  [28, 16, 68],
  [79, 18, 123],
  [129, 37, 129],
  [181, 54, 122],
  [229, 80, 100],
  [251, 135, 97],
  [254, 194, 135],
  [252, 253, 191],
]);

export const COLORMAPS: Record<string, ColorMap> = { inferno, viridis, ice, magma };
export type ColorMapName = keyof typeof COLORMAPS;

// Diverging map for signed fields (vorticity): blue → black → red.
export function diverging(t: number): RGB {
  // t ∈ [-1, 1]
  const x = t < -1 ? -1 : t > 1 ? 1 : t;
  if (x < 0) {
    const k = -x;
    return [20 * (1 - k), 60 * (1 - k) + 20 * k, 90 * (1 - k) + 230 * k];
  }
  return [90 * (1 - x) + 240 * x, 60 * (1 - x) + 40 * x, 20 * (1 - x)];
}
