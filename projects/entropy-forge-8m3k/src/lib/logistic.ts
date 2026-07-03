// logistic.ts — the stretch/squash pair, the fixed-point logit domain that all
// context-mixing math happens in.
//
// A context-mixing compressor never averages probabilities directly; it averages
// them in the *logistic* (log-odds) domain, where combining independent evidence
// is a linear operation. `stretch(p) = ln(p/(1-p))` maps a 12-bit probability to a
// signed "stretched" value in about [-2047, 2047]; `squash` is its inverse. Both
// are integer, table-driven and exactly reproducible — the encoder and decoder must
// compute bit-identical predictions, so there is no floating point on the hot path.
//
// This is the classic lpaq/PAQ construction (Matt Mahoney): a 33-point spline for
// squash, and a stretch table built by inverting it.

// squash(d) = 4096 / (1 + e^(-d/256)), as a 33-knot piecewise-linear spline.
const SQUASH_T = [
  1, 2, 3, 6, 10, 16, 27, 45, 73, 120, 194, 310, 488, 747, 1101, 1546, 2047, 2549,
  2994, 3348, 3607, 3785, 3901, 3975, 4022, 4050, 4068, 4079, 4085, 4089, 4092, 4093, 4094,
]

/** Logistic: map a stretched log-odds value to a 12-bit probability in [0, 4095]. */
export function squash(d: number): number {
  if (d > 2047) return 4095
  if (d < -2047) return 0
  const w = d & 127
  const i = (d >> 7) + 16
  return (SQUASH_T[i] * (128 - w) + SQUASH_T[i + 1] * w + 64) >> 7
}

// stretch[p] = ln(p / (4096 - p)), the inverse of squash, precomputed for p in
// [0, 4095]. Built by walking squash across its domain and filling each output
// probability with the input that produced it.
const STRETCH = new Int16Array(4096)
{
  let pi = 0
  for (let x = -2047; x <= 2047; x++) {
    const i = squash(x)
    for (let j = pi; j <= i; j++) STRETCH[j] = x
    pi = i + 1
  }
  for (let j = pi; j < 4096; j++) STRETCH[j] = 2047
}

/** Inverse logistic: map a 12-bit probability to its log-odds. Clamps its input. */
export function stretch(p: number): number {
  return STRETCH[p < 1 ? 1 : p > 4095 ? 4095 : p]
}

/** Clamp a probability into the open range the arithmetic coder accepts. */
export function clampP(p: number): number {
  return p < 1 ? 1 : p > 4095 ? 4095 : p
}
