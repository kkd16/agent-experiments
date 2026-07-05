// Inspection + fuzzing helpers for `tools/check-vrp.mjs`: report whether
// value-range propagation fired, plus a seeded generator of programs stuffed with
// comparisons a *range* (not an identical dominating test) decides — masks,
// remainders, bit-counts, chained guards — which the triple differential oracle
// then proves compile identically to the reference interpreter (and the
// from-scratch wasm VM) at every optimization level. Lives in `src/` so it bundles
// through the exact extensionless-TS resolution the app uses.
import { compile } from './pipeline';
import { parse } from './parser';
import { typecheck } from './types';
import { interpret } from './interp';
import { runWasm } from './runner';
import { runOnVm } from '../wasm/vm';

export interface VrpProbe {
  level: number;
  vrpChanged: number;
  ssaInsts: number;
  optInsts: number;
}

export function probeVrp(source: string, level: 0 | 1 | 2 | 3): VrpProbe {
  const c = compile(source, level);
  let n = 0;
  for (const s of c.optLog ?? []) if (s.name.startsWith('value-range-prop')) n += s.changed;
  return { level, vrpChanged: n, ssaInsts: c.metrics?.ssaInsts ?? 0, optInsts: c.metrics?.optInsts ?? 0 };
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

// A program whose control flow mixes comparisons that a *derived range* settles
// (so VRP folds them) with genuine input-dependent branches (so the output still
// depends on `a`/`b` and a wrong fold would be caught). Every divisor/modulus is a
// nonzero constant and every value is mask-bounded, so nothing traps — a trap's
// message isn't differential.
export function genProgram(seed: number): string {
  const rnd = mulberry32(seed);
  const pick = <T>(xs: T[]): T => xs[Math.floor(rnd() * xs.length) % xs.length];
  const r = (lo: number, hi: number): number => lo + Math.floor(rnd() * (hi - lo + 1));

  const maskX = pick([7, 15, 31, 63]);
  const maskY = pick([3, 7, 15]);
  const modC = pick([5, 8, 10, 16]);
  // A comparison VRP can always decide from `x ∈ [0, maskX]`.
  const alwaysTrue = pick([`x < ${maskX + r(1, 20)}`, `x >= 0`, `x <= ${maskX}`, `(x % ${modC}) < ${modC}`, `popcount(x) <= 32`]);
  const alwaysFalse = pick([`x > ${maskX + r(1, 20)}`, `x < 0`, `y >= ${maskY + r(1, 9)}`, `(y % ${modC}) >= ${modC}`]);
  // A genuine runtime branch (VRP must decline) — keeps the output input-sensitive.
  const runtime = pick([`x > y`, `x + y > ${r(2, 12)}`, `(x ^ y) < ${r(1, 8)}`, `x == y`]);

  const body =
    `  let x = a & ${maskX};\n` +
    `  let y = b & ${maskY};\n` +
    `  let s = x * 3 + y;\n` +
    `  if (${alwaysTrue}) { s = s + ${r(1, 5)}; } else { print(9990 + s); s = s - 7; }\n` +
    `  if (${alwaysFalse}) { print(8880 + s); s = s * 2; } else { s = s + ${r(1, 5)}; }\n` +
    `  if (${runtime}) { s = s + x; if (${runtime}) { print(s); s = s + 1; } } else { s = s - y; }\n` +
    `  let q = x % ${modC};\n` +
    `  if (q >= 0) { s = s + q; } else { print(7770); }\n` +
    `  return s;\n`;

  return (
    `fn run(a: int, b: int) -> int {\n${body}}\n` +
    `fn main(){\n` +
    `  let g = 0;\n` +
    `  for (let k = 0; k < 40; k = k + 1) { g = g + k * 7 - 3; }\n` +
    `  for (let i = 0; i < 8; i = i + 1) { print(run((g + i) & 255, (g - i * 3) & 127)); }\n` +
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
      if (level >= 2 && probeVrp(source, level).vrpChanged > 0) fired++;
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
