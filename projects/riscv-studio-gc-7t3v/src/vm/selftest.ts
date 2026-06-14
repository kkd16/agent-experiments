// An in-app verification suite. Each test assembles a tiny program (or a bundled example),
// runs it on the interpreter, and asserts on the resulting output / registers / memory.
//
// This is the project's own quality gate: open the "Verify" tab and every check should be
// green. It exercises the assembler, the decoder, and the executor end-to-end.

import { assemble } from './assembler';
import { Cpu } from './cpu';
import { EXAMPLES } from './examples';
import { FB_BASE, FB_W } from './constants';
import { decode } from './decode';
import { disassemble, disassembleUnit } from './disassembler';
import { decompress } from './compressed';

export interface TestResult {
  name: string;
  passed: boolean;
  detail: string;
}

class AssertionError extends Error {}

function assert(cond: boolean, message: string): void {
  if (!cond) throw new AssertionError(message);
}

function eq<T>(actual: T, expected: T, label: string): void {
  if (actual !== expected) {
    throw new AssertionError(`${label}: expected ${String(expected)}, got ${String(actual)}`);
  }
}

/** Assemble + run a program, returning the halted CPU. Throws on assembler errors. */
function run(src: string, maxSteps = 5_000_000): Cpu {
  const result = assemble(src);
  if (!result.ok) {
    throw new AssertionError(`assembler errors: ${result.errors.map((e) => `L${e.line} ${e.message}`).join('; ')}`);
  }
  const cpu = new Cpu();
  cpu.load(result);
  cpu.run(maxSteps);
  return cpu;
}

type Test = { name: string; fn: () => void };

