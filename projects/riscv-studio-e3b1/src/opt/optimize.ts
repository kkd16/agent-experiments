// The optimization driver: run a pipeline of passes over the module to a fixpoint, recording every
// change. The pipeline is ordered so each pass feeds the next (simplify exposes copies → propagate
// threads values → control-flow folds branches → dead-code reaps the remains), and the whole thing
// repeats until a full round changes nothing.

import type { Module } from './ir';
import { parseModule } from './parse';
import { printModule, textInstrs } from './ir';
import { buildCfg } from './cfg';
import { PassCtx } from './pass';
import type { Pass, Change } from './pass';
import { simplifyPass } from './passes/simplify';
import { propagatePass } from './passes/propagate';
import { dcePass } from './passes/dce';
import { stackForwardPass, deadStackPass } from './passes/stack';
import { controlPass } from './passes/control';
import { csePass } from './passes/cse';

export const DEFAULT_PIPELINE: Pass[] = [
  simplifyPass,
  propagatePass,
  csePass,
  stackForwardPass,
  deadStackPass,
  controlPass,
  dcePass,
];

export interface OptStats {
  instrsBefore: number;
  instrsAfter: number;
  blocksBefore: number;
  blocksAfter: number;
  rounds: number;
  removed: number;
  byPass: { name: string; changes: number }[];
}

export interface OptResult {
  module: Module;
  asm: string;
  log: Change[];
  stats: OptStats;
}

const MAX_ROUNDS = 24;

export function optimizeModule(m: Module, pipeline: Pass[] = DEFAULT_PIPELINE): OptResult {
  const ctx = new PassCtx();
  const instrsBefore = textInstrs(m).length;
  const blocksBefore = buildCfg(m).blocks.length;

  let rounds = 0;
  for (; rounds < MAX_ROUNDS; rounds++) {
    let roundChanges = 0;
    for (const pass of pipeline) roundChanges += pass.run(m, ctx);
    if (roundChanges === 0) break;
  }

  const instrsAfter = textInstrs(m).length;
  const blocksAfter = buildCfg(m).blocks.length;
  const byPass = pipeline.map((p) => ({ name: p.name, changes: ctx.countFor(p.name) }));

  return {
    module: m,
    asm: printModule(m),
    log: ctx.changes,
    stats: {
      instrsBefore,
      instrsAfter,
      blocksBefore,
      blocksAfter,
      rounds: rounds + 1,
      removed: instrsBefore - instrsAfter,
      byPass,
    },
  };
}

/** Convenience: optimize assembly text → optimized assembly text + report. */
export function optimizeAsm(src: string, pipeline: Pass[] = DEFAULT_PIPELINE): OptResult {
  return optimizeModule(parseModule(src), pipeline);
}
