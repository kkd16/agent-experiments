// The profiler engine: a pure, trace-driven dynamic profile of a program.
//
// Like the performance lab, this never executes anything itself and never touches the live
// debugging CPU. It runs the assembled program on a *fresh, throwaway* CPU with the retire-tracer
// attached (history disabled), captures the bounded dynamic instruction stream, and then derives:
//
//   • a per-instruction (per-PC) hit + cost profile and coverage of the static program,
//   • a reconstructed call stack — from the calling-convention link/return instructions — that
//     yields per-function self/inclusive cost, a call graph, and a foldable flamegraph tree,
//   • a data-memory working-set profile (per-address read/write counts + a block heatmap).
//
// The functional results are provably unchanged (the tracer is the same opt-in seam the timing
// models use). "Cost" is a documented *modelled issue-cost* — one cycle per instruction plus the
// functional-unit latency of the multi-cycle ops (mul/div, fp add/mul/div) — the same latencies
// the in-order pipeline model uses. It is an intrinsic per-instruction weight (pairwise pipeline
// stalls and cache misses are *not* attributed to a single site), so it is exactly reproducible
// and hand-checkable, which is what a profiler's ranking needs. Retired-instruction *hits* are the
// exact primary metric; cost is the secondary weight.

import { Cpu } from '../vm/cpu';
import type { RetireEvent } from '../vm/cpu';
import type { AssembleResult } from '../vm/assembler';
import { classify } from '../perf/isa-classes';
import type { InstrClass } from '../perf/isa-classes';
import type { DecodedFormat } from '../vm/decode';

/** Default trace budget — matches the perf lab's cap so a runaway loop can't exhaust memory. */
export const PROFILE_CAP = 300_000;

/** How deep the reconstructed call stack may grow before deeper frames are folded into the
 *  current one (a backstop against pathological/pointer-chasing recursion blowing up the tree). */
export const MAX_STACK_DEPTH = 1024;

/** Multi-cycle functional-unit latencies used for the modelled issue-cost (mirrors the pipeline). */
export interface CostModel {
  mul: number;
  div: number;
  fpadd: number;
  fpmul: number;
  fpdiv: number;
}

export const DEFAULT_COST: CostModel = { mul: 3, div: 20, fpadd: 4, fpmul: 5, fpdiv: 20 };

export interface ProfileOptions {
  cap?: number;
  cost?: CostModel;
}

/** One static instruction site (keyed by PC), with its dynamic totals. */
export interface Site {
  pc: number;
  hits: number;
  cost: number;
  /** Source line (1-based) if the PC maps back to the editor buffer, else 0. */
  line: number;
  /** The mnemonic first seen retiring here. */
  mnemonic: string;
  category: Category;
  /** Control-flow outcome tallies (for branch/jump sites). */
  isControl: boolean;
  taken: number;
  notTaken: number;
}

/** Per-function aggregate. `self` is exclusive (time at the top of stack); `total` is inclusive
 *  (this frame plus everything it called), counted once per outermost occurrence so recursion is
 *  never double-counted. */
export interface FuncStat {
  name: string;
  startPc: number;
  selfHits: number;
  selfCost: number;
  totalHits: number;
  totalCost: number;
  /** How many times control entered this function (call count). */
  calls: number;
}

export interface CallEdge {
  caller: string;
  callee: string;
  count: number;
}

/** A node in the call-path (flamegraph) tree. Inclusive totals are filled in a final pass. */
export interface FlameNode {
  func: string;
  selfHits: number;
  selfCost: number;
  totalHits: number;
  totalCost: number;
  /** How many times this exact call path was entered. */
  entries: number;
  depth: number;
  children: FlameNode[];
}

export interface MemBucket {
  addr: number;
  count: number;
  reads: number;
  writes: number;
}

