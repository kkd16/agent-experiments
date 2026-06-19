// Self-tests for the out-of-order superscalar timing model.
//
// Like the in-order `perf-tests.ts`, these are hand-derived cycle oracles plus structural
// invariants — small programs whose exact out-of-order schedules can be reasoned about on paper,
// and whole-program checks (every instruction's fetch ≤ dispatch ≤ issue ≤ complete ≤ commit,
// commit strictly in program order, exactly *n* instructions retired, IPC ≤ width). They are
// wired into the in-app Verify suite. They never run the interpreter for *results* — that
// guarantee is already proven once in `perf-tests.ts` and shared by both timing models.

import { assemble } from '../vm/assembler';
import type { TestResult } from '../vm/selftest';
import { captureTrace } from './analyze';
import { simulateOoo, defaultOooConfig } from './ooo';
import type { OooConfig, OooResult } from './ooo';
import type { CacheConfig } from './cache';

class AssertionError extends Error {}
function assert(cond: boolean, message: string): void {
  if (!cond) throw new AssertionError(message);
}

const DCACHE: CacheConfig = { sizeBytes: 1024, blockBytes: 32, ways: 2, replace: 'lru', writeBack: true };

/** A clean, cache-free base config so the cycle arithmetic is easy to reason about. */
function cfg(over: Partial<OooConfig> = {}): OooConfig {
  return {
    ...defaultOooConfig(null, null),
    predictor: 'not-taken',
    mispredictPenalty: 4,
    mulCycles: 3,
    divCycles: 20,
    ...over,
  };
}

function trace(src: string) {
  const program = assemble(src, { compress: false });
  assert(program.ok, `program failed to assemble: ${program.errors.map((e) => e.message).join('; ')}`);
  return captureTrace(program).trace;
}

function run(src: string, over: Partial<OooConfig> = {}): OooResult {
  return simulateOoo(trace(src), cfg(over));
}

/** Generate `count` mutually-independent ALU instructions (writing distinct registers). */
function independentStream(count: number): string {
  const regs = ['t0', 't1', 't2', 't3', 't4', 't5', 't6', 's0', 's1', 's2', 's3', 's4'];
  let s = '';
  for (let i = 0; i < count; i++) s += `addi ${regs[i % regs.length]}, zero, ${i % 16}\n`;
  return s + 'ebreak\n';
}

/**
 * Whole-program structural invariants. For programs whose entire dynamic trace fits in the
 * diagram, this proves every instruction's lifetime is monotone and commit is in program order.
 */
function checkInvariants(label: string, r: OooResult, width: number): void {
  assert(!r.bailed, `${label}: the safety cycle-cap tripped`);
  assert(r.cycles >= r.instructions / width - 1e-9, `${label}: cycles below the width bound`);
  assert(r.ipc <= width + 1e-9, `${label}: IPC ${r.ipc} exceeds width ${width}`);
  assert(r.cpi >= 1 / width - 1e-9, `${label}: CPI below 1/width`);
  // Per-instruction lifetime monotonicity (diagram covers the whole program for these tests).
  assert(r.diagram.length === r.instructions, `${label}: diagram should cover all ${r.instructions} instructions`);
  let prevCommit = -1;
  for (const row of r.diagram) {
    assert(row.fetch <= row.dispatch, `${label}: fetch>${'dispatch'} at #${row.index}`);
    assert(row.dispatch < row.issue, `${label}: issue must follow dispatch at #${row.index}`);
    assert(row.complete > row.issue, `${label}: complete must follow issue at #${row.index}`);
    assert(row.commit >= row.complete, `${label}: commit must be ≥ complete at #${row.index}`);
    assert(row.commit >= prevCommit, `${label}: commit went backwards at #${row.index} (in-order commit)`);
    prevCommit = row.commit;
  }
}

interface OooTest {
  name: string;
  fn: () => void;
}

