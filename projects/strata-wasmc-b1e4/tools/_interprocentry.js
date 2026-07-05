// Plain-JS entry bundled by Vite for the interprocedural-optimization checks
// (tools/check-interproc.mjs): an activity probe + a seeded differential fuzzer.
export { probeInterproc, fuzz, genProgram } from '../src/compiler/interprocProbe.ts';
