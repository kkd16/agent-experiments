import type { Program } from './ast';
import type { Token } from './token';
import type { IRModule, IRFunc } from './ir/ir';
import type { PassStat, OptLevel } from './opt/optimize';
import { tokenize } from './lexer';
import { parse } from './parser';
import { typecheck } from './types';
import { buildPreIR } from './ir/builder';
import { toSSA } from './ir/ssa';
import { optimize } from './opt/optimize';
import { inlineModule } from './opt/inline';
import { tailCallOpt } from './opt/tco';
import { codegen } from './backend/codegen';
import { CompileError } from './diagnostics';
import type { DomInfo } from './ir/cfg';
import { computeDom, succOfTerm } from './ir/cfg';

// The end-to-end compiler driver used by the UI. A single call surfaces every
// intermediate artifact so each pipeline stage can be visualized.

export interface Metrics {
  sourceLines: number;
  tokens: number;
  ssaInsts: number; // instructions + phis, unoptimized
  optInsts: number; // instructions + phis, after optimization
  wasmBytes: number;
  wasmInsts: number;
  wasmLocals: number; // declared locals after stackification (lower = better)
  stackFolded: number; // values kept on the operand stack (no local)
  reductionPct: number;
  compileMs: number;
}

export interface Compilation {
  ok: boolean;
  level: OptLevel;
  source: string;
  tokens: Token[];
  error?: { message: string; line: number; col: number; phase: string };
  program?: Program;
  ssa?: IRModule; // unoptimized SSA
  optimized?: IRModule; // optimized at `level`
  optLog?: PassStat[]; // SSA-level passes (aligned with optSnapshots)
  preLog?: PassStat[]; // pre-SSA transforms (tail-call, inlining)
  optSnapshots?: string[]; // textual IR after each SSA pass (UI only)
  wat?: string;
  bytes?: Uint8Array;
  metrics?: Metrics;
}

function countIR(mod: IRModule): number {
  let n = 0;
  for (const fn of mod.funcs) for (const b of fn.blocks) n += b.insts.length + b.phis.length;
  return n;
}

export function compile(source: string, level: OptLevel, collectSnapshots = false): Compilation {
  const t0 = (globalThis.performance?.now?.() ?? Date.now());
  let tokens: Token[] = [];
  try {
    tokens = tokenize(source);
    const program = parse(source);
    typecheck(program);
    const pre = buildPreIR(program);
    // Pre-SSA transforms (at -O2+): turn self-tail-recursion into loops, then
    // inline small non-recursive callees. SSA construction reconciles the merged
    // control flow with phi nodes automatically.
    const tco = level >= 2 ? tailCallOpt(pre) : 0;
    const inlined = level >= 2 ? inlineModule(pre) : 0;
    const ssa = toSSA(pre);
    const { mod: optimized, log, snapshots } = optimize(ssa, level, collectSnapshots);
    const preLog: PassStat[] = [];
    if (tco > 0) preLog.push({ name: 'tail-call → loop', changed: tco });
    if (inlined > 0) preLog.push({ name: 'inline (pre-SSA)', changed: inlined });
    const cg = codegen(optimized);
    const ssaInsts = countIR(ssa);
    const optInsts = countIR(optimized);
    const compileMs = (globalThis.performance?.now?.() ?? Date.now()) - t0;
    return {
      ok: true,
      level,
      source,
      tokens,
      program,
      ssa,
      optimized,
      optLog: log,
      preLog,
      optSnapshots: snapshots,
      wat: cg.wat,
      bytes: cg.bytes,
      metrics: {
        sourceLines: source.split('\n').length,
        tokens: tokens.length - 1,
        ssaInsts,
        optInsts,
        wasmBytes: cg.bytes.length,
        wasmInsts: cg.funcInstrCount,
        wasmLocals: cg.localCount,
        stackFolded: cg.stackFolded,
        reductionPct: ssaInsts ? Math.round((1 - optInsts / ssaInsts) * 100) : 0,
        compileMs,
      },
    };
  } catch (e) {
    if (e instanceof CompileError) {
      return {
        ok: false,
        level,
        source,
        tokens,
        error: { message: e.message, line: e.span.line, col: e.span.col, phase: e.phase },
      };
    }
    return { ok: false, level, source, tokens, error: { message: String((e as Error).message ?? e), line: 1, col: 1, phase: 'ir' } };
  }
}

// --- CFG model for the graph view ---

export type EdgeKind = 'normal' | 'back' | 'true' | 'false';
export interface CFGEdge {
  from: number;
  to: number;
  kind: EdgeKind;
}
export interface CFGModel {
  blocks: number[];
  edges: CFGEdge[];
  idom: Map<number, number>;
  loopHeaders: Set<number>;
  layers: Map<number, number>; // block id -> depth layer (for layout)
}

export function cfgModel(fn: IRFunc): CFGModel {
  const dom = computeDom(fn);
  const edges: CFGEdge[] = [];
  const loopHeaders = new Set<number>();
  for (const b of fn.blocks) {
    const t = b.term;
    if (t.op === 'condbr' && t.t !== t.f) {
      edges.push({ from: b.id, to: t.t, kind: classify(b.id, t.t, dom, 'true') });
      edges.push({ from: b.id, to: t.f, kind: classify(b.id, t.f, dom, 'false') });
    } else {
      for (const s of succOfTerm(t)) edges.push({ from: b.id, to: s, kind: classify(b.id, s, dom, 'normal') });
    }
  }
  for (const e of edges) if (e.kind === 'back') loopHeaders.add(e.to);

  // simple layered layout via BFS depth on the dominator tree / rpo
  const layers = new Map<number, number>();
  dom.rpo.forEach((id, i) => layers.set(id, i));
  return { blocks: dom.rpo, edges, idom: dom.idom, loopHeaders, layers };
}

function classify(from: number, to: number, dom: DomInfo, base: EdgeKind): EdgeKind {
  const a = dom.rpoIndex.get(from) ?? 0;
  const b = dom.rpoIndex.get(to) ?? 0;
  if (b <= a) return 'back';
  return base;
}
