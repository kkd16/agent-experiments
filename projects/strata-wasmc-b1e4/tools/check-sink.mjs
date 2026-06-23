// Code-sinking checks. Bundles the compiler (Vite SSR, extensionless-TS as in the
// app) and (1) confirms the pass *fires* on a value used on only one branch arm —
// and correctly *declines* when the value is used on both arms or in the branch
// condition — and (2) runs a seeded differential fuzzer: hundreds of such programs
// compiled at -O0..-O3 and proven to print exactly what the reference interpreter
// (and the from-scratch wasm VM) print. Correctness is the oracle's job; firing is
// this tool's.
//
// Run with:  node tools/check-sink.mjs
import { build } from 'vite';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { resolve, dirname } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const outDir = resolve(here, '../node_modules/.sinkharness');

await build({
  configFile: false, logLevel: 'error',
  build: { ssr: true, outDir, emptyOutDir: true,
    lib: { entry: resolve(here, '_sinkentry.js'), formats: ['es'], fileName: 'sinkharness' },
    rollupOptions: { output: { entryFileNames: 'sinkharness.mjs' } }, minify: false, target: 'node20' },
});

const { probeSink, fuzz } = await import(pathToFileURL(resolve(outDir, 'sinkharness.mjs')).href);

const seed = `  let g = 0;
  for (let k = 0; k < 150; k = k + 1) { g = g + k * 5 - 2; }
  let a = (g & 15) - 6; let b = (g & 7) - 3; let cond = (g & 16);`;

const programs = [
  {
    name: 'value used on one arm (print blocks if-conv)',
    expectFire: true,
    source: `fn main() {
${seed}
  let t = a * a + b * b - a * b;
  let s = a + b;
  if (cond > 0) { print(t); s = s + t; } else { s = s - b; }
  print(s);
}`,
  },
  {
    name: 'two values, one per arm',
    expectFire: true,
    source: `fn main() {
${seed}
  let t = a * a + b; let u = b * b - a;
  let s = a + b;
  if (cond > 0) { print(t); s = s + t; } else { print(u); s = s - u; }
  print(s);
}`,
  },
  {
    name: 'value used on BOTH arms — must NOT fire',
    expectFire: false,
    source: `fn main() {
${seed}
  let t = a * a + b * b;
  let s = a + b;
  if (cond > 0) { print(t); s = s + t; } else { print(t); s = s - t; }
  print(s);
}`,
  },
  {
    name: 'value used in the branch condition — must NOT fire',
    expectFire: false,
    source: `fn main() {
${seed}
  let t = a * a + b * b;
  let s = a + b;
  if (t > 10) { print(s); s = s + 1; } else { s = s - 1; }
  print(s); print(t);
}`,
  },
];

let ok = 0, bad = 0;
for (const p of programs) {
  for (const level of [2, 3]) {
    const rp = probeSink(p.source, level);
    const fired = rp.sinkChanged > 0;
    const pass = fired === p.expectFire;
    if (pass) ok++; else bad++;
    console.log(`${pass ? 'ok  ' : 'FAIL'} ${p.name} -O${level}  fired=${fired} (changed=${rp.sinkChanged}) insts ${rp.ssaInsts}->${rp.optInsts}`);
  }
}
console.log(`\n${ok}/${ok + bad} activity checks pass`);

const seeds = [];
for (let s = 1; s <= 240; s++) seeds.push(s * 2654435761);
const fr = await fuzz(seeds, [0, 1, 2, 3]);
console.log(`\nfuzz: ${fr.pass}/${fr.total} differential checks pass across -O0..-O3 (${seeds.length} random programs; sink fired in ${fr.fired} of the -O2/-O3 compiles)`);
if (fr.failures.length) { console.log('\nFAILURES:'); for (const f of fr.failures.slice(0, 30)) console.log(`  seed ${f.seed} -O${f.level}: ${f.detail}`); }
if (bad || fr.failures.length) process.exit(1);
