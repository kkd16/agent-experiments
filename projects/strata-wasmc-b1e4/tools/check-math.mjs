// Accuracy + differential oracle for Strata's transcendental math library.
//
// For every kernel and a sweep of inputs it builds a Strata program that prints
// each result (via str(float), the Dragon4 shortest round-trip), then:
//   1. compiles + runs the real WebAssembly at -O0 and -O3,
//   2. runs the reference interpreter,
//   3. asserts wasm output == interpreter output  (the differential contract —
//      proves the shared MATH_PRELUDE kernel lowers identically on both paths),
//   4. parses each printed value and asserts it is within a tight relative/abs
//      tolerance of the host `Math.*`  (proves the math is actually *correct*,
//      not merely self-consistent).
//
// Run with:  node tools/check-math.mjs   (after `pnpm install`)
import { build } from 'vite';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { resolve, dirname } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const outDir = resolve(here, '../node_modules/.mathharness');

await build({
  configFile: false,
  logLevel: 'error',
  build: {
    ssr: true,
    outDir,
    emptyOutDir: true,
    lib: { entry: resolve(here, '_mathentry.js'), formats: ['es'], fileName: 'mathharness' },
    rollupOptions: { output: { entryFileNames: 'mathharness.mjs' } },
    minify: false,
    target: 'node20',
  },
});
const mod = await import(pathToFileURL(resolve(outDir, 'mathharness.mjs')).href);
const { parse, typecheck, interpret, compile, runWasm } = mod;

// A Strata float literal that round-trips to exactly the JS double `x`.
const lit = (x) => {
  if (!Number.isFinite(x)) throw new Error('non-finite input ' + x);
  const s = String(x);
  return /[.eE]/.test(s) ? s : s + '.0';
};

// Build a program that prints fn(input) for each input (unary or binary).
function programFor(fn, inputs, binary) {
  const n = inputs.length;
  let body = '';
  if (!binary) {
    body += `  let xs = float_array(${n});\n`;
    inputs.forEach((v, i) => { body += `  xs[${i}] = ${lit(v)};\n`; });
    body += `  let i = 0;\n  while (i < ${n}) { print(str(${fn}(xs[i]))); i = i + 1; }\n`;
  } else {
    body += `  let xs = float_array(${n});\n  let ys = float_array(${n});\n`;
    inputs.forEach(([a, b], i) => { body += `  xs[${i}] = ${lit(a)};\n  ys[${i}] = ${lit(b)};\n`; });
    body += `  let i = 0;\n  while (i < ${n}) { print(str(${fn}(xs[i], ys[i]))); i = i + 1; }\n`;
  }
  return `fn main() {\n${body}}\n`;
}

const close = (got, want, relTol, absTol) => {
  if (Number.isNaN(want)) return Number.isNaN(got);
  if (!Number.isFinite(want)) return got === want;
  const err = Math.abs(got - want);
  return err <= absTol || err <= relTol * Math.abs(want);
};

// linspace helper
const lin = (a, b, k) => Array.from({ length: k }, (_, i) => a + ((b - a) * i) / (k - 1));

const REL = 1e-12; // default relative tolerance (a few ULP)

