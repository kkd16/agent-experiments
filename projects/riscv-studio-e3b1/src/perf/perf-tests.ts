// Self-tests for the microarchitecture timing model.
//
// These are hand-computed cycle oracles: tiny programs whose exact pipeline cycle counts can be
// derived on paper, plus invariants (forwarding never slows a program down, a warm 2-bit
// predictor beats always-not-taken, a re-access hits in the cache, …). They are wired into the
// in-app Verify suite, and — crucially — one of them proves the retire-tracer leaves the
// interpreter's architectural results byte-for-byte unchanged.

import { assemble } from '../vm/assembler';
import { Cpu } from '../vm/cpu';
import type { TestResult } from '../vm/selftest';
import { simulate } from './pipeline';
import type { PipelineConfig } from './pipeline';
import { defaultConfig, captureTrace, comparePredictors } from './analyze';
import type { CacheConfig } from './cache';

class AssertionError extends Error {}
function assert(cond: boolean, message: string): void {
  if (!cond) throw new AssertionError(message);
}

/** A unit-latency, cache-free config so pipeline arithmetic is clean to reason about. */
function unitConfig(over: Partial<PipelineConfig> = {}): PipelineConfig {
  return {
    ...defaultConfig(),
    mulCycles: 1,
    divCycles: 1,
    fpAddCycles: 1,
    fpMulCycles: 1,
    fpDivCycles: 1,
    icache: null,
    dcache: null,
    predictor: 'not-taken',
    ...over,
  };
}

/** Assemble a program and capture its retired-instruction trace. */
function trace(src: string) {
  const program = assemble(src, { compress: false });
  assert(program.ok, `program failed to assemble: ${program.errors.map((e) => e.message).join('; ')}`);
  return captureTrace(program).trace;
}

interface PerfTest {
  name: string;
  fn: () => void;
}

