// Stack-slot forwarding & dead-store elimination — the headline win against the naive back end.
//
// The C back end is a stack machine: it materialises a value, pushes it (`addi sp,sp,-4; sw a0,0(sp)`),
// and later pops it (`lw t1,0(sp); addi sp,sp,4`). Those temporaries are *private*: their addresses
// are never taken, and they live below `sp`, a region disjoint from the `s0`-relative locals and the
// heap. That lets us prove two transformations sound:
//
//   * store-to-load FORWARDING — a pop reads exactly what the matching push wrote, so we replace the
//     load with a cheap rematerialisation of that value (a constant `li`, an address `addi`, or a
//     `mv` from a register that still holds it), breaking the dependence on memory entirely; and
//   * dead-store ELIMINATION — once every load of a slot is forwarded, the push's store is dead and
//     the slot is freed when `sp` rises back over it, so the store is removed.
//
// We track `sp` exactly (only constant adjustments; any other write to `sp` stops tracking), key
// slots by their `sp`-relative address, and only ever forward across an intervening store we can
// prove cannot alias the slot. Anything we cannot classify conservatively invalidates the slot map.
// The differential oracle re-checks every result, so this stays aggressive without being unsafe.

import type { Module, Instr } from '../ir';
import { printInstr, reg as mkReg, imm as mkImm, isReg, isImm } from '../ir';
import { buildCfg } from '../cfg';
import { analyzeInstr, ZERO, SP, S0, GP, TP } from '../semantics';
import { applyDeletions } from '../edit';
import { setMv, setLi } from './simplify';
import type { Pass, PassCtx } from '../pass';

const fits12 = (x: number): boolean => x >= -2048 && x <= 2047;

type RegVal = { k: 'const'; v: number } | { k: 'addr'; base: number; off: number };
type Recipe =
  | { k: 'const'; v: number }
  | { k: 'addr'; base: number; off: number; ver: number }
  | { k: 'reg'; reg: number; ver: number };

interface Slot {
  store: Instr;
  recipe: Recipe;
  hadRealLoad: boolean;
}

export const stackForwardPass: Pass = {
  name: 'stack-forward',
  run(m: Module, ctx: PassCtx): number {
    const cfg = buildCfg(m);
    const drop = new Set<Instr>();
    let changes = 0;

    for (const b of cfg.blocks) {
      const regv = new Map<number, RegVal>();
      const ver = new Int32Array(32);
      const slots = new Map<number, Slot>();
      let spOff = 0;
      let spOk = true;

      const bump = (r: number) => {
        if (r === ZERO) return;
        ver[r]++;
        regv.delete(r);
        for (const [k, e] of regv) if (e.k === 'addr' && e.base === r) regv.delete(k);
      };
      // sp-relative slot address of base+off, or undefined if not a stack reference.
      const stackSlot = (baseReg: number, off: number): number | undefined => {
        if (!spOk) return undefined;
        if (baseReg === SP) return spOff + off;
        const e = regv.get(baseReg);
        if (e && e.k === 'addr' && e.base === SP) return spOff + e.off + off;
        return undefined;
      };
      // Classify a memory base for aliasing: 'stack' (a slot), 'nonstack' (frame/global), 'unknown'.
      const classifyBase = (baseReg: number): 'stack' | 'nonstack' | 'unknown' => {
        if (baseReg === SP) return 'stack';
        if (baseReg === S0 || baseReg === GP || baseReg === TP) return 'nonstack';
        const e = regv.get(baseReg);
        if (e && e.k === 'addr') {
          if (e.base === SP) return 'stack';
          if (e.base === S0 || e.base === GP || e.base === TP) return 'nonstack';
        }
        return 'unknown';
      };

      for (const idx of b.range) {
        const i = cfg.instrs[idx];
        const info = analyzeInstr(i);
        const o = i.operands;

        // --- sp tracking ----------------------------------------------------
        if (i.op === 'addi' && isReg(o[0]) && o[0].n === SP && isReg(o[1]) && o[1].n === SP && isImm(o[2])) {
          const k = o[2].v;
          const newSp = spOff + k;
          if (k > 0) freeAbove(slots, newSp, drop);
          spOff = newSp;
        } else if (info.defs.includes(SP) || info.clobbers.includes(SP)) {
          slots.clear();
          spOk = false;
        }

        // --- loads: forward a stack-slot load -------------------------------
        if (!info.opaque && isLoadWord(i)) {
          const mem = o[1];
          if (mem && mem.kind === 'mem' && isImm(mem.off)) {
            const slotKey = stackSlot(mem.base, mem.off.v);
            const rd = isReg(o[0]) ? o[0].n : undefined;
            if (slotKey !== undefined && rd !== undefined) {
              const slot = slots.get(slotKey);
              if (slot && tryForward(i, rd, slot, ver)) {
                ctx.rewrote('stack-forward', printInstr(i).trim(), i, 'pop forwarded from the matching push');
                changes++;
              } else if (slot) {
                slot.hadRealLoad = true; // a real memory load keeps the store alive
              }
            }
          }
        }

        // --- stores: record a stack-slot store, kill an overwritten dead one -
        if (!info.opaque && isStoreWord(i)) {
          const mem = o[1];
          const src = isReg(o[0]) ? o[0].n : undefined;
          if (mem && mem.kind === 'mem' && isImm(mem.off)) {
            const slotKey = stackSlot(mem.base, mem.off.v);
            if (slotKey !== undefined && src !== undefined) {
              const prev = slots.get(slotKey);
              if (prev && !prev.hadRealLoad) drop.add(prev.store);
              slots.set(slotKey, { store: i, recipe: recipeFor(src, regv, ver), hadRealLoad: false });
            } else if (classifyBase(mem.base) === 'unknown') {
              slots.clear(); // might alias a temp — forget everything forwardable
            }
            // 'nonstack' stores (frame/global) cannot alias temps — leave slots intact.
          } else {
            slots.clear();
          }
        }

        // --- any other memory writer we don't model: be safe ----------------
        if (info.opaque || (info.memWrite && !isStoreWord(i))) slots.clear();

        // --- update the register value model --------------------------------
        modelRegs(i, info, regv, bump);
      }
    }

    for (const ins of drop) ctx.deleted('stack-forward', ins, 'spilled value is never reloaded');
    const removed = applyDeletions(m, drop);
    return changes + removed;
  },
};

