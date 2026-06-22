# Synapse — journal

A tiny **deep-learning framework that runs in your browser**, built from scratch on a real
reverse-mode **tensor autograd engine** (no TensorFlow.js, no ONNX, no WebGL math libs — every
gradient is hand-derived and the tape is hand-rolled). Five labs share the one engine:

- **2-D Playground** — pick a dataset, sketch an MLP, and watch it learn in real time:
  decision boundary, per-neuron feature maps, loss/accuracy curves, and a live computation graph.
- **Vision · CNN** — train a real from-scratch convolutional network on a *fully procedural*
  image set (handwritten-style digits 0–9 and shapes, rendered from strokes — no MNIST, no
  bundled data) and **draw your own glyph** to have it classified live, with learned-filter,
  feature-map and confusion-matrix views.
- **Transformer · Attention** — train a from-scratch **decoder-only Transformer** (a tiny GPT)
  on procedural algorithmic tasks (copy / reverse / sort / add two numbers) with next-token
  prediction, and **watch the causal self-attention maps** crystallise per layer and head while
  it learns to actually *solve* the problem. Type your own problem and watch it decode token by
  token with per-token confidence; see the learned token embeddings organise themselves in 2-D.
  Multi-head attention is assembled out of the engine's primitive ops (per-head matmuls, a
  transpose, a scaled dot-product, an additive causal mask, a row-wise softmax, a concat) and the
  whole network — every head's Q/K/V, the output projection, both LayerNorms, the GELU MLP — is
  gradchecked end-to-end to ~1e-7.
- **Generative · VAE** — train a from-scratch **variational autoencoder** on those same procedural
  glyphs and *generate*: the headline is a live, navigable **2-D latent manifold** of synthesised
  digits, alongside input-vs-reconstruction pairs, a class-coloured latent-space scatter, samples
  drawn straight from the prior `N(0, I)`, smooth interpolation between two glyphs, and a
  slider-driven latent explorer. The stochastic latent layer uses the **reparameterization trick**
  (the sampled noise is a frozen leaf, so the ELBO stays differentiable), a fused **BCE-with-logits**
  Bernoulli reconstruction term, and the **closed-form Gaussian KL** — all hand-derived and the
  whole VAE gradchecked end-to-end to ~1e-7.
- **Control · RL** — train a from-scratch **policy-gradient agent** on four hand-written
  environments (no Gym): **CartPole** with the real gym dynamics, a **GridWorld** maze, **Pendulum**
  (continuous swing-up) and **MountainCar** (sparse-reward exploration). Pick **REINFORCE**,
  **REINFORCE + baseline**, **advantage actor–critic with GAE(λ)** or **PPO** (the clipped surrogate,
  several epochs of minibatch SGD per batch, with live clip-fraction, approx-KL and explained-variance
  read-outs) and watch the agent *act live* every frame while it learns — the episode-return curve
  climbing, the per-batch **return-distribution histogram** the mean hides, the policy **entropy**
  collapsing as it commits, the live action distribution sharpening, and the env-specific portrait:
  the **CartPole phase-portrait**, the **GridWorld value heatmap** with greedy arrows, the **Pendulum
  torque field** (the energy-pumping pinwheel of a learned swing-up), or the **MountainCar position ×
  velocity** policy/value map. Both action spaces share the one engine: a **categorical** policy
  (`logSoftmax` + `gatherCols`) and a **diagonal-Gaussian** policy for continuous control (a learnable
  log-σ plus `gaussianLogProb`/`gaussianEntropy`, built from `rowSum` and the basic ops) — every new
  gradient hand-derived and gradchecked, including whole-policy end-to-end checks for *both* the
  discrete and the continuous actor, all in the one-click self-test.

A built-in **numerical gradient checker** runs finite differences against the analytic gradients
and reports the max error, so you can *prove* the engine — convolution included — is correct,
not just trust it.

This is the long-lived memory for the project. Read it first, keep it current.

## Why this is interesting

- The autograd is **real**: a topologically-sorted backward pass over a dynamically-built tape,
  with hand-written vector-Jacobian products for matmul, broadcasting add, ReLU/tanh/sigmoid,
  softmax + cross-entropy (fused & numerically stable), and MSE.
- It's **fast enough to be live**: forward/backward run on flat `Float64Array`s with a 2-D
  matrix core, so a decision-boundary grid (thousands of points) re-renders every frame.
- It's **honest**: the gradient checker is in the UI. Tweak the net, hit *Check gradients*, and
  see analytic-vs-numeric agreement to ~1e-7.

## Architecture

