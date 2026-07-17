// Kearns–Vazirani — active DFA learning with a DISCRIMINATION TREE.
//
// L* (see learn.ts) keeps a flat observation *table*: |S|·|E| membership cells,
// most of which are redundant. Kearns & Vazirani (1994, "An Introduction to
// Computational Learning Theory") replace the table with a *binary tree* of
// experiments. Each inner node is a distinguishing suffix; each leaf is a state
// (named by an access string). To classify — "sift" — a word, you walk from the
// root, and at every inner node with discriminator e you ask one membership
// query "is w·e in the language?", branching right on yes and left on no, until
// you fall into a leaf. So a word is placed among the states with at most
// (tree depth) queries — never the whole table — which is the whole point: KV
// spends dramatically fewer membership queries than table-based L*.
//
// The teacher is identical to L*'s: membership is a walk over the target's
// minimal DFA, equivalence is the studio's product-automaton `compareDFAs`,
// which returns the shortest distinguishing witness for free. Counterexamples
// are folded in Rivest–Schapire style — a binary search for the one suffix that
// splits a leaf into two — so, like RS-L*, KV adds *exactly one state per
// counterexample* and needs only n equivalence queries for an n-state target.
//
// At termination the tree's leaves are exactly the Myhill–Nerode classes and
// the read-off DFA is minimal — the same guarantee L* gives, reached by a
// different road, which is exactly the kind of cross-check this studio is built
// on.

import { CharSet } from './charset';
import { atomIndexFor, type DFA, type DFAState, type DFATransition } from './dfa';
import { minimizeDFA } from './minimize';
import { compareDFAs } from './equivalence';
import { learnAlphabet, type Letter, type Word, type Round, type LogEvent } from './learn';

// A discrimination-tree node. An inner node carries a discriminator suffix and
// two children (child[0] = "suffix rejected", child[1] = "suffix accepted"); a
// leaf carries the access string of the state it represents. We mutate a leaf
// into an inner node in place when a counterexample splits it, so the fields are
// optional and `discr === undefined` is the leaf test.
interface DTNode {
  discr?: Word; // present iff inner node
  access?: Word; // present iff leaf
  child0?: DTNode; // taken when member(w · discr) is false
  child1?: DTNode; // taken when member(w · discr) is true
}

const isLeaf = (n: DTNode): boolean => n.discr === undefined;

export interface DTSnapshotNode {
  kind: 'inner' | 'leaf';
  label: string; // discriminator (inner) or access string (leaf)
  accept?: boolean; // leaves only: does this state accept?
  children?: DTSnapshotNode[]; // [child0, child1] for inner nodes
}

export interface KVResult {
  ok: boolean;
  aborted: boolean;
  alphabet: Letter[];
  hypothesis: DFA | null;
  equivalent: boolean;
  canonicalStates: number;
  targetStates: number;
  minimal: boolean;
  membershipQueries: number;
  equivalenceQueries: number;
  rounds: Round[];
  log: LogEvent[];
  tree: DTSnapshotNode | null;
  leaves: number; // states in the final hypothesis
  treeDepth: number; // deepest leaf (the worst-case sift cost)
  ceSearchProbes: number; // membership probes spent inside counterexample analysis
}

const DEFAULT_MAX_STATES = 120;
const DEFAULT_MAX_ALPHABET = 48;
const DEFAULT_MAX_EQ_ROUNDS = 200;

export interface KVOptions {
  maxStates?: number;
  maxAlphabet?: number;
  maxEqRounds?: number;
}

const keyOf = (w: Word): string => w.join(',');

function displayCode(c: number): string {
  if (c === 32) return '␣';
  if (c === 10) return '\\n';
  if (c === 9) return '\\t';
  if (c < 32 || c === 127) return `\\x${c.toString(16).padStart(2, '0')}`;
  return String.fromCodePoint(c);
}

function wordToStr(word: Word, alphabet: Letter[]): string {
  if (word.length === 0) return 'ε';
  return word.map((a) => displayCode(alphabet[a].rep)).join('');
}

