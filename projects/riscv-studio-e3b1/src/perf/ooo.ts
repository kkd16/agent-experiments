// An out-of-order superscalar timing model (Tomasulo dynamic scheduling + a reorder buffer).
//
// This is the high-performance sibling of the in-order `pipeline.ts`. Like that model it is a
// *timing* model only: it never executes anything, it consumes the retired-instruction trace the
// functional interpreter emits and computes how many cycles a real out-of-order machine would
// take to run that exact dynamic instruction stream. The functional results are therefore
// impossible to regress — only the timing numbers are new.
//
// What it models (the textbook dynamically-scheduled core):
//   • superscalar **fetch / dispatch / commit** (a configurable width) over an instruction cache
//     and a front-end that squashes past a *mispredicted* branch until the branch *resolves*;
//   • **register renaming** — a producer map records, per architectural register, the in-flight
//     instruction that will write it, so WAR/WAW (false) dependences simply do not exist; only
//     true RAW data flow constrains issue;
//   • a **reorder buffer** (the instruction window) and a unified pool of **reservation stations**
//     (the issue queue), both of bounded size, that throttle how far ahead the machine runs;
//   • **out-of-order wakeup / select**: each cycle the oldest *ready* instructions (operands
//     available, a functional unit free) issue, regardless of program order — so independent work
//     flows under the shadow of a cache miss or a 20-cycle divide;
//   • a configurable pool of **typed functional units**, pipelined (1 op/cycle) or iterative
//     (busy for their whole latency, e.g. divide), with results broadcast on a bandwidth-limited
//     **common data bus**;
//   • a **load/store queue**: stores latch address+data on execute and drain to the D-cache at
//     **commit**; loads do real **address disambiguation** and **store-to-load forwarding** out of
//     the store buffer (an in-order-memory mode is offered for contrast);
//   • **in-order commit** from the ROB head, giving precise architectural state.
//
// The whole thing is a pure function of (trace, config), so it is exhaustively unit-testable
// against hand-derived cycle counts and structural invariants (see `ooo-tests.ts`).

import type { RetireEvent } from '../vm/cpu';
import { classify } from './isa-classes';
import type { InstrClass, RegFile, UnitKind } from './isa-classes';
import { Cache } from './cache';
import type { CacheConfig } from './cache';
import { BranchPredictor } from './predictor';
import type { PredictorKind } from './predictor';

/** Which pool of functional units an instruction contends for. */
export type FuClass = 'alu' | 'mul' | 'div' | 'fpadd' | 'fpmul' | 'fpdiv' | 'mem';

export interface OooConfig {
  /** Superscalar width: instructions fetched, dispatched and committed per cycle. */
  width: number;
  /** Max instructions that may *begin execution* in one cycle (also bounded by free units). */
  issueWidth: number;
  /** Reorder-buffer entries — the in-flight instruction window. */
  robSize: number;
  /** Unified reservation-station (issue-queue) entries. */
  iqSize: number;
  /** Load/store-queue entries (in-flight memory operations). */
  lsqSize: number;

  // Functional-unit counts (how many of each can execute concurrently).
  aluUnits: number;
  mulUnits: number;
  divUnits: number;
  fpAddUnits: number;
  fpMulUnits: number;
  fpDivUnits: number;
  /** Address-generation + cache ports shared by loads and stores. */
  memUnits: number;

  // Execution latencies (cycles; a result issued at cycle t is on the CDB at t + latency).
  mulCycles: number;
  divCycles: number;
  fpAddCycles: number;
  fpMulCycles: number;
  fpDivCycles: number;
  /** Load-hit latency (address-gen + cache); a miss adds `missPenalty`. */
  loadCycles: number;

  /** Pipelined mul / fp-add / fp-mul (1 op/cycle/unit) vs occupying the unit for their latency. */
  pipelinedMul: boolean;

