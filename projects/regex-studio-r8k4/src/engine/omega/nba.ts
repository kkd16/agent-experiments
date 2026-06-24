// Büchi automata over a finite alphabet Σ — both the *generalized* form (GBA,
// several accepting sets, each to be visited infinitely often) the GPVW tableau
// produces, and the plain NBA (one accepting set) it degeneralizes to. Plus the
// only decision procedure that matters for ω-words: a reachable accepting cycle,
// whose witness is a **lasso** u·vᵒ.

import type { GraphInput } from '../layout';

// A guard is the set of Σ-letters that may be read on an edge. Each ω-word
// position carries exactly one letter, so a guard derived from propositional
// literals is just a subset of Σ (two distinct *positive* literals ⇒ ∅).
export interface BuchiEdge {
  from: number;
  to: number;
  letters: string[]; // a non-empty subset of Σ (empty-guard edges are dropped)
}

export interface GBA {
  stateCount: number;
  start: number[];
  edges: BuchiEdge[];
  acceptSets: number[][]; // each an accepting set; a run must hit every set i.o.
  alphabet: string[];
  labels: string[]; // a short display label per state
}

export interface NBA {
  stateCount: number;
  start: number[];
  edges: BuchiEdge[];
  accept: Set<number>;
  alphabet: string[];
  labels: string[];
}

export class OmegaError extends Error {}

export interface Literal {
  pos: boolean;
  letter: string;
}

// The Σ-letters consistent with a conjunction of propositional literals.
export function lettersSatisfying(lits: Literal[], alphabet: string[]): string[] {
  const positives = new Set<string>();
  const negatives = new Set<string>();
  for (const l of lits) (l.pos ? positives : negatives).add(l.letter);
  if (positives.size >= 2) return []; // need two distinct letters at one position
  if (positives.size === 1) {
    const a = [...positives][0];
    if (negatives.has(a) || !alphabet.includes(a)) return [];
    return [a];
  }
  return alphabet.filter((c) => !negatives.has(c)).slice();
}

export function formatLetters(letters: string[], alphabet: string[]): string {
  if (letters.length === 0) return '∅';
  if (letters.length === alphabet.length) return 'Σ';
  return letters.join(',');
}

// ── degeneralization GBA → NBA (Baier–Katoen counter construction) ───────────
export function degeneralize(gba: GBA): NBA {
  const k = gba.acceptSets.length;
  // No Until-derived constraint ⇒ the GBA accepts every infinite run; every
  // state is accepting and the structure is unchanged.
  if (k === 0) {
    return {
      stateCount: gba.stateCount,
      start: gba.start.slice(),
      edges: gba.edges.map((e) => ({ ...e, letters: e.letters.slice() })),
      accept: new Set(Array.from({ length: gba.stateCount }, (_, i) => i)),
      alphabet: gba.alphabet.slice(),
      labels: gba.labels.slice(),
    };
  }
  const inSet = gba.acceptSets.map((set) => new Set(set));
  const id = (q: number, i: number) => q * k + i;
  const newCount = gba.stateCount * k;
  const start = gba.start.map((q) => id(q, 0));
  const edges: BuchiEdge[] = [];
  for (const e of gba.edges) {
    for (let i = 0; i < k; i++) {
      const j = inSet[i].has(e.from) ? (i + 1) % k : i;
      edges.push({ from: id(e.from, i), to: id(e.to, j), letters: e.letters.slice() });
    }
  }
  const accept = new Set<number>();
  for (let q = 0; q < gba.stateCount; q++) if (inSet[0].has(q)) accept.add(id(q, 0));
  const labels: string[] = new Array(newCount);
  for (let q = 0; q < gba.stateCount; q++)
    for (let i = 0; i < k; i++) labels[id(q, i)] = `${gba.labels[q]}·${i}`;
  return { stateCount: newCount, start, edges, accept, alphabet: gba.alphabet.slice(), labels };
}

// ── reachable-trim (keeps the graphs readable) ───────────────────────────────
function reachable(stateCount: number, start: number[], edges: BuchiEdge[]): boolean[] {
  const adj: number[][] = Array.from({ length: stateCount }, () => []);
  for (const e of edges) adj[e.from].push(e.to);
  const seen = new Array(stateCount).fill(false);
  const stack = [...start];
  for (const s of start) seen[s] = true;
  while (stack.length) {
    const q = stack.pop()!;
    for (const t of adj[q]) if (!seen[t]) { seen[t] = true; stack.push(t); }
  }
  return seen;
}

