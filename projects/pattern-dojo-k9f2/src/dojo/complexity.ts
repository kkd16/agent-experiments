/**
 * The complexity-fitting math for the Code Dojo profiler.
 *
 * Given a set of (n, t) measurements — input size n, measured per-call time t —
 * this module decides which asymptotic growth class the timings most resemble:
 * O(1), O(log n), O(n), O(n log n), O(n²), O(n³) or O(2ⁿ).
 *
 * Two independent signals are combined:
 *
 *   1. **Per-model least squares.** Each candidate class f(n) is fit as
 *      `t ≈ a·f(n) + b` (a ≥ 0 — time can't *decrease* with input, and b absorbs
 *      fixed per-call overhead). The coefficient of determination R² ranks them.
 *
 *   2. **The log–log slope.** A power law `t ≈ c·nᵖ` is a straight line of slope p
 *      on log–log axes, so the slope of `log t` against `log n` is an empirical
 *      estimate of the polynomial exponent — ~1 for linear, ~2 for quadratic, ~0
 *      for logarithmic/constant. It's the single most intuitive number, and it's
 *      robust to the per-model intercept.
 *
 * Everything here is pure and dependency-free so it can be unit-tested in Node
 * against synthetic curves (see the validation harness).
 */

export type ClassId =
  | "const"
  | "log"
  | "linear"
  | "linearithmic"
  | "quadratic"
  | "cubic"
  | "exp";

export interface ComplexityModel {
  id: ClassId;
  /** Big-O label, e.g. "O(n log n)". */
  label: string;
  /** A short plain-language name. */
  name: string;
  /** The growth function f(n). */
  f: (n: number) => number;
  /** Ordering for "faster/slower than target" comparisons. */
  rank: number;
}

export const MODELS: ComplexityModel[] = [
  { id: "const", label: "O(1)", name: "constant", rank: 0, f: () => 1 },
  { id: "log", label: "O(log n)", name: "logarithmic", rank: 1, f: (n) => Math.log2(Math.max(2, n)) },
  { id: "linear", label: "O(n)", name: "linear", rank: 2, f: (n) => n },
  {
    id: "linearithmic",
    label: "O(n log n)",
    name: "linearithmic",
    rank: 3,
    f: (n) => n * Math.log2(Math.max(2, n)),
  },
  { id: "quadratic", label: "O(n²)", name: "quadratic", rank: 4, f: (n) => n * n },
  { id: "cubic", label: "O(n³)", name: "cubic", rank: 5, f: (n) => n * n * n },
  { id: "exp", label: "O(2ⁿ)", name: "exponential", rank: 6, f: (n) => Math.pow(2, n) },
];

export function modelOf(id: ClassId): ComplexityModel {
  const m = MODELS.find((x) => x.id === id);
  if (!m) throw new Error(`unknown complexity class: ${id}`);
  return m;
}

export interface Sample {
  n: number;
  /** measured representative per-call time (any consistent time unit) */
  t: number;
}

export interface Fit {
  id: ClassId;
  /** slope coefficient (≥ 0) */
  a: number;
  /** intercept — fixed per-call overhead */
  b: number;
  /** coefficient of determination in [−∞, 1]; higher is better */
  r2: number;
  /** false when the model can't be evaluated over these n (e.g. 2ⁿ overflow) */
  ok: boolean;
}

/**
 * Fit `t ≈ a·f(n) + b` by ordinary least squares with the constraint a ≥ 0.
 * If unconstrained OLS wants a negative slope (time falling as the model grows),
 * the model is a bad explanation, so we clamp to the best flat fit (a = 0).
 */
export function fitModel(samples: Sample[], model: ComplexityModel): Fit {
  const xs = samples.map((s) => model.f(s.n));
  const ys = samples.map((s) => s.t);
  if (xs.some((x) => !Number.isFinite(x))) {
    return { id: model.id, a: 0, b: 0, r2: -Infinity, ok: false };
  }
  const k = xs.length;
  const meanX = xs.reduce((p, c) => p + c, 0) / k;
  const meanY = ys.reduce((p, c) => p + c, 0) / k;
  let sxx = 0;
  let sxy = 0;
  for (let i = 0; i < k; i++) {
    sxx += (xs[i] - meanX) * (xs[i] - meanX);
    sxy += (xs[i] - meanX) * (ys[i] - meanY);
  }

  let a: number;
  let b: number;
  if (sxx <= 1e-12) {
    // f is (effectively) constant over the sampled n — only an intercept is identifiable.
    a = 0;
    b = meanY;
  } else {
    a = sxy / sxx;
    if (a < 0) {
      a = 0;
      b = meanY;
    } else {
      b = meanY - a * meanX;
    }
  }

  let sse = 0;
  let sst = 0;
  for (let i = 0; i < k; i++) {
    const pred = a * xs[i] + b;
    sse += (ys[i] - pred) * (ys[i] - pred);
    sst += (ys[i] - meanY) * (ys[i] - meanY);
  }
  const r2 = sst <= 1e-30 ? (sse <= 1e-30 ? 1 : 0) : 1 - sse / sst;
  return { id: model.id, a, b, r2, ok: true };
}

