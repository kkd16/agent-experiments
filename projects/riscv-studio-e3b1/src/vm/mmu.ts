// Sv32 virtual memory: constants, page-table-entry / virtual-address bit helpers, the
// translation-lookaside-buffer entry shape, and the page-fault sentinel.
//
// Sv32 is the RV32 paging scheme: a 32-bit virtual address is translated through a two-level
// radix tree of 4 KiB page tables to a (nominally 34-bit) physical address. This machine has a
// 32-bit physical space, so the composed physical address is wrapped to 32 bits — megapages and
// pages whose PPN fits in 20 bits behave exactly as hardware; only frames above 4 GiB are
// unreachable. The walker, permission model and A/D updates live in `cpu.ts` (they need live
// machine state); everything purely about the *encoding* lives here so the two stay in lock-step.

/** `satp.MODE` value selecting Sv32 paging (bit 31). MODE 0 is Bare = no translation. */
export const SATP_MODE_SV32 = 1;

/** Page geometry. */
export const PAGE_SHIFT = 12;
export const PAGE_SIZE = 1 << PAGE_SHIFT; // 4096
export const PAGE_MASK = PAGE_SIZE - 1;
/** Sv32 has two levels of page table (level 1 = megapage, level 0 = 4 KiB page). */
export const SV32_LEVELS = 2;

// Page-table-entry permission/status bits.
export const PTE_V = 1 << 0; // valid
export const PTE_R = 1 << 1; // readable
export const PTE_W = 1 << 2; // writable
export const PTE_X = 1 << 3; // executable
export const PTE_U = 1 << 4; // user-accessible
export const PTE_G = 1 << 5; // global (ignored by this single-ASID TLB)
export const PTE_A = 1 << 6; // accessed
export const PTE_D = 1 << 7; // dirty
/** The low 8 status/permission bits, the slice the TLB caches. */
export const PTE_FLAGS_MASK = 0xff;

/** Access classes that drive translation, permission checks and fault causes. */
export const ACCESS_FETCH = 0;
export const ACCESS_LOAD = 1;
export const ACCESS_STORE = 2;
export type Access = typeof ACCESS_FETCH | typeof ACCESS_LOAD | typeof ACCESS_STORE;

/** Synchronous page-fault exception cause per access class (fetch/load/store-or-AMO). */
export const PAGE_FAULT_CAUSE: Record<Access, number> = {
  [ACCESS_FETCH]: 12,
  [ACCESS_LOAD]: 13,
  [ACCESS_STORE]: 15,
};

/** Privilege rings. (There is no H/reserved ring 2 in this machine.) Typed `number` so the
 *  interpreter can compare freely without literal-type narrowing tripping the checker. */
export const PRIV_U: number = 0;
export const PRIV_S: number = 1;
export const PRIV_M: number = 3;

export function satpMode(satp: number): number {
  return (satp >>> 31) & 1;
}
/** Root page-table physical page number — the low 22 bits of `satp`. */
export function satpRootPpn(satp: number): number {
  return satp & 0x003f_ffff;
}
/** Extract the 10-bit virtual page number for a given level (1 = high, 0 = low). */
export function vpn(vaddr: number, level: number): number {
  return level === 1 ? (vaddr >>> 22) & 0x3ff : (vaddr >>> 12) & 0x3ff;
}

/** A cached leaf translation. Permissions are re-checked per access against live SUM/MXR/priv. */
export interface TlbEntry {
  /** Full 22-bit physical page number of the leaf (used for 4 KiB pages). */
  ppn: number;
  /** High 12-bit PPN field — the frame base of a 4 MiB megapage. */
  ppn1: number;
  /** Tree level the leaf was found at: 0 = 4 KiB page, 1 = 4 MiB megapage. */
  level: number;
  /** The cached low-8 PTE permission/status bits (A/D kept in sync on update). */
  flags: number;
  /** Physical address of the PTE itself, so A/D updates can write it back. */
  pteAddr: number;
}

/** One visited page-table entry in a read-only walk (for the UI's translation tracer). */
export interface TranslationStep {
  level: number;
  pteAddr: number;
  pte: number;
  kind: 'pointer' | 'leaf' | 'invalid';
}

/** The result of a non-mutating Sv32 walk used by the inspector. */
export interface TranslationTrace {
  vaddr: number;
  paging: boolean;
  effPriv: number;
  steps: TranslationStep[];
  physical: number | null;
  fault: number | null;
}

/** Thrown by the translator on a structural or permission fault; caught in `Cpu.step`. */
export class PageFault {
  readonly cause: number;
  readonly vaddr: number;
  constructor(cause: number, vaddr: number) {
    this.cause = cause;
    this.vaddr = vaddr;
  }
}
