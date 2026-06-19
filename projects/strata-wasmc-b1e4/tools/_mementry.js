// Plain-JS entry bundled by Vite for the memory-optimization check harness.
// Re-exports the pieces tools/check-mem.mjs needs to compile a program and
// inspect its IR. Not part of the app build (tsconfig includes only src/).
export { parse } from '../src/compiler/parser.ts';
export { typecheck } from '../src/compiler/types.ts';
export { interpret } from '../src/compiler/interp.ts';
export { compile } from '../src/compiler/pipeline.ts';
export { runWasm } from '../src/compiler/runner.ts';
