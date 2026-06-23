// Neural Ordinary Differential Equations — a continuous-depth network built on the same
// reverse-mode tensor autograd as the rest of the studio (no solver library, no autodiff
// library). The idea (Chen et al., NeurIPS 2018): instead of stacking N discrete residual
// blocks h_{k+1} = h_k + f(h_k), take the limit of infinitely many infinitesimal steps and
// let a *single* learned vector field f_θ(z, t) define the trajectory by an ODE
//
//     dz/dt = f_θ(z, t),    z(0) = x,    prediction = head(z(1)).
//
// "Depth" becomes integration time, and a numerical ODE solver (Euler / midpoint / RK4)
// replaces the layer stack. Because every solver step is built out of the engine's own
// tape ops (matmul / add / scale / activation), back-propagating *through the solver* gives
// exact gradients of the discrete loss — gradchecked end-to-end in the self-test.
//
// Two extra ideas ride along:
//   • The **adjoint method** (`adjointDynamicsGrad`) — the O(1)-memory gradient of the
//     continuous problem, integrating a second ("adjoint") ODE backwards in time. It is a
//     genuinely different computation from back-prop-through-the-solver, and the lab shows
//     the two agree to the solver's truncation error.
//   • **Augmented Neural ODEs** (Dupont et al., 2019) — lift the state with a few extra zero
//     channels so trajectories can move through the added dimensions. A plane-bound (2-D)
//     ODE flow is a homeomorphism and *cannot* unlink concentric rings without crossing
//     trajectories; one augmenting channel makes the task trivially separable. The lab makes
//     that failure-then-fix visible.

import { Tensor } from './tensor';
import { applyActivation, type Activation } from './nn';
import { softmaxCrossEntropy } from './losses';
import { makeClassDataset, type ClassDatasetKind, type ClassDataset } from './data';

export type Solver = 'euler' | 'midpoint' | 'rk4';

export const SOLVERS: { id: Solver; label: string; order: number; nfe: number }[] = [
  { id: 'euler', label: 'Euler', order: 1, nfe: 1 },
  { id: 'midpoint', label: 'Midpoint (RK2)', order: 2, nfe: 2 },
  { id: 'rk4', label: 'Runge–Kutta 4', order: 4, nfe: 4 },
];

export interface ODEArch {
  hidden: number; // width of the dynamics MLP
  depth: number; // number of hidden layers in the dynamics MLP (>= 1)
  activation: Activation;
  augDim: number; // extra augmenting channels (Augmented Neural ODE); 0 = vanilla
}

// ---- the learned vector field f_θ(z, t) -------------------------------------------------
//
// A small MLP from the (augmented) state z ∈ R^D to a velocity dz/dt ∈ R^D. Time enters as
// an additive bias at the first layer (a learned `tw` row scaled by the scalar t), which is
// enough to make the field non-autonomous without a concat op. The output layer is
// initialised small so the initial flow is gentle (near-identity), which keeps the solver
// well-behaved from step zero.
export class ODEFunc {
  readonly D: number;
  readonly H: number;
  readonly depth: number;
  readonly act: Activation;
  readonly W: Tensor[]; // per-layer weights; W[0] is [D,H], rest [H,H]
  readonly b: Tensor[]; // per-layer bias [1,H]
  readonly tw: Tensor; // time-injection row [1,H] at layer 0
  readonly Wout: Tensor; // [H,D]
  readonly bout: Tensor; // [1,D]

