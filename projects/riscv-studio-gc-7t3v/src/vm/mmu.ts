// The privileged architecture: privilege levels, the Sv32 page-table format, and the
// pure pieces of address translation. The live walk (which needs the CPU's physical
// memory) lives in cpu.ts; everything here is data + pure decoders so the MMU inspector
// and the self-tests can reason about translation without a running machine.

import { hexWord } from './format';

// --- privilege levels ------------------------------------------------------
export const PRIV_U = 0;
export const PRIV_S = 1;
export const PRIV_M = 3;

export function privName(p: number): string {
  return p === PRIV_M ? 'M' : p === PRIV_S ? 'S' : p === PRIV_U ? 'U' : '?';
}
export function privLong(p: number): string {
  return p === PRIV_M ? 'Machine' : p === PRIV_S ? 'Supervisor' : p === PRIV_U ? 'User' : 'unknown';
}

// --- trap causes (mcause / scause, interrupt bit cleared) ------------------
export const CAUSE = {
  ILLEGAL: 2,
  ECALL_U: 8,
  ECALL_S: 9,
  ECALL_M: 11,
  INST_PAGE_FAULT: 12,
  LOAD_PAGE_FAULT: 13,
  STORE_PAGE_FAULT: 15,
} as const;

// --- interrupt causes (the cause code with mcause/scause bit 31 set) -------
// Bit positions in mip/mie double as the interrupt cause codes.
export const IRQ = {
  S_SOFT: 1,
  M_SOFT: 3,
  S_TIMER: 5,
  M_TIMER: 7,
  S_EXT: 9,
  M_EXT: 11,
} as const;

/** mip/mie field bits (one per interrupt; the bit index *is* the cause code). */
export const MIP = {
  SSIP: 1 << IRQ.S_SOFT,
  MSIP: 1 << IRQ.M_SOFT,
  STIP: 1 << IRQ.S_TIMER,
  MTIP: 1 << IRQ.M_TIMER,
  SEIP: 1 << IRQ.S_EXT,
  MEIP: 1 << IRQ.M_EXT,
} as const;

/**
 * The order interrupts are serviced when several are pending at once (RISC-V privileged spec):
 * external before software before timer, machine before supervisor. The first takeable cause
 * in this list wins.
 */
export const INT_PRIORITY: readonly number[] = [
  IRQ.M_EXT, IRQ.M_SOFT, IRQ.M_TIMER, IRQ.S_EXT, IRQ.S_SOFT, IRQ.S_TIMER,
];

/** Human-readable name for an interrupt cause code (mcause/scause with bit 31 set). */
export function interruptName(code: number): string {
  switch (code) {
    case IRQ.S_SOFT: return 'supervisor software interrupt';
    case IRQ.M_SOFT: return 'machine software interrupt';
    case IRQ.S_TIMER: return 'supervisor timer interrupt';
    case IRQ.M_TIMER: return 'machine timer interrupt';
    case IRQ.S_EXT: return 'supervisor external interrupt';
    case IRQ.M_EXT: return 'machine external interrupt';
    default: return `interrupt ${code}`;
  }
}

/** Decode any mcause/scause value (the interrupt bit selects the namespace). */
export function mcauseName(code: number): string {
  return (code & 0x8000_0000) !== 0 ? interruptName(code & 0x7fff_ffff) : causeName(code & 0x7fff_ffff);
}

/** Human-readable name for a synchronous exception cause code. */
export function causeName(code: number): string {
  switch (code) {
    case 0: return 'instruction address misaligned';
    case 2: return 'illegal instruction';
    case 3: return 'breakpoint';
    case 8: return 'ecall from U-mode';
    case 9: return 'ecall from S-mode';
    case 11: return 'ecall from M-mode';
    case 12: return 'instruction page fault';
    case 13: return 'load page fault';
    case 15: return 'store/AMO page fault';
    default: return `exception ${code}`;
  }
}

// --- mstatus / sstatus field bits ------------------------------------------
export const MSTATUS = {
  SIE: 1 << 1,
  MIE: 1 << 3,
  SPIE: 1 << 5,
  MPIE: 1 << 7,
  SPP: 1 << 8,
  MPP: 3 << 11,
  MPRV: 1 << 17,
  SUM: 1 << 18,
  MXR: 1 << 19,
  TVM: 1 << 20, // trap satp access + sfence.vma in S-mode
  TW: 1 << 21, // trap wfi below M-mode
  TSR: 1 << 22, // trap sret in S-mode
} as const;

/** Every mstatus bit this machine models — the writable mask for the CSR. */
export const MSTATUS_MASK =
  MSTATUS.SIE | MSTATUS.MIE | MSTATUS.SPIE | MSTATUS.MPIE | MSTATUS.SPP | MSTATUS.MPP |
  MSTATUS.MPRV | MSTATUS.SUM | MSTATUS.MXR | MSTATUS.TVM | MSTATUS.TW | MSTATUS.TSR;