export interface MemProfile {
  reads: number;
  writes: number;
  /** Distinct byte addresses touched. */
  distinct: number;
  lo: number;
  hi: number;
  bucketBytes: number;
  buckets: MemBucket[];
  /** Hottest individual addresses (word-aligned), most-accessed first. */
  hot: MemBucket[];
}

export interface CategoryStat {
  name: Category;
  hits: number;
  cost: number;
}

export type Category =
  | 'alu'
  | 'load'
  | 'store'
  | 'branch'
  | 'jump'
  | 'muldiv'
  | 'float'
  | 'vector'
  | 'system'
  | 'other';

export interface Profile {
  ok: boolean;
  message: string;
  traced: number;
  truncated: boolean;
  halted: boolean;
  totalHits: number;
  totalCost: number;
  /** Distinct static instructions that executed. */
  distinctPcs: number;
  /** Total static instructions in the program's text. */
  staticInstrs: number;
  coverage: number;
  /** Static instruction PCs that never executed (dead in this run), sorted ascending. */
  uncovered: number[];
  sites: Site[];
  siteMap: Map<number, Site>;
  functions: FuncStat[];
  edges: CallEdge[];
  flame: FlameNode;
  mem: MemProfile;
  maxDepth: number;
  categories: CategoryStat[];
}

const LINK_REGS = new Set([1, 5]); // ra (x1), t0 (x5) — the ABI link registers used for RAS hints

function normalize(m: string): string {
  return m.startsWith('c.') ? m.slice(2) : m;
}

function costOf(cls: InstrClass, cost: CostModel): number {
  switch (cls.unit) {
    case 'mul':
      return Math.max(1, cost.mul);
    case 'div':
      return Math.max(1, cost.div);
    case 'fpadd':
      return Math.max(1, cost.fpadd);
    case 'fpmul':
      return Math.max(1, cost.fpmul);
    case 'fpdiv':
      return Math.max(1, cost.fpdiv);
    default:
      return 1;
  }
}

function categoryOf(cls: InstrClass, format: DecodedFormat, mnemonic: string): Category {
  if (format === 'V') return 'vector';
  if (cls.isLoad) return 'load';
  if (cls.isStore) return 'store';
  if (cls.isBranch) return 'branch';
  if (cls.isJump) return 'jump';
  if (cls.unit === 'mul' || cls.unit === 'div') return 'muldiv';
  if (cls.unit === 'fpadd' || cls.unit === 'fpmul' || cls.unit === 'fpdiv') return 'float';
  const m = normalize(mnemonic);
  if (m.startsWith('f')) return 'float';
  if (m === 'ecall' || m === 'ebreak' || m === 'mret' || m === 'sret' || m === 'wfi' || m.startsWith('csr') || m.startsWith('sfence')) {
    return 'system';
  }
  if (cls.unit === 'alu') return 'alu';
  return 'other';
}

/** call / return / neither, from the calling-convention hint bits (rd/rs1 being a link register). */
function controlKind(mnemonic: string, rd: number, rs1: number): 'call' | 'return' | 'other' {
  const m = normalize(mnemonic);
  if (m === 'jal') return LINK_REGS.has(rd) ? 'call' : 'other';
  if (m === 'jalr') {
    if (LINK_REGS.has(rd)) return 'call';
    // A plain `jalr x0, ra/t0, 0` (i.e. `ret`) with no link write is a return.
    if (rd === 0 && LINK_REGS.has(rs1)) return 'return';
    return 'other';
  }
  return 'other';
}

