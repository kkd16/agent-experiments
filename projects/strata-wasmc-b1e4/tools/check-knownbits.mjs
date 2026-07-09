// Known-bits (bitwise lattice) checks. Bundles the compiler (Vite SSR,
// extensionless-TS as in the app) and (1) confirms the known-bits pass *fires* on
// bit facts a per-bit lattice settles — a value that masks/shifts to a constant, a
// redundant mask, a parity comparison — and correctly *declines* on a genuine
// runtime branch; and (2) runs a seeded differential fuzzer: hundreds of
// bit-twiddling programs compiled at -O0..-O3 and proven to print exactly what the
// reference interpreter (and the from-scratch wasm VM) print. Correctness is the
// oracle's job; firing is this tool's.
//
// Run with:  node tools/check-knownbits.mjs
import { build } from 'vite';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { resolve, dirname } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const outDir = resolve(here, '../node_modules/.kbharness');

await build({
  configFile: false,
  logLevel: 'error',
  build: {
    ssr: true,
    outDir,
    emptyOutDir: true,
    lib: { entry: resolve(here, '_kbentry.js'), formats: ['es'], fileName: 'kbharness' },
    rollupOptions: { output: { entryFileNames: 'kbharness.mjs' } },
    minify: false,
    target: 'node20',
  },
});

const { probeKb, fuzz } = await import(pathToFileURL(resolve(outDir, 'kbharness.mjs')).href);

const programs = [
  {
    name: 'masked-off bits fold a comparison (always true)',
    expectFire: true,
    source: `fn run(a: int) -> int {
  let x = (a << 3) + (a << 3);   // low 3 bits are provably zero
  let s = 0;
  if ((x & 7) == 0) { s = 100; } else { print(-1); s = 200; }
  return s + (x >> 3);
}
fn main(){ for (let i = 0; i < 5; i = i + 1) { print(run(i * 37)); } }`,
  },
  {
    name: 'set bit makes a parity test always false',
    expectFire: true,
    source: `fn run(a: int) -> int {
  let x = a | 1;                 // odd -> bit 0 known 1 -> never zero
  let s = 0;
  if (x == 0) { print(-1); s = 200; } else { s = 100; }
  return s + (x & 1);
}
fn main(){ for (let i = 0; i < 5; i = i + 1) { print(run(i * 91)); } }`,
  },
  {
    name: 'redundant mask is removed (fires)',
    expectFire: true,
    source: `fn run(a: int) -> int {
  let x = a & 15;
  let y = (x & 15) & 7;          // x already fits 4 bits; & 15 is a no-op, & 7 the only real mask
  return y + x;
}
fn main(){ for (let i = 0; i < 6; i = i + 1) { print(run(i * 53)); } }`,
  },
  {
    name: 'or of a known-set bit is a no-op (fires)',
    expectFire: true,
    source: `fn run(a: int) -> int {
  let x = (a & 7) | 4;
  let y = x | 4;                 // bit 2 already known 1 -> | 4 is the identity
  return y + x;
}
fn main(){ for (let i = 0; i < 6; i = i + 1) { print(run(i * 17)); } }`,
  },
  {
    name: 'shift/mask plumbing folds to a constant (fires)',
    expectFire: true,
    source: `fn run(a: int) -> int {
  let x = ((a & 255) << 8) & 255;   // the low byte of a value with 8 known-zero low bits: 0
  let s = 7;
  if (x == 0) { s = s + 1; } else { print(-9); }
  return s;
}
fn main(){ for (let i = 0; i < 5; i = i + 1) { print(run(i * 12345)); } }`,
  },
  {
    // Recursion keeps `run` un-inlined, so `a`/`b` stay genuinely runtime and no
    // bit is pinned — known-bits must decline.
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
    const rp = probeKb(p.source, level);
    const fired = rp.kbChanged > 0;
    const pass = fired === p.expectFire;
    if (pass) ok++;
    else bad++;
    console.log(
      `${pass ? 'ok  ' : 'FAIL'} ${p.name} -O${level}  fired=${fired} (changed=${rp.kbChanged}) insts ${rp.ssaInsts}->${rp.optInsts}`,
    );
  }
}
console.log(`\n${ok}/${ok + bad} activity checks pass`);

const seeds = [];
for (let s = 1; s <= 260; s++) seeds.push(s * 2654435761);
const fr = await fuzz(seeds, [0, 1, 2, 3]);
console.log(
  `\nfuzz: ${fr.pass}/${fr.total} differential checks pass across -O0..-O3 (${seeds.length} random programs; known-bits fired in ${fr.fired} of the -O2/-O3 compiles)`,
);
if (fr.failures.length) {
  console.log('\nFAILURES:');
  for (const f of fr.failures.slice(0, 30)) console.log(`  seed ${f.seed} -O${f.level}: ${f.detail}`);
}
if (bad || fr.failures.length) process.exit(1);