  constructor(D: number, arch: ODEArch, rng: () => number) {
    this.D = D;
    this.H = arch.hidden;
    this.depth = Math.max(1, arch.depth);
    this.act = arch.activation;
    const heLike =
      arch.activation === 'relu' ||
      arch.activation === 'leaky_relu' ||
      arch.activation === 'elu' ||
      arch.activation === 'gelu' ||
      arch.activation === 'silu';
    const randn = () => {
      let u = 0;
      let v = 0;
      while (u === 0) u = rng();
      while (v === 0) v = rng();
      return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
    };
    const dense = (inF: number, outF: number, scale: number, label: string): Tensor => {
      const gain = (heLike ? Math.sqrt(2 / inF) : Math.sqrt(1 / inF)) * scale;
      const w = new Float64Array(inF * outF);
      for (let i = 0; i < w.length; i++) w[i] = randn() * gain;
      return Tensor.fromFlat(w, inF, outF, true).named(label);
    };

    this.W = [];
    this.b = [];
    this.W.push(dense(D, this.H, 1, 'W0'));
    this.b.push(Tensor.zeros(1, this.H, true).named('b0'));
    for (let i = 1; i < this.depth; i++) {
      this.W.push(dense(this.H, this.H, 1, `W${i}`));
      this.b.push(Tensor.zeros(1, this.H, true).named(`b${i}`));
    }
    const tw = new Float64Array(this.H);
    for (let i = 0; i < this.H; i++) tw[i] = randn() * 0.1;
    this.tw = Tensor.fromFlat(tw, 1, this.H, true).named('tw');
    // Small output init → gentle initial dynamics.
    this.Wout = dense(this.H, D, 0.1, 'Wout');
    this.bout = Tensor.zeros(1, D, true).named('bout');
  }

  // Tape forward: z [N,D], scalar t → velocity [N,D], recording backward closures.
  forward(z: Tensor, t: number): Tensor {
    let h = z.matmul(this.W[0]).add(this.b[0]).add(this.tw.scale(t));
    h = applyActivation(h, this.act);
    for (let i = 1; i < this.depth; i++) {
      h = applyActivation(h.matmul(this.W[i]).add(this.b[i]), this.act);
    }
    return h.matmul(this.Wout).add(this.bout);
  }

  // Tape-free forward over a packed [N*D] buffer — used by the (throttled but heavy) live
  // visualisations (decision grid, trajectories, vector field) so they never build a graph.
  evalRaw(z: Float64Array, N: number, t: number): Float64Array {
    const D = this.D;
    const H = this.H;
    let cur = new Float64Array(N * H);
    // layer 0 with time injection
    const W0 = this.W[0].data;
    const b0 = this.b[0].data;
    const tw = this.tw.data;
    for (let n = 0; n < N; n++) {
      const zr = n * D;
      const cr = n * H;
      for (let j = 0; j < H; j++) {
        let s = b0[j] + tw[j] * t;
        for (let k = 0; k < D; k++) s += z[zr + k] * W0[k * H + j];
        cur[cr + j] = act1(s, this.act);
      }
    }
    // hidden layers
    for (let li = 1; li < this.depth; li++) {
      const W = this.W[li].data;
      const b = this.b[li].data;
      const next = new Float64Array(N * H);
      for (let n = 0; n < N; n++) {
        const ir = n * H;
        for (let j = 0; j < H; j++) {
          let s = b[j];
          for (let k = 0; k < H; k++) s += cur[ir + k] * W[k * H + j];
          next[ir + j] = act1(s, this.act);
        }
      }
      cur = next;
    }
    // output
    const Wo = this.Wout.data;
    const bo = this.bout.data;
    const out = new Float64Array(N * D);
    for (let n = 0; n < N; n++) {
      const ir = n * H;
      const or = n * D;
      for (let j = 0; j < D; j++) {
        let s = bo[j];
        for (let k = 0; k < H; k++) s += cur[ir + k] * Wo[k * D + j];
        out[or + j] = s;
      }
    }
    return out;
  }

  parameters(): Tensor[] {
    const ps: Tensor[] = [];
    for (let i = 0; i < this.W.length; i++) ps.push(this.W[i], this.b[i]);
    ps.push(this.tw, this.Wout, this.bout);
    return ps;
  }
}

// Scalar activation matching the engine's tape ops, for the tape-free path.
function act1(x: number, act: Activation): number {
  switch (act) {
    case 'relu':
      return x > 0 ? x : 0;
    case 'leaky_relu':
      return x > 0 ? x : 0.01 * x;
    case 'elu':
      return x > 0 ? x : Math.exp(x) - 1;
    case 'gelu': {
      const c = Math.sqrt(2 / Math.PI);
      return 0.5 * x * (1 + Math.tanh(c * (x + 0.044715 * x * x * x)));
    }
    case 'silu':
      return x / (1 + Math.exp(-x));
    case 'softplus':
      return x > 30 ? x : x < -30 ? Math.exp(x) : Math.log1p(Math.exp(x));
    case 'tanh':
      return Math.tanh(x);
    case 'sigmoid':
      return 1 / (1 + Math.exp(-x));
    case 'linear':
      return x;
  }
}