/** Build a `pc → nearest preceding label` resolver over the program's text symbols. */
function makeFuncResolver(program: AssembleResult): (pc: number) => { name: string; start: number } {
  const [lo, hi] = program.textRange;
  const labels: { addr: number; name: string }[] = [];
  for (const [name, addr] of program.symbols) {
    if (addr >= lo && addr <= hi) labels.push({ addr, name });
  }
  labels.sort((a, b) => a.addr - b.addr || (a.name < b.name ? -1 : 1));
  return (pc: number) => {
    // greatest label whose addr <= pc
    let loI = 0;
    let hiI = labels.length - 1;
    let best = -1;
    while (loI <= hiI) {
      const mid = (loI + hiI) >> 1;
      if (labels[mid].addr <= pc) {
        best = mid;
        loI = mid + 1;
      } else {
        hiI = mid - 1;
      }
    }
    if (best < 0) return { name: `0x${(pc >>> 0).toString(16).padStart(8, '0')}`, start: pc >>> 0 };
    return { name: labels[best].name, start: labels[best].addr };
  };
}

/** Capture a bounded retired-instruction trace on a throwaway CPU (no time-travel journal). */
function capture(program: AssembleResult, cap: number): { trace: RetireEvent[]; halted: boolean; truncated: boolean } {
  const cpu = new Cpu();
  cpu.recordHistory = false;
  cpu.load(program);
  const trace: RetireEvent[] = [];
  let truncated = false;
  cpu.tracer = (ev) => {
    if (trace.length < cap) trace.push(ev);
    else truncated = true;
  };
  while (!cpu.isStopped() && trace.length < cap) {
    if (!cpu.step()) break;
  }
  return { trace, halted: cpu.status === 'halted', truncated };
}

function emptyProfile(message: string): Profile {
  return {
    ok: false,
    message,
    traced: 0,
    truncated: false,
    halted: false,
    totalHits: 0,
    totalCost: 0,
    distinctPcs: 0,
    staticInstrs: 0,
    coverage: 0,
    uncovered: [],
    sites: [],
    siteMap: new Map(),
    functions: [],
    edges: [],
    flame: { func: '(root)', selfHits: 0, selfCost: 0, totalHits: 0, totalCost: 0, entries: 1, depth: 0, children: [] },
    mem: { reads: 0, writes: 0, distinct: 0, lo: 0, hi: 0, bucketBytes: 0, buckets: [], hot: [] },
    maxDepth: 0,
    categories: [],
  };
}

