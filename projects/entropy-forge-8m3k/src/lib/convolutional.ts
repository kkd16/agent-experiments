// convolutional.ts — convolutional codes and the Viterbi maximum-likelihood
// decoder, the codes that carried Voyager's photos across the solar system and
// still run inside GSM, 802.11 and satellite links.
//
// Unlike a block code, a convolutional encoder has MEMORY: it slides a small
// shift register over the input bit stream and, at each step, emits a few output
// bits that are parity taps across the current bit and the last K−1 bits (K is
// the "constraint length"). A rate-1/n code emits n bits per input bit. Because
// each output depends on a window of inputs, a single received error is
// out-voted by its neighbours — errors get spread thin and averaged out.
//
// DECODING is the elegant part. The encoder is a finite-state machine (state =
// the K−1 remembered bits), so every possible transmitted sequence is a path
// through a TRELLIS. The received (noisy) sequence has, under an independent-
// noise channel, a likelihood that factorises along the path — so the maximum-
// likelihood transmitted sequence is the trellis path CLOSEST to what we
// received. VITERBI finds it in linear time by dynamic programming:
// Add-Compare-Select keeps, for each state at each time, only the best path into
// it; a final traceback reads off the winner. Hard-decision uses Hamming
// distance; soft-decision uses Euclidean distance to the raw channel samples and
// buys ~2 dB of coding gain for free.

/** A convolutional code: rate 1/n, constraint length K, octal generator taps. */
export interface ConvCode {
  name: string
  K: number // constraint length
  n: number // outputs per input bit (rate = 1/n)
  gens: number[] // generator polynomials, K bits each (MSB = current input tap)
  states: number // 2^(K−1)
}

/** Build a code from octal generator strings, e.g. [0o7, 0o5] for the (7,5) code. */
export function makeConvCode(name: string, K: number, gens: number[]): ConvCode {
  return { name, K, n: gens.length, gens, states: 1 << (K - 1) }
}

// The two codes every textbook and standard uses.
export const CONV_7_5 = makeConvCode('(7,5)₈ · K=3', 3, [0o7, 0o5])
export const CONV_171_133 = makeConvCode('(171,133)₈ · K=7', 7, [0o171, 0o133])

/** Parity (XOR of all set bits) of an integer. */
function parity(x: number): number {
  let p = 0
  while (x) {
    p ^= 1
    x &= x - 1
  }
  return p
}

/** The n output bits for a given (state, input) — state holds the previous K−1
 * inputs (most-recent bit as the high bit). */
export function branchOutput(code: ConvCode, state: number, input: number): number[] {
  const window = (input << (code.K - 1)) | state // K bits: [input | state]
  return code.gens.map((g) => parity(window & g))
}

/** Next state after shifting `input` into `state`. */
export function nextState(code: ConvCode, state: number, input: number): number {
  return (state >> 1) | (input << (code.K - 2))
}

/**
 * Encode a bit stream. If `terminate`, K−1 zero bits are appended to flush the
 * register back to state 0 (so the decoder can anchor its traceback there).
 * Returns the coded bit stream and the number of input bits actually encoded
 * (including the flush bits).
 */
export function convEncode(
  code: ConvCode,
  bits: number[],
  terminate = true,
): { coded: number[]; steps: number } {
  const input = terminate ? [...bits, ...new Array(code.K - 1).fill(0)] : bits.slice()
  let state = 0
  const coded: number[] = []
  for (const b of input) {
    coded.push(...branchOutput(code, state, b))
    state = nextState(code, state, b)
  }
  return { coded, steps: input.length }
}

/** Precomputed trellis transitions for a code (built once, reused per decode). */
interface Trellis {
  // For each state s and input b: the next state and the n expected output bits.
  next: number[][] // next[s][b]
  out: number[][][] // out[s][b] = n output bits
  // For Viterbi ACS we need the predecessors: for each state, the two (prevState,
  // input) pairs that lead into it.
  preds: { from: number; input: number }[][]
}

function buildTrellis(code: ConvCode): Trellis {
  const S = code.states
  const next: number[][] = []
  const out: number[][][] = []
  const preds: { from: number; input: number }[][] = Array.from({ length: S }, () => [])
  for (let s = 0; s < S; s++) {
    next[s] = []
    out[s] = []
    for (let b = 0; b < 2; b++) {
      const ns = nextState(code, s, b)
      next[s][b] = ns
      out[s][b] = branchOutput(code, s, b)
      preds[ns].push({ from: s, input: b })
    }
  }
  return { next, out, preds }
}

export interface ViterbiResult {
  bits: number[] // decoded input bits (flush bits stripped if terminated)
  survivorStates: number[] // the winning state at each trellis stage (length steps+1)
  finalMetric: number
  metricsPerStep: number[][] // path metric of each state after each stage (for viz)
  steps: number
}

