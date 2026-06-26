// Module-editing helpers shared by the passes.
//
// Passes rewrite instructions in place (changing the mnemonic/operands of an Instr object). The one
// structural edit that needs care is *deletion*: when we drop an instruction we must not lose any
// label that pointed at it — that label has to slide onto whatever instruction now occupies its
// position, or survive as a stand-alone label, so every branch target stays valid.

import type { Module, Item, Instr } from './ir';

/** Remove the instructions whose object identity is in `drop`, preserving all labels. */
export function applyDeletions(m: Module, drop: ReadonlySet<Instr>): number {
  if (drop.size === 0) return 0;
  const out: Item[] = [];
  let carried: string[] = []; // labels orphaned by a deletion, awaiting the next text instr
  let removed = 0;

  const flushAsLabels = (line: number, section: 'text' | 'data') => {
    for (const name of carried) out.push({ kind: 'label', name, line, section });
    carried = [];
  };

  for (const it of m.items) {
    if (it.kind === 'instr' && it.section === 'text') {
      if (drop.has(it)) {
        carried.push(...it.labels);
        removed++;
        continue;
      }
      it.labels = [...carried, ...it.labels];
      carried = [];
      out.push(it);
    } else if (it.kind === 'label' && it.section === 'text') {
      carried.push(it.name);
    } else {
      // A directive or section boundary: any orphaned labels must materialise here.
      flushAsLabels(it.line, it.section === 'data' ? 'data' : 'text');
      out.push(it);
    }
  }
  flushAsLabels(Number.MAX_SAFE_INTEGER, 'text');
  m.items = out;
  return removed;
}
