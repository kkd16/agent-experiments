// Memory-bound check: run str(float)/parse_float hundreds of thousands of times
// in a SINGLE wasm instance (no re-instantiation). With the old per-call scratch
// leak this OOMs almost immediately; with heap reset it completes.
import { build } from 'vite';
import { pathToFileURL } from 'node:url';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const outDir = resolve(here, '../node_modules/.fuzz');
await build({
  configFile: false, logLevel: 'error',
  build: {
    ssr: true, outDir, emptyOutDir: true,
    lib: { entry: resolve(here, '_fuzzentry.js'), formats: ['es'], fileName: 'fuzz' },
    rollupOptions: { output: { entryFileNames: 'fuzz.mjs' } },
    minify: false, target: 'node20',
  },
});
const mod = await import(pathToFileURL(resolve(outDir, 'fuzz.mjs')).href);

const N = Number(process.argv[2] ?? 300000);
const src = `fn main(){
  let acc = 0.0;
  let okp = 0;
  for (let i = 0; i < ${N}; i = i + 1) {
    let x = float(i) * 0.5 - 1000.0;
    let r = parse_float(str(x));          // format then parse back
    if (r == x) { okp = okp + 1; }        // must round-trip exactly
    acc = acc + r;
  }
  print(okp); print(str(acc));
}`;
for (const level of [0, 3]) {
  const bytes = mod.buildProg(src, level);
  const out = [];
  let mem = null;
  const readStr = (p) => { const len = mem[p] | (mem[p + 1] << 8) | (mem[p + 2] << 16) | (mem[p + 3] << 24); let s = ''; for (let i = 0; i < len; i++) s += String.fromCharCode(mem[p + 8 + i]); return s; };
  const env = { print_int: (x) => out.push(String(x | 0)), print_str: (p) => out.push(readStr(p)), print_float: (x) => out.push(String(x)), print_long: () => {}, print_bool: () => {} };
  const inst = await WebAssembly.instantiate(await WebAssembly.compile(bytes), { env });
  mem = new Uint8Array(inst.exports.memory.buffer);
  const t0 = performance.now();
  inst.exports.main();
  const ms = (performance.now() - t0) | 0;
  const roundTripped = Number(out[0]) === N;
  console.log(`-O${level}: ${N} format+parse round-trips in one instance — okp=${out[0]} acc=${out[1]}  (${ms}ms)  ${roundTripped ? 'BOUNDED + EXACT' : 'MISMATCH'}`);
  if (!roundTripped) process.exit(1);
}
console.log('\nMemory is bounded: no OOM across a single long-lived instance, and every value round-tripped.');
