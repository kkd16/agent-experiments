// Plain-JS entry bundled by Vite for the jump-threading checks
// (tools/check-thread.mjs): an activity probe + a seeded differential fuzzer.
export { probeThread, fuzz, genProgram } from '../src/compiler/threadProbe.ts';
