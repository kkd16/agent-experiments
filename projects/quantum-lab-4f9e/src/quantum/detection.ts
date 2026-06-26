import { nelderMead } from './variational';

/**
 * The detection loophole, and how Eberhard closed it: CH-inequality thresholds on detector efficiency.
 *
 * Every real Bell test misses particles. If a detector fires with probability η < 1, an adversary (or
 * nature) can exploit the un-detected events: a purely LOCAL model can reproduce the observed
 * *coincidence* statistics by choosing when to "not click". So a loophole-free violation needs η above
 * a threshold. The famous facts this module computes from scratch:
 *
 *   • With the MAXIMALLY-entangled state and the symmetric CHSH/CH test, the threshold is
 *     η > 2(√2 − 1) ≈ 82.84% — punishingly high for photons.
 *   • Eberhard (1993) showed that NON-maximally-entangled states do far better: as the entanglement
 *     of |ψ(θ)⟩ = cosθ|00⟩ + sinθ|11⟩ is dialled down (θ → 0), the threshold drops all the way to
 *     η > 2/3 ≈ 66.7%. Less entanglement, more robustness — the counter-intuitive result that made
 *     the first loophole-free experiments feasible.
 *
 * The model. Use the Clauser–Horne (1974) inequality, which is LHV-bounded by 0:
 *     S_CH = p(a₁b₁) + p(a₁b₂) + p(a₂b₁) − p(a₂b₂) − p_A(a₁) − p_B(b₁) ≤ 0,
 * where p(aᵢbⱼ) is a "++" coincidence probability and p_A, p_B are single-wing "+" marginals. With a
 * symmetric efficiency η, coincidences carry η² and marginals carry η:
 *     S_CH(η) = η²·Q − η·M,   Q = ΣP(++) [signed],  M = P_A(+|a₁) + P_B(+|b₁).
 * A violation S_CH > 0 needs η > M/Q (when Q > 0), so the per-configuration threshold is η* = M/Q.
 * Minimising η* over the measurement angles at each θ traces the detection-efficiency frontier.
 */

/** The maximally-entangled CHSH/CH detection threshold 2(√2−1). */
export const CHSH_THRESHOLD = 2 * (Math.SQRT2 - 1); // ≈ 0.8284
/** Eberhard's asymptotic threshold for vanishing entanglement: 2/3. */
export const EBERHARD_LIMIT = 2 / 3; // ≈ 0.6667

// Real projective qubit measurement at plane-angle φ: "+" projector onto cos(φ/2)|0⟩ + sin(φ/2)|1⟩.
function coincidence(theta: number, al: number, be: number): number {
  const v = Math.cos(theta) * Math.cos(al / 2) * Math.cos(be / 2) + Math.sin(theta) * Math.sin(al / 2) * Math.sin(be / 2);
  return v * v;
}
function marginalA(theta: number, al: number): number {
  return Math.cos(theta) ** 2 * Math.cos(al / 2) ** 2 + Math.sin(theta) ** 2 * Math.sin(al / 2) ** 2;
}
function marginalB(theta: number, be: number): number {
  return Math.cos(theta) ** 2 * Math.cos(be / 2) ** 2 + Math.sin(theta) ** 2 * Math.sin(be / 2) ** 2;
}

/** The per-configuration efficiency threshold η* = M/Q for given state angle θ and four settings. */
export function configThreshold(theta: number, angles: number[]): number {
  const [a1, a2, b1, b2] = angles;
  const Q = coincidence(theta, a1, b1) + coincidence(theta, a1, b2) + coincidence(theta, a2, b1) - coincidence(theta, a2, b2);
  const M = marginalA(theta, a1) + marginalB(theta, b1);
  if (Q <= 1e-9) return 10; // no violation possible with these settings
  const eta = M / Q;
  return eta > 0 && eta <= 1 ? eta : 10;
}

/**
 * Minimum detector efficiency that still permits a loophole-free CH violation for |ψ(θ)⟩, found by
 * minimising η* = M/Q over the four measurement angles with a heavily multi-started Nelder–Mead.
 * Returns the threshold and the optimal settings (or null if no valid violating configuration found).
 */
export function detectionThreshold(theta: number): { eta: number; angles: number[] } | null {
  let best: { eta: number; angles: number[] } | null = null;
  const seeds: number[][] = [];
  // Random seeds.
  const rng = makeRng(Math.round(theta * 1e6) + 1);
  for (let i = 0; i < 50; i++) seeds.push([rng() * Math.PI, rng() * Math.PI, rng() * Math.PI, rng() * Math.PI]);
  // Structured + θ-scaled seeds (Eberhard's optimal "weak" settings scale with θ).
  for (const c of [1, 2, 4, 8]) for (const s of [Math.PI / 2, 2.0, 2.6, 3.0]) {
    seeds.push([c * theta, s, c * theta, s]);
    seeds.push([c * theta, s, s, c * theta]);
    seeds.push([Math.PI - c * theta, s, Math.PI - c * theta, s]);
  }
  for (const sm of [0.1, 0.3, 0.6]) for (const lg of [2.5, 2.9, 3.0]) seeds.push([sm, lg, sm, lg], [sm, lg, lg, sm], [lg, sm, sm, lg]);
  for (const x0 of seeds) {
    const res = nelderMead((x) => configThreshold(theta, x), x0, { maxIter: 800, step: Math.max(0.1, theta) });
    if (res.fx < 9.9 && (!best || res.fx < best.eta)) best = { eta: res.fx, angles: res.x };
  }
  return best;
}

function makeRng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x9e3779b9) >>> 0;
    let z = s;
    z = (z ^ (z >>> 16)) >>> 0; z = Math.imul(z, 0x21f0aaad) >>> 0;
    z = (z ^ (z >>> 15)) >>> 0; z = Math.imul(z, 0x735a2d97) >>> 0;
    z = (z ^ (z >>> 15)) >>> 0;
    return z / 4294967296;
  };
}

export interface ThresholdPoint { theta: number; entanglement: number; eta: number; }

/**
 * Sweep the state angle θ from maximally-entangled (π/4) down toward a product state, tracing the
 * detection-efficiency frontier η*(θ): it starts at 2(√2−1) and falls toward Eberhard's 2/3.
 * `entanglement` is the concurrence C = sin(2θ) of |ψ(θ)⟩ (1 = maximal, 0 = product).
 */
export function thresholdCurve(thetaMin = 0.18, steps = 22): ThresholdPoint[] {
  const out: ThresholdPoint[] = [];
  for (let i = 0; i < steps; i++) {
    const theta = Math.PI / 4 - (Math.PI / 4 - thetaMin) * (i / (steps - 1));
    const r = detectionThreshold(theta);
    if (r) out.push({ theta, entanglement: Math.sin(2 * theta), eta: r.eta });
  }
  return out;
}
