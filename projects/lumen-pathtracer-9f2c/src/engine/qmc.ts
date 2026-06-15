// qmc.ts — quasi-Monte-Carlo (low-discrepancy) sampling for the primary path
// dimensions. White-noise samples (plain rng.next()) clump and leave gaps, so an
// N-sample pixel converges only as O(1/√N). A low-discrepancy sequence spreads
// its points to cover the unit square far more evenly, so the *primary*
// estimators that integrate over the pixel footprint — anti-aliasing and the
// depth-of-field lens — converge closer to O(1/N) for the same sample budget.
//
// We use the Halton sequence (the multi-dimensional van der Corput sequence in
// coprime bases) for the 4 primary dimensions (sub-pixel x/y, lens x/y), and
// decorrelate neighbouring pixels with a per-pixel Cranley–Patterson rotation —
// a toroidal shift that preserves the in-pixel low-discrepancy structure while
// making each pixel's sequence independent (so the image doesn't show
// structured aliasing). Every deeper bounce keeps its own pseudo-random stream,
// which is what keeps the global-illumination estimator unbiased.

// The radical inverse of `i` in `base`: write i in base-b and reflect its digits
// about the radix point. Sweeping i = 0,1,2,… fills [0,1) with ever-finer
// stratification; pairing coprime bases gives a low-discrepancy 2D sequence.
export function radicalInverse(base: number, i: number): number {
  let f = 1
  let r = 0
  while (i > 0) {
    f /= base
    r += f * (i % base)
    i = Math.floor(i / base)
  }
  return r
}

const frac = (x: number): number => x - Math.floor(x)

// A 2D Halton point (bases 2,3) for sample index `i`, Cranley–Patterson-rotated
// by the per-pixel offset (ox,oy) ∈ [0,1)².
export function halton23(i: number, ox: number, oy: number): { x: number; y: number } {
  return { x: frac(radicalInverse(2, i) + ox), y: frac(radicalInverse(3, i) + oy) }
}

// A second 2D Halton point (bases 5,7) for an independent pair of dimensions
// (the camera lens), so the lens disk and the sub-pixel jitter don't correlate.
export function halton57(i: number, ox: number, oy: number): { x: number; y: number } {
  return { x: frac(radicalInverse(5, i) + ox), y: frac(radicalInverse(7, i) + oy) }
}

// A well-mixed hash of integer pixel coordinates → a deterministic [0,1)²
// Cranley–Patterson rotation offset, distinct for every pixel.
export function pixelOffset(px: number, py: number): { x: number; y: number } {
  let h = (Math.imul(px, 0x1f1f1f1f) ^ (py + 0x9e3779b9)) >>> 0
  h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d) >>> 0
  const a = (h >>> 8) / 0x1000000
  h = Math.imul(h ^ (h >>> 13), 0x297a2d39) >>> 0
  const b = (h >>> 8) / 0x1000000
  return { x: a, y: b }
}
