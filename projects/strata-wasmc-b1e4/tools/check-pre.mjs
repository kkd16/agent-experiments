// GVN-PRE checks. Bundles the compiler (Vite SSR, extensionless-TS as in the app)
// and (1) confirms the pass *fires* on a partial redundancy — an expression
// computed on some-but-not-all paths into a merge and recomputed after it — and
// correctly *declines* when the post-merge computation is fully redundant (GVN's
// job) or simply absent; and (2) runs a seeded differential fuzzer: hundreds of
// such programs compiled at -O0..-O3 and proven to print exactly what the
// reference interpreter (and the from-scratch wasm VM) print. Correctness is the
// oracle's job; firing is this tool's.
//
// Run with:  node tools/check-pre.mjs
import { build } from 'vite';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { resolve, dirname } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const outDir = resolve(here, '../node_modules/.preharness');

await build({
  configFile: false,
  logLevel: 'error',
  build: {
    ssr: true,
    outDir,
    emptyOutDir: true,
    lib: { entry: resolve(here, '_preentry.js'), formats: ['es'], fileName: 'preharness' },
    rollupOptions: { output: { entryFileNames: 'preharness.mjs' } },
    minify: false,
    target: 'node20',
  },
});

const { probePre, fuzz } = await import(pathToFileURL(resolve(outDir, 'preharness.mjs')).href);

const seed = `  let g = 0;
  for (let k = 0; k < 130; k = k + 1) { g = g + k * 5 - 2; }
  let a = (g & 15) - 6; let b = (g & 7) - 3; let c = (g & 31) - 12; let d = (g & 3) + 2; let s = 0;`;

const programs = [
  {
    name: 'partial redundancy — computed in one arm, recomputed after (print blocks if-conv)',
    expectFire: true,
    source: `fn main() {
${seed}
  if (a > b) { let t = a * b + c; print(t); s = s + 1; }
  let z = a * b + c;
  print(z); print(s);
}`,
  },
  {
    name: 'partial redundancy — two arms, only the then computes e',
    expectFire: true,
    source: `fn main() {
${seed}
  if ((a ^ c) > 0) { let t = (a + b) * c; print(t); s = s + a; } else { print(s); s = s - b; }
  let z = (a + b) * c;
  print(z + s);
}`,
  },
  {
    name: 'different expression after the merge (a+c vs a+d) — must NOT be treated as redundant',
    expectFire: false,
    source: `fn main() {
${seed}
  if (a > b) { let t = a + c; print(t); s = s + 1; } else { s = s - 1; }
  let z = a + d;
  print(z + s);
}`,
  },
  {
    name: 'no recomputation — nothing for PRE to do',
    expectFire: false,
    source: `fn main() {
${seed}
  if (a > b) { let t = a * b + c; print(t); s = s + 1; } else { s = s - 1; }
  print(s);
}`,
  },
];

let ok = 0,
  bad = 0;
for (const p of programs) {
  for (const level of [2, 3]) {
    const rp = probePre(p.source, level);
    const fired = rp.preChanged > 0;
    const pass = fired === p.expectFire;
    if (pass) ok++;
    else bad++;
    console.log(`${pass ? 'ok  ' : 'FAIL'} ${p.name} -O${level}  fired=${fired} (changed=${rp.preChanged}) insts ${rp.ssaInsts}->${rp.optInsts}`);
  }
}
console.log(`\n${ok}/${ok + bad} activity checks pass`);

const seeds = [];
for (let s = 1; s <= 320; s++) seeds.push(s * 2654435761);
const fr = await fuzz(seeds, [0, 1, 2, 3]);
console.log(
  `\nfuzz: ${fr.pass}/${fr.total} differential checks pass across -O0..-O3 (${seeds.length} random programs; PRE fired in ${fr.fired} of the -O2/-O3 compiles)`,
);
if (fr.failures.length) {
  console.log('\nFAILURES:');
  for (const f of fr.failures.slice(0, 30)) console.log(`  seed ${f.seed} -O${f.level}: ${f.detail}`);
}
if (bad || fr.failures.length) process.exit(1);
