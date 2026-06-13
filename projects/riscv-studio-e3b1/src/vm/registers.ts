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
