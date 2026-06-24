// The Gerth–Peled–Vardi–Wolper (1995) on-the-fly tableau: LTL (in NNF core) ⇒ a
// generalized Büchi automaton. The classic "Simple on-the-fly automatic
// verification of linear temporal logic" construction, hand-written.
//
// Each tableau node carries four fields:
//   Incoming — the predecessor node ids (the sentinel INIT marks an initial node)
//   New      — obligations still to be decomposed at THIS position
//   Old      — obligations already decomposed here (its literals are the state's guard)
//   Next     — obligations deferred to the SUCCESSOR position (what X pushes forward)
//
// Splitting happens on ∨ / U / R (each a "now or later" choice); ∧ and X never
// split. A node is finished when New is empty; two finished nodes with the same
// (Old, Next) are merged. Edges run predecessor→node; the letter consumed on an
// edge q→q′ is the SOURCE state's guard (the literals in Old(q)). One accepting
// set per Until-subformula enforces its eventuality (a run can't promise φUψ
// forever without ever delivering ψ).

import type { Core } from './ltl';
import { coreKey } from './ltl';
import { lettersSatisfying, type GBA, type Literal, OmegaError } from './nba';

const INIT = -1;
const NODE_CAP = 2500;

interface TNode {
  id: number;
  incoming: Set<number>;
  New: Core[];
  newKeys: Set<string>;
  Old: Core[];
  oldKeys: Set<string>;
  Next: Core[];
  nextKeys: Set<string>;
}

function freshNode(incoming: Set<number>, New: Core[]): TNode {
  const n: TNode = {
    id: -2,
    incoming,
    New: [],
    newKeys: new Set(),
    Old: [],
    oldKeys: new Set(),
    Next: [],
    nextKeys: new Set(),
  };
  for (const f of New) addNew(n, f);
  return n;
}

function addNew(n: TNode, f: Core): void {
  const k = coreKey(f);
  if (n.oldKeys.has(k) || n.newKeys.has(k)) return;
  n.newKeys.add(k);
  n.New.push(f);
}
function addOld(n: TNode, f: Core): void {
  const k = coreKey(f);
  if (n.oldKeys.has(k)) return;
  n.oldKeys.add(k);
  n.Old.push(f);
}
function addNext(n: TNode, f: Core): void {
  const k = coreKey(f);
  if (n.nextKeys.has(k)) return;
  n.nextKeys.add(k);
  n.Next.push(f);
}

function clone(n: TNode): TNode {
  return {
    id: -2,
    incoming: new Set(n.incoming),
    New: n.New.slice(),
    newKeys: new Set(n.newKeys),
    Old: n.Old.slice(),
    oldKeys: new Set(n.oldKeys),
    Next: n.Next.slice(),
    nextKeys: new Set(n.nextKeys),
  };
}

function complementKey(f: Core): string | null {
  if (f.k === 'prop') return coreKey({ k: 'nprop', letter: f.letter });
  if (f.k === 'nprop') return coreKey({ k: 'prop', letter: f.letter });
  return null;
}

function literalsOf(node: TNode): Literal[] {
  const out: Literal[] = [];
  for (const f of node.Old) {
    if (f.k === 'prop') out.push({ pos: true, letter: f.letter });
    else if (f.k === 'nprop') out.push({ pos: false, letter: f.letter });
  }
  return out;
}

// All distinct Until-subformulas (for the accepting sets) and the closure size.
function collectUntils(f: Core, into: Map<string, { mu: Core; psi: Core }>): void {
  switch (f.k) {
    case 'until':
      into.set(coreKey(f), { mu: f, psi: f.b });
      collectUntils(f.a, into);
      collectUntils(f.b, into);
      return;
    case 'release':
    case 'and':
    case 'or':
      collectUntils(f.a, into);
      collectUntils(f.b, into);
      return;
    case 'next':
      collectUntils(f.a, into);
      return;
    default:
      return;
  }
}

function closureSize(f: Core): number {
  const seen = new Set<string>();
  const go = (g: Core): void => {
    const k = coreKey(g);
    if (seen.has(k)) return;
    seen.add(k);
    switch (g.k) {
      case 'next': go(g.a); return;
      case 'and': case 'or': case 'until': case 'release': go(g.a); go(g.b); return;
      default: return;
    }
  };
  go(f);
  return seen.size;
}

export interface BuildResult {
  gba: GBA;
  closure: number;
  rawStates: number; // nodes before degeneralization
}

