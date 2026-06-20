import type { OptLevel } from './opt/optimize';
import { parse } from './parser';
import { typecheck } from './types';
import { interpret } from './interp';
import { compile } from './pipeline';
import { runWasm } from './runner';
import { runOnVm } from '../wasm/vm';

// Differential testing, exposed as an in-app feature: compile each program at
// each optimization level, run the resulting WebAssembly, and assert its output
// matches the independent tree-walking interpreter. This is the project's
// correctness conscience — if a pass or the backend ever miscompiles, it shows.
//
// A *third* engine joins the cross-check: `runOnVm` decodes the assembled bytes
// and executes them on the project's own from-scratch WebAssembly VM
// (`src/wasm/`). A program passes only when all three — the host's `WebAssembly`
// (V8), the tree-walking interpreter, and the hand-written VM — print the exact
// same output. Three independent implementations agreeing is a far stronger
// proof than two.

export interface VerifyResult {
  name: string;
  level: OptLevel;
  pass: boolean;
  detail: string;
  bytes: number;
  ms: number;
  /** Whether the from-scratch VM agreed with the reference interpreter. */
  vmPass: boolean;
}

export async function verifyOne(name: string, source: string, level: OptLevel): Promise<VerifyResult> {
  const t0 = performance.now();
  try {
    const program = parse(source);
    typecheck(program);
    const ref = interpret(program);
    const comp = compile(source, level);
    if (!comp.ok || !comp.bytes) {
      return { name, level, pass: false, detail: `compile error: ${comp.error?.message}`, bytes: 0, ms: performance.now() - t0, vmPass: false };
    }
    const run = await runWasm(comp.bytes);
    const vm = runOnVm(comp.bytes);
    const sameOut = JSON.stringify(ref.output) === JSON.stringify(run.output);
    const sameErr = (ref.error ?? '') === (run.error ?? '');
    const vmOut = JSON.stringify(ref.output) === JSON.stringify(vm.output);
    const vmErr = (ref.error ?? '') === (vm.error ?? '');
    const vmPass = vmOut && vmErr;
    const pass = sameOut && sameErr && vmPass;
    const detail = pass
      ? `${run.output.length} lines match (interp = wasm = vm)`
      : !sameOut || !sameErr
        ? `wasm mismatch — ref ${JSON.stringify(ref.output).slice(0, 50)} vs wasm ${JSON.stringify(run.output).slice(0, 50)}`
        : `VM mismatch — ref ${JSON.stringify(ref.output).slice(0, 50)} vs vm ${JSON.stringify(vm.output).slice(0, 50)}${vm.error ? ` (vm trap: ${vm.error})` : ''}`;
    return { name, level, pass, detail, bytes: comp.bytes.length, ms: performance.now() - t0, vmPass };
  } catch (e) {
    return { name, level, pass: false, detail: `exception: ${(e as Error).message}`, bytes: 0, ms: performance.now() - t0, vmPass: false };
  }
}

export async function verifyAll(
  programs: { name: string; source: string }[],
  levels: OptLevel[],
  onResult?: (r: VerifyResult) => void,
): Promise<VerifyResult[]> {
  const results: VerifyResult[] = [];
  for (const p of programs) {
    for (const lvl of levels) {
      const r = await verifyOne(p.name, p.source, lvl);
      results.push(r);
      onResult?.(r);
    }
  }
  return results;
}
