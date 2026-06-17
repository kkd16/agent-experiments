// The classic 5-stage in-order pipeline timing model.
//
// This is a *timing* model only: it never executes anything. It consumes the retired-instruction
// trace produced by the functional interpreter and computes how many cycles a textbook
// IF/ID/EX/MEM/WB pipeline would take to run that exact dynamic instruction stream, accounting
// for data hazards (with optional forwarding), control hazards (via a branch predictor + BTB),
// multi-cycle functional units, and instruction/data cache misses.
//
// The schedule is the standard in-order stage-entry recurrence: each instruction enters a stage
// no earlier than (a) it finished its previous stage, (b) the prior instruction vacated that
// stage, and (c) — at EX — its source operands are available, and — at IF — any mispredicted
// branch ahead has resolved. With unit latencies and no hazards this yields the ideal
// `cycles = instructions + 4` (the 4-cycle pipeline fill), i.e. CPI → 1.

import type { RetireEvent } from '../vm/cpu';
import { classify } from './isa-classes';
import type { RegFile, UnitKind } from './isa-classes';
import { Cache } from './cache';
import type { CacheConfig } from './cache';
import { BranchPredictor } from './predictor';
import type { PredictorKind } from './predictor';

export interface PipelineConfig {
  /** EX→EX and MEM→EX forwarding paths. With forwarding off, a dependent op waits for WB. */
  forwarding: boolean;
  /** Pipeline stage at which a branch's direction/target is resolved (sets the mispredict penalty). */
  branchResolve: 'ID' | 'EX';
  predictor: PredictorKind;
  predictorEntries: number;
  ghistBits: number;
  btbSets: number;
  /** Multi-cycle EX latencies (cycles spent in EX). */
  mulCycles: number;
  divCycles: number;
  fpAddCycles: number;
  fpMulCycles: number;
  fpDivCycles: number;
  /** Caches; null ⇒ a perfect (always-hit) cache with no miss penalty. */
  icache: CacheConfig | null;
  dcache: CacheConfig | null;
  /** Cycles added to a stage on a cache miss (shared by I$ and D$). */
  missPenalty: number;
}

export interface StallBreakdown {
  dataHazard: number;
  loadUse: number;
  control: number;
  icache: number;
  dcache: number;
  fuLatency: number;
  structural: number;
}

export interface CacheReport {
  reads: number;
  writes: number;
  readMisses: number;
  writeMisses: number;
  writebacks: number;
  accesses: number;
  misses: number;
  missRate: number;
}

export interface DiagramRow {
  index: number;
  pc: number;
  mnemonic: string;
  enter: { if: number; id: number; ex: number; mem: number; wb: number };
  len: { if: number; ex: number; mem: number };
  mispredicted: boolean;
  loadUseStall: boolean;
  dataStall: boolean;
  iMiss: boolean;
  dMiss: boolean;
}

export interface PipelineResult {
  instructions: number;
  cycles: number;
  cpi: number;
  ipc: number;
  stalls: StallBreakdown;
  loads: number;
  stores: number;
  branches: number;
  jumps: number;
  predictor: {
    kind: PredictorKind;
    hits: number;
    misses: number;
    directionMisses: number;
    targetMisses: number;
    accuracy: number;
    total: number;
  };
  icacheStats: CacheReport | null;
  dcacheStats: CacheReport | null;
  diagram: DiagramRow[];
  diagramTruncated: boolean;
}

const DIAGRAM_MAX = 56;
const NEG = Number.NEGATIVE_INFINITY;

function exCyclesFor(unit: UnitKind, c: PipelineConfig): number {
  switch (unit) {
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
    default:
      return 1;
  }
}

function report(c: Cache | null): CacheReport | null {
  if (!c) return null;
  return {
    reads: c.reads,
    writes: c.writes,
    readMisses: c.readMisses,
    writeMisses: c.writeMisses,
    writebacks: c.writebacks,
    accesses: c.accesses,
    misses: c.misses,
    missRate: c.missRate,
  };
}

/** The producer record kept per register: when its value can reach a consumer's EX. */
interface Producer {
  availEX: number;
  isLoad: boolean;
}

