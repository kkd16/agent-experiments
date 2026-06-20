// Running the automata over real input: full-string acceptance, leftmost-
// longest non-overlapping search (for highlighting), and step-by-step traces
// that drive the animated debugger.

import { atomIndexFor, type DFA } from './dfa';
import type { NFA } from './nfa';
import { buildAdjacency, epsilonClosure, type NFAAdjacency } from './nfa';

export function toCodePoints(text: string): number[] {
  return Array.from(text, (ch) => ch.codePointAt(0)!);
}

// --- NFA trace -------------------------------------------------------------

export interface NFAFrame {
  consumed: number; // characters consumed so far (0 = start)
  char: string | null; // the character just read
  active: number[]; // active states (ε-closed) after reading `consumed` chars
  stuck: boolean; // no active states remain
}

export interface NFATrace {
  frames: NFAFrame[];
  accepted: boolean;
}

export function traceNFA(nfa: NFA, text: string, adjacency?: NFAAdjacency): NFATrace {
  const adj = adjacency ?? buildAdjacency(nfa);
  const codes = toCodePoints(text);
  const chars = Array.from(text);
  let active = epsilonClosure([nfa.start], adj);
  const frames: NFAFrame[] = [
    { consumed: 0, char: null, active: [...active].sort((a, b) => a - b), stuck: active.size === 0 },
  ];
  for (let i = 0; i < codes.length; i++) {
    const moved = new Set<number>();
    for (const s of active) {
      for (const edge of adj.symbol[s]) {
        if (edge.set.contains(codes[i])) moved.add(edge.to);
      }
    }
    active = epsilonClosure(moved, adj);
    frames.push({
      consumed: i + 1,
      char: chars[i],
      active: [...active].sort((a, b) => a - b),
      stuck: active.size === 0,
    });
    if (active.size === 0) break;
  }
  const accepted = frames[frames.length - 1].consumed === codes.length && active.has(nfa.accept);
  return { frames, accepted };
}

// --- DFA trace -------------------------------------------------------------

export interface DFAFrame {
  consumed: number;
  char: string | null;
  state: number; // -1 once stuck in the dead sink
  accept: boolean;
}

export interface DFATrace {
  frames: DFAFrame[];
  accepted: boolean;
}

export function traceDFA(dfa: DFA, text: string): DFATrace {
  const codes = toCodePoints(text);
  const chars = Array.from(text);
  let state = dfa.start;
  const frames: DFAFrame[] = [
    { consumed: 0, char: null, state, accept: dfa.states[state]?.accept ?? false },
  ];
  for (let i = 0; i < codes.length; i++) {
    if (state < 0) break;
    const a = atomIndexFor(dfa.atoms, codes[i]);
    const ns = a >= 0 ? dfa.table[state][a] : -1;
    state = ns;
    frames.push({
      consumed: i + 1,
      char: chars[i],
      state,
      accept: state >= 0 ? dfa.states[state].accept : false,
    });
    if (state < 0) break;
  }
  const last = frames[frames.length - 1];
  const accepted = last.consumed === codes.length && last.state >= 0 && dfa.states[last.state].accept;
  return { frames, accepted };
}

export function dfaAccepts(dfa: DFA, text: string): boolean {
  return traceDFA(dfa, text).accepted;
}

// --- Search (leftmost-longest, non-overlapping) ----------------------------

export interface Match {
  start: number; // inclusive, in code-point space
  end: number; // exclusive
}

export interface SearchResult {
  matches: Match[];
  emptyMatches: number; // zero-width matches found (not highlighted)
}

export function searchAll(dfa: DFA, text: string): SearchResult {
  const codes = toCodePoints(text);
  const matches: Match[] = [];
  let emptyMatches = 0;
  let i = 0;
  let guard = 0;
  while (i <= codes.length && guard++ < codes.length * 2 + 4) {
    let state = dfa.start;
    let lastAccept = dfa.states[state]?.accept ? i : -1;
    let j = i;
    while (j < codes.length && state >= 0) {
      const a = atomIndexFor(dfa.atoms, codes[j]);
      const ns = a >= 0 ? dfa.table[state][a] : -1;
      if (ns < 0) break;
      state = ns;
      j++;
      if (dfa.states[state].accept) lastAccept = j;
    }
    if (lastAccept > i) {
      matches.push({ start: i, end: lastAccept });
      i = lastAccept;
    } else {
      if (lastAccept === i) emptyMatches++;
      i++;
    }
  }
  return { matches, emptyMatches };
}
