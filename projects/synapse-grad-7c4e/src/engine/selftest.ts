// Automated engine self-test. For every op in the engine we build a small randomized
// computation graph, reduce it to a scalar with a fixed random weighting, take the analytic
// gradient via the tape, and compare it entry-by-entry against a central finite-difference
// estimate. The maximum relative disagreement for each op should be ~1e-6 — that is the
// machine-checked proof that the hand-derived backward passes are correct, surfaced in the UI.

import { Tensor } from './tensor';
import { dropout, layerNorm, batchNorm, makeBatchNormState, embedding, concatCols, stackRows, gatherCols } from './ops';
import { conv2d, maxPool2d, avgPool2d } from './conv';
import { softmaxCrossEntropy, maskedCrossEntropy, bceWithLogits, mse } from './losses';
import { GPT } from './transformer';
import { RecurrentLM, type CellKind } from './recurrent';
import { MoEGPT, scaleRows, selectCol } from './moe';
import { VAE, klDivStandardNormal } from './vae';
import { Agent, gaussianLogProb, gaussianEntropy, categoricalLogProb, categoricalEntropy } from './policy';
import {
  NoiseSchedule,
  Denoiser,
  sinusoidalTimeEmbedding,
  qSampleData,
  predictX0,
  posteriorMean,
  classifierFreeGuidance,
} from './diffusion';
import { RealNVP } from './flows';
import { GAN } from './gan';
import { GNN, buildAdj, type ConvKind } from './gnn';
import { KAN, KANLayer, makeGrid, evalSplineBasis } from './kan';
import { NeuralODE, ODEFunc, odeIntegrate, adjointDynamicsGrad, terminalAdjointCE, makeNodeDataset } from './node-ode';
import { gaussianNLL, gaussianKL, BayesLinear, BayesMLP, mixtureMoments } from './bayes';
import { perceive, NCA, ncaVisibleLoss, makeSeed, renderTarget } from './nca';

export interface OpCheck {
  name: string;
  maxRelError: number;
  meanRelError: number;
  checked: number;
}

export interface SelfTestReport {
  ops: OpCheck[];
  maxRelError: number;
  passed: boolean;
}

