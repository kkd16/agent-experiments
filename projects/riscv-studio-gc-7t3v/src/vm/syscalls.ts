// Environment calls (`ecall`), following the RARS / MARS convention: the syscall number
// is in a7 (x17) and the primary argument in a0 (x10). This is what real teaching-oriented
// RISC-V assembly targets, so example programs written elsewhere run here unchanged.

import type { Cpu } from './cpu';
import { toHex } from './format';
import { f32FromBits } from './fp';

export interface Syscall {
  readonly id: number;
  readonly name: string;
  readonly summary: string;
}

/** Documented syscalls, surfaced on the ISA reference page. */
export const SYSCALLS: readonly Syscall[] = [
  { id: 1, name: 'print_int', summary: 'print a0 as a signed decimal integer' },
  { id: 2, name: 'print_float', summary: 'print fa0 as a single-precision float' },
  { id: 4, name: 'print_string', summary: 'print the NUL-terminated string at address a0' },
  { id: 11, name: 'print_char', summary: 'print the low byte of a0 as a character' },
  { id: 34, name: 'print_hex', summary: 'print a0 as 0x-prefixed 8-digit hex' },
  { id: 35, name: 'print_bin', summary: 'print a0 as a 32-bit binary string' },
  { id: 36, name: 'print_uint', summary: 'print a0 as an unsigned decimal integer' },
  { id: 9, name: 'sbrk', summary: 'grow the heap by a0 bytes; returns the old break in a0' },
  { id: 30, name: 'time_ms', summary: 'wall-clock milliseconds → a0 (low), a1 (high)' },
  { id: 41, name: 'rand_int', summary: 'a0 ← a pseudo-random 32-bit integer' },
  { id: 42, name: 'rand_range', summary: 'a0 ← a pseudo-random integer in [0, a1)' },
  { id: 10, name: 'exit', summary: 'halt the program' },
  { id: 93, name: 'exit2', summary: 'halt the program with exit code a0' },
];

const A0 = 10;
const A1 = 11;
const A7 = 17;
const FA0 = 10;

export type EcallResult = 'continue' | 'halt';

/** Render a single-precision float compactly: integral values keep a trailing `.0`. */
function formatFloat(x: number): string {
  if (Number.isNaN(x)) return 'nan';
  if (x === Infinity) return 'inf';
  if (x === -Infinity) return '-inf';
  if (Number.isInteger(x)) return `${x}.0`;
  // ~7 significant digits is the single-precision sweet spot.
  return String(Number(x.toPrecision(7)));
}

/** Service an `ecall`. Mutates the CPU (output / exit) and reports whether to keep running. */
export function handleEcall(cpu: Cpu): EcallResult {
  const which = cpu.regs[A7] | 0;
  const a0 = cpu.regs[A0] | 0;
  switch (which) {
    case 1:
      cpu.print(String(a0 | 0));
      return 'continue';
    case 2:
      cpu.print(formatFloat(f32FromBits(cpu.fregs[FA0])));
      return 'continue';
    case 4:
      cpu.print(cpu.mem.readCString(a0 >>> 0));
      return 'continue';
    case 11:
      cpu.print(String.fromCharCode(a0 & 0xff));
      return 'continue';
    case 34:
      cpu.print(`0x${toHex(a0, 8)}`);
      return 'continue';
    case 35:
      cpu.print((a0 >>> 0).toString(2).padStart(32, '0'));
      return 'continue';
    case 36:
      cpu.print(String(a0 >>> 0));
      return 'continue';
    case 9: {
      // Bump-allocator heap: return the old break, then grow it.
      const old = cpu.heapPtr >>> 0;
      cpu.heapPtr = (cpu.heapPtr + (a0 | 0)) >>> 0;
      cpu.regs[A0] = old | 0;
      return 'continue';
    }
    case 30: {
      const ms = Date.now();
      cpu.regs[A0] = ms >>> 0 | 0;
      cpu.regs[A1] = Math.floor(ms / 0x1_0000_0000) | 0;
      return 'continue';
    }
    case 41:
      cpu.regs[A0] = (cpu.nextRandom() >>> 0) | 0;
      return 'continue';
    case 42: {
      const bound = cpu.regs[A1] >>> 0;
      cpu.regs[A0] = bound === 0 ? 0 : (cpu.nextRandom() >>> 0) % bound | 0;
      return 'continue';
    }
    case 10:
      cpu.exitCode = 0;
      return 'halt';
    case 93:
      cpu.exitCode = a0 | 0;
      return 'halt';
    default:
      cpu.fail(`unknown ecall #${which} (a7=${which})`);
      return 'halt';
  }
}