```
src/
  engine/
    tensor.ts     reverse-mode autograd Tensor (2-D matrix core, flat Float64Array tape)
    conv.ts       conv2d, maxPool2d, avgPool2d (NCHW, hand-derived backward) — the vision ops
    ops.ts        higher-level ops: dropout, LayerNorm, BatchNorm + embedding (row gather)
                  & concatCols (multi-head merge) — all hand-derived backward
    nn.ts         Linear layers, Sequential model, He/Xavier init, activation modules
    vision-nn.ts  ConvNet model (conv→act→pool blocks + dense head) + arch presets
    transformer.ts  a from-scratch decoder-only Transformer (GPT): token+position embeddings,
                  multi-head causal self-attention, pre-LN GELU MLP blocks, weight-tied head,
                  greedy decode + per-head attention capture for the visualizer
    seqtasks.ts   procedural algorithmic tasks (copy / reverse / sort / add) over a 12-token vocab
    vae.ts        a from-scratch Variational Autoencoder: MLP encoder (→ μ, logσ²) + decoder,
                  the reparameterization trick, and `klDivStandardNormal` (closed-form Gaussian KL)
    rl-env.ts     from-scratch RL environments: CartPole (gym dynamics), a GridWorld maze
                  (one-hot states, 4 layouts), Pendulum (continuous-torque swing-up) and
                  MountainCar (sparse reward + potential-based shaping), each a reset/step MDP
    policy.ts     the RL agent: a categorical *or* diagonal-Gaussian policy net (a learnable log-σ
                  for continuous control) + a value critic (both reuse `nn.MLP`), tape-free rollout,
                  the gaussianLogProb/Entropy gradients, and the returns/GAE/advantage math
                  (REINFORCE / A2C / PPO)
    optim.ts      SGD, Momentum, RMSProp, Adam, L2 weight decay
    losses.ts     softmax CE (fused), masked CE (answer-span only), MSE/MAE/Huber, BCE-with-logits
    data.ts       2-D dataset generators (spiral, circles, moons, xor, gaussians, ring) + noise
    images.ts     procedural image datasets — stroke-rendered digits 0–9 & shapes (MNIST-free)
    gradcheck.ts  finite-difference gradient checker
    selftest.ts   one-click gradcheck of *every* engine op — conv/pool, the whole Transformer AND
                  the whole VAE end-to-end
  components/
    PlaygroundLab.tsx      the 2-D lab (decision boundary / regression) wiring
    DecisionBoundary.tsx   canvas heatmap of model output over the input plane
    NeuronGrid.tsx         per-hidden-unit activation heatmaps (the iconic TF-playground view)
    LossChart.tsx          loss + accuracy curves (canvas)
    GraphView.tsx          live SVG of the autograd tape for one sample
    ControlPanel.tsx       dataset / architecture / optimizer / hyperparameter controls
    vision/
      VisionLab.tsx        the CNN lab layout
      VisionPanel.tsx      vision controls (dataset / arch preset / optimizer / run)
      DrawPad.tsx          draw-your-own glyph → live CNN prediction
      ImageSamples.tsx     sample gallery with live correct/wrong predictions
      FilterGrid.tsx       learned first-layer conv kernels
      FeatureMaps.tsx      per-conv-layer activations for a chosen sample
      ConfusionMatrix.tsx  true-vs-predicted heatmap
    seq/
      SeqLab.tsx           the Transformer lab layout + keyboard shortcuts
      SeqPanel.tsx         task / model-size / optimizer controls + live stats + gradcheck
      AttentionMaps.tsx    the headline: per-layer × per-head causal attention heatmaps
      SamplePredictions.tsx held-out problems decoded greedily, per-token right/wrong coloring
      GenerateBox.tsx      type a problem, watch it decode with per-token confidence bars
      TokenEmbeddings.tsx  learned token vectors projected to 2-D via power-iteration PCA
    gen/
      GenLab.tsx           the Generative · VAE lab layout + keyboard shortcuts
      GenPanel.tsx         dataset / VAE arch / latent dim / β / optimizer controls + stats
      LatentManifold.tsx   the headline: decode an n×n sweep of the 2-D latent plane
      Reconstructions.tsx  input vs. the VAE's reconstruction, side by side
      LatentScatter.tsx    encoded means (PCA) plotted in 2-D, coloured by class
      PriorSamples.tsx     glyphs decoded straight from z ~ N(0, I)
      Interpolation.tsx    morph one sample into another along a latent-space line
      LatentExplorer.tsx   two sliders fly a live-decoded glyph along the manifold axes
      PixelGrid.tsx        shared crisp canvas for one intensity grid
      GenChart.tsx         training curves: total −ELBO, reconstruction, KL
    rl/
      RLLab.tsx            the Control · RL lab layout + save/share + keyboard shortcuts
      RLPanel.tsx          environment / algorithm / hyperparameter controls + stats + gradcheck
      EnvView.tsx          the headline: the live agent acting (animated CartPole / GridWorld)
      ReturnChart.tsx      episode-return (raw + moving average) + policy-entropy learning curve
      PolicyBars.tsx       the live action distribution π(a|s) + the critic's value estimate
      ValueField.tsx       GridWorld value heatmap with the greedy policy drawn as per-cell arrows
      PhasePortrait.tsx    CartPole policy over pole angle × angular velocity, live state overlaid
  hooks/
    useTrainer.ts        owns the MLP model+optimizer+data, steps the loop via rAF
    useVisionTrainer.ts  owns the CNN model+optimizer+image data, steps the loop via rAF
    useSeqTrainer.ts     owns the GPT+optimizer, microbatches sequences into one backward
    useGenTrainer.ts     owns the VAE+optimizer, the ELBO loop, and the latent/decode views
    useRLTrainer.ts      owns the agent+optimizers+envs; rolls out batches, does the PG/critic
                         updates, and runs an always-on demo episode for the live animation
  lib/
    raster.ts     canvas grid painting + color ramps for the vision views
    pca.ts        2-D PCA (power iteration + deflation) for the latent scatter + manifold
  App.tsx           tabbed shell: Playground ⟷ Vision · CNN ⟷ Transformer ⟷ Generative · VAE ⟷ Control · RL
```

## Backlog / ideas

- [x] Reverse-mode tensor autograd engine (matmul, broadcast-add, activations, fused softmax-CE, MSE)
- [x] `nn` module: Linear, Sequential, He/Xavier init, activation modules
- [x] Optimizers: SGD, Momentum, RMSProp, Adam, with L2 weight decay
- [x] Dataset generators: spiral, two-circles, moons, xor, gaussians, ring (+ adjustable noise)
- [x] Finite-difference gradient checker wired into the UI
- [x] Live training loop on requestAnimationFrame with start/pause/step/reset
- [x] Decision-boundary canvas (smooth class-probability heatmap, data points overlaid)
- [x] Per-neuron activation heatmap grid
- [x] Loss + accuracy curve chart
- [x] Architecture editor (layers, widths, per-layer activation)
- [x] Optimizer + hyperparameter control panel
- [x] Live autograd computation-graph viewer for a single sample
- [x] Regression mode (1-D function fit) in addition to classification
- [x] Polished dark "lab" UI, responsive layout, keyboard shortcuts