  /** `disambiguate`: loads bypass non-aliasing stores and forward from aliasing ones;
   *  `inorder`: memory operations execute in strict program order (no disambiguation). */
  memModel: 'disambiguate' | 'inorder';

  predictor: PredictorKind;
  predictorEntries: number;
  ghistBits: number;
  btbSets: number;
  /** Front-end refill cycles charged *after* a mispredicted branch resolves. */
  mispredictPenalty: number;

  icache: CacheConfig | null;
  dcache: CacheConfig | null;
  /** Cycles a cache miss adds (shared by I$ and D$). */
  missPenalty: number;
}

/** Diagnostic counters: where dispatch lost cycles (not a strict partition of total cycles). */
export interface BottleneckBreakdown {
  /** Cycles dispatch was blocked because the reorder buffer was full. */
  robFull: number;
  /** Cycles dispatch was blocked because the reservation stations were full. */
  iqFull: number;
  /** Cycles dispatch was blocked because the load/store queue was full. */
  lsqFull: number;
  /** Cycles dispatch was starved because the front-end delivered no instruction
   *  (an I-cache miss or a branch-misprediction refill). */
  frontEnd: number;
  /** Cycles where work was waiting but no instruction could *issue* (operands / units busy). */
  noIssue: number;
}

export interface FuUtil {
  cls: FuClass;
  units: number;
  /** Unit-cycles busy executing. */
  busy: number;
  /** Instructions that used this unit. */
  ops: number;
  /** busy / (units × cycles). */
  utilization: number;
}

export interface OooCacheReport {
  reads: number;
  writes: number;
  readMisses: number;
  writeMisses: number;
  writebacks: number;
  accesses: number;
  misses: number;
  missRate: number;
}

/** One row of the instruction-lifetime (Gantt) diagram. */
export interface OooDiagramRow {
  index: number;
  pc: number;
  mnemonic: string;
  fuClass: FuClass;
  fetch: number;
  dispatch: number;
  issue: number;
  complete: number;
  commit: number;
  mispredicted: boolean;
  forwarded: boolean;
  iMiss: boolean;
  dMiss: boolean;
}

export interface OooResult {
  instructions: number;
  cycles: number;
  cpi: number;
  ipc: number;
  /** Average reservation-station→execute latency (a proxy for scheduling pressure). */
  avgIssueDelay: number;
  /** Peak reorder-buffer occupancy reached. */
  maxRobOccupancy: number;
  /** Average instructions in flight (ROB occupancy) across the run. */
  avgRobOccupancy: number;
  loads: number;
  stores: number;
  branches: number;
  jumps: number;
  /** Loads that got their value from the store buffer instead of the cache. */
  storeForwards: number;
  /** Cycles loads waited on the memory order (disambiguation / in-order memory). */
  memOrderStalls: number;
  bottleneck: BottleneckBreakdown;
  fuUtil: FuUtil[];
  predictor: {
    kind: PredictorKind;
    hits: number;
    misses: number;
    directionMisses: number;
    targetMisses: number;
    accuracy: number;
    total: number;
  };
  icacheStats: OooCacheReport | null;
  dcacheStats: OooCacheReport | null;
  diagram: OooDiagramRow[];
  diagramTruncated: boolean;
  /** True if the safety cycle-cap tripped (should never happen for real programs). */
  bailed: boolean;
}

const DIAGRAM_MAX = 48;

export function defaultOooConfig(icache: CacheConfig | null, dcache: CacheConfig | null): OooConfig {
  return {
    width: 4,
    issueWidth: 4,
    robSize: 64,
    iqSize: 32,
    lsqSize: 16,
    aluUnits: 3,
    mulUnits: 1,
    divUnits: 1,
    fpAddUnits: 2,
    fpMulUnits: 1,
    fpDivUnits: 1,
    memUnits: 2,
    mulCycles: 3,
    divCycles: 20,
    fpAddCycles: 4,
    fpMulCycles: 5,
    fpDivCycles: 20,
    loadCycles: 2,
    pipelinedMul: true,
    memModel: 'disambiguate',
    predictor: 'two-bit',
    predictorEntries: 1024,
    ghistBits: 8,
    btbSets: 256,
    mispredictPenalty: 4,
    icache,
    dcache,
    missPenalty: 10,
  };
}

