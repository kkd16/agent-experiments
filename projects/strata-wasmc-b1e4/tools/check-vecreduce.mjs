// Reduction-vectorizer fuzz: generate thousands of random *integer reduction*
// loops — one to three loop-carried accumulators `acc = acc ⊕ expr(a[i],b[i],…)`
// over an associative+commutative op (`+ * & | ^`), at random array lengths
// 0..40 — and assert the optimized wasm (-O3, where the reduction vectorizer
// folds four lanes at a time and horizontally reduces at loop exit) prints
// EXACTLY what the unoptimized scalar wasm (-O0) does. Lengths straddle every
// multiple of 4, so the all-remainder (< 4) and ragged-tail cases are hammered.
//
// This is the load-bearing proof that lane-shuffling the fold is sound: it is
// only bit-for-bit equal because `+`/`*` wrap mod 2³² (associative+commutative)
// and `&`/`|`/`^` are bitwise — the harness would catch any op that *isn't*.
// Node provides `WebAssembly`, so this is the real backend end-to-end. Also
// tallies how often the reduction path fired, to prove it actually engages.
//
// Run with:  node tools/check-vecreduce.mjs [count] [seed]
import { build } from 'vite';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { resolve, dirname } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const outDir = resolve(here, '../node_modules/.vecharness');
await build({
  configFile: false, logLevel: 'error',
  build: { ssr: true, outDir, emptyOutDir: true,
    lib: { entry: resolve(here, '_vecentry.js'), formats: ['es'], fileName: 'vh' },
    rollupOptions: { output: { entryFileNames: 'vh.mjs' } }, minify: false, target: 'node20' },
});
const { buildV } = await import(pathToFileURL(resolve(outDir, 'vh.mjs')).href);

// deterministic RNG (mulberry32)
function rng(seed) { let s = seed >>> 0; return () => { s |= 0; s = (s + 0x6D2B79F5) | 0; let t = Math.imul(s ^ (s >>> 15), 1 | s); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
const pick = (r, a) => a[(r() * a.length) | 0];

// An elementwise integer expression over the array reads a[i], b[i] (and small
// constants), restricted to the ops with a v128 lanewise form (no div/rem/shift,
// so no traps and every node is vectorizable). This is the per-iteration value
// that gets folded into an accumulator.
function genExpr(r, vars, depth) {
  if (depth <= 0 || r() < 0.4) return r() < 0.7 ? pick(r, vars) : konst(r);
  const a = () => genExpr(r, vars, depth - 1);
  return `(${a()} ${pick(r, ['+', '-', '*', '&', '|', '^'])} ${a()})`;
}
function konst(r) {
  const big = r() < 0.2;
  const v = big ? (((r() * 4.0e9) - 2.0e9) | 0) : (((r() * 25) | 0) - 12);
  return v < 0 ? `(${v})` : `${v}`;
}

const OPS = ['+', '*', '&', '|', '^'];
function genProgram(r, len) {
  const nArr = 1 + ((r() * 3) | 0); // 1..3 arrays
  const names = ['a', 'b', 'd'].slice(0, nArr);
  const reads = names.map((nm) => `${nm}[i]`);
  const decls = names.map((nm) => `let ${nm} = int_array(N);`).join(' ');
  const inits = names.map((nm, k) => `${nm}[i] = i * ${7 * k + 3} - ${11 * k + 1};`).join(' ');
  // 1..3 independent accumulators, each its own op + invariant init.
  const nAcc = 1 + ((r() * 3) | 0);
  const accs = [];
  for (let k = 0; k < nAcc; k++) {
    const op = pick(r, OPS);
    // a sensible identity-ish init so `&` doesn't always wipe to 0
    const init = op === '&' ? '(-1)' : op === '*' ? '1' : `${((r() * 7) | 0)}`;
    accs.push({ name: `s${k}`, op, init, expr: genExpr(r, reads, 1 + ((r() * 3) | 0)) });
  }
  const accDecls = accs.map((a) => `let ${a.name} = ${a.init};`).join(' ');
  const folds = accs.map((a) => `${a.name} = ${a.name} ${a.op} ${a.expr};`).join(' ');
  // Optionally also emit an elementwise store kernel in the SAME loop (map+reduce).
  const wantKernel = r() < 0.5;
  const kernel = wantKernel ? `c[i] = ${genExpr(r, reads, 2)};` : '';
  const cDecl = wantKernel ? `let c = int_array(N);` : '';
  const cPrint = wantKernel ? `for (let i = 0; i < N; i = i + 1) { print(c[i]); }` : '';
  const accPrint = accs.map((a) => `print(${a.name});`).join(' ');
  return `fn main(){
  let N = ${len};
  ${decls} ${cDecl}
  for (let i = 0; i < N; i = i + 1) { ${inits} }
  ${accDecls}
  for (let i = 0; i < N; i = i + 1) { ${kernel} ${folds} }
  ${cPrint} ${accPrint}
}`;
}

async function runWasm(bytes) {
  const out = [];
  const env = { print_int: (x) => out.push(String(x | 0)), print_long: (x) => out.push(String(BigInt.asIntN(64, x))), print_float: (x) => out.push(String(x)), print_bool: (x) => out.push(String(!!x)), print_str: () => {} };
  const inst = await WebAssembly.instantiate(await WebAssembly.compile(bytes), { env });
  inst.exports.main();
  return out.join('|');
}

const COUNT = Number(process.argv[2] ?? 3000);
const SEED0 = Number(process.argv[3] ?? 0x5eed);
let fired = 0, mismatches = 0;
for (let n = 0; n < COUNT; n++) {
  const r = rng((SEED0 + n * 2654435761) >>> 0);
  const len = (r() * 41) | 0; // 0..40 — straddles every multiple of 4
  const src = genProgram(r, len);
  let b0, b3;
  try { b0 = buildV(src, 0); b3 = buildV(src, 3); }
  catch (e) { console.error('COMPILE FAIL on:\n' + src + '\n' + e.message); process.exit(1); }
  if (b3.fired) fired++;
  const o0 = await runWasm(b0.bytes);
  const o3 = await runWasm(b3.bytes);
  if (o0 !== o3) {
    mismatches++;
    console.error(`MISMATCH (seed ${(SEED0 + n) >>> 0}, N=${len}):\n${src}\n -O0: ${o0}\n -O3: ${o3}`);
    if (mismatches > 5) break;
  }
}
const pct = ((fired / COUNT) * 100).toFixed(1);
console.log(`${COUNT} random integer reduction loops (1..3 accumulators over + * & | ^, lengths 0..40) — reduction vectorizer fired on ${fired} (${pct}%); mismatches: ${mismatches}`);
process.exit(mismatches === 0 ? 0 : 1);
