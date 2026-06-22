// Bundled entry for the reassociation fuzz (tools/check-reassoc.mjs). Compiles a
// generated Strata program and returns the wasm bytes plus whether the
// reassociation pass actually fired — so the fuzz checks both correctness
// (-O0 == -O3) and activity (the pass did real work).
import { compile } from '../src/compiler/pipeline.ts';
export function buildR(src, level) {
  const c = compile(src, level);
  if (!c.ok) throw new Error('compile failed: ' + JSON.stringify(c.error));
  const fired = c.optLog.some((p) => p.name.startsWith('reassociate') && p.changed > 0);
  return { bytes: c.bytes, fired };
}
