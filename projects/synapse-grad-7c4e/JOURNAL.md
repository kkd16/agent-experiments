# Synapse — journal

A tiny **deep-learning framework that runs in your browser**, built from scratch on a real
reverse-mode **tensor autograd engine** (no TensorFlow.js, no ONNX, no WebGL math libs — every
gradient is hand-derived and the tape is hand-rolled). Two labs share the one engine:

- **2-D Playground** — pick a dataset, sketch an MLP, and watch it learn in real time:
  decision boundary, per-neuron feature maps, loss/accuracy curves, and a live computation graph.
- **Vision · CNN** — train a real from-scratch convolutional network on a *fully procedural*
  image set (handwritten-style digits 0–9 and shapes, rendered from strokes — no MNIST, no
  bundled data) and **draw your own glyph** to have it classified live, with learned-filter,
  feature-map and confusion-matrix views.

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
    nn.ts         Linear layers, Sequential model, He/Xavier init, activation modules
    vision-nn.ts  ConvNet model (conv→act→pool blocks + dense head) + arch presets
    optim.ts      SGD, Momentum, RMSProp, Adam, L2 weight decay
    losses.ts     softmax cross-entropy (fused), MSE/MAE/Huber
    data.ts       2-D dataset generators (spiral, circles, moons, xor, gaussians, ring) + noise
    images.ts     procedural image datasets — stroke-rendered digits 0–9 & shapes (MNIST-free)
    gradcheck.ts  finite-difference gradient checker
    selftest.ts   one-click gradcheck of *every* engine op, conv/pool included
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
  hooks/
    useTrainer.ts        owns the MLP model+optimizer+data, steps the loop via rAF
    useVisionTrainer.ts  owns the CNN model+optimizer+image data, steps the loop via rAF
  lib/
    raster.ts     canvas grid painting + color ramps for the vision views
  App.tsx           tabbed shell: 2-D Playground ⟷ Vision · CNN
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

### Still open / future

- [ ] Per-channel padding / stride controls in the conv UI (presets only for now)
- [ ] More glyph classes (letters) and an "all classes" balanced sampler
- [ ] WebGL/WebGPU matmul + conv backend for bigger nets (stretch)
- [ ] Per-parameter learning-rate heatmap

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

