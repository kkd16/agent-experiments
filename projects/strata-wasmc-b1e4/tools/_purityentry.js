// Plain-JS entry bundled by Vite for the purity checks (tools/check-purity.mjs):
// an activity probe + a seeded differential fuzzer.
export { probePurity, fuzz, genProgram } from '../src/compiler/purityProbe.ts';
