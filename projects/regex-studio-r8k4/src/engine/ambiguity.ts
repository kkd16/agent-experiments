// Ambiguity & multiplicity — how many distinct accepting *runs* does one word
// have? That number is an NFA's **degree of ambiguity**, and the Weber–Seidl
// theorem (1991) puts every NFA in exactly one of four classes, each decided by
// a structural criterion on the trimmed machine:
//
//   UNAMBIGUOUS      ≤ 1 run for every word
//        ⊂ FINITELY  a constant cap C on the number of runs
//        ⊂ POLYNOMIAL runs grow like nᵈ for an integer degree d ≥ 1
//        ⊂ EXPONENTIAL runs grow like 2^Θ(n)
//
// The two combinatorial witnesses (Weber & Seidl, "On the degree of ambiguity of
// finite automata", TCS 1991; Allauzen–Mohri–Rastogi, "General algorithms for
// testing the ambiguity of finite automata", 2011):
//
//   • EDA  — a state q and a non-empty word v admitting TWO distinct cycles
//            q ─v→ q. ⇔ in the squared automaton N×N an SCC touches both the
//            diagonal (q,q) and an off-diagonal (a,b≠a). EDA ⇔ exponential.
//            (This is *exactly* the studio's ReDoS exponential condition.)
//   • IDA  — distinct states p≠q and a non-empty word v with p─v→p, p─v→q and
//            q─v→q simultaneously. ⇔ in the triple automaton N×N×N a path
//            (p,p,q) ⇝ (p,q,q). No-EDA + no-IDA ⇔ finitely ambiguous; otherwise
//            the DEGREE of polynomial ambiguity is the longest chain of states
//            linked by IDA (a longest path in the acyclic IDA relation).
//
// We analyse the studio's ε-free **Glushkov position automaton** (so runs are
// genuine position-paths and there are no ε-cycles to make "runs" infinite), and
// — house style — prove the structural verdict against a brute-force run count
// over the pattern's symbol *atoms*, with the total run count Rₙ pinned to an
// exact integer transfer matrix Rₙ = e₀ᵀ Bⁿ f.

import type { RegexNode } from './ast';
import { CharSet } from './charset';
import { buildGlushkov, type PositionAutomaton } from './glushkov';

// --- An ε-free NFA (the Glushkov automaton, lowered to plain adjacency) ------

export interface ENFA {
  n: number; // states 0…n-1 (0 is the Glushkov start ι; 1…m are positions)
  initial: number; // single initial state (always 0)
  accept: boolean[]; // accepting flags
  out: { to: number; set: CharSet }[][]; // adjacency; every edge carries a class
  positions: CharSet[]; // [p] = class at state p ([0] unused), for labelling
}

export function glushkovENFA(pa: PositionAutomaton): ENFA {
  const n = pa.m + 1;
  const out: { to: number; set: CharSet }[][] = Array.from({ length: n }, () => []);
  for (const e of pa.edges) out[e.from].push({ to: e.to, set: e.set });
  const accept = new Array<boolean>(n).fill(false);
  for (const p of pa.last) accept[p] = true;
  if (pa.nullableStart) accept[0] = true;
  return { n, initial: 0, accept, out, positions: pa.positions };
}

// Trim: a state is *useful* iff it is reachable from the initial state AND can
// reach an accepting state. Dead and unreachable states host no realisable run,
// so the ambiguity criteria only quantify over useful states.
export function usefulStates(a: ENFA): boolean[] {
  const fwd = new Array<boolean>(a.n).fill(false);
  const st = [a.initial];
  fwd[a.initial] = true;
  while (st.length) {
    const s = st.pop()!;
    for (const e of a.out[s])
      if (!fwd[e.to]) {
        fwd[e.to] = true;
        st.push(e.to);
      }
  }
  const rev: number[][] = Array.from({ length: a.n }, () => []);
  for (let s = 0; s < a.n; s++) for (const e of a.out[s]) rev[e.to].push(s);
  const back = new Array<boolean>(a.n).fill(false);
  const st2: number[] = [];
  for (let s = 0; s < a.n; s++)
    if (a.accept[s]) {
      back[s] = true;
      st2.push(s);
    }
  while (st2.length) {
    const s = st2.pop()!;
    for (const p of rev[s])
      if (!back[p]) {
        back[p] = true;
        st2.push(p);
      }
  }
  return fwd.map((f, i) => f && back[i]);
}

