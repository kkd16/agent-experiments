// Inspection + fuzzing helpers for `tools/check-unswitch.mjs`: compile a program
// and report whether loop unswitching fired, plus a seeded generator of random
// loops-with-invariant-branches that the differential oracle then proves are
// compiled identically to the reference interpreter at every optimization level.
// Lives in `src/` so it bundles through the exact extensionless-TS resolution the
// app uses; referenced only by the headless tool, never the app UI.
import { compile } from './pipeline';
import { findNaturalLoops } from './ir/loops';
import { parse } from './parser';
import { typecheck } from './types';
import { interpret } from './interp';
import { runWasm } from './runner';
import { runOnVm } from '../wasm/vm';
import { dumpModule } from './irdump';
import type { IRModule } from './ir/ir';

export interface UnswitchProbe {
  level: number;
  unswitchChanged: number;
  loopsBefore: number;
  loopsAfter: number;
  ssaInsts: number;
  optInsts: number;
}

function countLoops(mod: IRModule | undefined): number {
  if (!mod) return 0;
  let n = 0;
  for (const fn of mod.funcs) n += findNaturalLoops(fn).length;
  return n;
}

/** The optimized IR as text, for eyeballing that the branch really left the loop. */
export function dumpOptimized(source: string, level: 0 | 1 | 2 | 3): string {
  const c = compile(source, level);
  return c.optimized ? dumpModule(c.optimized) : '';
}

export function probeUnswitch(source: string, level: 0 | 1 | 2 | 3): UnswitchProbe {
  const c = compile(source, level);
  const stat = c.optLog?.find((s) => s.name === 'loop-unswitch');
  return {
    level,
    unswitchChanged: stat?.changed ?? 0,
    loopsBefore: countLoops(c.ssa),
    loopsAfter: countLoops(c.optimized),
    ssaInsts: c.metrics?.ssaInsts ?? 0,
    optInsts: c.metrics?.optInsts ?? 0,
  };
}

// --- a seeded random program generator ------------------------------------
// Each program is a function with a counted loop carrying an accumulator and a
// loop-*invariant* branch (on a parameter flag, or a value computed before the
// loop), plus possibly a second invariant branch and a nested loop — exactly the
// shapes unswitching targets. `main` calls it across a spread of arguments so the
// printed trace exercises both branch directions and several trip counts.

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function genProgram(seed: number): string {
  const rnd = mulberry32(seed);
  const pick = <T>(xs: T[]): T => xs[Math.floor(rnd() * xs.length) % xs.length];
  const r = (lo: number, hi: number): number => lo + Math.floor(rnd() * (hi - lo + 1));

  // An expression over the in-scope integer variables, kept small and total
  // (no division — a zero divisor would trap and traps aren't differential).
  const vars = ['s', 'i', 'a', 'b'];
  const expr = (depth: number): string => {
    if (depth <= 0 || rnd() < 0.35) {
      return rnd() < 0.5 ? pick(vars) : String(r(-6, 9));
    }
    const op = pick(['+', '-', '*', '&', '|', '^']);
    return `(${expr(depth - 1)} ${op} ${expr(depth - 1)})`;
  };
  const stmt = (): string => `s = ${expr(2)};`;

  // The invariant branches test flags built from `a`/`b`, which are *runtime*
  // values: they are derived below from loops whose trip counts exceed the
  // full-unroll limit, so SCCP cannot fold them to constants. That keeps the
  // flag a genuine loop-invariant runtime value — exactly what unswitching is
  // for (a constant flag would just be folded by SCCP, with no loop to clone).
  const flagExpr = pick(['a > b', 'a < 5', '(a ^ b) > 0', 'b == 0', 'a + b > 7']);
  const cmp = pick(['<', '<=', '>', '>=']);
  const stepUp = cmp === '<' || cmp === '<=';

  // Optionally a second invariant flag and/or a nested counted loop.
  const second = rnd() < 0.5;
  const flag2 = pick(['b > a', 'a == 3', 'b < 4']);
  const nested = rnd() < 0.5;
  const innerBound = r(2, 5);

  const inner = nested
    ? `    for (let j = 0; j < ${innerBound}; j = j + 1) { s = s + ${expr(1)}; if (${flagExpr}) { s = s + j; } }\n`
    : '';
  const arm = (sign: string): string => `${stmt()} s = s ${sign} ${r(2, 7)};`;
  const secondBranch = second ? `    if (${flag2}) { ${arm('+')} } else { ${arm('-')} }\n` : '';

  const guard = stepUp ? `i ${cmp} n` : `i ${cmp} 0`;
  const initI = stepUp ? '0' : 'n';
  const step = stepUp ? 'i = i + 1' : 'i = i - 1';

  // Two long seed loops (trip counts past the unroll limit ⇒ runtime-opaque),
  // then the runtime flag/bound values they feed, then the loop we unswitch.
  return (
    `fn main() {\n` +
    `  let p = 0;\n` +
    `  for (let k = 0; k < ${r(90, 240)}; k = k + 1) { p = p + k * 3 - 1; }\n` +
    `  let q = 1;\n` +
    `  for (let k = 0; k < ${r(90, 200)}; k = k + 1) { q = q ^ (k + 7); }\n` +
    `  let a = (p & 15) - ${r(2, 8)};\n` +
    `  let b = (q & 7) - ${r(1, 4)};\n` +
    `  let n = (p & 31) + ${r(3, 9)};\n` +
    `  let s = a + b;\n` +
    `  for (let i = ${initI}; ${guard}; ${step}) {\n` +
    `    if (${flagExpr}) {\n` +
    `      ${arm('+')}\n` +
    `    } else {\n` +
    `      ${arm('*')}\n` +
    `    }\n` +
    secondBranch +
    inner +
    `  }\n` +
    `  print(s);\n` +
    `}\n`
  );
}

export interface FuzzResult {
  total: number;
  pass: number;
  fired: number;
  failures: { seed: number; level: number; detail: string }[];
}

export async function fuzz(seeds: number[], levels: (0 | 1 | 2 | 3)[]): Promise<FuzzResult> {
  let total = 0;
  let pass = 0;
  let fired = 0;
  const failures: { seed: number; level: number; detail: string }[] = [];
  for (const seed of seeds) {
    const source = genProgram(seed);
    // Reference output from the tree-walking interpreter (level-independent).
    let ref: ReturnType<typeof interpret>;
    try {
      const program = parse(source);
      typecheck(program);
      ref = interpret(program);
    } catch (e) {
      failures.push({ seed, level: -1, detail: 'reference failed: ' + (e as Error).message });
      continue;
    }
    for (const level of levels) {
      total++;
      const probe = probeUnswitch(source, level);
      if (level >= 2 && probe.unswitchChanged > 0) fired++;
      const comp = compile(source, level);
      if (!comp.ok || !comp.bytes) {
        failures.push({ seed, level, detail: 'compile error: ' + (comp.error?.message ?? '?') });
        continue;
      }
      const run = await runWasm(comp.bytes);
      const vm = runOnVm(comp.bytes);
      const sameOut = JSON.stringify(ref.output) === JSON.stringify(run.output);
      const sameVm = JSON.stringify(ref.output) === JSON.stringify(vm.output);
      if (sameOut && sameVm) pass++;
      else
        failures.push({
          seed,
          level,
          detail: `ref=${JSON.stringify(ref.output)} wasm=${JSON.stringify(run.output)} vm=${JSON.stringify(vm.output)}`,
        });
    }
  }
  return { total, pass, fired, failures };
}