/** @type {{fn:string, js:Function, inputs:number[]|number[][], binary?:boolean, rel?:number, abs?:number}[]} */
const SPECS = [
  { fn: 'exp', js: Math.exp, inputs: [...lin(-20, 20, 41), -700, 700, 0, 1, -1] },
  { fn: 'expm1', js: Math.expm1, inputs: [...lin(-2, 2, 41), 1e-6, -1e-6, 1e-9], abs: 1e-15 },
  { fn: 'ln', js: Math.log, inputs: [...lin(0.01, 100, 60), 1, 2, 0.5, 1e-8, 1e8] },
  { fn: 'log2', js: Math.log2, inputs: [...lin(0.01, 100, 40), 1, 2, 8, 1024] },
  { fn: 'log10', js: Math.log10, inputs: [...lin(0.01, 100, 40), 1, 10, 1000] },
  { fn: 'log1p', js: Math.log1p, inputs: [...lin(-0.9, 5, 50), 1e-6, -1e-6, 1e-9], abs: 1e-15 },
  { fn: 'sin', js: Math.sin, inputs: [...lin(-10, 10, 81), 0, Math.PI, Math.PI / 2, 1e6], abs: 1e-13 },
  { fn: 'cos', js: Math.cos, inputs: [...lin(-10, 10, 81), 0, Math.PI, Math.PI / 2, 1e6], abs: 1e-13 },
  { fn: 'tan', js: Math.tan, inputs: lin(-1.4, 1.4, 41), rel: 1e-11, abs: 1e-12 },
  { fn: 'atan', js: Math.atan, inputs: [...lin(-50, 50, 81), 0, 1, -1], abs: 1e-13 },
  { fn: 'asin', js: Math.asin, inputs: lin(-0.99, 0.99, 61), abs: 1e-12 },
  { fn: 'acos', js: Math.acos, inputs: lin(-0.99, 0.99, 61), abs: 1e-12 },
  { fn: 'sinh', js: Math.sinh, inputs: lin(-20, 20, 61), rel: 1e-12, abs: 1e-13 },
  { fn: 'cosh', js: Math.cosh, inputs: lin(-20, 20, 61) },
  { fn: 'tanh', js: Math.tanh, inputs: [...lin(-10, 10, 61), 0], abs: 1e-14 },
  { fn: 'cbrt', js: Math.cbrt, inputs: [...lin(-1000, 1000, 81), 0, 27, -8, 1e-9, 1e9] },
  { fn: 'pow', js: Math.pow, binary: true, inputs: [[2, 10], [2, 0.5], [9, 0.5], [2, -3], [-2, 3], [-8, 2], [10, 3], [0.5, 4], [3, 3.3], [1.5, -2.7], [5, 0]], rel: 1e-11 },
  { fn: 'atan2', js: Math.atan2, binary: true, inputs: [[1, 1], [1, -1], [-1, 1], [-1, -1], [3, 4], [-3, 4], [0, 1], [0, -1], [1, 0], [-1, 0]], abs: 1e-13 },
  { fn: 'hypot', js: Math.hypot, binary: true, inputs: [[3, 4], [5, 12], [1, 1], [1e200, 1e200], [0, 0], [-3, -4], [1e-200, 1e-200]] },
  { fn: 'fmod', js: (a, b) => a % b, binary: true, inputs: [[10, 3], [10.5, 0.5], [-10, 3], [10, -3], [7.7, 2.1], [100, 7], [1, 0.3], [5.5, 5.5]], abs: 1e-13 },
];

let total = 0, fails = 0;
for (const spec of SPECS) {
  const rel = spec.rel ?? REL;
  const abs = spec.abs ?? 0;
  const src = programFor(spec.fn, spec.inputs, spec.binary);
  const program = parse(src);
  typecheck(program);
  const ref = interpret(program);
  let wasmFail = '';
  for (const lvl of [0, 3]) {
    const comp = compile(src, lvl);
    if (!comp.ok) { wasmFail = `compile error @O${lvl}: ${comp.error?.message}`; break; }
    const run = await runWasm(comp.bytes);
    if (JSON.stringify(run.output) !== JSON.stringify(ref.output)) {
      wasmFail = `wasm≠interp @O${lvl}`;
      break;
    }
  }
  // Accuracy vs host Math.*
  let worst = 0, accFail = 0, firstBad = '';
  ref.output.forEach((line, i) => {
    const got = Number(line);
    const want = spec.binary ? spec.js(spec.inputs[i][0], spec.inputs[i][1]) : spec.js(spec.inputs[i]);
    if (!close(got, want, rel, abs)) {
      accFail++;
      if (!firstBad) firstBad = `f(${JSON.stringify(spec.inputs[i])}) = ${got} want ${want}`;
    } else if (Number.isFinite(want) && want !== 0) {
      worst = Math.max(worst, Math.abs(got - want) / Math.abs(want));
    }
  });
  total++;
  const ok = !wasmFail && accFail === 0;
  if (!ok) fails++;
  const status = ok ? 'ok  ' : 'FAIL';
  console.log(`${status} ${spec.fn.padEnd(7)} n=${String(ref.output.length).padStart(3)}  maxRelErr=${worst.toExponential(2)}  ${wasmFail}${accFail ? `  accFail=${accFail} (${firstBad})` : ''}`);
}
console.log(`\n${total - fails}/${total} kernels pass (wasm≡interp at -O0/-O3, and within tolerance of Math.*)`);
if (fails) process.exit(1);