// --- The squared product N×N (unambiguity + EDA) ----------------------------

interface Prod2 {
  // reachable product nodes encoded as a*n+b, with their successor edges
  adj: Map<number, { to: number; ch: number }[]>;
  order: number[]; // discovery order (Tarjan input)
  parent: Map<number, { from: number; ch: number }>; // BFS tree from (0,0)
  n: number;
}

// One synchronized step of k tracks: pick an edge out of each track over a
// COMMON non-empty character class, returning a representative code point.
function syncSucc(a: ENFA, useful: boolean[], tracks: number[]): { tracks: number[]; ch: number }[] {
  const choices = tracks.map((s) => a.out[s].filter((e) => useful[e.to]));
  const out: { tracks: number[]; ch: number }[] = [];
  const rec = (i: number, picked: number[], inter: CharSet | null): void => {
    if (i === tracks.length) {
      const c = (inter as CharSet).samplePrintable() ?? (inter as CharSet).sample();
      if (c === null) return;
      out.push({ tracks: picked.slice(), ch: c });
      return;
    }
    for (const e of choices[i]) {
      const ni = inter === null ? e.set : inter.intersect(e.set);
      if (ni.isEmpty()) continue;
      picked.push(e.to);
      rec(i + 1, picked, ni);
      picked.pop();
    }
  };
  rec(0, [], null);
  return out;
}

function buildProd2(a: ENFA, useful: boolean[]): Prod2 {
  const n = a.n;
  const adj = new Map<number, { to: number; ch: number }[]>();
  const order: number[] = [];
  const parent = new Map<number, { from: number; ch: number }>();
  const start = a.initial * n + a.initial;
  const seen = new Set<number>([start]);
  const queue = [start];
  while (queue.length) {
    const cur = queue.shift()!;
    const x = Math.floor(cur / n);
    const y = cur % n;
    const succ = syncSucc(a, useful, [x, y]).map((s) => ({ to: s.tracks[0] * n + s.tracks[1], ch: s.ch }));
    adj.set(cur, succ);
    order.push(cur);
    for (const e of succ)
      if (!seen.has(e.to)) {
        seen.add(e.to);
        parent.set(e.to, { from: cur, ch: e.ch });
        queue.push(e.to);
      }
  }
  return { adj, order, parent, n };
}

// Tarjan's SCC over the reachable product graph (iterative).
function tarjan(order: number[], adj: Map<number, { to: number; ch: number }[]>): Map<number, number> {
  const index = new Map<number, number>();
  const low = new Map<number, number>();
  const onStack = new Set<number>();
  const stack: number[] = [];
  const comp = new Map<number, number>();
  let idx = 0;
  let nextComp = 0;
  for (const root of order) {
    if (index.has(root)) continue;
    const work: { node: number; ei: number }[] = [{ node: root, ei: 0 }];
    while (work.length) {
      const frame = work[work.length - 1];
      const v = frame.node;
      if (frame.ei === 0) {
        index.set(v, idx);
        low.set(v, idx);
        idx++;
        stack.push(v);
        onStack.add(v);
      }
      const edges = adj.get(v)!;
      if (frame.ei < edges.length) {
        const w = edges[frame.ei].to;
        frame.ei++;
        if (!index.has(w)) work.push({ node: w, ei: 0 });
        else if (onStack.has(w)) low.set(v, Math.min(low.get(v)!, index.get(w)!));
      } else {
        if (low.get(v) === index.get(v)) {
          for (;;) {
            const w = stack.pop()!;
            onStack.delete(w);
            comp.set(w, nextComp);
            if (w === v) break;
          }
          nextComp++;
        }
        work.pop();
        if (work.length) {
          const parent = work[work.length - 1].node;
          low.set(parent, Math.min(low.get(parent)!, low.get(v)!));
        }
      }
    }
  }
  return comp;
}

