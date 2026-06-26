// The optimizer's own verification suite, surfaced in the in-app "Verify" tab.
//
// Three layers of evidence:
//   1. transform unit tests — each pass fires on a minimal case and produces the expected code;
//   2. end-to-end equivalence — every bundled C program and hand-written assembly example is
//      compiled/assembled, optimized, and proven observably identical to the original; and
//   3. randomized differential fuzzing — hundreds of pseudo-random straight-line programs (with
//      balanced stack traffic) are optimized and checked, the technique real compilers rely on.
//
// A failure here means a miscompile, so the bar is byte-for-byte identical console output + exit
// code (the same oracle the Optimizer tab shows live).

import type { TestResult } from '../vm/selftest';
import { compile } from '../cc/compile';
import { C_EXAMPLES } from '../cc/examples';
import { EXAMPLES } from '../vm/examples';
import { optimizeAsm } from './optimize';
import { runProgram } from './equiv';

interface Case {
  name: string;
  fn: () => void;
}

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(msg);
}

// Optimize `src` and assert the result is observably identical. When both runs halt, the full
// output + exit code must match; when one hits the step budget (a program that loops by design),
// the optimized version simply gets further in the same steps, so the shorter output must be a
// prefix of the longer — equivalent programs emit the same byte sequence regardless of speed.
function assertEquivalent(src: string, label: string, budget = 4_000_000): { before: number; after: number } {
  const res = optimizeAsm(src);
  const a = runProgram(src, budget);
  const b = runProgram(res.asm, budget);
  assert(a.ok, `${label}: original did not assemble — ${a.assembleError ?? ''}`);
  assert(b.ok, `${label}: optimized did not assemble — ${b.assembleError ?? ''}`);
  if (a.halted && b.halted) {
    assert(a.output === b.output, `${label}: console output differs\n  before: ${JSON.stringify(a.output).slice(0, 80)}\n  after:  ${JSON.stringify(b.output).slice(0, 80)}`);
    assert(a.status === b.status, `${label}: halt status differs (${a.status} vs ${b.status})`);
    assert(a.exitCode === b.exitCode, `${label}: exit code differs (${a.exitCode} vs ${b.exitCode})`);
  } else {
    const n = Math.min(a.output.length, b.output.length);
    assert(a.output.slice(0, n) === b.output.slice(0, n), `${label}: output prefix differs (one program ran longer)\n  before: ${JSON.stringify(a.output).slice(0, 80)}\n  after:  ${JSON.stringify(b.output).slice(0, 80)}`);
  }
  return { before: res.stats.instrsBefore, after: res.stats.instrsAfter };
}

function optd(src: string): string {
  return optimizeAsm(src).asm;
}
function bodyText(asm: string): string {
  // The user-relevant region (drop the .data section) for textual assertions.
  return asm.split('.data')[0];
}
function countOp(asm: string, op: string): number {
  return bodyText(asm).split('\n').filter((l) => new RegExp(`^\\s*${op}\\b`).test(l)).length;
}

// A tiny program wrapper that prints one int so optimizing it has an observable effect.
function prog(body: string): string {
  return `.text\nmain:\n${body}\n        li a7, 93\n        li a0, 0\n        ecall\n`;
}