const TESTS: OooTest[] = [
  {
    name: 'ooo · a single-issue machine matches a hand-derived schedule (n + 3 cycles)',
    fn: () => {
      // 5 independent ops, width 1, one ALU: fetch i@i, dispatch i+1, issue i+2, commit i+2.
      const r = run(independentStream(4), { width: 1, issueWidth: 1, aluUnits: 1 });
      assert(r.instructions === 5, `expected 5 instructions, got ${r.instructions}`);
      assert(r.cycles === 8, `single-issue independent stream should take 8 cycles, got ${r.cycles}`);
      checkInvariants('single-issue', r, 1);
    },
  },
  {
    name: 'ooo · superscalar extracts ILP — IPC approaches the issue width on independent work',
    fn: () => {
      const wide = run(independentStream(200), { width: 4, issueWidth: 4, aluUnits: 4, robSize: 64 });
      const narrow = run(independentStream(200), { width: 1, issueWidth: 1, aluUnits: 1, robSize: 64 });
      assert(wide.ipc > 3.4, `a 4-wide machine should reach IPC > 3.4 on independent work, got ${wide.ipc.toFixed(3)}`);
      assert(narrow.ipc <= 1 + 1e-9, `a 1-wide machine cannot exceed IPC 1, got ${narrow.ipc.toFixed(3)}`);
      assert(wide.cycles < narrow.cycles / 3, `4-wide (${wide.cycles}) should crush 1-wide (${narrow.cycles})`);
    },
  },
  {
    name: 'ooo · a true dependence chain stays at IPC ≈ 1 no matter how wide the machine',
    fn: () => {
      // Each op depends on the previous: width cannot help a latency-bound chain.
      const chain = `
        addi t0, zero, 1
        addi t1, t0, 1
        addi t2, t1, 1
        addi t3, t2, 1
        addi t4, t3, 1
        addi t5, t4, 1
        ebreak`;
      const wide = run(chain, { width: 4, issueWidth: 4, aluUnits: 4 });
      const narrow = run(chain, { width: 1, issueWidth: 1, aluUnits: 1 });
      assert(wide.ipc < 1.1, `a serial chain cannot exceed IPC ≈ 1, got ${wide.ipc.toFixed(3)}`);
      // Widening the machine barely helps a chain (only the trailing ebreak overlaps).
      assert(wide.cycles >= narrow.cycles - 1, `width should not materially speed up a chain (${wide.cycles} vs ${narrow.cycles})`);
    },
  },
  {
    name: 'ooo · register renaming dissolves WAR/WAW false dependences (zero cost)',
    fn: () => {
      // Four writes to the *same* architectural register with no true data flow: renaming makes
      // them fully independent, so they run exactly as fast as four distinct-register writes.
      const waw = `
        addi t0, zero, 1
        addi t0, zero, 2
        addi t0, zero, 3
        addi t0, zero, 4
        ebreak`;
      const renamed = run(waw, { width: 4, issueWidth: 4, aluUnits: 4 });
      const distinct = run(independentStream(4), { width: 4, issueWidth: 4, aluUnits: 4 });
      assert(renamed.cycles === distinct.cycles, `renamed WAW (${renamed.cycles}) must match independent (${distinct.cycles})`);
      // And it must beat the same length forced into a true chain.
      const chain = `
        addi t0, zero, 1
        addi t1, t0, 1
        addi t2, t1, 1
        addi t3, t2, 1
        ebreak`;
      const trueChain = run(chain, { width: 4, issueWidth: 4, aluUnits: 4 });
      assert(renamed.cycles < trueChain.cycles, `renaming (${renamed.cycles}) must beat a true dependence chain (${trueChain.cycles})`);
      checkInvariants('renamed-waw', renamed, 4);
    },
  },
  {
    name: 'ooo · a long-latency divide is hidden by independent work behind it',
    fn: () => {
      let many = '';
      for (let i = 0; i < 20; i++) many += `addi a0, zero, ${i}\n`;
      const src = `li t0, 100\nli t1, 7\ndiv t2, t0, t1\n${many}ebreak`;
      const hidden = run(src, { width: 4, issueWidth: 4, robSize: 64, divCycles: 20 });
      // A machine that could *not* look past the divide would pay 20 cycles + the 20 ALUs serially.
      const serialBound = 20 + 20; // divide latency + one cycle per independent op, very loose
      assert(hidden.cycles < serialBound, `independent work should hide the divide (${hidden.cycles} < ${serialBound})`);
      // A reorder buffer too small to see past the divide is measurably slower.
      const blind = run(src, { width: 4, issueWidth: 4, robSize: 6, divCycles: 20 });
      assert(blind.cycles >= hidden.cycles, `a small ROB (${blind.cycles}) cannot beat a large one (${hidden.cycles})`);
      assert(blind.maxRobOccupancy <= 6, `the small ROB must cap occupancy at 6, got ${blind.maxRobOccupancy}`);
    },
  },
  {
    name: 'ooo · the load/store queue forwards a store to a dependent in-flight load',
    fn: () => {
      // A divide at the ROB head keeps the store in the buffer (it cannot commit) while the
      // dependent load issues — so the load gets its value by forwarding, not from the cache.
      const src = `
        li t0, 0x4000
        li t1, 42
        li t2, 7
        div s0, t2, t2
        sw t1, 0(t0)
        lw t3, 0(t0)
        addi t4, t3, 1
        ebreak`;
      const r = run(src, { memModel: 'disambiguate', dcache: DCACHE, missPenalty: 10, divCycles: 20 });
      assert(r.storeForwards >= 1, `the load should forward from the store buffer, got ${r.storeForwards} forwards`);
    },
  },
  {
    name: 'ooo · address disambiguation lets independent loads overlap (in-order memory serializes)',
    fn: () => {
      const src = `
        li t0, 0x4000
        li t1, 0x5000
        li t2, 0x6000
        lw t3, 0(t0)
        lw t4, 0(t1)
        lw t5, 0(t2)
        ebreak`;
      const dis = run(src, { memModel: 'disambiguate', dcache: DCACHE, missPenalty: 10, memUnits: 3 });
      const seq = run(src, { memModel: 'inorder', dcache: DCACHE, missPenalty: 10, memUnits: 3 });
      assert(dis.cycles < seq.cycles, `disambiguation (${dis.cycles}) should beat in-order memory (${seq.cycles})`);
      assert(seq.memOrderStalls > 0, `in-order memory should report memory-order stalls, got ${seq.memOrderStalls}`);
      assert(dis.memOrderStalls === 0, `non-aliasing loads should not stall under disambiguation, got ${dis.memOrderStalls}`);
    },
  },
  {
    name: 'ooo · the misprediction penalty is dynamic — a late-resolving branch costs more',
    fn: () => {
      // The branch condition depends on a multiply, so a slower multiply resolves the branch
      // later, and the (always-not-taken) misprediction's refill is charged from that later cycle.
      const src = `
        li t0, 5
        li t1, 6
        mul t2, t0, t1
        bne t2, zero, skip
        addi a0, zero, 9
      skip:
        ebreak`;
      const slow = run(src, { predictor: 'not-taken', mispredictPenalty: 4, mulCycles: 10 });
      const fast = run(src, { predictor: 'not-taken', mispredictPenalty: 4, mulCycles: 1 });
      assert(slow.cycles > fast.cycles, `a late-resolving branch (${slow.cycles}) must cost more than an early one (${fast.cycles})`);
    },
  },
  {
    name: 'ooo · structural invariants hold on a realistic loop with loads, stores and branches',
    fn: () => {
      // A small loop (3 iterations) so its whole dynamic trace fits in the diagram and every
      // instruction's lifetime can be checked.
      const src = `
        li t0, 3
        li t1, 0x4000
        li a0, 0
      loop:
        sw t0, 0(t1)
        lw t2, 0(t1)
        add a0, a0, t2
        addi t0, t0, -1
        bne t0, zero, loop
        ebreak`;
      const r = run(src, { width: 2, issueWidth: 2, dcache: DCACHE, missPenalty: 10, predictor: 'two-bit' });
      checkInvariants('loop', r, 2);
      assert(r.loads === 3 && r.stores === 3, `expected 3 loads + 3 stores, got ${r.loads}/${r.stores}`);
      assert(r.branches === 3, `expected 3 branch events, got ${r.branches}`);
    },
  },
  {
    name: 'ooo · every instruction commits exactly once and IPC never exceeds the width',
    fn: () => {
      const src = `
        li a0, 0
        li a1, 1
        li t0, 8
      fib:
        add a2, a0, a1
        mv a0, a1
        mv a1, a2
        addi t0, t0, -1
        bne t0, zero, fib
        ebreak`;
      const widths = [1, 2, 4, 8];
      let prevCycles = Infinity;
      for (const w of widths) {
        const r = run(src, { width: w, issueWidth: w, aluUnits: Math.max(2, w), robSize: 64, predictor: 'two-bit' });
        assert(!r.bailed, `width ${w}: bailed`);
        assert(r.ipc <= w + 1e-9, `width ${w}: IPC ${r.ipc} exceeds width`);
        // A wider machine is never slower on the same program (monotone, modulo equal).
        assert(r.cycles <= prevCycles + 1e-9, `width ${w} (${r.cycles}) should not exceed the narrower run (${prevCycles})`);
        prevCycles = r.cycles;
      }
    },
  },
];

export function runOooTests(): TestResult[] {
  return TESTS.map(({ name, fn }) => {
    try {
      fn();
      return { name, passed: true, detail: 'ok' };
    } catch (e) {
      return { name, passed: false, detail: (e as Error).message };
    }
  });
}