// Shortest word (as code points) driving the product from (0,0) to `enc`.
function wordToProd(p2: Prod2, enc: number): number[] {
  const chars: number[] = [];
  let cur = enc;
  const start = 0; // a.initial is 0, so (0,0) encodes to 0
  while (cur !== start) {
    const pe = p2.parent.get(cur);
    if (!pe) break;
    chars.push(pe.ch);
    cur = pe.from;
  }
  chars.reverse();
  return chars;
}

// --- EDA detection on the squared product -----------------------------------

export interface EdaWitness {
  pivot: number; // the state q with two distinct same-word cycles
  prefix: string; // a word reaching (q,q)
  pump: string; // a non-empty word labelling two distinct cycles q ─pump→ q
  suffix: string; // a word from q to an accepting state — so prefix·pumpᵏ·suffix is accepted
}

// Shortest word (code points) from state `from` to any accepting state.
function shortestToAccept(a: ENFA, from: number): number[] {
  if (a.accept[from]) return [];
  const parent = new Map<number, { from: number; ch: number }>();
  const seen = new Set<number>([from]);
  const queue = [from];
  let goal = -1;
  while (queue.length) {
    const s = queue.shift()!;
    if (a.accept[s]) {
      goal = s;
      break;
    }
    for (const e of a.out[s]) {
      if (seen.has(e.to)) continue;
      seen.add(e.to);
      parent.set(e.to, { from: s, ch: e.set.samplePrintable() ?? e.set.sample() ?? 0 });
      queue.push(e.to);
    }
  }
  if (goal < 0) return [];
  const chars: number[] = [];
  let cur = goal;
  while (cur !== from) {
    const pe = parent.get(cur)!;
    chars.push(pe.ch);
    cur = pe.from;
  }
  chars.reverse();
  return chars;
}

function detectEDA(a: ENFA, useful: boolean[], p2: Prod2): EdaWitness | null {
  const n = p2.n;
  const comp = tarjan(p2.order, p2.adj);
  const members = new Map<number, number[]>();
  const hasInternalEdge = new Map<number, boolean>();
  for (const node of p2.order) {
    const c = comp.get(node)!;
    (members.get(c) ?? members.set(c, []).get(c)!).push(node);
    for (const e of p2.adj.get(node)!) if (comp.get(e.to) === c) hasInternalEdge.set(c, true);
  }
  for (const [c, nodes] of members) {
    if (!hasInternalEdge.get(c)) continue; // need a real cycle in the component
    let diag = -1;
    let offDiag = false;
    for (const node of nodes) {
      if (Math.floor(node / n) === node % n) {
        if (diag < 0) diag = node;
      } else offDiag = true;
    }
    if (diag >= 0 && offDiag) {
      const q = Math.floor(diag / n);
      const prefix = String.fromCodePoint(...wordToProd(p2, diag));
      const pump = edaPump(a, useful, comp, c, diag);
      if (pump !== null && pump.length > 0) {
        const suffix = String.fromCodePoint(...shortestToAccept(a, q));
        return { pivot: q, prefix, pump, suffix };
      }
    }
  }
  return null;
}

