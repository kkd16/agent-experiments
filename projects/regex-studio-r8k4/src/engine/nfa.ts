// Thompson's construction: turn a RegexNode AST into an ε-NFA.
//
// Every fragment we build has exactly one entry and one exit state, wired
// together with ε-transitions. Quantifiers are desugared here: a{2,4} becomes
// a·a·a?·a?, a{2,} becomes a·a·a*, and so on.

import type { RegexNode } from './ast';
import { CharSet } from './charset';

export interface NFAEdge {
  from: number;
  to: number;
  set: CharSet | null; // null = ε
}

export interface NFA {
  start: number;
  accept: number; // single accepting state (Thompson)
  stateCount: number;
  edges: NFAEdge[];
}

interface Fragment {
  start: number;
  end: number;
}

class Builder {
  stateCount = 0;
  edges: NFAEdge[] = [];

  newState(): number {
    return this.stateCount++;
  }
  eps(from: number, to: number): void {
    this.edges.push({ from, to, set: null });
  }
  sym(from: number, to: number, set: CharSet): void {
    this.edges.push({ from, to, set });
  }

  build(node: RegexNode): Fragment {
    switch (node.type) {
      case 'empty': {
        const s = this.newState();
        const e = this.newState();
        this.eps(s, e);
        return { start: s, end: e };
      }
      case 'char': {
        const s = this.newState();
        const e = this.newState();
        this.sym(s, e, node.set);
        return { start: s, end: e };
      }
      case 'group':
        return this.build(node.node);
      case 'concat': {
        if (node.parts.length === 0) return this.build({ type: 'empty' });
        const frags = node.parts.map((p) => this.build(p));
        for (let i = 0; i < frags.length - 1; i++) this.eps(frags[i].end, frags[i + 1].start);
        return { start: frags[0].start, end: frags[frags.length - 1].end };
      }
      case 'alt': {
        const s = this.newState();
        const e = this.newState();
        for (const opt of node.options) {
          const f = this.build(opt);
          this.eps(s, f.start);
          this.eps(f.end, e);
        }
        return { start: s, end: e };
      }
      case 'star': {
        const s = this.newState();
        const e = this.newState();
        const f = this.build(node.node);
        this.eps(s, f.start);
        this.eps(f.end, e);
        this.eps(f.end, f.start);
        this.eps(s, e);
        return { start: s, end: e };
      }
      case 'plus': {
        const f = this.build(node.node);
        const e = this.newState();
        this.eps(f.end, f.start);
        this.eps(f.end, e);
        return { start: f.start, end: e };
      }
      case 'opt': {
        const s = this.newState();
        const e = this.newState();
        const f = this.build(node.node);
        this.eps(s, f.start);
        this.eps(f.end, e);
        this.eps(s, e);
        return { start: s, end: e };
      }
      case 'repeat': {
        const frags: Fragment[] = [];
        for (let i = 0; i < node.min; i++) frags.push(this.build(node.node));
        if (node.max === null) {
          frags.push(this.build({ type: 'star', node: node.node, lazy: false }));
        } else {
          for (let i = node.min; i < node.max; i++) {
            frags.push(this.build({ type: 'opt', node: node.node, lazy: false }));
          }
        }
        if (frags.length === 0) return this.build({ type: 'empty' });
        for (let i = 0; i < frags.length - 1; i++) this.eps(frags[i].end, frags[i + 1].start);
        return { start: frags[0].start, end: frags[frags.length - 1].end };
      }
    }
  }
}

export function buildNFA(ast: RegexNode): NFA {
  const b = new Builder();
  const frag = b.build(ast);
  return { start: frag.start, accept: frag.end, stateCount: b.stateCount, edges: b.edges };
}

// Adjacency helpers ---------------------------------------------------------

export interface NFAAdjacency {
  epsilon: number[][]; // epsilon successors per state
  symbol: { to: number; set: CharSet }[][]; // labelled successors per state
}

export function buildAdjacency(nfa: NFA): NFAAdjacency {
  const epsilon: number[][] = Array.from({ length: nfa.stateCount }, () => []);
  const symbol: { to: number; set: CharSet }[][] = Array.from({ length: nfa.stateCount }, () => []);
  for (const e of nfa.edges) {
    if (e.set === null) epsilon[e.from].push(e.to);
    else symbol[e.from].push({ to: e.to, set: e.set });
  }
  return { epsilon, symbol };
}

// ε-closure of a set of states.
export function epsilonClosure(states: Iterable<number>, adj: NFAAdjacency): Set<number> {
  const closure = new Set<number>();
  const stack: number[] = [];
  for (const s of states) {
    if (!closure.has(s)) {
      closure.add(s);
      stack.push(s);
    }
  }
  while (stack.length) {
    const s = stack.pop()!;
    for (const t of adj.epsilon[s]) {
      if (!closure.has(t)) {
        closure.add(t);
        stack.push(t);
      }
    }
  }
  return closure;
}