export function trimNBA(nba: NBA): NBA {
  const seen = reachable(nba.stateCount, nba.start, nba.edges);
  const map = new Array(nba.stateCount).fill(-1);
  let n = 0;
  for (let i = 0; i < nba.stateCount; i++) if (seen[i]) map[i] = n++;
  const labels: string[] = new Array(n);
  for (let i = 0; i < nba.stateCount; i++) if (seen[i]) labels[map[i]] = nba.labels[i];
  return {
    stateCount: n,
    start: nba.start.filter((s) => seen[s]).map((s) => map[s]),
    edges: nba.edges.filter((e) => seen[e.from] && seen[e.to]).map((e) => ({ from: map[e.from], to: map[e.to], letters: e.letters.slice() })),
    accept: new Set([...nba.accept].filter((s) => seen[s]).map((s) => map[s])),
    alphabet: nba.alphabet.slice(),
    labels,
  };
}

export function trimGBA(gba: GBA): GBA {
  const seen = reachable(gba.stateCount, gba.start, gba.edges);
  const map = new Array(gba.stateCount).fill(-1);
  let n = 0;
  for (let i = 0; i < gba.stateCount; i++) if (seen[i]) map[i] = n++;
  const labels: string[] = new Array(n);
  for (let i = 0; i < gba.stateCount; i++) if (seen[i]) labels[map[i]] = gba.labels[i];
  return {
    stateCount: n,
    start: gba.start.filter((s) => seen[s]).map((s) => map[s]),
    edges: gba.edges.filter((e) => seen[e.from] && seen[e.to]).map((e) => ({ from: map[e.from], to: map[e.to], letters: e.letters.slice() })),
    acceptSets: gba.acceptSets.map((set) => set.filter((s) => seen[s]).map((s) => map[s])),
    alphabet: gba.alphabet.slice(),
    labels,
  };
}

// ── Tarjan SCCs over a plain directed graph ──────────────────────────────────
export function tarjanSCC(stateCount: number, adj: number[][]): { comp: number[]; count: number } {
  const comp = new Array(stateCount).fill(-1);
  const index = new Array(stateCount).fill(-1);
  const low = new Array(stateCount).fill(0);
  const onStack = new Array(stateCount).fill(false);
  const stack: number[] = [];
  let idx = 0;
  let count = 0;
  // iterative Tarjan to avoid deep recursion on large automata
  for (let s = 0; s < stateCount; s++) {
    if (index[s] !== -1) continue;
    const work: { v: number; pi: number }[] = [{ v: s, pi: 0 }];
    while (work.length) {
      const frame = work[work.length - 1];
      const v = frame.v;
      if (frame.pi === 0) {
        index[v] = low[v] = idx++;
        stack.push(v);
        onStack[v] = true;
      }
      if (frame.pi < adj[v].length) {
        const w = adj[v][frame.pi++];
        if (index[w] === -1) {
          work.push({ v: w, pi: 0 });
        } else if (onStack[w]) {
          low[v] = Math.min(low[v], index[w]);
        }
      } else {
        if (low[v] === index[v]) {
          while (true) {
            const w = stack.pop()!;
            onStack[w] = false;
            comp[w] = count;
            low[w] = low[v]; // keep low consistent for parents reading min
            if (w === v) break;
          }
          count++;
        }
        work.pop();
        if (work.length) low[work[work.length - 1].v] = Math.min(low[work[work.length - 1].v], low[v]);
      }
    }
  }
  return { comp, count };
}

// Does a Büchi-like graph have a reachable accepting cycle? (ω-emptiness.)
// `accept` is the set of accepting states; a non-trivial SCC (a cycle exists)
// reachable from a start state and containing an accepting state ⇒ non-empty.
function hasAcceptingLasso(stateCount: number, start: number[], adj: number[][], accept: Set<number>): boolean {
  const seen = new Array(stateCount).fill(false);
  const stack = [...start];
  for (const s of start) seen[s] = true;
  while (stack.length) {
    const q = stack.pop()!;
    for (const t of adj[q]) if (!seen[t]) { seen[t] = true; stack.push(t); }
  }
  const { comp, count } = tarjanSCC(stateCount, adj);
  // mark SCCs that contain an internal edge (so a real cycle exists)
  const hasCycle = new Array(count).fill(false);
  const selfLoopOk = new Array(stateCount).fill(false);
  for (let v = 0; v < stateCount; v++) {
    for (const w of adj[v]) {
      if (comp[v] === comp[w]) {
        if (v !== w) hasCycle[comp[v]] = true;
        else selfLoopOk[v] = true;
      }
    }
  }
  const compHasAccept = new Array(count).fill(false);
  const compSize = new Array(count).fill(0);
  for (let v = 0; v < stateCount; v++) {
    compSize[comp[v]]++;
    if (accept.has(v)) compHasAccept[comp[v]] = true;
  }
  for (let v = 0; v < stateCount; v++) {
    if (!seen[v] || !accept.has(v)) continue;
    const c = comp[v];
    // an accepting state lies on a cycle if its SCC has ≥2 nodes with an
    // internal edge, or it self-loops.
    if ((compSize[c] > 1 && hasCycle[c]) || selfLoopOk[v]) return true;
  }
  return false;
}

