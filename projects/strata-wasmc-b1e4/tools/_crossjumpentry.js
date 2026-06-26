// Plain-JS entry bundled by Vite for the cross-jumping (tail-merging) checks
// (tools/check-crossjump.mjs): an activity probe + a seeded differential fuzzer.
export { probeCrossJump, fuzz, genProgram } from '../src/compiler/crossjumpProbe.ts';
