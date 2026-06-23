// A from-scratch Generative Adversarial Network on the engine's reverse-mode autograd.
//
// The lab already learns a 2-D density three ways: a VAE optimises a *lower bound* on the
// likelihood, a diffusion model learns a *score*, and a normalizing flow gives the **exact**
// likelihood in closed form. A GAN is the fourth, and the odd one out — it never writes down a
// density at all. Instead it sets up a two-player game:
//
//   • the GENERATOR  G_θ : z ↦ x   maps a latent noise vector z ~ N(0, I) into a fake sample,
//   • the DISCRIMINATOR (critic) D_φ : x ↦ ℝ   scores how "real" a point looks,
//
// and the two are trained against each other. D is pushed to tell real data apart from G's
// fakes; G is pushed to fool D. At the unique equilibrium of the minimax game G's pushforward
// of the Gaussian *equals* the data distribution and D can do no better than a coin flip — so
// the model learns to *sample* the data without ever evaluating its probability.
//
//   minimax value (Goodfellow et al., 2014):
//       min_G  max_D   E_{x~data}[ log D(x) ]  +  E_{z~N}[ log(1 − D(G(z))) ]
//
// Everything here is assembled from the engine's primitive ops (matmul, add, the MLP, and the
// fused numerically-stable `bceWithLogits`), so the gradient of each player's objective flows
// back into its own parameters for free — and `selftest.ts` gradchecks BOTH players end to end
// against finite differences, and proves the Wasserstein critic's loss identity exactly.
//
// Three objectives are offered, because the *training dynamics* are the whole story of GANs:
//
//   • 'minimax'  — the original saturating game. G minimises log(1 − D(G(z))). Faithful to the
//                  theory, but G's gradient vanishes early while D is winning (the classic
//                  "saturation" failure) — instructive to watch it stall.
//   • 'nonsat'   — the non-saturating trick from the same paper: G instead MAXIMISES log D(G(z)).
//                  Same fixed point, strong gradients even when D is confident. The default.
//   • 'wgan'     — Wasserstein GAN (Arjovsky et al., 2017). D becomes an unbounded *critic*
//                  trained to maximise E[D(real)] − E[D(fake)] (an estimate of the Earth-Mover
//                  distance), kept 1-Lipschitz by clipping its weights to [−c, c]. G minimises
//                  −E[D(G(z))]. The loss now tracks a real distance, so it actually correlates
//                  with sample quality — the headline reason WGAN mattered.

import { Tensor } from './tensor';
import { MLP, type Activation, type LayerSpec } from './nn';
import { bceWithLogits } from './losses';
import { mulberry32, sampleNoise } from './vae';

export { mulberry32, sampleNoise };

export type GANObjective = 'minimax' | 'nonsat' | 'wgan';

export interface GANConfig {
  D: number; // data dimension (2 for the lab)
  zDim: number; // latent dimension
  gHidden: number[]; // generator hidden widths
  dHidden: number[]; // discriminator/critic hidden widths
  gAct: Activation; // generator hidden activation
  dAct: Activation; // discriminator hidden activation
  objective: GANObjective;
}

// Per-player statistics surfaced live in the UI. For the probabilistic games these are mean
// σ(D(·)) ∈ [0,1] ("how real does D think this batch is"); for WGAN they are mean raw critic
// scores, and `wDist` is the critic's Earth-Mover estimate E[D(real)] − E[D(fake)].
export interface GANLossOut {
  loss: Tensor;
  dReal: number; // mean score on real data  (σ for prob games, raw for WGAN)
  dFake: number; // mean score on fake data
  wDist: number; // raw E[D(real)] − E[D(fake)]  (the Wasserstein estimate)
}

const sigmoid = (z: number) => 1 / (1 + Math.exp(-z));

// A constant target column [k,1] filled with `value` — the real/fake labels for the BCE games.
function constCol(k: number, value: number): Tensor {
  const d = new Float64Array(k).fill(value);
  return Tensor.fromFlat(d, k, 1, false);
}

function meanCol(t: Tensor): number {
  let s = 0;
  for (let i = 0; i < t.size; i++) s += t.data[i];
  return s / Math.max(1, t.size);
}

function meanSigmoid(t: Tensor): number {
  let s = 0;
  for (let i = 0; i < t.size; i++) s += sigmoid(t.data[i]);
  return s / Math.max(1, t.size);
}

export class GAN {
  readonly cfg: GANConfig;
  readonly gen: MLP;
  readonly disc: MLP;

  constructor(cfg: GANConfig, rng: () => number) {
    this.cfg = cfg;
    const gLayers: LayerSpec[] = cfg.gHidden.map((u) => ({ units: u, activation: cfg.gAct }));
    const dLayers: LayerSpec[] = cfg.dHidden.map((u) => ({ units: u, activation: cfg.dAct }));
    // Build the discriminator first so the two nets draw distinct streams from the same rng —
    // they must not start as mirror images. The generator's output is a plain linear map into
    // the (standardised, roughly unit-variance) data plane.
    this.disc = new MLP(cfg.D, dLayers, 1, rng);
    this.gen = new MLP(cfg.zDim, gLayers, cfg.D, rng);
  }

  // z ~ N(0, I) as a fixed (non-grad) leaf [k, zDim].
  sampleLatent(k: number, rng: () => number): Tensor {
    return sampleNoise(k, this.cfg.zDim, rng);
  }