// A pump word: a non-empty word whose product walk starts and ends at (q,q) but
// detours through an off-diagonal node — proof of two distinct cycles spelling
// the same word. BFS over (node, sawOffDiagonal) inside the component.
function edaPump(
  a: ENFA,
  useful: boolean[],
  comp: Map<number, number>,
  targetComp: number,
  diag: number,
): string | null {
  const n = a.n;
  const isOff = (enc: number) => Math.floor(enc / n) !== enc % n;
  type Key = number; // node*2 + (sawOff?1:0)
  const startKey: Key = diag * 2 + 0;
  const parent = new Map<Key, { from: Key; ch: number }>();
  const seen = new Set<Key>([startKey]);
  const queue: Key[] = [startKey];
  let goal: Key | null = null;
  while (queue.length) {
    const cur = queue.shift()!;
    const node = Math.floor(cur / 2);
    const sawOff = (cur & 1) === 1;
    if (sawOff && node === diag && cur !== startKey) {
      goal = cur;
      break;
    }
    const x = Math.floor(node / n);
    const y = node % n;
    for (const s of syncSucc(a, useful, [x, y])) {
      const enc = s.tracks[0] * n + s.tracks[1];
      if (comp.get(enc) !== targetComp) continue; // stay inside the SCC
      const key: Key = enc * 2 + (sawOff || isOff(enc) ? 1 : 0);
      if (!seen.has(key)) {
        seen.add(key);
        parent.set(key, { from: cur, ch: s.ch });
        queue.push(key);
      }
    }
  }
  if (goal === null) return null;
  const chars: number[] = [];
  let cur: Key = goal;
  while (cur !== startKey) {
    const pe = parent.get(cur)!;
    chars.push(pe.ch);
    cur = pe.from;
  }
  chars.reverse();
  return String.fromCodePoint(...chars);
}

// --- Ambiguity (the unambiguous test) on the squared product ----------------
//
// N is ambiguous ⇔ some off-diagonal product state (p,q), p≠q, is reachable
// from (i,i) AND co-reachable to a final pair (both accepting): the two runs
// agree on every letter yet visit different states, so the word has ≥2 runs.

export interface AmbWitness {
  word: string; // a concrete word with ≥ 2 distinct accepting runs
  runs: number[][]; // up to a few distinct accepting runs (sequences of states)
}

function coReachableProd(a: ENFA, p2: Prod2): Set<number> {
  const n = p2.n;
  const rev = new Map<number, number[]>();
  for (const [node, succ] of p2.adj) for (const e of succ) (rev.get(e.to) ?? rev.set(e.to, []).get(e.to)!).push(node);
  const back = new Set<number>();
  const st: number[] = [];
  for (const node of p2.order) {
    const x = Math.floor(node / n);
    const y = node % n;
    if (a.accept[x] && a.accept[y]) {
      back.add(node);
      st.push(node);
    }
  }
  while (st.length) {
    const s = st.pop()!;
    for (const p of rev.get(s) ?? [])
      if (!back.has(p)) {
        back.add(p);
        st.push(p);
      }
  }
  return back;
}

function detectAmbiguous(a: ENFA, p2: Prod2): AmbWitness | null {
  const n = p2.n;
  const co = coReachableProd(a, p2);
  // shortest word to the closest co-reachable off-diagonal node (reachable by
  // construction since p2 only holds reachable nodes).
  let best: number | null = null;
  let bestLen = Infinity;
  for (const node of p2.order) {
    if (Math.floor(node / n) === node % n) continue; // diagonal
    if (!co.has(node)) continue;
    const w = wordToProd(p2, node);
    if (w.length < bestLen) {
      bestLen = w.length;
      best = node;
    }
  }
  if (best === null) return null;
  // prefix to the off-diagonal node, then shortest suffix to a final pair.
  const prefix = wordToProd(p2, best);
  const suffix = shortestProdToFinal(a, p2, best);
  const word = String.fromCodePoint(...prefix, ...suffix);
  return { word, runs: enumerateRuns(a, word, 4) };
}