const TESTS: PerfTest[] = [
  {
    name: 'pipeline · dependence-free stream costs n + 4 cycles (fill only)',
    fn: () => {
      // 4 independent addis + ebreak = 5 instructions; the ideal in-order pipeline = n + 4.
      const t = trace(`
        addi t0, zero, 1
        addi t1, zero, 2
        addi t2, zero, 3
        addi t3, zero, 4
        ebreak
      `);
      assert(t.length === 5, `expected 5 retired instructions, got ${t.length}`);
      const r = simulate(t, unitConfig());
      assert(r.cycles === 9, `expected 9 cycles, got ${r.cycles}`);
      assert(r.stalls.dataHazard === 0 && r.stalls.loadUse === 0, 'no data stalls expected');
      assert(Math.abs(r.cpi - 9 / 5) < 1e-9, `CPI should be 1.8, got ${r.cpi}`);
    },
  },
  {
    name: 'pipeline · forwarding makes back-to-back dependent ALU ops stall zero cycles',
    fn: () => {
      const t = trace(`
        addi t0, zero, 5
        addi t1, t0, 1
        addi t2, t1, 1
        ebreak
      `);
      assert(t.length === 4, `expected 4 instructions, got ${t.length}`);
      const r = simulate(t, unitConfig({ forwarding: true }));
      assert(r.cycles === 8, `forwarding should give 8 cycles, got ${r.cycles}`);
      assert(r.stalls.dataHazard === 0, `no ALU stalls with forwarding, got ${r.stalls.dataHazard}`);
    },
  },
  {
    name: 'pipeline · disabling forwarding inserts the expected RAW stalls',
    fn: () => {
      const t = trace(`
        addi t0, zero, 5
        addi t1, t0, 1
        addi t2, t1, 1
        ebreak
      `);
      const fwd = simulate(t, unitConfig({ forwarding: true })).cycles;
      const noFwd = simulate(t, unitConfig({ forwarding: false }));
      assert(noFwd.cycles > fwd, `no-forwarding (${noFwd.cycles}) should exceed forwarding (${fwd})`);
      assert(noFwd.stalls.dataHazard > 0, 'no-forwarding should report data-hazard stalls');
    },
  },
  {
    name: 'pipeline · a load-use pair stalls exactly one cycle with forwarding',
    fn: () => {
      const t = trace(`
        lw t0, 0(gp)
        addi t1, t0, 1
        ebreak
      `);
      assert(t.length === 3, `expected 3 instructions, got ${t.length}`);
      const r = simulate(t, unitConfig({ forwarding: true }));
      // Ideal n+4 = 7; the unavoidable load-use bubble makes it 8.
      assert(r.cycles === 8, `load-use should give 8 cycles, got ${r.cycles}`);
      assert(r.stalls.loadUse === 1, `expected exactly one load-use stall cycle, got ${r.stalls.loadUse}`);
    },
  },
  {
    name: 'pipeline · multi-cycle EX latency lengthens the schedule monotonically',
    fn: () => {
      const t = trace(`
        li t0, 7
        li t1, 6
        mul t2, t0, t1
        mul t3, t2, t0
        ebreak
      `);
      const fast = simulate(t, unitConfig({ mulCycles: 1 }));
      const slow = simulate(t, unitConfig({ mulCycles: 5 }));
      assert(slow.cycles > fast.cycles, `slower multiply should cost more (${slow.cycles} vs ${fast.cycles})`);
      assert(slow.stalls.fuLatency === 2 * 4, `two 5-cycle muls add 8 FU-latency cycles, got ${slow.stalls.fuLatency}`);
    },
  },
  {
    name: 'branch prediction · 2-bit predictor crushes a loop that always-not-taken mispredicts',
    fn: () => {
      const t = trace(`
        li t0, 10
        loop:
        addi t0, t0, -1
        bne t0, zero, loop
        ebreak
      `);
      const cmp = comparePredictors(t, 1024, 8, 256);
      const nt = cmp.find((c) => c.kind === 'not-taken')!;
      const tb = cmp.find((c) => c.kind === 'two-bit')!;
      // 10 branches: 9 taken, 1 fall-through.
      assert(nt.hits + nt.misses === 10, `expected 10 branch events, got ${nt.hits + nt.misses}`);
      assert(nt.misses === 9, `always-not-taken should miss all 9 taken branches, got ${nt.misses}`);
      assert(tb.misses === 2, `a 2-bit predictor should miss only the cold + final branch, got ${tb.misses}`);
      assert(tb.accuracy > nt.accuracy, 'the 2-bit predictor must beat always-not-taken');
    },
  },
  {
    name: 'branch prediction · a taken branch under always-not-taken costs the mispredict penalty',
    fn: () => {
      const t = trace(`
        li t0, 3
        loop:
        addi t0, t0, -1
        bne t0, zero, loop
        ebreak
      `);
      const exResolve = simulate(t, unitConfig({ predictor: 'not-taken', branchResolve: 'EX' }));
      const idResolve = simulate(t, unitConfig({ predictor: 'not-taken', branchResolve: 'ID' }));
      assert(exResolve.stalls.control > 0, 'mispredictions should cost control-stall cycles');
      // Resolving in ID flushes fewer stages than resolving in EX, so it is cheaper.
      assert(idResolve.cycles < exResolve.cycles, `ID-resolve (${idResolve.cycles}) should beat EX-resolve (${exResolve.cycles})`);
    },
  },
  {
    name: 'cache · a re-access to the same line hits; a cold access misses',
    fn: () => {
      const t = trace(`
        lw t0, 0(gp)
        lw t1, 0(gp)
        ebreak
      `);
      const dcache: CacheConfig = { sizeBytes: 1024, blockBytes: 32, ways: 2, replace: 'lru', writeBack: true };
      const r = simulate(t, unitConfig({ dcache, missPenalty: 10 }));
      assert(r.dcacheStats !== null, 'expected D-cache stats');
      assert(r.dcacheStats!.accesses === 2, `expected 2 data accesses, got ${r.dcacheStats!.accesses}`);
      assert(r.dcacheStats!.readMisses === 1, `expected exactly one cold miss, got ${r.dcacheStats!.readMisses}`);
    },
  },
  {
    name: 'cache · the I-cache sees exactly one fetch per retired instruction, and a bigger penalty costs more',
    fn: () => {
      const t = trace(`
        addi t0, zero, 1
        addi t1, zero, 2
        addi t2, zero, 3
        ebreak
      `);
      const icache: CacheConfig = { sizeBytes: 256, blockBytes: 16, ways: 1, replace: 'lru', writeBack: true };
      const cheap = simulate(t, unitConfig({ icache, missPenalty: 5 }));
      const dear = simulate(t, unitConfig({ icache, missPenalty: 40 }));
      assert(cheap.icacheStats!.accesses === t.length, `I-fetches (${cheap.icacheStats!.accesses}) should equal instructions (${t.length})`);
      assert(cheap.icacheStats!.misses > 0, 'cold I-cache should miss at least once');
      assert(dear.cycles > cheap.cycles, `a larger miss penalty must cost more cycles (${dear.cycles} vs ${cheap.cycles})`);
    },
  },
  {
    name: 'correctness · the retire-tracer leaves architectural results byte-for-byte unchanged',
    fn: () => {
      const src = `
        li a0, 0
        li a1, 1
        li t0, 12
        floop:
        add a2, a0, a1
        mv a0, a1
        mv a1, a2
        addi t0, t0, -1
        bne t0, zero, floop
        ebreak
      `;
      const program = assemble(src, { compress: false });
      assert(program.ok, 'fib program should assemble');

      const traced = new Cpu();
      traced.recordHistory = false;
      traced.load(program);
      let touched = 0;
      traced.tracer = () => {
        touched++;
      };
      while (!traced.isStopped()) if (!traced.step()) break;

      const plain = new Cpu();
      plain.load(program);
      while (!plain.isStopped()) if (!plain.step()) break;

      assert(touched > 0, 'the tracer should have observed instructions');
      assert(traced.output === plain.output, 'tracing must not change console output');
      for (let i = 0; i < 32; i++) {
        assert(traced.regs[i] === plain.regs[i], `register x${i} diverged under tracing`);
      }
      assert(traced.pc === plain.pc, 'final pc diverged under tracing');
    },
  },
  {
    name: 'invariants · CPI ≥ 1, IPC ≤ 1, accuracy ∈ [0,1] on a realistic program',
    fn: () => {
      const t = trace(`
        li a0, 0
        li t0, 20
        sloop:
        add a0, a0, t0
        addi t0, t0, -1
        bne t0, zero, sloop
        ebreak
      `);
      const r = simulate(t, defaultConfig());
      assert(r.cycles >= r.instructions, 'cycles cannot be fewer than instructions');
      assert(r.cpi >= 1 - 1e-9, `CPI must be ≥ 1, got ${r.cpi}`);
      assert(r.ipc <= 1 + 1e-9, `IPC must be ≤ 1, got ${r.ipc}`);
      assert(r.predictor.accuracy >= 0 && r.predictor.accuracy <= 1, 'accuracy out of range');
    },
  },
];

export function runPerfTests(): TestResult[] {
  return TESTS.map(({ name, fn }) => {
    try {
      fn();
      return { name, passed: true, detail: 'ok' };
    } catch (e) {
      return { name, passed: false, detail: (e as Error).message };
    }
  });
}