/** Map an instruction's micro-op kind to the functional-unit pool it contends for. */
function fuClassOf(unit: UnitKind): FuClass {
  switch (unit) {
    case 'mul':
      return 'mul';
    case 'div':
      return 'div';
    case 'fpadd':
      return 'fpadd';
    case 'fpmul':
      return 'fpmul';
    case 'fpdiv':
      return 'fpdiv';
    case 'load':
    case 'store':
      return 'mem';
    default:
      // alu / branch / jump / system all use a simple single-cycle integer unit.
      return 'alu';
  }
}

function latencyOf(fc: FuClass, isLoad: boolean, c: OooConfig): number {
  switch (fc) {
    case 'mul':
      return Math.max(1, c.mulCycles);
    case 'div':
      return Math.max(1, c.divCycles);
    case 'fpadd':
      return Math.max(1, c.fpAddCycles);
    case 'fpmul':
      return Math.max(1, c.fpMulCycles);
    case 'fpdiv':
      return Math.max(1, c.fpDivCycles);
    case 'mem':
      return isLoad ? Math.max(1, c.loadCycles) : 1; // a store just latches addr+data
    default:
      return 1;
  }
}

/** Whether a functional-unit class is fully pipelined (accepts a new op every cycle per unit). */
function pipelined(fc: FuClass, c: OooConfig): boolean {
  if (fc === 'div' || fc === 'fpdiv') return false; // iterative dividers are not pipelined
  if (fc === 'mul' || fc === 'fpadd' || fc === 'fpmul') return c.pipelinedMul;
  return true; // alu, mem
}

function unitsOf(fc: FuClass, c: OooConfig): number {
  switch (fc) {
    case 'alu':
      return Math.max(1, c.aluUnits);
    case 'mul':
      return Math.max(1, c.mulUnits);
    case 'div':
      return Math.max(1, c.divUnits);
    case 'fpadd':
      return Math.max(1, c.fpAddUnits);
    case 'fpmul':
      return Math.max(1, c.fpMulUnits);
    case 'fpdiv':
      return Math.max(1, c.fpDivUnits);
    case 'mem':
      return Math.max(1, c.memUnits);
  }
}

const FU_CLASSES: FuClass[] = ['alu', 'mul', 'div', 'fpadd', 'fpmul', 'fpdiv', 'mem'];

/** A reorder-buffer / reservation-station entry: everything we track per in-flight instruction. */
interface Entry {
  idx: number;
  cls: InstrClass;
  fuClass: FuClass;
  latency: number;
  isLoad: boolean;
  isStore: boolean;
  isControl: boolean;
  /** Effective address for memory ops (base + imm). */
  addr: number;

  fetch: number;
  dispatch: number;
  issue: number; // -1 until issued
  complete: number; // -1 until known (= issue + latency, after CDB arbitration)
  commit: number; // -1 until committed

  /** Producers not yet known-complete at dispatch (RAW wakeup count). */
  pending: number;
  /** Cycle the last operand becomes available (folded as producers complete). */
  operandReady: number;
  /** Consumers waiting on this entry's result. */
  waiters: number[];

  mispredicted: boolean;
  forwarded: boolean;
  iMiss: boolean;
  dMiss: boolean;
}

