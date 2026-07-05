// Value-range-propagation checks. Bundles the compiler (Vite SSR, extensionless-TS
// as in the app) and (1) confirms VRP *fires* on comparisons a derived range settles
// — a mask, a remainder, a bit-count, a chained guard — and correctly *declines* on a
// genuine runtime branch; and (2) runs a seeded differential fuzzer: hundreds of
// range-heavy programs compiled at -O0..-O3 and proven to print exactly what the
// reference interpreter (and the from-scratch wasm VM) print. Correctness is the
// oracle's job; firing is this tool's.
//
// Run with:  node tools/check-vrp.mjs
import { build } from 'vite';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { resolve, dirname } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const outDir = resolve(here, '../node_modules/.vrpharness');

await build({
  configFile: false,
  logLevel: 'error',
  build: {
    ssr: true,
    outDir,
    emptyOutDir: true,
    lib: { entry: resolve(here, '_vrpentry.js'), formats: ['es'], fileName: 'vrpharness' },
    rollupOptions: { output: { entryFileNames: 'vrpharness.mjs' } },
    minify: false,
    target: 'node20',
  },
});

const { probeVrp, fuzz } = await import(pathToFileURL(resolve(outDir, 'vrpharness.mjs')).href);

const programs = [
  {
    name: 'mask bounds a comparison (always true)',
    expectFire: true,
    source: `fn run(a: int) -> int {
  let x = a & 7;
  let s = 0;
  if (x < 8) { s = 100; } else { print(-1); s = 200; }   // x in [0,7] -> always true
  return s + x;
}
fn main(){ for (let i = 0; i < 5; i = i + 1) { print(run(i * 37)); } }`,
  },
  {
    name: 'mask makes a comparison always false',
    expectFire: true,
    source: `fn run(a: int) -> int {
  let x = a & 15;
  let s = 0;
  if (x > 15) { print(-1); s = 200; } else { s = 100; }   // x in [0,15] -> always false
  return s + x;
}
fn main(){ for (let i = 0; i < 5; i = i + 1) { print(run(i * 91)); } }`,
  },
  {
    name: 'remainder sign + bound (always true)',
    expectFire: true,
    source: `fn run(a: int) -> int {
  let x = a & 255;
  let r = x % 10;               // x >= 0 -> r in [0,9]
  let s = 0;
  if (r < 10) { s = s + r; } else { print(-1); s = s - 1; }
  return s;
}
fn main(){ for (let i = 0; i < 6; i = i + 1) { print(run(i * 53)); } }`,
  },
  {
    name: 'bit-count bound (always true)',
    expectFire: true,
    source: `fn run(a: int) -> int {
  let s = 0;
  if (popcount(a) <= 32) { s = 7; } else { print(-1); s = 9; }
  return s;
}
fn main(){ for (let i = 0; i < 5; i = i + 1) { print(run(i * 12345)); } }`,
  },
  {
    name: 'chained guard: a<b implies a<b+1',
    expectFire: true,
    source: `fn run(a: int, b: int) -> int {
  let x = a & 31;
  let y = (b & 31) + 40;
  let s = 0;
  if (x < y) { s = s + 1; if (x < y + 1) { print(x); s = s + 2; } }
  return s;
}
fn main(){ for (let i = 0; i < 6; i = i + 1) { print(run(i * 7, i * 5)); } }`,
  },
  {
    // Recursion keeps `run` un-inlined, so `a`/`b` stay genuinely runtime (never
    // specialized to constants) and their full ranges overlap — VRP must decline.
    name: 'genuine runtime branch — must NOT fire',
    expectFire: false,
    source: `fn run(a: int, b: int, n: int) -> int {
  if (n <= 0) { return a - b; }
  if (a > b) { return run(a - 1, b, n - 1); }
  return run(a, b - 1, n - 1);
}
fn main(){ for (let i = 0; i < 6; i = i + 1) { print(run(i * 3, 7, i)); } }`,
  },
];

let ok = 0,
  bad = 0;
for (const p of programs) {
  for (const level of [2, 3]) {
    const rp = probeVrp(p.source, level);
    const fired = rp.vrpChanged > 0;
    const pass = fired === p.expectFire;
    if (pass) ok++;
    else bad++;
    console.log(
      `${pass ? 'ok  ' : 'FAIL'} ${p.name} -O${level}  fired=${fired} (changed=${rp.vrpChanged}) insts ${rp.ssaInsts}->${rp.optInsts}`,
    );
  }
}
console.log(`\n${ok}/${ok + bad} activity checks pass`);

const seeds = [];
for (let s = 1; s <= 260; s++) seeds.push(s * 2654435761);
const fr = await fuzz(seeds, [0, 1, 2, 3]);
console.log(
  `\nfuzz: ${fr.pass}/${fr.total} differential checks pass across -O0..-O3 (${seeds.length} random programs; VRP fired in ${fr.fired} of the -O2/-O3 compiles)`,
);
if (fr.failures.length) {
  console.log('\nFAILURES:');
  for (const f of fr.failures.slice(0, 30)) console.log(`  seed ${f.seed} -O${f.level}: ${f.detail}`);
}
if (bad || fr.failures.length) process.exit(1);
