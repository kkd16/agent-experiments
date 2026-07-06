// CFG → PDA — the top-down, single-state pushdown automaton for a grammar.
// One control state q; the stack alphabet is the grammar's symbols. Two move
// kinds: EXPAND `(q, ε, A) → (q, γ)` replaces a nonterminal on top by a
// production body (leftmost symbol on top), and MATCH `(q, a, a) → (q, ε)` pops
// a terminal that equals the next input. Acceptance is by empty stack with the
// input fully read — and an accepting computation is exactly a leftmost
// derivation, which is what the animated run makes visible.

import type { Grammar, Rule, Sym } from './grammar';
import { minYield } from './analysis';

export interface PdaTable {
  start: string;
  expand: { A: string; rhs: Sym[] }[]; // (q,ε,A) → (q, rhs)
  match: string[]; // terminals a with (q,a,a) → (q,ε)
}

export function buildPda(g: Grammar): PdaTable {
  const expand = g.rules.map((r: Rule) => ({ A: r.lhs, rhs: r.rhs }));
  return { start: g.start, expand, match: [...g.terminals] };
}

export interface PdaStep {
  action: string; // human-readable move
  pos: number; // input position after the move
  stack: Sym[]; // stack after the move (top = last element)
}

export interface PdaRun {
  accepted: boolean;
  bounded: boolean; // hit the search cap without a definitive answer
  steps: PdaStep[]; // an accepting computation, if found
}

function symTag(s: Sym): string {
  return (s.kind === 'N' ? 'N' : 'T') + s.name;
}
function stackKey(stack: Sym[]): string {
  return stack.map(symTag).join(',');
}

/**
 * Search for an accepting computation by BFS over configs `(pos, stack)`, with
 * the oracle's admissible min-yield pruning, a stack-height cap and a config
 * cap so it always terminates. `bounded` is true if the caps were hit before a
 * definitive answer (only possible on pathological ε/left-recursive grammars).
 */
export function pdaRun(g: Grammar, w: string, opts: { maxConfigs?: number } = {}): PdaRun {
  const input = [...w];
  const n = input.length;
  const best = minYield(g);
  const byLhs = new Map<string, Rule[]>();
  for (const r of g.rules) {
    const l = byLhs.get(r.lhs);
    if (l) l.push(r);
    else byLhs.set(r.lhs, [r]);
  }
  const maxConfigs = opts.maxConfigs ?? 40000;
  const heightCap = n + 4 + 2 * g.nonterminals.length;

  const stackMinYield = (stack: Sym[]): number => {
    let sum = 0;
    for (const s of stack) {
      sum += s.kind === 'T' ? 1 : best.get(s.name) ?? Infinity;
      if (sum === Infinity) return Infinity;
    }
    return sum;
  };

  interface Node {
    pos: number;
    stack: Sym[];
    step: PdaStep | null;
    prev: number; // index into `nodes`
  }
  const startStack: Sym[] = [{ kind: 'N', name: g.start }];
  const nodes: Node[] = [{ pos: 0, stack: startStack, step: null, prev: -1 }];
  const seen = new Set<string>([`0#${stackKey(startStack)}`]);
  const queue = [0];
  let head = 0;
  let bounded = false;

  const reconstruct = (idx: number): PdaStep[] => {
    const out: PdaStep[] = [];
    let i = idx;
    while (i >= 0) {
      const nd = nodes[i];
      if (nd.step) out.push(nd.step);
      i = nd.prev;
    }
    out.reverse();
    return out;
  };

  while (head < queue.length) {
    if (nodes.length > maxConfigs) {
      bounded = true;
      break;
    }
    const idx = queue[head++];
    const cur = nodes[idx];
    const { pos, stack } = cur;
    if (stack.length === 0) {
      if (pos === n) return { accepted: true, bounded: false, steps: reconstruct(idx) };
      continue; // empty stack but input remains — dead
    }
    const top = stack[stack.length - 1];
    const push = (nextPos: number, nextStack: Sym[], action: string) => {
      if (nextStack.length > heightCap) return;
      if (nextPos + stackMinYield(nextStack) > n) return;
      const k = `${nextPos}#${stackKey(nextStack)}`;
      if (seen.has(k)) return;
      seen.add(k);
      nodes.push({ pos: nextPos, stack: nextStack, step: { action, pos: nextPos, stack: nextStack }, prev: idx });
      queue.push(nodes.length - 1);
    };
    if (top.kind === 'T') {
      // MATCH
      if (pos < n && input[pos] === top.name) {
        push(pos + 1, stack.slice(0, -1), `match ‘${top.name}’`);
      }
    } else {
      // EXPAND
      const A = top.name;
      const base = stack.slice(0, -1);
      for (const r of byLhs.get(A) ?? []) {
        // leftmost symbol of the body ends up on top → push the body reversed
        const nextStack = [...base];
        for (let i = r.rhs.length - 1; i >= 0; i--) nextStack.push(r.rhs[i]);
        push(pos, nextStack, `expand ${A} → ${r.rhs.length ? r.rhs.map((s) => s.name).join(' ') : 'ε'}`);
      }
    }
  }

  return { accepted: false, bounded, steps: [] };
}

/** Decide acceptance; `bounded` true means the caps were hit (answer inconclusive). */
export function pdaAccepts(g: Grammar, w: string): { accepted: boolean; bounded: boolean } {
  const run = pdaRun(g, w);
  return { accepted: run.accepted, bounded: run.bounded };
}
