// Plain-JS entry bundled by Vite for the known-bits (bitwise lattice) checks
// (tools/check-knownbits.mjs): an activity probe + a seeded differential fuzzer.
export { probeKb, fuzz, genProgram } from '../src/compiler/knownbitsProbe.ts';