/** The subset of mstatus visible through (and writable via) the sstatus alias. */
export const SSTATUS_MASK = MSTATUS.SIE | MSTATUS.SPIE | MSTATUS.SPP | MSTATUS.SUM | MSTATUS.MXR;

/** Supervisor-visible interrupt bits for the sie/sip aliases (SSI=1, STI=5, SEI=9). */
export const S_INT_MASK = (1 << 1) | (1 << 5) | (1 << 9);

// --- CSR address encoding (privilege + writability live in the number) -----
// A CSR address encodes its access policy: bits [9:8] = lowest privilege that may access it,
// and bits [11:10] = 11 means read-only (no instruction may write it).
/** Lowest privilege level allowed to access a CSR, from its address. */
export function csrMinPriv(addr: number): number {
  return (addr >>> 8) & 3;
}
/** Whether a CSR address denotes a read-only register (writes are illegal). */
export function csrIsReadOnly(addr: number): boolean {
  return ((addr >>> 10) & 3) === 3;
}

// --- satp + Sv32 page-table entries ----------------------------------------
export const SATP_MODE_SV32 = 0x8000_0000; // MODE = 1 in bit 31

export const PTE = {
  V: 1 << 0,
  R: 1 << 1,
  W: 1 << 2,
  X: 1 << 3,
  U: 1 << 4,
  G: 1 << 5,
  A: 1 << 6,
  D: 1 << 7,
} as const;

export const PAGESIZE = 4096;
export const PAGE_SHIFT = 12;
export const MEGAPAGE_SHIFT = 22; // a level-1 leaf maps 4 MiB

export interface SatpFields {
  mode: number; // 0 = Bare, 1 = Sv32
  asid: number;
  ppn: number;
  rootBase: number; // ppn << 12, the physical base of the root page table
}

export function decodeSatp(satp: number): SatpFields {
  const mode = (satp >>> 31) & 1;
  const asid = (satp >>> 22) & 0x1ff;
  const ppn = satp & 0x3f_ffff;
  return { mode, asid, ppn, rootBase: (ppn * PAGESIZE) >>> 0 };
}

export interface PteFields {
  raw: number;
  v: boolean;
  r: boolean;
  w: boolean;
  x: boolean;
  u: boolean;
  g: boolean;
  a: boolean;
  d: boolean;
  ppn: number; // bits [31:10] of the PTE: the 22-bit physical page number
  leaf: boolean; // a leaf maps memory (R or X set); a branch points at the next level
}

export function decodePte(raw: number): PteFields {
  const v = (raw & PTE.V) !== 0;
  const r = (raw & PTE.R) !== 0;
  const w = (raw & PTE.W) !== 0;
  const x = (raw & PTE.X) !== 0;
  return {
    raw: raw >>> 0,
    v,
    r,
    w,
    x,
    u: (raw & PTE.U) !== 0,
    g: (raw & PTE.G) !== 0,
    a: (raw & PTE.A) !== 0,
    d: (raw & PTE.D) !== 0,
    ppn: (raw >>> 10) & 0x3f_ffff,
    leaf: r || x,
  };
}

/** A compact `rwx`/`U`/`AD` flag string for the inspector, e.g. `V R W X · U · AD`. */
export function pteFlagString(p: PteFields): string {
  const f = (on: boolean, ch: string) => (on ? ch : '·');
  return `${f(p.v, 'V')}${f(p.r, 'R')}${f(p.w, 'W')}${f(p.x, 'X')}${f(p.u, 'U')}${f(p.g, 'G')}${f(p.a, 'A')}${f(p.d, 'D')}`;
}

export type Access = 'fetch' | 'load' | 'store';

/** The page-fault cause for a given access kind. */
export function pageFaultCause(access: Access): number {
  return access === 'fetch'
    ? CAUSE.INST_PAGE_FAULT
    : access === 'load'
      ? CAUSE.LOAD_PAGE_FAULT
      : CAUSE.STORE_PAGE_FAULT;
}

/** One level of a recorded Sv32 walk, for the MMU inspector's step-through view. */
export interface WalkLevel {
  level: number; // 1 then 0
  vpn: number; // the index into this level's table
  pteAddr: number; // physical address of the PTE read
  pte: PteFields;
}

/** The full result of probing a virtual address through the page tables (no side effects). */
export interface WalkTrace {
  va: number;
  access: Access;
  active: boolean; // false → translation is off (Bare / wrong privilege); pa === va
  vpn1: number;
  vpn0: number;
  offset: number;
  levels: WalkLevel[];
  pa?: number; // present iff the walk + permission check succeeded
  fault?: number; // a page-fault cause code, if it failed
  reason?: string; // a human-readable explanation for the inspector
}

/** Decompose a virtual address into its Sv32 fields, formatted for display. */
export function splitVa(va: number): { vpn1: string; vpn0: string; offset: string } {
  return {
    vpn1: ((va >>> 22) & 0x3ff).toString(),
    vpn0: ((va >>> 12) & 0x3ff).toString(),
    offset: '0x' + (va & 0xfff).toString(16),
  };
}

export { hexWord };
