// lic.ts — Line Integral Convolution: a dense, texture-like view of a flow.
//
// LIC (Cabral & Leedom, 1993) turns a vector field into an image by smearing a
// white-noise texture *along* the field's streamlines. Where the flow is fast
// and coherent the noise blurs into long streaks aligned with the velocity;
// where it stalls or swirls the texture stays grainy or curls. The result reads
// like ink dropped on flowing water — every pixel shows the local flow direction
// at once, with none of the seed-placement gaps a sparse streamline plot has.
//
// Everything here is a pure function over typed arrays (no canvas, no DOM), so
// the verification suite can pin down its invariants directly: the convolution
// weights are non-negative, so the output obeys a maximum principle (a convex
// blend of the noise can't leave the noise's range); with no flow each pixel
// convolves a single point and the output is the noise unchanged; and under a
// uniform shear the texture is provably smoother *along* the flow than across it.

export interface LICInput {
  /** Interior grid resolution; fields are the usual (N+2)² padded arrays. */
  N: number;
  u: Float32Array;
  v: Float32Array;
  /** N×N white-noise texture (row-major, interior cells only). */
  noise: Float32Array;
  /** Optional solid mask ((N+2)², non-zero = wall) — walls render flat. */
  solid?: Uint8Array;
}

export interface LICOptions {
  /** Half-length of the convolution: this many integration steps each way. */
  steps?: number;
  /** Arc-length advanced per step, in grid cells. */
  step?: number;
  /**
   * Animation phase in [0, 1). The convolution kernel is a cosine lobe that
   * travels downstream as the phase advances, so the whole texture appears to
   * flow. At any fixed phase the weights stay non-negative (max principle holds).
   */
  phase?: number;
}

/** Deterministic white-noise texture in [0, 1], seeded — the LIC input pattern. */
export function makeNoise(N: number, seed = 0x9e3779b9): Float32Array {
  const out = new Float32Array(N * N);
  // mulberry32 — small, fast, well-distributed.
  let s = (seed ^ 0x6d2b79f5) >>> 0;
  for (let k = 0; k < out.length; k++) {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    out[k] = ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  return out;
}

/**
 * Compute the LIC intensity field into `out` (length N²). For each interior cell
 * we integrate the streamline through its centre forward and backward with a
 * midpoint (RK2) step, sample the noise along it, and accumulate a phase-shifted
 * cosine-windowed average. Solid cells are written as 0.
 */
export function computeLIC(inp: LICInput, out: Float32Array, opts: LICOptions = {}): void {
  const { N, u, v, noise, solid } = inp;
  const S = N + 2;
  const steps = Math.max(2, opts.steps ?? 16);
  const h = opts.step ?? 0.85;
  const phase = opts.phase ?? 0;
  const TAU = Math.PI * 2;

  // Bilinear sample of a padded (N+2)² field at fractional grid coords.
  const sampleField = (f: Float32Array, x: number, y: number): number => {
    if (x < 0.5) x = 0.5;
    else if (x > N + 0.5) x = N + 0.5;
    if (y < 0.5) y = 0.5;
    else if (y > N + 0.5) y = N + 0.5;
    const i0 = Math.floor(x);
    const j0 = Math.floor(y);
    const s1 = x - i0;
    const s0 = 1 - s1;
    const t1 = y - j0;
    const t0 = 1 - t1;
    const i1 = i0 + 1;
    const j1 = j0 + 1;
    return (
      s0 * (t0 * f[i0 + S * j0] + t1 * f[i0 + S * j1]) +
      s1 * (t0 * f[i1 + S * j0] + t1 * f[i1 + S * j1])
    );
  };

  // Bilinear sample of the N×N interior noise at grid coords (1..N → 0..N-1).
  const sampleNoise = (x: number, y: number): number => {
    let nx = x - 1;
    let ny = y - 1;
    if (nx < 0) nx = 0;
    else if (nx > N - 1) nx = N - 1;
    if (ny < 0) ny = 0;
    else if (ny > N - 1) ny = N - 1;
    const i0 = Math.floor(nx);
    const j0 = Math.floor(ny);
    const i1 = Math.min(N - 1, i0 + 1);
    const j1 = Math.min(N - 1, j0 + 1);
    const s1 = nx - i0;
    const s0 = 1 - s1;
    const t1 = ny - j0;
    const t0 = 1 - t1;
    return (
      s0 * (t0 * noise[i0 + N * j0] + t1 * noise[i0 + N * j1]) +
      s1 * (t0 * noise[i1 + N * j0] + t1 * noise[i1 + N * j1])
    );
  };

  // Travelling cosine window: weight for offset `s` ∈ [-1, 1] along the path.
  // Non-negative everywhere, so the weighted average can't overshoot the noise.
  const weight = (s: number): number => 0.5 * (1 + Math.cos(TAU * (0.5 * s - phase)));

  for (let oj = 0; oj < N; oj++) {
    for (let oi = 0; oi < N; oi++) {
      const cell = oj * N + oi;
      const idx = oi + 1 + S * (oj + 1);
      if (solid && solid[idx]) {
        out[cell] = 0;
        continue;
      }
      const cx = oi + 1;
      const cy = oj + 1;
      // Centre sample.
      let acc = weight(0) * sampleNoise(cx, cy);
      let wsum = weight(0);

      // March forward (+) and backward (−) along the streamline.
      for (const dir of [1, -1]) {
        let x = cx;
        let y = cy;
        for (let k = 1; k <= steps; k++) {
          let vu = sampleField(u, x, y);
          let vv = sampleField(v, x, y);
          let sp = Math.hypot(vu, vv);
          if (sp < 1e-6) break; // stalled — nothing to convolve along
          // Normalise to unit speed so the kernel is arc-length parameterised.
          vu /= sp;
          vv /= sp;
          // Midpoint (RK2) probe.
          let mu = sampleField(u, x + dir * 0.5 * h * vu, y + dir * 0.5 * h * vv);
          let mv = sampleField(v, x + dir * 0.5 * h * vu, y + dir * 0.5 * h * vv);
          sp = Math.hypot(mu, mv);
          if (sp > 1e-6) {
            mu /= sp;
            mv /= sp;
          } else {
            mu = vu;
            mv = vv;
          }
          x += dir * h * mu;
          y += dir * h * mv;
          if (x < 0.5 || x > N + 0.5 || y < 0.5 || y > N + 0.5) break;
          const s = (dir * k) / steps; // ∈ [-1, 1]
          const w = weight(s);
          acc += w * sampleNoise(x, y);
          wsum += w;
        }
      }
      out[cell] = wsum > 0 ? acc / wsum : 0.5;
    }
  }
}
