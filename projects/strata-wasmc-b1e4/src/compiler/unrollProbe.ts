// A tiny inspection helper used by `tools/check-unroll.mjs`: compile a program
// at a given level and report the partial-unroll pass's activity plus the loop
// structure of the result, so the dev loop can confirm the strider actually
// fired (and didn't merely no-op). Lives in `src/` so it bundles through the
// exact extensionless-TS resolution the app uses; it is referenced only by the
// headless tool, never the app UI.
import { compile } from './pipeline';
import { findNaturalLoops } from './ir/loops';
import { analyzeLoops } from './loopAnalysis';
import type { IRModule } from './ir/ir';

export interface UnrollProbe {
  level: number;
  partialUnrollChanged: number;
  loopsBefore: number;
  loopsAfter: number;
  optInsts: number;
  ssaInsts: number;
  /** Per-function loop kinds in the optimized IR, e.g. "f:[strided-main,counted]". */
  kinds: string;
}

function countLoops(mod: IRModule | undefined): number {
  if (!mod) return 0;
  let n = 0;
  for (const fn of mod.funcs) n += findNaturalLoops(fn).length;
  return n;
}

export function probeUnroll(source: string, level: 0 | 1 | 2 | 3): UnrollProbe {
  const c = compile(source, level);
  const stat = c.optLog?.find((s) => s.name === 'partial-unroll');
  const kinds = (c.optimized?.funcs ?? [])
    .map((fn) => {
      const ks = analyzeLoops(fn).map((l) => l.kind);
      return ks.length ? `${fn.name}:[${ks.join(',')}]` : '';
    })
    .filter(Boolean)
    .join(' ');
  return {
    level,
    partialUnrollChanged: stat?.changed ?? 0,
    loopsBefore: countLoops(c.ssa),
    loopsAfter: countLoops(c.optimized),
    optInsts: c.metrics?.optInsts ?? 0,
    ssaInsts: c.metrics?.ssaInsts ?? 0,
    kinds,
  };
}