// ---- solvers (tape) ---------------------------------------------------------------------

// One integrator step on the tape. h may be any sign (the adjoint integrates backwards).
function solverStep(func: ODEFunc, z: Tensor, t: number, h: number, solver: Solver): Tensor {
  if (solver === 'euler') {
    return z.add(func.forward(z, t).scale(h));
  }
  if (solver === 'midpoint') {
    const k1 = func.forward(z, t);
    const k2 = func.forward(z.add(k1.scale(h / 2)), t + h / 2);
    return z.add(k2.scale(h));
  }
  // classic RK4
  const k1 = func.forward(z, t);
  const k2 = func.forward(z.add(k1.scale(h / 2)), t + h / 2);
  const k3 = func.forward(z.add(k2.scale(h / 2)), t + h / 2);
  const k4 = func.forward(z.add(k3.scale(h)), t + h);
  const incr = k1
    .add(k2.scale(2))
    .add(k3.scale(2))
    .add(k4)
    .scale(h / 6);
  return z.add(incr);
}

// Integrate z0 from t0 to t1 in `steps` equal steps, returning the final state (on the tape).
export function odeIntegrate(
  func: ODEFunc,
  z0: Tensor,
  steps: number,
  t0: number,
  t1: number,
  solver: Solver,
): Tensor {
  const h = (t1 - t0) / steps;
  let z = z0;
  for (let i = 0; i < steps; i++) z = solverStep(func, z, t0 + i * h, h, solver);
  return z;
}

// ---- solvers (tape-free, with trajectory capture) ---------------------------------------

// One tape-free step over packed buffers.
function rawStep(func: ODEFunc, z: Float64Array, N: number, t: number, h: number, solver: Solver): Float64Array {
  const D = func.D;
  const n = z.length;
  const out = new Float64Array(n);
  if (solver === 'euler') {
    const k1 = func.evalRaw(z, N, t);
    for (let i = 0; i < n; i++) out[i] = z[i] + h * k1[i];
    return out;
  }
  if (solver === 'midpoint') {
    const k1 = func.evalRaw(z, N, t);
    const zmid = new Float64Array(n);
    for (let i = 0; i < n; i++) zmid[i] = z[i] + (h / 2) * k1[i];
    const k2 = func.evalRaw(zmid, N, t + h / 2);
    for (let i = 0; i < n; i++) out[i] = z[i] + h * k2[i];
    return out;
  }
  const k1 = func.evalRaw(z, N, t);
  const tmp = new Float64Array(n);
  for (let i = 0; i < n; i++) tmp[i] = z[i] + (h / 2) * k1[i];
  const k2 = func.evalRaw(tmp, N, t + h / 2);
  for (let i = 0; i < n; i++) tmp[i] = z[i] + (h / 2) * k2[i];
  const k3 = func.evalRaw(tmp, N, t + h / 2);
  for (let i = 0; i < n; i++) tmp[i] = z[i] + h * k3[i];
  const k4 = func.evalRaw(tmp, N, t + h);
  for (let i = 0; i < n; i++) out[i] = z[i] + (h / 6) * (k1[i] + 2 * k2[i] + 2 * k3[i] + k4[i]);
  void D;
  return out;
}

// Integrate a packed [N*D] buffer, returning every intermediate frame (steps+1 of them) so a
// UI scrubber can play the continuous transformation back. Tape-free → cheap enough to run
// the whole decision grid each redraw.
export function odeIntegrateRawTrace(
  func: ODEFunc,
  z0: Float64Array,
  N: number,
  steps: number,
  t0: number,
  t1: number,
  solver: Solver,
): Float64Array[] {
  const h = (t1 - t0) / steps;
  const frames: Float64Array[] = [z0.slice()];
  let z = z0;
  for (let i = 0; i < steps; i++) {
    z = rawStep(func, z, N, t0 + i * h, h, solver);
    frames.push(z);
  }
  return frames;
}

// ---- the continuous-depth classifier ----------------------------------------------------

export interface NeuralODEConfig {
  inDim: number; // input feature dim (2 for the plane)
  classes: number;
  arch: ODEArch;
  solver: Solver;
  steps: number;
  t0: number;
  t1: number;
}

