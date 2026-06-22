// Reassociation fuzz: generate thousands of random integer *affine* expression
// trees (i32 and i64), each built over loop-carried values so they stay symbolic
// past SCCP, and assert the optimized wasm (-O3, where reassociation runs) prints
// exactly what the unoptimized wasm (-O0, where it does not) does. Reassociation
// is the only pass that differs in what it canonicalizes here, so any divergence
// is its bug. Node provides `WebAssembly`, so this is the real backend end-to-end.
// Also tallies how often the pass fired, to prove it is doing real work.
//
// Run with:  node tools/check-reassoc.mjs [count] [seed]
import { build } from 'vite';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { resolve, dirname } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const outDir = resolve(here, '../node_modules/.reassocharness');
await build({
  configFile: false, logLevel: 'error',
  build: { ssr: true, outDir, emptyOutDir: true,
    lib: { entry: resolve(here, '_reassocentry.js'), formats: ['es'], fileName: 'rh' },
    rollupOptions: { output: { entryFileNames: 'rh.mjs' } }, minify: false, target: 'node20' },
});
const { buildR } = await import(pathToFileURL(resolve(outDir, 'rh.mjs')).href);

// deterministic RNG (mulberry32)
function rng(seed) { let s = seed >>> 0; return () => { s |= 0; s = (s + 0x6D2B79F5) | 0; let t = Math.imul(s ^ (s >>> 15), 1 | s); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
const pick = (r, a) => a[(r() * a.length) | 0];

// A grammar of integer affine trees: +, -, *const, <<const over a few atoms and
// constants. `*` and `<<` keep one side constant (so they are reassociable
// coefficients); both small and wrap-inducing constants are drawn.
function genExpr(r, vars, L, depth) {
  if (depth <= 0 || r() < 0.32) {
    return r() < 0.6 ? pick(r, vars) : konst(r, L);
  }
  const k = r();
  const a = () => genExpr(r, vars, L, depth - 1);
  if (k < 0.34) return `(${a()} + ${a()})`;
  if (k < 0.6) return `(${a()} - ${a()})`;
  if (k < 0.84) return r() < 0.5 ? `(${a()} * ${coeff(r, L)})` : `(${coeff(r, L)} * ${a()})`;
  return `(${a()} << ${((r() * (L === 'long' ? 12 : 6)) | 0)}${L === 'long' ? 'L' : ''})`;
}
function konst(r, L) {
  const big = r() < 0.25;
  const sfx = L === 'long' ? 'L' : '';
  if (big) { const v = L === 'long' ? `${((r() * 9e18) | 0)}` + `${(r() * 1e9) | 0}` : `${((r() * 4.0e9) - 2.0e9) | 0}`; return v.startsWith('-') ? `(${v}${sfx})` : `${v}${sfx}`; }
  const v = ((r() * 21) | 0) - 10;
  return v < 0 ? `(${v}${sfx})` : `${v}${sfx}`;
}
function coeff(r, L) {
  const sfx = L === 'long' ? 'L' : '';
  const big = r() < 0.3;
  const v = big ? (L === 'long' ? ((r() * 6e9) | 0) : (((r() * 4.0e9) - 2.0e9) | 0)) : (((r() * 25) | 0) - 12);
  return v < 0 ? `(${v}${sfx})` : `${v}${sfx}`;
}

function genProgram(r, L) {
  const ty = L; // 'int' | 'long'
  const one = L === 'long' ? '1L' : '1';
  const zero = L === 'long' ? '0L' : '0';
  // Three symbolic atoms derived from the loop counter, spanning negative/large.
  const va = L === 'long' ? 'a' : 'a', vb = 'b', vc = 'c';
  const vars = [va, vb, vc];
  const exprs = [];
  const n = 2 + ((r() * 3) | 0);
  for (let i = 0; i < n; i++) exprs.push(genExpr(r, vars, L, 3 + ((r() * 3) | 0)));
  const body = exprs.map((e) => `acc = acc ^ (${e});`).join('\n    ');
  // a,b,c sweep wide ranges (incl. negative & wrap) as functions of i.
  const mkA = L === 'long' ? 'i * 2654435761L - 1000000000L' : 'i * 374761393 - 1000000000';
  const mkB = L === 'long' ? 'i * (-50000000L) + 7L' : 'i * (-500000) + 7';
  const mkC = L === 'long' ? 'i' : 'i';
  return `fn main(){
  let acc: ${ty} = ${zero};
  for (let i: ${ty} = ${zero}; i < 240${L === 'long' ? 'L' : ''}; i = i + ${one}) {
    let a: ${ty} = ${mkA};
    let b: ${ty} = ${mkB};
    let c: ${ty} = ${mkC};
    ${body}
  }
  print(acc);
}`;
}

async function runWasm(bytes, L) {
  const out = [];
  const env = { print_int: (x) => out.push(String(x | 0)), print_long: (x) => out.push(String(BigInt.asIntN(64, x))), print_float: (x) => out.push(String(x)), print_bool: (x) => out.push(String(!!x)), print_str: () => {} };
  const inst = await WebAssembly.instantiate(await WebAssembly.compile(bytes), { env });
  inst.exports.main();
  return out.join('|');
}

const COUNT = Number(process.argv[2] ?? 4000);
const SEED0 = Number(process.argv[3] ?? 0x5ea1);
let fired = 0, mismatches = 0;
for (let n = 0; n < COUNT; n++) {
  const r = rng((SEED0 + n * 2654435761) >>> 0);
  const L = r() < 0.5 ? 'int' : 'long';
  const src = genProgram(r, L);
  let b0, b3;
  try { b0 = buildR(src, 0); b3 = buildR(src, 3); }
  catch (e) { console.error('COMPILE FAIL on:\n' + src + '\n' + e.message); process.exit(1); }
  if (b3.fired) fired++;
  const o0 = await runWasm(b0.bytes, L);
  const o3 = await runWasm(b3.bytes, L);
  if (o0 !== o3) {
    mismatches++;
    console.error(`MISMATCH (seed ${(SEED0 + n) >>> 0}, ${L}):\n${src}\n -O0: ${o0}\n -O3: ${o3}`);
    if (mismatches > 5) break;
  }
}
const pct = ((fired / COUNT) * 100).toFixed(1);
console.log(`${COUNT} random affine programs (i32+i64) — reassociation fired on ${fired} (${pct}%); mismatches: ${mismatches}`);
process.exit(mismatches === 0 ? 0 : 1);
