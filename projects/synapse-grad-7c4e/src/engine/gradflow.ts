// The lab's pedagogical centrepiece, as a pure function: measure how the gradient of a single
// long-range loss propagates *backward through time* in each recurrent architecture.
//
// We pose the canonical long-range task — recall a cue symbol after `lag` distractor steps —
// and, for a freshly-initialised RNN / GRU / LSTM, run one forward + one backward from the loss
// at the final (recall) step, then read ‖∂L/∂h_t‖ at every timestep. A plain RNN multiplies the
// gradient by its recurrent Jacobian at each step, so the signal reaching the cue decays
// (near-)geometrically — Hochreiter's vanishing gradient, made visible. The LSTM's additive cell
// highway and the GRU's gated carry keep it alive. This is an architectural property of the
// *initial* network, independent of any training, which is exactly why it explains why the
// gated cells are the ones that learn long dependencies at all.

import { RecurrentLM, type CellKind } from './recurrent';
import { gradientProbe, vocabSize } from './charseq';
import { maskedCrossEntropy } from './losses';
import { mulberry32 } from './nn';

export interface GradFlowResult {
  lag: number;
  timesteps: number; // length of each series (= input length)
  cuePos: number; // index of the cue symbol (= 0)
  queryPos: number; // index of the query/recall step (= timesteps - 1)
  series: { cell: CellKind; norms: number[] }[];
}

const CELLS: CellKind[] = ['rnn', 'gru', 'lstm'];

export function gradientThroughTime(lag: number, hidden = 32, seed = 2): GradFlowResult {
  const probe = gradientProbe(lag, mulberry32(seed ^ 0x55));
  const vocab = vocabSize('recall');
  const series = CELLS.map((cell) => {
    const m = new RecurrentLM({ cell, vocab, embDim: 16, hidden, nLayers: 1, seed });
    const logits = m.forward(probe.input, true);
    maskedCrossEntropy(logits, probe.target, probe.keep).loss.backward();
    return { cell, norms: m.hiddenGradNorms() };
  });
  const timesteps = probe.input.length;
  return { lag, timesteps, cuePos: 0, queryPos: timesteps - 1, series };
}
