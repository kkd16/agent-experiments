// Inspection + fuzzing helpers for `tools/check-sink.mjs`: report whether code
// sinking fired, plus a seeded generator of programs that compute a pure value
// used on only one arm of a runtime branch — the shape sinking targets — which
// the differential oracle then proves compile identically to the reference
// interpreter at every optimization level. Lives in `src/` so it bundles through
// the exact extensionless-TS resolution the app uses; referenced only by the
// headless tool, never the app UI.
import { compile } from './pipeline';
import { parse } from './parser';
import { typecheck } from './types';
import { interpret } from './interp';
import { runWasm } from './runner';
import { runOnVm } from '../wasm/vm';

export interface SinkProbe {
  level: number;
  sinkChanged: number;
  ssaInsts: number;
  optInsts: number;
}

export function probeSink(source: string, level: 0 | 1 | 2 | 3): SinkProbe {
  const c = compile(source, level);
  let sink = 0;
  for (const s of c.optLog ?? []) if (s.name.startsWith('sink')) sink += s.changed;
  return { level, sinkChanged: sink, ssaInsts: c.metrics?.ssaInsts ?? 0, optInsts: c.metrics?.optInsts ?? 0 };
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

// A program that builds runtime values (seed loop too long to unroll, so SCCP
// can't fold them), computes a pure value `t` from them, then branches on a
// runtime condition and uses `t` on **only one** arm. A `print` on the using arm
// keeps it non-speculable so if-conversion (which would make `t` unconditional)
// declines, leaving a real branch for sinking. Both arms reachable across the
// call spread, so the differential oracle exercises the sunk and the not-sunk
// path. (No division — a zero divisor traps, and traps aren't differential.)
export function genProgram(seed: number): string {
  const rnd = mulberry32(seed);
  const pick = <T>(xs: T[]): T => xs[Math.floor(rnd() * xs.length) % xs.length];
  const r = (lo: number, hi: number): number => lo + Math.floor(rnd() * (hi - lo + 1));
  const vars = ['a', 'b', 'c'];
  const expr = (depth: number): string => {
    if (depth <= 0 || rnd() < 0.3) return rnd() < 0.5 ? pick(vars) : String(r(-5, 9));
    return `(${expr(depth - 1)} ${pick(['+', '-', '*', '&', '|', '^'])} ${expr(depth - 1)})`;
  };
  const cond = pick(['a > b', 'c < 4', '(a ^ c) > 0', 'b == 0', 'a + b > 5']);
  const useT = pick(['s = s + t * 2 - a;', 'print(t); s = s + t;', 's = (s ^ t) + b;']);
  const elseArm = pick(['s = s - b;', 'print(c); s = s + a;', 's = (s | a) - c;']);
  // Optionally a second, independent sinkable value used only on the else arm.
  const second = rnd() < 0.5;
  return (
    `fn main() {\n` +
    `  let g = 0;\n` +
    `  for (let k = 0; k < ${r(90, 220)}; k = k + 1) { g = g + k * 3 - 1; }\n` +
    `  let a = (g & 15) - ${r(2, 8)};\n` +
    `  let b = (g & 7) - ${r(1, 4)};\n` +
    `  let c = (g & 31) - 12;\n` +
    `  let t = ${expr(3)};\n` +
    (second ? `  let u = ${expr(3)};\n` : '') +
    `  let s = a + b + c;\n` +
    `  if (${cond}) {\n    ${useT}\n  } else {\n    ${second ? `s = s + u * 3;\n    ` : ''}${elseArm}\n  }\n` +
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
      if (level >= 2 && probeSink(source, level).sinkChanged > 0) fired++;
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
