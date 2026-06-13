// Environment calls (`ecall`), following the RARS / MARS convention: the syscall number
// is in a7 (x17) and the primary argument in a0 (x10). This is what real teaching-oriented
// RISC-V assembly targets, so example programs written elsewhere run here unchanged.

import type { Cpu } from './cpu';
import { toHex } from './format';

export interface Syscall {
  readonly id: number;
  readonly name: string;
  readonly summary: string;
}

/** Documented syscalls, surfaced on the ISA reference page. */
export const SYSCALLS: readonly Syscall[] = [
  { id: 1, name: 'print_int', summary: 'print a0 as a signed decimal integer' },
  { id: 4, name: 'print_string', summary: 'print the NUL-terminated string at address a0' },
  { id: 11, name: 'print_char', summary: 'print the low byte of a0 as a character' },
  { id: 34, name: 'print_hex', summary: 'print a0 as 0x-prefixed 8-digit hex' },
  { id: 35, name: 'print_bin', summary: 'print a0 as a 32-bit binary string' },
  { id: 36, name: 'print_uint', summary: 'print a0 as an unsigned decimal integer' },
  { id: 10, name: 'exit', summary: 'halt the program' },
  { id: 93, name: 'exit2', summary: 'halt the program with exit code a0' },
];

const A0 = 10;
const A7 = 17;

export type EcallResult = 'continue' | 'halt';

/** Service an `ecall`. Mutates the CPU (output / exit) and reports whether to keep running. */
export function handleEcall(cpu: Cpu): EcallResult {
  const which = cpu.regs[A7] | 0;
  const a0 = cpu.regs[A0] | 0;
  switch (which) {
    case 1:
      cpu.print(String(a0 | 0));
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