/** Run the out-of-order timing model over a retired-instruction trace. */
export function simulateOoo(trace: readonly RetireEvent[], config: OooConfig): OooResult {
  const n = trace.length;
  const icache = config.icache ? new Cache(config.icache) : null;
  const dcache = config.dcache ? new Cache(config.dcache) : null;
  const bp = new BranchPredictor(config.predictor, config.predictorEntries, config.ghistBits, config.btbSets);

  const width = Math.max(1, config.width);
  const issueWidth = Math.max(1, config.issueWidth);
  const cdbWidth = width; // result-bus bandwidth tracks commit/dispatch width
  const robSize = Math.max(1, config.robSize);
  const iqSize = Math.max(1, config.iqSize);
  const lsqSize = Math.max(1, config.lsqSize);

  // Renaming: the in-flight producer of each architectural register, per file (x / f).
  const prodX: (Entry | null)[] = new Array(32).fill(null);
  const prodF: (Entry | null)[] = new Array(32).fill(null);
  const producerOf = (file: RegFile): (Entry | null)[] => (file === 'x' ? prodX : prodF);

  const entries: (Entry | undefined)[] = new Array(n);

  // Per-instruction front-end metadata, written by fetch and read by dispatch.
  const fetchInfo = new Map<number, number>(); // index → fetch cycle
  const predictedMiss = new Map<number, boolean>(); // index → was this control op mispredicted
  const iMissAt = new Set<number>(); // indices whose fetch missed in the I-cache

  // Front-end + queues.
  let fetchIdx = 0; // next instruction to fetch
  const frontEnd: number[] = []; // fetched, not yet dispatched (FIFO of indices)
  const fetchBufferSize = Math.max(width, robSize); // how far fetch may run ahead
  let fetchStallUntil = 0; // I-cache-miss / branch-refill stall barrier
  let mispredictBlock = false; // a fetched mispredicted branch is blocking the front-end
  let mispredictBlockIdx = -1;

  const rob: number[] = []; // in-flight indices, program order (head = rob[0])
  let iqInflight = 0; // dispatched-but-not-issued count (reservation-station occupancy)
  const lsq: number[] = []; // in-flight memory-op indices, program order
  const inflightStores: number[] = []; // in-flight store indices, program order

  // Functional-unit state.
  const pipe: Record<FuClass, boolean> = {} as Record<FuClass, boolean>;
  const unitCount: Record<FuClass, number> = {} as Record<FuClass, number>;
  const busyUntil: Record<FuClass, number[]> = {} as Record<FuClass, number[]>; // iterative units
  const fuBusyCycles: Record<FuClass, number> = {} as Record<FuClass, number>;
  const fuOps: Record<FuClass, number> = {} as Record<FuClass, number>;
  for (const fc of FU_CLASSES) {
    pipe[fc] = pipelined(fc, config);
    unitCount[fc] = unitsOf(fc, config);
    busyUntil[fc] = new Array(unitCount[fc]).fill(-1);
    fuBusyCycles[fc] = 0;
    fuOps[fc] = 0;
  }

  // Completion + CDB bookkeeping, keyed by cycle.
  const completionsAt = new Map<number, number[]>();
  const cdbUsed = new Map<number, number>();
  const schedule = (cycle: number, idx: number) => {
    const a = completionsAt.get(cycle);
    if (a) a.push(idx);
    else completionsAt.set(cycle, [idx]);
  };

  const bottleneck: BottleneckBreakdown = { robFull: 0, iqFull: 0, lsqFull: 0, frontEnd: 0, noIssue: 0 };
  let loads = 0;
  let stores = 0;
  let branches = 0;
  let jumps = 0;
  let storeForwards = 0;
  let memOrderStalls = 0;
  let committedCount = 0;
  let issueDelaySum = 0;
  let robOccupancySum = 0;
  let maxRobOccupancy = 0;

  const wordAddr = (a: number): number => (a & ~3) >>> 0;

  let C = 0;
  const cycleCap = n * 256 + config.missPenalty * (n + 16) + 100_000;
  let bailed = false;

  while (committedCount < n) {
    if (C > cycleCap) {
      bailed = true;
      break;
    }

    // ---- (1) completions land on the CDB this cycle: mark done, wake dependents ----
    const done = completionsAt.get(C);
    if (done) {
      for (const di of done) {
        const e = entries[di]!;
        for (const wi of e.waiters) {
          const w = entries[wi];
          if (!w) continue;
          if (e.complete > w.operandReady) w.operandReady = e.complete;
          w.pending--;
        }
        e.waiters.length = 0;
        // A resolved mispredicted branch refills the front-end after the penalty.
        if (e.mispredicted && e.idx === mispredictBlockIdx) {
          fetchStallUntil = Math.max(fetchStallUntil, e.complete + config.mispredictPenalty);
          mispredictBlock = false;
          mispredictBlockIdx = -1;
        }
      }
      completionsAt.delete(C);
    }

    // ---- (2) commit in order from the ROB head (up to `width`) ----
    let committedThisCycle = 0;
    while (rob.length > 0 && committedThisCycle < width) {
      const e = entries[rob[0]]!;
      if (e.complete < 0 || e.complete > C) break; // head not yet finished
      e.commit = C;
      if (e.isStore && dcache) dcache.access(e.addr, true); // drain the store to the D-cache
      rob.shift();
      if (e.isLoad || e.isStore) {
        if (lsq.length && lsq[0] === e.idx) lsq.shift();
        else {
          const li = lsq.indexOf(e.idx);
          if (li >= 0) lsq.splice(li, 1);
        }
      }
      if (e.isStore) {
        if (inflightStores.length && inflightStores[0] === e.idx) inflightStores.shift();
        else {
          const si = inflightStores.indexOf(e.idx);
          if (si >= 0) inflightStores.splice(si, 1);
        }
      }
      committedCount++;
      committedThisCycle++;
    }

    // ---- (3) issue: oldest ready instruction(s) begin execution out of order ----
    let issuedThisCycle = 0;
    const perCycleIssued: Record<FuClass, number> = {} as Record<FuClass, number>;
    for (const fc of FU_CLASSES) perCycleIssued[fc] = 0;
    let sawWaitingButNoneIssued = false;
    // rob is in program order, so scanning it oldest-first gives the right priority.
    for (const idx of rob) {
      if (issuedThisCycle >= issueWidth) break;
      const e = entries[idx]!;
      if (e.issue >= 0) continue; // already executing / done
      if (e.dispatch >= C) continue; // can issue no earlier than the cycle after dispatch
      if (e.pending > 0 || e.operandReady > C) {
        sawWaitingButNoneIssued = true;
        continue; // operands not ready
      }

      // Memory-ordering gate for loads/stores.
      let forwardLatency = -1;
      let forwardedFrom = -1;
      if (e.isLoad || e.isStore) {
        const gate = memGate(e, config, entries, inflightStores, lsq, C, wordAddr);
        if (!gate.ready) {
          sawWaitingButNoneIssued = true;
          continue;
        }
        forwardLatency = gate.forwardLatency;
        forwardedFrom = gate.forwardFrom;
      }

      // Functional-unit availability.
      const fc = e.fuClass;
      let unitIndex = -1;
      if (pipe[fc]) {
        if (perCycleIssued[fc] >= unitCount[fc]) {
          sawWaitingButNoneIssued = true;
          continue;
        }
        unitIndex = perCycleIssued[fc];
      } else {
        for (let u = 0; u < unitCount[fc]; u++) {
          if (busyUntil[fc][u] <= C) {
            unitIndex = u;
            break;
          }
        }
        if (unitIndex < 0) {
          sawWaitingButNoneIssued = true;
          continue;
        }
      }

      // --- issue it ---
      e.issue = C;
      iqInflight--; // leaves the reservation station
      perCycleIssued[fc]++;
      issuedThisCycle++;
      fuOps[fc]++;
      issueDelaySum += C - e.dispatch;

      let lat = e.latency;
      if (e.isLoad) {
        loads++;
        if (forwardedFrom >= 0) {
          e.forwarded = true;
          storeForwards++;
          lat = forwardLatency; // value comes from the store buffer, no cache access
        } else if (dcache) {
          const hit = dcache.access(e.addr, false);
          if (!hit) {
            e.dMiss = true;
            lat += config.missPenalty;
          }
        }
      } else if (e.isStore) {
        stores++;
      }

      if (!pipe[fc]) busyUntil[fc][unitIndex] = C + lat;
      fuBusyCycles[fc] += lat;

      // Schedule completion. Only register-producing results contend for the CDB.
      const producesReg = e.cls.dst !== null && !(e.cls.dst.file === 'x' && e.cls.dst.index === 0);
      let comp = C + lat;
      if (producesReg) {
        while ((cdbUsed.get(comp) ?? 0) >= cdbWidth) comp++;
        cdbUsed.set(comp, (cdbUsed.get(comp) ?? 0) + 1);
      }
      e.complete = comp;
      schedule(comp, e.idx);
    }
    if (sawWaitingButNoneIssued && issuedThisCycle === 0 && rob.length > 0) bottleneck.noIssue++;

    // ---- (4) dispatch (in order) into the ROB + reservation stations (up to `width`) ----
    let dispatchedThisCycle = 0;
    let blockedReason: keyof BottleneckBreakdown | null = null;
    while (dispatchedThisCycle < width && frontEnd.length > 0) {
      const idx = frontEnd[0];
      const ev = trace[idx];
      const cls = classify(ev.mnemonic, ev.format, ev.rd, ev.rs1, ev.rs2, ev.rs3);
      const isMem = cls.isLoad || cls.isStore;
      if (rob.length >= robSize) {
        blockedReason = 'robFull';
        break;
      }
      if (iqInflight >= iqSize) {
        blockedReason = 'iqFull';
        break;
      }
      if (isMem && lsq.length >= lsqSize) {
        blockedReason = 'lsqFull';
        break;
      }

      const fc = fuClassOf(cls.unit);
      const e: Entry = {
        idx,
        cls,
        fuClass: fc,
        latency: latencyOf(fc, cls.isLoad, config),
        isLoad: cls.isLoad,
        isStore: cls.isStore,
        isControl: cls.isControl,
        addr: isMem ? (ev.base + ev.imm) >>> 0 : 0,
        fetch: fetchInfo.get(idx) ?? C,
        dispatch: C,
        issue: -1,
        complete: -1,
        commit: -1,
        pending: 0,
        operandReady: 0,
        waiters: [],
        mispredicted: predictedMiss.get(idx) ?? false,
        forwarded: false,
        iMiss: iMissAt.has(idx),
        dMiss: false,
      };

      // Rename + RAW wakeup: link to each source's in-flight producer.
      for (const s of cls.srcs) {
        if (s.file === 'x' && s.index === 0) continue;
        const p = producerOf(s.file)[s.index];
        if (!p || p.commit >= 0) continue; // value already in the register file
        if (p.complete >= 0) {
          // Producer has issued: its broadcast cycle is known — fold it in directly.
          if (p.complete > e.operandReady) e.operandReady = p.complete;
        } else {
          // Producer still waiting: become a waiter so we learn its completion cycle.
          p.waiters.push(idx);
          e.pending++;
        }
      }
      // Publish this instruction as the new in-flight producer of its destination.
      if (cls.dst && !(cls.dst.file === 'x' && cls.dst.index === 0)) {
        producerOf(cls.dst.file)[cls.dst.index] = e;
      }

      entries[idx] = e;
      rob.push(idx);
      iqInflight++;
      if (isMem) lsq.push(idx);
      if (cls.isStore) inflightStores.push(idx);
      if (cls.isControl) {
        if (cls.isBranch) branches++;
        else jumps++;
      }

      frontEnd.shift();
      dispatchedThisCycle++;
    }
    if (blockedReason && dispatchedThisCycle === 0) bottleneck[blockedReason]++;

    // ---- (5) fetch (in order) into the front-end buffer (up to `width`) ----
    let fetchedThisCycle = 0;
    const frontStarved = frontEnd.length === 0 && dispatchedThisCycle === 0 && fetchIdx < n;
    while (
      fetchedThisCycle < width &&
      fetchIdx < n &&
      frontEnd.length < fetchBufferSize &&
      C >= fetchStallUntil &&
      !mispredictBlock
    ) {
      const idx = fetchIdx;
      const ev = trace[idx];
      fetchInfo.set(idx, C);

      if (icache) {
        const hit = icache.access(ev.pc, false);
        if (!hit) {
          iMissAt.add(idx);
          fetchStallUntil = Math.max(fetchStallUntil, C + config.missPenalty);
        }
      }

      // Predict this control instruction's outcome; a miss blocks the front-end until it resolves.
      const cls = classify(ev.mnemonic, ev.format, ev.rd, ev.rs1, ev.rs2, ev.rs3);
      const fallThrough = (ev.pc + ev.size) >>> 0;
      const dynTaken = ev.nextPc !== fallThrough;
      let miss = false;
      if (cls.isControl) {
        const r = bp.step({ pc: ev.pc, isJump: cls.isJump, taken: dynTaken, target: ev.nextPc >>> 0 });
        miss = !r.correct;
      } else if (dynTaken) {
        miss = true; // an unpredicted redirect (trap / mret / fence.i): a front-end surprise
      }
      predictedMiss.set(idx, miss);

      frontEnd.push(idx);
      fetchIdx++;
      fetchedThisCycle++;

      if (miss) {
        mispredictBlock = true;
        mispredictBlockIdx = idx;
        break; // stop fetching past the mispredicted branch until it resolves
      }
      if (iMissAt.has(idx)) break; // the I-miss stall takes effect next cycle
    }
    if (frontStarved && fetchedThisCycle === 0 && rob.length < robSize) bottleneck.frontEnd++;

    // running ROB-occupancy statistics
    robOccupancySum += rob.length;
    if (rob.length > maxRobOccupancy) maxRobOccupancy = rob.length;

    C++;
  }

  const totalCycles = committedCount === n ? lastCommit(entries, n) + 1 : C;

  // ---- build the diagram + memory-order stalls + utilization ----
  const diagram: OooDiagramRow[] = [];
  for (let i = 0; i < n && diagram.length < DIAGRAM_MAX; i++) {
    const e = entries[i];
    if (!e) continue;
    diagram.push({
      index: e.idx,
      pc: trace[i].pc,
      mnemonic: trace[i].mnemonic,
      fuClass: e.fuClass,
      fetch: e.fetch,
      dispatch: e.dispatch,
      issue: e.issue,
      complete: e.complete,
      commit: e.commit,
      mispredicted: e.mispredicted,
      forwarded: e.forwarded,
      iMiss: e.iMiss,
      dMiss: e.dMiss,
    });
  }

  // memory-order stalls: for each memory op, cycles it waited past its operands for the
  // memory order (the gap between operand-ready and actual issue attributable to the LSQ).
  for (let i = 0; i < n; i++) {
    const e = entries[i];
    if (!e || (!e.isLoad && !e.isStore) || e.issue < 0) continue;
    const earliest = Math.max(e.operandReady, e.dispatch + 1);
    if (e.issue > earliest) memOrderStalls += e.issue - earliest;
  }

  const fuUtil: FuUtil[] = FU_CLASSES.map((fc) => ({
    cls: fc,
    units: unitCount[fc],
    busy: fuBusyCycles[fc],
    ops: fuOps[fc],
    utilization: totalCycles > 0 ? fuBusyCycles[fc] / (unitCount[fc] * totalCycles) : 0,
  })).filter((u) => u.ops > 0);

  const report = (c: Cache | null): OooCacheReport | null =>
    c
      ? {
          reads: c.reads,
          writes: c.writes,
          readMisses: c.readMisses,
          writeMisses: c.writeMisses,
          writebacks: c.writebacks,
          accesses: c.accesses,
          misses: c.misses,
          missRate: c.missRate,
        }
      : null;

  return {
    instructions: n,
    cycles: n === 0 ? 0 : totalCycles,
    cpi: n === 0 ? 0 : totalCycles / n,
    ipc: totalCycles === 0 ? 0 : n / totalCycles,
    avgIssueDelay: n === 0 ? 0 : issueDelaySum / n,
    maxRobOccupancy,
    avgRobOccupancy: totalCycles === 0 ? 0 : robOccupancySum / totalCycles,
    loads,
    stores,
    branches,
    jumps,
    storeForwards,
    memOrderStalls,
    bottleneck,
    fuUtil,
    predictor: {
      kind: config.predictor,
      hits: bp.hits,
      misses: bp.misses,
      directionMisses: bp.directionMisses,
      targetMisses: bp.targetMisses,
      accuracy: bp.accuracy,
      total: bp.total,
    },
    icacheStats: report(icache),
    dcacheStats: report(dcache),
    diagram,
    diagramTruncated: n > DIAGRAM_MAX,
    bailed,
  };
}

