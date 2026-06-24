// Debug-info (line-table) integrity harness for the source-level VM debugger.
//
// The debugger maps the program counter of the *real, optimized* WebAssembly
// back to a source line via the compiler's line table (`comp.debug`). That only
// works if the table is exactly 1:1 with the bytecode the disassembler decodes —
// one entry per wasm instruction, in the same order. This tool proves that
// invariant holds, for every example + adversarial program, at every -O level:
//
//   1. ALIGNMENT — for each defined function, the line table has exactly as many
//      entries as the disassembled instruction stream (`spans.length ===
//      instrs.length`). A single off-by-one here would mis-attribute every
//      following instruction, so this is the load-bearing check.
//   2. BOUNDS — every mapped entry points at a real source location
//      (1 ≤ line ≤ #source-lines, col ≥ 1).
//   3. COVERAGE — at -O0 a healthy fraction of instructions carry a mapping
//      (otherwise the debugger would have nothing to highlight).
//   4. FUNCTIONAL — stepping the VM with the table attached reports source lines
//      within bounds, and a breakpoint actually stops the machine on its line.
//
// Run with:  node tools/check-debuginfo.mjs   (after `pnpm install`)
import { build } from 'vite';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { resolve, dirname } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const outDir = resolve(here, '../node_modules/.dbgharness');

await build({
  configFile: false,
  logLevel: 'error',
  build: {
    ssr: true,
    outDir,
    emptyOutDir: true,
    lib: { entry: resolve(here, '_vmentry.js'), formats: ['es'], fileName: 'dbgharness' },
    rollupOptions: { output: { entryFileNames: 'dbgharness.mjs' } },
    minify: false,
    target: 'node20',
  },
});
const mod = await import(pathToFileURL(resolve(outDir, 'dbgharness.mjs')).href);
const { compile, decodeModule, disassemble, WasmVM, EXAMPLES, TESTS } = mod;

const programs = [
  ...EXAMPLES.map((e) => ({ name: 'ex:' + e.id, source: e.source })),
  ...TESTS.map((t) => ({ name: t.name, source: t.source })),
];
const levels = [0, 1, 2, 3];

let checks = 0;
let fail = 0;
let fnCount = 0;
let coverNum = 0; // mapped non-structural instrs at -O0
let coverDen = 0; // total non-structural instrs at -O0
const failures = [];
const STRUCTURAL = new Set(['end', 'else', 'block', 'loop', 'if']);

for (const p of programs) {
  const srcLines = p.source.split('\n').length;
  for (const lvl of levels) {
    const comp = compile(p.source, lvl);
    if (!comp.ok || !comp.bytes) {
      fail++;
      failures.push(`${p.name} -O${lvl}: compile error ${comp.error?.message}`);
      continue;
    }
    if (!comp.debug) {
      fail++;
      failures.push(`${p.name} -O${lvl}: no debug info on Compilation`);
      continue;
    }
    const decoded = decodeModule(comp.bytes);
    if (decoded.codes.length !== comp.debug.funcs.length) {
      fail++;
      failures.push(`${p.name} -O${lvl}: ${decoded.codes.length} code bodies vs ${comp.debug.funcs.length} debug funcs`);
      continue;
    }
    for (let fi = 0; fi < decoded.codes.length; fi++) {
      fnCount++;
      const dis = disassemble(decoded.codes[fi].body);
      const spans = comp.debug.funcs[fi].spans;
      const fname = comp.debug.funcs[fi].name;
      // Injected runtime-library functions (string/float/math prelude) are
      // compiled from their OWN Strata source, so their spans legitimately point
      // into prelude-source lines, not the user program. Bounds/coverage only
      // make sense for user functions; alignment must hold for every function.
      const isPrelude = fname.startsWith('__');
      // (1) alignment — the load-bearing invariant, checked for every function.
      checks++;
      if (spans.length !== dis.instrs.length) {
        fail++;
        failures.push(`${p.name} -O${lvl} fn#${fi} (${fname}): table ${spans.length} != instrs ${dis.instrs.length}`);
        continue;
      }
      if (isPrelude) continue;
      // (2) bounds — one check per user function: all mapped spans in range.
      checks++;
      let bad = null;
      for (let i = 0; i < spans.length; i++) {
        const s = spans[i];
        if (s && !(s.line >= 1 && s.line <= srcLines && s.col >= 1)) { bad = { i, s }; break; }
        // (3) coverage tally at -O0
        if (lvl === 0) {
          const op = dis.instrs[i].text.split(/\s/)[0];
          if (!STRUCTURAL.has(op)) { coverDen++; if (s) coverNum++; }
        }
      }
      if (bad) {
        fail++;
        failures.push(`${p.name} -O${lvl} fn#${fi} (${fname}) pc${bad.i}: span {${bad.s.line}:${bad.s.col}} out of bounds (src has ${srcLines} lines)`);
      }
    }
  }
}

// (4) functional: step a known program and assert source lines + a breakpoint.
const FN_SRC = `fn add(a: int, b: int) -> int {
  let s = a + b;
  return s;
}
fn main() {
  let x = add(2, 3);
  print(x);
}`;
{
  const comp = compile(FN_SRC, 0);
  const decoded = decodeModule(comp.bytes);
  const vm = new WasmVM(decoded, 'main', [], comp.debug);
  let sawAdd = false; // entered add()'s body at the `let s = a + b;` line (line 2)
  const lines = new Set();
  for (let i = 0; i < 100000 && !vm.halted; i++) {
    vm.step();
    const ln = vm.currentLine();
    if (ln !== undefined) lines.add(ln);
    if (ln === 2) sawAdd = true;
  }
  checks += 2;
  if (!sawAdd) { fail++; failures.push('functional: stepping never reported source line 2 (add body)'); }
  const allInRange = [...lines].every((l) => l >= 1 && l <= FN_SRC.split('\n').length);
  if (!allInRange) { fail++; failures.push(`functional: reported out-of-range lines ${[...lines]}`); }

  // breakpoint: continue from start should stop on line 7 (print(x)).
  const vm2 = new WasmVM(decoded, 'main', [], comp.debug);
  checks++;
  const stop = vm2.continueToBreakpoints(new Set([7]), 100000);
  if (stop !== 7) { fail++; failures.push(`functional: breakpoint on line 7 stopped on ${stop}`); }
}

const coverPct = coverDen ? Math.round((coverNum / coverDen) * 100) : 0;
checks++;
if (coverPct < 60) { fail++; failures.push(`coverage: only ${coverPct}% of -O0 instructions are source-mapped (expected >= 60%)`); }

for (const f of failures.slice(0, 40)) console.log('FAIL ' + f);
console.log(`\n${checks - fail}/${checks} debug-info checks pass across ${fnCount} functions, -O0..-O3`);
console.log(`-O0 line coverage: ${coverPct}% of non-structural instructions are source-mapped`);
if (fail) process.exit(1);