function shortestProdToFinal(a: ENFA, p2: Prod2, from: number): number[] {
  const n = p2.n;
  const parent = new Map<number, { from: number; ch: number }>();
  const seen = new Set<number>([from]);
  const queue = [from];
  let goal: number | null = null;
  while (queue.length) {
    const cur = queue.shift()!;
    const x = Math.floor(cur / n);
    const y = cur % n;
    if (a.accept[x] && a.accept[y]) {
      goal = cur;
      break;
    }
    for (const e of p2.adj.get(cur) ?? []) {
      if (!seen.has(e.to)) {
        seen.add(e.to);
        parent.set(e.to, { from: cur, ch: e.ch });
        queue.push(e.to);
      }
    }
  }
  if (goal === null) return [];
  const chars: number[] = [];
  let cur = goal;
  while (cur !== from) {
    const pe = parent.get(cur)!;
    chars.push(pe.ch);
    cur = pe.from;
  }
  chars.reverse();
  return chars;
}

// Enumerate up to `cap` distinct accepting runs (state sequences) of `word`.
export function enumerateRuns(a: ENFA, word: string, cap: number): number[][] {
  const codes = Array.from(word, (c) => c.codePointAt(0)!);
  const runs: number[][] = [];
  const path: number[] = [a.initial];
  const dfs = (state: number, i: number): void => {
    if (runs.length >= cap) return;
    if (i === codes.length) {
      if (a.accept[state]) runs.push(path.slice());
      return;
    }
    for (const e of a.out[state]) {
      if (!e.set.contains(codes[i])) continue;
      path.push(e.to);
      dfs(e.to, i + 1);
      path.pop();
      if (runs.length >= cap) return;
    }
  };
  dfs(a.initial, 0);
  return runs;
}

// --- IDA detection + the degree of polynomial ambiguity (triple product) ----

const IDA_STATE_CAP = 26; // |useful states| — keeps the per-pair N×N×N search affordable

export interface IdaWitness {
  p: number;
  q: number;
  word: string; // v with p→p, p→q, q→q
}

// Is (p,q,q) reachable from (p,p,q) over a non-empty synchronized word? If so,
// IDA(p,q) holds. Returns the witness word's code points or null.
function idaWord(a: ENFA, useful: boolean[], p: number, q: number): number[] | null {
  const n = a.n;
  const enc3 = (x: number, y: number, z: number) => (x * n + y) * n + z;
  const start = enc3(p, p, q);
  const target = enc3(p, q, q);
  const parent = new Map<number, { from: number; ch: number }>();
  const seen = new Set<number>([start]);
  const queue = [start];
  while (queue.length) {
    const cur = queue.shift()!;
    const x = Math.floor(cur / (n * n));
    const y = Math.floor(cur / n) % n;
    const z = cur % n;
    for (const s of syncSucc(a, useful, [x, y, z])) {
      const enc = enc3(s.tracks[0], s.tracks[1], s.tracks[2]);
      if (!seen.has(enc)) {
        seen.add(enc);
        parent.set(enc, { from: cur, ch: s.ch });
        queue.push(enc);
        if (enc === target) {
          const chars: number[] = [];
          let c = enc;
          while (c !== start) {
            const pe = parent.get(c)!;
            chars.push(pe.ch);
            c = pe.from;
          }
          chars.reverse();
          return chars;
        }
      }
    }
  }
  return null;
}

interface IdaResult {
  degree: number; // longest IDA chain (edges); 0 = no IDA
  edges: [number, number][]; // IDA(p,q) pairs
  witness: IdaWitness | null;
  chain: number[]; // the states realising the longest chain
  computed: boolean; // false ⇒ automaton too big, degree unknown
}

// A state lies on a cycle iff it can return to itself in ≥1 step. Only cyclic
// states can be IDA endpoints (IDA needs cycles p→p and q→q), so restricting the
// O(n²) pair search to them is sound, complete, and much faster.
function cyclicStates(a: ENFA, useful: boolean[]): boolean[] {
  const cyclic = new Array<boolean>(a.n).fill(false);
  for (let s = 0; s < a.n; s++) {
    if (!useful[s]) continue;
    const seen = new Set<number>();
    const stack: number[] = [];
    for (const e of a.out[s]) if (useful[e.to]) stack.push(e.to);
    while (stack.length) {
      const u = stack.pop()!;
      if (u === s) {
        cyclic[s] = true;
        break;
      }
      if (seen.has(u)) continue;
      seen.add(u);
      for (const e of a.out[u]) if (useful[e.to]) stack.push(e.to);
    }
  }
  return cyclic;
}