/** Run the timing model over a retired-instruction trace. */
export function simulate(trace: readonly RetireEvent[], config: PipelineConfig): PipelineResult {
  const icache = config.icache ? new Cache(config.icache) : null;
  const dcache = config.dcache ? new Cache(config.dcache) : null;
  const bp = new BranchPredictor(config.predictor, config.predictorEntries, config.ghistBits, config.btbSets);

  // Last writer of each register, per file. Index 0 of the x-file is the hard-wired zero.
  const prodX: (Producer | null)[] = new Array(32).fill(null);
  const prodF: (Producer | null)[] = new Array(32).fill(null);
  const producerOf = (file: RegFile): (Producer | null)[] => (file === 'x' ? prodX : prodF);

  // Previous instruction's stage-entry cycles (sentinels so the first instruction is unconstrained).
  let prevIF = NEG;
  let prevID = NEG;
  let prevEX = NEG;
  let prevMEM = NEG;
  let prevWB = NEG;
  let prevMispredict = false;
  let prevResolve = NEG;

  const stalls: StallBreakdown = {
    dataHazard: 0,
    loadUse: 0,
    control: 0,
    icache: 0,
    dcache: 0,
    fuLatency: 0,
    structural: 0,
  };
  let loads = 0;
  let stores = 0;
  let branches = 0;
  let jumps = 0;
  let lastWB = 0;

  const diagram: DiagramRow[] = [];

  for (let i = 0; i < trace.length; i++) {
    const e = trace[i];
    const cls = classify(e.mnemonic, e.format, e.rd, e.rs1, e.rs2, e.rs3);

    // ---- instruction-cache access (fetch) ----
    let ifLen = 1;
    let iMiss = false;
    if (icache) {
      const hit = icache.access(e.pc, false);
      if (!hit) {
        iMiss = true;
        ifLen += config.missPenalty;
      }
    }

    // ---- functional-unit (EX) latency ----
    const exLen = exCyclesFor(cls.unit, config);

    // ---- data-cache access (MEM) ----
    let memLen = 1;
    let dMiss = false;
    if (cls.isMem) {
      if (cls.isLoad) loads++;
      else stores++;
      const addr = (e.base + e.imm) >>> 0;
      if (dcache) {
        const hit = dcache.access(addr, cls.isStore);
        if (!hit) {
          dMiss = true;
          memLen += config.missPenalty;
        }
      }
    }

    // ---- RAW data hazard: the earliest cycle EX may begin given operand availability ----
    let hazardEX = NEG;
    let bindingLoad = false;
    for (const s of cls.srcs) {
      if (s.file === 'x' && s.index === 0) continue; // x0 is always available
      const p = producerOf(s.file)[s.index];
      if (p && p.availEX > hazardEX) {
        hazardEX = p.availEX;
        bindingLoad = p.isLoad;
      }
    }

    // ---- control hazard: a mispredicted branch ahead delays this fetch until it resolves ----
    const controlStall = prevMispredict ? prevResolve : NEG;

    // ---- the in-order stage-entry recurrence ----
    const enterIF = Math.max(prevID, controlStall, 0);
    const enterID = Math.max(enterIF + ifLen, prevEX);
    const baseEX = Math.max(enterID + 1, prevMEM);
    const enterEX = Math.max(baseEX, hazardEX);
    const enterMEM = Math.max(enterEX + exLen, prevWB);
    const enterWB = Math.max(enterMEM + memLen, prevWB + 1);

    // ---- stall attribution (categories can overlap when hazards stack; see Docs) ----
    if (hazardEX > baseEX) {
      const extra = hazardEX - baseEX;
      if (bindingLoad) stalls.loadUse += extra;
      else stalls.dataHazard += extra;
    }
    if (iMiss) stalls.icache += ifLen - 1;
    if (dMiss) stalls.dcache += memLen - 1;
    if (exLen > 1) stalls.fuLatency += exLen - 1;

    // ---- branch prediction + control resolution ----
    let mispredict = false;
    const dynTaken = e.nextPc !== ((e.pc + e.size) >>> 0);
    if (cls.isControl) {
      if (cls.isBranch) branches++;
      else jumps++;
      const r = bp.step({ pc: e.pc, isJump: cls.isJump, taken: dynTaken, target: e.nextPc >>> 0 });
      mispredict = !r.correct;
    } else if (dynTaken) {
      // A non-predicted redirect (mret/sret/ecall trap, fence.i, …): always a front-end surprise.
      mispredict = true;
    }
    const resolveCycle = config.branchResolve === 'EX' ? enterMEM : enterID + 1;
    if (mispredict) {
      // The bubbles this misprediction will insert before the next instruction's IF.
      const baseNextIF = Math.max(prevID, 0); // ignores the control term
      stalls.control += Math.max(0, resolveCycle - Math.max(enterID, baseNextIF));
    }

    // ---- record this instruction as the producer of its destination ----
    if (cls.dst && !(cls.dst.file === 'x' && cls.dst.index === 0)) {
      let availEX: number;
      if (config.forwarding) {
        // Forwarded result: a load's data is ready end of MEM (enterWB); an ALU/FU result end of EX.
        availEX = cls.isLoad ? enterWB : enterMEM;
      } else {
        // No forwarding: the consumer must read the written-back value from the register file.
        availEX = enterWB + 1;
      }
      producerOf(cls.dst.file)[cls.dst.index] = { availEX, isLoad: cls.isLoad };
    }

    if (i < DIAGRAM_MAX) {
      diagram.push({
        index: i,
        pc: e.pc,
        mnemonic: e.mnemonic,
        enter: { if: enterIF, id: enterID, ex: enterEX, mem: enterMEM, wb: enterWB },
        len: { if: ifLen, ex: exLen, mem: memLen },
        mispredicted: mispredict,
        loadUseStall: hazardEX > baseEX && bindingLoad,
        dataStall: hazardEX > baseEX && !bindingLoad,
        iMiss,
        dMiss,
      });
    }

    // ---- shift the window forward ----
    prevIF = enterIF;
    prevID = enterID;
    prevEX = enterEX;
    prevMEM = enterMEM;
    prevWB = enterWB;
    prevMispredict = mispredict;
    prevResolve = resolveCycle;
    lastWB = enterWB;
  }

  const instructions = trace.length;
  const cycles = instructions === 0 ? 0 : lastWB + 1;
  const ideal = instructions + 4;
  const known =
    stalls.dataHazard + stalls.loadUse + stalls.control + stalls.icache + stalls.dcache + stalls.fuLatency;
  stalls.structural = Math.max(0, cycles - ideal - known);

  // touch prevIF so the unused-binding lints stay quiet while keeping the symmetric assignment.
  void prevIF;

  return {
    instructions,
    cycles,
    cpi: instructions === 0 ? 0 : cycles / instructions,
    ipc: cycles === 0 ? 0 : instructions / cycles,
    stalls,
    loads,
    stores,
    branches,
    jumps,
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
    diagramTruncated: trace.length > DIAGRAM_MAX,
  };
}
