// Plain-JS entry bundled by Vite for the math accuracy/differential harness.
// Re-exports the pieces tools/check-math.mjs needs to compile + run a program
// on both backends. Not part of the app build (tsconfig includes only src/).
export { parse } from '../src/compiler/parser.ts';
export { typecheck } from '../src/compiler/types.ts';
export { interpret } from '../src/compiler/interp.ts';
export { compile } from '../src/compiler/pipeline.ts';
export { runWasm } from '../src/compiler/runner.ts';