function adjOf(stateCount: number, edges: BuchiEdge[]): number[][] {
  const adj: number[][] = Array.from({ length: stateCount }, () => []);
  for (const e of edges) adj[e.from].push(e.to);
  return adj;
}

export function isEmpty(nba: NBA): boolean {
  return !hasAcceptingLasso(nba.stateCount, nba.start, adjOf(nba.stateCount, nba.edges), nba.accept);
}

// ── a lasso witness u·vᵒ for a non-empty NBA ─────────────────────────────────
export interface Lasso {
  stem: string[]; // letters u
  loop: string[]; // letters v (non-empty)
  stemStates: number[]; // states visited reading u, ending at the loop anchor
  loopStates: number[]; // states visited around the loop (anchor … back-to-anchor edge implicit)
}

interface FullEdge { to: number; letter: string }

// BFS over the labelled graph: shortest path of states/letters from any start
// to `target`. Returns null if unreachable.
function bfsTo(start: number[], target: number, ladj: FullEdge[][]): { states: number[]; letters: string[] } | null {
  const prev = new Map<number, { from: number; letter: string }>();
  const seen = new Set<number>(start);
  const queue = [...start];
  if (start.includes(target)) return { states: [target], letters: [] };
  while (queue.length) {
    const q = queue.shift()!;
    for (const e of ladj[q]) {
      if (seen.has(e.to)) continue;
      seen.add(e.to);
      prev.set(e.to, { from: q, letter: e.letter });
      if (e.to === target) {
        const states = [target];
        const letters: string[] = [];
        let cur = target;
        while (prev.has(cur)) {
          const p = prev.get(cur)!;
          letters.unshift(p.letter);
          states.unshift(p.from);
          cur = p.from;
        }
        return { states, letters };
      }
      queue.push(e.to);
    }
  }
  return null;
}

// A cycle of length ≥1 anchored at `f`, staying inside the component `inComp`.
function cycleThrough(f: number, ladj: FullEdge[][], inComp: (q: number) => boolean): { states: number[]; letters: string[] } | null {
  // BFS from f's successors back to f, restricted to the component.
  const prev = new Map<number, { from: number; letter: string }>();
  const seen = new Set<number>();
  const queue: number[] = [];
  for (const e of ladj[f]) {
    if (!inComp(e.to)) continue;
    if (e.to === f) return { states: [f], letters: [e.letter] }; // self-loop
    if (!seen.has(e.to)) {
      seen.add(e.to);
      prev.set(e.to, { from: f, letter: e.letter });
      queue.push(e.to);
    }
  }
  while (queue.length) {
    const q = queue.shift()!;
    for (const e of ladj[q]) {
      if (!inComp(e.to)) continue;
      if (e.to === f) {
        const letters = [e.letter];
        const states = [q];
        let cur = q;
        while (prev.has(cur)) {
          const p = prev.get(cur)!;
          letters.unshift(p.letter);
          states.unshift(p.from);
          cur = p.from;
        }
        return { states, letters };
      }
      if (!seen.has(e.to)) {
        seen.add(e.to);
        prev.set(e.to, { from: q, letter: e.letter });
        queue.push(e.to);
      }
    }
  }
  return null;
}

