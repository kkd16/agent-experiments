// Jump-threading checks. Bundles the compiler (Vite SSR, extensionless-TS as in the
// app) and (1) confirms the generalized threader *fires* when a branch condition is
// a foldable cone (icmp/ibin) over a per-edge-constant flag phi — and correctly
// *declines* when the condition depends on a runtime value — and (2) runs a seeded
// differential fuzzer: hundreds of such programs compiled at -O0..-O3 and proven to
// print exactly what the reference interpreter (and the from-scratch wasm VM) print.
// Correctness is the oracle's job; firing is this tool's.
//
// Run with:  node tools/check-thread.mjs
import { build } from 'vite';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { resolve, dirname } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const outDir = resolve(here, '../node_modules/.threadharness');

await build({
  configFile: false, logLevel: 'error',
  build: { ssr: true, outDir, emptyOutDir: true,
    lib: { entry: resolve(here, '_threadentry.js'), formats: ['es'], fileName: 'threadharness' },
    rollupOptions: { output: { entryFileNames: 'threadharness.mjs' } }, minify: false, target: 'node20' },
});

const { probeThread, fuzz } = await import(pathToFileURL(resolve(outDir, 'threadharness.mjs')).href);

const programs = [
  {
    name: 'comparison cone over a flag phi (flag == 0)',
    expectFire: true,
    source: `fn run(n: int) -> void {
  let flag = 0;
  if (n > 5) { flag = 2; print(n); }
  if (flag == 0) { print(10); } else { print(20); }
}
fn main(){ for (let i = 0; i < 8; i = i + 1) { run(i); } }`,
  },
  {
    name: 'arithmetic cone over a flag phi ((flag & 1) == 0)',
    expectFire: true,
    source: `fn run(n: int) -> void {
  let flag = 1;
  if (n % 2 == 0) { flag = 4; print(n); }
  if ((flag & 1) == 0) { print(10); } else { print(20); }
}
fn main(){ for (let i = 0; i < 8; i = i + 1) { run(i); } }`,
  },
  {
    name: 'two-level cone ((flag - 1) > 0)',
    expectFire: true,
    source: `fn run(n: int) -> void {
  let flag = 0;
  if (n < 4) { flag = 5; print(n); }
  if ((flag - 1) > 0) { print(10); } else { print(20); }
}
fn main(){ for (let i = 0; i < 8; i = i + 1) { run(i); } }`,
  },
  {
    name: 'condition depends on a genuinely runtime value — must NOT fire',
    expectFire: false,
    source: `fn main(){
  let g = 0;
  for (let k = 0; k < 150; k = k + 1) { g = g + k * 5 - 2; }
  let n = g & 7;
  if (n == 0) { print(10); } else { print(20); }
}`,
  },
];

let ok = 0, bad = 0;
for (const p of programs) {
  for (const level of [1, 2, 3]) {
    const rp = probeThread(p.source, level);
    const fired = rp.threadChanged > 0;
    const pass = fired === p.expectFire;
    if (pass) ok++; else bad++;
    console.log(`${pass ? 'ok  ' : 'FAIL'} ${p.name} -O${level}  fired=${fired} (changed=${rp.threadChanged}) insts ${rp.ssaInsts}->${rp.optInsts}`);
  }
}
console.log(`\n${ok}/${ok + bad} activity checks pass`);

const seeds = [];
for (let s = 1; s <= 240; s++) seeds.push(s * 2654435761);
const fr = await fuzz(seeds, [0, 1, 2, 3]);
console.log(`\nfuzz: ${fr.pass}/${fr.total} differential checks pass across -O0..-O3 (${seeds.length} random programs; threading fired in ${fr.fired} of the compiles)`);
if (fr.failures.length) { console.log('\nFAILURES:'); for (const f of fr.failures.slice(0, 30)) console.log(`  seed ${f.seed} -O${f.level}: ${f.detail}`); }
if (bad || fr.failures.length) process.exit(1);
