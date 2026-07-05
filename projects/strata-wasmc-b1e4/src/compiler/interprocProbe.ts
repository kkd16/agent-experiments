// Inspection + fuzzing helpers for `tools/check-interproc.mjs`: report whether the
// interprocedural optimizer fired (and *which* of its four transforms), plus a
// seeded generator of programs that call a too-big-to-inline kernel at several
// sites — some arguments constant module-wide, some constant at only a subset, some
// genuinely runtime — which the differential oracle then proves compile identically
// to the reference interpreter (and the from-scratch wasm VM) at every optimization
// level. Correctness is the oracle's job; *firing* is this tool's. Lives in `src/`
// so it bundles through the exact extensionless-TS resolution the app uses.
import { compile } from './pipeline';
import { parse } from './parser';
import { typecheck } from './types';
import { interpret } from './interp';
import { runWasm } from './runner';
import { runOnVm } from '../wasm/vm';

export interface InterprocProbe {
  level: number;
  retConsts: number;
  specialized: number;
  constArgs: number;
  deadArgs: number;
  fired: boolean;
  ssaInsts: number;
  optInsts: number;
}

export function probeInterproc(source: string, level: 0 | 1 | 2 | 3): InterprocProbe {
  const c = compile(source, level);
  const get = (name: string): number => {
    for (const s of c.preLog ?? []) if (s.name === name) return s.changed;
    return 0;
  };
  const retConsts = get('ipo: return-const fold');
  const specialized = get('ipo: specialize (clones)');
  const constArgs = get('ipo: const-arg');
  const deadArgs = get('ipo: dead-arg');
  return {
    level,
    retConsts,
    specialized,
    constArgs,
    deadArgs,
    fired: retConsts + specialized + constArgs + deadArgs > 0,
    ssaInsts: c.metrics?.ssaInsts ?? 0,
    optInsts: c.metrics?.optInsts ?? 0,
  };
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

// A large (never-inlined) kernel with a loop over three parameters — `mode` selects a
// branch, `scale` mixes into the arithmetic, `n` bounds the loop. `main` calls it at
// several sites. We hand `mode` a value that is either uniform across all sites (a
// module-wide constant ⇒ const-arg + dead-arg fold) or split across two constants
// (⇒ specialization), while `n` is always a runtime induction value (⊥, never folded).
// No division/remainder or variable shift — every run is total, so the interpreter and
// the real wasm agree bit-for-bit whatever the optimizer does with the constants.
export function genProgram(seed: number): string {
  const rnd = mulberry32(seed);
  const r = (lo: number, hi: number): number => lo + Math.floor(rnd() * (hi - lo + 1));

  const scale = r(1, 6);
  const uniformMode = rnd() < 0.5; // true ⇒ every site passes the same mode (const-arg)
  const modeA = r(0, 2);
  const modeB = (modeA + 1 + r(0, 1)) % 3; // a different mode for the split case
  const bases = [r(3, 8), r(2, 7), r(4, 9), r(3, 6)];
  const extra = rnd() < 0.5;

  const kernel = `fn kernel(mode: int, scale: int, n: int) -> int {
  let acc = ${r(0, 3)};
  for (let i = 0; i < n; i = i + 1) {
    let t = i * scale;
    if (mode == 0) { acc = acc + t; }
    else { if (mode == 1) { acc = acc + t * 2 - i; } else { acc = acc + (t - i) + scale; } }
    acc = acc + (i & scale);
    acc = acc ^ (i * 3 + mode);
    acc = acc + (acc & 15) - 7;
  }
  return acc + mode * 7 + scale * 2;
}
`;

  const modeAt = (k: number): number => (uniformMode ? modeA : k % 2 === 0 ? modeA : modeB);
  const calls: string[] = [];
  const nSites = r(2, 4);
  for (let k = 0; k < nSites; k++) {
    // `n` is a runtime value derived from the loop counter — never a constant.
    calls.push(`  for (let j = ${bases[k % bases.length]}; j < ${bases[k % bases.length] + r(2, 5)}; j = j + 1) { print(kernel(${modeAt(k)}, ${scale}, j)); }`);
  }
  const helper = extra
    ? `fn twice(v: int) -> int { return v + v; }\n`
    : '';
  const helperCall = extra ? `  print(twice(${r(1, 9)}));\n  print(twice(${r(1, 9)}));\n` : '';

  return `${kernel}${helper}fn main() {
${calls.join('\n')}
${helperCall}}
`;
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
      if (probeInterproc(source, level).fired) fired++;
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
