// Plain-JS entry bundled by Vite for the correlated-branch-folding checks
// (tools/check-correlate.mjs): an activity probe + a seeded differential fuzzer.
export { probeCorrelate, fuzz, genProgram } from '../src/compiler/correlateProbe.ts';