/**
 * Theil–Sen estimate of the log–log slope: the median of the slopes of every
 * pair of points. Unlike ordinary least squares it shrugs off a handful of
 * outliers — exactly what real timings produce, where a few large-n points get
 * inflated by garbage-collection pauses on allocation-heavy O(n) code. This is
 * the profiler's backbone for picking a polynomial degree.
 */
export function theilSenSlope(samples: Sample[]): number {
  const pts = samples
    .filter((s) => s.n > 1 && s.t > 0)
    .map((s) => ({ x: Math.log(s.n), y: Math.log(s.t) }));
  if (pts.length < 2) return NaN;
  const slopes: number[] = [];
  for (let i = 0; i < pts.length; i++) {
    for (let j = i + 1; j < pts.length; j++) {
      const dx = pts[j].x - pts[i].x;
      if (Math.abs(dx) < 1e-9) continue;
      slopes.push((pts[j].y - pts[i].y) / dx);
    }
  }
  if (!slopes.length) return NaN;
  slopes.sort((a, b) => a - b);
  const m = slopes.length;
  return m % 2 ? slopes[(m - 1) / 2] : (slopes[m / 2 - 1] + slopes[m / 2]) / 2;
}

/** Least-squares slope and R² of `log t` regressed on `log n` (the power-law exponent). */
export function logLogSlope(samples: Sample[]): { slope: number; r2: number } {
  const pts = samples.filter((s) => s.n > 1 && s.t > 0);
  if (pts.length < 2) return { slope: NaN, r2: 0 };
  const lx = pts.map((s) => Math.log(s.n));
  const ly = pts.map((s) => Math.log(s.t));
  const k = lx.length;
  const mx = lx.reduce((p, c) => p + c, 0) / k;
  const my = ly.reduce((p, c) => p + c, 0) / k;
  let sxx = 0;
  let sxy = 0;
  let syy = 0;
  for (let i = 0; i < k; i++) {
    sxx += (lx[i] - mx) * (lx[i] - mx);
    sxy += (lx[i] - mx) * (ly[i] - my);
    syy += (ly[i] - my) * (ly[i] - my);
  }
  const slope = sxx <= 1e-12 ? NaN : sxy / sxx;
  const r2 = sxx <= 1e-12 || syy <= 1e-12 ? 0 : (sxy * sxy) / (sxx * syy);
  return { slope, r2 };
}

export interface Classification {
  /** all evaluable model fits, sorted best R² first */
  fits: Fit[];
  /** the chosen model's fit — the headline answer (also the curve to draw) */
  best: Fit | null;
  /** runner-up by R² (for "could also be…") */
  second: Fit | null;
  /** robust empirical power-law exponent (Theil–Sen log–log slope) */
  slope: number;
  /** R² of the ordinary-least-squares power-law fit (how power-law-like it is) */
  slopeR2: number;
  /** number of (n,t) points used */
  points: number;
  /** how cleanly the winner separates from the runner-up: bestR² − secondR² */
  margin: number;
}

const byId = (fits: Fit[], id: ClassId): Fit | undefined => fits.find((f) => f.id === id);

/** Pick whichever of the listed (evaluable) classes fits best, preferring the
 *  simpler one when their R² is within a whisker — Occam over noise. */
function pickBest(fits: Fit[], ids: ClassId[]): Fit | null {
  const cands = ids.map((id) => byId(fits, id)).filter((f): f is Fit => !!f);
  if (!cands.length) return null;
  const top = cands.reduce((a, b) => (b.r2 > a.r2 ? b : a));
  const within = cands
    .filter((f) => f.r2 >= top.r2 - 0.012)
    .sort((a, b) => modelOf(a.id).rank - modelOf(b.id).rank);
  return within[0] ?? top;
}

/**
 * Classify a measurement series.
 *
 * The robust log–log slope chooses a *band* of plausible growth classes (so the
 * brittle linear-vs-quadratic boundary is never decided by a single number),
 * and within that band the best-fitting model wins, ties broken toward the
 * simpler class. Models that over/underflow on the sampled n (notably 2ⁿ on
 * large n) are excluded automatically.
 */
