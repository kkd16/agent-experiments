// The differential oracle: assemble + run two assembly programs on throwaway, history-free CPUs
// and decide whether they are observably equivalent.
//
// "Observable" means exactly what a user can see: the console output, how the program halted, and
// its exit/return code (a0 at the exit syscall). It deliberately does NOT compare the full register
// file or stack memory — a correct optimization routinely leaves dead temporaries in different
// states, and that is not an observable difference. This is the safety net every optimization is
// checked against, both in the self-test suite and live in the Optimizer tab.

import { assemble } from '../vm/assembler';
import { Cpu } from '../vm/cpu';

export type Verdict = 'equivalent' | 'different' | 'inconclusive';

export interface RunObs {
  ok: boolean;
  assembleError?: string;
  halted: boolean;
  status: string;
  output: string;
  exitCode: number; // a0 at halt
  steps: number;
}

const STEP_BUDGET = 5_000_000;

export function runProgram(src: string, budget = STEP_BUDGET): RunObs {
  const a = assemble(src, { compress: false });
  if (!a.ok) {
    return {
      ok: false,
      assembleError: a.errors.map((e) => `line ${e.line}: ${e.message}`).join('; '),
      halted: false, status: 'asm-error', output: '', exitCode: 0, steps: 0,
    };
  }
  const cpu = new Cpu();
  cpu.recordHistory = false;
  cpu.load(a);
  let steps = 0;
  while (!cpu.isStopped() && steps < budget) {
    if (!cpu.step()) break;
    steps++;
  }
  return {
    ok: true,
    halted: cpu.status === 'halted',
    status: cpu.status,
    output: cpu.output,
    exitCode: cpu.regs[10] | 0, // a0
    steps,
  };
}

export interface EquivResult {
  verdict: Verdict;
  reason: string;
  before: RunObs;
  after: RunObs;
}

export function checkEquivalence(beforeSrc: string, afterSrc: string, budget = STEP_BUDGET): EquivResult {
  const before = runProgram(beforeSrc, budget);
  const after = runProgram(afterSrc, budget);

  if (!before.ok) return verdict('inconclusive', `original did not assemble: ${before.assembleError}`, before, after);
  if (!after.ok) return verdict('different', `optimized program failed to assemble: ${after.assembleError}`, before, after);
  if (!before.halted || !after.halted) {
    if (before.status === after.status && before.output === after.output) {
      return verdict('inconclusive', `neither program halted within ${budget.toLocaleString()} steps`, before, after);
    }
    return verdict('inconclusive', 'a program did not halt within the step budget', before, after);
  }
  if (before.output !== after.output) return verdict('different', 'console output differs', before, after);
  if (before.exitCode !== after.exitCode) {
    return verdict('different', `exit code differs (${before.exitCode} vs ${after.exitCode})`, before, after);
  }
  return verdict('equivalent', 'identical console output and exit code', before, after);
}

function verdict(v: Verdict, reason: string, before: RunObs, after: RunObs): EquivResult {
  return { verdict: v, reason, before, after };
}
