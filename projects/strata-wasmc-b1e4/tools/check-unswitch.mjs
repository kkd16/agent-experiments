// Loop-unswitching checks. Bundles the compiler (Vite SSR, extensionless-TS
// resolution as in the app) and (1) confirms the pass *fires* on loops with a
// loop-invariant branch — that it does real work, not silently declines — and
// (2) runs a seeded differential fuzzer: hundreds of random loops-with-invariant-
// branches compiled at -O0..-O3 and proven to print exactly what the reference
// interpreter (and the from-scratch wasm VM) does. Correctness is the oracle's
// job; firing is this tool's.
//
// Run with:  node tools/check-unswitch.mjs
import { build } from 'vite';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { resolve, dirname } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const outDir = resolve(here, '../node_modules/.unswitchharness');

await build({
  configFile: false,
  logLevel: 'error',
  build: {
    ssr: true,
    outDir,
    emptyOutDir: true,
    lib: { entry: resolve(here, '_unswitchentry.js'), formats: ['es'], fileName: 'unswitchharness' },
    rollupOptions: { output: { entryFileNames: 'unswitchharness.mjs' } },
    minify: false,
    target: 'node20',
  },
});

const { probeUnswitch, fuzz } = await import(pathToFileURL(resolve(outDir, 'unswitchharness.mjs')).href);

// --- (1) activity: the pass must fire on an invariant branch, and decline when
//         there is nothing to hoist (a variant branch, or a flag mutated in-loop).
// A runtime, SCCP-opaque seed: a loop too long to unroll, so `r` is unknown at
// compile time. Used to make flags genuine runtime loop-invariants.
const seed = `  let r = 0;
  for (let k = 0; k < 150; k = k + 1) { r = r + k * 7 - 3; }
  let flag = (r & 8) - 4;
  let n = (r & 31) + 6;`;

const programs = [
  {
    name: 'invariant flag (runtime)',
    expectFire: true,
    source: `fn main() {
${seed}
  let s = 0;
  for (let i = 0; i < n; i = i + 1) { if (flag > 0) { s = s + i; } else { s = s - i; } }
  print(s);
}`,
  },
  {
    name: 'two invariant flags (runtime)',
    expectFire: true,
    source: `fn main() {
${seed}
  let g = (r & 4);
  let s = 0;
  for (let i = 0; i < n; i = i + 1) {
    if (flag > 0) { s = s + i; } else { s = s * 2 - i; }
    if (g == 0) { s = s + 3; } else { s = s - 1; }
  }
  print(s);
}`,
  },
  {
    name: 'invariant branch around a nested loop (runtime)',
    expectFire: true,
    source: `fn main() {
${seed}
  let s = 0;
  for (let i = 0; i < n; i = i + 1) {
    if (flag > 0) { for (let j = 0; j < 4; j = j + 1) { s = s + i * j; } }
    else { s = s - i; }
  }
  print(s);
}`,
  },
  {
    name: 'variant branch — must NOT fire',
    expectFire: false,
    source: `fn main() {
${seed}
  let s = 0;
  for (let i = 0; i < n; i = i + 1) { if (i > 10) { s = s + i; } else { s = s - 1; } }
  print(s);
}`,
  },
  {
    name: 'flag mutated in loop — must NOT fire',
    expectFire: false,
    source: `fn main() {
${seed}
  let s = 0;
  let flag2 = flag;
  for (let i = 0; i < n; i = i + 1) { if (flag2 > 0) { s = s + i; } else { s = s - i; } flag2 = flag2 - 1; }
  print(s);
}`,
  },
];

let ok = 0;
let bad = 0;
for (const p of programs) {
  for (const level of [2, 3]) {
    const r = probeUnswitch(p.source, level);
    const fired = r.unswitchChanged > 0;
    const pass = fired === p.expectFire;
    if (pass) ok++;
    else bad++;
    console.log(
      `${pass ? 'ok  ' : 'FAIL'} ${p.name} -O${level}  fired=${fired} (changed=${r.unswitchChanged}) ` +
        `loops ${r.loopsBefore}->${r.loopsAfter}  insts ${r.ssaInsts}->${r.optInsts}`,
    );
  }
}
console.log(`\n${ok}/${ok + bad} activity checks pass`);

// --- (2) seeded differential fuzz.
const seeds = [];
for (let s = 1; s <= 240; s++) seeds.push(s * 2654435761);
const fr = await fuzz(seeds, [0, 1, 2, 3]);
console.log(
  `\nfuzz: ${fr.pass}/${fr.total} differential checks pass across -O0..-O3 ` +
    `(${seeds.length} random programs; unswitch fired in ${fr.fired} of the -O2/-O3 compiles)`,
);
if (fr.failures.length) {
  console.log('\nFAILURES:');
  for (const f of fr.failures.slice(0, 30)) console.log(`  seed ${f.seed} -O${f.level}: ${f.detail}`);
}

if (bad || fr.failures.length) process.exit(1);
