// Angluin's L* — learning the minimal DFA of a regular language from queries.
//
// Every other road in this studio starts from a regex you *wrote* and walks it
// down to an automaton. L* goes the other way: it is handed a language as an
// oracle it may only *interrogate*, and it reconstructs the minimal DFA from
// scratch — never seeing the regex, only its yes/no answers.
//
// The teacher answers two kinds of question (Angluin's "minimally adequate
// teacher"):
//   • a MEMBERSHIP query  — "is the string w in the language?"   (yes/no)
//   • an EQUIVALENCE query — "is this DFA the right one?"          (yes, or a
//                            counterexample string the two disagree on)
//
// Here the teacher is the studio's *own* engine: membership is a walk over the
// target's minimal DFA, and equivalence is the product-automaton comparison
// (`compareDFAs`) that already powers the Compare tab — which hands back the
// shortest distinguishing witness for free. The learner keeps an OBSERVATION
// TABLE (S · E → {0,1}); it drives the table to be *closed* and *consistent*,
// reads a hypothesis DFA off it, asks "is this it?", and folds every
// counterexample back in by adding its prefixes to S. At termination the
// hypothesis is provably the minimal DFA (Myhill–Nerode): one state per
// distinct row, i.e. per residual language — exactly the equivalence classes
// the right-congruence carves out.
//
// We learn over the *atom alphabet* the rest of the engine already computes:
// each atomic character class is one symbol, so a word is a list of atom
// indices. That keeps the alphabet finite and small and lets the learned DFA
// drop straight into the existing graph / minimise / language views.

import { CharSet } from './charset';
import { atomIndexFor, type Atom, type DFA, type DFAState, type DFATransition } from './dfa';
import { minimizeDFA } from './minimize';
import { compareDFAs } from './equivalence';

// One symbol of the learning alphabet: an atom of the target DFA, with a
// readable representative character and label for the UI.
export interface Letter {
  atom: number; // index into target.atoms
  rep: number; // a representative code point (for rendering words)
  label: string; // the atom's CharSet label, e.g. "a", "\d", "[b-d]"
}

export type Word = number[]; // a list of atom indices

export interface TableSnapshot {
  E: string[]; // experiments (column headers), rendered
  topRows: { access: string; signature: string }[]; // rows for s ∈ S
  bottomRows: { access: string; signature: string }[]; // rows for s·a ∉ S (the boundary)
}

export type LogKind = 'close' | 'consistent' | 'conjecture' | 'counterexample' | 'done' | 'abort';

export interface LogEvent {
  kind: LogKind;
  detail: string;
}

export interface Round {
  index: number;
  hypStates: number;
  membershipSoFar: number;
  counterexample: string | null;
}

export interface LStarResult {
  ok: boolean; // learning completed (table closed/consistent, hypothesis accepted)
  aborted: boolean; // hit a safety cap
  alphabet: Letter[];
  hypothesis: DFA | null; // the learned (complete) DFA
  equivalent: boolean; // learned ≡ target (the gold-standard check)
  canonicalStates: number; // states of minimizeDFA(learned) — the partial canonical form
  targetStates: number; // states of the target's minimal DFA (same partial form)
  minimal: boolean; // canonicalStates === targetStates AND equivalent
  membershipQueries: number;
  equivalenceQueries: number;
  rounds: Round[];
  log: LogEvent[];
  table: TableSnapshot | null;
  finalS: number; // |S| at termination
  finalE: number; // |E| at termination
  distinctRows: number; // number of states in the hypothesis
}

const DEFAULT_MAX_STATES = 120; // cap on distinct table rows (hypothesis states)
const DEFAULT_MAX_ALPHABET = 48; // bail before the table/graph become unwieldy
const DEFAULT_MAX_EQ_ROUNDS = 200;

export interface LearnOptions {
  maxStates?: number;
  maxAlphabet?: number;
  maxEqRounds?: number;
}

// Build the learning alphabet from the target DFA's atoms.
export function learnAlphabet(dfa: DFA): Letter[] {
  return dfa.atoms.map((atom: Atom, i: number) => ({
    atom: i,
    rep: atom.set.samplePrintable() ?? atom.lo,
    label: atom.set.label(),
  }));
}

