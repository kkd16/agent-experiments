// Code-hoisting checks. Bundles the compiler (Vite SSR, extensionless-TS as in the
// app) and (1) confirms the pass *fires* when both arms of a branch begin with the
// same pure value — and correctly *declines* when the arms differ — and (2) runs a
// seeded differential fuzzer: hundreds of such programs compiled at -O0..-O3 and
// proven to print exactly what the reference interpreter (and the from-scratch wasm
// VM) print. Correctness is the oracle's job; firing is this tool's.
//
// Run with:  node tools/check-hoist.mjs
import { build } from 'vite';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { resolve, dirname } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const outDir = resolve(here, '../node_modules/.hoistharness');

await build({
  configFile: false, logLevel: 'error',
  build: { ssr: true, outDir, emptyOutDir: true,
    lib: { entry: resolve(here, '_hoistentry.js'), formats: ['es'], fileName: 'hoistharness' },
    rollupOptions: { output: { entryFileNames: 'hoistharness.mjs' } }, minify: false, target: 'node20' },
});

const { probeHoist, fuzz } = await import(pathToFileURL(resolve(outDir, 'hoistharness.mjs')).href);

const seed = `  let g = 0;
  for (let k = 0; k < 150; k = k + 1) { g = g + k * 5 - 2; }
  let a = (g & 15) - 6; let b = (g & 7) - 3; let cond = (g & 16);`;

const programs = [
  {
    name: 'same expr in both arms (print blocks if-conv)',
    expectFire: true,
    source: `fn main() {
${seed}
  let s = a + b;
  if (cond > 0) { let e = a * a + b * b; print(e); s = s + a; } else { let e = a * a + b * b; print(e); s = s - b; }
  print(s);
}`,
  },
  {
    name: 'two common exprs in both arms',
    expectFire: true,
    source: `fn main() {
${seed}
  let s = a + b;
  if (cond > 0) { let e = a * b - 3; let f = a + b * 7; print(e); print(f); s = s + a; }
  else { let e = a * b - 3; let f = a + b * 7; print(e); print(f); s = s - b; }
  print(s);
}`,
  },
  {
    name: 'different exprs per arm — must NOT fire',
    expectFire: false,
    source: `fn main() {
${seed}
  let s = a + b;
  if (cond > 0) { let e = a * a - b; print(e); s = s + a; } else { let e = b * b + a; print(e); s = s - b; }
  print(s);
}`,
  },
];

let ok = 0, bad = 0;
for (const p of programs) {
  for (const level of [2, 3]) {
    const rp = probeHoist(p.source, level);
    const fired = rp.hoistChanged > 0;
    const pass = fired === p.expectFire;
    if (pass) ok++; else bad++;
    console.log(`${pass ? 'ok  ' : 'FAIL'} ${p.name} -O${level}  fired=${fired} (changed=${rp.hoistChanged}) insts ${rp.ssaInsts}->${rp.optInsts}`);
  }
}
console.log(`\n${ok}/${ok + bad} activity checks pass`);

const seeds = [];
for (let s = 1; s <= 240; s++) seeds.push(s * 2654435761);
const fr = await fuzz(seeds, [0, 1, 2, 3]);
console.log(`\nfuzz: ${fr.pass}/${fr.total} differential checks pass across -O0..-O3 (${seeds.length} random programs; hoist fired in ${fr.fired} of the -O2/-O3 compiles)`);
if (fr.failures.length) { console.log('\nFAILURES:'); for (const f of fr.failures.slice(0, 30)) console.log(`  seed ${f.seed} -O${f.level}: ${f.detail}`); }
if (bad || fr.failures.length) process.exit(1);
