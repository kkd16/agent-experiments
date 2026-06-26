// Inspection + fuzzing helpers for `tools/check-correlate.mjs`: report whether
// correlated-branch folding fired, plus a seeded generator of programs that test
// the *same* runtime condition twice — once nested inside the other's arm — which
// the differential oracle then proves compile identically to the reference
// interpreter (and the from-scratch wasm VM) at every optimization level. Lives in
// `src/` so it bundles through the exact extensionless-TS resolution the app uses.
import { compile } from './pipeline';
import { parse } from './parser';
import { typecheck } from './types';
import { interpret } from './interp';
import { runWasm } from './runner';
import { runOnVm } from '../wasm/vm';

export interface CorrelateProbe {
  level: number;
  correlateChanged: number;
  ssaInsts: number;
  optInsts: number;
}

export function probeCorrelate(source: string, level: 0 | 1 | 2 | 3): CorrelateProbe {
  const c = compile(source, level);
  let n = 0;
  for (const s of c.optLog ?? []) if (s.name.startsWith('correlated-fold')) n += s.changed;
  return { level, correlateChanged: n, ssaInsts: c.metrics?.ssaInsts ?? 0, optInsts: c.metrics?.optInsts ?? 0 };
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

// A program that tests the same runtime predicate `P(a,b)` twice, the second test
// **nested** inside the first's taken arm (sometimes the else arm), so a dominating
// branch already settled it. GVN unifies the two identical comparisons to one value;
// correlation then folds the inner branch. Side effects (`print`) keep the arms from
// being if-converted away before correlation runs. (No division — a zero divisor
// traps, and traps aren't differential.)
export function genProgram(seed: number): string {
  const rnd = mulberry32(seed);
  const pick = <T>(xs: T[]): T => xs[Math.floor(rnd() * xs.length) % xs.length];
  const r = (lo: number, hi: number): number => lo + Math.floor(rnd() * (hi - lo + 1));
  const pred = pick([`a > b`, `a + b > ${r(2, 9)}`, `(a ^ b) > 0`, `a < ${r(1, 6)}`, `(a & 3) == 0`]);
  const inThen = rnd() < 0.6;
  const inner = inThen
    ? `  if (${pred}) { print(a); s = s + ${r(1, 5)}; } else { print(b); s = s - 1; }`
    : `    if (${pred}) { print(a + 1); s = s + 2; } else { print(b - 1); s = s - ${r(1, 4)}; }`;
  const body = inThen
    ? `  if (${pred}) {\n    s = s * 2 - 1;\n${inner}\n  } else { s = s + 7; }`
    : `  if (${pred}) { s = s + 3; }\n  else {\n    s = s - 5;\n${inner}\n  }`;
  return (
    `fn run(a: int, b: int) -> int {\n` +
    `  let s = a + b;\n` +
    `${body}\n` +
    `  return s;\n` +
    `}\n` +
    `fn main(){\n` +
    `  let g = 0;\n` +
    `  for (let k = 0; k < 90; k = k + 1) { g = g + k * 5 - 2; }\n` +
    `  for (let i = 0; i < 6; i = i + 1) { print(run((g + i) & 15, (g - i) & 7)); }\n` +
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
      if (level >= 2 && probeCorrelate(source, level).correlateChanged > 0) fired++;
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
