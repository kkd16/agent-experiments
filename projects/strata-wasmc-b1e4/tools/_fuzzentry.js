// Bundled entry for the float-formatter fuzz: compiles a Strata program that
// exports `fmt(x) -> str` (which calls str(x)) and hands back the wasm bytes.
import { compile } from '../src/compiler/pipeline.ts';

export function buildFmt(level) {
  // No `main`, so every function (including the exported `fmt`) is exported and
  // the float-format prelude is pulled in by `str(float)`.
  const src = `fn fmt(x: float) -> str { return str(x); }`;
  const comp = compile(src, level);
  if (!comp.ok || !comp.bytes) throw new Error('compile failed: ' + (comp.error && comp.error.message));
  return comp.bytes;
}
