// Inspection + fuzzing helpers for `tools/check-purity.mjs`: report whether the
// interprocedural purity optimizations fired (redundant `pure` calls CSE-d away,
// loop-invariant `pure` calls hoisted, dead `pure` calls dropped) — and, crucially,
// whether they correctly *declined* on impure callees (ones that print, write a
// global, or read memory). A seeded differential fuzzer then proves every generated
// program compiles to wasm that prints exactly what the reference interpreter and
// the from-scratch wasm VM print, at -O0..-O3. Lives in `src/` so it bundles through
// the same extensionless-TS resolution the app uses; referenced only by the tool.
import { compile } from './pipeline';
import { parse } from './parser';
import { typecheck } from './types';
import { interpret } from './interp';
import { runWasm } from './runner';
import { runOnVm } from '../wasm/vm';
import { toSSA } from './ir/ssa';
import { buildPreIR } from './ir/builder';
import { analyzeEffects } from './ir/effects';
import type { IRModule } from './ir/ir';

export interface PurityProbe {
  level: number;
  /** Total number of `call` instructions surviving in the optimized module. */
  callInsts: number;
  /** Changes attributed to GVN/CSE (which removes redundant `pure` calls). */
  gvnChanged: number;
  /** Changes attributed to LICM (which hoists invariant `pure` calls). */
  licmChanged: number;
  /** Functions the analysis proved `pure` / `pureNoTrap`, on the unoptimized SSA. */
  pure: string[];
  pureNoTrap: string[];
}

function countCalls(mod: IRModule): number {
  let n = 0;
  for (const fn of mod.funcs) for (const b of fn.blocks) for (const i of b.insts) if (i.kind === 'call') n++;
  return n;
}

export function probePurity(source: string, level: 0 | 1 | 2 | 3): PurityProbe {
  const c = compile(source, level);
  let gvn = 0;
  let licm = 0;
  for (const s of c.optLog ?? []) {
    if (s.name.startsWith('gvn')) gvn += s.changed;
    if (s.name.startsWith('licm')) licm += s.changed;
  }
  // Classify on the unoptimized SSA so the reported sets reflect the source as
  // written, independent of what the optimizer later deletes.
  const program = parse(source);
  typecheck(program);
  const ssa = toSSA(buildPreIR(program));
  const info = analyzeEffects(ssa);
  const pure: string[] = [];
  const pureNoTrap: string[] = [];
  for (const fn of ssa.funcs) {
    if (info.pure(fn.name)) pure.push(fn.name);
    if (info.pureNoTrap(fn.name)) pureNoTrap.push(fn.name);
  }
  return {
    level,
    callInsts: c.optimized ? countCalls(c.optimized) : -1,
    gvnChanged: gvn,
    licmChanged: licm,
    pure,
    pureNoTrap,
  };
}

// ---------------------------------------------------------------------------
// A seeded generator of programs that mix a *pure* helper (arithmetic only, so
// it is referentially transparent) with an *impure* helper (it prints, so it
// must never be deduplicated), and call the pure one redundantly, inside a loop,
// and with a dead result. The differential oracle then proves behaviour is
// identical at every optimization level — a pure call that was wrongly removed,
// or an impure call wrongly merged, changes the printed output and fails.
// ---------------------------------------------------------------------------

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
  // A pure arithmetic helper — no prints, no globals, no memory. Wrapping i32
  // arithmetic only (no divide, so it is also non-trapping → hoistable/droppable).
  const op = pick(['+', '-', '*']);
  const op2 = pick(['+', '-', '*']);
  const k1 = r(1, 9);
  const k2 = r(1, 7);
  const pureBody = `return (x ${op} y) ${op2} (x * ${k1} - y * ${k2});`;
  // A second pure helper that calls the first (tests transitive purity).
  const mixBody = `return mix(x, y) ${pick(['+', '-'])} mix(y, x);`;
  // An impure helper: it prints, so two calls are observably distinct and must
  // never be merged, hoisted, or dropped.
  const noiseK = r(1, 5);
  const a0 = r(-30, 30);
  const b0 = r(-20, 20);
  const n = r(3, 9);
  return (
    `fn mix(x: int, y: int) -> int { ${pureBody} }\n` +
    `fn combine(x: int, y: int) -> int { ${mixBody} }\n` +
    `fn noisy(x: int) -> int { print(x); return x ${pick(['+', '-'])} ${noiseK}; }\n` +
    `fn main() {\n` +
    `  let a = ${a0};\n` +
    `  let b = ${b0};\n` +
    // redundant pure call: combine(a,b) computed twice — CSE should keep one
    `  let r1 = combine(a, b) + combine(a, b) * 2;\n` +
    // loop-invariant pure call: mix(a,b) does not depend on i — LICM should hoist
    `  let acc = 0;\n` +
    `  for (let i = 0; i < ${n}; i = i + 1) { acc = acc + mix(a, b) + i; }\n` +
    // dead pure call: result unused — DCE should drop it
    `  let dead = mix(a + 1, b - 1);\n` +
    // impure calls must survive verbatim and in order
    `  let s = noisy(a) + noisy(b) + noisy(a);\n` +
    `  print(r1);\n  print(acc);\n  print(s);\n` +
    `}\n`
  );
}

export interface FuzzResult {
  total: number;
  pass: number;
  firedGvn: number;
  firedLicm: number;
  failures: { seed: number; level: number; detail: string }[];
}

export async function fuzz(seeds: number[], levels: (0 | 1 | 2 | 3)[]): Promise<FuzzResult> {
  let total = 0;
  let pass = 0;
  let firedGvn = 0;
  let firedLicm = 0;
  const failures: { seed: number; level: number; detail: string }[] = [];
  for (const seed of seeds) {
    const source = genProgram(seed);
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
      if (level >= 2) {
        const p = probePurity(source, level);
        if (p.gvnChanged > 0) firedGvn++;
        if (p.licmChanged > 0) firedLicm++;
      }
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
  return { total, pass, firedGvn, firedLicm, failures };
}