const UNIT: Case[] = [
  {
    name: 'opt: peephole — addi x,y,0 → mv, mul by x0 → li 0',
    fn: () => {
      const out = optd(prog('        li t0, 5\n        addi t1, t0, 0\n        mul t2, t1, x0\n        mv a0, t1\n        li a7, 1\n        ecall'));
      assert(/\bmul\b/.test(bodyText(out)) === false, 'mul by x0 should be folded away');
    },
  },
  {
    name: 'opt: constant folding — 2 + 3*4 collapses to li 14',
    fn: () => {
      const out = optd(prog('        li t0, 3\n        li t1, 4\n        mul t2, t0, t1\n        li t3, 2\n        add a0, t2, t3\n        li a7, 1\n        ecall'));
      assert(/li\s+a0,\s*14/.test(bodyText(out)) || /li\s+\w+,\s*14/.test(bodyText(out)), 'expected the constant 14 to be materialised directly');
      assert(countOp(out, 'mul') === 0, 'the multiply should be folded');
    },
  },
  {
    name: 'opt: copy propagation + DCE removes a dead move chain',
    fn: () => {
      const out = optd(prog('        li t0, 7\n        mv t1, t0\n        mv t2, t1\n        mv a0, t2\n        li a7, 1\n        ecall'));
      assert(countOp(out, 'mv') <= 1, 'the chain of copies should collapse');
    },
  },
  {
    name: 'opt: strength reduction — multiply by 8 → shift',
    fn: () => {
      const out = optd(prog('        li t0, 8\n        mv a0, a1\n        mul a0, a0, t0\n        li a7, 1\n        ecall'));
      assert(countOp(out, 'mul') === 0 && countOp(out, 'slli') >= 1, 'mul by 8 should become slli ,,3');
    },
  },
  {
    name: 'opt: address-mode folding — addi base + lw 0(base) → lw off(base)',
    fn: () => {
      const out = optd(prog('        addi t0, gp, 16\n        lw a0, 0(t0)\n        li a7, 1\n        ecall'));
      assert(/lw\s+a0,\s*16\(gp\)/.test(bodyText(out)), 'the address computation should fold into the load offset');
    },
  },
  {
    name: 'opt: stack forwarding — a pushed constant is rematerialised, store removed',
    fn: () => {
      const out = optd(prog('        li t0, 42\n        addi sp, sp, -4\n        sw t0, 0(sp)\n        lw a0, 0(sp)\n        addi sp, sp, 4\n        li a7, 1\n        ecall'));
      assert(countOp(out, 'sw') === 0, 'the dead spill store should be eliminated');
      assert(countOp(out, 'lw') === 0, 'the reload should be rematerialised, not a memory load');
    },
  },
  {
    name: 'opt: dead stack-slot — an unused push/pop pair vanishes',
    fn: () => {
      const out = optd(prog('        li a0, 1\n        addi sp, sp, -4\n        addi sp, sp, 4\n        li a7, 1\n        ecall'));
      assert(countOp(out, 'addi') === 0 || /addi\s+sp/.test(bodyText(out)) === false, 'the balanced unused sp pair should be removed');
    },
  },
  {
    name: 'opt: CSE — a repeated computation reuses the first result',
    fn: () => {
      const out = optd(prog('        add t2, a0, a1\n        add t3, a0, a1\n        add a0, t2, t3\n        li a7, 1\n        ecall'));
      assert(countOp(out, 'add') <= 2, 'the duplicated add should be eliminated by value numbering');
    },
  },
  {
    name: 'opt: control flow — a jump to the next instruction is removed',
    fn: () => {
      const out = optd(prog('        li a0, 1\n        j next\nnext:\n        li a7, 1\n        ecall'));
      assert(countOp(out, 'j') === 0, 'the no-op jump-to-next should be removed');
    },
  },
  {
    name: 'opt: constant branch — beqz on a known-zero becomes the taken jump',
    fn: () => {
      const out = optd(prog('        li t0, 0\n        beqz t0, hit\n        li a0, 999\nhit:\n        li a7, 11\n        li a0, 65\n        ecall'));
      assert(/li\s+a0,\s*999/.test(bodyText(out)) === false, 'the dead arm of a constant branch should be removed');
    },
  },
];

function equivalenceCases(): Case[] {
  const cases: Case[] = [];
  for (const ex of C_EXAMPLES) {
    cases.push({
      name: `opt: C example "${ex.title}" stays equivalent (and shrinks)`,
      fn: () => {
        const c = compile(ex.code);
        assert(c.ok && !!c.asm, `compile failed for ${ex.title}`);
        const { before, after } = assertEquivalent(c.asm!, ex.title);
        assert(after <= before, `${ex.title}: optimizer must not grow the program (${before} → ${after})`);
      },
    });
  }
  // Hand-written assembly examples — equivalence over a bounded run (some loop forever by design).
  for (const ex of EXAMPLES) {
    cases.push({
      name: `opt: asm example "${ex.title}" stays equivalent`,
      fn: () => assertEquivalent(ex.code, ex.title, 200_000),
    });
  }
  return cases;
}

// ---- randomized differential fuzzing --------------------------------------

