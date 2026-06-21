# Synapse — journal

A tiny **deep-learning framework that runs in your browser**, built from scratch on a real
reverse-mode **tensor autograd engine** (no TensorFlow.js, no ONNX, no WebGL math libs — every
gradient is hand-derived and the tape is hand-rolled). On top of the engine sits an interactive
**neural-network laboratory**: pick a 2-D dataset, sketch a network, and watch it learn in real
time — decision boundary, per-neuron feature maps, loss/accuracy curves, and a live computation
graph all update each training step. A built-in **numerical gradient checker** runs finite
differences against the analytic gradients and reports the max error, so you can *prove* the
engine is correct, not just trust it.

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
    nn.ts         Linear layers, Sequential model, He/Xavier init, activation modules
    optim.ts      SGD, Momentum, RMSProp, Adam, L2 weight decay
    losses.ts     softmax cross-entropy (fused), MSE
    data.ts       dataset generators (spiral, circles, moons, xor, gaussians, ring) + noise
    gradcheck.ts  finite-difference gradient checker
  components/
    DecisionBoundary.tsx   canvas heatmap of model output over the input plane
    NeuronGrid.tsx         per-hidden-unit activation heatmaps (the iconic TF-playground view)
    LossChart.tsx          loss + accuracy curves (canvas)
    GraphView.tsx          live SVG of the autograd tape for one sample
    ControlPanel.tsx       dataset / architecture / optimizer / hyperparameter controls
  hooks/
    useTrainer.ts   owns model+optimizer+data, steps the training loop via rAF
  App.tsx           lab layout wiring it all together
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

### Still open / future

- [ ] Convolution + a tiny image task (stretch)
- [ ] WebGL/WebGPU matmul backend for bigger nets (stretch)
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
</content>