export class NeuralODE {
  readonly cfg: NeuralODEConfig;
  readonly D: number; // augmented state dim = inDim + augDim
  readonly func: ODEFunc;
  readonly headW: Tensor; // [D, classes]
  readonly headB: Tensor; // [1, classes]

  constructor(cfg: NeuralODEConfig, rng: () => number) {
    this.cfg = cfg;
    this.D = cfg.inDim + cfg.arch.augDim;
    this.func = new ODEFunc(this.D, cfg.arch, rng);
    const gain = Math.sqrt(1 / this.D);
    const randn = () => {
      let u = 0;
      let v = 0;
      while (u === 0) u = rng();
      while (v === 0) v = rng();
      return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
    };
    const w = new Float64Array(this.D * cfg.classes);
    for (let i = 0; i < w.length; i++) w[i] = randn() * gain;
    this.headW = Tensor.fromFlat(w, this.D, cfg.classes, true).named('headW');
    this.headB = Tensor.zeros(1, cfg.classes, true).named('headB');
  }

  // Lift a plane input [N, inDim] into the augmented state [N, D] by zero-padding the extra
  // channels. The lifted tensor is a leaf (we never need a gradient w.r.t. the input itself).
  lift(x: Tensor): Tensor {
    const N = x.rows;
    const D = this.D;
    const data = new Float64Array(N * D);
    for (let n = 0; n < N; n++) {
      for (let j = 0; j < this.cfg.inDim; j++) data[n * D + j] = x.data[n * x.cols + j];
    }
    return Tensor.fromFlat(data, N, D, false);
  }

  // Integrate the input through the vector field to the terminal state z(t1) (on the tape).
  flow(x: Tensor): Tensor {
    return odeIntegrate(this.func, this.lift(x), this.cfg.steps, this.cfg.t0, this.cfg.t1, this.cfg.solver);
  }

  // Logits = head(z(t1)).
  forward(x: Tensor): Tensor {
    return this.flow(x).matmul(this.headW).add(this.headB);
  }

  parameters(): Tensor[] {
    return [...this.func.parameters(), this.headW, this.headB];
  }

  paramCount(): number {
    let n = 0;
    for (const p of this.parameters()) n += p.size;
    return n;
  }

  exportWeights(): number[] {
    const out: number[] = [];
    for (const p of this.parameters()) for (let i = 0; i < p.size; i++) out.push(p.data[i]);
    return out;
  }

  importWeights(flat: number[]): boolean {
    const ps = this.parameters();
    let total = 0;
    for (const p of ps) total += p.size;
    if (flat.length !== total) return false;
    let k = 0;
    for (const p of ps) for (let i = 0; i < p.size; i++) p.data[i] = flat[k++];
    return true;
  }

  // ---- tape-free inference helpers (for the live views) --------------------------------

  // Classify a packed [N*inDim] plane buffer: returns argmax class + the winning softmax
  // probability per point, computed without touching the tape.
  classifyRaw(xy: Float64Array, N: number): { cls: Int32Array; conf: Float64Array } {
    const D = this.D;
    const z0 = new Float64Array(N * D);
    for (let n = 0; n < N; n++) for (let j = 0; j < this.cfg.inDim; j++) z0[n * D + j] = xy[n * this.cfg.inDim + j];
    const frames = odeIntegrateRawTrace(this.func, z0, N, this.cfg.steps, this.cfg.t0, this.cfg.t1, this.cfg.solver);
    const zT = frames[frames.length - 1];
    return this.headRaw(zT, N);
  }

  // Integrate an already-augmented packed buffer [N*D] through the solver, returning every
  // intermediate frame (frames+1 of them) — drives the trajectory scrubber / lift view.
  traceRaw(z0: Float64Array, N: number, frames: number): Float64Array[] {
    return odeIntegrateRawTrace(this.func, z0, N, frames, this.cfg.t0, this.cfg.t1, this.cfg.solver);
  }

