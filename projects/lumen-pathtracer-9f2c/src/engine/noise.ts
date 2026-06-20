// noise.ts — a small, dependency-free procedural noise toolkit used to build the
// 3D density fields of heterogeneous participating media (clouds, smoke, fog).
//
// Everything here is a *pure function of position* (plus an integer seed): there
// is no internal state and nothing is allocated in the hot path, so the same
// field evaluates identically on the UI thread and every render worker, and a
// delta-/ratio-tracking loop can probe it millions of times per frame cheaply.
//
// The primitive is classic **value noise**: hash the eight integer-lattice
// corners of the cell containing `p`, then trilinearly interpolate their pseudo-
// random values with a quintic smoothstep (Perlin's C² fade, so the field and
// its gradient are both continuous — no creases). `fbm3` sums octaves of it at
// geometrically increasing frequency and decreasing amplitude (fractional
// Brownian motion), which is what gives clouds their self-similar billows.

// A fast integer hash (a 32-bit avalanche, à la the "wang"/"murmur" finalisers)
// mixing three lattice coordinates and a seed into a uniform value in [0, 1).
function hash3(ix: number, iy: number, iz: number, seed: number): number {
  let h = (ix | 0) * 0x1f1f1f1f
  h ^= (iy | 0) * 0x27d4eb2f
  h ^= (iz | 0) * 0x165667b1
  h ^= seed * 0x9e3779b1
  // 32-bit integer avalanche (xorshift-multiply finaliser).
  h = Math.imul(h ^ (h >>> 16), 0x7feb352d)
  h = Math.imul(h ^ (h >>> 15), 0x846ca68b)
  h ^= h >>> 16
  // >>> 0 → unsigned; map to [0, 1).
  return (h >>> 0) / 4294967296
}

// Perlin's quintic fade 6t⁵ − 15t⁴ + 10t³ (C² continuous at the cell boundary).
function fade(t: number): number {
  return t * t * t * (t * (t * 6 - 15) + 10)
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t
}

// Value noise in [0, 1] at an arbitrary point, with a per-field integer seed.
export function valueNoise3(x: number, y: number, z: number, seed = 0): number {
  const ix = Math.floor(x)
  const iy = Math.floor(y)
  const iz = Math.floor(z)
  const fx = x - ix
  const fy = y - iy
  const fz = z - iz
  const ux = fade(fx)
  const uy = fade(fy)
  const uz = fade(fz)

  const c000 = hash3(ix, iy, iz, seed)
  const c100 = hash3(ix + 1, iy, iz, seed)
  const c010 = hash3(ix, iy + 1, iz, seed)
  const c110 = hash3(ix + 1, iy + 1, iz, seed)
  const c001 = hash3(ix, iy, iz + 1, seed)
  const c101 = hash3(ix + 1, iy, iz + 1, seed)
  const c011 = hash3(ix, iy + 1, iz + 1, seed)
  const c111 = hash3(ix + 1, iy + 1, iz + 1, seed)

  const x00 = lerp(c000, c100, ux)
  const x10 = lerp(c010, c110, ux)
  const x01 = lerp(c001, c101, ux)
  const x11 = lerp(c011, c111, ux)
  const y0 = lerp(x00, x10, uy)
  const y1 = lerp(x01, x11, uy)
  return lerp(y0, y1, uz)
}

// Fractional Brownian motion: sum `octaves` of value noise, each at `lacunarity`×
// the previous frequency and `gain`× the previous amplitude, normalised back into
// [0, 1]. Higher octaves add finer wisps; `gain < 1` keeps them subordinate.
export function fbm3(
  x: number,
  y: number,
  z: number,
  octaves: number,
  lacunarity: number,
  gain: number,
  seed = 0,
): number {
  let sum = 0
  let amp = 1
  let norm = 0
  let freq = 1
  for (let o = 0; o < octaves; o++) {
    sum += amp * valueNoise3(x * freq, y * freq, z * freq, seed + o * 1013)
    norm += amp
    amp *= gain
    freq *= lacunarity
  }
  return norm > 0 ? sum / norm : 0
}

// A cheap domain warp: offset the sample point by a low-frequency noise vector
// before evaluating the field, which bends the otherwise grid-aligned billows
// into the curled, turbulent shapes of real smoke and cumulus. `amount` is the
// warp displacement in field-space units.
export function warp3(
  x: number,
  y: number,
  z: number,
  amount: number,
  seed = 0,
): { x: number; y: number; z: number } {
  if (amount === 0) return { x, y, z }
  const wx = valueNoise3(x + 11.3, y + 4.7, z + 1.1, seed + 31) - 0.5
  const wy = valueNoise3(x + 2.9, y + 19.2, z + 8.4, seed + 57) - 0.5
  const wz = valueNoise3(x + 7.6, y + 3.3, z + 23.7, seed + 83) - 0.5
  return { x: x + amount * wx, y: y + amount * wy, z: z + amount * wz }
}
