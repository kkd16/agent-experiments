// Tiny 2-D PCA via power iteration with deflation — no matrix libraries. Given a set of
// row vectors, it returns the mean, the top-2 principal axes, and each point projected onto
// them. Used by the generative lab to flatten a high-dimensional latent code down to a plane
// (for the latent-space scatter and the latent-manifold sweep).

export interface Pca2D {
  mean: Float64Array; // [D]
  axisU: Float64Array; // [D] first principal direction (unit length)
  axisV: Float64Array; // [D] second principal direction (unit length)
  points: { x: number; y: number }[]; // each input row projected onto (axisU, axisV)
}

function dot(a: Float64Array, b: Float64Array): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
}

// Largest-eigenvalue eigenvector of the covariance, estimated by iterating v ← Cov·v on the
// centered data (Cov·v = Σ_i x_i (x_iᵀ v) without ever forming Cov).
function topAxis(rows: Float64Array[], D: number, seed: number): Float64Array {
  let s = seed >>> 0;
  const rand = () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296 - 0.5;
  };
  let v = new Float64Array(D);
  for (let i = 0; i < D; i++) v[i] = rand();
  let norm = Math.sqrt(dot(v, v)) || 1;
  for (let i = 0; i < D; i++) v[i] /= norm;

  for (let iter = 0; iter < 64; iter++) {
    const next = new Float64Array(D);
    for (const r of rows) {
      const proj = dot(r, v);
      for (let i = 0; i < D; i++) next[i] += proj * r[i];
    }
    norm = Math.sqrt(dot(next, next));
    if (norm < 1e-12) break;
    for (let i = 0; i < D; i++) next[i] /= norm;
    v = next;
  }
  return v;
}

export function pca2d(data: Float64Array[], D: number, seed = 1234): Pca2D {
  const mean = new Float64Array(D);
  for (const r of data) for (let i = 0; i < D; i++) mean[i] += r[i];
  if (data.length) for (let i = 0; i < D; i++) mean[i] /= data.length;

  const centered = data.map((r) => {
    const c = new Float64Array(D);
    for (let i = 0; i < D; i++) c[i] = r[i] - mean[i];
    return c;
  });

  const axisU = topAxis(centered, D, seed);
  // Deflate: remove the first component, then find the next axis.
  const residual = centered.map((r) => {
    const proj = dot(r, axisU);
    const c = new Float64Array(D);
    for (let i = 0; i < D; i++) c[i] = r[i] - proj * axisU[i];
    return c;
  });
  const axisV = topAxis(residual, D, seed ^ 0x9e3779b9);

  const points = centered.map((r) => ({ x: dot(r, axisU), y: dot(r, axisV) }));
  return { mean, axisU, axisV, points };
}