  // Apply the linear head + softmax to a packed terminal state [N*D].
  headRaw(zT: Float64Array, N: number): { cls: Int32Array; conf: Float64Array } {
    const D = this.D;
    const K = this.cfg.classes;
    const W = this.headW.data;
    const b = this.headB.data;
    const cls = new Int32Array(N);
    const conf = new Float64Array(N);
    for (let n = 0; n < N; n++) {
      let best = -Infinity;
      let arg = 0;
      let max = -Infinity;
      const logits = new Float64Array(K);
      for (let c = 0; c < K; c++) {
        let s = b[c];
        for (let k = 0; k < D; k++) s += zT[n * D + k] * W[k * K + c];
        logits[c] = s;
        if (s > max) max = s;
        if (s > best) {
          best = s;
          arg = c;
        }
      }
      let sum = 0;
      for (let c = 0; c < K; c++) sum += Math.exp(logits[c] - max);
      cls[n] = arg;
      conf[n] = Math.exp(best - max) / sum;
    }
    return { cls, conf };
  }
}

// ---- the adjoint method -----------------------------------------------------------------

// Gradient of a scalar loss w.r.t. the *dynamics* parameters, via the continuous adjoint
// (Pontryagin). We never store the forward activations: we re-derive z(t) by integrating the
// state ODE backwards alongside the adjoint, the O(1)-memory trick that makes Neural ODEs
// scale. The vector–Jacobian products a^T ∂f/∂z and a^T ∂f/∂θ are taken with the engine's own
// reverse mode (build f on a fresh tape, seed the output grad with a, back-propagate).
//
// Inputs: the terminal state z1 [N,D] (as plain data), and aT = ∂L/∂z1 [N,D] (the adjoint at
// t1, obtained by back-propagating the head + loss). Returns flat gradients aligned with
// `func.parameters()`, plus the recovered initial adjoint a(t0) (= ∂L/∂z0) for diagnostics.
export function adjointDynamicsGrad(
  func: ODEFunc,
  z1: Float64Array,
  aT: Float64Array,
  N: number,
  steps: number,
  t0: number,
  t1: number,
  solver: Solver,
): { paramGrads: Float64Array[]; a0: Float64Array } {
  const D = func.D;
  const params = func.parameters();
  const paramGrads = params.map((p) => new Float64Array(p.size));

  // The augmented backward state is (z, a). We also accumulate ∫ a^T ∂f/∂θ dt into paramGrads.
  let z: Float64Array = z1.slice();
  let a: Float64Array = aT.slice();
  const h = (t1 - t0) / steps; // positive; we step with -h

  // Evaluate the augmented dynamics at time t given (z, a):
  //   dz/dt = f(z, t)
  //   da/dt = -(∂f/∂z)^T a
  //   dθ/dt += -(∂f/∂θ)^T a   (accumulated into `acc`, scaled by the RK weight)
  // Returns {fz, faz} where faz = -(∂f/∂z)^T a, and writes the parameter VJP into `acc`.
  const augEval = (
    zBuf: Float64Array,
    aBuf: Float64Array,
    t: number,
    acc: Float64Array[] | null,
    weight: number,
  ): { fz: Float64Array; fa: Float64Array } => {
    const zt = Tensor.fromFlat(zBuf.slice(), N, D, true);
    const fOut = func.forward(zt, t);
    // seed grad with a → fOut.grad = a, then backward gives zt.grad = (∂f/∂z)^T a and
    // param.grad = (∂f/∂θ)^T a.
    const topoBackward = () => {
      // replicate Tensor.backward but seed with aBuf instead of ones.
      const topo: Tensor[] = [];
      const seen = new Set<number>();
      const build = (tt: Tensor) => {
        if (seen.has(tt.id)) return;
        seen.add(tt.id);
        for (const p of tt.prev) build(p);
        topo.push(tt);
      };
      build(fOut);
      for (const tt of topo) tt.grad.fill(0);
      fOut.grad.set(aBuf);
      for (let i = topo.length - 1; i >= 0; i--) {
        const fn = topo[i].backwardFn;
        if (fn) fn();
      }
    };
    topoBackward();
    const fz = fOut.data.slice(); // f(z,t)
    const fa = new Float64Array(N * D); // -(∂f/∂z)^T a
    for (let i = 0; i < N * D; i++) fa[i] = -zt.grad[i];
    if (acc) {
      for (let pi = 0; pi < params.length; pi++) {
        const g = params[pi].grad;
        const dst = acc[pi];
        // dθ/dt = -(∂f/∂θ)^T a ; integrating ∫_{t1}^{t0}(dθ/dt)dτ over a step of size -h adds
        // (-h)*weight*(-(∂f/∂θ)^T a) = h*weight*(∂f/∂θ)^T a.
        for (let i = 0; i < g.length; i++) dst[i] += h * weight * g[i];
      }
    }
    return { fz, fa };
  };

  for (let s = 0; s < steps; s++) {
    const t = t1 - s * h;
    // RK4 over the augmented system, stepping by -h. Parameter VJPs are accumulated with the
    // RK4 weights (1,2,2,1)/6 at the matching stage states/times.
    if (solver === 'rk4') {
      const s1 = augEval(z, a, t, paramGrads, 1 / 6);
      const z2 = step(z, s1.fz, -h / 2);
      const a2 = step(a, s1.fa, -h / 2);
      const s2 = augEval(z2, a2, t - h / 2, paramGrads, 2 / 6);
      const z3 = step(z, s2.fz, -h / 2);
      const a3 = step(a, s2.fa, -h / 2);
      const s3 = augEval(z3, a3, t - h / 2, paramGrads, 2 / 6);
      const z4 = step(z, s3.fz, -h);
      const a4 = step(a, s3.fa, -h);
      const s4 = augEval(z4, a4, t - h, paramGrads, 1 / 6);
      z = rk4Combine(z, s1.fz, s2.fz, s3.fz, s4.fz, -h);
      a = rk4Combine(a, s1.fa, s2.fa, s3.fa, s4.fa, -h);
    } else if (solver === 'midpoint') {
      const s1 = augEval(z, a, t, null, 0);
      const z2 = step(z, s1.fz, -h / 2);
      const a2 = step(a, s1.fa, -h / 2);
      const s2 = augEval(z2, a2, t - h / 2, paramGrads, 1);
      z = step(z, s2.fz, -h);
      a = step(a, s2.fa, -h);
    } else {
      const s1 = augEval(z, a, t, paramGrads, 1);
      z = step(z, s1.fz, -h);
      a = step(a, s1.fa, -h);
    }
  }
  return { paramGrads, a0: a };
}

