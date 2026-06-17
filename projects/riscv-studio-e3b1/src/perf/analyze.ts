// The performance analyzer: glue between the functional interpreter and the timing model.
//
// It runs the assembled program on a *fresh, throwaway* CPU with the retire-tracer attached
// (history disabled, so there is no journal overhead), captures the bounded dynamic
// instruction trace, then feeds it through the pipeline + cache + branch-prediction model. It
// also replays the branch sub-trace through every predictor for a side-by-side comparison.
// Nothing here touches the live debugging CPU, and the functional results are untouched.

import { Cpu } from '../vm/cpu';
import type { RetireEvent } from '../vm/cpu';
import type { AssembleResult } from '../vm/assembler';
import { classify } from './isa-classes';
import { simulate } from './pipeline';
import type { PipelineConfig, PipelineResult } from './pipeline';
import { BranchPredictor } from './predictor';
import type { BranchEvent, PredictorKind } from './predictor';
import type { CacheConfig } from './cache';

/** Hard cap on captured instructions, so a runaway loop can't exhaust memory. */
export const TRACE_CAP = 300_000;

export const DEFAULT_ICACHE: CacheConfig = {
  sizeBytes: 1024,
  blockBytes: 32,
  ways: 2,
  replace: 'lru',
  writeBack: true,
};

export const DEFAULT_DCACHE: CacheConfig = {
  sizeBytes: 1024,
  blockBytes: 32,
  ways: 2,
  replace: 'lru',
  writeBack: true,
};

export function defaultConfig(): PipelineConfig {
  return {
    forwarding: true,
    branchResolve: 'EX',
    predictor: 'two-bit',
    predictorEntries: 1024,
    ghistBits: 8,
    btbSets: 256,
    mulCycles: 3,
    divCycles: 20,
    fpAddCycles: 4,
    fpMulCycles: 5,
    fpDivCycles: 20,
    icache: DEFAULT_ICACHE,
    dcache: DEFAULT_DCACHE,
    missPenalty: 10,
  };
}

export const ALL_PREDICTORS: PredictorKind[] = ['not-taken', 'taken', 'one-bit', 'two-bit', 'gshare'];

export interface PredictorComparison {
  kind: PredictorKind;
  hits: number;
  misses: number;
  accuracy: number;
}

export interface Analysis {
  ok: boolean;
  message: string;
  /** How many instructions were retired (and traced). */
  traced: number;
  truncated: boolean;
  /** Whether the program halted cleanly within the budget. */
  halted: boolean;
  result: PipelineResult;
  predictorComparison: PredictorComparison[];
}

/**
 * Capture the retired-instruction trace of `program` on a throwaway CPU. Returns the events plus
 * whether it halted and whether the cap truncated the run.
 */
export function captureTrace(program: AssembleResult): {
  trace: RetireEvent[];
  halted: boolean;
  truncated: boolean;
} {
  const cpu = new Cpu();
  cpu.recordHistory = false; // no time-travel journal — we only want the trace
  cpu.load(program);
  const trace: RetireEvent[] = [];
  let truncated = false;
  cpu.tracer = (ev) => {
    if (trace.length < TRACE_CAP) trace.push(ev);
    else truncated = true;
  };
  // Drive the CPU one instruction at a time until it stops or we hit the cap.
  while (!cpu.isStopped() && trace.length < TRACE_CAP) {
    if (!cpu.step()) break;
  }
  return { trace, halted: cpu.status === 'halted', truncated };
}

/** Replay only the control events through each predictor kind for a comparison table. */
export function comparePredictors(
  trace: readonly RetireEvent[],
  entries: number,
  ghistBits: number,
  btbSets: number,
): PredictorComparison[] {
  // Distil the branch sub-trace once.
  const branchEvents: BranchEvent[] = [];
  for (const e of trace) {
    const cls = classify(e.mnemonic, e.format, e.rd, e.rs1, e.rs2, e.rs3);
    if (!cls.isControl) continue;
    branchEvents.push({
      pc: e.pc,
      isJump: cls.isJump,
      taken: e.nextPc !== ((e.pc + e.size) >>> 0),
      target: e.nextPc >>> 0,
    });
  }
  return ALL_PREDICTORS.map((kind) => {
    const bp = new BranchPredictor(kind, entries, ghistBits, btbSets);
    for (const be of branchEvents) bp.step(be);
    return { kind, hits: bp.hits, misses: bp.misses, accuracy: bp.accuracy };
  });
}

/** Full analysis: capture the trace, run the timing model, and compare predictors. */
export function analyze(program: AssembleResult | null, config: PipelineConfig): Analysis {
  const empty = simulate([], config);
  if (!program || !program.ok) {
    return {
      ok: false,
      message: program ? 'Fix the assembler errors first.' : 'Assemble a program first.',
      traced: 0,
      truncated: false,
      halted: false,
      result: empty,
      predictorComparison: [],
    };
  }
  const { trace, halted, truncated } = captureTrace(program);
  if (trace.length === 0) {
    return {
      ok: false,
      message: 'The program retired no instructions.',
      traced: 0,
      truncated,
      halted,
      result: empty,
      predictorComparison: [],
    };
  }
  const result = simulate(trace, config);
  const predictorComparison = comparePredictors(trace, config.predictorEntries, config.ghistBits, config.btbSets);
  return {
    ok: true,
    message: truncated
      ? `Traced the first ${trace.length.toLocaleString()} instructions (hit the ${TRACE_CAP.toLocaleString()} cap).`
      : `Traced ${trace.length.toLocaleString()} retired instructions.`,
    traced: trace.length,
    truncated,
    halted,
    result,
    predictorComparison,
  };
}