// A small deterministic PRNG (no Math.random — keeps the suite reproducible).
function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

const WORK = ['t0', 't1', 't2', 't3', 't4', 't5', 't6', 'a1', 'a2', 'a3', 'a4', 'a5'];
const RR = ['add', 'sub', 'and', 'or', 'xor', 'sll', 'srl', 'sra', 'mul', 'slt', 'sltu', 'div', 'divu', 'rem', 'remu'];
const RI = ['addi', 'andi', 'ori', 'xori', 'slti', 'sltiu'];
const SH = ['slli', 'srli', 'srai'];
const UN = ['neg', 'not', 'seqz', 'snez', 'mv'];

function randomProgram(seed: number, n: number): string {
  const rnd = lcg(seed);
  const pick = <T>(a: readonly T[]): T => a[Math.floor(rnd() * a.length)];
  const rsmall = () => Math.floor(rnd() * 4096) - 2048; // 12-bit-ish immediates
  const lines: string[] = ['.text', 'main:'];
  for (const r of WORK) lines.push(`        li ${r}, ${Math.floor(rnd() * 200) - 100}`);
  let depth = 0;
  const pushed: string[] = [];
  for (let k = 0; k < n; k++) {
    const roll = rnd();
    if (roll < 0.14) {
      const r = pick(WORK);
      lines.push('        addi sp, sp, -4');
      lines.push(`        sw ${r}, 0(sp)`);
      pushed.push(r);
      depth++;
    } else if (roll < 0.26 && depth > 0) {
      const r = pick(WORK);
      lines.push(`        lw ${r}, 0(sp)`);
      lines.push('        addi sp, sp, 4');
      pushed.pop();
      depth--;
    } else {
      const cls = rnd();
      if (cls < 0.45) lines.push(`        ${pick(RR)} ${pick(WORK)}, ${pick(WORK)}, ${pick(WORK)}`);
      else if (cls < 0.7) lines.push(`        ${pick(RI)} ${pick(WORK)}, ${pick(WORK)}, ${rsmall()}`);
      else if (cls < 0.85) lines.push(`        ${pick(SH)} ${pick(WORK)}, ${pick(WORK)}, ${Math.floor(rnd() * 32)}`);
      else lines.push(`        ${pick(UN)} ${pick(WORK)}, ${pick(WORK)}`);
    }
  }
  while (depth > 0) { lines.push('        lw t0, 0(sp)'); lines.push('        addi sp, sp, 4'); depth--; }
  // Observe every working register so dead-code elimination can't trivially erase the program.
  for (const r of WORK) {
    lines.push(`        mv a0, ${r}`);
    lines.push('        li a7, 1');
    lines.push('        ecall');
    lines.push('        li a7, 11');
    lines.push('        li a0, 32');
    lines.push('        ecall');
  }
  lines.push('        li a7, 93');
  lines.push('        li a0, 0');
  lines.push('        ecall');
  return lines.join('\n') + '\n';
}

function fuzzCase(count: number, len: number): Case {
  return {
    name: `opt: ${count} randomized programs are miscompile-free (differential fuzz)`,
    fn: () => {
      for (let i = 0; i < count; i++) {
        const src = randomProgram(0x9e3779b9 ^ (i * 2654435761), len);
        assertEquivalent(src, `fuzz#${i} (seed ${i})`, 300_000);
      }
    },
  };
}

function idempotenceCase(): Case {
  return {
    name: 'opt: optimization reaches a fixpoint (re-optimizing is a no-op)',
    fn: () => {
      const c = compile(C_EXAMPLES[1].code); // recursive fibonacci
      const once = optimizeAsm(c.asm!);
      const twice = optimizeAsm(once.asm);
      assert(twice.stats.removed === 0, `re-optimizing removed ${twice.stats.removed} more instructions — not a fixpoint`);
    },
  };
}

export function runOptTests(): TestResult[] {
  const cases: Case[] = [...UNIT, ...equivalenceCases(), idempotenceCase(), fuzzCase(200, 36)];
  return cases.map(({ name, fn }) => {
    try {
      fn();
      return { name, passed: true, detail: 'ok' };
    } catch (e) {
      return { name, passed: false, detail: (e as Error).message };
    }
  });
}