/** The cycle the last-committed instruction retired. */
function lastCommit(entries: (Entry | undefined)[], n: number): number {
  let last = 0;
  for (let i = 0; i < n; i++) {
    const e = entries[i];
    if (e && e.commit > last) last = e.commit;
  }
  return last;
}

interface MemGate {
  ready: boolean;
  forwardFrom: number;
  forwardLatency: number;
}

/**
 * Decide whether a memory op may execute at cycle C, and (for a load) whether it forwards from an
 * older in-flight store. `disambiguate` mode: a load needs every older in-flight store's address
 * (its issue cycle) known, then forwards from the youngest aliasing store (waiting for that
 * store's data) or hits the cache. `inorder` mode: every memory op follows the previous one.
 */
function memGate(
  e: Entry,
  config: OooConfig,
  entries: (Entry | undefined)[],
  inflightStores: number[],
  lsq: number[],
  C: number,
  wordAddr: (a: number) => number,
): MemGate {
  if (config.memModel === 'inorder') {
    // Wait for every older in-flight memory op to have completed.
    for (const mi of lsq) {
      if (mi >= e.idx) break;
      const m = entries[mi]!;
      if (m.complete < 0 || m.complete > C) return { ready: false, forwardFrom: -1, forwardLatency: -1 };
    }
    return { ready: true, forwardFrom: -1, forwardLatency: config.loadCycles };
  }

  // disambiguate: stores need only their own operands (handled by RAW); they may execute freely.
  if (e.isStore) return { ready: true, forwardFrom: -1, forwardLatency: -1 };

  // A load: every older in-flight store must have a known address (have issued) to disambiguate.
  let forwardFrom = -1;
  let forwardComplete = -1;
  const want = wordAddr(e.addr);
  for (const si of inflightStores) {
    if (si >= e.idx) break; // only older stores
    const s = entries[si]!;
    if (s.issue < 0) return { ready: false, forwardFrom: -1, forwardLatency: -1 }; // address unknown
    if (wordAddr(s.addr) === want) {
      // The youngest aliasing store wins (later iterations overwrite earlier matches).
      forwardFrom = si;
      forwardComplete = s.complete; // store data latched at its completion
    }
  }
  if (forwardFrom >= 0) {
    if (forwardComplete < 0 || forwardComplete > C) return { ready: false, forwardFrom: -1, forwardLatency: -1 };
    return { ready: true, forwardFrom, forwardLatency: Math.max(1, config.loadCycles) };
  }
  return { ready: true, forwardFrom: -1, forwardLatency: -1 };
}
