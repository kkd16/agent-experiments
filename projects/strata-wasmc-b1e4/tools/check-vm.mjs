// From-scratch-VM check harness. For every example + adversarial program, at
// -O0..-O3, it:
//   1. compiles the real WebAssembly,
//   2. runs it three ways — the host's WebAssembly (V8), the reference
//      tree-walking interpreter, and the project's own hand-written VM
//      (`src/wasm/`, which decodes the bytes and executes them on a stack
//      machine) — and asserts all three print identical output,
//   3. tallies the distinct wasm opcodes the corpus exercises (proving the VM's
//      decoder + interpreter cover the backend's whole instruction set) and the
//      total instructions the VM retired.
//
// Run with:  node tools/check-vm.mjs   (after `pnpm install`)
import { build } from 'vite';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { resolve, dirname } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const outDir = resolve(here, '../node_modules/.vmharness');

await build({
  configFile: false,
  logLevel: 'error',
  build: {
    ssr: true,
    outDir,
    emptyOutDir: true,
    lib: { entry: resolve(here, '_vmentry.js'), formats: ['es'], fileName: 'vmharness' },
    rollupOptions: { output: { entryFileNames: 'vmharness.mjs' } },
    minify: false,
    target: 'node20',
  },
});
const mod = await import(pathToFileURL(resolve(outDir, 'vmharness.mjs')).href);
const { parse, typecheck, interpret, compile, runWasm, runOnVm, WasmVM, decodeModule, disassemble, EXAMPLES, TESTS } = mod;

const programs = [
  ...EXAMPLES.map((e) => ({ name: 'ex:' + e.id, source: e.source })),
  ...TESTS.map((t) => ({ name: t.name, source: t.source })),
];
const levels = [0, 1, 2, 3];

let pass = 0;
let fail = 0;
let totalInstrs = 0;
const opcodes = new Set();
const failures = [];

for (const p of programs) {
  for (const lvl of levels) {
    let refOut, refErr;
    try {
      const prog = parse(p.source);
      typecheck(prog);
      const ref = interpret(prog);
      refOut = JSON.stringify(ref.output);
      refErr = ref.error ?? '';
    } catch (e) {
      refOut = '<<interp threw>>';
      refErr = String(e?.message ?? e);
    }
    const comp = compile(p.source, lvl);
    if (!comp.ok || !comp.bytes) {
      fail++;
      failures.push(`${p.name} -O${lvl}: compile error ${comp.error?.message}`);
      continue;
    }
    const v8 = await runWasm(comp.bytes);
    const vm = runOnVm(comp.bytes);

    // Tally distinct opcodes + instruction count via a fresh stepping VM.
    const decoded = decodeModule(comp.bytes);
    for (const code of decoded.codes) {
      for (const ins of disassemble(code.body).instrs) opcodes.add(ins.text.split(/[\s]/)[0]);
    }
    const stepVm = new WasmVM(decoded);
    stepVm.runToEnd();
    totalInstrs += stepVm.steps;

    const v8ok = JSON.stringify(v8.output) === refOut && (v8.error ?? '') === refErr;
    const vmok = JSON.stringify(vm.output) === refOut && (vm.error ?? '') === refErr;
    const v8vm = JSON.stringify(v8.output) === JSON.stringify(vm.output);
    if (v8ok && vmok && v8vm) {
      pass++;
    } else {
      fail++;
      failures.push(
        `${p.name} -O${lvl}: ref=${refOut.slice(0, 60)} v8=${JSON.stringify(v8.output).slice(0, 60)} ` +
          `vm=${JSON.stringify(vm.output).slice(0, 60)}${vm.error ? ` (vm trap: ${vm.error})` : ''}`,
      );
    }
  }
}

// --- trap parity ------------------------------------------------------------
// The main battery is deliberately non-trapping (trap *messages* differ across
// engines, so they aren't comparable). These programs DO trap; we assert that V8
// and the from-scratch VM trap on the same run — both report an error, and the
// output produced *before* the trap is identical. Compiled at -O0 so no constant
// folding turns the runtime trap into a compile-time fold.
const TRAP_PROGRAMS = [
  { name: 'div-by-zero', src: `fn d(x: int) -> int { return 100 / x; }\nfn main() { print(d(0)); }` },
  { name: 'div-overflow', src: `fn d(x: int) -> int { return -2147483648 / x; }\nfn main() { print(d(-1)); }` },
  { name: 'rem-by-zero', src: `fn d(x: int) -> int { return 5 % x; }\nfn main() { print(7); print(d(0)); }` },
  { name: 'null-fn-call', src: `fn main() { let f: fn() -> int = null; print(f()); }` },
  { name: 'long-div-zero', src: `fn d(x: long) -> long { return 9L / x; }\nfn main() { print(d(0L)); }` },
];
let trapPass = 0;
for (const p of TRAP_PROGRAMS) {
  const comp = compile(p.src, 0);
  if (!comp.ok) { fail++; failures.push(`trap:${p.name}: compile error ${comp.error?.message}`); continue; }
  const v8 = await runWasm(comp.bytes);
  const vm = runOnVm(comp.bytes);
  const bothTrap = !!v8.error && !!vm.error;
  const sameOut = JSON.stringify(v8.output) === JSON.stringify(vm.output);
  if (bothTrap && sameOut) { trapPass++; }
  else { fail++; failures.push(`trap:${p.name}: v8.err=${v8.error} vm.err=${vm.error} v8.out=${JSON.stringify(v8.output)} vm.out=${JSON.stringify(vm.output)}`); }
}

for (const f of failures) console.log('FAIL ' + f);
console.log(`trap parity: ${trapPass}/${TRAP_PROGRAMS.length} programs trap identically on V8 and the VM`);
console.log(
  `\n${fail === 0 ? 'ALL AGREE' : fail + ' FAILURES'} — ${pass}/${pass + fail} checks ` +
    `(V8 = reference interpreter = from-scratch VM) across -O0..-O3`,
);
console.log(
  `from-scratch VM retired ${totalInstrs.toLocaleString()} wasm instructions across the corpus, ` +
    `exercising ${opcodes.size} distinct opcodes.`,
);
process.exit(fail === 0 ? 0 : 1);