// A second, independent pass: once the stores that *used* a stack slot are gone, the `addi sp,sp,-K`
// that reserved it and the matching `addi sp,sp,+K` that freed it are pure overhead. We match these
// adjustments LIFO within a block and delete a pair whose reserved region is never touched by a
// surviving stack access. Sound because the region demonstrably holds no live datum.
export const deadStackPass: Pass = {
  name: 'dead-stack',
  run(m: Module, ctx: PassCtx): number {
    const cfg = buildCfg(m);
    const drop = new Set<Instr>();

    for (const b of cfg.blocks) {
      interface Open { instr: Instr; size: number; low: number; high: number; used: boolean }
      const open: Open[] = [];
      const spDerived = new Map<number, number>(); // reg → (value - sp), i.e. its sp offset
      let depth = 0;
      let bailed = false;

      const markAccess = (addr: number) => {
        for (let k = open.length - 1; k >= 0; k--) {
          if (addr >= open[k].low && addr < open[k].high) { open[k].used = true; return; }
        }
      };

      for (const idx of b.range) {
        if (bailed) break;
        const i = cfg.instrs[idx];
        const o = i.operands;
        const info = analyzeInstr(i);

        // sp adjustment?
        if (i.op === 'addi' && isReg(o[0]) && o[0].n === SP && isReg(o[1]) && o[1].n === SP && isImm(o[2])) {
          const k = o[2].v;
          if (k < 0) { open.push({ instr: i, size: -k, low: depth + k, high: depth, used: false }); depth += k; }
          else if (k > 0) {
            const top = open[open.length - 1];
            if (top && top.size === k) {
              open.pop();
              if (!top.used) { drop.add(top.instr); drop.add(i); }
              depth += k;
            } else { bailed = true; } // structure we don't understand — stop, change nothing more
          }
          continue;
        }
        if (info.defs.includes(SP) || info.clobbers.includes(SP)) break;

        // Memory access through sp or an sp-derived register marks its enclosing region as used.
        for (const op of o) {
          if (op.kind === 'mem') {
            const off = isImm(op.off) ? op.off.v : 0;
            if (op.base === SP) markAccess(depth + off);
            else if (spDerived.has(op.base)) markAccess(depth + spDerived.get(op.base)! + off);
          }
        }

        // Track sp-derived registers (reg = sp + const). s0 is excluded: it is the *stable* frame
        // pointer (set once from sp, then fixed while sp moves), so reading it as sp-relative would
        // mis-attribute every frame access to a moving stack offset.
        const dst = isReg(o[0]) ? o[0].n : -1;
        if (dst === S0) { spDerived.delete(S0); }
        else if (i.op === 'mv' && isReg(o[1]) && o[1].n === SP) spDerived.set(dst, 0);
        else if (i.op === 'addi' && isReg(o[1]) && isImm(o[2]) && o[1].n === SP) spDerived.set(dst, o[2].v);
        else if (i.op === 'addi' && isReg(o[1]) && isImm(o[2]) && spDerived.has(o[1].n) && dst !== o[1].n) {
          spDerived.set(dst, spDerived.get(o[1].n)! + o[2].v);
        } else for (const d of info.clobbers) if (d !== SP) spDerived.delete(d);
      }
    }

    for (const ins of drop) ctx.deleted('dead-stack', ins, 'reserves stack space that is never used');
    return applyDeletions(m, drop);
  },
};

