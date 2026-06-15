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
import { disassemble } from './disassembler';

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

  // --- RV32C: the compressed extension ---------------------------------------
  {
    name: 'RVC: hand-written compressed program prints 210 (sum 1..20)',
    fn: () => {
      const cpu = run(EXAMPLES.find((e) => e.id === 'rvc')!.code);
      eq(cpu.output, 'sum 1..20 = 210', 'output');
      eq(cpu.status, 'halted', 'status');
    },
  },
  {
    name: 'RVC: c.* instructions assemble to 2 bytes and step the pc by 2',
    fn: () => {
      const result = assemble(`main:\n  c.li a0, 5\n  c.addi a0, 3\n  c.mv a1, a0\n  li a7, 10\n  ecall\n`);
      assert(result.ok, `assembles: ${result.errors.map((e) => e.message).join('; ')}`);
      // The three c.* instructions are 2 bytes each at 0,2,4; the 32-bit li lands at 6.
      eq(result.instrs[0].size, 2, 'c.li size');
      eq(result.instrs[0].addr, 0, 'c.li addr');
      eq(result.instrs[1].addr, 2, 'c.addi addr');
      eq(result.instrs[2].addr, 4, 'c.mv addr');
      eq(result.instrs[3].addr, 6, 'li addr (after three halfwords)');
      const cpu = new Cpu();
      cpu.load(result);
      cpu.step(); // c.li a0,5
      eq(cpu.pc, 2, 'pc advanced by 2');
      eq(cpu.regs[10], 5, 'a0=5');
      cpu.step(); // c.addi a0,3 -> 8
      cpu.step(); // c.mv a1,a0 -> 8
      eq(cpu.regs[10], 8, 'a0=8');
      eq(cpu.regs[11], 8, 'a1=8 via c.mv');
    },
  },
  {
    name: 'RVC: c.jal links the *next 2-byte* address (return = pc+2)',
    fn: () => {
      // c.jal must write pc+2 to ra so the callee returns to the following 16-bit slot.
      const result = assemble(`main:\n  c.jal sub\n  c.li a0, 7\n  li a7, 1\n  ecall\n  li a7, 10\n  ecall\nsub:\n  c.jr ra\n`);
      assert(result.ok, `assembles: ${result.errors.map((e) => e.message).join('; ')}`);
      const cpu = new Cpu();
      cpu.load(result);
      cpu.step(); // c.jal sub  (ra = 2)
      eq(cpu.regs[1], 2, 'ra = pc+2');
      cpu.step(); // c.jr ra -> back to 0x2
      eq(cpu.pc, 2, 'returned to the c.li slot');
    },
  },
  {
    name: 'RVC auto-compress: identical behaviour, smaller binary',
    fn: () => {
      const prog = EXAMPLES.find((e) => e.id === 'fib')!.code;
      const plain = assemble(prog, { compress: false });
      const small = assemble(prog, { compress: true });
      assert(plain.ok && small.ok, 'both assemble');
      const cpuA = new Cpu();
      cpuA.load(plain);
      cpuA.run(1_000_000);
      const cpuB = new Cpu();
      cpuB.load(small);
      cpuB.run(1_000_000);
      eq(cpuB.output, cpuA.output, 'output matches the uncompressed build');
      const bytesA = plain.instrs.reduce((s, i) => s + i.size, 0);
      const bytesB = small.instrs.reduce((s, i) => s + i.size, 0);
      assert(bytesB < bytesA, `expected a smaller image, got ${bytesB} vs ${bytesA}`);
      assert(small.instrs.some((i) => i.size === 2), 'at least one instruction compressed');
    },
  },
  {
    name: 'RVC: every compressed encoding ⇄ disassembles to a c.* form',
    fn: () => {
      const result = assemble(EXAMPLES.find((e) => e.id === 'rvc')!.code, { compress: true });
      assert(result.ok, 'assembles');
      let sawCompressed = false;
      for (const ins of result.instrs) {
        const text = disassemble(ins.word, ins.addr, ins.size);
        assert(text.length > 0 && !text.startsWith('.half') && !text.startsWith('.word'), `bad disasm: ${text}`);
        if (ins.size === 2) {
          sawCompressed = true;
          assert(text.startsWith('c.'), `compressed word should render as c.*, got '${text}'`);
        }
      }
      assert(sawCompressed, 'expected compressed instructions');
    },
  },

  // --- machine-mode traps & interrupts ---------------------------------------
  {
    name: 'trap: the timer-interrupt example fires 5 ticks and prints 5',
    fn: () => {
      const cpu = run(EXAMPLES.find((e) => e.id === 'timer')!.code);
      eq(cpu.output, '5\n', 'output');
      eq(cpu.status, 'halted', 'status');
    },
  },
  {
    name: 'trap: software interrupt (CLINT msip) vectors to the handler',
    fn: () => {
      const cpu = run(`
        .equ MSIP, 0x02000000
        main:
          la    t0, h
          csrw  mtvec, t0
          li    s0, 0
          li    t1, 0x8          # mie.MSIE
          csrs  mie, t1
          csrsi mstatus, 0x8
          li    t2, MSIP
          li    t0, 1
          sw    t0, 0(t2)        # raise the software interrupt
          nop
          csrci mstatus, 0x8
          mv    a0, s0
          li    a7, 1
          ecall
          li    a7, 10
          ecall
        .align 2
        h:
          addi  s0, s0, 7
          sw    x0, 0(t2)        # clear msip
          mret
      `);
      eq(cpu.output, '7', 'handler ran');
    },
  },
  {
    name: 'trap: ebreak vectors to mtvec when a handler is armed; mcause = 3',
    fn: () => {
      const cpu = run(`
        main:
          la   t0, h
          csrw mtvec, t0
          ebreak
          li   a7, 10
          ecall
        .align 2
        h:
          csrr a0, mcause       # breakpoint cause = 3
          li   a7, 1
          ecall
          csrr t1, mepc
          addi t1, t1, 4        # step over the ebreak
          csrw mepc, t1
          li   a7, 10
          ecall
      `);
      eq(cpu.output, '3', 'mcause = 3');
    },
  },
  {
    name: 'trap: illegal instruction vectors to mtvec (mcause = 2) instead of erroring',
    fn: () => {
      // 0x00000000 is an illegal word; with a handler armed it must trap, not fail.
      const cpu = run(`
        .text
        main:
          la   t0, h
          csrw mtvec, t0
          .word 0               # illegal instruction
          li   a7, 10
          ecall
        .align 2
        h:
          csrr a0, mcause       # illegal-instruction cause = 2
          li   a7, 1
          ecall
          li   a7, 10
          ecall
      `);
      eq(cpu.output, '2', 'mcause = 2');
      eq(cpu.status, 'halted', 'did not error out');
    },
  },
  {
    name: 'trap: mret restores the interrupt-enable stack (MIE ← MPIE)',
    fn: () => {
      const result = assemble(`
        main:
          la   t0, h
          csrw mtvec, t0
          li   t1, 0x80
          csrs mie, t1
          csrsi mstatus, 0x8    # MIE = 1
          ebreak                # synchronous trap clears MIE, sets MPIE
          li   a7, 10
          ecall
        .align 2
        h:
          mret
      `);
      assert(result.ok, 'assembles');
      const cpu = new Cpu();
      cpu.load(result);
      // Run up to (but not into) the handler so we can inspect mstatus inside the trap.
      while (cpu.status !== 'halted' && cpu.cycles < 1000) {
        const before = cpu.pc;
        cpu.step();
        // After ebreak traps, MIE must be 0 and MPIE must be 1.
        if (cpu.mcause === 3 && before !== cpu.pc) {
          eq(cpu.mstatus & (1 << 3), 0, 'MIE cleared on trap');
          assert((cpu.mstatus & (1 << 7)) !== 0, 'MPIE set on trap');
          break;
        }
      }
      // mret then restores MIE from MPIE.
      cpu.step(); // mret
      assert((cpu.mstatus & (1 << 3)) !== 0, 'MIE restored after mret');
    },
  },
  {
    name: 'time-travel: stepBack reverts mtime and machine CSRs',
    fn: () => {
      const result = assemble(`main:\n  csrwi mstatus, 0x8\n  li a7, 10\n  ecall\n`);
      assert(result.ok, 'assembles');
      const cpu = new Cpu();
      cpu.load(result);
      const t0 = cpu.mtime;
      cpu.step(); // csrwi mstatus, 0x8
      assert((cpu.mstatus & 0x8) !== 0, 'mstatus.MIE set');
      assert(cpu.mtime > t0, 'mtime advanced');
      cpu.stepBack();
      eq(cpu.mstatus, 0, 'mstatus reverted');
      eq(cpu.mtime, t0, 'mtime reverted');
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
