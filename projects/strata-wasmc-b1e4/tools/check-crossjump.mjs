// Cross-jumping (tail-merging) checks. Bundles the compiler (Vite SSR,
// extensionless-TS as in the app) and (1) confirms the pass *fires* when every
// predecessor of a merge ends in the same side-effecting tail — and correctly
// *declines* when the tails differ or an operand is defined inside an arm — and
// (2) runs a seeded differential fuzzer: hundreds of such programs compiled at
// -O0..-O3 and proven to print exactly what the reference interpreter (and the
// from-scratch wasm VM) print. Correctness is the oracle's job; firing is this
// tool's.
//
// Run with:  node tools/check-crossjump.mjs
import { build } from 'vite';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { resolve, dirname } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const outDir = resolve(here, '../node_modules/.crossjumpharness');

await build({
  configFile: false, logLevel: 'error',
  build: { ssr: true, outDir, emptyOutDir: true,
    lib: { entry: resolve(here, '_crossjumpentry.js'), formats: ['es'], fileName: 'crossjumpharness' },
    rollupOptions: { output: { entryFileNames: 'crossjumpharness.mjs' } }, minify: false, target: 'node20' },
});

const { probeCrossJump, fuzz } = await import(pathToFileURL(resolve(outDir, 'crossjumpharness.mjs')).href);

const seed = `  let g = 0;
  for (let k = 0; k < 150; k = k + 1) { g = g + k * 5 - 2; }
  let a = (g & 15) - 6; let b = (g & 7) - 3; let cond = (g & 16);`;

const programs = [
  {
    name: 'same print tail in both arms (effect hoist cannot move)',
    expectFire: true,
    source: `fn main() {
${seed}
  let s = a + b;
  if (cond > 0) { s = s + a; print(a); } else { s = s - b; print(a); }
  print(s);
}`,
  },
  {
    name: 'shared value+print tail, different leading work',
    expectFire: true,
    source: `fn main() {
${seed}
  let s = a + b;
  if (cond > 0) { s = s + a; let e = a * b - 3; print(e); } else { s = s - b; let e = a * b - 3; print(e); }
  print(s);
}`,
  },
  {
    name: 'three-way merge, identical tail on all arms',
    expectFire: true,
    source: `fn main() {
${seed}
  let s = a + b;
  if (cond > 0) { s = s + a; print(a + b); }
  else { if (a > 0) { s = s - b; print(a + b); } else { s = s * 2; print(a + b); } }
  print(s);
}`,
  },
  {
    name: 'return-tail merge: shared print tail then same value',
    expectFire: true,
    source: `fn g(a: int, b: int, cond: int) -> int {
  if (cond > 0) { print(a + 1); print(a); return a * b - 3; }
  else { print(b + 1); print(a); return a * b - 3; }
}
fn main() {
${seed}
  print(g(a, b, cond));
}`,
  },
  {
    name: 'return-tail merge: differing prefix, shared two-print tail + return',
    expectFire: true,
    source: `fn g(a: int, b: int, cond: int) -> int {
  if (cond > 0) { print(a + 7); print(b); print(a); return a + b; }
  else { print(b - 7); print(b); print(a); return a + b; }
}
fn main() {
${seed}
  print(g(a, b, cond));
}`,
  },
  {
    name: 'return different values — must NOT fire',
    expectFire: false,
    source: `fn g(a: int, b: int, cond: int) -> int {
  if (cond > 0) { print(a); return a * b; } else { print(a); return a + b; }
}
fn main() {
${seed}
  print(g(a, b, cond));
}`,
  },
  {
    name: 'different tails per arm — must NOT fire',
    expectFire: false,
    source: `fn main() {
${seed}
  let s = a + b;
  if (cond > 0) { s = s + a; print(a); } else { s = s - b; print(b); }
  print(s);
}`,
  },
  {
    name: 'tail operand defined inside the arm — must NOT fire',
    expectFire: false,
    source: `fn main() {
${seed}
  let s = a + b;
  if (cond > 0) { let u = a + cond; print(u); } else { let u = b - cond; print(u); }
  print(s);
}`,
  },
];

let ok = 0, bad = 0;
for (const p of programs) {
  for (const level of [2, 3]) {
    const rp = probeCrossJump(p.source, level);
    const fired = rp.crossJumpChanged > 0;
    const pass = fired === p.expectFire;
    if (pass) ok++; else bad++;
    console.log(`${pass ? 'ok  ' : 'FAIL'} ${p.name} -O${level}  fired=${fired} (changed=${rp.crossJumpChanged}) insts ${rp.ssaInsts}->${rp.optInsts}`);
  }
}
console.log(`\n${ok}/${ok + bad} activity checks pass`);

const seeds = [];
for (let s = 1; s <= 240; s++) seeds.push(s * 2654435761);
const fr = await fuzz(seeds, [0, 1, 2, 3]);
console.log(`\nfuzz: ${fr.pass}/${fr.total} differential checks pass across -O0..-O3 (${seeds.length} random programs; cross-jump fired in ${fr.fired} of the -O2/-O3 compiles)`);
if (fr.failures.length) { console.log('\nFAILURES:'); for (const f of fr.failures.slice(0, 30)) console.log(`  seed ${f.seed} -O${f.level}: ${f.detail}`); }
if (bad || fr.failures.length) process.exit(1);