function rngFrom(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

// A leaf tensor of the given shape filled with values in [-1,1], nudged away from 0 so
// activation kinks (ReLU/LeakyReLU/ELU at 0) don't sit under the finite-difference window.
function leaf(rng: () => number, rows: number, cols: number, positive = false): Tensor {
  const d = new Float64Array(rows * cols);
  for (let i = 0; i < d.length; i++) {
    let v = rng() * 2 - 1;
    if (positive) v = Math.abs(v) + 0.5;
    else if (Math.abs(v) < 0.15) v += v >= 0 ? 0.15 : -0.15;
    d[i] = v;
  }
  return Tensor.fromFlat(d, rows, cols, true);
}

// Gradient-check one op. `forward` must be a pure function of the supplied input tensors'
// data (it may allocate fresh intermediates each call). We weight the output by a fixed
// random vector to form a scalar loss with non-trivial gradients everywhere.
function checkOp(
  name: string,
  inputs: Tensor[],
  forward: () => Tensor,
  rng: () => number,
  eps = 1e-5,
): OpCheck {
  const out = forward();
  const W = new Float64Array(out.size);
  for (let i = 0; i < W.length; i++) W[i] = rng() * 2 - 1;

  const scalarLoss = (o: Tensor): number => {
    let s = 0;
    for (let i = 0; i < o.size; i++) s += o.data[i] * W[i];
    return s;
  };

  // Analytic gradients: build loss = sum(out * W) through the engine and back-propagate.
  const Wt = Tensor.fromFlat(W.slice(), out.rows, out.cols, false);
  out.mul(Wt).sumAll().backward();
  const analytic = inputs.map((t) => t.grad.slice());

  let maxRel = 0;
  let sumRel = 0;
  let count = 0;
  for (let pi = 0; pi < inputs.length; pi++) {
    const p = inputs[pi];
    for (let idx = 0; idx < p.size; idx++) {
      const orig = p.data[idx];
      p.data[idx] = orig + eps;
      const lp = scalarLoss(forward());
      p.data[idx] = orig - eps;
      const lm = scalarLoss(forward());
      p.data[idx] = orig;
      const numeric = (lp - lm) / (2 * eps);
      const a = analytic[pi][idx];
      const denom = Math.max(Math.abs(a) + Math.abs(numeric), 1e-8);
      const rel = Math.abs(a - numeric) / denom;
      maxRel = Math.max(maxRel, rel);
      sumRel += rel;
      count++;
    }
  }
  return { name, maxRelError: maxRel, meanRelError: count ? sumRel / count : 0, checked: count };
}

// A *value* identity check (not a gradient check): the maximum relative disagreement between a
// list of (actual, expected) pairs. Used to prove the diffusion schedule/posterior identities,
// which are exact algebraic facts about the noise process rather than backward passes.
function relCheck(name: string, pairs: [number, number][]): OpCheck {
  let maxRel = 0;
  let sum = 0;
  for (const [a, b] of pairs) {
    const denom = Math.max(Math.abs(a) + Math.abs(b), 1e-8);
    const rel = Math.abs(a - b) / denom;
    maxRel = Math.max(maxRel, rel);
    sum += rel;
  }
  return { name, maxRelError: maxRel, meanRelError: pairs.length ? sum / pairs.length : 0, checked: pairs.length };
}

export function runSelfTest(seed = 7): SelfTestReport {
  const rng = rngFrom(seed);
  const ops: OpCheck[] = [];

  // Binary / broadcasting ops.
  {
    const a = leaf(rng, 4, 3);
    const b = leaf(rng, 3, 2);
    ops.push(checkOp('matmul', [a, b], () => a.matmul(b), rng));
  }
  {
    const x = leaf(rng, 4, 3);
    const b = leaf(rng, 1, 3);
    ops.push(checkOp('add (bias broadcast)', [x, b], () => x.add(b), rng));
  }
  {
    const x = leaf(rng, 4, 3);
    const y = leaf(rng, 4, 3);
    ops.push(checkOp('mul', [x, y], () => x.mul(y), rng));
  }
  {
    const x = leaf(rng, 4, 3);
    const y = leaf(rng, 1, 3);
    ops.push(checkOp('mul (broadcast)', [x, y], () => x.mul(y), rng));
  }
  {
    const x = leaf(rng, 4, 3);
    const y = leaf(rng, 4, 3);
    ops.push(checkOp('sub', [x, y], () => x.sub(y), rng));
  }
  {
    const x = leaf(rng, 4, 3);
    const y = leaf(rng, 4, 3, true);
    ops.push(checkOp('div', [x, y], () => x.div(y), rng));
  }

  // Unary ops.
  const unary: [string, (t: Tensor) => Tensor, boolean][] = [
    ['scale', (t) => t.scale(1.7), false],
    ['neg', (t) => t.neg(), false],
    ['exp', (t) => t.exp(), false],
    ['log', (t) => t.log(), true],
    ['pow(2.5)', (t) => t.pow(2.5), true],
    ['sumAll', (t) => t.sumAll(), false],
    ['meanAll', (t) => t.meanAll(), false],
    ['rowSum', (t) => t.rowSum(), false],
    ['transpose', (t) => t.transpose(), false],
    ['softmax', (t) => t.softmax(), false],
    ['logSoftmax', (t) => t.logSoftmax(), false],
    ['relu', (t) => t.relu(), false],
    ['tanh', (t) => t.tanh(), false],
    ['sigmoid', (t) => t.sigmoid(), false],
    ['leakyRelu', (t) => t.leakyRelu(), false],
    ['elu', (t) => t.elu(), false],
    ['gelu', (t) => t.gelu(), false],
    ['silu', (t) => t.silu(), false],
    ['softplus', (t) => t.softplus(), false],
  ];
  for (const [name, fn, positive] of unary) {
    const x = leaf(rng, 4, 3, positive);
    ops.push(checkOp(name, [x], () => fn(x), rng));
  }

  // Dropout — fixed seed so the mask is identical across forward calls.
  {
    const x = leaf(rng, 5, 4);
    ops.push(checkOp('dropout', [x], () => dropout(x, 0.5, true, rngFrom(99)), rng));
  }

  // Normalization layers (learnable gamma/beta also gradchecked).
  {
    const x = leaf(rng, 5, 4);
    const g = leaf(rng, 1, 4, true);
    const b = leaf(rng, 1, 4);
    ops.push(checkOp('layerNorm', [x, g, b], () => layerNorm(x, g, b), rng));
  }
  {
    const x = leaf(rng, 6, 4);
    const g = leaf(rng, 1, 4, true);
    const b = leaf(rng, 1, 4);
    ops.push(
      checkOp('batchNorm', [x, g, b], () => batchNorm(x, g, b, makeBatchNormState(4), true), rng),
    );
  }

  // Convolution + pooling (the vision ops). Input is gradchecked too (it is a non-trivial
  // im2col-free backward), alongside the kernel weights and bias.
  {
    const N = 2;
    const Cin = 2;
    const H = 4;
    const W = 4;
    const Cout = 3;
    const k = 3;
    const x = leaf(rng, N, Cin * H * W);
    const w = leaf(rng, Cout, Cin * k * k);
    const b = leaf(rng, 1, Cout);
    ops.push(
      checkOp(
        'conv2d',
        [x, w, b],
        () => conv2d(x, w, b, { N, Cin, H, W, Cout, kh: k, kw: k, stride: 1, pad: 1 }),
        rng,
      ),
    );
  }
  {
    const N = 2;
    const C = 2;
    const H = 4;
    const W = 4;
    // Nudge values apart so the max in each window is unambiguous (ties break finite diff).
    const x = leaf(rng, N, C * H * W);
    for (let i = 0; i < x.size; i++) x.data[i] += i * 1e-3;
    ops.push(checkOp('maxPool2d', [x], () => maxPool2d(x, { N, C, H, W, k: 2, stride: 2 }), rng));
  }
  {
    const N = 2;
    const C = 2;
    const H = 4;
    const W = 4;
    const x = leaf(rng, N, C * H * W);
    ops.push(checkOp('avgPool2d', [x], () => avgPool2d(x, { N, C, H, W, k: 2, stride: 2 }), rng));
  }

  // Transformer ops: the row-gather embedding and the multi-head concat.
  {
    const table = leaf(rng, 5, 4);
    const ids = Int32Array.from([0, 3, 1, 3, 4]); // a repeated id exercises gradient accumulation
    ops.push(checkOp('embedding', [table], () => embedding(table, ids), rng));
  }
  {
    const a = leaf(rng, 4, 2);
    const b = leaf(rng, 4, 3);
    const c = leaf(rng, 4, 2);
    ops.push(checkOp('concatCols', [a, b, c], () => concatCols([a, b, c]), rng));
  }
  {
    const logits = leaf(rng, 5, 4);
    const targets = Int32Array.from([1, 3, 0, 2, 1]);
    const keep = Uint8Array.from([0, 1, 1, 0, 1]); // only the masked rows count
    ops.push(checkOp('maskedCE', [logits], () => maskedCrossEntropy(logits, targets, keep).loss, rng));
  }

  // Reinforcement-learning op: per-row column gather (reads off the chosen action's log-prob).
  {
    const x = leaf(rng, 5, 4);
    const idx = Int32Array.from([0, 3, 1, 2, 0]);
    ops.push(checkOp('gatherCols', [x], () => gatherCols(x, idx), rng));
  }

  // End-to-end: a whole policy network through the policy-gradient objective — the clipped-free
  // REINFORCE loss −E[advantage · logπ(a|s)] minus an entropy bonus, assembled from logSoftmax,
  // gatherCols, softmax and the basic reductions. The advantage is a frozen leaf (it is a constant
  // weight in the policy-gradient estimator), so the loss is a clean function of the policy params.
  {
    const agent = new Agent(4, 3, [6], 'tanh', rngFrom(11));
    const B = 5;
    const sd = new Float64Array(B * 4);
    for (let i = 0; i < sd.length; i++) sd[i] = rng() * 2 - 1;
    const states = Tensor.fromFlat(sd, B, 4, false);
    const actions = Int32Array.from([0, 2, 1, 2, 0]);
    const advd = new Float64Array(B);
    for (let i = 0; i < B; i++) advd[i] = rng() * 2 - 1;
    const adv = Tensor.fromFlat(advd, B, 1, false);
    ops.push(
      checkOp(
        'policy-grad (e2e)',
        agent.policy.parameters(),
        () => {
          const logits = agent.policyLogits(states);
          const logp = categoricalLogProb(logits, actions);
          const pg = logp.mul(adv).meanAll().neg();
          const ent = categoricalEntropy(logits);
          return pg.add(ent.scale(-0.01));
        },
        rng,
      ),
    );
  }

  // Continuous-control ops: the diagonal-Gaussian policy's log-density (differentiated w.r.t. both
  // the mean and the shared log-σ) and its entropy (w.r.t. log-σ).
  {
    const mu = leaf(rng, 5, 2);
    const logStd = leaf(rng, 1, 2);
    const acts = leaf(rng, 5, 2);
    ops.push(checkOp('gaussianLogProb', [mu, logStd], () => gaussianLogProb(mu, logStd, acts), rng));
  }
  {
    const logStd = leaf(rng, 1, 3);
    ops.push(checkOp('gaussianEntropy', [logStd], () => gaussianEntropy(logStd), rng));
  }

  // End-to-end: a whole continuous-control policy (a diagonal-Gaussian actor) through the
  // policy-gradient objective −E[advantage · logπ(a|s)] minus an entropy bonus, assembled from
  // gaussianLogProb (sub, mul, exp, scale, rowSum) and gaussianEntropy. Both the policy MLP *and*
  // the learnable log-σ vector are gradchecked together (agent.policyParams()).
  {
    const agent = new Agent(4, 2, [6], 'tanh', rngFrom(13), true);
    const B = 5;
    const sd = new Float64Array(B * 4);
    for (let i = 0; i < sd.length; i++) sd[i] = rng() * 2 - 1;
    const states = Tensor.fromFlat(sd, B, 4, false);
    const actd = new Float64Array(B * 2);
    for (let i = 0; i < actd.length; i++) actd[i] = rng() * 2 - 1;
    const acts = Tensor.fromFlat(actd, B, 2, false);
    const advd = new Float64Array(B);
    for (let i = 0; i < B; i++) advd[i] = rng() * 2 - 1;
    const adv = Tensor.fromFlat(advd, B, 1, false);
    ops.push(
      checkOp(
        'gaussian-policy (e2e)',
        agent.policyParams(),
        () => {
          const mu = agent.policyLogits(states);
          const logp = gaussianLogProb(mu, agent.logStd!, acts);
          const pg = logp.mul(adv).meanAll().neg();
          const ent = gaussianEntropy(agent.logStd!);
          return pg.add(ent.scale(-0.01));
        },
        rng,
      ),
    );
  }

  // End-to-end: a whole tiny GPT — every parameter (embeddings, all heads' Q/K/V, the output
  // projection, both LayerNorms, the GELU feed-forward) gradchecked through the masked loss.
  {
    const gpt = new GPT({ vocab: 5, dModel: 4, nHeads: 2, nLayers: 1, dFF: 6, maxLen: 6, seed: 3 });
    const ids = Int32Array.from([2, 0, 4, 1, 3]);
    const targets = Int32Array.from([0, 4, 1, 3, 2]);
    const keep = Uint8Array.from([0, 0, 1, 1, 1]);
    ops.push(
      checkOp(
        'transformer (e2e)',
        gpt.parameters(),
        () => maskedCrossEntropy(gpt.forward(ids), targets, keep).loss,
        rng,
      ),
    );
  }

  // stackRows: glue per-timestep logit rows back into the [T,V] matrix the recurrent net trains
  // through. Reduced to a scalar against fixed random weights.
  {
    const a = leaf(rng, 1, 4);
    const b = leaf(rng, 2, 4);
    const c = leaf(rng, 1, 4);
    ops.push(checkOp('stackRows', [a, b, c], () => stackRows([a, b, c]), rng));
  }

  // End-to-end: each recurrent cell — vanilla RNN, GRU, LSTM — unrolled over a sequence and
  // gradchecked through the masked loss. This proves backprop-through-time: every gate's W/U/b,
  // the embedding and the readout, differentiated across every timestep.
  for (const cell of ['rnn', 'gru', 'lstm'] as CellKind[]) {
    const m = new RecurrentLM({ cell, vocab: 5, embDim: 4, hidden: 6, nLayers: 2, seed: 7 });
    const ids = Int32Array.from([1, 3, 0, 4, 2, 1]);
    const targets = Int32Array.from([3, 0, 4, 2, 1, 0]);
    const keep = Uint8Array.from([0, 1, 1, 0, 1, 1]);
    ops.push(
      checkOp(
        `${cell} backprop-through-time (e2e)`,
        m.parameters(),
        () => maskedCrossEntropy(m.forward(ids), targets, keep).loss,
        rng,
      ),
    );
  }

  // The two ops the sparse-MoE combine is built from: a per-row scalar scale (mix an expert's
  // whole output by its router weight) and a single-column gather (pull one expert's gate column).
  {
    const x = leaf(rng, 4, 5);
    const w = leaf(rng, 4, 1);
    ops.push(checkOp('scaleRows', [x, w], () => scaleRows(x, w), rng));
  }
  {
    const x = leaf(rng, 4, 6);
    ops.push(checkOp('selectCol', [x], () => selectCol(x, 3), rng));
  }

  // End-to-end: a whole sparse Mixture-of-Experts Transformer — every parameter (embeddings,
  // attention, the router, all E experts) gradchecked through the combined task + load-balancing
  // loss. topK = nExperts here so the top-k selection is smooth (no argmax kink under the finite
  // difference); the identical code path runs sparsely during training.
  {
    const moe = new MoEGPT({
      vocab: 5,
      dModel: 4,
      nHeads: 2,
      nLayers: 1,
      dFF: 6,
      nExperts: 3,
      topK: 3,
      maxLen: 6,
      seed: 3,
    });
    const ids = Int32Array.from([2, 0, 4, 1, 3]);
    const targets = Int32Array.from([0, 4, 1, 3, 2]);
    const keep = Uint8Array.from([0, 0, 1, 1, 1]);
    ops.push(
      checkOp(
        'moe-transformer (e2e, CE+aux)',
        moe.parameters(),
        () => {
          const logits = moe.forward(ids);
          return maskedCrossEntropy(logits, targets, keep).loss.add(moe.lastAux!);
        },
        rng,
      ),
    );
  }

  // Generative (VAE) ops: the Bernoulli reconstruction loss and the closed-form KL.
  {
    const logits = leaf(rng, 4, 3);
    const td = new Float64Array(12);
    for (let i = 0; i < td.length; i++) td[i] = 0.1 + rng() * 0.8; // targets in (0,1)
    const target = Tensor.fromFlat(td, 4, 3, false);
    ops.push(checkOp('bceWithLogits', [logits], () => bceWithLogits(logits, target), rng));
  }
  {
    const mu = leaf(rng, 4, 3);
    const logvar = leaf(rng, 4, 3); // kept in [-1,1] so e^{logvar} stays well-conditioned
    ops.push(checkOp('klDivStdNormal', [mu, logvar], () => klDivStandardNormal(mu, logvar), rng));
  }

  // End-to-end: a whole tiny VAE — encoder, the μ and logσ² heads, and the decoder — gradchecked
  // through the reparameterized ELBO (BCE reconstruction + KL). ε is a fixed leaf so the
  // stochastic latent sample is a well-defined function of the parameters for finite differences.
  {
    const vae = new VAE({ px: 6, hidden: [8], latent: 3, activation: 'gelu' }, rngFrom(5));
    const xd = new Float64Array(12);
    for (let i = 0; i < xd.length; i++) xd[i] = rng() * 2 - 1;
    const x = Tensor.fromFlat(xd, 2, 6, false);
    const td = new Float64Array(12);
    for (let i = 0; i < td.length; i++) td[i] = 0.1 + rng() * 0.8;
    const target = Tensor.fromFlat(td, 2, 6, false);
    const epsd = new Float64Array(6);
    for (let i = 0; i < epsd.length; i++) epsd[i] = rng() * 2 - 1;
    const eps = Tensor.fromFlat(epsd, 2, 3, false);
    ops.push(
      checkOp(
        'vae (e2e)',
        vae.parameters(),
        () => {
          const { logits, mu, logvar } = vae.forward(x, eps);
          return bceWithLogits(logits, target).add(klDivStandardNormal(mu, logvar));
        },
        rng,
      ),
    );
  }

  // ---- Diffusion (DDPM/DDIM) -------------------------------------------------------
  //
  // End-to-end: a whole time-conditioned denoiser — input projection, the time MLP, the learned
  // class embedding, every residual block's LayerNorm + SiLU Linears, and the output projection —
  // gradchecked through the eps-prediction MSE. x_t, the timestep embedding and the class ids are
  // frozen leaves (they are the network's *input*, exactly like the VAE's eps), so the loss is a
  // clean function of the parameters for finite differences.
  {
    const sched = new NoiseSchedule(20, 'cosine');
    const den = new Denoiser({ px: 6, hidden: 8, depth: 2, timeDim: 8, numClasses: 3 }, rngFrom(21));
    const B = 3;
    const tIdx = Int32Array.from([2, 11, 17]);
    const xtd = new Float64Array(B * 6);
    for (let i = 0; i < xtd.length; i++) xtd[i] = rng() * 2 - 1;
    const xt = Tensor.fromFlat(xtd, B, 6, false);
    const temb = sinusoidalTimeEmbedding(tIdx, sched.T, 8);
    const classIds = Int32Array.from([0, 2, 1]);
    const targd = new Float64Array(B * 6);
    for (let i = 0; i < targd.length; i++) targd[i] = rng() * 2 - 1;
    const target = Tensor.fromFlat(targd, B, 6, false);
    ops.push(
      checkOp(
        'diffusion-denoiser (e2e)',
        den.parameters(),
        () => mse(den.forward(xt, temb, classIds), target),
        rng,
      ),
    );
  }

  // Schedule self-consistency: the cumulative product of alpha_t equals abar_T, and the variance
  // recursion v_t = alpha_t·v_{t-1} + beta_t (v_0 = 0) accumulates to exactly 1 - abar_T. This is
  // the proof that the noising chain's per-step kernel and its closed-form marginal agree.
  {
    const s = new NoiseSchedule(60, 'cosine');
    let prod = 1;
    let v = 0;
    for (let i = 0; i < s.T; i++) {
      prod *= s.alpha[i];
      v = s.alpha[i] * v + s.beta[i];
    }
    ops.push(
      relCheck('diffusion-schedule', [
        [prod, s.alphaBar[s.T - 1]],
        [v, 1 - s.alphaBar[s.T - 1]],
      ]),
    );
  }

  // Forward-marginal identity: sqrt(abar_t)^2 + sqrt(1-abar_t)^2 ≡ 1 at every step, and abar is a
  // strictly decreasing sequence starting near 1 — so the forward kernel really is a unit-variance
  // interpolation between the data and Gaussian noise.
  {
    const s = new NoiseSchedule(40, 'linear');
    const pairs: [number, number][] = [];
    let mono = 0;
    for (let i = 0; i < s.T; i++) {
      pairs.push([s.sqrtAlphaBar[i] * s.sqrtAlphaBar[i] + s.sqrtOneMinusAlphaBar[i] * s.sqrtOneMinusAlphaBar[i], 1]);
      if (i > 0 && s.alphaBar[i] > s.alphaBar[i - 1]) mono = 1;
    }
    pairs.push([s.alphaBar[0], s.alpha[0]]); // abar_1 == alpha_1
    pairs.push([mono, 0]); // 0 if abar is monotonically decreasing
    ops.push(relCheck('diffusion-marginal', pairs));
  }

  // Posterior identity: the DDPM reverse-step *mean* (using the true eps that produced x_t) equals
  // the closed-form forward-posterior mean μ̃_t(x_0, x_t). The two are algebraically identical — this
  // verifies the reverse update targets the right Gaussian.
  {
    const s = new NoiseSchedule(50, 'cosine');
    const px = 8;
    const x0 = new Float64Array(px);
    const eps = new Float64Array(px);
    for (let i = 0; i < px; i++) {
      x0[i] = rng() * 2 - 1;
      eps[i] = rng() * 2 - 1;
    }
    const ti = 23;
    const xt = qSampleData(x0, eps, Int32Array.from([ti]), px, s);
    // The classic eps-form reverse mean  1/sqrt(alpha)·(x_t - beta/sqrt(1-abar)·eps), computed inline
    // (independent of ddpmStep), must equal the closed-form forward-posterior mean μ̃_t(x0, x_t).
    const invSqrtA = 1 / Math.sqrt(s.alpha[ti]);
    const coef = s.beta[ti] / s.sqrtOneMinusAlphaBar[ti];
    const muPost = posteriorMean(x0, xt, ti, s);
    const pairs: [number, number][] = [];
    for (let i = 0; i < px; i++) pairs.push([invSqrtA * (xt[i] - coef * eps[i]), muPost[i]]);
    ops.push(relCheck('diffusion-posterior', pairs));
  }

  // DDIM x̂0 exactness: recovering x_0 from x_t with the true eps is exact, and classifier-free
  // guidance is the affine combine eps_uncond + w·(eps_cond − eps_uncond) — at w = 0 it is exactly
  // the conditional prediction.
  {
    const s = new NoiseSchedule(50, 'linear');
    const px = 8;
    const x0 = new Float64Array(px);
    const eps = new Float64Array(px);
    const epsCond = new Float64Array(px);
    const epsUncond = new Float64Array(px);
    for (let i = 0; i < px; i++) {
      x0[i] = rng() * 2 - 1;
      eps[i] = rng() * 2 - 1;
      epsCond[i] = rng() * 2 - 1;
      epsUncond[i] = rng() * 2 - 1;
    }
    const ti = 31;
    const xt = qSampleData(x0, eps, Int32Array.from([ti]), px, s);
    const x0hat = predictX0(xt, eps, ti, s);
    const g0 = classifierFreeGuidance(epsCond, epsUncond, 0);
    const g2 = classifierFreeGuidance(epsCond, epsUncond, 2);
    const pairs: [number, number][] = [];
    for (let i = 0; i < px; i++) {
      pairs.push([x0hat[i], x0[i]]); // x̂0 reconstructs x0
      pairs.push([g0[i], epsCond[i]]); // strength w=0 ⇒ plain conditional
      pairs.push([g2[i], 3 * epsCond[i] - 2 * epsUncond[i]]); // (1+w)·cond − w·uncond, w=2
    }
    ops.push(relCheck('diffusion-ddim+cfg', pairs));
  }

  // ---- Normalizing flow (RealNVP) --------------------------------------------------
  //
  // End-to-end: a whole flow — every coupling layer's conditioner MLP, its bounded log-scale
  // and shift heads — gradchecked through the *exact* negative log-likelihood (the change-of-
  // variables objective −[log p_z(f(x)) + Σ logdet]). x is a frozen leaf (the network's input),
  // so the loss is a clean function of the parameters for finite differences.
  {
    const flow = new RealNVP({ D: 2, hidden: [6], layers: 3, activation: 'tanh' }, rngFrom(31));
    const B = 4;
    const xd = new Float64Array(B * 2);
    for (let i = 0; i < xd.length; i++) xd[i] = rng() * 2 - 1;
    const x = Tensor.fromFlat(xd, B, 2, false);
    ops.push(checkOp('flow-nll (e2e)', flow.parameters(), () => flow.nllLoss(x), rng));
  }

  // Invertibility: f⁻¹(f(x)) ≡ x to machine precision — the property that makes the exact
  // density valid in the first place. A random flow maps x → z and straight back.
  {
    const flow = new RealNVP({ D: 2, hidden: [8], layers: 6, activation: 'gelu' }, rngFrom(73));
    const B = 6;
    const xd = new Float64Array(B * 2);
    for (let i = 0; i < xd.length; i++) xd[i] = rng() * 2 - 1;
    const x = Tensor.fromFlat(xd, B, 2, false);
    const z = flow.forward(x).z;
    const xback = flow.inverse(z);
    const pairs: [number, number][] = [];
    for (let i = 0; i < B * 2; i++) pairs.push([xback.data[i], xd[i]]);
    ops.push(relCheck('flow-invertibility', pairs));
  }

  // Change-of-variables exactness: the analytic log-determinant the flow reports for a point
  // equals log|det J| of its forward map, estimated by a central-difference Jacobian. This is
  // the proof that the triangular-Jacobian shortcut (Σ s) really is the volume change.
  {
    const flow = new RealNVP({ D: 2, hidden: [8], layers: 4, activation: 'tanh' }, rngFrom(91));
    // The scale head is zero-initialised (identity start), so a fresh flow has logdet ≡ 0 —
    // a degenerate ~0-vs-~0 comparison. Nudge every parameter off the init so the volume
    // change is genuinely non-trivial before we check it.
    for (const p of flow.parameters()) for (let i = 0; i < p.size; i++) p.data[i] += rng() * 0.6 - 0.3;
    const x0 = new Float64Array([rng() * 2 - 1, rng() * 2 - 1]);
    const fwdZ = (xv: Float64Array): Float64Array => flow.forward(Tensor.fromFlat(xv.slice(), 1, 2, false)).z.data;
    const h = 1e-4;
    const J = [
      [0, 0],
      [0, 0],
    ];
    for (let b = 0; b < 2; b++) {
      const xp = x0.slice();
      xp[b] += h;
      const zp = fwdZ(xp).slice();
      const xm = x0.slice();
      xm[b] -= h;
      const zm = fwdZ(xm).slice();
      for (let a = 0; a < 2; a++) J[a][b] = (zp[a] - zm[a]) / (2 * h);
    }
    const det = J[0][0] * J[1][1] - J[0][1] * J[1][0];
    const logAbsDet = Math.log(Math.abs(det));
    const reported = flow.forward(Tensor.fromFlat(x0.slice(), 1, 2, false)).logdet.data[0];
    ops.push(relCheck('flow-logdet (Jacobian)', [[logAbsDet, reported]]));
  }

  // ---- Generative adversarial network (GAN) ----------------------------------------
  //
  // The two players are trained against each other, so each gets its own end-to-end gradcheck.
  //
  // Discriminator: with a frozen real batch and a frozen (detached) fake batch, the binary
  // cross-entropy classifier loss is a clean function of D's parameters — exactly the update
  // alternating-GD applies to the critic. Both players' MLPs are exercised here too.
  {
    const gan = new GAN({ D: 2, zDim: 3, gHidden: [8], dHidden: [8], gAct: 'tanh', dAct: 'tanh', objective: 'nonsat' }, rngFrom(202));
    const B = 5;
    const rd = new Float64Array(B * 2);
    const fd = new Float64Array(B * 2);
    for (let i = 0; i < B * 2; i++) {
      rd[i] = rng() * 2 - 1;
      fd[i] = rng() * 2 - 1;
    }
    const real = Tensor.fromFlat(rd, B, 2, false);
    const fake = Tensor.fromFlat(fd, B, 2, false);
    ops.push(checkOp('gan-D (e2e)', gan.discParameters(), () => gan.discLoss(real, fake).loss, rng));
  }

  // Generator: with z frozen and the discriminator's weights held fixed, the non-saturating
  // generator loss −log D(G(z)) is a clean function of G's parameters. Its gradient is the
  // signal D back-propagates *through itself* into the generator — proving that learning
  // signal exact is proving the whole GAN trains correctly.
  {
    const gan = new GAN({ D: 2, zDim: 3, gHidden: [8], dHidden: [8], gAct: 'gelu', dAct: 'tanh', objective: 'nonsat' }, rngFrom(303));
    const B = 5;
    const zd = new Float64Array(B * 3);
    for (let i = 0; i < zd.length; i++) zd[i] = rng() * 2 - 1;
    const z = Tensor.fromFlat(zd, B, 3, false);
    ops.push(checkOp('gan-G (e2e)', gan.genParameters(), () => gan.genLoss(gan.generate(z)).loss, rng));
  }

  // Wasserstein critic: the WGAN critic loss is differentiable too (it is just a difference of
  // means of D's outputs), and its gradcheck proves the EM-distance objective trains the critic.
  {
    // A smooth critic activation here so the finite-difference check isn't biased by a ReLU-kink
    // (the live lab defaults to leaky_relu; the gradient is identical away from the kink).
    const gan = new GAN({ D: 2, zDim: 2, gHidden: [6], dHidden: [8], gAct: 'tanh', dAct: 'tanh', objective: 'wgan' }, rngFrom(404));
    const B = 6;
    const rd = new Float64Array(B * 2);
    const fd = new Float64Array(B * 2);
    for (let i = 0; i < B * 2; i++) {
      rd[i] = rng() * 2 - 1;
      fd[i] = rng() * 2 - 1;
    }
    const real = Tensor.fromFlat(rd, B, 2, false);
    const fake = Tensor.fromFlat(fd, B, 2, false);
    ops.push(checkOp('gan-wgan-critic (e2e)', gan.discParameters(), () => gan.discLoss(real, fake).loss, rng));

    // Value identity: the critic loss really is mean(D(fake)) − mean(D(real)), recomputed by
    // hand from the raw critic scores — the exact algebraic definition of the EM objective.
    const dReal = gan.discriminate(real);
    const dFake = gan.discriminate(fake);
    let mR = 0;
    let mF = 0;
    for (let i = 0; i < B; i++) {
      mR += dReal.data[i];
      mF += dFake.data[i];
    }
    const manual = mF / B - mR / B;
    const reported = gan.discLoss(real, fake).loss.data[0];
    ops.push(relCheck('gan-wgan-loss (identity)', [[manual, reported]]));
  }

  // ---- Graph neural network (GCN · SAGE · GAT) --------------------------------------
  // End-to-end on a tiny fixed graph: each message-passing convolution (every layer's weight,
  // bias, and — for GAT — multi-head attention vectors) backpropagated through the masked
  // cross-entropy of a semi-supervised split, vs. finite differences. Dropout is off so the
  // loss is a clean function of the parameters. This proves the dense-propagation message
  // passing differentiates correctly through the engine's existing ops.
  {
    const n = 6;
    const edges: [number, number][] = [
      [0, 1], [1, 2], [2, 0], [2, 3], [3, 4], [4, 5], [5, 3],
    ];
    const labels = Int32Array.from([0, 0, 0, 1, 1, 1]);
    const keep = Uint8Array.from([1, 0, 0, 1, 0, 0]); // one labeled node per community
    const inDim = 3;
    const X = leaf(rng, n, inDim);
    X.requiresGrad = false;
    const adj = buildAdj(n, edges, true);
    const mk = (conv: ConvKind, heads: number) =>
      new GNN({ inDim, hidden: [4], numClasses: 2, conv, activation: 'relu', dropout: 0, heads }, adj, rngFrom(conv === 'gat' ? 41 : 19));
    for (const [conv, heads, name] of [
      ['gcn', 1, 'gnn-gcn (e2e)'],
      ['sage', 1, 'gnn-sage (e2e)'],
      ['gat', 2, 'gnn-gat·2head (e2e)'],
    ] as [ConvKind, number, string][]) {
      const model = mk(conv, heads);
      ops.push(checkOp(name, model.parameters(), () => maskedCrossEntropy(model.forward(X), labels, keep).loss, rng));
    }
  }

  // ---- Kolmogorov–Arnold Network (B-spline edges) -----------------------------------
  //
  // One fused KAN layer, gradchecked through ALL of its parameters AND its input: the SiLU base
  // weights, every spline coefficient, the bias, and x itself (the chain rule through the B-spline
  // derivative B'(x) — the part that lets KAN layers stack). x is a real (requiresGrad) input here
  // so the dx backward is exercised exactly like every other tensor's.
  {
    const inF = 3;
    const outF = 2;
    const grid = makeGrid(5, 3, -1.2, 1.2);
    const layer = new KANLayer(inF, outF, grid, rngFrom(61), 0.6);
    const x = leaf(rng, 4, inF); // values in [-1,1], inside the grid
    ops.push(checkOp('kan-layer (x+params)', [x, ...layer.parameters()], () => layer.forward(x), rng));
  }

  // End-to-end: a whole KAN — two B-spline layers — gradchecked through the classification
  // cross-entropy, proving the stacked layers differentiate correctly through one another.
  {
    const kan = new KAN({ inDim: 2, hidden: [3], outDim: 3, gridSize: 5, degree: 3, domain: 1.2 }, rngFrom(67));
    const B = 5;
    const xd = new Float64Array(B * 2);
    for (let i = 0; i < xd.length; i++) xd[i] = rng() * 1.6 - 0.8;
    const x = Tensor.fromFlat(xd, B, 2, false);
    const targets = Int32Array.from([0, 2, 1, 2, 0]);
    ops.push(checkOp('kan-classify (e2e)', kan.parameters(), () => softmaxCrossEntropy(kan.forward(x), targets).loss, rng));
  }

  // End-to-end regression KAN through MSE (the 1-D function-fitting head).
  {
    const kan = new KAN({ inDim: 1, hidden: [4], outDim: 1, gridSize: 6, degree: 3, domain: 1 }, rngFrom(71));
    const B = 5;
    const xd = new Float64Array(B);
    for (let i = 0; i < B; i++) xd[i] = rng() * 1.6 - 0.8;
    const x = Tensor.fromFlat(xd, B, 1, false);
    const td = new Float64Array(B);
    for (let i = 0; i < B; i++) td[i] = rng() * 2 - 1;
    const target = Tensor.fromFlat(td, B, 1, false);
    ops.push(checkOp('kan-regress (e2e)', kan.parameters(), () => mse(kan.forward(x), target), rng));
  }

  // B-spline partition of unity: at any interior point the basis values sum to 1 — the property
  // that makes the spline a true convex blend of its control points.
  {
    const grid = makeGrid(6, 3, -1, 1);
    const val = new Float64Array(grid.numBasis);
    const der = new Float64Array(grid.numBasis);
    const pairs: [number, number][] = [];
    for (const x of [-0.73, -0.21, 0.05, 0.4, 0.88]) {
      evalSplineBasis(grid, x, val, der);
      let s = 0;
      for (let k = 0; k < grid.numBasis; k++) s += val[k];
      pairs.push([s, 1]);
    }
    ops.push(relCheck('kan-spline-partition', pairs));
  }

  // Grid refit preservation: re-solving the spline coefficients onto a finer grid (G → 2G) keeps
  // the learned function nearly unchanged — the "grid extension" property that lets a trained KAN
  // be refined without forgetting. We compare φ before/after the refit at interior sample points.
  {
    const inF = 1;
    const outF = 1;
    const layer = new KANLayer(inF, outF, makeGrid(5, 3, -1, 1), rngFrom(83), 1.0);
    const before = layer.edgeCurve(0, 0, 40);
    layer.refitToGrid(makeGrid(10, 3, -1, 1));
    const after = layer.edgeCurve(0, 0, 40);
    const pairs: [number, number][] = [];
    // skip the very edges where the open knot vector has the most freedom
    for (let s = 4; s < 36; s++) pairs.push([after.ys[s], before.ys[s]]);
    ops.push(relCheck('kan-grid-refit', pairs));
  }

  // ---- Neural ODE (continuous depth · adjoint) --------------------------------------
  {
    // (1) the whole continuous-depth classifier, gradchecked through the ODE solver end-to-end.
    const model = new NeuralODE(
      { inDim: 2, classes: 2, arch: { hidden: 8, depth: 2, activation: 'tanh', augDim: 1 }, solver: 'rk4', steps: 5, t0: 0, t1: 1 },
      rngFrom(seed ^ 0x0de),
    );
    const ds = makeNodeDataset('moons', 12, 0.05, 4);
    const X = Tensor.fromFlat(ds.X.slice(0, 24), 12, 2);
    const y = ds.y.slice(0, 12);
    ops.push(checkOp('node-classify (e2e)', model.parameters(), () => softmaxCrossEntropy(model.forward(X), y).loss, rng));
  }
  {
    // (2) RK4 exactness: realise a *linear* field dz/dt = λz with a 1-layer linear ODEFunc
    // (W0 = I, Wout = λI), integrate to t=1, and compare against the closed form z0·e^λ.
    const D = 3;
    const lambda = 0.7;
    const func = new ODEFunc(D, { hidden: D, depth: 1, activation: 'linear', augDim: 0 }, rngFrom(1));
    func.W[0].data.fill(0);
    for (let i = 0; i < D; i++) func.W[0].data[i * D + i] = 1; // W0 = I
    func.b[0].data.fill(0);
    func.tw.data.fill(0);
    func.Wout.data.fill(0);
    for (let i = 0; i < D; i++) func.Wout.data[i * D + i] = lambda; // Wout = λI
    func.bout.data.fill(0);
    const z0 = Tensor.from([[1.3, -0.7, 0.4]]);
    const z1 = odeIntegrate(func, z0, 64, 0, 1, 'rk4');
    const pairs: [number, number][] = [];
    for (let i = 0; i < D; i++) pairs.push([z1.data[i], z0.data[i] * Math.exp(lambda)]);
    ops.push(relCheck('node-rk4-exactness', pairs));
  }
  {
    // (3) the continuous adjoint must reproduce back-prop-through-the-solver on a real batch.
    const model = new NeuralODE(
      { inDim: 2, classes: 2, arch: { hidden: 16, depth: 1, activation: 'tanh', augDim: 1 }, solver: 'rk4', steps: 16, t0: 0, t1: 1 },
      rngFrom(seed ^ 0xad),
    );
    const ds = makeNodeDataset('moons', 24, 0.05, 9);
    const X = Tensor.fromFlat(ds.X.slice(0, 48), 24, 2);
    const y = ds.y.slice(0, 24);
    const logits = model.forward(X);
    softmaxCrossEntropy(logits, y).loss.backward();
    const bp = model.func.parameters().map((p) => p.grad.slice());
    const z1 = model.flow(X);
    const { aT } = terminalAdjointCE(model, z1, y);
    const { paramGrads } = adjointDynamicsGrad(model.func, z1.data, aT, 24, 16, 0, 1, 'rk4');
    const pairs: [number, number][] = [];
    for (let pi = 0; pi < bp.length; pi++) for (let i = 0; i < bp[pi].length; i++) pairs.push([paramGrads[pi][i], bp[pi][i]]);
    ops.push(relCheck('node-adjoint=backprop', pairs));
  }

  // ---- Bayesian deep learning (uncertainty lab) -------------------------------------
  //
  // The two hand-derived probabilistic losses, a single reparameterized variational layer, and a
  // whole Bayes-by-Backprop MLP gradchecked end-to-end through its ELBO. The variational forward
  // path draws weights w = μ + softplus(ρ)⊙ε; freezing ε once (per check) makes the ELBO a clean
  // deterministic function of the parameters, exactly the way the VAE's reparameterization is
  // gradchecked.
  {
    const B = 5;
    const mu = leaf(rng, B, 1);
    const lv = leaf(rng, B, 1); // log-variance in [-1,1] — inside the precision clamp, so exact
    const td = new Float64Array(B);
    for (let i = 0; i < B; i++) td[i] = rng() * 2 - 1;
    const target = Tensor.fromFlat(td, B, 1, false);
    ops.push(checkOp('bayes-nll', [mu, lv], () => gaussianNLL(mu, lv, target), rng));
  }
  {
    const muK = leaf(rng, 3, 4);
    const rhoK = leaf(rng, 3, 4);
    ops.push(checkOp('bayes-kl', [muK, rhoK], () => gaussianKL(muK, rhoK, 0.5), rng));
  }
  {
    const inF = 3;
    const B = 4;
    const layer = new BayesLinear(inF, 2, 'tanh', rngFrom(91), -2);
    const eps = layer.sampleEps(rngFrom(123)); // frozen ⇒ deterministic
    const xd = new Float64Array(B * inF);
    for (let i = 0; i < xd.length; i++) xd[i] = rng() * 1.4 - 0.7;
    const x = Tensor.fromFlat(xd, B, inF, false);
    const td = new Float64Array(B);
    for (let i = 0; i < B; i++) td[i] = rng() * 2 - 1;
    const target = Tensor.fromFlat(td, B, 1, false);
    const z = new Int32Array(B);
    const o = new Int32Array(B).fill(1);
    ops.push(
      checkOp(
        'bayes-linear (e2e)',
        layer.parameters(),
        () => {
          const out = layer.forwardWith(x, eps);
          return gaussianNLL(gatherCols(out, z), gatherCols(out, o), target);
        },
        rng,
      ),
    );
  }
  {
    const net = new BayesMLP(2, [4], rngFrom(97), 'tanh', -2);
    const eps = net.sampleAllEps(rngFrom(131));
    const B = 5;
    const xd = new Float64Array(B * 2);
    for (let i = 0; i < xd.length; i++) xd[i] = rng() * 1.4 - 0.7;
    const x = Tensor.fromFlat(xd, B, 2, false);
    const td = new Float64Array(B);
    for (let i = 0; i < B; i++) td[i] = rng() * 2 - 1;
    const target = Tensor.fromFlat(td, B, 1, false);
    const z = new Int32Array(B);
    const o = new Int32Array(B).fill(1);
    const N = 80;
    ops.push(
      checkOp(
        'bayes-mlp-elbo (e2e)',
        net.parameters(),
        () => {
          const out = net.forwardWith(x, eps);
          const nll = gaussianNLL(gatherCols(out, z), gatherCols(out, o), target);
          return nll.add(net.kl(0.5).scale(1 / N));
        },
        rng,
      ),
    );
  }
  {
    // Law of total variance: the mixture predictive variance (aleatoric + epistemic) must equal
    // the brute-force second moment (1/S)Σ(var_s + mean_s²) − (mean of means)².
    const S = 6;
    const G = 4;
    const means: Float64Array[] = [];
    const vars: Float64Array[] = [];
    for (let s = 0; s < S; s++) {
      const m = new Float64Array(G);
      const v = new Float64Array(G);
      for (let g = 0; g < G; g++) {
        m[g] = rng() * 2 - 1;
        v[g] = 0.2 + rng();
      }
      means.push(m);
      vars.push(v);
    }
    const pm = mixtureMoments(means, vars, G);
    const pairs: [number, number][] = [];
    for (let g = 0; g < G; g++) {
      let m2 = 0;
      let mBar = 0;
      for (let s = 0; s < S; s++) {
        m2 += vars[s][g] + means[s][g] * means[s][g];
        mBar += means[s][g];
      }
      mBar /= S;
      const brute = m2 / S - mBar * mBar;
      pairs.push([pm.aleatoric[g] + pm.epistemic[g], brute]);
    }
    ops.push(relCheck('bayes-total-variance', pairs));
  }

  // ---- Neural Cellular Automata (morphogenesis lab) ---------------------------------
  //
  // The one new hand-derived op is `perceive` (a fixed depthwise Sobel/identity filter bank);
  // the update rule is plain matmul/add/relu, so the real proof is that the gradient flows
  // back through a WHOLE multi-step CA rollout (back-prop through time). Masks are frozen
  // (stop-gradient, as in Distill) so the finite-difference check sees a smooth function.
  {
    // (1) perceive: forward + VJP against finite differences.
    const meta = { N: 1, H: 4, W: 4, C: 3 };
    const x = leaf(rng, meta.N * meta.H * meta.W, meta.C);
    ops.push(checkOp('nca-perceive', [x], () => perceive(x, meta), rng));
  }
  {
    // (2) a whole CA rollout gradchecked end-to-end through BPTT.
    const meta = { N: 2, H: 6, W: 6, C: 6 };
    const model = new NCA({ channels: meta.C, hidden: 8, fireRate: 0.5 }, rngFrom(seed ^ 0xca));
    for (let i = 0; i < model.W2.size; i++) model.W2.data[i] = (rng() * 2 - 1) * 0.2; // wake up the update
    const cells = meta.H * meta.W;
    const seedArr = makeSeed(meta);
    const buf = new Float64Array(meta.N * cells * meta.C);
    for (let g = 0; g < meta.N; g++) buf.set(seedArr, g * cells * meta.C);
    const seedT = Tensor.fromFlat(buf, meta.N * cells, meta.C, false);
    const target = renderTarget('heart', meta);
    const T = 6;
    const captured = model.rollout(seedT, T, meta, rngFrom(0x5eed)).masks; // freeze the masks
    ops.push(
      checkOp(
        'nca-rollout (BPTT e2e)',
        model.parameters(),
        () => ncaVisibleLoss(model.rollout(seedT, T, meta, rngFrom(0x5eed), captured).state, target, meta),
        rng,
      ),
    );
  }
  {
    // (3) value identity: with the second update layer zero-initialised, one CA step is the
    // identity on the seed (the network starts by doing nothing — it must *learn* to grow).
    const meta = { N: 1, H: 5, W: 5, C: 6 };
    const model = new NCA({ channels: meta.C, hidden: 8, fireRate: 1 }, rngFrom(seed ^ 0xceca));
    const seedArr = makeSeed(meta);
    const seedT = Tensor.fromFlat(seedArr.slice(), meta.H * meta.W, meta.C, false);
    const after = model.rollout(seedT, 1, meta, rngFrom(1)).state;
    const pairs: [number, number][] = [];
    for (let i = 0; i < seedArr.length; i++) pairs.push([after.data[i], seedArr[i]]);
    ops.push(relCheck('nca-zero-init-identity', pairs));
  }

  const maxRelError = ops.reduce((m, o) => Math.max(m, o.maxRelError), 0);
  return { ops, maxRelError, passed: maxRelError < 1e-3 };
}
