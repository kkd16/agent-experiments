// Inspection + fuzzing helpers for `tools/check-knownbits.mjs`: report whether the
// known-bits (bitwise) pass fired, plus a seeded generator of programs stuffed with
// bit-plumbing — masks, shifts, or/xor toggles, alignment sums, parity/mask
// comparisons — that a *per-bit* fact (not a magnitude range) decides, which the
// triple differential oracle then proves compile identically to the reference
// interpreter (and the from-scratch wasm VM) at every optimization level. Lives in
// `src/` so it bundles through the exact extensionless-TS resolution the app uses.
import { compile } from './pipeline';
import { parse } from './parser';
import { typecheck } from './types';
import { interpret } from './interp';
import { runWasm } from './runner';
import { runOnVm } from '../wasm/vm';

export interface KbProbe {
  level: number;
  kbChanged: number;
  ssaInsts: number;
  optInsts: number;
}

export function probeKb(source: string, level: 0 | 1 | 2 | 3): KbProbe {
  const c = compile(source, level);
  let n = 0;
  for (const s of c.optLog ?? []) if (s.name.startsWith('known-bits')) n += s.changed;
  return { level, kbChanged: n, ssaInsts: c.metrics?.ssaInsts ?? 0, optInsts: c.metrics?.optInsts ?? 0 };
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

// A program that computes bit-plumbed quantities and branches on facts a *per-bit*
// lattice settles: a value that masks/shifts down to a constant, a redundant mask,
// a parity/low-bit comparison. It interleaves those with genuine input-dependent
// branches so the output still depends on `a`/`b` and a wrong bit-fold is caught.
// Every shift amount is a small constant and every divisor is nonzero, so nothing
// traps (a trap message is not differential).
export function genProgram(seed: number): string {
  const rnd = mulberry32(seed);
  const pick = <T>(xs: T[]): T => xs[Math.floor(rnd() * xs.length) % xs.length];
  const r = (lo: number, hi: number): number => lo + Math.floor(rnd() * (hi - lo + 1));

  const shA = pick([1, 2, 3, 4]);
  const shB = pick([2, 4, 8]);
  const maskLo = pick([1, 3, 7, 15]);
  const setBit = pick([1, 2, 4, 8]);
  // A value whose low `shA` bits are provably zero (known-bits proves the mask/shr
  // that reads them is constant); combined so the whole thing stays a real value.
  const aligned = `((a << ${shA}) + (b << ${shA}))`;
  // A comparison known-bits can always decide from the low bits it pins.
  const alwaysTrue = pick([
    `(${aligned} & ${(1 << shA) - 1}) == 0`, // low shA bits are zero
    `((x | ${setBit}) & ${setBit}) == ${setBit}`, // a set bit stays set
    `(x & 0) == 0`,
    `((x ^ x) | 0) == 0`,
  ]);
  const alwaysFalse = pick([
    `(x | 1) == 0`, // odd number is never zero
    `(${aligned} & 1) != 0`, // an even value never has bit 0 set
    `((x << ${shB}) & ${(1 << shB) - 1}) != 0`,
  ]);
  // A genuine runtime branch (known-bits must decline) — keeps the output sensitive.
  const runtime = pick([`x > y`, `x + y > ${r(2, 12)}`, `(x & y) > ${r(0, 3)}`, `x == y`]);

  const body =
    `  let x = a & ${maskLo};\n` +
    `  let y = (b & 7) | ${setBit};\n` +
    `  let m = ${aligned};\n` +
    `  let redundant = (x & ${maskLo}) & ${maskLo | 0};\n` + // masking twice with a superset is a no-op
    `  let s = x * 5 + (y << ${shA}) + (m >> ${shA});\n` +
    `  if (${alwaysTrue}) { s = s + ${r(1, 5)}; } else { print(9990 + s); s = s - 7; }\n` +
    `  if (${alwaysFalse}) { print(8880 + s); s = s * 2; } else { s = s + ${r(1, 5)}; }\n` +
    `  if (${runtime}) { s = s + x; if (${runtime}) { print(s); s = s + 1; } } else { s = s - y; }\n` +
    `  s = s + redundant + popcount(x);\n` +
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
      if (level >= 2 && probeKb(source, level).kbChanged > 0) fired++;
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