export function classify(samples: Sample[]): Classification {
  const clean = samples.filter((s) => Number.isFinite(s.n) && Number.isFinite(s.t) && s.t >= 0);
  const fits = MODELS.map((m) => fitModel(clean, m))
    .filter((fit) => fit.ok && Number.isFinite(fit.r2))
    .sort((p, q) => q.r2 - p.r2);
  const slope = theilSenSlope(clean);
  const power = logLogSlope(clean);

  let chosen: Fit | null = null;
  if (fits.length && Number.isFinite(slope)) {
    const expFit = byId(fits, "exp");
    const logFit = byId(fits, "log");
    if (slope >= 3.6 && expFit) {
      chosen = expFit;
    } else if (slope < 0.4) {
      // sub-linear: constant vs logarithmic. Call it log only if it genuinely climbs.
      chosen = logFit && logFit.r2 > 0.85 && slope > 0.03 ? logFit : (byId(fits, "const") ?? logFit ?? fits[0]);
    } else if (slope < 1.4) {
      chosen = pickBest(fits, ["linear", "linearithmic"]);
    } else if (slope < 1.8) {
      chosen = pickBest(fits, ["linearithmic", "quadratic"]);
    } else if (slope < 2.6) {
      chosen = pickBest(fits, ["quadratic", "linearithmic"]);
    } else if (slope < 3.6) {
      chosen = pickBest(fits, ["cubic", "quadratic"]);
    } else {
      chosen = pickBest(fits, ["cubic", "quadratic"]);
    }
  } else {
    chosen = fits[0] ?? null;
  }

  const second =
    fits.find((f) => f.id !== chosen?.id) ?? null;
  return {
    fits,
    best: chosen,
    second,
    slope,
    slopeR2: power.r2,
    points: clean.length,
    margin: chosen && second ? chosen.r2 - second.r2 : chosen ? 1 : 0,
  };
}

/** Two classes are "adjacent" when only a logarithmic factor separates them. */
function adjacent(a: ClassId, b: ClassId): boolean {
  const pair = new Set([a, b]);
  const adj: ClassId[][] = [
    ["const", "log"],
    ["linear", "linearithmic"],
  ];
  return adj.some((p) => pair.has(p[0]) && pair.has(p[1]));
}

export type Verdict = "match" | "close" | "slower" | "faster" | "unknown";

export interface TargetComparison {
  verdict: Verdict;
  /** headline shown in the banner */
  headline: string;
  /** one-sentence explanation */
  detail: string;
}

/**
 * Compare the measured class against the challenge's stated optimal class and
 * phrase a verdict. The language is deliberately hedged ("appears to") — this is
 * an empirical estimate from timings, not a proof.
 */
export function compareToTarget(
  measured: ClassId | null,
  target: ClassId | null,
): TargetComparison {
  if (!measured) {
    return {
      verdict: "unknown",
      headline: "Not enough signal",
      detail: "Couldn't gather enough clean timing points to estimate a growth rate.",
    };
  }
  const mModel = modelOf(measured);
  if (!target) {
    return {
      verdict: "unknown",
      headline: `Looks like ${mModel.label}`,
      detail: "No target complexity is recorded for this problem to compare against.",
    };
  }
  const tModel = modelOf(target);
  if (measured === target) {
    return {
      verdict: "match",
      headline: `Optimal — ${mModel.label}`,
      detail: `Your solution scales like ${mModel.label}, matching the best known complexity for this problem.`,
    };
  }
  if (adjacent(measured, target)) {
    return {
      verdict: "close",
      headline: `On target — ${mModel.label}`,
      detail: `Measured ${mModel.label} versus a target of ${tModel.label}; these differ only by a logarithmic factor that's hard to separate empirically, so you're effectively on the optimal curve.`,
    };
  }
  if (mModel.rank > tModel.rank) {
    return {
      verdict: "slower",
      headline: `Slower than optimal — ${mModel.label}`,
      detail: `Your solution appears to run in ${mModel.label}, but this problem can be solved in ${tModel.label}. It likely passes the judge yet would time out at scale — look for the smarter approach.`,
    };
  }
  return {
    verdict: "faster",
    headline: `Faster than the listed ${tModel.label}`,
    detail: `Measured ${mModel.label}, below the recorded target of ${tModel.label}. The generated inputs may not trigger this problem's worst case, or the target is a loose bound.`,
  };
}
