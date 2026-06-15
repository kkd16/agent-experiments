// Fuzz the *compiled wasm* float formatter against ECMAScript String() over many
// random doubles, at every optimization level. This proves the from-scratch
// Dragon4 written in Strata reproduces V8's shortest round-trip output exactly.
import { build } from 'vite';
import { pathToFileURL } from 'node:url';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const outDir = resolve(here, '../node_modules/.fuzz');

await build({
  configFile: false,
  logLevel: 'error',
  build: {
    ssr: true, outDir, emptyOutDir: true,
    lib: { entry: resolve(here, '_fuzzentry.js'), formats: ['es'], fileName: 'fuzz' },
    rollupOptions: { output: { entryFileNames: 'fuzz.mjs' } },
    minify: false, target: 'node20',
  },
});
const mod = await import(pathToFileURL(resolve(outDir, 'fuzz.mjs')).href);

const buf = new ArrayBuffer(8);
const dv = new DataView(buf);
const u8 = new Uint8Array(buf);
function ref(x) {
  if (Number.isNaN(x)) return 'nan';
  if (x === Infinity) return 'inf';
  if (x === -Infinity) return '-inf';
  if (Object.is(x, -0)) return '0';
  return String(x);
}

const N = Number(process.argv[2] ?? 3_000_000);
const levels = [0, 1, 2, 3];
let totalFail = 0;
for (const level of levels) {
  const module = await WebAssembly.compile(mod.buildFmt(level));
  // The bump heap never frees, so re-instantiate periodically to reset it (each
  // fmt() call leaks its scratch bignums + result string — consistent with the
  // language's no-GC model; here we just need a fresh 16 MiB now and then).
  let fmt, mem;
  const reset = () => {
    const inst = new WebAssembly.Instance(module, { env: {} });
    fmt = inst.exports.fmt;
    mem = new Uint8Array(inst.exports.memory.buffer);
  };
  reset();
  const readStr = (ptr) => {
    const len = mem[ptr] | (mem[ptr + 1] << 8) | (mem[ptr + 2] << 16) | (mem[ptr + 3] << 24);
    let s = '';
    for (let i = 0; i < len; i++) s += String.fromCharCode(mem[ptr + 8 + i]);
    return s;
  };
  let fail = 0, checked = 0, sinceReset = 0;
  const bad = [];
  const check = (x) => {
    checked++;
    if (++sinceReset >= 2500) { sinceReset = 0; reset(); }
    const got = readStr(fmt(x));
    const want = ref(x);
    if (got !== want) { fail++; if (bad.length < 20) bad.push(`x=${x} wasm=${got} ref=${want}`); }
  };
  // edge cases
  for (const x of [0, -0, 1, -1, 0.1, 0.2, 0.3, 0.5, 1.5, 2.5, 100, 1e21, 1e-7, 5e-7, 1e-6,
    1.7976931348623157e308, 5e-324, 4.9e-324, 2.2250738585072014e-308, 0.1 + 0.2, 1 / 3,
    9007199254740993, 123456789, 6.022e23, 1e20, 1e22, Infinity, -Infinity, NaN]) check(x);
  for (let p = -323; p <= 308; p++) { const v = Number(`1e${p}`); check(v); check(-v); }
  for (let i = 0; i < N; i++) {
    for (let j = 0; j < 8; j++) u8[j] = (Math.random() * 256) | 0;
    check(dv.getFloat64(0));
  }
  // "nice" magnitudes that stress notation
  for (let i = 0; i < (N / 4) | 0; i++) check((Math.random() * 2 - 1) * Math.pow(10, (Math.random() * 60 - 30)));
  console.log(`-O${level}: checked ${checked}, fails ${fail}`);
  for (const s of bad) console.log('   ', s);
  totalFail += fail;
}
console.log(totalFail === 0 ? '\nALL CLEAN — compiled wasm matches String() exactly' : `\n${totalFail} MISMATCHES`);
process.exit(totalFail ? 1 : 0);