function step(x: Float64Array, d: Float64Array, h: number): Float64Array {
  const out = new Float64Array(x.length);
  for (let i = 0; i < x.length; i++) out[i] = x[i] + h * d[i];
  return out;
}

function rk4Combine(x: Float64Array, k1: Float64Array, k2: Float64Array, k3: Float64Array, k4: Float64Array, h: number): Float64Array {
  const out = new Float64Array(x.length);
  for (let i = 0; i < x.length; i++) out[i] = x[i] + (h / 6) * (k1[i] + 2 * k2[i] + 2 * k3[i] + k4[i]);
  return out;
}

// Convenience: compute ∂L/∂z1 for the softmax-CE classification loss by back-propagating the
// head + loss only (z1 treated as a leaf). Returns the adjoint seed aT and the loss value.
export function terminalAdjointCE(model: NeuralODE, z1: Tensor, targets: Int32Array): { aT: Float64Array; loss: number } {
  const z = Tensor.fromFlat(z1.data.slice(), z1.rows, z1.cols, true);
  const logits = z.matmul(model.headW).add(model.headB);
  const { loss } = softmaxCrossEntropy(logits, targets);
  loss.backward();
  return { aT: z.grad.slice(), loss: loss.data[0] };
}

// ---- datasets ---------------------------------------------------------------------------

// The lab reuses the playground's labelled 2-D classification sets. Concentric circles / ring
// are the headline: a vanilla 2-D ODE cannot separate them (topology), augmentation can.
export const NODE_DATASETS: { id: ClassDatasetKind; label: string }[] = [
  { id: 'circles', label: 'Concentric circles' },
  { id: 'moons', label: 'Two moons' },
  { id: 'two-spirals', label: 'Two spirals' },
  { id: 'ring', label: 'Ring + blob' },
  { id: 'xor', label: 'XOR' },
  { id: 'checkerboard', label: 'Checkerboard' },
  { id: 'spiral', label: 'Spiral (3 classes)' },
  { id: 'gaussians', label: 'Gaussians (4)' },
];

export function makeNodeDataset(kind: ClassDatasetKind, n: number, noise: number, seed: number): ClassDataset {
  return makeClassDataset(kind, n, noise, seed);
}