export function buildGBA(formula: Core, alphabet: string[]): BuildResult {
  // result keyed by (Old | Next) signature → finished node
  const result = new Map<string, TNode>();
  const byId: TNode[] = [];
  let nextId = 0;
  const pending: TNode[] = [freshNode(new Set([INIT]), [formula])];

  const signature = (n: TNode) =>
    [...n.oldKeys].sort().join('§') + '‖' + [...n.nextKeys].sort().join('§');

  let guard = 0;
  while (pending.length) {
    if (++guard > NODE_CAP * 40 || nextId > NODE_CAP) {
      throw new OmegaError(`the tableau blew up past ${NODE_CAP} states`);
    }
    const node = pending.pop()!;
    let discarded = false;
    let split = false;

    while (node.New.length) {
      const eta = node.New.pop()!;
      node.newKeys.delete(coreKey(eta));
      if (node.oldKeys.has(coreKey(eta))) continue;

      if (eta.k === 'false') { discarded = true; break; }
      if (eta.k === 'true') { addOld(node, eta); continue; }
      if (eta.k === 'prop' || eta.k === 'nprop') {
        const comp = complementKey(eta);
        if (comp && node.oldKeys.has(comp)) { discarded = true; break; }
        addOld(node, eta);
        continue;
      }
      if (eta.k === 'and') {
        addNew(node, eta.a);
        addNew(node, eta.b);
        addOld(node, eta);
        continue;
      }
      if (eta.k === 'next') {
        addOld(node, eta);
        addNext(node, eta.a);
        continue;
      }
      // splitting connectives: ∨, U, R
      if (eta.k === 'or') {
        const n1 = clone(node); addNew(n1, eta.a); addOld(n1, eta);
        const n2 = clone(node); addNew(n2, eta.b); addOld(n2, eta);
        pending.push(n1, n2);
      } else if (eta.k === 'until') {
        // φUψ: continue {φ, X(φUψ)}  |  discharge {ψ}
        const n1 = clone(node); addNew(n1, eta.a); addNext(n1, eta); addOld(n1, eta);
        const n2 = clone(node); addNew(n2, eta.b); addOld(n2, eta);
        pending.push(n1, n2);
      } else {
        // φRψ: continue {ψ, X(φRψ)}  |  discharge {φ, ψ}
        const n1 = clone(node); addNew(n1, eta.b); addNext(n1, eta); addOld(n1, eta);
        const n2 = clone(node); addNew(n2, eta.a); addNew(n2, eta.b); addOld(n2, eta);
        pending.push(n1, n2);
      }
      split = true;
      break;
    }

    if (discarded || split) continue;

    // New is empty — finalize this node.
    const sig = signature(node);
    const existing = result.get(sig);
    if (existing) {
      for (const p of node.incoming) existing.incoming.add(p);
      continue;
    }
    node.id = nextId++;
    result.set(sig, node);
    byId[node.id] = node;
    // spawn the successor seeded by Next
    pending.push(freshNode(new Set([node.id]), node.Next));
  }

  // ── assemble the GBA ────────────────────────────────────────────────────────
  const nodes = byId.filter(Boolean);
  const stateCount = nodes.length;
  const start: number[] = [];
  const edges: { from: number; to: number; letters: string[] }[] = [];
  const labels: string[] = new Array(stateCount);

  for (const q of nodes) {
    if (q.incoming.has(INIT)) start.push(q.id);
    const lits = q.Old.filter((f) => f.k === 'prop' || f.k === 'nprop')
      .map((f) => (f.k === 'prop' ? f.letter : '¬' + (f as { letter: string }).letter));
    labels[q.id] = lits.length ? lits.join(' ') : '⊤';
  }
  // guard cache per source node
  const guardOf: string[][] = new Array(stateCount);
  for (const q of nodes) guardOf[q.id] = lettersSatisfying(literalsOf(q), alphabet);

  for (const q of nodes) {
    for (const p of q.incoming) {
      if (p === INIT) continue;
      const g = guardOf[p];
      if (g.length === 0) continue; // source has no readable letter — dead transition
      edges.push({ from: p, to: q.id, letters: g.slice() });
    }
  }

  // ── accepting sets: one per Until-subformula ────────────────────────────────
  const untils = new Map<string, { mu: Core; psi: Core }>();
  collectUntils(formula, untils);
  const acceptSets: number[][] = [];
  for (const { mu, psi } of untils.values()) {
    const muK = coreKey(mu);
    const psiK = coreKey(psi);
    const set: number[] = [];
    for (const q of nodes) {
      if (!q.oldKeys.has(muK) || q.oldKeys.has(psiK)) set.push(q.id);
    }
    acceptSets.push(set);
  }

  const gba: GBA = { stateCount, start, edges, acceptSets, alphabet: alphabet.slice(), labels };
  return { gba, closure: closureSize(formula), rawStates: stateCount };
}
