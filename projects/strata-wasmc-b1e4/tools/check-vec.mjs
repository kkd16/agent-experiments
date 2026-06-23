// Auto-vectorizer fuzz: generate thousands of random elementwise array kernels
// (i32: + - * & | ^ ; f32: + - * /) over one to three arrays at random lengths
// 0..40, and assert the optimized wasm (-O3, where the vectorizer widens the loop
// into v128.load → lanewise arith → v128.store + a scalar remainder) prints
// EXACTLY what the unoptimized scalar wasm (-O0) does. Lengths straddle every
// multiple of 4, so the remainder split is hammered, including the all-remainder
// (< 4) cases. The vectorizer is the only pass that restructures these loops, so
// any divergence is its bug. Node provides `WebAssembly`, so this is the real
// backend end-to-end. Also tallies how often the pass fired, to prove it works.
//
// Run with:  node tools/check-vec.mjs [count] [seed]
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

// A grammar of elementwise expressions over the array reads a[i], b[i] (and the
// IV-free constants), restricted to ops with a v128 lanewise form.
function genExpr(r, vars, isF, depth) {
  if (depth <= 0 || r() < 0.34) {
    return r() < 0.68 ? pick(r, vars) : konst(r, isF);
  }
  const a = () => genExpr(r, vars, isF, depth - 1);
  const op = isF ? pick(r, ['+', '-', '*', '/']) : pick(r, ['+', '-', '*', '&', '|', '^']);
  // keep the operands array-ish so most expressions actually carry a load
  return `(${a()} ${op} ${a()})`;
}
function konst(r, isF) {
  if (isF) { const v = (((r() * 200) | 0) - 100) / 4; return `f32(${v.toFixed(2)})`; }
  const big = r() < 0.25;
  const v = big ? (((r() * 4.0e9) - 2.0e9) | 0) : (((r() * 25) | 0) - 12);
  return v < 0 ? `(${v})` : `${v}`;
}

function genProgram(r, isF, len) {
  const arrFn = isF ? 'f32_array' : 'int_array';
  const sumTy = isF ? 'f32' : 'int';
  const zero = isF ? 'f32(0.0)' : '0';
  const nArr = 2 + ((r() * 2) | 0); // 2 or 3 arrays
  const names = ['a', 'b', 'd'].slice(0, nArr);
  const reads = names.map((nm) => `${nm}[i]`);
  const decls = names.map((nm) => `let ${nm} = ${arrFn}(N);`).join(' ');
  // Scalar init loops (i-dependent stores ⇒ NOT vectorized — exactly right).
  const inits = names.map((nm, k) => {
    if (isF) return `${nm}[i] = f32(i * ${k + 1} - ${3 * k}) * f32(0.5) + f32(${k});`;
    return `${nm}[i] = i * ${7 * k + 3} - ${11 * k + 1};`;
  }).join(' ');
  // The kernel that should widen: c[i] = expr(reads, consts).
  const kernel = genExpr(r, reads, isF, 2 + ((r() * 3) | 0));
  // Optionally a second, in-place kernel that aliases a (exercises within-lane RMW).
  const inplace = r() < 0.4 ? `for (let i = 0; i < N; i = i + 1) { a[i] = (a[i] ${isF ? '+' : '+'} a[i]); }` : '';
  // Print a deterministic readout of the whole result array.
  const printer = isF
    ? `for (let i = 0; i < N; i = i + 1) { print(c[i]); }`
    : `let s = 0; for (let i = 0; i < N; i = i + 1) { s = s * 31 + c[i]; print(c[i]); } print(s);`;
  void sumTy; void zero;
  return `fn main(){
  let N = ${len};
  ${decls} let c = ${arrFn}(N);
  for (let i = 0; i < N; i = i + 1) { ${inits} }
  ${inplace}
  for (let i = 0; i < N; i = i + 1) { c[i] = ${kernel}; }
  ${printer}
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
  const isF = r() < 0.5;
  const len = (r() * 41) | 0; // 0..40 — straddles every multiple of 4
  const src = genProgram(r, isF, len);
  let b0, b3;
  try { b0 = buildV(src, 0); b3 = buildV(src, 3); }
  catch (e) { console.error('COMPILE FAIL on:\n' + src + '\n' + e.message); process.exit(1); }
  if (b3.fired) fired++;
  const o0 = await runWasm(b0.bytes);
  const o3 = await runWasm(b3.bytes);
  if (o0 !== o3) {
    mismatches++;
    console.error(`MISMATCH (seed ${(SEED0 + n) >>> 0}, ${isF ? 'f32' : 'i32'}, N=${len}):\n${src}\n -O0: ${o0}\n -O3: ${o3}`);
    if (mismatches > 5) break;
  }
}
const pct = ((fired / COUNT) * 100).toFixed(1);
console.log(`${COUNT} random elementwise array kernels (i32 + f32, lengths 0..40) — vectorizer fired on ${fired} (${pct}%); mismatches: ${mismatches}`);
process.exit(mismatches === 0 ? 0 : 1);
