// Correlated-branch-folding checks. Bundles the compiler (Vite SSR, extensionless-TS
// as in the app) and (1) confirms the pass *fires* when a branch's condition was
// already decided by a dominating test of the same value — and correctly *declines*
// when the two tests are not correlated — and (2) runs a seeded differential fuzzer:
// hundreds of such programs compiled at -O0..-O3 and proven to print exactly what the
// reference interpreter (and the from-scratch wasm VM) print. Correctness is the
// oracle's job; firing is this tool's.
//
// Run with:  node tools/check-correlate.mjs
import { build } from 'vite';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { resolve, dirname } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const outDir = resolve(here, '../node_modules/.correlateharness');

await build({
  configFile: false, logLevel: 'error',
  build: { ssr: true, outDir, emptyOutDir: true,
    lib: { entry: resolve(here, '_correlateentry.js'), formats: ['es'], fileName: 'correlateharness' },
    rollupOptions: { output: { entryFileNames: 'correlateharness.mjs' } }, minify: false, target: 'node20' },
});

const { probeCorrelate, fuzz } = await import(pathToFileURL(resolve(outDir, 'correlateharness.mjs')).href);

const programs = [
  {
    name: 'nested test of the same predicate (true arm)',
    expectFire: true,
    source: `fn run(a: int, b: int) -> int {
  let s = a + b;
  if (a > b) { s = s * 2; if (a > b) { print(a); s = s + 1; } }
  return s;
}
fn main(){ for (let i = 0; i < 6; i = i + 1) { print(run(i, 3)); } }`,
  },
  {
    name: 'nested test inside the else arm (known false)',
    expectFire: true,
    source: `fn run(a: int, b: int) -> int {
  let s = a + b;
  if (a > b) { s = s + 9; }
  else { s = s - 5; if (a > b) { print(999); s = s + 100; } else { print(b); s = s - 1; } }
  return s;
}
fn main(){ for (let i = 0; i < 6; i = i + 1) { print(run(i, 3)); } }`,
  },
  {
    name: 'loop-invariant condition re-tested in the body',
    expectFire: true,
    source: `fn run(flag: int, n: int) -> int {
  let s = 0;
  for (let i = 0; i < n; i = i + 1) {
    if (flag > 0) { s = s + i; if (flag > 0) { print(i); s = s + 1; } }
  }
  return s;
}
fn main(){ print(run(1, 5)); print(run(0, 5)); }`,
  },
  {
    name: 'two unrelated conditions — must NOT fire',
    expectFire: false,
    source: `fn run(a: int, b: int) -> int {
  let s = a + b;
  if (a > b) { s = s * 2; if (a < b) { print(a); s = s + 1; } }
  return s;
}
fn main(){ for (let i = 0; i < 6; i = i + 1) { print(run(i, 3)); } }`,
  },
];

let ok = 0, bad = 0;
for (const p of programs) {
  for (const level of [2, 3]) {
    const rp = probeCorrelate(p.source, level);
    const fired = rp.correlateChanged > 0;
    const pass = fired === p.expectFire;
    if (pass) ok++; else bad++;
    console.log(`${pass ? 'ok  ' : 'FAIL'} ${p.name} -O${level}  fired=${fired} (changed=${rp.correlateChanged}) insts ${rp.ssaInsts}->${rp.optInsts}`);
  }
}
console.log(`\n${ok}/${ok + bad} activity checks pass`);

const seeds = [];
for (let s = 1; s <= 240; s++) seeds.push(s * 2654435761);
const fr = await fuzz(seeds, [0, 1, 2, 3]);
console.log(`\nfuzz: ${fr.pass}/${fr.total} differential checks pass across -O0..-O3 (${seeds.length} random programs; correlation fired in ${fr.fired} of the -O2/-O3 compiles)`);
if (fr.failures.length) { console.log('\nFAILURES:'); for (const f of fr.failures.slice(0, 30)) console.log(`  seed ${f.seed} -O${f.level}: ${f.detail}`); }
if (bad || fr.failures.length) process.exit(1);