function detectIDA(a: ENFA, useful: boolean[]): IdaResult {
  const usefulCount = useful.filter(Boolean).length;
  if (usefulCount > IDA_STATE_CAP) return { degree: 0, edges: [], witness: null, chain: [], computed: false };
  const cyclic = cyclicStates(a, useful);
  const states: number[] = [];
  for (let s = 0; s < a.n; s++) if (cyclic[s]) states.push(s);
  const edges: [number, number][] = [];
  let witness: IdaWitness | null = null;
  for (const p of states)
    for (const q of states) {
      if (p === q) continue;
      const w = idaWord(a, useful, p, q);
      if (w !== null) {
        edges.push([p, q]);
        if (!witness) witness = { p, q, word: String.fromCodePoint(...w) };
      }
    }
  // Longest path in the IDA relation. With no EDA it is acyclic; guard anyway.
  const succ = new Map<number, number[]>();
  for (const [p, q] of edges) (succ.get(p) ?? succ.set(p, []).get(p)!).push(q);
  const memoLen = new Map<number, number>();
  const memoNext = new Map<number, number>();
  const inProgress = new Set<number>();
  const longest = (u: number): number => {
    if (memoLen.has(u)) return memoLen.get(u)!;
    if (inProgress.has(u)) return 0; // cycle guard (shouldn't happen without EDA)
    inProgress.add(u);
    let best = 0;
    let next = -1;
    for (const v of succ.get(u) ?? []) {
      const l = 1 + longest(v);
      if (l > best) {
        best = l;
        next = v;
      }
    }
    inProgress.delete(u);
    memoLen.set(u, best);
    memoNext.set(u, next);
    return best;
  };
  let degree = 0;
  let head = -1;
  for (const s of states) {
    const l = longest(s);
    if (l > degree) {
      degree = l;
      head = s;
    }
  }
  const chain: number[] = [];
  const seenChain = new Set<number>(); // guard a cyclic IDA relation (only arises alongside EDA)
  let cur = head;
  while (cur >= 0 && !seenChain.has(cur)) {
    seenChain.add(cur);
    chain.push(cur);
    cur = memoNext.get(cur) ?? -1;
  }
  return { degree, edges, witness, chain, computed: true };
}

// --- Symbol atoms: a finite alphabet that realises every behaviour ----------
//
// All counting/brute-force happens over the partition of code points induced by
// the pattern's character classes: two symbols in the same atom are
// interchangeable for every position, so one representative per atom suffices.

export interface Atoms {
  reps: number[]; // one representative code point per non-empty atom
  labels: string[]; // a readable label per atom
  ok: boolean; // false ⇒ too many atoms; live counts skipped
}

const ATOM_CAP = 12;

export function symbolAtoms(a: ENFA): Atoms {
  // distinct classes appearing on edges
  const classes: CharSet[] = [];
  const keys = new Set<string>();
  for (let s = 0; s < a.n; s++)
    for (const e of a.out[s]) {
      const k = e.set.key();
      if (!keys.has(k)) {
        keys.add(k);
        classes.push(e.set);
      }
    }
  // refine the universe into atoms
  let parts: CharSet[] = [CharSet.fromRange(0, 0x10ffff)];
  for (const c of classes) {
    const next: CharSet[] = [];
    for (const p of parts) {
      const inside = p.intersect(c);
      const outside = p.intersect(c.negate());
      if (!inside.isEmpty()) next.push(inside);
      if (!outside.isEmpty()) next.push(outside);
    }
    parts = next;
    if (parts.length > ATOM_CAP) return { reps: [], labels: [], ok: false };
  }
  const reps: number[] = [];
  const labels: string[] = [];
  for (const p of parts) {
    const r = p.samplePrintable() ?? p.sample();
    if (r === null) continue;
    reps.push(r);
    labels.push(p.label());
  }
  return { reps, labels, ok: reps.length > 0 };
}

