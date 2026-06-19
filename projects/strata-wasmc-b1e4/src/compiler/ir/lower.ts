import type { IRModule, Inst, Operand } from './ir';
import { HEAP_GLOBAL } from './builder';

// Lower the high-level `alloc` op to the concrete bump-allocator sequence the
// backend understands. This runs once, on a private clone, just before codegen —
// so the optimizer and the UI see records as first-class `alloc`s (which escape
// analysis can reason about and scalarize), while the wasm backend stays a pure
// consumer of `gget`/`add`/`gset` and never has to know what an allocation is.
//
//     v = alloc <size>
//   becomes
//     v     = global.get __hp          ; the old heap top is the handle
//     vnext = v + alignUp(size, 8)     ; reserve the (8-aligned) block
//             global.set __hp, vnext   ; bump the pointer
//
// `v` (the alloc's result id) is reused as the `gget`, so every use of the handle
// keeps working untouched. A constant size is aligned at lowering time (struct
// sizes already are); a dynamic size gets the runtime `(+7) & ~7` rounding.

function alignUp8(n: number): number {
  return (n + 7) & ~7;
}

export function lowerAllocs(mod: IRModule): number {
  let count = 0;
  for (const fn of mod.funcs) {
    let hasAlloc = false;
    for (const b of fn.blocks) {
      for (const i of b.insts)
        if (i.kind === 'alloc') {
          hasAlloc = true;
          break;
        }
      if (hasAlloc) break;
    }
    if (!hasAlloc) continue;

    let nextId = -1;
    for (const k of fn.valueType.keys()) if (k > nextId) nextId = k;
    for (const b of fn.blocks) for (const i of b.insts) if (i.res !== null && i.res > nextId) nextId = i.res;
    const fresh = (ty: 'i32'): number => {
      const id = ++nextId;
      fn.valueType.set(id, ty);
      return id;
    };
    const ci = (n: number): Operand => ({ tag: 'const', ty: 'i32', num: n | 0 });
    const v = (id: number): Operand => ({ tag: 'val', id });

    for (const b of fn.blocks) {
      const out: Inst[] = [];
      for (const inst of b.insts) {
        if (inst.kind !== 'alloc' || inst.res === null) {
          out.push(inst);
          continue;
        }
        const base = inst.res; // reuse the handle id for the heap-top read
        out.push({ res: base, ty: 'i32', kind: 'gget', sub: HEAP_GLOBAL, args: [] });
        const size = inst.args[0];
        let reserve: Operand;
        if (size.tag === 'const') {
          reserve = ci(alignUp8(size.num as number));
        } else {
          const raw = fresh('i32');
          out.push({ res: raw, ty: 'i32', kind: 'ibin', sub: 'add', args: [size, ci(7)] });
          const aligned = fresh('i32');
          out.push({ res: aligned, ty: 'i32', kind: 'ibin', sub: 'and', args: [v(raw), ci(~7)] });
          reserve = v(aligned);
        }
        const next = fresh('i32');
        out.push({ res: next, ty: 'i32', kind: 'ibin', sub: 'add', args: [v(base), reserve] });
        out.push({ res: null, ty: 'void', kind: 'gset', sub: HEAP_GLOBAL, args: [v(next)] });
        count++;
      }
      b.insts = out;
    }
  }
  return count;
}
