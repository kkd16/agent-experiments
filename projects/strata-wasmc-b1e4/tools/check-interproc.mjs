// Interprocedural-optimization checks. Bundles the compiler (Vite SSR, extensionless-TS
// exactly as the app resolves it) and (1) confirms each of the four transforms —
// constant-argument propagation, dead-argument elimination, function specialization
// and return-constant folding — *fires* on a program built to exhibit it, and correctly
// *declines* when every argument is genuinely runtime; then (2) runs a seeded
// differential fuzzer: hundreds of call-heavy programs compiled at -O0..-O3 and proven
// to print exactly what the reference interpreter (and the from-scratch wasm VM) print.
// Correctness is the oracle's job; firing is this tool's.
//
// Run with:  node tools/check-interproc.mjs
import { build } from 'vite';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { resolve, dirname } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const outDir = resolve(here, '../node_modules/.interprocharness');

await build({
  configFile: false, logLevel: 'error',
  build: { ssr: true, outDir, emptyOutDir: true,
    lib: { entry: resolve(here, '_interprocentry.js'), formats: ['es'], fileName: 'interprocharness' },
    rollupOptions: { output: { entryFileNames: 'interprocharness.mjs' } }, minify: false, target: 'node20' },
});

const { probeInterproc, fuzz } = await import(pathToFileURL(resolve(outDir, 'interprocharness.mjs')).href);

// A kernel too big to inline (so the interprocedural pass — not the inliner — is what
// specializes it), called at several sites with mixed constant / runtime arguments.
const BIG = `fn kernel(mode: int, gain: int, n: int) -> int {
  let acc = 0;
  for (let i = 0; i < n; i = i + 1) {
    let t = i * gain;
    if (mode == 0) { acc = acc + t; }
    else { if (mode == 1) { acc = acc + t * 2 - i; } else { acc = acc + (t - i) + gain; } }
    acc = acc + (i & gain);
    acc = acc ^ (i * 3 + mode);
    acc = acc + (acc & 15) - 7;
  }
  return acc + mode * 7 + gain * 2;
}`;

const programs = [
  {
    name: 'const-arg + dead-arg: every site passes mode=0, gain=3',
    want: (p) => p.constArgs > 0 && p.deadArgs > 0,
    source: `${BIG}
fn main() {
  for (let a = 2; a < 6; a = a + 1) { print(kernel(0, 3, a)); }
  for (let b = 4; b < 7; b = b + 1) { print(kernel(0, 3, b)); }
}`,
  },
  {
    name: 'specialization: mode split across two constants (0 and 2)',
    want: (p) => p.specialized > 0,
    source: `${BIG}
fn main() {
  for (let a = 2; a < 6; a = a + 1) { print(kernel(0, 3, a)); }
  for (let b = 3; b < 7; b = b + 1) { print(kernel(0, 3, b)); }
  for (let c = 2; c < 5; c = c + 1) { print(kernel(2, 3, c)); }
}`,
  },
  {
    name: 'return-const fold: a pure function that always returns 42',
    want: (p) => p.retConsts > 0,
    source: `fn answer(x: int, y: int) -> int {
  let a = x * 0;
  let b = y & 0;
  if (a + b > 100) { return 42; }
  return 42;
}
fn main() { print(answer(3, 9) + answer(7, 1)); print(answer(0, 0)); }`,
  },
  {
    name: 'declines: every argument is a genuine runtime value',
    want: (p) => !p.fired,
    source: `${BIG}
fn main() {
  let s = 0;
  for (let i = 0; i < 5; i = i + 1) {
    s = s + i * 2;
    print(kernel(s & 3, (s & 1) + 1, i + 2));
  }
}`,
  },
];

let ok = 0, bad = 0;
for (const p of programs) {
  for (const level of [2, 3]) {
    const rp = probeInterproc(p.source, level);
    const pass = p.want(rp);
    if (pass) ok++; else bad++;
    console.log(`${pass ? 'ok  ' : 'FAIL'} ${p.name} -O${level}  ret=${rp.retConsts} spec=${rp.specialized} const=${rp.constArgs} dead=${rp.deadArgs}  insts ${rp.ssaInsts}->${rp.optInsts}`);
  }
}
console.log(`\n${ok}/${ok + bad} activity checks pass`);

const seeds = [];
for (let s = 1; s <= 260; s++) seeds.push(s * 2654435761);
const fr = await fuzz(seeds, [0, 1, 2, 3]);
console.log(`\nfuzz: ${fr.pass}/${fr.total} differential checks pass across -O0..-O3 (${seeds.length} random programs; interprocedural opts fired in ${fr.fired} of the compiles)`);
if (fr.failures.length) { console.log('\nFAILURES:'); for (const f of fr.failures.slice(0, 30)) console.log(`  seed ${f.seed} -O${f.level}: ${f.detail}`); }
if (bad || fr.failures.length) process.exit(1);