/** The main entry point: profile an assembled program. */
export function profile(program: AssembleResult | null, options: ProfileOptions = {}): Profile {
  if (!program || !program.ok) {
    return emptyProfile(program ? 'Fix the assembler errors first.' : 'Assemble a program first.');
  }
  const cap = options.cap ?? PROFILE_CAP;
  const cost = options.cost ?? DEFAULT_COST;
  const { trace, halted, truncated } = capture(program, cap);
  if (trace.length === 0) {
    const p = emptyProfile('The program retired no instructions.');
    p.halted = halted;
    p.truncated = truncated;
    return p;
  }

  const funcAt = makeFuncResolver(program);
  const siteMap = new Map<number, Site>();
  const catTotals = new Map<Category, CategoryStat>();

  // --- call-path (flame) tree + reconstructed stack ---
  const rootInfo = funcAt(trace[0].pc);
  const root: FlameNode = {
    func: rootInfo.name,
    selfHits: 0,
    selfCost: 0,
    totalHits: 0,
    totalCost: 0,
    entries: 1,
    depth: 0,
    children: [],
  };
  const stack: { node: FlameNode; retAddr: number; startPc: number }[] = [
    { node: root, retAddr: -1, startPc: rootInfo.start },
  ];
  let maxDepth = 1;

  const edgeMap = new Map<string, CallEdge>();
  const funcStart = new Map<string, number>();
  funcStart.set(rootInfo.name, rootInfo.start);

  // --- memory working set ---
  const memCounts = new Map<number, MemBucket>();
  let memReads = 0;
  let memWrites = 0;
  let memLo = Infinity;
  let memHi = -Infinity;

  let totalHits = 0;
  let totalCost = 0;

  for (let i = 0; i < trace.length; i++) {
    const e = trace[i];
    const cls = classify(e.mnemonic, e.format, e.rd, e.rs1, e.rs2, e.rs3);
    const c = costOf(cls, cost);
    const cat = categoryOf(cls, e.format, e.mnemonic);
    totalHits++;
    totalCost += c;

    // per-site
    let site = siteMap.get(e.pc);
    if (!site) {
      site = {
        pc: e.pc,
        hits: 0,
        cost: 0,
        line: program.addrToLine.get(e.pc) ?? 0,
        mnemonic: e.mnemonic,
        category: cat,
        isControl: cls.isControl,
        taken: 0,
        notTaken: 0,
      };
      siteMap.set(e.pc, site);
    }
    site.hits++;
    site.cost += c;
    if (cls.isControl) {
      if (e.nextPc !== ((e.pc + e.size) >>> 0)) site.taken++;
      else site.notTaken++;
    }

    // per-category
    let cs = catTotals.get(cat);
    if (!cs) {
      cs = { name: cat, hits: 0, cost: 0 };
      catTotals.set(cat, cs);
    }
    cs.hits++;
    cs.cost += c;

    // attribute self time to the current top-of-stack frame
    const top = stack[stack.length - 1].node;
    top.selfHits++;
    top.selfCost += c;

    // memory working set
    if (cls.isMem) {
      const addr = (e.base + e.imm) >>> 0;
      let mb = memCounts.get(addr);
      if (!mb) {
        mb = { addr, count: 0, reads: 0, writes: 0 };
        memCounts.set(addr, mb);
      }
      mb.count++;
      if (cls.isStore) {
        mb.writes++;
        memWrites++;
      } else {
        mb.reads++;
        memReads++;
      }
      if (addr < memLo) memLo = addr;
      if (addr > memHi) memHi = addr;
    }

    // control flow: a call pushes a frame, a return pops one. The call/return instruction itself
    // belongs to the caller (already attributed above).
    const kind = controlKind(e.mnemonic, e.rd, e.rs1);
    if (kind === 'call') {
      const callee = funcAt(e.nextPc >>> 0);
      if (!funcStart.has(callee.name)) funcStart.set(callee.name, callee.start);
      const key = `${top.func} ${callee.name}`;
      const edge = edgeMap.get(key);
      if (edge) edge.count++;
      else edgeMap.set(key, { caller: top.func, callee: callee.name, count: 1 });

      if (stack.length < MAX_STACK_DEPTH) {
        let child = top.children.find((k) => k.func === callee.name);
        if (!child) {
          child = {
            func: callee.name,
            selfHits: 0,
            selfCost: 0,
            totalHits: 0,
            totalCost: 0,
            entries: 0,
            depth: top.depth + 1,
            children: [],
          };
          top.children.push(child);
        }
        child.entries++;
        stack.push({ node: child, retAddr: (e.pc + e.size) >>> 0, startPc: callee.start });
        if (stack.length > maxDepth) maxDepth = stack.length;
      }
      // At/over the depth cap we fold: keep attributing to `top` without growing the tree.
    } else if (kind === 'return') {
      if (stack.length > 1) {
        // Robust unwind: if the return target matches an ancestor's saved return address, unwind to
        // it (handles returns that skip frames); otherwise pop exactly one frame.
        const target = e.nextPc >>> 0;
        let idx = -1;
        for (let s = stack.length - 1; s >= 1; s--) {
          if (stack[s].retAddr === target) {
            idx = s;
            break;
          }
        }
        if (idx >= 1) stack.length = idx;
        else stack.pop();
      }
    }
  }

  // inclusive totals over the tree
  finalizeInclusive(root);

  // per-function aggregation: self from every node; inclusive counted once per outermost occurrence
  const funcMap = new Map<string, FuncStat>();
  const ensure = (name: string): FuncStat => {
    let f = funcMap.get(name);
    if (!f) {
      f = { name, startPc: funcStart.get(name) ?? 0, selfHits: 0, selfCost: 0, totalHits: 0, totalCost: 0, calls: 0 };
      funcMap.set(name, f);
    }
    return f;
  };
  const ancestors = new Set<string>();
  const walk = (node: FlameNode) => {
    const f = ensure(node.func);
    f.selfHits += node.selfHits;
    f.selfCost += node.selfCost;
    f.calls += node.entries;
    const outermost = !ancestors.has(node.func);
    if (outermost) {
      f.totalHits += node.totalHits;
      f.totalCost += node.totalCost;
      ancestors.add(node.func);
    }
    for (const child of node.children) walk(child);
    if (outermost) ancestors.delete(node.func);
  };
  walk(root);

  const functions = [...funcMap.values()].sort((a, b) => b.selfCost - a.selfCost || b.selfHits - a.selfHits);
  const edges = [...edgeMap.values()].sort((a, b) => b.count - a.count);

  // coverage
  const staticInstrs = program.instrs.length;
  const executed = new Set(siteMap.keys());
  const uncovered: number[] = [];
  for (const ins of program.instrs) if (!executed.has(ins.addr)) uncovered.push(ins.addr);
  uncovered.sort((a, b) => a - b);
  const distinctPcs = executed.size;
  const coverage = staticInstrs === 0 ? 0 : distinctPcs / staticInstrs;

  // memory buckets/heatmap
  const mem = buildMemProfile(memCounts, memReads, memWrites, memLo, memHi);

  const sites = [...siteMap.values()].sort((a, b) => a.pc - b.pc);
  const categories = [...catTotals.values()].sort((a, b) => b.cost - a.cost);

  return {
    ok: true,
    message: truncated
      ? `Traced the first ${trace.length.toLocaleString()} instructions (hit the ${cap.toLocaleString()} cap).`
      : `Traced ${trace.length.toLocaleString()} retired instructions${halted ? ' — program halted' : ''}.`,
    traced: trace.length,
    truncated,
    halted,
    totalHits,
    totalCost,
    distinctPcs,
    staticInstrs,
    coverage,
    uncovered,
    sites,
    siteMap,
    functions,
    edges,
    flame: root,
    mem,
    maxDepth,
    categories,
  };
}

