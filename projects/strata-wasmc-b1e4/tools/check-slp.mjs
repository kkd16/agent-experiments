// SLP (superword / straight-line) vectorizer checks. Bundles the compiler (Vite
// SSR, extensionless-TS as in the app) and (1) confirms the SLP pass *fires* on a
// run of isomorphic adjacent-store statements — three-array elementwise, in-place
// scale, a memset, an f64 straight-line kernel, and a small fixed-trip loop the
// unroller flattens first — and correctly *declines* a shifted stencil (a
// cross-lane dependence); and (2) runs a seeded differential fuzzer: hundreds of
// straight-line SIMD-shaped programs compiled at -O0..-O3 and proven to print
// exactly what the reference interpreter (and the from-scratch wasm VM) print.
// Correctness is the oracle's job; firing is this tool's.
//
// Run with:  node tools/check-slp.mjs [count] [seed]
import { build } from 'vite';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { resolve, dirname } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const outDir = resolve(here, '../node_modules/.slpharness');

await build({
  configFile: false,
  logLevel: 'error',
  build: {
    ssr: true,
    outDir,
    emptyOutDir: true,
    lib: { entry: resolve(here, '_slpentry.js'), formats: ['es'], fileName: 'slpharness' },
    rollupOptions: { output: { entryFileNames: 'slpharness.mjs' } },
    minify: false,
    target: 'node20',
  },
});

const mod = await import(pathToFileURL(resolve(outDir, 'slpharness.mjs')).href);
const { probeSlp, fuzz, compile, parse, typecheck, interpret, runWasm, runOnVm } = mod;

let failures = 0;

// --- (1) targeted fire / decline + correctness -----------------------------
const cases = [
  {
    name: 'three-array elementwise (i32x4)',
    expectFire: true,
    source: `fn main(){
  let a = int_array(4); let b = int_array(4); let c = int_array(4);
  a[0]=1; a[1]=2; a[2]=3; a[3]=4; b[0]=10; b[1]=20; b[2]=30; b[3]=40;
  c[0]=a[0]*b[0]+a[0]; c[1]=a[1]*b[1]+a[1]; c[2]=a[2]*b[2]+a[2]; c[3]=a[3]*b[3]+a[3];
  print(c[0]); print(c[1]); print(c[2]); print(c[3]);
}`,
  },
  {
    name: 'in-place scale (same array read+written)',
    expectFire: true,
    source: `fn main(){
  let a = int_array(4);
  a[0]=11; a[1]=22; a[2]=33; a[3]=44;
  a[0]=a[0]*3; a[1]=a[1]*3; a[2]=a[2]*3; a[3]=a[3]*3;
  print(a[0]); print(a[1]); print(a[2]); print(a[3]);
}`,
  },
  {
    name: 'memset constant lanes',
    expectFire: true,
    source: `fn main(){
  let a = int_array(4);
  a[0]=7; a[1]=7; a[2]=7; a[3]=7;
  print(a[0]+a[1]+a[2]+a[3]);
}`,
  },
  {
    name: 'lanewise-const vector (a[k]+k literals)',
    expectFire: true,
    source: `fn main(){
  let a = int_array(4); let c = int_array(4);
  a[0]=100; a[1]=200; a[2]=300; a[3]=400;
  c[0]=a[0]+0; c[1]=a[1]+1; c[2]=a[2]+2; c[3]=a[3]+3;
  print(c[0]); print(c[1]); print(c[2]); print(c[3]);
}`,
  },
  {
    name: 'i64 straight-line kernel (i64x2)',
    expectFire: true,
    source: `fn main(){
  let a = long_array(2); let b = long_array(2); let c = long_array(2);
  a[0]=1000000007L; a[1]=-42L; b[0]=999999937L; b[1]=7L;
  c[0]=a[0]*b[0]+a[0]; c[1]=a[1]*b[1]+a[1];
  print(c[0]); print(c[1]);
}`,
  },
  {
    name: 'f64 straight-line saxpy (f64x2)',
    expectFire: true,
    source: `fn main(){
  let x = float_array(2); let y = float_array(2);
  x[0]=1.5; x[1]=2.5; y[0]=0.25; y[1]=0.75;
  y[0]=2.25*x[0]+y[0]; y[1]=2.25*x[1]+y[1];
  print(y[0]); print(y[1]);
}`,
  },
  {
    name: 'unroll then SLP (fixed-trip loop)',
    expectFire: true,
    source: `fn main(){
  let a = int_array(4); let b = int_array(4); let c = int_array(4);
  a[0]=1; a[1]=2; a[2]=3; a[3]=4; b[0]=5; b[1]=6; b[2]=7; b[3]=8;
  for (let i = 0; i < 4; i = i + 1) { c[i] = a[i] + b[i]; }
  print(c[0]); print(c[1]); print(c[2]); print(c[3]);
}`,
  },
  {
    name: 'shifted stencil must DECLINE',
    expectFire: false,
    // The array is initialized by a large loop the unroller leaves intact (a
    // strided store, not an SLP seed), so the only adjacent-store run is the
    // stencil `a[k] = a[k+1] + 1` — a genuine cross-lane dependence SLP must reject.
    source: `fn main(){
  let n = 64;
  let a = int_array(n);
  for (let i = 0; i < n; i = i + 1) { a[i] = i * 7 - 3; }
  a[0]=a[1]+1; a[1]=a[2]+1; a[2]=a[3]+1; a[3]=a[4]+1;
  print(a[0]); print(a[1]); print(a[2]); print(a[3]);
}`,
  },
];

for (const c of cases) {
  // Reference output.
  let ref;
  try {
    const p = parse(c.source);
    typecheck(p);
    ref = interpret(p).output;
  } catch (e) {
    console.log(`  ✗ ${c.name}: reference failed: ${e.message}`);
    failures++;
    continue;
  }
  let fired = false;
  let mismatch = false;
  for (const lvl of [0, 1, 2, 3]) {
    if (lvl >= 2 && probeSlp(c.source, lvl).slpChanged > 0) fired = true;
    const comp = compile(c.source, lvl);
    const w = (await runWasm(comp.bytes)).output;
    const vm = runOnVm(comp.bytes).output;
    if (JSON.stringify(w) !== JSON.stringify(ref) || JSON.stringify(vm) !== JSON.stringify(ref)) {
      mismatch = true;
      console.log(`  ✗ ${c.name} @ -O${lvl}: ref=${JSON.stringify(ref)} wasm=${JSON.stringify(w)} vm=${JSON.stringify(vm)}`);
    }
  }
  const fireOk = fired === c.expectFire;
  if (mismatch || !fireOk) failures++;
  console.log(`  ${mismatch || !fireOk ? '✗' : '✓'} ${c.name}: fired=${fired} (expected ${c.expectFire})`);
}

// --- (2) seeded differential fuzz ------------------------------------------
const count = Number(process.argv[2] ?? 200);
const seed0 = Number(process.argv[3] ?? 1);
const seeds = Array.from({ length: count }, (_, i) => seed0 + i);
console.log(`\nFuzzing ${count} programs × 4 levels (seed ${seed0}…)…`);
const res = await fuzz(seeds, [0, 1, 2, 3]);
console.log(`  total=${res.total} pass=${res.pass} fired(@-O2/3)=${res.fired}`);
if (res.failures.length) {
  failures += res.failures.length;
  for (const f of res.failures.slice(0, 8)) console.log(`  ✗ seed ${f.seed} @ -O${f.level}: ${f.detail}`);
}

console.log(failures === 0 ? '\nALL OK' : `\nFAILURES: ${failures}`);
process.exit(failures === 0 ? 0 : 1);
