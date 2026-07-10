// Plain-JS entry bundled by Vite for the generics check harness. Re-exports the
// front-end pieces tools/check-generics.mjs needs to elaborate a program, inspect
// the concrete clones the monomorphizer produced, and exercise the error paths.
// Not part of the app build (tsconfig includes only src/).
export { parse } from '../src/compiler/parser.ts';
export { monomorphize } from '../src/compiler/generics.ts';
export { typecheck } from '../src/compiler/types.ts';
export { interpret } from '../src/compiler/interp.ts';
export { compile } from '../src/compiler/pipeline.ts';
export { runWasm } from '../src/compiler/runner.ts';
