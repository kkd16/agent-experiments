// Inspection + fuzzing helpers for `tools/check-slp.mjs`: report whether the SLP
// (superword / straight-line) vectorizer fired, plus a seeded generator of
// programs stuffed with runs of isomorphic adjacent-store statements — the shape
// SLP packs into one v128 chain — which the triple differential oracle then proves
// compile identically to the reference interpreter (and the from-scratch wasm VM)
// at every optimization level. Lives in `src/` so it bundles through the exact
// extensionless-TS resolution the app uses.
import { compile } from './pipeline';
import { parse } from './parser';
import { typecheck } from './types';
import { interpret } from './interp';
import { runWasm } from './runner';
import { runOnVm } from '../wasm/vm';

export interface SlpProbe {
  level: number;
  slpChanged: number;
  ssaInsts: number;
  optInsts: number;
}

export function probeSlp(source: string, level: 0 | 1 | 2 | 3): SlpProbe {
  const c = compile(source, level);
  let n = 0;
  for (const s of c.optLog ?? []) if (s.name.startsWith('slp-vectorize')) n += s.changed;
  return { level, slpChanged: n, ssaInsts: c.metrics?.ssaInsts ?? 0, optInsts: c.metrics?.optInsts ?? 0 };
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

// A program with W adjacent, isomorphic store statements over a handful of arrays
// — the canonical SLP seed. Two flavours: 32-bit (i32, W=4, arithmetic + bitwise)
// and 64-bit float (f64, W=2, arithmetic). Some lanes read the same array being
// written (an in-place kernel), some read distinct arrays; a fraction are emitted
// as a small fixed-trip loop the *unroller* flattens into the same adjacent-store
// run, so the `unroll → SLP` path is exercised too. Every value still feeds a
// `print`, so a wrong lane is caught by the oracle. All divisors are nonzero (a
// trap message is not differential).
export function genProgram(seed: number): string {
  const rnd = mulberry32(seed);
  const pick = <T>(xs: T[]): T => xs[Math.floor(rnd() * xs.length) % xs.length];
  const r = (lo: number, hi: number): number => lo + Math.floor(rnd() * (hi - lo + 1));
  // Three lane shapes: i32x4 (W=4), i64x2 and f64x2 (W=2). The 64-bit shapes stress
  // the 2-lane path; `long`/`int` exercise the wrapping integer + bitwise ops, `float`
  // the per-lane IEEE rounding (bit-exact because SLP never shuffles lanes).
  const kind = pick(['int', 'int', 'long', 'float'] as const);
  const isF = kind === 'float';
  const W = kind === 'int' ? 4 : 2;
  const arrFn = kind === 'int' ? 'int_array' : kind === 'long' ? 'long_array' : 'float_array';
  const suffix = kind === 'long' ? 'L' : '';
  const konst = (): string => (isF ? `${(r(-40, 40) / 8).toFixed(3)}` : `${r(-9, 9)}${suffix}`);
  const ops = isF ? ['+', '-', '*', '/'] : ['+', '-', '*', '&', '|', '^'];

  // Up to three arrays; the output array `c` may or may not be one of the inputs.
  const names = ['a', 'b', 'c'];
  const nIn = r(1, 2);
  const inputs = names.slice(0, nIn);
  const out = rnd() < 0.4 ? pick(inputs) : 'c'; // sometimes in-place
  const arrays = out === 'c' ? [...inputs, 'c'] : inputs;
  const N = 8;

  const decls = arrays.map((nm) => `  let ${nm} = ${arrFn}(${N});`).join('\n');
  // i-dependent init loops (not an SLP seed — strided by the IV, exactly right).
  const initBody = inputs
    .map((nm, k) =>
      isF
        ? `${nm}[i] = ${(k + 1).toFixed(1)} * float(i) - ${k}.0;`
        : kind === 'long'
          ? `${nm}[i] = long(i * ${7 * k + 3} - ${11 * k + 1});`
          : `${nm}[i] = i * ${7 * k + 3} - ${11 * k + 1};`,
    )
    .join(' ');
  const init = `  for (let i = 0; i < ${N}; i = i + 1) { ${initBody} }`;

  // One straight-line, per-lane expression over the input reads at a fixed index.
  const expr = (k: number): string => {
    const a = (): string => (rnd() < 0.6 ? `${pick(inputs)}[${k}]` : konst());
    let e = a();
    const terms = r(1, 3);
    for (let t = 0; t < terms; t++) e = `(${e} ${pick(ops)} ${a()})`;
    return e;
  };

  let body: string;
  if (rnd() < 0.35) {
    // A fixed-trip loop the unroller flattens, then SLP re-widens.
    body = `  for (let i = 0; i < ${W}; i = i + 1) { ${out}[i] = ${inputs.map((nm) => `${nm}[i]`).join(isF ? ' * ' : ' + ')}; }`;
  } else {
    body = Array.from({ length: W }, (_, k) => `  ${out}[${k}] = ${expr(k)};`).join('\n');
  }

  const printTy = isF ? 'float' : 'int';
  void printTy;
  const prints = Array.from({ length: W }, (_, k) => `  print(${out}[${k}]);`).join('\n');

  return `fn main(){\n${decls}\n${init}\n${body}\n${prints}\n}\n`;
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
      failures.push({ seed, level: -1, detail: 'reference failed: ' + (e as Error).message + '\n' + source });
      continue;
    }
    for (const level of levels) {
      total++;
      if (level >= 2 && probeSlp(source, level).slpChanged > 0) fired++;
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
      else failures.push({ seed, level, detail: `ref=${JSON.stringify(ref.output)} wasm=${JSON.stringify(run.output)} vm=${JSON.stringify(vm.output)}\n${source}` });
    }
  }
  return { total, pass, fired, failures };
}
