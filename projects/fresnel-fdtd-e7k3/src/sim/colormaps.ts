/**
 * Colormap look-up tables. Each map is a 256-entry RGB ramp built from a small
 * set of anchor colours and linearly interpolated. Diverging maps are centered
 * so index 128 is the neutral midpoint — ideal for the signed Ez field.
 */

export type ColormapName = 'rdbu' | 'coolwarm' | 'spectral' | 'twilight' | 'inferno';

interface Anchor {
  t: number; // 0..1
  c: [number, number, number]; // 0..255
}

const RAMPS: Record<ColormapName, Anchor[]> = {
  // Diverging blue -> white -> red (classic field visualization)
  rdbu: [
    { t: 0.0, c: [5, 48, 97] },
    { t: 0.25, c: [33, 102, 172] },
    { t: 0.5, c: [247, 247, 247] },
    { t: 0.75, c: [178, 24, 43] },
    { t: 1.0, c: [103, 0, 31] },
  ],
  // Diverging blue -> light -> red, slightly warmer neutral
  coolwarm: [
    { t: 0.0, c: [59, 76, 192] },
    { t: 0.5, c: [221, 221, 221] },
    { t: 1.0, c: [180, 4, 38] },
  ],
  // Rainbow-ish diverging spectral
  spectral: [
    { t: 0.0, c: [50, 60, 140] },
    { t: 0.25, c: [66, 170, 200] },
    { t: 0.5, c: [250, 250, 210] },
    { t: 0.75, c: [244, 140, 60] },
    { t: 1.0, c: [158, 1, 66] },
  ],
  // Cyclic-ish twilight, good for phase-like fields
  twilight: [
    { t: 0.0, c: [40, 30, 70] },
    { t: 0.3, c: [80, 110, 190] },
    { t: 0.5, c: [225, 225, 235] },
    { t: 0.7, c: [200, 120, 150] },
    { t: 1.0, c: [50, 30, 70] },
  ],
  // Sequential inferno (best applied to |Ez|); centered so it still reads signed
  inferno: [
    { t: 0.0, c: [0, 0, 4] },
    { t: 0.25, c: [87, 16, 110] },
    { t: 0.5, c: [188, 55, 84] },
    { t: 0.75, c: [249, 142, 9] },
    { t: 1.0, c: [252, 255, 164] },
  ],
};

export const COLORMAP_NAMES: ColormapName[] = ['rdbu', 'coolwarm', 'spectral', 'twilight', 'inferno'];

export const COLORMAP_LABELS: Record<ColormapName, string> = {
  rdbu: 'Red–Blue',
  coolwarm: 'Cool–Warm',
  spectral: 'Spectral',
  twilight: 'Twilight',
  inferno: 'Inferno',
};

/** Build a 256*4 RGBA Uint8 LUT for the given colormap. */
export function buildLUT(name: ColormapName): Uint8Array {
  const anchors = RAMPS[name];
  const lut = new Uint8Array(256 * 4);
  for (let i = 0; i < 256; i++) {
    const t = i / 255;
    // find surrounding anchors
    let a = anchors[0];
    let b = anchors[anchors.length - 1];
    for (let k = 0; k < anchors.length - 1; k++) {
      if (t >= anchors[k].t && t <= anchors[k + 1].t) {
        a = anchors[k];
        b = anchors[k + 1];
        break;
      }
    }
    const span = b.t - a.t || 1;
    const f = (t - a.t) / span;
    lut[i * 4 + 0] = Math.round(a.c[0] + (b.c[0] - a.c[0]) * f);
    lut[i * 4 + 1] = Math.round(a.c[1] + (b.c[1] - a.c[1]) * f);
    lut[i * 4 + 2] = Math.round(a.c[2] + (b.c[2] - a.c[2]) * f);
    lut[i * 4 + 3] = 255;
  }
  return lut;
}