function finalizeInclusive(node: FlameNode): { hits: number; cost: number } {
  let h = node.selfHits;
  let c = node.selfCost;
  for (const child of node.children) {
    const r = finalizeInclusive(child);
    h += r.hits;
    c += r.cost;
  }
  node.totalHits = h;
  node.totalCost = c;
  return { hits: h, cost: c };
}

function buildMemProfile(
  counts: Map<number, MemBucket>,
  reads: number,
  writes: number,
  lo: number,
  hi: number,
): MemProfile {
  if (counts.size === 0) {
    return { reads: 0, writes: 0, distinct: 0, lo: 0, hi: 0, bucketBytes: 0, buckets: [], hot: [] };
  }
  const distinct = counts.size;
  const addrs = [...counts.values()];
  const hot = [...addrs].sort((a, b) => b.count - a.count).slice(0, 24);

  // A heatmap over ~64 blocks spanning the touched range.
  const span = Math.max(1, hi - lo + 1);
  const TARGET_BUCKETS = 64;
  let bucketBytes = Math.max(1, Math.ceil(span / TARGET_BUCKETS));
  // round up to a power of two so bucket boundaries are readable
  bucketBytes = 1 << Math.ceil(Math.log2(bucketBytes));
  const bmap = new Map<number, MemBucket>();
  for (const a of addrs) {
    const base = lo + Math.floor((a.addr - lo) / bucketBytes) * bucketBytes;
    let b = bmap.get(base);
    if (!b) {
      b = { addr: base, count: 0, reads: 0, writes: 0 };
      bmap.set(base, b);
    }
    b.count += a.count;
    b.reads += a.reads;
    b.writes += a.writes;
  }
  const buckets = [...bmap.values()].sort((a, b) => a.addr - b.addr);
  return { reads, writes, distinct, lo, hi, bucketBytes, buckets, hot };
}