// --- Exact total run count via the integer transfer matrix Rₙ = e₀ᵀ Bⁿ f ----
//
// B[i][j] = number of atom-representatives σ with an edge i ─σ→ j. Then Rₙ is
// the total number of (word, accepting-run) pairs over atom-words of length n.

export function transferRuns(a: ENFA, reps: number[], maxLen: number): bigint[] {
  const n = a.n;
  const B: bigint[][] = Array.from({ length: n }, () => new Array<bigint>(n).fill(0n));
  for (let i = 0; i < n; i++)
    for (const e of a.out[i]) {
      let c = 0n;
      for (const r of reps) if (e.set.contains(r)) c++;
      B[i][e.to] += c;
    }
  // vector iteration: v₀ = e₀ (the initial indicator); Rₙ = vₙ · f
  let v = new Array<bigint>(n).fill(0n);
  v[a.initial] = 1n;
  const f = a.accept.map((x) => (x ? 1n : 0n));
  const out: bigint[] = [];
  for (let len = 0; len <= maxLen; len++) {
    let r = 0n;
    for (let i = 0; i < n; i++) r += v[i] * f[i];
    out.push(r);
    const nv = new Array<bigint>(n).fill(0n);
    for (let i = 0; i < n; i++) {
      if (v[i] === 0n) continue;
      for (let j = 0; j < n; j++) if (B[i][j]) nv[j] += v[i] * B[i][j];
    }
    v = nv;
  }
  return out;
}

// --- Brute force over atom-words: am(n) and total runs ----------------------

export interface BruteCounts {
  amb: number[]; // amb[n] = max distinct accepting runs over atom-words of length n
  total: bigint[]; // total[n] = Σ over atom-words of length n of (#accepting runs)
  words: bigint[]; // words[n] = # distinct accepted atom-words of length n (the census)
  maxLen: number;
}

// Run-count vector DP: count[state] = #position-paths from the initial spelling
// the prefix and ending at `state`. amb is the max of count·f over all words.
export function bruteCounts(a: ENFA, reps: number[], maxLen: number): BruteCounts {
  const n = a.n;
  const amb = new Array<number>(maxLen + 1).fill(0);
  const total = new Array<bigint>(maxLen + 1).fill(0n);
  const words = new Array<bigint>(maxLen + 1).fill(0n);
  // precompute per-symbol transition: for each rep, list of (i -> j) edges
  const trans = reps.map((r) => {
    const m: number[][] = Array.from({ length: n }, () => []);
    for (let i = 0; i < n; i++) for (const e of a.out[i]) if (e.set.contains(r)) m[i].push(e.to);
    return m;
  });
  const f = a.accept;
  // DFS over atom-words carrying the run-count vector (a Map of state→count).
  const startVec = new Map<number, bigint>([[a.initial, 1n]]);
  const visit = (vec: Map<number, bigint>, len: number): void => {
    let acc = 0n;
    for (const [s, c] of vec) if (f[s]) acc += c;
    total[len] += acc;
    if (acc > 0n) words[len] += 1n;
    const a2 = acc > BigInt(Number.MAX_SAFE_INTEGER) ? Number.MAX_SAFE_INTEGER : Number(acc);
    if (a2 > amb[len]) amb[len] = a2;
    if (len === maxLen) return;
    for (let r = 0; r < reps.length; r++) {
      const nv = new Map<number, bigint>();
      for (const [s, c] of vec)
        for (const j of trans[r][s]) nv.set(j, (nv.get(j) ?? 0n) + c);
      if (nv.size) visit(nv, len + 1);
    }
  };
  visit(startVec, 0);
  return { amb, total, words, maxLen };
}

