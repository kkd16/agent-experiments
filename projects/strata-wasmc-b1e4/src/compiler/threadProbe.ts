// Inspection + fuzzing helpers for `tools/check-thread.mjs`: report whether jump
// threading fired, plus a seeded generator of programs whose branch condition is a
// pure **cone** (`icmp`/`ibin`) over a per-edge-constant flag phi — the shape the
// generalized threader folds per-edge — which the differential oracle then proves
// compile identically to the reference interpreter (and the from-scratch wasm VM)
// at every optimization level. Lives in `src/` so it bundles through the exact
// extensionless-TS resolution the app uses; referenced only by the headless tool.
import { compile } from './pipeline';
import { parse } from './parser';
import { typecheck } from './types';
import { interpret } from './interp';
import { runWasm } from './runner';
import { runOnVm } from '../wasm/vm';

export interface ThreadProbe {
  level: number;
  threadChanged: number;
  ssaInsts: number;
  optInsts: number;
}

export function probeThread(source: string, level: 0 | 1 | 2 | 3): ThreadProbe {
  const c = compile(source, level);
  let th = 0;
  for (const s of c.optLog ?? []) if (s.name.startsWith('jump-thread')) th += s.changed;
  return { level, threadChanged: th, ssaInsts: c.metrics?.ssaInsts ?? 0, optInsts: c.metrics?.optInsts ?? 0 };
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

// A program that sets an integer flag to one of two constants on a runtime branch,
// then later tests a **comparison/arithmetic cone over that flag** (not the flag
// itself). The flag phi is a meet of two constants, so SCCP sees it as unknown and
// can't fold the test — but on each incoming edge the flag *is* a constant, so the
// generalized threader folds the cone per-edge and routes the branch directly. A
// `print` in each arm keeps it unspeculable (if-conversion declines), so the cone
// survives to the threader. (No division — a zero divisor traps, not differential.)
export function genProgram(seed: number): string {
  const rnd = mulberry32(seed);
  const pick = <T>(xs: T[]): T => xs[Math.floor(rnd() * xs.length) % xs.length];
  const r = (lo: number, hi: number): number => lo + Math.floor(rnd() * (hi - lo + 1));
  const A = r(0, 3);
  const B = r(4, 9);
  const cone = pick([
    `flag == 0`,
    `flag != 0`,
    `flag > ${r(1, 6)}`,
    `flag < ${r(2, 7)}`,
    `(flag & 1) == 0`,
    `(flag - ${r(1, 3)}) > 0`,
    `(flag | 1) > ${r(2, 8)}`,
    `(flag * 3 - 2) > ${r(3, 12)}`,
  ]);
  const setCond = pick([`n > 5`, `n % 2 == 0`, `n < 3`, `(n & 2) == 0`]);
  const t2 = rnd() < 0.5 ? `\n  let g = flag + ${r(1, 4)};\n  if (g > ${r(3, 9)}) { print(g); } else { print(-g); }` : '';
  return (
    `fn run(n: int) -> void {\n` +
    `  let flag = ${A};\n` +
    `  if (${setCond}) { flag = ${B}; print(n); }\n` +
    `  if (${cone}) { print(100 + flag); } else { print(200 - flag); }${t2}\n` +
    `}\n` +
    `fn main(){ for (let i = 0; i < 8; i = i + 1) { run(i); } }\n`
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
      if (probeThread(source, level).threadChanged > 0) fired++;
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
