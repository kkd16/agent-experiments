import type { Inst, IRFunc, IRModule, Operand, Phi, Term } from './ir/ir';

// Human-readable textual SSA, used by the dev harness and the IR panel in the UI.

function op(o: Operand): string {
  if (o.tag === 'const') return o.ty === 'i32' ? `${(o.num as number) | 0}` : `${o.num}`; // i64 prints with no suffix
  return `v${o.id}`;
}

export function fmtInst(i: Inst): string {
  return inst(i);
}
export function fmtPhi(p: Phi): string {
  return phi(p);
}
export function fmtTerm(t: Term): string {
  return term(t);
}

function inst(i: Inst): string {
  const dst = i.res !== null ? `v${i.res} = ` : '';
  const a = i.args.map(op);
  switch (i.kind) {
    case 'ibin':
    case 'fbin':
      return `${dst}${i.kind === 'ibin' ? 'i' : 'f'}.${i.sub} ${a[0]}, ${a[1]}`;
    case 'iunary':
      return `${dst}i.${i.sub} ${a[0]}`;
    case 'icmp':
    case 'fcmp':
      return `${dst}${i.kind === 'icmp' ? 'i' : 'f'}.cmp.${i.sub} ${a[0]}, ${a[1]}`;
    case 'cast':
      return `${dst}cast.${i.sub} ${a[0]}`;
    case 'select':
      return `${dst}select ${a[2]} ? ${a[0]} : ${a[1]}`;
    case 'copy':
      return `${dst}copy ${a[0]}`;
    case 'call':
      return `${dst}call ${i.sub}(${a.join(', ')})`;
    case 'funcaddr':
      return `${dst}funcaddr &${i.sub}`;
    case 'callind':
      return `${dst}call_indirect [${a[0]}](${a.slice(1).join(', ')}) : ${i.sub}`;
    case 'print':
      return `print.${i.sub} ${a[0]}`;
    case 'gget':
      return `${dst}global.get ${i.sub}`;
    case 'gset':
      return `global.set ${i.sub}, ${a[0]}`;
    case 'alloc':
      return `${dst}alloc ${a[0]}`;
    case 'load':
      return `${dst}load.${i.sub} [${a[0]}]`;
    case 'store':
      return `store.${i.sub} [${a[0]}], ${a[1]}`;
    case 'vsplat':
      return `${dst}${i.sub}.splat ${a[0]}`;
    case 'vunary':
      return `${dst}${i.sub} ${a[0]}`;
    case 'vbin':
      return `${dst}${i.sub} ${a[0]}, ${a[1]}`;
    case 'vextract':
      return `${dst}${i.sub} ${a[0]}`;
    case 'vreplace':
      return `${dst}${i.sub} ${a[0]}, ${a[1]}`;
    case 'vselect':
      return `${dst}v128.bitselect ${a[2]} ? ${a[0]} : ${a[1]}`;
  }
}

function phi(p: Phi): string {
  const parts = p.incomings.map((inc) => `b${inc.pred}:${op(inc.val)}`).join(', ');
  return `v${p.res} = phi.${p.ty} [${parts}]`;
}

function term(t: Term): string {
  switch (t.op) {
    case 'br':
      return `br b${t.target}`;
    case 'condbr':
      return `condbr ${op(t.cond)} ? b${t.t} : b${t.f}`;
    case 'ret':
      return t.value ? `ret ${op(t.value)}` : 'ret';
    case 'unreachable':
      return 'unreachable';
  }
}

export function dumpFunc(fn: IRFunc): string {
  const lines: string[] = [];
  const ps = fn.params.map((p, i) => `v${i}:${p.ty}`).join(', ');
  lines.push(`func ${fn.name}(${ps}) -> ${fn.retTy} {`);
  for (const b of fn.blocks) {
    const preds = b.preds.length ? `  ; preds: ${b.preds.map((p) => `b${p}`).join(', ')}` : '';
    lines.push(`b${b.id}:${preds}`);
    for (const p of b.phis) lines.push(`    ${phi(p)}`);
    for (const i of b.insts) lines.push(`    ${inst(i)}`);
    lines.push(`    ${term(b.term)}`);
  }
  lines.push('}');
  return lines.join('\n');
}

export function dumpModule(mod: IRModule): string {
  const parts: string[] = [];
  for (const g of mod.globals) parts.push(`global ${g.name}: ${g.ty} = ${g.init}`);
  if (mod.globals.length) parts.push('');
  for (const fn of mod.funcs) parts.push(dumpFunc(fn));
  return parts.join('\n\n');
}