// --- The public verdict -----------------------------------------------------

export type AmbClass = 'unambiguous' | 'finite' | 'polynomial' | 'exponential';

export interface AmbiguityReport {
  ok: boolean; // false ⇒ not a regular pattern / too big to analyse
  reason?: string;
  klass: AmbClass;
  degree: number; // 0 unamb/finite, d for polynomial, ∞ for exp, NaN if degree not computed
  degreeKnown: boolean; // false ⇒ ambiguous & sub-exponential, but the exact degree was not computed
  usefulCount: number;
  stateCount: number;
  eda: EdaWitness | null;
  ida: IdaWitness | null;
  idaComputed: boolean;
  ambWitness: AmbWitness | null; // a word with ≥2 runs (null ⇒ unambiguous)
  idaChain: number[]; // the states realising the polynomial degree
  positions: CharSet[];
}

const SQUARE_STATE_CAP = 150; // |useful states| for the N×N tests

export function analyzeAmbiguity(ast: RegexNode): AmbiguityReport {
  let pa: PositionAutomaton;
  try {
    pa = buildGlushkov(ast);
  } catch {
    return blank('Pattern is too large to build its position automaton.');
  }
  const a = glushkovENFA(pa);
  const useful = usefulStates(a);
  const usefulCount = useful.filter(Boolean).length;
  if (usefulCount === 0) {
    return {
      ...blank(),
      ok: true,
      klass: 'unambiguous',
      reason: 'The language is empty — no word has any run at all.',
      stateCount: a.n,
      positions: a.positions,
    };
  }
  if (usefulCount > SQUARE_STATE_CAP) return blank(`Automaton has ${usefulCount} useful states — above the analysis budget.`);

  const p2 = buildProd2(a, useful);
  const ambWitness = detectAmbiguous(a, p2);
  const eda = detectEDA(a, useful, p2);
  const ida = detectIDA(a, useful);

  // The squared product (cap 150) decides unambiguity and EDA outright; the
  // cubed product (cap 26) refines the polynomial degree. Weber–Seidl: no EDA ⇔
  // polynomially bounded, and no EDA ∧ no IDA ⇔ finitely ambiguous.
  let klass: AmbClass;
  let degree: number;
  let degreeKnown = true;
  if (!ambWitness) {
    klass = 'unambiguous';
    degree = 0;
  } else if (eda) {
    klass = 'exponential';
    degree = Number.POSITIVE_INFINITY;
  } else if (ida.computed) {
    if (ida.degree >= 1) {
      klass = 'polynomial';
      degree = ida.degree;
    } else {
      klass = 'finite';
      degree = 0;
    }
  } else {
    // ambiguous, not exponential, but too large for the cubed test: the exact
    // degree is unknown — it is polynomially bounded (finite or higher degree).
    klass = 'polynomial';
    degree = Number.NaN;
    degreeKnown = false;
  }

  return {
    ok: true,
    klass,
    degree,
    degreeKnown,
    usefulCount,
    stateCount: a.n,
    eda,
    ida: ida.witness,
    idaComputed: ida.computed,
    ambWitness,
    idaChain: ida.chain,
    positions: a.positions,
  };
}

function blank(reason?: string): AmbiguityReport {
  return {
    ok: false,
    reason,
    klass: 'unambiguous',
    degree: 0,
    degreeKnown: true,
    usefulCount: 0,
    stateCount: 0,
    eda: null,
    ida: null,
    idaComputed: false,
    ambWitness: null,
    idaChain: [],
    positions: [],
  };
}

// A label for a state (the Glushkov start ι, or a position's class).
export function stateLabel(report: AmbiguityReport, s: number): string {
  if (s === 0) return 'ι';
  const cls = report.positions[s];
  return cls ? `${s}:${cls.label()}` : String(s);
}