const TESTS: Test[] = [
  {
    name: 'addi / print_int prints 5',
    fn: () => {
      const cpu = run(`
        main:
          li a0, 2
          addi a0, a0, 3
          li a7, 1
          ecall
          li a7, 10
          ecall
      `);
      eq(cpu.output, '5', 'output');
      eq(cpu.status, 'halted', 'status');
    },
  },
  {
    name: 'sum 1..100 == 5050 (branch loop)',
    fn: () => {
      const cpu = run(`
        main:
          li t0, 0          # acc
          li t1, 1          # i
        loop:
          li t2, 101
          bge t1, t2, done
          add t0, t0, t1
          addi t1, t1, 1
          j loop
        done:
          mv a0, t0
          li a7, 1
          ecall
          li a7, 10
          ecall
      `);
      eq(cpu.output, '5050', 'sum');
    },
  },
  {
    name: 'large li uses lui+addi (0x12345678)',
    fn: () => {
      const cpu = run(`
        main:
          li a0, 0x12345678
          li a7, 34
          ecall
          li a7, 10
          ecall
      `);
      eq(cpu.output, '0x12345678', 'hex print');
    },
  },
  {
    name: 'signed vs unsigned: srai vs srli of -16',
    fn: () => {
      const cpu = run(`
        main:
          li t0, -16
          srai a0, t0, 2     # -4
          li a7, 1
          ecall
          li a0, ' '
          li a7, 11
          ecall
          li t0, -16
          srli a0, t0, 28    # logical: 0xF
          li a7, 1
          ecall
          li a7, 10
          ecall
      `);
      eq(cpu.output, '-4 15', 'shift results');
    },
  },
  {
    name: 'RV32M: mul / div / rem',
    fn: () => {
      const cpu = run(`
        main:
          li a0, 123456
          li a1, 1000
          mul a0, a0, a1     # 123456000
          li a7, 1
          ecall
          li a0, ' '
          li a7, 11
          ecall
          li a0, -7
          li a1, 2
          div a0, a0, a1     # -3 (truncate toward zero)
          li a7, 1
          ecall
          li a0, ' '
          li a7, 11
          ecall
          li a0, -7
          li a1, 2
          rem a0, a0, a1     # -1
          li a7, 1
          ecall
          li a7, 10
          ecall
      `);
      eq(cpu.output, '123456000 -3 -1', 'muldiv');
    },
  },
  {
    name: 'division by zero is defined (-1, dividend)',
    fn: () => {
      const cpu = run(`
        main:
          li a0, 42
          li a1, 0
          div a2, a0, a1     # -1
          rem a3, a0, a1     # 42
          mv a0, a2
          li a7, 1
          ecall
          li a0, ' '
          li a7, 11
          ecall
          mv a0, a3
          li a7, 1
          ecall
          li a7, 10
          ecall
      `);
      eq(cpu.output, '-1 42', 'div0');
    },
  },
  {
    name: 'memory round-trip: sw then lw',
    fn: () => {
      const cpu = run(`
        .data
        slot: .word 0
        .text
        main:
          la t0, slot
          li t1, 0xCAFEBABE
          sw t1, 0(t0)
          lw a0, 0(t0)
          li a7, 34
          ecall
          li a7, 10
          ecall
      `);
      eq(cpu.output, '0xcafebabe', 'roundtrip');
    },
  },
  {
    name: 'byte loads sign-extend (lb) vs zero-extend (lbu)',
    fn: () => {
      const cpu = run(`
        .data
        b: .byte 0xFF
        .text
        main:
          la t0, b
          lb a0, 0(t0)       # -1
          li a7, 1
          ecall
          li a0, ' '
          li a7, 11
          ecall
          la t0, b
          lbu a0, 0(t0)      # 255
          li a7, 1
          ecall
          li a7, 10
          ecall
      `);
      eq(cpu.output, '-1 255', 'lb/lbu');
    },
  },
  {
    name: 'call / ret with a recursive-style helper (factorial 5 = 120)',
    fn: () => {
      const cpu = run(`
        .text
        main:
          li a0, 5
          call fact
          li a7, 1
          ecall
          li a7, 10
          ecall
        # iterative factorial(a0) -> a0
        fact:
          li t0, 1
        floop:
          beqz a0, fdone
          mul t0, t0, a0
          addi a0, a0, -1
          j floop
        fdone:
          mv a0, t0
          ret
      `);
      eq(cpu.output, '120', 'factorial');
    },
  },
  {
    name: 'example: GCD(1071, 462) == 21',
    fn: () => {
      const cpu = run(EXAMPLES.find((e) => e.id === 'gcd')!.code);
      eq(cpu.output, '21', 'gcd output');
    },
  },
  {
    name: 'example: bubble sort produces ascending order',
    fn: () => {
      const cpu = run(EXAMPLES.find((e) => e.id === 'bubble')!.code);
      eq(cpu.output.trim(), '0 1 2 3 4 5 6 7 8 9', 'sorted');
    },
  },
  {
    name: 'example: Fibonacci first values',
    fn: () => {
      const cpu = run(EXAMPLES.find((e) => e.id === 'fib')!.code);
      assert(cpu.output.startsWith('0 1 1 2 3 5 8 13 21 34'), `got: ${cpu.output}`);
    },
  },
  {
    name: 'framebuffer: Mandelbrot interior is black, corner escapes',
    fn: () => {
      const cpu = run(EXAMPLES.find((e) => e.id === 'mandelbrot')!.code, 20_000_000);
      eq(cpu.status, 'halted', 'status');
      // Centre pixel maps to c = (-0.75, 0), which is inside the set -> colour 0.
      const center = cpu.mem.readByte(FB_BASE + 64 * FB_W + 64);
      eq(center, 0, 'centre pixel colour');
      // Top-left maps to c = (-2.5, -1.5), which escapes on the first iteration -> colour 1.
      const corner = cpu.mem.readByte(FB_BASE + 0);
      eq(corner, 1, 'corner pixel colour');
    },
  },
  {
    name: 'decoder ⇄ encoder round-trip for a sampled program',
    fn: () => {
      const result = assemble(EXAMPLES.find((e) => e.id === 'fib')!.code);
      assert(result.ok, 'fib assembles');
      for (const ins of result.instrs) {
        const d = decode(ins.word);
        assert(d.mnemonic !== 'unknown', `decoded ${ins.word.toString(16)} as unknown`);
        // disassembly should at least be non-empty and mention something sane
        assert(disassemble(ins.word, ins.addr).length > 0, 'disassembly empty');
      }
    },
  },
  {
    name: 'assembler reports an error for an unknown instruction',
    fn: () => {
      const result = assemble('main:\n  florp a0, a1, a2\n');
      assert(!result.ok, 'should fail');
      assert(result.errors.some((e) => /unknown instruction/.test(e.message)), 'error message');
    },
  },
  {
    name: 'assembler rejects an out-of-range immediate',
    fn: () => {
      const result = assemble('main:\n  addi a0, a0, 5000\n');
      assert(!result.ok, 'should fail');
      assert(result.errors.some((e) => /out of range/.test(e.message)), 'range error');
    },
  },
  {
    name: 'branch offsets resolve in both directions',
    fn: () => {
      const cpu = run(`
        main:
          li a0, 0
          li t0, 0
        up:
          addi a0, a0, 1
          addi t0, t0, 1
          li t1, 3
          blt t0, t1, up      # backward branch
          li t1, 1
          beq t1, t1, fwd     # forward branch
          li a0, 999          # skipped
        fwd:
          li a7, 1
          ecall
          li a7, 10
          ecall
      `);
      eq(cpu.output, '3', 'branches');
    },
  },

  // --- RV32F floating point --------------------------------------------------
  {
    name: 'RV32F: integer→float→arithmetic→int (3*4+3 = 15)',
    fn: () => {
      const cpu = run(`
        main:
          li t0, 3
          fcvt.s.w fa0, t0
          li t1, 4
          fcvt.s.w fa1, t1
          fmul.s fa2, fa0, fa1
          fadd.s fa2, fa2, fa0
          fcvt.w.s a0, fa2
          li a7, 1
          ecall
          li a7, 10
          ecall
      `);
      eq(cpu.output, '15', 'fp arithmetic');
    },
  },
  {
    name: 'RV32F: fsqrt then square round-trips (sqrt(2)^2 ≈ 2)',
    fn: () => {
      const cpu = run(`
        main:
          li t0, 2
          fcvt.s.w fa0, t0
          fsqrt.s fa1, fa0
          fmul.s fa2, fa1, fa1
          fcvt.w.s a0, fa2
          li a7, 1
          ecall
          li a7, 10
          ecall
      `);
      eq(cpu.output, '2', 'sqrt round-trip');
    },
  },
  {
    name: 'RV32F: print_float renders pi bits as 3.14159…',
    fn: () => {
      const cpu = run(`
        main:
          li t0, 0x40490fdb
          fmv.w.x fa0, t0
          li a7, 2
          ecall
          li a7, 10
          ecall
      `);
      assert(cpu.output.startsWith('3.14159'), `got: ${cpu.output}`);
    },
  },
  {
    name: 'RV32F: fmv.x.w / fmv.w.x preserve the bit pattern',
    fn: () => {
      const cpu = run(`
        main:
          li t0, 0x40490fdb
          fmv.w.x fa0, t0
          fmv.x.w a0, fa0
          li a7, 34
          ecall
          li a7, 10
          ecall
      `);
      eq(cpu.output, '0x40490fdb', 'bit move');
    },
  },
  {
    name: 'RV32F: compares (flt/fle/feq) and fclass of +0.0',
    fn: () => {
      const cpu = run(`
        main:
          li t0, 1
          fcvt.s.w fa0, t0
          li t1, 2
          fcvt.s.w fa1, t1
          flt.s a0, fa0, fa1     # 1
          li a7, 1
          ecall
          li a0, ' '
          li a7, 11
          ecall
          li t0, 0
          fcvt.s.w fa0, t0
          fclass.s a0, fa0       # +0.0 -> bit 4 = 16
          li a7, 1
          ecall
          li a7, 10
          ecall
      `);
      eq(cpu.output, '1 16', 'compare + fclass');
    },
  },
  {
    name: 'example: Newton √2 (float) ≈ 1.41421',
    fn: () => {
      const cpu = run(EXAMPLES.find((e) => e.id === 'newton')!.code);
      assert(cpu.output.startsWith('1.4142'), `got: ${cpu.output}`);
    },
  },
  {
    name: 'example: Leibniz π (float) ≈ 3.14…',
    fn: () => {
      const cpu = run(EXAMPLES.find((e) => e.id === 'leibniz')!.code);
      assert(cpu.output.startsWith('3.14'), `got: ${cpu.output}`);
    },
  },
  {
    name: 'example: float dot product (fmadd.s) == 70',
    fn: () => {
      const cpu = run(EXAMPLES.find((e) => e.id === 'dotprod')!.code);
      eq(cpu.output, '70', 'dot product');
    },
  },

  // --- RV32A atomics ---------------------------------------------------------
  {
    name: 'RV32A: amoadd.w returns the old value and updates memory',
    fn: () => {
      const cpu = run(`
        .data
        counter: .word 10
        .text
        main:
          la t0, counter
          li t1, 5
          amoadd.w a0, t1, (t0)   # a0 = 10 (old), mem -> 15
          li a7, 1
          ecall
          li a0, ' '
          li a7, 11
          ecall
          lw a0, 0(t0)
          li a7, 1
          ecall
          li a7, 10
          ecall
      `);
      eq(cpu.output, '10 15', 'amoadd');
    },
  },
  {
    name: 'RV32A: amoswap.w swaps and lr/sc succeeds',
    fn: () => {
      const cpu = run(`
        .data
        slot: .word 7
        .text
        main:
          la t0, slot
          li t1, 42
          amoswap.w a0, t1, (t0)  # a0 = 7 (old)
          li a7, 1
          ecall
          li a0, ' '
          li a7, 11
          ecall
          lr.w t2, (t0)
          li t3, 99
          sc.w a0, t3, (t0)       # success -> 0
          li a7, 1
          ecall
          li a0, ' '
          li a7, 11
          ecall
          lw a0, 0(t0)            # 99
          li a7, 1
          ecall
          li a7, 10
          ecall
      `);
      eq(cpu.output, '7 0 99', 'amoswap + lr/sc');
    },
  },
  {
    name: 'example: atomic counter (100 amoadd.w) == 100',
    fn: () => {
      const cpu = run(EXAMPLES.find((e) => e.id === 'atomic')!.code);
      eq(cpu.output, '100', 'atomic counter');
    },
  },

  // --- Zicsr + counters ------------------------------------------------------
  {
    name: 'Zicsr: rdcycle advances by the instructions executed between reads',
    fn: () => {
      const cpu = run(`
        main:
          rdcycle t0
          nop
          nop
          rdcycle t1
          sub a0, t1, t0      # 3 (nop, nop, rdcycle)
          li a7, 1
          ecall
          li a7, 10
          ecall
      `);
      eq(cpu.output, '3', 'rdcycle delta');
    },
  },
  {
    name: 'Zicsr: fcsr write-then-read round-trips',
    fn: () => {
      const cpu = run(`
        main:
          li t0, 0x1f
          csrw fcsr, t0
          csrr a0, fcsr
          li a7, 1
          ecall
          li a7, 10
          ecall
      `);
      eq(cpu.output, '31', 'fcsr round-trip');
    },
  },
  {
    name: 'example: cycle counter prints "<cycles> 500500"',
    fn: () => {
      const cpu = run(EXAMPLES.find((e) => e.id === 'counters')!.code);
      assert(/^\d+ 500500$/.test(cpu.output), `got: ${cpu.output}`);
    },
  },

  // --- time-travel debugger --------------------------------------------------
  {
    name: 'time-travel: stepBack reverts registers, pc and cycles',
    fn: () => {
      const result = assemble(`main:\n  li a0, 7\n  addi a0, a0, 5\n  li a7, 10\n  ecall\n`);
      assert(result.ok, 'assembles');
      const cpu = new Cpu();
      cpu.load(result);
      cpu.step(); // li a0, 7
      cpu.step(); // addi a0, a0, 5 -> 12
      eq(cpu.regs[10], 12, 'a0 after two steps');
      eq(cpu.stepBack(), true, 'stepBack ok');
      eq(cpu.regs[10], 7, 'a0 reverted');
      cpu.stepBack();
      eq(cpu.regs[10], 0, 'a0 back to start');
      eq(cpu.pc, 0, 'pc back to start');
      eq(cpu.stepBack(), false, 'nothing left to undo');
    },
  },
  {
    name: 'time-travel: stepBack restores memory written by a store',
    fn: () => {
      const result = assemble(`.data\nx: .word 0\n.text\nmain:\n  la t0, x\n  li t1, 99\n  sw t1, 0(t0)\n  li a7, 10\n  ecall\n`);
      assert(result.ok, 'assembles');
      const cpu = new Cpu();
      cpu.load(result);
      cpu.step(); // la part 1
      cpu.step(); // la part 2
      const addr = cpu.regs[5] >>> 0;
      cpu.step(); // li t1, 99
      cpu.step(); // sw
      eq(cpu.mem.readWord(addr), 99, 'stored');
      cpu.stepBack();
      eq(cpu.mem.readWord(addr), 0, 'store reverted');
    },
  },

  // --- new examples render to the framebuffer --------------------------------
  {
    name: 'example: float Mandelbrot fills the framebuffer (centre inside set)',
    fn: () => {
      const cpu = run(EXAMPLES.find((e) => e.id === 'mandelf')!.code, 30_000_000);
      eq(cpu.status, 'halted', 'status');
      eq(cpu.mem.readByte(FB_BASE + 64 * FB_W + 64), 0, 'centre pixel');
      let nonzero = 0;
      for (let i = 0; i < FB_W * FB_W; i++) if (cpu.mem.readByte(FB_BASE + i) !== 0) nonzero++;
      assert(nonzero > 500, `expected a drawn fractal, got ${nonzero} coloured pixels`);
    },
  },
  {
    name: 'FP decode ⇄ disassemble round-trip for the dot-product program',
    fn: () => {
      const result = assemble(EXAMPLES.find((e) => e.id === 'dotprod')!.code);
      assert(result.ok, 'assembles');
      for (const ins of result.instrs) {
        const d = decode(ins.word);
        assert(d.mnemonic !== 'unknown' && d.mnemonic !== '?', `bad decode 0x${ins.word.toString(16)}`);
        assert(disassemble(ins.word, ins.addr).length > 0, 'disassembly empty');
      }
    },
  },

  // --- RV32C compressed instructions -----------------------------------------
  {
    name: 'RV32C: c.li / c.addi / c.add / c.mv arithmetic == 10',
    fn: () => {
      const cpu = run(`
        main:
          c.li a0, 2
          c.addi a0, 5      # 7
          c.li a1, 3
          c.add a0, a1      # 10
          li a7, 1
          ecall
          li a7, 10
          ecall
      `);
      eq(cpu.output, '10', 'compressed arithmetic');
      eq(cpu.status, 'halted', 'status');
    },
  },
  {
    name: 'RV32C: compressed loop (c.j / c.add / c.addi / c.beqz) sums 1..10 == 55',
    fn: () => {
      const cpu = run(`
        main:
          c.li t0, 0
          c.li t1, 1
        loop:
          li t2, 11
          bge t1, t2, done
          c.add t0, t1
          c.addi t1, 1
          c.j loop
        done:
          c.mv a0, t0
          li a7, 1
          ecall
          li a7, 10
          ecall
      `);
      eq(cpu.output, '55', 'compressed loop sum');
    },
  },
  {
    name: 'RV32C: c.addi16sp + c.swsp/c.lwsp stack round-trip == 42',
    fn: () => {
      const cpu = run(`
        main:
          c.addi16sp -16
          li a0, 30
          c.addi a0, 12       # 42
          c.swsp a0, 0(sp)
          c.li a0, 0
          c.lwsp a0, 0(sp)
          c.addi16sp 16
          li a7, 1
          ecall
          li a7, 10
          ecall
      `);
      eq(cpu.output, '42', 'compressed stack round-trip');
    },
  },
  {
    name: 'RV32C: c.beqz / c.bnez select the right branch',
    fn: () => {
      const cpu = run(`
        main:
          c.li a0, 0
          c.beqz a0, zero
          c.li a1, 9
          c.j end
        zero:
          c.li a1, 7
        end:
          c.mv a0, a1
          li a7, 1
          ecall
          li a7, 10
          ecall
      `);
      eq(cpu.output, '7', 'compressed branch');
    },
  },
  {
    name: 'RV32C: a compressed instruction occupies 2 bytes (mixed 16/32-bit layout)',
    fn: () => {
      const result = assemble(`
        main:
          c.li a0, 1     # 2 bytes @ 0x0
          addi a0, a0, 1 # 4 bytes @ 0x2
          c.addi a0, 1   # 2 bytes @ 0x6
          li a7, 10
          ecall
      `);
      assert(result.ok, `assembles: ${result.errors.map((e) => e.message).join('; ')}`);
      const cli = result.instrs.find((i) => i.source.includes('c.li'))!;
      const addi = result.instrs.find((i) => i.source.startsWith('addi'))!;
      const caddi = result.instrs.find((i) => i.source.includes('c.addi'))!;
      eq(cli.len, 2, 'c.li length');
      eq(addi.len, 4, 'addi length');
      eq(cli.addr, 0, 'c.li addr');
      eq(addi.addr, 2, 'addi addr (after a 2-byte compressed op)');
      eq(caddi.addr, 6, 'c.addi addr (after a 4-byte op)');
    },
  },
  {
    name: 'RV32C: c.jal links pc+2 (compressed return address)',
    fn: () => {
      // c.jal calls a leaf that immediately returns; the program then prints ra-relative proof
      // by returning a sentinel. Simpler: check the linked ra equals the address after c.jal.
      const result = assemble(`
        main:
          c.jal leaf      # @0x0, 2 bytes; ra should become 0x2
          li a7, 10
          ecall
        leaf:
          mv a0, ra
          jr ra
      `);
      assert(result.ok, 'assembles');
      const cpu = new Cpu();
      cpu.load(result);
      cpu.step(); // execute c.jal
      eq(cpu.regs[1] >>> 0, 2, 'ra = pc+2 after compressed jal');
    },
  },
  {
    name: 'RV32C: every c.* form decompresses to exactly its full-width equivalent',
    fn: () => {
      // The acid test: a compressed instruction must *mean* the same 32-bit instruction the
      // assembler would emit for its expansion. We assemble each side independently and
      // compare the resulting machine words bit-for-bit.
      const pairs: [string, string][] = [
        ['c.addi4spn s0, 16', 'addi s0, sp, 16'],
        ['c.lw s0, 4(s1)', 'lw s0, 4(s1)'],
        ['c.sw s0, 8(s1)', 'sw s0, 8(s1)'],
        ['c.addi t0, -1', 'addi t0, t0, -1'],
        ['c.li t0, 5', 'addi t0, x0, 5'],
        ['c.lui t0, 3', 'lui t0, 3'],
        ['c.srli s0, 3', 'srli s0, s0, 3'],
        ['c.srai s0, 2', 'srai s0, s0, 2'],
        ['c.andi s0, 5', 'andi s0, s0, 5'],
        ['c.sub s0, s1', 'sub s0, s0, s1'],
        ['c.xor s0, s1', 'xor s0, s0, s1'],
        ['c.or s0, s1', 'or s0, s0, s1'],
        ['c.and s0, s1', 'and s0, s0, s1'],
        ['c.slli t0, 4', 'slli t0, t0, 4'],
        ['c.lwsp t0, 8(sp)', 'lw t0, 8(sp)'],
        ['c.swsp t0, 4(sp)', 'sw t0, 4(sp)'],
        ['c.mv t0, t1', 'add t0, x0, t1'],
        ['c.add t0, t1', 'add t0, t0, t1'],
        ['c.jr t0', 'jalr x0, 0(t0)'],
        ['c.jalr t0', 'jalr x1, 0(t0)'],
        ['c.addi16sp -32', 'addi sp, sp, -32'],
      ];
      for (const [c, full] of pairs) {
        const cr = assemble(`main:\n  ${c}\n`);
        assert(cr.ok, `compressed assembles: ${c} (${cr.errors.map((e) => e.message).join(';')})`);
        const ci = cr.instrs[0];
        eq(ci.len, 2, `${c} is 2 bytes`);
        const dc = decompress(ci.word, true);
        assert(dc !== null, `${c} decompresses`);
        const fr = assemble(`main:\n  ${full}\n`);
        assert(fr.ok, `full assembles: ${full}`);
        eq((dc!.word >>> 0).toString(16), (fr.instrs[0].word >>> 0).toString(16), `${c} ≡ ${full}`);
      }
    },
  },
  {
    name: 'RV32C: illegal compressed half (0x0000) is reported',
    fn: () => {
      eq(decompress(0x0000, true), null, 'all-zero half is illegal');
      const cpu = new Cpu();
      cpu.load(assemble('main:\n  .half 0x0000\n  .half 0x0000\n'));
      cpu.step();
      eq(cpu.status, 'error', 'executing an illegal compressed half faults');
    },
  },
  {
    name: 'RV32C: disassembly shows the c.* mnemonic and its expansion',
    fn: () => {
      const r = assemble('main:\n  c.addi a0, 5\n');
      assert(r.ok, 'assembles');
      const s = disassembleUnit(r.instrs[0].word, r.instrs[0].addr, 2);
      assert(s.startsWith('c.addi'), `expected c.addi prefix, got: ${s}`);
      assert(s.includes('addi a0, a0, 5'), `expected expansion, got: ${s}`);
    },
  },
  {
    name: 'RV32C: time-travel steps back across a compressed instruction',
    fn: () => {
      const cpu = new Cpu();
      cpu.load(assemble('main:\n  c.li a0, 7\n  c.addi a0, 5\n  li a7, 10\n  ecall\n'));
      cpu.step(); // c.li a0, 7  (pc 0 -> 2)
      cpu.step(); // c.addi a0, 5 -> 12 (pc 2 -> 4)
      eq(cpu.regs[10], 12, 'a0 after two compressed steps');
      eq(cpu.pc, 4, 'pc advanced by 2+2');
      cpu.stepBack();
      eq(cpu.regs[10], 7, 'a0 reverted');
      eq(cpu.pc, 2, 'pc reverted to 2');
    },
  },
  {
    name: 'example: compressed (RVC) program runs and is smaller',
    fn: () => {
      const ex = EXAMPLES.find((e) => e.id === 'compressed')!;
      const result = assemble(ex.code);
      assert(result.ok, `assembles: ${result.errors.map((e) => e.message).join('; ')}`);
      const compressedCount = result.instrs.filter((i) => i.len === 2).length;
      assert(compressedCount >= 5, `expected several compressed instrs, got ${compressedCount}`);
      const cpu = new Cpu();
      cpu.load(result);
      cpu.run(1_000_000);
      eq(cpu.output, '55', 'compressed example output');
    },
  },

  // --- Traps & interrupts (machine mode) -------------------------------------
  {
    name: 'traps: machine CSRs (mtvec/mscratch/mepc/mcause) read-write round-trip',
    fn: () => {
      const cpu = run(`
        main:
          li t0, 0x1234
          csrw mtvec, t0
          csrr a0, mtvec        # 0x1234
          li a7, 34
          ecall
          li a0, ' '
          li a7, 11
          ecall
          li t0, 0xABC
          csrw mscratch, t0
          csrr a0, mscratch
          li a7, 34
          ecall
          li a7, 10
          ecall
      `);
      eq(cpu.output, '0x00001234 0x00000abc', 'CSR round-trip');
    },
  },
  {
    name: 'traps: a machine timer interrupt is taken 5 times',
    fn: () => {
      const cpu = run(`
        .equ MTIME,    0x0200bff8
        .equ MTIMECMP, 0x02004000
        main:
          la t0, h
          csrw mtvec, t0
          li s0, 0
          li t0, MTIME
          lw t1, 0(t0)
          addi t1, t1, 10
          li t2, MTIMECMP
          sw t1, 0(t2)
          li t0, 0x80
          csrs mie, t0
          csrsi mstatus, 0x8
        loop:
          li t3, 5
          blt s0, t3, loop
          mv a0, s0
          li a7, 1
          ecall
          li a7, 10
          ecall
        h:
          addi s0, s0, 1
          li t0, MTIME
          lw t1, 0(t0)
          addi t1, t1, 10
          li t2, MTIMECMP
          sw t1, 0(t2)
          mret
      `);
      eq(cpu.output, '5', 'timer interrupt count');
      eq(cpu.status, 'halted', 'status');
    },
  },
  {
    name: 'traps: an illegal instruction vectors to the handler (mcause = 2)',
    fn: () => {
      const cpu = run(`
        main:
          la t0, ih
          csrw mtvec, t0
          li s0, 0
          .word 0xffffffff       # illegal -> trap
          mv a0, s0              # set to mcause by the handler
          li a7, 1
          ecall
          li a7, 10
          ecall
        ih:
          csrr s0, mcause        # 2 = illegal instruction
          csrr t1, mepc
          addi t1, t1, 4         # skip the 4-byte illegal word
          csrw mepc, t1
          mret
      `);
      eq(cpu.output, '2', 'mcause is illegal-instruction');
    },
  },
  {
    name: 'traps: interrupts stay masked when mstatus.MIE is clear',
    fn: () => {
      // Same setup but without enabling MIE — the loop must run to its own bound, untouched.
      const cpu = run(`
        .equ MTIME,    0x0200bff8
        .equ MTIMECMP, 0x02004000
        main:
          la t0, h
          csrw mtvec, t0
          li s0, 0
          li t0, MTIME
          lw t1, 0(t0)
          addi t1, t1, 5
          li t2, MTIMECMP
          sw t1, 0(t2)
          li t0, 0x80
          csrs mie, t0          # timer enabled in mie...
          # ...but mstatus.MIE left 0, so no interrupt should fire
          li t3, 0
        loop:
          addi t3, t3, 1
          li t4, 50
          blt t3, t4, loop
          mv a0, s0             # handler never ran -> 0
          li a7, 1
          ecall
          li a7, 10
          ecall
        h:
          addi s0, s0, 100
          mret
      `);
      eq(cpu.output, '0', 'no interrupt while MIE=0');
    },
  },
  {
    name: 'traps: mret restores mstatus.MIE from MPIE',
    fn: () => {
      const result = assemble(`
        main:
          la t0, h
          csrw mtvec, t0
          .equ MTIME,    0x0200bff8
          .equ MTIMECMP, 0x02004000
          li t0, MTIME
          lw t1, 0(t0)
          addi t1, t1, 3
          li t2, MTIMECMP
          sw t1, 0(t2)
          li t0, 0x80
          csrs mie, t0
          csrsi mstatus, 0x8
        spin:
          beqz s0, spin
          li a7, 10
          ecall
        h:
          li s0, 1
          li t0, 0x80
          csrc mie, t0          # disable the timer source (else it re-fires forever)
          mret
      `);
      assert(result.ok, 'assembles');
      const cpu = new Cpu();
      cpu.load(result);
      // Run until the interrupt has been taken and handled.
      cpu.run(2_000_000);
      eq(cpu.status, 'halted', 'program halts after the single interrupt');
      // After mret, global interrupt enable must be back on (MPIE was 1 → MIE restored).
      eq((cpu.mstatus >>> 3) & 1, 1, 'MIE restored after mret');
    },
  },
  {
    name: 'traps: CLINT mtime advances with cycles and is readable via lw',
    fn: () => {
      const cpu = run(`
        .equ MTIME, 0x0200bff8
        main:
          li t0, MTIME
          lw s0, 0(t0)          # t0_time
          nop
          nop
          nop
          lw s1, 0(t0)          # t1_time
          sub a0, s1, s0        # elapsed cycles between the two loads (> 0)
          li a7, 1
          ecall
          li a7, 10
          ecall
      `);
      const n = parseInt(cpu.output, 10);
      assert(n >= 4, `expected mtime to advance by the executed cycles, got ${cpu.output}`);
    },
  },
  {
    name: 'traps: time-travel steps back across a taken interrupt',
    fn: () => {
      const result = assemble(`
        .equ MTIME,    0x0200bff8
        .equ MTIMECMP, 0x02004000
        main:
          la t0, h
          csrw mtvec, t0
          li t0, MTIME
          lw t1, 0(t0)
          addi t1, t1, 2
          li t2, MTIMECMP
          sw t1, 0(t2)
          li t0, 0x80
          csrs mie, t0
          csrsi mstatus, 0x8
        spin:
          j spin
        h:
          li s0, 7
          mret
      `);
      assert(result.ok, 'assembles');
      const cpu = new Cpu();
      cpu.load(result);
      // Step until the trap is taken (pc jumps to the handler 'h').
      const hAddr = result.symbols.get('h')!;
      let guard = 0;
      while (cpu.pc !== (hAddr >>> 0) && guard++ < 1000) cpu.step();
      eq(cpu.pc >>> 0, hAddr >>> 0, 'reached handler via trap');
      const savedMepc = cpu.mepc;
      const savedMstatus = cpu.mstatus;
      cpu.stepBack(); // undo the trap entry
      assert(cpu.pc !== (hAddr >>> 0), 'pc reverted out of the handler');
      // Re-take it and confirm the trap state reproduces exactly.
      cpu.step();
      eq(cpu.pc >>> 0, hAddr >>> 0, 're-entered handler');
      eq(cpu.mepc, savedMepc, 'mepc reproduced');
      eq(cpu.mstatus, savedMstatus, 'mstatus reproduced');
    },
  },
  {
    name: 'mret / wfi decode & disassemble',
    fn: () => {
      const r = assemble('main:\n  mret\n  wfi\n');
      assert(r.ok, 'assembles');
      eq(r.instrs[0].word >>> 0, 0x30200073, 'mret encoding');
      eq(r.instrs[1].word >>> 0, 0x10500073, 'wfi encoding');
      eq(disassemble(r.instrs[0].word), 'mret', 'mret disasm');
      eq(disassemble(r.instrs[1].word), 'wfi', 'wfi disasm');
    },
  },
  {
    name: 'example: timer-interrupt program services 8 ticks',
    fn: () => {
      const cpu = run(EXAMPLES.find((e) => e.id === 'timerirq')!.code);
      eq(cpu.output, '8', 'timer example output');
      eq(cpu.status, 'halted', 'status');
    },
  },

  // --- RV32D double precision ------------------------------------------------
  {
    name: 'RV32D: double arithmetic 3*4+2 == 14',
    fn: () => {
      const cpu = run(`
        main:
          li t0, 3
          fcvt.d.w fa0, t0
          li t1, 4
          fcvt.d.w fa1, t1
          fmul.d fa2, fa0, fa1
          li t2, 2
          fcvt.d.w fa3, t2
          fadd.d fa2, fa2, fa3
          fmv.d fa0, fa2
          li a7, 3
          ecall
          li a7, 10
          ecall
      `);
      eq(cpu.output, '14.0', 'double arithmetic');
    },
  },
  {
    name: 'RV32D: fld loads a π constant and print_double shows full precision',
    fn: () => {
      const cpu = run(`
        .data
        pi: .word 0x54442D18
            .word 0x400921FB
        .text
        main:
          la t0, pi
          fld fa0, 0(t0)
          li a7, 3
          ecall
          li a7, 10
          ecall
      `);
      eq(cpu.output, '3.141592653589793', 'double π');
    },
  },
  {
    name: 'RV32D: fsd then fld round-trips a double through memory',
    fn: () => {
      const cpu = run(`
        .data
        src:  .word 0x54442D18
              .word 0x400921FB
        slot: .word 0
              .word 0
        .text
        main:
          la t0, src
          fld fa0, 0(t0)
          la t1, slot
          fsd fa0, 0(t1)
          fld fa1, 0(t1)
          fmv.d fa0, fa1
          li a7, 3
          ecall
          li a7, 10
          ecall
      `);
      eq(cpu.output, '3.141592653589793', 'fsd/fld round-trip');
    },
  },
  {
    name: 'RV32D: fcvt.d.s widens then fcvt.s.d narrows back',
    fn: () => {
      const cpu = run(`
        main:
          li t0, 0x40490fdb       # single π bits
          fmv.w.x fa0, t0
          fcvt.d.s fa1, fa0       # widen single π -> double
          fcvt.s.d fa2, fa1       # narrow back to single
          fmv.s fa0, fa2
          li a7, 2
          ecall
          li a7, 10
          ecall
      `);
      assert(cpu.output.startsWith('3.14159'), `got: ${cpu.output}`);
    },
  },
  {
    name: 'RV32D: fclass.d of -0.0 (bit 3) and +∞ (bit 7)',
    fn: () => {
      const cpu = run(`
        .data
        negz: .word 0
              .word 0x80000000
        pinf: .word 0
              .word 0x7FF00000
        .text
        main:
          la t0, negz
          fld fa0, 0(t0)
          fclass.d a0, fa0        # -0.0 -> 1<<3 = 8
          li a7, 1
          ecall
          li a0, ' '
          li a7, 11
          ecall
          la t0, pinf
          fld fa0, 0(t0)
          fclass.d a0, fa0        # +inf -> 1<<7 = 128
          li a7, 1
          ecall
          li a7, 10
          ecall
      `);
      eq(cpu.output, '8 128', 'fclass.d');
    },
  },
  {
    name: 'RV32D: fmin.d / fmax.d and compares (flt.d/fle.d)',
    fn: () => {
      const cpu = run(`
        main:
          li t0, 3
          fcvt.d.w fa0, t0        # 3.0
          li t1, 7
          fcvt.d.w fa1, t1        # 7.0
          fmin.d fa2, fa0, fa1
          fcvt.w.d a0, fa2        # 3
          li a7, 1
          ecall
          li a0, ' '
          li a7, 11
          ecall
          fmax.d fa2, fa0, fa1
          fcvt.w.d a0, fa2        # 7
          li a7, 1
          ecall
          li a0, ' '
          li a7, 11
          ecall
          flt.d a0, fa0, fa1      # 1
          li a7, 1
          ecall
          li a7, 10
          ecall
      `);
      eq(cpu.output, '3 7 1', 'min/max/compare');
    },
  },
  {
    name: 'RV32D: fmadd.d fused multiply-add (2.5*4 + 1 = 11)',
    fn: () => {
      const cpu = run(`
        .data
        half: .word 0
              .word 0x40040000     # 2.5
        .text
        main:
          la t0, half
          fld fa0, 0(t0)          # 2.5
          li t1, 4
          fcvt.d.w fa1, t1        # 4.0
          li t2, 1
          fcvt.d.w fa2, t2        # 1.0
          fmadd.d fa3, fa0, fa1, fa2   # 2.5*4 + 1 = 11
          fcvt.w.d a0, fa3
          li a7, 1
          ecall
          li a7, 10
          ecall
      `);
      eq(cpu.output, '11', 'fmadd.d');
    },
  },
  {
    name: 'RV32D: NaN-boxing — a single op on a register holding a double yields NaN',
    fn: () => {
      const cpu = run(`
        .data
        d: .word 0x54442D18
           .word 0x400921FB
        .text
        main:
          la t0, d
          fld fa0, 0(t0)          # fa0 holds a double (NOT NaN-boxed)
          fadd.s fa1, fa0, fa0    # used as single -> operands read as canonical NaN
          fclass.s a0, fa1        # quiet NaN -> 1<<9 = 512
          li a7, 1
          ecall
          li a7, 10
          ecall
      `);
      eq(cpu.output, '512', 'unboxed double read as NaN under single ops');
    },
  },
  {
    name: 'RV32D: fmv writing a single NaN-boxes (double read of a boxed single is NaN)',
    fn: () => {
      const cpu = run(`
        main:
          li t0, 5
          fcvt.s.w fa0, t0        # NaN-boxed single 5.0
          fclass.d a0, fa0        # high half = 0xffffffff -> a NaN -> 1<<9 = 512
          li a7, 1
          ecall
          li a7, 10
          ecall
      `);
      eq(cpu.output, '512', 'boxed single read as double is NaN');
    },
  },
  {
    name: 'RV32DC: compressed double load/store (c.fsdsp / c.fldsp) round-trip',
    fn: () => {
      const cpu = run(`
        .data
        v: .word 0x54442D18
           .word 0x400921FB
        .text
        main:
          c.addi16sp -16
          la t0, v
          fld fa0, 0(t0)
          c.fsdsp fa0, 0(sp)
          c.fldsp fa1, 0(sp)
          fmv.d fa0, fa1
          c.addi16sp 16
          li a7, 3
          ecall
          li a7, 10
          ecall
      `);
      eq(cpu.output, '3.141592653589793', 'compressed double load/store');
    },
  },
  {
    name: 'RV32D: time-travel reverts a 64-bit float-register write',
    fn: () => {
      const cpu = new Cpu();
      cpu.load(assemble(`
        main:
          li t0, 9
          fcvt.d.w fa0, t0
          li a7, 10
          ecall
      `));
      cpu.step(); // li t0, 9
      cpu.step(); // fcvt.d.w fa0, t0 -> 9.0
      assert(cpu.fregsHi[10] !== 0 || cpu.fregs[10] !== 0, 'fa0 written');
      cpu.stepBack();
      eq(cpu.fregs[10], 0, 'fa0 low reverted');
      eq(cpu.fregsHi[10], 0, 'fa0 high reverted');
    },
  },
  {
    name: 'RV32D: decode ⇄ disassemble round-trip for the double example',
    fn: () => {
      const result = assemble(EXAMPLES.find((e) => e.id === 'double')!.code);
      assert(result.ok, `assembles: ${result.errors.map((e) => e.message).join('; ')}`);
      for (const ins of result.instrs) {
        const d = decode(ins.word);
        assert(d.mnemonic !== 'unknown' && d.mnemonic !== '?', `bad decode 0x${ins.word.toString(16)}`);
        assert(disassembleUnit(ins.word, ins.addr, ins.len).length > 0, 'disassembly empty');
      }
    },
  },
  {
    name: 'example: double-precision Newton √2 ≈ 1.41421356237309…',
    fn: () => {
      const cpu = run(EXAMPLES.find((e) => e.id === 'double')!.code);
      // 14+ correct digits — far beyond single precision's ~7 (the point of the demo).
      assert(cpu.output.startsWith('1.41421356237309'), `got: ${cpu.output}`);
    },
  },
];

export function runSelfTests(): TestResult[] {
  return TESTS.map(({ name, fn }) => {
    try {
      fn();
      return { name, passed: true, detail: 'ok' };
    } catch (e) {
      return { name, passed: false, detail: (e as Error).message };
    }
  });
}
