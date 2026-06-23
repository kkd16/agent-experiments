// Bundled entry for the auto-vectorizer fuzz (tools/check-vec.mjs). Compiles a
// generated Strata array kernel and returns the wasm bytes plus whether the
// vectorizer actually fired — so the fuzz checks both correctness (-O0 == -O3)
// and activity (the pass widened a real loop).
import { compile } from '../src/compiler/pipeline.ts';
export function buildV(src, level) {
  const c = compile(src, level);
  if (!c.ok) throw new Error('compile failed: ' + JSON.stringify(c.error));
  const fired = c.optLog.some((p) => p.name === 'vectorize' && p.changed > 0);
  return { bytes: c.bytes, fired };
}
