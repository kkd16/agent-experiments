// The 32 integer registers and their ABI names.
//
// RISC-V defines x0..x31. x0 is hard-wired to zero. The assembler accepts both the
// raw `xN` form and the ABI mnemonics (`sp`, `ra`, `a0`, `t0`, …), which is what real
// assembly is written in.

export const REG_COUNT = 32;

/** ABI name for each register index, e.g. ABI_NAMES[2] === 'sp'. */
export const ABI_NAMES: readonly string[] = [
  'zero', 'ra', 'sp', 'gp', 'tp', 't0', 't1', 't2',
  's0', 's1', 'a0', 'a1', 'a2', 'a3', 'a4', 'a5',
  'a6', 'a7', 's2', 's3', 's4', 's5', 's6', 's7',
  's8', 's9', 's10', 's11', 't3', 't4', 't5', 't6',
];

/** A one-line role description per register, surfaced in the register inspector. */
export const REG_ROLES: readonly string[] = [
  'hard-wired zero', 'return address', 'stack pointer', 'global pointer',
  'thread pointer', 'temporary', 'temporary', 'temporary',
  'saved / frame ptr', 'saved', 'arg / return 0', 'arg / return 1',
  'argument', 'argument', 'argument', 'argument',
  'argument', 'syscall number', 'saved', 'saved',
  'saved', 'saved', 'saved', 'saved',
  'saved', 'saved', 'saved', 'saved',
  'temporary', 'temporary', 'temporary', 'temporary',
];

const NAME_TO_INDEX: Map<string, number> = (() => {
  const m = new Map<string, number>();
  for (let i = 0; i < REG_COUNT; i++) {
    m.set(`x${i}`, i);
    m.set(ABI_NAMES[i], i);
  }
  // `fp` is an alias for s0 / x8.
  m.set('fp', 8);
  return m;
})();

/** Resolve a register token (`x5`, `t0`, `sp`, `fp`) to its index, or -1 if invalid. */
export function regIndex(token: string): number {
  const i = NAME_TO_INDEX.get(token.trim().toLowerCase());
  return i === undefined ? -1 : i;
}

/** Canonical display label, e.g. `x10 / a0`. */
export function regLabel(i: number): string {
  return `x${i}/${ABI_NAMES[i]}`;
}

// ---------------------------------------------------------------------------
// Floating-point registers (RV32F): f0..f31 with their own ABI names.
// ---------------------------------------------------------------------------

/** ABI name for each float register index, e.g. FREG_ABI_NAMES[10] === 'fa0'. */
export const FREG_ABI_NAMES: readonly string[] = [
  'ft0', 'ft1', 'ft2', 'ft3', 'ft4', 'ft5', 'ft6', 'ft7',
  'fs0', 'fs1', 'fa0', 'fa1', 'fa2', 'fa3', 'fa4', 'fa5',
  'fa6', 'fa7', 'fs2', 'fs3', 'fs4', 'fs5', 'fs6', 'fs7',
  'fs8', 'fs9', 'fs10', 'fs11', 'ft8', 'ft9', 'ft10', 'ft11',
];

/** One-line role per float register, surfaced in the float inspector. */
export const FREG_ROLES: readonly string[] = [
  'fp temporary', 'fp temporary', 'fp temporary', 'fp temporary',
  'fp temporary', 'fp temporary', 'fp temporary', 'fp temporary',
  'fp saved', 'fp saved', 'fp arg / return 0', 'fp arg / return 1',
  'fp argument', 'fp argument', 'fp argument', 'fp argument',
  'fp argument', 'fp argument', 'fp saved', 'fp saved',
  'fp saved', 'fp saved', 'fp saved', 'fp saved',
  'fp saved', 'fp saved', 'fp saved', 'fp saved',
  'fp temporary', 'fp temporary', 'fp temporary', 'fp temporary',
];

const FNAME_TO_INDEX: Map<string, number> = (() => {
  const m = new Map<string, number>();
  for (let i = 0; i < REG_COUNT; i++) {
    m.set(`f${i}`, i);
    m.set(FREG_ABI_NAMES[i], i);
  }
  return m;
})();

/** Resolve a float-register token (`f5`, `fa0`, `ft0`) to its index, or -1 if invalid. */
export function fregIndex(token: string): number {
  const i = FNAME_TO_INDEX.get(token.trim().toLowerCase());
  return i === undefined ? -1 : i;
}