export function witness(nba: NBA): Lasso | null {
  const adj = adjOf(nba.stateCount, nba.edges);
  const ladj: FullEdge[][] = Array.from({ length: nba.stateCount }, () => []);
  for (const e of nba.edges) if (e.letters.length) ladj[e.from].push({ to: e.to, letter: e.letters[0] });

  const seen = reachable(nba.stateCount, nba.start, nba.edges);
  const { comp, count } = tarjanSCC(nba.stateCount, adj);
  const hasCycle = new Array(count).fill(false);
  const selfLoop = new Array(nba.stateCount).fill(false);
  const compSize = new Array(count).fill(0);
  for (let v = 0; v < nba.stateCount; v++) compSize[comp[v]]++;
  for (let v = 0; v < nba.stateCount; v++) {
    for (const w of adj[v]) {
      if (comp[v] === comp[w]) {
        if (v !== w) hasCycle[comp[v]] = true;
        else selfLoop[v] = true;
      }
    }
  }
  // pick the accepting state that lies on a cycle, with the shortest stem.
  let best: Lasso | null = null;
  for (let f = 0; f < nba.stateCount; f++) {
    if (!seen[f] || !nba.accept.has(f)) continue;
    const c = comp[f];
    if (!((compSize[c] > 1 && hasCycle[c]) || selfLoop[f])) continue;
    const stem = bfsTo(nba.start, f, ladj);
    if (!stem) continue;
    const loop = cycleThrough(f, ladj, (q) => comp[q] === c);
    if (!loop) continue;
    const lasso: Lasso = { stem: stem.letters, loop: loop.letters, stemStates: stem.states, loopStates: loop.states };
    if (!best || lasso.stem.length + lasso.loop.length < best.stem.length + best.loop.length) best = lasso;
  }
  return best;
}

// ── does a concrete lasso u·vᵒ have an accepting NBA run? ─────────────────────
// Product of the NBA with the cyclic position structure of the word; the word
// is accepted iff that product has a reachable accepting cycle (its emptiness).
export function nbaAcceptsLasso(nba: NBA, u: string[], v: string[]): boolean {
  if (v.length === 0) return false; // not a valid ω-word
  const m = u.length + v.length;
  const loopStart = u.length;
  const letterAt = (c: number) => (c < u.length ? u[c] : v[c - u.length]);
  const succ = (c: number) => (c < m - 1 ? c + 1 : loopStart);
  // product states (q, c) → id q*m + c
  const id = (q: number, c: number) => q * m + c;
  const prodCount = nba.stateCount * m;
  const adj: number[][] = Array.from({ length: prodCount }, () => []);
  // index edges by (from-state) for the letter check
  const byFrom: BuchiEdge[][] = Array.from({ length: nba.stateCount }, () => []);
  for (const e of nba.edges) byFrom[e.from].push(e);
  for (let q = 0; q < nba.stateCount; q++) {
    for (let c = 0; c < m; c++) {
      const a = letterAt(c);
      const nc = succ(c);
      for (const e of byFrom[q]) if (e.letters.includes(a)) adj[id(q, c)].push(id(e.to, nc));
    }
  }
  const start = nba.start.map((q) => id(q, 0));
  const accept = new Set<number>();
  for (const q of nba.accept) for (let c = 0; c < m; c++) accept.add(id(q, c));
  return hasAcceptingLasso(prodCount, start, adj, accept);
}

// ── graph-input adapters (reusing the studio's layered SVG renderer) ─────────
export function nbaToGraph(nba: NBA): GraphInput {
  return buchiToGraph(nba.stateCount, nba.start, nba.edges, nba.accept, nba.labels, nba.alphabet);
}

export function gbaToGraph(gba: GBA): GraphInput {
  // mark a state accepting (for the double ring) if it is in *every* accept set
  // — only those are "always accepting"; the panel lists the sets separately.
  const inAll = new Set<number>();
  if (gba.acceptSets.length > 0) {
    for (let q = 0; q < gba.stateCount; q++) {
      if (gba.acceptSets.every((set) => set.includes(q))) inAll.add(q);
    }
  }
  return buchiToGraph(gba.stateCount, gba.start, gba.edges, inAll, gba.labels, gba.alphabet);
}

function buchiToGraph(
  stateCount: number,
  start: number[],
  edges: BuchiEdge[],
  accept: Set<number>,
  labels: string[],
  alphabet: string[],
): GraphInput {
  // A synthetic init marker node ι so every initial state shows its start arrow
  // and the layout layers cleanly even with several initial states.
  const iota = stateCount;
  const nodes = [
    ...Array.from({ length: stateCount }, (_, id) => ({ id, label: labels[id] ?? String(id) })),
    { id: iota, label: 'ι' },
  ];
  const gedges = edges.map((e) => ({
    from: e.from,
    to: e.to,
    // a transition is labelled by the letter it consumes = the SOURCE state's
    // guard (state-labelled GPVW rendered as a transition-labelled NBA).
    label: formatLetters(e.letters, alphabet),
    epsilon: false,
  }));
  for (const s of start) gedges.push({ from: iota, to: s, label: '', epsilon: true });
  return { nodes, edges: gedges, start: iota, accepts: accept };
}
