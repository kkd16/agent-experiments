// Self-tests for the profiler engine.
//
// The profiler is a pure function of the retired trace, so its primary metric — retired-instruction
// *hits* per site/function — is exact and hand-checkable. These oracles pin that down on tiny
// programs whose dynamic behaviour is obvious on paper (a loop body runs exactly N times; a called
// function's inclusive time contains its callee's; coverage is the set of executed PCs; the modelled
// cost of a mul is its FU latency; a store touches exactly the address it computes). They are wired
// into the in-app Verify suite alongside the interpreter, timing-model and optimizer oracles.

import { assemble } from '../vm/assembler';
import type { TestResult } from '../vm/selftest';
import { EXAMPLES } from '../vm/examples';
import { profile, DEFAULT_COST } from './profile';
import type { Profile } from './profile';
import { layoutFlame, flameDepth } from './flamegraph';

class AssertionError extends Error {}
function assert(cond: boolean, message: string): void {
  if (!cond) throw new AssertionError(message);
}
function eq<T>(actual: T, expected: T, label: string): void {
  if (actual !== expected) throw new AssertionError(`${label}: expected ${String(expected)}, got ${String(actual)}`);
}

/** Assemble + profile a program; throws on assembler errors. */
function prof(src: string): Profile {
  const program = assemble(src, { compress: false });
  if (!program.ok) {
    throw new AssertionError(`assembler errors: ${program.errors.map((e) => `L${e.line} ${e.message}`).join('; ')}`);
  }
  const p = profile(program);
  if (!p.ok) throw new AssertionError(`profile failed: ${p.message}`);
  return p;
}

/** Sum of per-site hits equals the total retired instruction count. */
function siteHitsSum(p: Profile): number {
  let s = 0;
  for (const site of p.sites) s += site.hits;
  return s;
}

type Test = { name: string; fn: () => void };

