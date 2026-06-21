// Partial-unroll probe. Bundles the compiler (Vite SSR, extensionless-TS
// resolution as in the app) and checks that the partial loop unroller actually
// fires on runtime- and large-trip loops at -O2/-O3 — i.e. that the optimization
// is doing real work, not silently declining. Correctness is proven separately
// by the differential harness (tools/run-harness.mjs); this is an *activity*
// check, so the dev loop can see the strider engage.
//
// Run with:  node tools/check-unroll.mjs
import { build } from 'vite';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { resolve, dirname } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const outDir = resolve(here, '../node_modules/.unrollharness');

await build({
  configFile: false,
  logLevel: 'error',
  build: {
    ssr: true,
    outDir,
    emptyOutDir: true,
    lib: { entry: resolve(here, '_unrollentry.js'), formats: ['es'], fileName: 'unrollharness' },
    rollupOptions: { output: { entryFileNames: 'unrollharness.mjs' } },
    minify: false,
    target: 'node20',
  },
});

const { probeUnroll } = await import(pathToFileURL(resolve(outDir, 'unrollharness.mjs')).href);

// Each program has a counted loop the *full* unroller cannot peel — a runtime
// bound, or a constant bound past the full-unroll limit — so the strider should.
const programs = [
  {
    name: 'runtime-sum (i32, lt, +1)',
    expectFire: true,
    source: `fn sum(n: int) -> int { let s = 0; for (let i = 0; i < n; i = i + 1) { s = s + i; } return s; }
fn main(){ print(sum(1000)); print(sum(7)); print(sum(0)); print(sum(1)); }`,
  },
  {
    name: 'runtime-countdown (i32, gt, -1)',
    expectFire: true,
    source: `fn f(n: int) -> int { let s = 0; for (let i = n; i > 0; i = i - 1) { s = s + i * 2; } return s; }
fn main(){ print(f(1000)); print(f(13)); print(f(0)); }`,
  },
  {
    name: 'runtime-stride3 (i32, le)',
    expectFire: true,
    source: `fn f(n: int) -> int { let s = 0; for (let i = 0; i <= n; i = i + 3) { s = s + i; } return s; }
fn main(){ print(f(1000)); print(f(10)); print(f(2)); }`,
  },
  {
    name: 'large-const-trip (300 iters)',
    expectFire: true,
    source: `fn main(){ let s = 0; for (let i = 0; i < 300; i = i + 1) { s = (s + i) * 3; } print(s); }`,
  },
  {
    name: 'small-const-trip (full unroller owns it)',
    expectFire: false,
    source: `fn main(){ let s = 0; for (let i = 0; i < 5; i = i + 1) { s = s + i; } print(s); }`,
  },
];

let ok = 0;
let bad = 0;
for (const p of programs) {
  for (const level of [2, 3]) {
    const r = probeUnroll(p.source, level);
    const fired = r.partialUnrollChanged > 0;
    const pass = fired === p.expectFire;
    if (pass) ok++;
    else bad++;
    console.log(
      `${pass ? 'ok  ' : 'FAIL'} ${p.name} -O${level}  fired=${fired} (changed=${r.partialUnrollChanged}) ` +
        `loops ${r.loopsBefore}->${r.loopsAfter}  insts ${r.ssaInsts}->${r.optInsts}  ${r.kinds}`,
    );
  }
}
console.log(`\n${ok}/${ok + bad} activity checks pass`);
if (bad) process.exit(1);