  // x̂ = G(z): the generator's fake batch (gradient flows into G).
  generate(z: Tensor): Tensor {
    return this.gen.forward(z);
  }

  // D(x): raw logits/critic scores [k, 1] (gradient flows into D, and into x if x is non-leaf).
  discriminate(x: Tensor): Tensor {
    return this.disc.forward(x);
  }

  // ---- the discriminator / critic objective ----------------------------------------
  //
  // `real` and `fakeDetached` are both treated as constants here (the fakes are detached from G
  // so the D update never reaches into the generator — standard alternating-GD GAN training).
  // Returns a loss the optimiser MINIMISES that maximises D's ability to separate the two.
  discLoss(real: Tensor, fakeDetached: Tensor): GANLossOut {
    const dReal = this.disc.forward(real);
    const dFake = this.disc.forward(fakeDetached);
    const k = real.rows;
    let loss: Tensor;
    if (this.cfg.objective === 'wgan') {
      // Critic maximises E[D(real)] − E[D(fake)]  ⇒  minimise its negation.
      loss = dFake.meanAll().sub(dReal.meanAll());
    } else {
      // Binary classifier: real → 1, fake → 0 (fused stable BCE-with-logits).
      loss = bceWithLogits(dReal, constCol(k, 1)).add(bceWithLogits(dFake, constCol(dFake.rows, 0)));
    }
    const rawReal = meanCol(dReal);
    const rawFake = meanCol(dFake);
    return {
      loss,
      dReal: this.cfg.objective === 'wgan' ? rawReal : meanSigmoid(dReal),
      dFake: this.cfg.objective === 'wgan' ? rawFake : meanSigmoid(dFake),
      wDist: rawReal - rawFake,
    };
  }

  // ---- the generator objective ------------------------------------------------------
  //
  // `fake` = G(z) WITH gradient tracking; the loss is minimised w.r.t. G's parameters (D held
  // fixed). The three objectives differ only here — this is exactly where the saturating vs.
  // non-saturating vs. Wasserstein training dynamics come from.
  genLoss(fake: Tensor): GANLossOut {
    const dFake = this.disc.forward(fake);
    const k = fake.rows;
    let loss: Tensor;
    if (this.cfg.objective === 'wgan') {
      loss = dFake.meanAll().scale(-1); // minimise −E[D(G(z))]
    } else if (this.cfg.objective === 'minimax') {
      // Original saturating game: G minimises log(1 − D) = −bce(·, fake=0). Maximising bce(·,0)
      // pushes D(fake)→1; we negate so the minimiser climbs it (and watch it saturate early).
      loss = bceWithLogits(dFake, constCol(k, 0)).scale(-1);
    } else {
      // Non-saturating: G minimises −log D(G(z)) = bce(·, real=1). Strong gradients throughout.
      loss = bceWithLogits(dFake, constCol(k, 1));
    }
    const rawFake = meanCol(dFake);
    return {
      loss,
      dReal: NaN,
      dFake: this.cfg.objective === 'wgan' ? rawFake : meanSigmoid(dFake),
      wDist: NaN,
    };
  }

  // WGAN keeps the critic ~1-Lipschitz by clamping every parameter into [−c, c] after each
  // critic step (Arjovsky et al.'s weight-clipping enforcement of the Lipschitz constraint).
  clipDiscWeights(c: number): void {
    if (c <= 0) return;
    for (const p of this.disc.parameters()) {
      const d = p.data;
      for (let i = 0; i < d.length; i++) d[i] = d[i] < -c ? -c : d[i] > c ? c : d[i];
    }
  }

  genParameters(): Tensor[] {
    return this.gen.parameters();
  }

  discParameters(): Tensor[] {
    return this.disc.parameters();
  }

  paramCount(): number {
    return this.gen.paramCount() + this.disc.paramCount();
  }

  // Weights are exported/imported as [generator…, discriminator…] so a saved or shared model
  // restores both players in lock-step.
  exportWeights(): number[] {
    return [...this.gen.exportWeights(), ...this.disc.exportWeights()];
  }

  importWeights(flat: number[]): boolean {
    const gN = this.gen.paramCount();
    const dN = this.disc.paramCount();
    if (flat.length !== gN + dN) return false;
    return this.gen.importWeights(flat.slice(0, gN)) && this.disc.importWeights(flat.slice(gN));
  }
}

export interface GANPreset {
  id: string;
  label: string;
  gHidden: number[];
  dHidden: number[];
}

export const GAN_PRESETS: GANPreset[] = [
  { id: 'small', label: 'Small · G[64] · D[64]', gHidden: [64], dHidden: [64] },
  { id: 'standard', label: 'Standard · G[128,128] · D[128,128]', gHidden: [128, 128], dHidden: [128, 128] },
  { id: 'deep', label: 'Deep · G[128,128,128] · D[128,128]', gHidden: [128, 128, 128], dHidden: [128, 128] },
];

export function ganPresetById(id: string): GANPreset {
  return GAN_PRESETS.find((p) => p.id === id) ?? GAN_PRESETS[1];
}

export const GAN_OBJECTIVES: { id: GANObjective; label: string }[] = [
  { id: 'nonsat', label: 'Non-saturating' },
  { id: 'minimax', label: 'Minimax (saturating)' },
  { id: 'wgan', label: 'Wasserstein (WGAN-clip)' },
];