const TESTS: Test[] = [
  {
    name: 'prof: straight-line program covers each instruction exactly once',
    fn: () => {
      // 4 instructions, no branches: exactly one hit each, retired = 4.
      const p = prof(`
        main:
          li   a0, 1
          addi a0, a0, 1
          li   a7, 10
          ecall
      `);
      eq(p.traced, 4, 'retired');
      eq(p.distinctPcs, 4, 'distinct PCs');
      for (const s of p.sites) eq(s.hits, 1, `hits @0x${s.pc.toString(16)}`);
      eq(siteHitsSum(p), p.totalHits, 'site-hit sum == totalHits');
    },
  },
  {
    name: 'prof: a loop body executes exactly N times',
    fn: () => {
      // Count down from 10 to 0: the loop body runs 10 times; the branch is taken 9, falls through 1.
      const p = prof(`
        main:
          li   t0, 10          # 1x
        loop:
          addi t0, t0, -1      # 10x
          bnez t0, loop        # 10x  (taken 9, not-taken 1)
          li   a7, 10          # 1x
          ecall                # 1x
      `);
      // find the branch site
      const branch = p.sites.find((s) => s.isControl);
      assert(!!branch, 'a control site exists');
      eq(branch!.hits, 10, 'branch executed 10x');
      eq(branch!.taken, 9, 'branch taken 9x');
      eq(branch!.notTaken, 1, 'branch fell through 1x');
      // the addi loop body also runs 10x
      const bodies = p.sites.filter((s) => s.mnemonic === 'addi' && s.hits === 10);
      assert(bodies.length >= 1, 'the decrement runs 10x');
    },
  },
  {
    name: 'prof: modelled cost charges FU latency (a mul costs its latency)',
    fn: () => {
      const p = prof(`
        main:
          li   a0, 6
          li   a1, 7
          mul  a2, a0, a1
          li   a7, 10
          ecall
      `);
      const mulSite = p.sites.find((s) => s.mnemonic === 'mul');
      assert(!!mulSite, 'mul site exists');
      eq(mulSite!.cost, DEFAULT_COST.mul, 'mul cost == mul latency');
      // total cost = (n-1 single-cycle ops)*1 + mul latency
      const singles = p.traced - 1;
      eq(p.totalCost, singles + DEFAULT_COST.mul, 'total modelled cost');
    },
  },
  {
    name: 'prof: coverage flags an unexecuted branch of an if',
    fn: () => {
      // The `then` arm is skipped, so its instruction is static-but-uncovered.
      const p = prof(`
        main:
          li   a0, 0
          bnez a0, taken       # not taken
          j    done
        taken:
          li   a1, 999         # never runs
        done:
          li   a7, 10
          ecall
      `);
      assert(p.coverage < 1, 'coverage below 100%');
      assert(p.uncovered.length >= 1, 'has uncovered instructions');
      // every uncovered PC is a static instruction that never appears in the executed site map
      const executedPcs = new Set(p.sites.map((s) => s.pc));
      assert(p.uncovered.every((a) => !executedPcs.has(a)), 'uncovered ∩ executed == ∅');
    },
  },
  {
    name: 'prof: call/return reconstruct a caller→callee frame with inclusive ≥ self',
    fn: () => {
      // main calls f; f does a little work and returns. f's inclusive == f's self (no callees);
      // main's inclusive contains f's inclusive.
      const p = prof(`
        main:
          li   a0, 3
          call f
          li   a7, 10
          ecall
        f:
          addi a0, a0, 1
          addi a0, a0, 1
          ret
      `);
      const main = p.functions.find((fn) => fn.name === 'main');
      const f = p.functions.find((fn) => fn.name === 'f');
      assert(!!main && !!f, 'both functions present');
      eq(f!.calls, 1, 'f entered once');
      assert(f!.totalCost >= f!.selfCost, 'f inclusive ≥ self');
      // main inclusive covers the whole program
      eq(main!.totalHits, p.traced, 'main inclusive == all retired');
      // an edge main→f exists
      const edge = p.edges.find((e) => e.caller === 'main' && e.callee === 'f');
      assert(!!edge && edge.count === 1, 'main→f edge counted once');
      // self totals across functions sum to the whole
      let selfSum = 0;
      for (const fn of p.functions) selfSum += fn.selfHits;
      eq(selfSum, p.traced, 'Σ self hits == retired');
    },
  },
  {
    name: 'prof: a function called in a loop counts every entry',
    fn: () => {
      const p = prof(`
        main:
          li   s0, 4
        again:
          call work
          addi s0, s0, -1
          bnez s0, again
          li   a7, 10
          ecall
        work:
          addi t0, t0, 1
          ret
      `);
      const work = p.functions.find((fn) => fn.name === 'work');
      assert(!!work, 'work present');
      eq(work!.calls, 4, 'work called 4x');
      // work's self hits = 4 entries * 2 retired instrs (addi + ret) = 8
      eq(work!.selfHits, 8, 'work self hits');
    },
  },
  {
    name: 'prof: memory profile counts the exact addresses a store/load touch',
    fn: () => {
      // Store to a known data address, then load it back: 1 write + 1 read at the same address.
      const p = prof(`
        .data
        cell: .word 0
        .text
        main:
          la   t0, cell
          li   t1, 42
          sw   t1, 0(t0)
          lw   t2, 0(t0)
          li   a7, 10
          ecall
      `);
      eq(p.mem.writes, 1, 'one store');
      eq(p.mem.reads, 1, 'one load');
      eq(p.mem.distinct, 1, 'one distinct address');
      eq(p.mem.hot.length, 1, 'one hot address');
      eq(p.mem.hot[0].count, 2, 'address accessed twice');
      eq(p.mem.hot[0].reads, 1, 'one read at address');
      eq(p.mem.hot[0].writes, 1, 'one write at address');
    },
  },
  {
    name: 'prof: flamegraph root inclusive equals the total and is well-nested',
    fn: () => {
      const p = prof(`
        main:
          li   a0, 2
          call a
          li   a7, 10
          ecall
        a:                       # non-leaf: saves/restores ra around its call to b
          addi sp, sp, -4
          sw   ra, 0(sp)
          call b
          lw   ra, 0(sp)
          addi sp, sp, 4
          ret
        b:
          addi a0, a0, 1
          ret
      `);
      eq(p.flame.totalHits, p.traced, 'root inclusive hits == retired');
      eq(p.flame.totalCost, p.totalCost, 'root inclusive cost == total cost');
      // a child's inclusive never exceeds its parent's
      const check = (node: typeof p.flame) => {
        for (const c of node.children) {
          assert(c.totalCost <= node.totalCost, `child ${c.func} inclusive ≤ parent ${node.func}`);
          check(c);
        }
      };
      check(p.flame);
      // layout: rectangles stay within their parent's span and fractions are ≤ 1
      const rects = layoutFlame(p.flame, 'cost');
      for (const r of rects) {
        assert(r.x0 >= -1e-9 && r.x1 <= 1 + 1e-9, 'rect within [0,1]');
        assert(r.fraction <= 1 + 1e-9, 'fraction ≤ 1');
      }
      assert(flameDepth(rects) >= 2, 'main→a→b nests at least 3 levels');
    },
  },
  {
    name: 'prof: categories partition the retired stream',
    fn: () => {
      const p = prof(`
        .data
        cell: .word 0
        .text
        main:
          la   t0, cell        # alu (auipc+addi via la — 2 alu)
          li   t1, 5           # alu
          sw   t1, 0(t0)       # store
          lw   t2, 0(t0)       # load
          mul  t3, t1, t1      # muldiv
          j    done            # jump
        done:
          li   a7, 10
          ecall                # system
      `);
      let hits = 0;
      let cost = 0;
      for (const c of p.categories) {
        hits += c.hits;
        cost += c.cost;
      }
      eq(hits, p.totalHits, 'Σ category hits == totalHits');
      eq(cost, p.totalCost, 'Σ category cost == totalCost');
      assert(p.categories.some((c) => c.name === 'load') && p.categories.some((c) => c.name === 'store'), 'load+store present');
      assert(p.categories.some((c) => c.name === 'muldiv'), 'muldiv present');
    },
  },
  {
    name: 'prof: bundled examples profile without corruption (invariants hold)',
    fn: () => {
      const ids = ['fib', 'gcd', 'bubble', 'reverse', 'muldiv', 'dotprod'];
      for (const id of ids) {
        const ex = EXAMPLES.find((e) => e.id === id);
        assert(!!ex, `example ${id} exists`);
        const program = assemble(ex!.code, { compress: false });
        assert(program.ok, `${id} assembles`);
        const p = profile(program);
        assert(p.ok, `${id} profiles`);
        // core invariants
        eq(siteHitsSum(p), p.traced, `${id}: Σ site hits == retired`);
        eq(p.flame.totalHits, p.traced, `${id}: flame root inclusive == retired`);
        let selfSum = 0;
        for (const fn of p.functions) selfSum += fn.selfHits;
        eq(selfSum, p.traced, `${id}: Σ function self == retired`);
        assert(p.coverage > 0 && p.coverage <= 1, `${id}: coverage in (0,1]`);
      }
    },
  },
];

export function runProfTests(): TestResult[] {
  return TESTS.map(({ name, fn }) => {
    try {
      fn();
      return { name, passed: true, detail: 'ok' };
    } catch (e) {
      return { name, passed: false, detail: (e as Error).message };
    }
  });
}