// Render a word (atom indices) as a readable string of representative chars.
function wordToStr(word: Word, alphabet: Letter[]): string {
  if (word.length === 0) return 'ε';
  return word.map((a) => displayCode(alphabet[a].rep)).join('');
}

function displayCode(c: number): string {
  if (c === 32) return '␣';
  if (c === 10) return '\\n';
  if (c === 9) return '\\t';
  if (c < 32 || c === 127) return `\\x${c.toString(16).padStart(2, '0')}`;
  return String.fromCodePoint(c);
}

const keyOf = (w: Word): string => w.join(',');

export function learnLStar(target: DFA, opts: LearnOptions = {}): LStarResult {
  const maxStates = opts.maxStates ?? DEFAULT_MAX_STATES;
  const maxAlphabet = opts.maxAlphabet ?? DEFAULT_MAX_ALPHABET;
  const maxEqRounds = opts.maxEqRounds ?? DEFAULT_MAX_EQ_ROUNDS;

  const alphabet = learnAlphabet(target);
  const A = alphabet.length;
  const log: LogEvent[] = [];
  const rounds: Round[] = [];

  if (A > maxAlphabet) {
    return {
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
      log: [
        {
          kind: 'abort',
          detail: `Alphabet has ${A} symbol classes (cap ${maxAlphabet}) — too wide for a legible observation table. Try a pattern over a smaller alphabet.`,
        },
      ],
      table: null,
      finalS: 0,
      finalE: 0,
      distinctRows: 0,
    };
  }

  // --- the teacher --------------------------------------------------------
  const cache = new Map<string, boolean>();
  let membershipQueries = 0;
  let equivalenceQueries = 0;

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

  // --- the observation table ---------------------------------------------
  const S: Word[] = [[]]; // access strings (one representative per state)
  const inS = new Set<string>([keyOf([])]);
  const E: Word[] = [[]]; // experiments (distinguishing suffixes); ε is always E[0]

  const rowKey = (s: Word): string => {
    let out = '';
    for (const e of E) out += member(s.concat(e)) ? '1' : '0';
    return out;
  };

  const addToS = (w: Word) => {
    const k = keyOf(w);
    if (inS.has(k)) return;
    inS.add(k);
    S.push(w);
  };

  // Drive the table to closed + consistent. Returns false if it blew the cap.
  const closeAndConsistent = (): boolean => {
    for (;;) {
      if (S.length > maxStates) return false;

      // Closedness: every boundary row s·a must already appear in S.
      let changed = false;
      const sKeys = new Set(S.map(rowKey));
      outer: for (const s of S) {
        for (let a = 0; a < A; a++) {
          const sa = s.concat([a]);
          if (!sKeys.has(rowKey(sa))) {
            addToS(sa);
            log.push({
              kind: 'close',
              detail: `not closed: row(${wordToStr(sa, alphabet)}) was new — moved it into S`,
            });
            changed = true;
            break outer;
          }
        }
      }
      if (changed) continue;

      // Consistency: equal rows in S must stay equal one step on.
      consistency: for (let i = 0; i < S.length; i++) {
        for (let j = i + 1; j < S.length; j++) {
          if (rowKey(S[i]) !== rowKey(S[j])) continue;
          for (let a = 0; a < A; a++) {
            const ri = rowKey(S[i].concat([a]));
            const rj = rowKey(S[j].concat([a]));
            if (ri === rj) continue;
            // Find the experiment that distinguishes them and prepend a.
            for (let k = 0; k < E.length; k++) {
              const vi = member(S[i].concat([a], E[k]));
              const vj = member(S[j].concat([a], E[k]));
              if (vi !== vj) {
                const newExp = [a, ...E[k]];
                E.push(newExp);
                log.push({
                  kind: 'consistent',
                  detail: `not consistent: row(${wordToStr(S[i], alphabet)}) = row(${wordToStr(
                    S[j],
                    alphabet,
                  )}) but they differ after '${alphabet[a].label}' — added experiment ${wordToStr(newExp, alphabet)}`,
                });
                changed = true;
                break consistency;
              }
            }
          }
        }
      }
      if (!changed) return true;
    }
  };

  // Read a hypothesis DFA off the (closed, consistent) table.
  const buildHypothesis = (): DFA => {
    const keyToId = new Map<string, number>();
    const accessByKey = new Map<string, Word>();
    const order: string[] = [];
    for (const s of S) {
      const k = rowKey(s);
      if (!keyToId.has(k)) {
        keyToId.set(k, order.length);
        order.push(k);
        accessByKey.set(k, s);
      }
    }
    const states: DFAState[] = order.map((k, id) => ({
      id,
      nfaStates: [],
      accept: member(accessByKey.get(k)!), // the ε-experiment column
    }));
    const table = order.map(() => new Int32Array(A).fill(-1));
    const accum = new Map<string, { from: number; to: number; sets: CharSet[] }>();
    for (let id = 0; id < order.length; id++) {
      const s = accessByKey.get(order[id])!;
      for (let a = 0; a < A; a++) {
        const to = keyToId.get(rowKey(s.concat([a])));
        if (to === undefined) throw new Error('hypothesis: table not closed');
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
    return {
      start: keyToId.get(rowKey([]))!,
      states,
      transitions,
      atoms: target.atoms,
      table,
    };
  };

  const snapshot = (): TableSnapshot => {
    const topKeys = new Set(S.map(keyOf));
    const top = S.map((s) => ({ access: wordToStr(s, alphabet), signature: rowKey(s) }));
    const bottom: { access: string; signature: string }[] = [];
    const seenBottom = new Set<string>();
    for (const s of S) {
      for (let a = 0; a < A; a++) {
        const sa = s.concat([a]);
        const k = keyOf(sa);
        if (topKeys.has(k) || seenBottom.has(k)) continue;
        seenBottom.add(k);
        bottom.push({ access: wordToStr(sa, alphabet), signature: rowKey(sa) });
      }
    }
    return { E: E.map((e) => wordToStr(e, alphabet)), topRows: top, bottomRows: bottom };
  };

  // --- the main learning loop --------------------------------------------
  let hypothesis: DFA | null = null;
  let aborted = false;
  let round = 0;

  for (;;) {
    if (!closeAndConsistent()) {
      aborted = true;
      log.push({ kind: 'abort', detail: `table exceeded ${maxStates} states — stopping (pattern too large to learn live)` });
      break;
    }
    hypothesis = buildHypothesis();
    log.push({
      kind: 'conjecture',
      detail: `conjecture #${round + 1}: a ${hypothesis.states.length}-state DFA (|S|=${S.length}, |E|=${E.length})`,
    });

    equivalenceQueries++;
    const cmp = compareDFAs(hypothesis, target);
    if (cmp.relation === 'equal') {
      rounds.push({ index: round, hypStates: hypothesis.states.length, membershipSoFar: membershipQueries, counterexample: null });
      log.push({ kind: 'done', detail: `equivalence query #${equivalenceQueries}: accepted ✓ — the learned DFA is exactly the target` });
      break;
    }

    // A counterexample: a string the hypothesis and target disagree on.
    const witness = cmp.inAOnly ?? cmp.inBOnly;
    if (!witness) {
      // Should not happen (not equal ⇒ some asymmetric witness exists).
      aborted = true;
      log.push({ kind: 'abort', detail: 'comparison reported "not equal" with no witness — internal error' });
      break;
    }
    const ceWord = witness.codes.map((c) => atomIndexFor(target.atoms, c));
    const ceStr = wordToStr(ceWord, alphabet);
    rounds.push({ index: round, hypStates: hypothesis.states.length, membershipSoFar: membershipQueries, counterexample: ceStr });
    log.push({
      kind: 'counterexample',
      detail: `equivalence query #${equivalenceQueries}: rejected — counterexample "${ceStr}" (the two disagree here); adding its prefixes to S`,
    });
    // Classic Angluin: add every prefix of the counterexample to S.
    for (let i = 1; i <= ceWord.length; i++) addToS(ceWord.slice(0, i));

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
    table: hypothesis ? snapshot() : null,
    finalS: S.length,
    finalE: E.length,
    distinctRows: hypothesis ? hypothesis.states.length : 0,
  };
}
