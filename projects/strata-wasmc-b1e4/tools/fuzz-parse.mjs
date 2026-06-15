// Fuzz the *compiled wasm* parse_float at every optimization level, two ways:
//   (1) round-trip: parse_float(str(x)) must equal x bit-for-bit, for random x;
//   (2) arbitrary decimal strings vs JS Number().
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

const buf = new ArrayBuffer(8), dv = new DataView(buf), u8 = new Uint8Array(buf);
const bits = (x) => (dv.setFloat64(0, x), dv.getBigUint64(0));
const N = Number(process.argv[2] ?? 2_000_000);
const STR_ADDR = 8 * 1024 * 1024; // well above the bump heap for a single call
const levels = [0, 1, 2, 3];
let totalFail = 0;

for (const level of levels) {
  const rtMod = await WebAssembly.compile(mod.buildProg(`fn rt(x: float) -> float { return parse_float(str(x)); }`, level));

  // --- (1) round-trip ---
  let rt, rtMem;
  const resetRt = () => { const i = new WebAssembly.Instance(rtMod, { env: {} }); rt = i.exports.rt; rtMem = i.exports.memory; };
  resetRt();
  let fail = 0, checked = 0, since = 0; const bad = [];
  for (let k = 0; k < N; k++) {
    if (++since >= 800) { since = 0; resetRt(); }
    for (let j = 0; j < 8; j++) u8[j] = (Math.random() * 256) | 0;
    const x = dv.getFloat64(0);
    if (!Number.isFinite(x)) continue;
    checked++;
    const got = rt(x);
    if (bits(got) !== bits(x)) { fail++; if (bad.length < 20) bad.push(`rt x=${x} got=${got}`); }
  }
  console.log(`-O${level} round-trip: checked ${checked}, fails ${fail}`);
  for (const b of bad) console.log('   ', b);
  totalFail += fail;
}

// --- (2) arbitrary decimal strings vs Number() (pass the string through memory) ---
function ref(s) { return Number(s); }
for (const level of levels) {
  const pfMod = await WebAssembly.compile(mod.buildProg(`fn pf(s: str) -> float { return parse_float(s); }`, level));
  // parse_float wants a str; an i32 handle *is* a str pointer, so we pass the
  // address where we hand-write a string object [len][pad][bytes].
  let pf, mem;
  const reset = () => {
    const inst = new WebAssembly.Instance(pfMod, { env: {} });
    pf = inst.exports.pf; mem = new Uint8Array(inst.exports.memory.buffer);
  };
  reset();
  const writeStr = (s) => {
    mem[STR_ADDR] = s.length & 0xff; mem[STR_ADDR + 1] = (s.length >> 8) & 0xff;
    mem[STR_ADDR + 2] = (s.length >> 16) & 0xff; mem[STR_ADDR + 3] = (s.length >> 24) & 0xff;
    for (let i = 0; i < s.length; i++) mem[STR_ADDR + 8 + i] = s.charCodeAt(i) & 0xff;
  };
  let fail = 0, checked = 0, since = 0; const bad = [];
  const ck = (s) => {
    if (++since >= 500) { since = 0; reset(); }
    checked++;
    writeStr(s);
    const got = pf(STR_ADDR);
    const want = ref(s);
    if (bits(got) !== bits(want) && !(Number.isNaN(got) && Number.isNaN(want))) {
      fail++; if (bad.length < 20) bad.push(`s=${s} got=${got} want=${want}`);
    }
  };
  for (const s of ['0', '1', '-1', '0.5', '0.1', '1e10', '1e-10', '5e-324', '1e308', '1e-308',
    '1.7976931348623157e308', '2.2250738585072014e-308', '0.30000000000000004', '9007199254740993']) ck(s);
  for (let i = 0; i < (N / 4) | 0; i++) {
    const dg = 1 + ((Math.random() * 19) | 0);
    let m = '';
    for (let k = 0; k < dg; k++) m += String((Math.random() * 10) | 0);
    const dot = (Math.random() * dg) | 0;
    let s = m.slice(0, dot) + '.' + m.slice(dot) + 'e' + (((Math.random() * 700) | 0) - 350);
    if (Math.random() < 0.5) s = '-' + s;
    ck(s);
  }
  console.log(`-O${level} strings:    checked ${checked}, fails ${fail}`);
  for (const b of bad) console.log('   ', b);
  totalFail += fail;
}
console.log(totalFail === 0 ? '\nALL CLEAN — compiled parse_float round-trips and matches Number()' : `\n${totalFail} MISMATCHES`);
process.exit(totalFail ? 1 : 0);