function freeAbove(slots: Map<number, Slot>, newSp: number, drop: Set<Instr>): void {
  for (const [key, slot] of slots) {
    if (key < newSp) {
      if (!slot.hadRealLoad) drop.add(slot.store); // freed without ever being really loaded
      slots.delete(key);
    }
  }
}

function recipeFor(src: number, regv: Map<number, RegVal>, ver: Int32Array): Recipe {
  if (src === ZERO) return { k: 'const', v: 0 };
  const e = regv.get(src);
  if (e && e.k === 'const') return { k: 'const', v: e.v };
  if (e && e.k === 'addr') return { k: 'addr', base: e.base, off: e.off, ver: ver[e.base] };
  return { k: 'reg', reg: src, ver: ver[src] };
}

// Rewrite load `i` (destination rd) to rematerialise the slot's value, if currently possible.
function tryForward(i: Instr, rd: number, slot: Slot, ver: Int32Array): boolean {
  const rec = slot.recipe;
  if (rec.k === 'const') { setLi(i, rd, rec.v); return true; }
  if (rec.k === 'addr') {
    if (ver[rec.base] === rec.ver && fits12(rec.off)) {
      if (rec.off === 0) setMv(i, rd, rec.base);
      else { i.op = 'addi'; i.operands = [mkReg(rd), mkReg(rec.base), mkImm(rec.off | 0)]; i.known = true; i.rewritten = true; }
      return true;
    }
    return false;
  }
  if (ver[rec.reg] === rec.ver) { setMv(i, rd, rec.reg); return true; }
  return false;
}

// Maintain the lightweight const/addr lattice + version stamps as we walk the block.
function modelRegs(
  i: Instr,
  info: ReturnType<typeof analyzeInstr>,
  regv: Map<number, RegVal>,
  bump: (r: number) => void,
): void {
  const o = i.operands;
  const setVal = (r: number, v: RegVal) => { bump(r); if (r !== ZERO) regv.set(r, v); };

  if (i.op === 'li' && isReg(o[0]) && isImm(o[1])) { setVal(o[0].n, { k: 'const', v: o[1].v | 0 }); return; }
  if (i.op === 'addi' && isReg(o[0]) && isReg(o[1]) && isImm(o[2])) {
    const rd = o[0].n, rs = o[1].n, imm = o[2].v;
    // sp/s0 stay opaque pointer bases (see propagate.ts) so frame refs are never aliased as temps.
    if (rd === SP || rd === S0) { bump(rd); return; }
    const e = regv.get(rs);
    if (e && e.k === 'const') { setVal(rd, { k: 'const', v: (e.v + imm) | 0 }); return; }
    if (e && e.k === 'addr' && e.base !== rd) { setVal(rd, { k: 'addr', base: e.base, off: (e.off + imm) | 0 }); return; }
    if (rs !== rd && rs !== ZERO) { setVal(rd, { k: 'addr', base: rs, off: imm }); return; }
    bump(rd); return;
  }
  if (i.op === 'mv' && isReg(o[0]) && isReg(o[1])) {
    const rd = o[0].n, rs = o[1].n;
    if (rd === SP || rd === S0) { bump(rd); return; }
    const e = regv.get(rs);
    if (e) { setVal(rd, e); return; }
    if (rs !== ZERO && rs !== rd) { setVal(rd, { k: 'addr', base: rs, off: 0 }); return; }
    bump(rd); return;
  }
  for (const c of info.clobbers) bump(c);
}

function isLoadWord(i: Instr): boolean {
  return i.op === 'lw' && i.operands.length === 2 && i.operands[1]?.kind === 'mem';
}
function isStoreWord(i: Instr): boolean {
  return i.op === 'sw' && i.operands.length === 2 && i.operands[1]?.kind === 'mem';
}