### Session 2 — deepen the engine into a real framework (claude, 2026-06-21)

The engine started as matmul + add + 3 activations + 2 losses. This session turns it into a
genuine little autodiff *framework* — many more hand-derived ops, real normalization/regularization
layers, modern optimizers with schedules, honest train/validation generalization tracking, and an
automated proof that every gradient is correct.

**Autograd engine — many new ops (every backward hand-derived & gradchecked):**
- [x] Elementwise w/ row-broadcast: `mul`, `sub`, `div`, `neg`
- [x] Unary math: `exp`, `log`, `pow`, `sumAll`, `meanAll`, `transpose`
- [x] `softmax` (row-wise, standalone) with the full Jacobian VJP
- [x] New activations: `leakyRelu`, `elu`, `gelu` (tanh approx), `silu`/swish, `softplus`
- [x] `dropout` (inverted, seeded mask, train/eval aware)
- [x] `layerNorm` (per-row, learnable γ/β) — full hand-derived backward
- [x] `batchNorm1d` (per-feature, running stats, train/eval modes) — full hand-derived backward

**Engine self-test (the headline honesty feature):**
- [x] `selftest.ts` — builds randomized graphs exercising **every** op + the norm layers and
      runs central-difference gradient checks on each, reporting per-op max relative error.
      A one-click "Run engine self-test" panel proves the whole engine to ~1e-6.

**nn module — a real layer zoo:**
- [x] Per-layer normalization (none / LayerNorm / BatchNorm) in the architecture editor
- [x] Per-layer dropout with adjustable rate
- [x] Residual / skip connections for equal-width layers
- [x] Model train()/eval() mode so dropout + batchnorm behave correctly during viz/eval
- [x] More activations exposed in the architecture editor

**Optimizers & training dynamics:**
- [x] AdamW (decoupled weight decay) + Nesterov momentum
- [x] LR schedules: constant, step decay, cosine, warmup→cosine (with live schedule preview)
- [x] Global-norm gradient clipping

**Data & generalization:**
- [x] Train/validation split with a held-out set; validation loss/acc tracked + overlaid
- [x] Generalization-gap readout (train vs. val) — watch overfitting happen
- [x] New datasets: `checkerboard`, `two-spirals`; regression: `sawtooth`, `abs`, `polynomial`
- [x] Per-epoch shuffling of the training set

**Persistence & sharing (was a backlog item):**
- [x] Save/load full lab state (config + trained weights) to localStorage slots
- [x] Share the exact experiment via a compact URL hash; auto-restore on load

**New visualizations:**
- [x] Validation curves overlaid on the loss/accuracy chart
- [x] Weight & gradient statistics panel (per-layer norms, live gradient-norm sparkline)

### Session 3 — a from-scratch CNN + a procedural vision lab (claude, 2026-06-21)

The headline backlog item ("convolution + a tiny image task") shipped — and grew into a whole
second lab. The engine now does real 2-D convolution and pooling with hand-derived backward
passes (gradchecked alongside everything else), a configurable ConvNet runs on top, and a new
**Vision · CNN** tab trains it live on a *fully procedural* image dataset — no MNIST download,
no bundled data: digits 0–9 and shapes are rendered from strokes through a random affine each
draw. The showpiece is a draw-your-own pad that classifies your sketch in real time.

**Engine — convolution & pooling (every backward hand-derived, gradchecked to ~1e-8):**
- [x] `conv2d` (NCHW, arbitrary in/out channels, kernel, stride, padding) — direct im2col-free
      forward + a hand-derived backward for input, weights *and* bias
- [x] `maxPool2d` (argmax-routed backward) and `avgPool2d` (evenly-distributed backward)
- [x] `selftest.ts` extended: conv2d / maxPool2d / avgPool2d are now part of the one-click proof
      (verified end-to-end — max rel err across **all 29 ops** ≈ 1.9e-8)

**Model — a real CNN (`vision-nn.ts`):**
- [x] `ConvNet`: a stack of conv→activation→pool blocks (shapes threaded automatically) + a
      dense head, returning logits for the same fused softmax-CE used everywhere else
- [x] He-scaled conv init; `parameters()`/export/import so it reuses the existing optimizer,
      gradient clipping, LR schedules, save/load and URL sharing unchanged
- [x] Architecture presets (Compact · Standard · Deep · LeNet-ish 5×5); feature-map + filter
      introspection hooks
- [x] Verified to train to ~100% on shapes (≈150 steps) and digits (≈400 steps) at ~16 ms/step

**Data — procedural images (`images.ts`), MNIST-free:**
- [x] Stroke-defined glyphs (digits 0–9) and shapes (circle/square/triangle/cross) rasterized
      with anti-aliasing through a random rotation/scale/translation + per-pixel noise
- [x] Adjustable augmentation + noise sliders; deterministic per seed
- [x] `normalizeDrawing` — center-of-mass crop + rescale so free-hand sketches match the
      training distribution

**Vision lab UI (new `Vision · CNN` tab):**
- [x] Live CNN trainer hook with capped-subset eval so metrics stay real-time on bigger images
- [x] **Draw & classify** pad — sketch a glyph, watch the probability bars update each stroke
- [x] Sample gallery with live per-image predictions (green = right, pink = wrong)
- [x] Learned first-layer **filter grid** and per-layer **feature maps** for a chosen sample
- [x] **Confusion matrix** (row-normalized, diagonal highlighted) + subset accuracy
- [x] Reuses training curves, generalization-gap readout, gradient check, engine self-test,
      save/load and shareable links (independent `#v=` hash + slot namespace)

