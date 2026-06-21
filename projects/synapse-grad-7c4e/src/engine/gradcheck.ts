import { Tensor } from './tensor';

// Finite-difference gradient checking. Given a closure that builds a scalar loss from the
// current parameter values, we (1) run a real backward pass to get analytic gradients,
// then (2) perturb each parameter entry by ±eps and re-evaluate the loss to estimate the
// gradient numerically via the central difference (L(+eps) - L(-eps)) / 2eps. The maximum
// relative disagreement across all checked entries should be ~1e-6 or smaller — that is
// the proof the hand-derived backward passes are correct.

export interface GradCheckResult {
  maxRelError: number;
  meanRelError: number;
  checked: number;
  worst: { layer: string; analytic: number; numeric: number };
}

export function gradCheck(
  params: Tensor[],
  lossFn: () => Tensor,
  opts: { eps?: number; samplesPerParam?: number; seed?: number } = {},
): GradCheckResult {
  const eps = opts.eps ?? 1e-5;
  const samples = opts.samplesPerParam ?? 12;
  let seed = (opts.seed ?? 12345) >>> 0;
  const rand = () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 4294967296;
  };

  // analytic gradients
  const loss = lossFn();
  loss.backward();
  const analytic = params.map((p) => p.grad.slice());

  let maxRel = 0;
  let sumRel = 0;
  let count = 0;
  let worst = { layer: '', analytic: 0, numeric: 0 };

  for (let pi = 0; pi < params.length; pi++) {
    const p = params[pi];
    const picks = Math.min(samples, p.size);
    for (let s = 0; s < picks; s++) {
      const idx = Math.floor(rand() * p.size);
      const orig = p.data[idx];

      p.data[idx] = orig + eps;
      const lp = lossFn().data[0];
      p.data[idx] = orig - eps;
      const lm = lossFn().data[0];
      p.data[idx] = orig;

      const numeric = (lp - lm) / (2 * eps);
      const a = analytic[pi][idx];
      const denom = Math.max(Math.abs(a) + Math.abs(numeric), 1e-8);
      const rel = Math.abs(a - numeric) / denom;
      sumRel += rel;
      count++;
      if (rel > maxRel) {
        maxRel = rel;
        worst = { layer: p.label || `param#${pi}`, analytic: a, numeric };
      }
    }
  }

  return {
    maxRelError: maxRel,
    meanRelError: count > 0 ? sumRel / count : 0,
    checked: count,
    worst,
  };
}
