// A head-to-head of the studio's active learners on one target language.
//
// All three ask the *same* teacher the *same* two questions (membership,
// equivalence) and all three must converge on the studio's minimal DFA — the
// interesting number is the *cost*: how many membership queries each spends, and
// how many equivalence rounds it needs. This is where the algorithms visibly
// differ:
//
//   • L* (classic)          — a flat table; a counterexample of length m dumps
//                             all m prefixes into S, so the table (and its query
//                             count) can balloon.
//   • L* (Rivest–Schapire)  — same table, but a counterexample is binary-searched
//                             to the *one* suffix that matters; |S| grows by one
//                             per round. Fewer membership queries.
//   • Kearns–Vazirani       — no table at all; a discrimination tree sifts each
//                             word in ≤ (tree depth) queries, and needs only n
//                             equivalence rounds for an n-state target.
//
// The panel renders the returned rows as a leaderboard so the query-complexity
// story is something you *measure*, not something the prose asserts.

import type { DFA } from './dfa';
import { learnLStar } from './learn';
import { learnKV } from './learn-kv';

export interface RaceRow {
  key: string;
  name: string;
  blurb: string;
  membershipQueries: number;
  equivalenceQueries: number;
  learnedStates: number; // complete DFA (incl. any trap)
  rounds: number; // conjectures made
  equivalent: boolean;
  minimal: boolean;
  aborted: boolean;
  // A structure-size number that means something different per learner:
  // |S|+|E| cells for the table learners, tree leaves+depth for KV.
  structure: string;
}

export interface RaceReport {
  targetStates: number;
  alphabet: number;
  rows: RaceRow[];
  agree: boolean; // every non-aborted learner recovered the exact minimal DFA
}

export function runLearnRace(target: DFA): RaceReport {
  const classic = learnLStar(target, { ceHandling: 'prefixes' });
  const rs = learnLStar(target, { ceHandling: 'rivest-schapire' });
  const kv = learnKV(target);

  const rows: RaceRow[] = [
    {
      key: 'lstar-classic',
      name: 'L* — classic',
      blurb: 'observation table · all prefixes of every counterexample → S',
      membershipQueries: classic.membershipQueries,
      equivalenceQueries: classic.equivalenceQueries,
      learnedStates: classic.distinctRows,
      rounds: classic.rounds.length,
      equivalent: classic.equivalent,
      minimal: classic.minimal,
      aborted: classic.aborted,
      structure: `|S|=${classic.finalS}, |E|=${classic.finalE} → ${classic.finalS * classic.finalE} cells`,
    },
    {
      key: 'lstar-rs',
      name: 'L* — Rivest–Schapire',
      blurb: 'observation table · binary-search one suffix per counterexample → E',
      membershipQueries: rs.membershipQueries,
      equivalenceQueries: rs.equivalenceQueries,
      learnedStates: rs.distinctRows,
      rounds: rs.rounds.length,
      equivalent: rs.equivalent,
      minimal: rs.minimal,
      aborted: rs.aborted,
      structure: `|S|=${rs.finalS}, |E|=${rs.finalE} → ${rs.finalS * rs.finalE} cells · ${rs.ceSearchProbes} search probes`,
    },
    {
      key: 'kv',
      name: 'Kearns–Vazirani',
      blurb: 'discrimination tree · sift in ≤ depth queries · one split per counterexample',
      membershipQueries: kv.membershipQueries,
      equivalenceQueries: kv.equivalenceQueries,
      learnedStates: kv.leaves,
      rounds: kv.rounds.length,
      equivalent: kv.equivalent,
      minimal: kv.minimal,
      aborted: kv.aborted,
      structure: `${kv.leaves} leaves, depth ${kv.treeDepth} · ${kv.ceSearchProbes} search probes`,
    },
  ];

  const agree = rows.every((r) => r.aborted || (r.equivalent && r.minimal));
  return { targetStates: target.states.length, alphabet: target.atoms.length, rows, agree };
}
