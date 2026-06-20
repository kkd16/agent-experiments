// Treating the DFA as a description of a *language* and answering questions
// about it directly: is it empty? finite or infinite? what's the shortest
// member? how many strings of each length does it contain? and a shortlex
// enumeration of example members. All of this is graph theory over the DFA's
// transition table — no string matching involved.

import type { Atom, DFA } from './dfa';

export interface LanguageInfo {
  empty: boolean;
  finite: boolean;
  shortest: { codes: number[]; display: string } | null;
  // Exact count of accepted strings of each length 0..maxLen (BigInt).
  countsByLength: bigint[];
  cumulative: bigint[];
  totalIfFinite: bigint | null;
  // Representative example members in shortlex order (one char per class).
  examples: string[];
  examplesExact: boolean; // true ⇒ every character class is a singleton
}

function representative(lo: number, hi: number): number {
  const prefer = [97, 98, 99, 48, 49, 32, 65];
  for (const c of prefer) if (c >= lo && c <= hi) return c;
  for (let c = Math.max(lo, 33); c <= Math.min(hi, 126); c++) return c;
  return lo;
}

function atomRep(atom: Atom): number {
  const r = atom.set.ranges[0];
  return r ? representative(r.lo, r.hi) : atom.lo;
}

function displayCodes(codes: number[]): string {
  if (codes.length === 0) return 'ε (empty string)';
  return codes
    .map((c) => {
      if (c === 32) return '␣';
      if (c === 10) return '\\n';
      if (c === 9) return '\\t';
      if (c < 32 || c === 127) return `\\x${c.toString(16).padStart(2, '0')}`;
      return String.fromCodePoint(c);
    })
    .join('');
}

// States reachable from the start (forward) and those that can reach an accept
// state (backward). A state is "live" if it is in both.
function liveStates(dfa: DFA): { reachable: boolean[]; coReachable: boolean[]; live: boolean[] } {
  const n = dfa.states.length;
  const A = dfa.atoms.length;
  const reachable = new Array(n).fill(false);
  const queue = [dfa.start];
  reachable[dfa.start] = true;
  while (queue.length) {
    const s = queue.shift()!;
    for (let a = 0; a < A; a++) {
      const t = dfa.table[s][a];
      if (t >= 0 && !reachable[t]) {
        reachable[t] = true;
        queue.push(t);
      }
    }
  }
  // reverse edges
  const rev: number[][] = Array.from({ length: n }, () => []);
  for (let s = 0; s < n; s++) {
    for (let a = 0; a < A; a++) {
      const t = dfa.table[s][a];
      if (t >= 0) rev[t].push(s);
    }
  }
  const coReachable = new Array(n).fill(false);
  const cq: number[] = [];
  for (let s = 0; s < n; s++) if (dfa.states[s].accept) { coReachable[s] = true; cq.push(s); }
  while (cq.length) {
    const s = cq.shift()!;
    for (const p of rev[s]) if (!coReachable[p]) { coReachable[p] = true; cq.push(p); }
  }
  const live = reachable.map((r, i) => r && coReachable[i]);
  return { reachable, coReachable, live };
}

// Is there a cycle in the subgraph induced by `live` states? (⇒ infinite language)
function hasCycle(dfa: DFA, live: boolean[]): boolean {
  const n = dfa.states.length;
  const A = dfa.atoms.length;
  const color = new Uint8Array(n); // 0 = white, 1 = grey (on stack), 2 = black
  const stack: { s: number; a: number }[] = [];
  for (let start = 0; start < n; start++) {
    if (!live[start] || color[start] !== 0) continue;
    stack.push({ s: start, a: 0 });
    color[start] = 1;
    while (stack.length) {
      const top = stack[stack.length - 1];
      if (top.a >= A) {
        color[top.s] = 2;
        stack.pop();
        continue;
      }
      const t = dfa.table[top.s][top.a++];
      if (t < 0 || !live[t]) continue;
      if (color[t] === 1) return true; // back edge ⇒ cycle
      if (color[t] === 0) {
        color[t] = 1;
        stack.push({ s: t, a: 0 });
      }
    }
  }
  return false;
}

