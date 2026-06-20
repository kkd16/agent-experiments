// Plain-JS entry bundled by Vite for the from-scratch-VM check harness
// (tools/check-vm.mjs). Re-exports the compiler front-end, the host-engine
// runner, the reference interpreter, and the project's own WebAssembly VM +
// decoder/disassembler, plus the program corpus. Not part of the app build.
export { parse } from '../src/compiler/parser.ts';
export { typecheck } from '../src/compiler/types.ts';
export { interpret } from '../src/compiler/interp.ts';
export { compile } from '../src/compiler/pipeline.ts';
export { runWasm } from '../src/compiler/runner.ts';
export { runOnVm, WasmVM } from '../src/wasm/vm.ts';
export { decodeModule } from '../src/wasm/decode.ts';
export { disassemble } from '../src/wasm/disasm.ts';
export { EXAMPLES } from '../src/examples.ts';
export { TESTS } from '../src/compiler/tests.ts';
