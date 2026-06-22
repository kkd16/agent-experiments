import type { Difficulty } from "../data/types";

/**
 * How the judge compares your function's return value against the expected one.
 * - `deep`           exact structural equality (order matters).
 * - `unordered`      top-level arrays compared as multisets (element order ignored).
 * - `unordered-deep` order is irrelevant at every level — for subsets / permutations /
 *                    grouped anagrams where neither the outer nor inner ordering is fixed.
 * - `approx`         numeric comparison within a small tolerance — for floating-point answers.
 */
export type CompareMode = "deep" | "unordered" | "unordered-deep" | "approx";

export interface DojoTest {
  /** positional arguments passed to the entry function */
  args: unknown[];
  /** the value the function must return */
  expected: unknown;
  /** sample tests are shown up-front and run by "Run"; the rest are the hidden judge set */
  sample?: boolean;
  /** optional short label shown in the results console */
  name?: string;
}

export interface Challenge {
  id: string;
  /** the pattern this problem drills (matches a Pattern.id) */
  patternId: string;
  title: string;
  difficulty: Difficulty;
  /** the problem statement, as paragraphs (supports inline `backtick code`) */
  statement: string[];
  /** name of the function the solver must implement */
  entry: string;
  /** parameter description lines, e.g. "nums: number[] — the input array" */
  params?: string[];
  /** description of the return value */
  returns?: string;
  /** code the editor is seeded with */
  starter: string;
  /** sample + hidden tests; at least one sample */
  tests: DojoTest[];
  compare?: CompareMode;
  /** a verified, idiomatic solution revealed on demand */
  reference: string;
  /** progressively-revealed nudges */
  hints: string[];
  /** target complexity of the intended solution */
  complexity?: { time: string; space: string };
}
