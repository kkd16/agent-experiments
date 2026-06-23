// Plain-JS entry bundled by Vite for the loop-unswitching checks
// (tools/check-unswitch.mjs): an activity probe + a seeded differential fuzzer.
export { probeUnswitch, fuzz, genProgram } from '../src/compiler/unswitchProbe.ts';