function shortestString(dfa: DFA): { codes: number[]; display: string } | null {
  const n = dfa.states.length;
  const A = dfa.atoms.length;
  // Atoms sorted by representative ⇒ lexicographically-smallest shortest member.
  const order = [...Array(A).keys()].sort((x, y) => atomRep(dfa.atoms[x]) - atomRep(dfa.atoms[y]));
  const prev = new Array(n).fill(-1);
  const prevAtom = new Array(n).fill(-1);
  const seen = new Array(n).fill(false);
  const queue = [dfa.start];
  seen[dfa.start] = true;
  let acc = dfa.states[dfa.start].accept ? dfa.start : -1;
  while (queue.length && acc < 0) {
    const s = queue.shift()!;
    for (const a of order) {
      const t = dfa.table[s][a];
      if (t >= 0 && !seen[t]) {
        seen[t] = true;
        prev[t] = s;
        prevAtom[t] = a;
        if (dfa.states[t].accept) { acc = t; break; }
        queue.push(t);
      }
    }
  }
  if (acc < 0) return null;
  const codes: number[] = [];
  let cur = acc;
  while (cur !== dfa.start) {
    codes.push(atomRep(dfa.atoms[prevAtom[cur]]));
    cur = prev[cur];
  }
  codes.reverse();
  return { codes, display: displayCodes(codes) };
}

// Exact count of accepted strings of each length, via DP over the DFA. Each
// atom contributes its *size* (number of distinct characters) at each step.
function countsByLength(dfa: DFA, maxLen: number): bigint[] {
  const n = dfa.states.length;
  const A = dfa.atoms.length;
  const sizes = dfa.atoms.map((at) => BigInt(at.set.size()));
  let dp = new Array<bigint>(n).fill(0n);
  dp[dfa.start] = 1n;
  const counts: bigint[] = [];
  for (let len = 0; len <= maxLen; len++) {
    let total = 0n;
    for (let s = 0; s < n; s++) if (dfa.states[s].accept) total += dp[s];
    counts.push(total);
    const next = new Array<bigint>(n).fill(0n);
    for (let s = 0; s < n; s++) {
      const here = dp[s];
      if (here === 0n) continue;
      for (let a = 0; a < A; a++) {
        const t = dfa.table[s][a];
        if (t >= 0) next[t] += here * sizes[a];
      }
    }
    dp = next;
  }
  return counts;
}

// Shortlex enumeration of example members using one representative per class.
function enumerate(dfa: DFA, limit: number, maxLen: number): string[] {
  const A = dfa.atoms.length;
  const order = [...Array(A).keys()].sort((x, y) => atomRep(dfa.atoms[x]) - atomRep(dfa.atoms[y]));
  const out: string[] = [];
  // BFS by length keeps shortlex order; within a length we expand atoms in
  // representative order, so siblings come out lexicographically.
  let frontier: { state: number; codes: number[] }[] = [{ state: dfa.start, codes: [] }];
  for (let len = 0; len <= maxLen && out.length < limit && frontier.length; len++) {
    for (const node of frontier) {
      if (dfa.states[node.state].accept) {
        out.push(node.codes.map((c) => String.fromCodePoint(c)).join(''));
        if (out.length >= limit) return out;
      }
    }
    const next: { state: number; codes: number[] }[] = [];
    for (const node of frontier) {
      for (const a of order) {
        const t = dfa.table[node.state][a];
        if (t >= 0) next.push({ state: t, codes: [...node.codes, atomRep(dfa.atoms[a])] });
      }
    }
    frontier = next;
  }
  return out;
}

export function analyzeLanguage(dfa: DFA, opts: { maxLen?: number; examples?: number } = {}): LanguageInfo {
  const maxLen = opts.maxLen ?? 8;
  const exampleLimit = opts.examples ?? 12;
  const { live } = liveStates(dfa);
  const shortest = shortestString(dfa);
  const isEmpty = shortest === null;
  const finite = isEmpty ? true : !hasCycle(dfa, live);

  const counts = countsByLength(dfa, maxLen);
  const cumulative: bigint[] = [];
  let run = 0n;
  for (const c of counts) { run += c; cumulative.push(run); }

  let totalIfFinite: bigint | null = null;
  if (finite && !isEmpty) {
    // Every member is shorter than the number of states.
    const full = countsByLength(dfa, Math.max(1, dfa.states.length));
    totalIfFinite = full.reduce((acc, c) => acc + c, 0n);
  } else if (isEmpty) {
    totalIfFinite = 0n;
  }

  const examplesExact = dfa.atoms.every((at) => at.set.size() === 1);
  const examples = enumerate(dfa, exampleLimit, Math.max(maxLen, 12));

  return {
    empty: isEmpty,
    finite,
    shortest,
    countsByLength: counts,
    cumulative,
    totalIfFinite,
    examples,
    examplesExact,
  };
}
