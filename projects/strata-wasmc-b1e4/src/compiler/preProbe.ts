// Inspection + fuzzing helpers for `tools/check-pre.mjs`: report whether GVN-PRE
// fired, plus a seeded generator of programs carrying a *partial* redundancy — an
// expression computed on some-but-not-all paths into a merge and recomputed
// after it — which the differential oracle then proves compile identically to the
// reference interpreter (and the from-scratch wasm VM) at every optimization
// level. Lives in `src/` so it bundles through the exact extensionless-TS
// resolution the app uses; referenced only by the headless tool.
import { compile } from './pipeline';
import { parse } from './parser';
import { typecheck } from './types';
import { interpret } from './interp';
import { runWasm } from './runner';
import { runOnVm } from '../wasm/vm';

export interface PreProbe {
  level: number;
  preChanged: number;
  ssaInsts: number;
  optInsts: number;
}

export function probePre(source: string, level: 0 | 1 | 2 | 3): PreProbe {
  const c = compile(source, level);
  let pre = 0;
  for (const s of c.optLog ?? []) if (s.name.startsWith('pre')) pre += s.changed;
  return { level, preChanged: pre, ssaInsts: c.metrics?.ssaInsts ?? 0, optInsts: c.metrics?.optInsts ?? 0 };
}

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

// A program with a partial redundancy that the upstream passes leave for PRE.
// The expression `e` is computed inside a guarded arm (a `print` there keeps the
// diamond from being if-converted, and the arm doesn't dominate the merge so GVN
// can't dedupe), then recomputed after the merge where it is redundant on the
// arm-taken path. PRE inserts `e` on the lacking edge and fuses the two with a φ.
// Variants add a second branch, a loop-carried recomputation, and a non-trapping
// operand mix (no `/` or `%` — a zero divisor traps, and traps aren't differential).
export function genProgram(seed: number): string {
  const rnd = mulberry32(seed);
  const pick = <T>(xs: T[]): T => xs[Math.floor(rnd() * xs.length) % xs.length];
  const r = (lo: number, hi: number): number => lo + Math.floor(rnd() * (hi - lo + 1));
  const vars = ['a', 'b', 'c', 'd'];
  const expr = (depth: number): string => {
    if (depth <= 0 || rnd() < 0.3) return rnd() < 0.55 ? pick(vars) : String(r(-4, 7));
    const op = pick(['+', '-', '*', '&', '|', '^']);
    return `(${expr(depth - 1)} ${op} ${expr(depth - 1)})`;
  };
  const e = expr(3);
  const e2 = expr(2);
  const cond1 = pick(['a > b', 'c < d', '(a ^ c) > 0', 'b == 0', 'a + b > 3', '(d & 1) == 0']);
  const cond2 = pick(['c > a', 'd < b', '(b ^ d) > 1', 'a == c', 'b + d > 2']);
  const seedBlock =
    `  let g = 0;\n` +
    `  for (let k = 0; k < ${r(40, 160)}; k = k + 1) { g = g + k * 3 - 1; }\n` +
    `  let a = (g & 15) - ${r(2, 8)};\n` +
    `  let b = (g & 7) - ${r(1, 4)};\n` +
    `  let c = (g & 31) - 12;\n` +
    `  let d = (g & 3) + ${r(1, 5)};\n` +
    `  let s = 0;\n`;

  const variant = seed % 4;
  if (variant === 0) {
    // single guarded arm, recomputed after the merge
    return (
      `fn main() {\n${seedBlock}` +
      `  if (${cond1}) {\n    let t = ${e};\n    print(t);\n    s = s + 1;\n  }\n` +
      `  let z = ${e};\n  print(z);\n  print(s);\n}\n`
    );
  }
  if (variant === 1) {
    // two arms, only one computes e; recomputed after
    return (
      `fn main() {\n${seedBlock}` +
      `  if (${cond1}) {\n    let t = ${e};\n    print(t);\n    s = s + a;\n  } else {\n    print(s - 1);\n    s = s - b;\n  }\n` +
      `  let z = ${e};\n  print(z + s);\n}\n`
    );
  }
  if (variant === 2) {
    // nested: e computed in the inner then, recomputed at the outer merge
    return (
      `fn main() {\n${seedBlock}` +
      `  if (${cond1}) {\n    if (${cond2}) {\n      let t = ${e};\n      print(t);\n    }\n    s = s + c;\n  }\n` +
      `  let z = ${e};\n  let w = ${e2};\n  print(z - w + s);\n}\n`
    );
  }
  // loop-carried: e recomputed each iteration but partially redundant across the
  // back edge once a guarded arm has produced it.
  return (
    `fn main() {\n${seedBlock}` +
    `  for (let i = 0; i < ${r(3, 9)}; i = i + 1) {\n` +
    `    if (${cond1}) {\n      let t = ${e};\n      print(t);\n      s = s + 1;\n    }\n` +
    `    let z = ${e};\n    print(z);\n  }\n` +
    `  print(s);\n}\n`
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
      if (level >= 2 && probePre(source, level).preChanged > 0) fired++;
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