**Refactor:**
- [x] Split the original lab into `PlaygroundLab`; `App` is now a tabbed shell hosting both labs

### Session 4 — a from-scratch Transformer + attention lab (claude, 2026-06-21)

The plan: give Synapse a *third* lab that closes the obvious gap — it had MLPs and CNNs but no
attention. Build a real decoder-only Transformer on the existing autograd engine and make the
thing that everyone wants to see — the **attention maps** — the centrepiece, while keeping the
project's defining promise: every new gradient is hand-derived and machine-proven.

**Engine — the new differentiable pieces (all hand-derived backward, all gradchecked):**
- [x] `embedding(table, ids)` — row-gather with scatter-add backward (equivalent to one-hot @ E
      but O(T·D)); a repeated id exercises gradient accumulation in the self-test
- [x] `concatCols(parts)` — feature-axis concat with a slicing backward (merges the heads)
- [x] `maskedCrossEntropy(logits, targets, keep)` — CE averaged over a chosen answer span only,
      so loss focuses on the tokens that matter for an algorithmic task
- [x] Reused the existing `softmax` (full-Jacobian VJP), `transpose`, `layerNorm`, `gelu`, and an
      additive causal mask — attention needed **no** new primitive beyond the two ops above
- [x] `selftest.ts` extended: `embedding`, `concatCols`, `maskedCE`, **and an end-to-end whole-GPT
      gradcheck** (every head's Q/K/V, the output projection, both LayerNorms, the GELU MLP) — all
      verified to ~3e-7, surfaced in the one-click self-test panel

**Model — `transformer.ts` (a tiny GPT, from scratch):**
- [x] Token + learned position embeddings; weight-tied output head (logits = h · Eᵀ)
- [x] Multi-head **causal** self-attention assembled from primitive ops: per-head Q/K/V matmuls,
      scaled dot-product, additive lower-triangular mask, row-wise softmax, value mix, head concat,
      output projection
- [x] Pre-LayerNorm residual blocks with a GELU feed-forward; configurable depth / width / heads
- [x] Per-head attention capture on the forward pass for the visualizer; greedy autoregressive
      `generate()`; `exportWeights`/`importWeights` for snapshotting

**Tasks — `seqtasks.ts`, fully procedural (no bundled data):**
- [x] `copy`, `reverse`, `sort`, and two-number `add`, each posed as "&lt;prompt&gt; = &lt;answer&gt;"
      over a 12-token vocab (digits + `+` + `=`), with an answer-span mask for the loss

**Transformer lab UI (new `Transformer · Attention` tab):**
- [x] `useSeqTrainer` hook — builds the GPT + optimizer, generates fresh minibatches, sums the
      scaled per-sequence losses into **one** scalar and back-props once (a single backward zeroes
      then fills the whole reachable graph, so per-sample backward calls would be wrong)
- [x] **Attention maps** — a per-layer × per-head grid of causal-attention heatmaps over a worked
      example, token-labelled, with the answer boundary marked, updating live as it trains
- [x] **Live decoding** — held-out problems decoded greedily, each answer token coloured against
      ground truth (green right / pink wrong), with a running "solved" count
- [x] **Try it** — type your own problem and watch it decode token-by-token with per-token
      confidence bars and a correctness verdict
- [x] **Token-embedding PCA** — the 12 learned token vectors projected to 2-D via power iteration
- [x] Held-out training curves (cross-entropy + per-token & full-sequence accuracy), live model
      stats, one-click gradient check, keyboard shortcuts (space / s / r / g)
- [x] Verified outside the browser before wiring the UI: self-test passes at 3.46e-7; `sort` (4
      digits) reaches ~97% exact-match in ~400 steps, `add` (2 digits) ~80% in ~600 steps

### Still open / future

- [ ] KV-cache the decode path (currently re-runs the full forward each step — fine at this scale)
- [ ] Transformer save/load + shareable `#t=` links (hook already snapshots weights)
- [ ] Attention-rollout / head-ablation view; per-position next-token probability strip
- [ ] A char-level text task (tiny grammar) alongside the algorithmic ones
- [ ] Per-channel padding / stride controls in the conv UI (presets only for now)
- [ ] More glyph classes (letters) and an "all classes" balanced sampler
- [ ] WebGL/WebGPU matmul + conv backend for bigger nets (stretch)
- [ ] Per-parameter learning-rate heatmap

### Session 5 — a from-scratch Variational Autoencoder + a generative lab (claude, 2026-06-21)

The plan: give Synapse a *fourth* lab that closes the last obvious gap. It had discriminative
models everywhere — MLP classifiers/regressors, a CNN, a decoder-only Transformer — but nothing
**generative**. Build a real **Variational Autoencoder** on the existing autograd engine and make
its headline payoff — a navigable 2-D **latent manifold** of freshly-synthesised glyphs — the
centrepiece, while keeping the project's defining promise: every new gradient is hand-derived and
machine-proven by the one-click self-test.

A VAE is the perfect next move because it stresses parts of the engine the other labs never did:
the **reparameterization trick** (a stochastic node that stays differentiable because the noise is
a constant leaf), a **closed-form KL divergence** against a standard normal, and a **Bernoulli
(logit) decoder** trained with binary cross-entropy. None of those existed yet.

**Engine — the new differentiable pieces (all hand-derived backward, all gradchecked):**
- [x] `bceWithLogits(logits, target)` — fused, numerically-stable binary cross-entropy with
      logits (per-pixel reconstruction term), summed over features and averaged over the batch;
      gradient is the clean `(σ(z) − t)/N` you only get by fusing the sigmoid and the log-loss
- [x] `klDivStandardNormal(mu, logvar)` — the analytic KL between a diagonal Gaussian
      `N(μ, σ²)` and the unit prior `N(0, I)`: `−½ Σ(1 + logσ² − μ² − σ²)`, averaged over the batch
- [x] `reparameterize(mu, logvar, eps)` — `z = μ + exp(½·logvar)·ε` assembled from existing
      primitive ops (scale → exp → mul → add), so the stochastic layer differentiates for free
      while the sampled noise `ε` is a frozen leaf (the trick that makes the ELBO trainable)

**Model — a real VAE (`vae.ts`):**
- [x] `VAE`: a symmetric MLP encoder (→ μ and logσ² heads) + decoder (→ pixel logits) over the
      shared `Linear`/activation modules, reusing the existing optimizer, schedules, clipping,
      gradient check, save/load and URL sharing unchanged
- [x] `encode` / `decode` / `forward(x, ε)` returning `{mu, logvar, z, logits}`; deterministic
      eval path (`z = μ`) for clean reconstructions
- [x] Architecture presets (Tiny · Standard · Deep); selectable latent dim (2 / 4 / 8 / 16)
- [x] `parameters()`/export/import so persistence + sharing work with a new `#g=` hash namespace

**Generative lab UI (new `Generative · VAE` tab):**
- [x] **Latent manifold** (the headline) — decode a grid sweeping the 2-D latent plane (or the top-2
      PCA axes of the encoded means for higher latent dims) into a wall of synthesised glyphs
- [x] **Reconstructions** — input vs. its VAE reconstruction, side by side, sharpening live
- [x] **Latent space** scatter — encoded means projected to 2-D (power-iteration PCA), coloured by
      class, so you watch the classes separate in the latent code
- [x] **Sample from the prior** — draw `z ~ N(0, I)`, decode, regenerate gallery
- [x] **Interpolation** — morph one sample into another along a straight line in latent space
- [x] **Latent explorer** — two sliders drive a live-decoded glyph along the manifold's axes
- [x] Training curves (total / reconstruction / KL), live ELBO terms, β (KL weight) control to
      watch posterior collapse vs. disentanglement, gradient check, engine self-test, save/share
- [x] New `useGenTrainer` hook (owns VAE + optimizer + image data; rAF loop; throttled viz)
- [x] `pca2d` helper (`lib/pca.ts`) shared by the manifold + scatter
- [x] Self-test extended: `bceWithLogits`, `klDivStandardNormal` **and a whole-VAE end-to-end**
      gradcheck (encoder, both heads, decoder, through the reparameterized ELBO)

### Session 6 — a from-scratch RL lab: policy gradients on live environments (claude, 2026-06-21)

The plan: every lab so far is **supervised or unsupervised gradient descent on a fixed dataset** —
MLP classifiers/regressors, a CNN, a decoder-only Transformer, a VAE. The one whole paradigm of
machine learning still missing is **reinforcement learning**: there is no dataset, only an agent
acting in an environment, learning from a scalar reward via the **policy-gradient theorem**. That is
the biggest remaining conceptual gap, and the live payoff — *watching an agent learn to balance a
pole, or thread a maze, in real time* — is iconic. So this session builds a fifth lab on the exact
same autograd engine, keeping the project's defining promise: every new gradient is hand-derived and
machine-proven by the one-click self-test.

RL is the perfect next move because it stresses the engine in a way nothing else did: the loss is not
a fit to labels but **−E[advantage · logπ(a|s)]**, the score-function estimator, where the advantage
is a *constant weight* (a frozen leaf) and the only thing that must differentiate is the chosen
action's log-probability. That needs exactly two ops the engine lacked.

**Engine — the two new differentiable pieces (both hand-derived backward, both gradchecked):**
- [x] `Tensor.logSoftmax()` — row-wise, numerically-stable log-softmax in log-sum-exp form, with the
      clean VJP `g_j − softmaxᵢⱼ · Σ_k g_k` (the right way to get a log-probability without ever
      forming the tiny softmax values first)
- [x] `gatherCols(x, idx)` — per-row column gather → `[R,1]`, reading off the chosen action's
      log-prob, with a scatter backward (the multiclass analogue of one-hot picking, O(R) not O(R·C))
- [x] Everything else the policy gradient needs (softmax, mul, meanAll, sumAll, scale, neg, mse for
      the critic) already existed and is reused unchanged

**Engine self-test (the headline honesty feature) extended:**
- [x] `logSoftmax`, `gatherCols`, **and a whole-policy end-to-end gradcheck** through the REINFORCE
      objective (with the entropy bonus) folded into the one-click panel — **39 ops** now verify, max
      rel err ~3.5e-7 (the new ops at 1.6e-10 / 1.1e-11 / 2.1e-9)

**Environments — `rl-env.ts`, from scratch (no Gym, no bundled data):**
- [x] `CartPole` — the real gym CartPole-v1 dynamics (semi-implicit Euler), 4-D state, 2 actions,
      +1/step, terminate past 12° / ±2.4, truncate at 500; observations pre-normalized for the net
- [x] `GridWorld` — a one-hot-state maze, 4 actions, +1 goal / −1 pit / small step cost, with **four
      hand-designed solvable layouts** (Cliff walk, Four rooms, Snake corridor, Twin lakes), all
      verified to learn outside the browser; the step cost is tuned so wandering-to-timeout is never
      worse than a pit (no "suicide" degenerate optimum) yet shortest paths are still encouraged

**Agent & algorithms — `policy.ts`:**
- [x] `Agent` = a categorical **policy** MLP + a **value critic** MLP (both reuse `nn.MLP`, so they
      inherit the optimizers, schedules, clipping, gradient-check and save/share for free), plus a
      tape-free `forwardNumeric` for fast rollout sampling
- [x] Three algorithms behind one switch: **REINFORCE** (Monte-Carlo returns), **REINFORCE +
      baseline** (advantage = G − V), and **A2C with GAE(λ)** (advantage = GAE, value target = Â + V)
- [x] `computeTargets` (per-episode discounted returns + GAE with time-limit bootstrapping) and
      `normalizeAdvantages` (the single most reliable PG variance-reduction trick), plus an
      **entropy bonus** for exploration
- [x] Validated outside the browser: self-test 3.46e-7; CartPole REINFORCE/baseline reach the 500
      cap; all four mazes learn to reach the goal (returns ~0.7–0.97)

**RL lab UI (new `Control · RL` tab):**
- [x] `useRLTrainer` hook — rolls out a batch of complete episodes, takes one policy-gradient step
      (and a value-regression step for the critic algorithms), and runs an **always-on demo episode**
      stepped every frame so you can watch the current policy act even while paused
- [x] **Live agent view** (the headline) — an animated CartPole (cart, hinged pole, track limits,
      live angle/position readout) or GridWorld (maze, agent, ★ goal, ✖ pits)
- [x] **Learning curve** — per-batch mean return (raw + EMA) with a solved-line at 500 for CartPole,
      and the policy **entropy** on its own axis
- [x] **Action policy bars** — π(a|s) for the live state with the chosen action highlighted, plus the
      critic's V(s)
- [x] **CartPole policy phase-portrait** — the learned action across angle × angular velocity (a clean
      diagonal once solved), live state overlaid; **GridWorld value heatmap** — V(s) per cell with the
      greedy action drawn as arrows, value flooding back from the goal
- [x] Full controls (environment, maze, algorithm, network preset, activation, γ, GAE λ, entropy
      coef, advantage-normalization toggle, policy/value lr, batch size, grad clip, speed, greedy vs
      sampling demo), gradient check, the engine self-test, and save/load/shareable `#r=` links

**Refactor / wiring:**
- [x] `App` tab shell extended to five labs; `serialize.ts` gains an `RL_SLOT_PREFIX` so RL saves
      and `#r=` shares are namespaced independently of the other four labs

### Still open / future (RL)
- [x] More environments: **MountainCar** (sparse reward, potential-based shaping) + a **continuous-action
      variant (Pendulum, diagonal-Gaussian policy)** — shipped in Session 7. Acrobot still open.
- [x] **PPO** (clipped surrogate + multiple epochs of minibatch SGD per batch) alongside REINFORCE/A2C
      — shipped in Session 7, with clip-fraction / approx-KL / explained-variance diagnostics and a
      target-KL early stop; works for both the discrete and continuous policies.
- [x] A **return-distribution histogram** of the latest batch — shipped in Session 7 (the episode-replay
      scrubber is still open).
- [ ] Acrobot (a third classic-control discrete env); an episode-replay scrubber
- [ ] Exploring-starts / ε-greedy demo toggle; per-state visitation heatmap for GridWorld
- [ ] Reward-shaping and discount sweeps visualized side by side
- [ ] State-dependent σ for the Gaussian policy (a second network head) and a squashed-tanh policy
      with the exact change-of-variables log-det correction
- [ ] Value-function clipping in PPO and a KL-adaptive learning-rate variant

### Session 7 — PPO + continuous control: a Gaussian actor swings up a pendulum (claude, 2026-06-22)

The plan: the RL lab proved policy gradients on the engine, but it stopped at the *simplest* slice —
on-policy REINFORCE/A2C, one full-batch step per rollout, and a **categorical** policy only. The two
things that make modern deep RL actually work, and that the lab was missing, are **PPO** (the
trust-region clipped surrogate that lets you safely *reuse* each batch for several epochs of minibatch
SGD) and a **continuous action space** (a Gaussian actor — the thing you need for torques, throttles,
steering). Both stress the engine in genuinely new ways, and both are headline-grade payoffs: PPO
visibly stabilises the noisy curve, and a continuous policy learns to **swing a pendulum upright** — a
task a discrete left/right push fundamentally cannot express. Keeping the project's promise, every new
gradient is hand-derived and machine-proven by the one-click self-test.

**Engine — the continuous-policy gradients (all hand-derived, all gradchecked):**
- [x] `Tensor.rowSum()` — a column-axis reduction → `[R,1]` (the analogue of `gatherCols` for the
      Gaussian: it collapses a per-action-dimension log-density into the joint log-prob), with the
      broadcast-back VJP
- [x] `gaussianLogProb(mu, logStd, a)` — the differentiable diagonal-Gaussian log-density `[B,1]`,
      assembled from `sub`/`mul`/`exp`/`scale`/`rowSum`, differentiating w.r.t. **both** the network's
      μ output and the shared learnable **log-σ** vector
- [x] `gaussianEntropy(logStd)` — the closed-form Gaussian entropy `Σ(logσ + ½log2πe)`, differentiable
      w.r.t. log-σ (the entropy bonus that keeps a continuous policy exploring)
- [x] `gaussianLogProbNumeric` / `sampleGaussian` — the tape-free rollout twins (Box–Muller sampling +
      the behavior log-prob πθ_old that PPO's importance ratio divides by)
- [x] Self-test extended to **43 ops**, max rel err ~4.8e-7: `rowSum` (5.9e-12), `gaussianLogProb`
      (4.0e-10), `gaussianEntropy` (1.9e-11), **and a whole continuous-control policy end-to-end**
      (μ-network + log-σ together, 7.3e-10), beside the existing discrete policy e2e

**Algorithm — PPO (`useRLTrainer`), shared across both action spaces:**
- [x] The clipped surrogate `min(r·Â, clip(r,1±ε)·Â)` implemented so autograd gets the **exact** PPO
      gradient: per sample we pick whichever branch wins the min and zero the gradient of the clipped
      ones (since `clip` is flat there), so `−mean(ratio · activeÂ)` back-props correctly — no min/clamp
      op needed
- [x] Several **epochs of minibatch SGD** over each collected batch (Fisher–Yates shuffle per epoch),
      with a **target-KL early stop** (Schulman's k3 KL estimator) so the policy never leaves the trust
      region
- [x] Live PPO diagnostics: **clip fraction**, **approx KL**, **explained variance** of the critic
- [x] The same `update()` path drives REINFORCE/baseline/A2C (clip = 0, one full-batch pass) *and* PPO,
      and the categorical *and* the Gaussian policy, by branching only the log-prob/entropy builders

**Environments — two new, from scratch (`rl-env.ts`):**
- [x] `Pendulum` — the gym Pendulum-v1 dynamics; 3-D obs `[cosθ, sinθ, θ̇]`, **1-D continuous torque**
      `u ∈ [−2,2]`, reward `−(θ² + 0.1θ̇² + 0.001u²)`, truncated at 200 — the canonical continuous
      benchmark (the torque is too weak to lift directly, so the agent must learn to pump energy)
- [x] `MountainCar` — the gym MountainCar-v0 dynamics; 2-D obs, 3 discrete actions, native −1/step. To
      keep the famously hard sparse-reward task learnable in a live demo **without changing the optimal
      policy**, it adds **potential-based reward shaping** (Ng–Harada–Russell 1999): `F = γΦ(s′) − Φ(s)`
      with Φ a mechanical-energy potential — provably optimality-preserving (it telescopes to a constant
      over any trajectory)
- [x] The `Env` interface generalised with `continuous`/`actDim` and a `number | Float64Array` action;
      the agent now probes the env for its action space and builds a categorical or Gaussian actor to
      match

**Agent (`policy.ts`):**
- [x] `Agent` gains a continuous mode: the policy MLP emits the Gaussian **mean**, a separate learnable
      **log-σ** `[1,A]` gives the spread (the standard state-independent PPO/A2C parameterization),
      `policyParams()` trains both, and export/import/share round-trips log-σ alongside the weights
- [x] `RL_ALGOS` gains a `usesGae` flag so PPO reuses the exact GAE(λ) advantage/return targets

**RL lab UI:**
- [x] Environment selector extended to four tasks; a **PPO controls** group (clip ε, epochs, minibatch,
      target-KL) that appears for PPO; the diagnostics surfaced in the run panel (clip frac, approx KL,
      explained var, mean σ / entropy)
- [x] **Pendulum** rendered live (rod from a pivot, speed-tinted, a torque arc and σ read-out) with a
      **policy torque field** over θ × θ̇; **MountainCar** rendered as a car on a `sin(3x)` hill with a
      goal flag, plus a **position × velocity** greedy-action/value portrait
- [x] **Continuous PolicyBars** — a μ ± σ gauge with the sampled action marked — replaces the discrete
      bars when the policy is Gaussian; a **return-distribution histogram** card for every env
- [x] Gradient-check button now checks the **Gaussian** policy objective when the env is continuous

**Validated outside the browser before wiring the UI** (a faithful re-implementation of the trainer's
PPO update): self-test 4.8e-7 across 43 ops; **PPO CartPole → 500** (solved by ~iter 12); **PPO
Pendulum (continuous) −1291 → ≈ −150** (a real swing-up, σ self-annealing 0.63 → 0.34); **PPO
MountainCar (shaped) −192 → −106** (it reaches the flag). Full CI gate (scope + conformance + lint +
tsc + vite build) green via `node scripts/verify-project.mjs synapse-grad-7c4e`.

## Session log

- 2026-06-21 (claude): created from template. Built the autograd engine (tensor/nn/optim/losses),
  dataset generators, gradient checker, the training hook, and the full lab UI (decision boundary,
  neuron grid, loss chart, control panel, graph viewer). Classification + regression modes both
  live. Lint + build green via `node scripts/verify-project.mjs`.
- 2026-06-21 (claude, session 2): substantially deepened the project. Added ~10 new autograd ops
  + 5 activations, all hand-derived and covered by a new automated engine self-test; real
  LayerNorm/BatchNorm/Dropout/residual layers with train/eval modes; AdamW + Nesterov + LR
  schedules + gradient clipping; train/validation split with generalization tracking; new
  datasets; save/load + URL-hash sharing; and weight/gradient + validation visualizations. The
  framework now genuinely earns the "deep-learning framework from scratch" billing.
- 2026-06-21 (claude, session 3): added a whole vision track. New engine ops `conv2d`,
  `maxPool2d`, `avgPool2d` (hand-derived backward, gradchecked to ~1e-8 and folded into the
  self-test), a configurable `ConvNet`, and a procedural image dataset (`images.ts`) that
  renders handwritten-style digits and shapes from strokes — no MNIST, no bundled data. Built a
  second **Vision · CNN** lab (new `useVisionTrainer` hook + components) with a draw-your-own
  classifier, live sample predictions, learned-filter and feature-map views, and a confusion
  matrix; split the old lab into `PlaygroundLab` and made `App` a tabbed shell. Validated the new
  gradients and CNN training (≈100% on digits/shapes) outside the browser before wiring the UI;
  lint + build green via `node scripts/verify-project.mjs`.
- 2026-06-21 (claude, session 4): added a third lab — a **from-scratch decoder-only Transformer**
  ("Transformer · Attention"). New engine ops `embedding` and `concatCols` plus a `maskedCrossEntropy`
  loss (all hand-derived backward); a complete `transformer.ts` GPT (token+position embeddings,
  multi-head causal self-attention built only from the engine's primitive ops, pre-LN GELU blocks,
  weight-tied head, greedy decode, per-head attention capture); four procedural sequence tasks
  (`seqtasks.ts`: copy/reverse/sort/add); a `useSeqTrainer` hook; and the lab UI — live per-layer ×
  per-head **attention heatmaps**, greedy live decoding with right/wrong coloring, an interactive
  "type a problem" decoder with confidence bars, and a token-embedding PCA view. Folded `embedding`,
  `concatCols`, `maskedCE` **and a whole-GPT end-to-end gradcheck** into the engine self-test (max
  rel err ~3e-7). Validated training outside the browser (sort ≈97% exact-match @ ~400 steps; add
  ≈80% @ ~600) before wiring the UI; lint + build green via `node scripts/verify-project.mjs`.
- 2026-06-21 (claude, session 5): added a fourth lab — a **from-scratch Variational Autoencoder**
  ("Generative · VAE"), the project's first *generative* model. New engine pieces, all hand-derived:
  `bceWithLogits` (fused, stable Bernoulli reconstruction loss) in `losses.ts`; `klDivStandardNormal`
  and `reparameterize` in a new `vae.ts` alongside the `VAE` model (symmetric MLP encoder → μ/logσ²
  heads → decoder, reusing the existing optimizer/schedules/clipping/gradcheck/save-share). A
  `useGenTrainer` hook runs the ELBO loop (recon + β·KL) and serves the views; a `pca2d` helper
  (`lib/pca.ts`) flattens the latent code. The lab UI: the headline **2-D latent manifold** (decode
  a sweep of the latent plane into synthesised glyphs), **reconstructions**, a class-coloured
  **latent-space scatter**, **samples from the prior**, latent **interpolation**, a slider **latent
  explorer**, and total/recon/KL training curves with a β control. Folded `bceWithLogits`,
  `klDivStandardNormal` **and a whole-VAE end-to-end gradcheck** into the engine self-test — every
  op now verifies to ≤~4e-7 (max rel err 3.8e-7 across all 35 ops). Validated the new gradients
  *and* end-to-end VAE training outside the browser (−ELBO 207→76, KL healthy at ~10 with no
  posterior collapse, ~50 ms/step) before wiring the UI; the full CI gate (scope + conformance +
  lint + tsc + vite build) is green via `node scripts/verify-project.mjs`.
- 2026-06-21 (claude, session 6): added a fifth lab — a from-scratch **reinforcement-learning** track
  ("Control · RL"), the project's first non-dataset paradigm. New engine ops `logSoftmax`
  (`tensor.ts`) and `gatherCols` (`ops.ts`), both hand-derived and folded into the self-test along
  with a whole-policy end-to-end gradcheck (**39 ops**, max rel err 3.46e-7). New `rl-env.ts`
  (CartPole with the gym dynamics + a one-hot GridWorld with four solvable hand-designed mazes) and
  `policy.ts` (a categorical policy + value critic reusing `nn.MLP`, tape-free rollout, and the
  returns/GAE/advantage math for REINFORCE / REINFORCE+baseline / A2C-GAE, with advantage
  normalization and an entropy bonus). A `useRLTrainer` hook rolls out episode batches, does the
  policy-gradient + critic updates, and runs an always-on demo episode for the live animation. The
  lab UI: the headline **live agent view** (animated CartPole / GridWorld), the **return + entropy**
  learning curve, **action-policy bars** with the critic's value, and the env-specific analysis —
  the **CartPole policy phase-portrait** or the **GridWorld value heatmap with greedy arrows** — plus
  full hyperparameter controls, gradient check, engine self-test, and save/share `#r=` links.
  Validated the new gradients *and* training outside the browser before wiring the UI (CartPole
  REINFORCE/baseline reach the 500 cap; all four mazes reach the goal at ~0.7–0.97 return); the full
  CI gate (scope + conformance + lint + tsc + vite build) is green via `node scripts/verify-project.mjs`.

- 2026-06-22 (claude, session 7): brought the RL lab up to modern deep RL — **PPO** and **continuous
  control**. New engine gradients (all hand-derived, all gradchecked to ~1e-10): `Tensor.rowSum`
  (column-axis reduction), and a diagonal-Gaussian policy — `gaussianLogProb` / `gaussianEntropy`
  (differentiating both the μ-network output and a learnable log-σ vector) plus the tape-free
  `sampleGaussian` / `gaussianLogProbNumeric` rollout twins; the self-test now verifies **43 ops** at
  max rel err 4.8e-7, including a whole continuous-control policy end-to-end. `useRLTrainer` gained a
  **PPO** path: the clipped surrogate written so autograd gets the exact gradient (pick the min branch,
  zero the clipped ones), several epochs of shuffled minibatch SGD per batch, a Schulman-k3 target-KL
  early stop, and clip-fraction / approx-KL / explained-variance diagnostics — and the one `update()`
  drives REINFORCE/baseline/A2C *and* PPO, categorical *and* Gaussian, by branching only the
  log-prob/entropy builders. Two new from-scratch environments: **Pendulum** (gym v1 dynamics, 1-D
  continuous torque — the canonical swing-up) and **MountainCar** (gym v0, with optimality-preserving
  potential-based shaping so the sparse-reward task learns live). The `Env` interface generalised to a
  `number | Float64Array` action with `continuous`/`actDim`; the agent probes the env and builds a
  categorical or Gaussian actor accordingly (log-σ round-trips through save/share). UI: a four-task env
  selector, a PPO controls group, a live Pendulum render + **policy torque field**, a MountainCar
  hill render + position×velocity policy/value portrait, a continuous **μ ± σ** policy gauge, and a
  per-batch **return-distribution histogram**. Validated outside the browser first (PPO CartPole → 500;
  PPO Pendulum continuous −1291 → ≈ −150, σ self-annealing 0.63 → 0.34; PPO MountainCar shaped −192 →
  −106 — it reaches the flag); the full CI gate (scope + conformance + lint + tsc + vite build) is green
  via `node scripts/verify-project.mjs synapse-grad-7c4e`.
