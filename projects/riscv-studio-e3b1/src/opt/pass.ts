// The pass framework: a structured change log every pass writes into, and the Pass shape the driver
// runs to a fixpoint. Keeping the log rich (per edit: which pass, the before/after text, a note) is
// what lets the Optimizer tab show *why* the code got smaller, not just that it did.

import type { Module, Instr } from './ir';
import { printInstr } from './ir';

export interface Change {
  pass: string;
  line: number; // source line of the affected instruction (0 for structural edits)
  before: string;
  after: string | null; // null = the instruction was deleted
  note: string;
}

export class PassCtx {
  changes: Change[] = [];
  private counts = new Map<string, number>();

  /** Record that `instr` was rewritten from its prior text `before` to its current state. */
  rewrote(pass: string, before: string, instr: Instr, note: string): void {
    this.push(pass, instr.line, before, printInstr(instr).trim(), note);
  }
  /** Record that an instruction was deleted. */
  deleted(pass: string, instr: Instr, note: string): void {
    this.push(pass, instr.line, printInstr(instr).trim(), null, note);
  }
  /** Record a structural edit (label removed, block merged, …). */
  structural(pass: string, note: string): void {
    this.push(pass, 0, '', null, note);
  }
  private push(pass: string, line: number, before: string, after: string | null, note: string): void {
    this.changes.push({ pass, line, before: before.trim(), after: after?.trim() ?? null, note });
    this.counts.set(pass, (this.counts.get(pass) ?? 0) + 1);
  }
  countFor(pass: string): number {
    return this.counts.get(pass) ?? 0;
  }
}

export interface Pass {
  name: string;
  /** Mutate `m` in place; return the number of changes made this run. */
  run(m: Module, ctx: PassCtx): number;
}