export function learnKV(target: DFA, opts: KVOptions = {}): KVResult {
  const maxStates = opts.maxStates ?? DEFAULT_MAX_STATES;
  const maxAlphabet = opts.maxAlphabet ?? DEFAULT_MAX_ALPHABET;
  const maxEqRounds = opts.maxEqRounds ?? DEFAULT_MAX_EQ_ROUNDS;

  const alphabet = learnAlphabet(target);
  const A = alphabet.length;
  const log: LogEvent[] = [];
  const rounds: Round[] = [];

  const bail = (detail: string): KVResult => ({
    ok: false,
    aborted: true,
    alphabet,
    hypothesis: null,
    equivalent: false,
    canonicalStates: 0,
    targetStates: target.states.length,
    minimal: false,
    membershipQueries: 0,
    equivalenceQueries: 0,
    rounds: [],
    log: [{ kind: 'abort', detail }],
    tree: null,
    leaves: 0,
    treeDepth: 0,
    ceSearchProbes: 0,
  });

  if (A > maxAlphabet) {
    return bail(
      `Alphabet has ${A} symbol classes (cap ${maxAlphabet}) — too wide to draw a legible discrimination tree.`,
    );
  }

  // --- the teacher (identical to L*'s) ------------------------------------
  const cache = new Map<string, boolean>();
  let membershipQueries = 0;
  let equivalenceQueries = 0;
  let ceSearchProbes = 0;

  const runTarget = (word: Word): boolean => {
    let s = target.start;
    for (const a of word) {
      if (s < 0) return false;
      s = target.table[s][a];
    }
    return s >= 0 && target.states[s].accept;
  };
  const member = (word: Word): boolean => {
    const k = keyOf(word);
    const hit = cache.get(k);
    if (hit !== undefined) return hit;
    membershipQueries++;
    const v = runTarget(word);
    cache.set(k, v);
    return v;
  };

  // --- the discrimination tree --------------------------------------------
  // The tree starts as a single leaf for the access string ε. The first
  // counterexample turns it into a proper tree rooted at the ε-discriminator.
  const root: DTNode = { access: [] };

  // Sift a word to the leaf that classifies it, asking one membership query per
  // inner node on the path.
  const sift = (w: Word): DTNode => {
    let node = root;
    while (!isLeaf(node)) {
      const b = member(w.concat(node.discr!));
      node = b ? node.child1! : node.child0!;
    }
    return node;
  };

  // Read a hypothesis DFA off the tree: one state per leaf, transitions by
  // sifting. Also return the access string per state id (RS needs it).
  const buildHypothesis = (): { dfa: DFA; accessById: Word[] } => {
    // Enumerate the leaves in a stable order and number them.
    const leaves: DTNode[] = [];
    const idOf = new Map<DTNode, number>();
    const walk = (n: DTNode) => {
      if (isLeaf(n)) {
        idOf.set(n, leaves.length);
        leaves.push(n);
      } else {
        walk(n.child0!);
        walk(n.child1!);
      }
    };
    walk(root);

    const accessById = leaves.map((l) => l.access!);
    const states: DFAState[] = leaves.map((l, id) => ({
      id,
      nfaStates: [],
      accept: member(l.access!), // root discriminator is ε, so this is the ε-column
    }));
    const table = leaves.map(() => new Int32Array(A).fill(-1));
    const accum = new Map<string, { from: number; to: number; sets: CharSet[] }>();
    for (let id = 0; id < leaves.length; id++) {
      const access = leaves[id].access!;
      for (let a = 0; a < A; a++) {
        const to = idOf.get(sift(access.concat([a])))!;
        table[id][a] = to;
        const tk = `${id}->${to}`;
        const acc = accum.get(tk) ?? { from: id, to, sets: [] };
        acc.sets.push(target.atoms[a].set);
        accum.set(tk, acc);
      }
    }
    const transitions: DFATransition[] = [...accum.values()].map((e) => ({
      from: e.from,
      to: e.to,
      set: CharSet.union(e.sets),
    }));
    const start = idOf.get(sift([]))!;
    return { dfa: { start, states, transitions, atoms: target.atoms, table }, accessById };
  };

  // Rivest–Schapire style counterexample analysis, adapted to the tree: find the
  // breakpoint suffix that splits one leaf into two. Returns false on the
  // (should-not-happen) degenerate case so the caller can abort cleanly.
  const processCounterexample = (ce: Word, hyp: DFA, accessById: Word[]): boolean => {
    const m = ce.length;
    if (m === 0) return false;
    const stateAfter = (len: number): number => {
      let s = hyp.start;
      for (let i = 0; i < len && s >= 0; i++) s = hyp.table[s][ce[i]];
      return s;
    };
    const gamma = (i: number): boolean => {
      const st = stateAfter(i);
      const access = st >= 0 ? accessById[st] : [];
      ceSearchProbes++;
      return member(access.concat(ce.slice(i)));
    };
    let lo = 0;
    let hi = m;
    const gLo = gamma(0);
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (gamma(mid) === gLo) lo = mid;
      else hi = mid;
    }
    // Breakpoint at lo: the letter ce[lo] takes access_H(ce[:lo]) to the leaf we
    // must split; the suffix ce[lo+1:] is the new discriminator.
    const discr = ce.slice(lo + 1);
    const newAccess = accessById[stateAfter(lo)].concat([ce[lo]]);
    const leafToSplit = sift(ce.slice(0, lo + 1)); // = leaf of state δ_H(start, ce[:lo+1])
    const oldAccess = leafToSplit.access!;

    // Place the two access strings under the new discriminator by their answers,
    // which are guaranteed to differ (that is what the breakpoint proves).
    const bOld = member(oldAccess.concat(discr));
    const bNew = member(newAccess.concat(discr));
    if (bOld === bNew) return false; // guard: the invariant failed — bail rather than loop

    // Mutate the leaf into an inner node in place.
    leafToSplit.discr = discr;
    delete leafToSplit.access;
    const oldLeaf: DTNode = { access: oldAccess };
    const newLeaf: DTNode = { access: newAccess };
    leafToSplit.child0 = bOld ? newLeaf : oldLeaf;
    leafToSplit.child1 = bOld ? oldLeaf : newLeaf;

    log.push({
      kind: 'consistent',
      detail: `Kearns–Vazirani: split the leaf ${wordToStr(oldAccess, alphabet)} on discriminator ${wordToStr(
        discr,
        alphabet,
      )} — new state ${wordToStr(newAccess, alphabet)}`,
    });
    return true;
  };

  const snapshotTree = (): DTSnapshotNode => {
    const conv = (n: DTNode): DTSnapshotNode => {
      if (isLeaf(n)) {
        return { kind: 'leaf', label: wordToStr(n.access!, alphabet), accept: member(n.access!) };
      }
      return {
        kind: 'inner',
        label: wordToStr(n.discr!, alphabet),
        children: [conv(n.child0!), conv(n.child1!)],
      };
    };
    return conv(root);
  };

  const depthOf = (): number => {
    const rec = (n: DTNode, d: number): number =>
      isLeaf(n) ? d : Math.max(rec(n.child0!, d + 1), rec(n.child1!, d + 1));
    return rec(root, 0);
  };
  const countLeaves = (): number => {
    const rec = (n: DTNode): number => (isLeaf(n) ? 1 : rec(n.child0!) + rec(n.child1!));
    return rec(root);
  };

  // --- the main learning loop --------------------------------------------
  let hypothesis: DFA | null = null;
  let aborted = false;
  let round = 0;

  for (;;) {
    if (countLeaves() > maxStates) {
      aborted = true;
      log.push({ kind: 'abort', detail: `tree exceeded ${maxStates} leaves — stopping (pattern too large to learn live)` });
      break;
    }
    const built = buildHypothesis();
    hypothesis = built.dfa;
    log.push({
      kind: 'conjecture',
      detail: `conjecture #${round + 1}: a ${hypothesis.states.length}-state DFA (${countLeaves()} leaves, depth ${depthOf()})`,
    });

    equivalenceQueries++;
    const cmp = compareDFAs(hypothesis, target);
    if (cmp.relation === 'equal') {
      rounds.push({ index: round, hypStates: hypothesis.states.length, membershipSoFar: membershipQueries, counterexample: null });
      log.push({ kind: 'done', detail: `equivalence query #${equivalenceQueries}: accepted ✓ — the learned DFA is exactly the target` });
      break;
    }

    const witness = cmp.inAOnly ?? cmp.inBOnly;
    if (!witness) {
      aborted = true;
      log.push({ kind: 'abort', detail: 'comparison reported "not equal" with no witness — internal error' });
      break;
    }
    const ceWord = witness.codes.map((c) => atomIndexFor(target.atoms, c));
    const ceStr = wordToStr(ceWord, alphabet);
    rounds.push({ index: round, hypStates: hypothesis.states.length, membershipSoFar: membershipQueries, counterexample: ceStr });
    log.push({
      kind: 'counterexample',
      detail: `equivalence query #${equivalenceQueries}: rejected — counterexample "${ceStr}"; sifting for the splitting suffix`,
    });

    if (!processCounterexample(ceWord, hypothesis, built.accessById)) {
      aborted = true;
      log.push({ kind: 'abort', detail: 'counterexample analysis failed to split a leaf — stopping' });
      break;
    }

    round++;
    if (round > maxEqRounds) {
      aborted = true;
      log.push({ kind: 'abort', detail: `exceeded ${maxEqRounds} equivalence rounds — stopping` });
      break;
    }
  }

  // --- verdicts -----------------------------------------------------------
  let equivalent = false;
  let canonicalStates = 0;
  const targetStates = target.states.length;
  if (hypothesis && !aborted) {
    equivalent = compareDFAs(hypothesis, target).relation === 'equal';
    canonicalStates = minimizeDFA(hypothesis).states.length;
  } else if (hypothesis) {
    canonicalStates = minimizeDFA(hypothesis).states.length;
  }
  const minimal = equivalent && canonicalStates === targetStates;

  return {
    ok: !aborted && equivalent,
    aborted,
    alphabet,
    hypothesis,
    equivalent,
    canonicalStates,
    targetStates,
    minimal,
    membershipQueries,
    equivalenceQueries,
    rounds,
    log,
    tree: hypothesis ? snapshotTree() : null,
    leaves: hypothesis ? countLeaves() : 0,
    treeDepth: hypothesis ? depthOf() : 0,
    ceSearchProbes,
  };
}