/**
 * Viterbi decode. `received` is the coded stream: hard-decision expects 0/1 bits
 * and uses Hamming branch metrics; soft-decision expects real samples (BPSK:
 * 0→+1, 1→−1) and uses squared-Euclidean branch metrics. `terminate` says the
 * encoder flushed to state 0 (so we anchor the traceback there and strip the
 * K−1 tail bits).
 */
export function viterbiDecode(
  code: ConvCode,
  received: number[],
  opts: { soft?: boolean; terminate?: boolean } = {},
): ViterbiResult {
  const soft = opts.soft ?? false
  const terminate = opts.terminate ?? true
  const trellis = buildTrellis(code)
  const S = code.states
  const steps = Math.floor(received.length / code.n)

  const INF = Infinity
  let metric = new Array(S).fill(INF)
  metric[0] = 0 // encoder starts in state 0
  // Traceback table: tb[t][s] = { from, input } chosen when entering state s at t.
  const tb: { from: number; input: number }[][] = []
  const metricsPerStep: number[][] = []

  for (let t = 0; t < steps; t++) {
    const recv = received.slice(t * code.n, t * code.n + code.n)
    const nextMetric = new Array(S).fill(INF)
    const choice: { from: number; input: number }[] = new Array(S)
    for (let s = 0; s < S; s++) {
      if (metric[s] === INF) continue
      for (let b = 0; b < 2; b++) {
        const ns = trellis.next[s][b]
        const exp = trellis.out[s][b]
        // Branch metric.
        let bm = 0
        if (soft) {
          for (let r = 0; r < code.n; r++) {
            const expSym = exp[r] === 0 ? 1 : -1 // BPSK map
            const diff = recv[r] - expSym
            bm += diff * diff
          }
        } else {
          for (let r = 0; r < code.n; r++) bm += (recv[r] ^ exp[r]) & 1
        }
        const cand = metric[s] + bm
        if (cand < nextMetric[ns]) {
          nextMetric[ns] = cand
          choice[ns] = { from: s, input: b }
        }
      }
    }
    tb.push(choice)
    metric = nextMetric
    metricsPerStep.push(metric.slice())
  }

  // Choose the terminal state: 0 if terminated, else the global minimum.
  let endState = 0
  if (!terminate) {
    let best = INF
    for (let s = 0; s < S; s++) {
      if (metric[s] < best) {
        best = metric[s]
        endState = s
      }
    }
  }
  const finalMetric = metric[endState]

  // Traceback.
  const survivorStates: number[] = new Array(steps + 1)
  const decoded: number[] = new Array(steps)
  let s = endState
  survivorStates[steps] = s
  for (let t = steps - 1; t >= 0; t--) {
    const c = tb[t][s]
    if (!c) {
      // Unreachable (shouldn't happen with a valid stream); bail gracefully.
      decoded[t] = 0
      s = 0
    } else {
      decoded[t] = c.input
      s = c.from
    }
    survivorStates[t] = s
  }

  const bits = terminate ? decoded.slice(0, Math.max(0, steps - (code.K - 1))) : decoded
  return { bits, survivorStates, finalMetric, metricsPerStep, steps }
}

/** Free distance d_free of a small convolutional code, found by a bounded search
 * over non-zero input sequences (weight of the lowest-weight path that leaves
 * and returns to state 0). Used to state the code's error-correction power. */
export function freeDistance(code: ConvCode, maxLen = 12): number {
  // BFS over states tracking accumulated output weight of paths that diverge
  // from the all-zero path and remerge. Classic approach: shortest path in the
  // state graph with the first branch forced to input 1.
  const S = code.states
  let best = Infinity
  // Dijkstra-like: distance = min output weight to reach (state) having left 0.
  const dist = new Array(S).fill(Infinity)
  // Start: from state 0 with input 1.
  const startOut = branchOutput(code, 0, 1).reduce((a, b) => a + b, 0)
  const startState = nextState(code, 0, 1)
  dist[startState] = startOut
  // Relax up to maxLen steps.
  for (let iter = 0; iter < maxLen; iter++) {
    const nd = dist.slice()
    for (let s = 0; s < S; s++) {
      if (dist[s] === Infinity) continue
      for (let b = 0; b < 2; b++) {
        const w = branchOutput(code, s, b).reduce((a, x) => a + x, 0)
        const ns = nextState(code, s, b)
        if (ns === 0 && !(s === 0 && b === 0)) {
          best = Math.min(best, dist[s] + w) // remerged to all-zero
        } else if (ns !== 0) {
          if (dist[s] + w < nd[ns]) nd[ns] = dist[s] + w
        }
      }
    }
    for (let s = 0; s < S; s++) dist[s] = nd[s]
  }
  return best === Infinity ? 0 : best
}
