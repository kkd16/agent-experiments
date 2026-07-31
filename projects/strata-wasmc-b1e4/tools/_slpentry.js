// Bundled entry for the SLP-vectorizer checks (tools/check-slp.mjs). Re-exports
// the probe (did the pass fire?) and the seeded differential fuzzer from the
// TS source, so the harness runs the exact in-app compiler through Vite's
// extensionless-TS resolution.
export { probeSlp, genProgram, fuzz } from '../src/compiler/slpProbe.ts';
export { compile } from '../src/compiler/pipeline.ts';
export { parse } from '../src/compiler/parser.ts';
export { typecheck } from '../src/compiler/types.ts';
export { interpret } from '../src/compiler/interp.ts';
export { runWasm } from '../src/compiler/runner.ts';
export { runOnVm } from '../src/wasm/vm.ts';
