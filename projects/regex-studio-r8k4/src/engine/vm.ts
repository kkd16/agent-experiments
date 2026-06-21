// A from-scratch backtracking regex VM.
//
// Where the automata pipeline compiles a regex to a DFA and runs in guaranteed
// O(n) time but can only express *regular* languages, this engine walks the AST
// directly with classic continuation-passing backtracking. That buys the full
// feature set — capture groups, backreferences, anchors, word boundaries,
// lookahead/lookbehind and lazy quantifiers — at the cost of worst-case
// exponential time. The `steps` counter makes that cost visible: it's how the
// app demonstrates catastrophic backtracking (ReDoS) live.

import type { RegexNode } from './ast';
import { WORD } from './charset';
import { toCodePoints } from './simulate';

export interface CaptureSpan {
  start: number; // code-point index, inclusive
  end: number; // exclusive
}

export interface VMMatch {
  start: number;
  end: number;
  groups: (CaptureSpan | null)[]; // index 0 = whole match; 1..n = capture groups
}

export interface VMOptions {
  multiline?: boolean; // ^ and $ also match at line breaks
  dotAll?: boolean; // (reserved) . matches newline — handled at parse time today
  stepLimit?: number; // abort after this many primitive steps (ReDoS guard)
}

export interface VMRunResult {
  match: VMMatch | null; // leftmost match (greedy by the regex's own preferences)
  steps: number; // primitive backtracking steps consumed
  aborted: boolean; // hit the step limit before deciding
}

export interface VMSearchResult {
  matches: VMMatch[];
  steps: number;
  aborted: boolean;
}

const DEFAULT_STEP_LIMIT = 2_000_000;

class StepLimitExceeded extends Error {}

// The matcher core. One instance is bound to a single input string so the
// continuation closures can share the code-point array and capture state.
class Matcher {
  private readonly codes: number[];
  private readonly groupCount: number;
  private readonly multiline: boolean;
  private readonly stepLimit: number;
  // caps[i] is the current span of group i (1-based); index 0 unused here.
  private caps: (CaptureSpan | null)[];
  steps = 0;

  constructor(codes: number[], groupCount: number, opts: VMOptions) {
    this.codes = codes;
    this.groupCount = groupCount;
    this.multiline = !!opts.multiline;
    this.stepLimit = opts.stepLimit ?? DEFAULT_STEP_LIMIT;
    this.caps = new Array(groupCount + 1).fill(null);
  }

  private tick(): void {
    if (++this.steps > this.stepLimit) throw new StepLimitExceeded();
  }

  private isWord(i: number): boolean {
    return i >= 0 && i < this.codes.length && WORD.contains(this.codes[i]);
  }

  // Match `node` starting at `pos`; on success call the continuation `k` with
  // the position after the match. Returns whether some continuation succeeded.
  private m(node: RegexNode, pos: number, k: (p: number) => boolean): boolean {
    this.tick();
    switch (node.type) {
      case 'empty':
        return k(pos);

      case 'char': {
        if (pos < this.codes.length && node.set.contains(this.codes[pos])) return k(pos + 1);
        return false;
      }

      case 'concat':
        return this.seq(node.parts, 0, pos, k);

      case 'alt': {
        for (const opt of node.options) {
          if (this.m(opt, pos, k)) return true;
        }
        return false;
      }

      case 'group': {
        const prev = this.caps[node.index];
        const ok = this.m(node.node, pos, (p2) => {
          const saved = this.caps[node.index];
          this.caps[node.index] = { start: pos, end: p2 };
          if (k(p2)) return true;
          this.caps[node.index] = saved;
          return false;
        });
        if (!ok) this.caps[node.index] = prev;
        return ok;
      }

      case 'star':
        return node.lazy
          ? this.lazyMany(node.node, pos, 0, null, k)
          : this.greedyMany(node.node, pos, 0, null, k);

      case 'plus':
        return node.lazy
          ? this.lazyMany(node.node, pos, 1, null, k)
          : this.greedyMany(node.node, pos, 1, null, k);

      case 'opt':
        if (node.lazy) return k(pos) || this.m(node.node, pos, k);
        return this.m(node.node, pos, k) || k(pos);

      case 'repeat':
        return node.lazy
          ? this.lazyMany(node.node, pos, node.min, node.max, k)
          : this.greedyMany(node.node, pos, node.min, node.max, k);

      case 'anchor':
        if (node.at === 'start') {
          if (pos === 0 || (this.multiline && this.codes[pos - 1] === 10)) return k(pos);
          return false;
        }
        if (pos === this.codes.length || (this.multiline && this.codes[pos] === 10)) return k(pos);
        return false;

      case 'boundary': {
        const atBoundary = this.isWord(pos - 1) !== this.isWord(pos);
        return atBoundary !== node.negate ? k(pos) : false;
      }

      case 'backref': {
        const cap = this.caps[node.index];
        if (!cap) return k(pos); // unset group ⇒ matches the empty string
        const len = cap.end - cap.start;
        if (pos + len > this.codes.length) return false;
        for (let i = 0; i < len; i++) {
          this.tick();
          if (this.codes[pos + i] !== this.codes[cap.start + i]) return false;
        }
        return k(pos + len);
      }

      case 'look': {
        if (node.dir === 'ahead') {
          const matched = this.m(node.node, pos, () => true);
          return matched !== node.negate ? k(pos) : false;
        }
        // Lookbehind: does `node` match some substring ending exactly at `pos`?
        let matched = false;
        for (let start = pos; start >= 0 && !matched; start--) {
          if (this.m(node.node, start, (p) => p === pos)) matched = true;
        }
        return matched !== node.negate ? k(pos) : false;
      }

      case 'intersect':
      case 'complement':
        // Boolean operators are an automata-only construct in this studio — the
        // backtracking VM never receives them (the Extended panel runs them on
        // the Boolean-derivative engine instead).
        throw new Error(`vm: '${node.type}' is handled by the Boolean-derivative engine, not the VM`);
    }
  }

  private seq(parts: RegexNode[], i: number, pos: number, k: (p: number) => boolean): boolean {
    if (i === parts.length) return k(pos);
    return this.m(parts[i], pos, (p2) => this.seq(parts, i + 1, p2, k));
  }

  // Greedy {min,max}: consume as many as possible first, then backtrack.
  private greedyMany(
    node: RegexNode,
    pos: number,
    min: number,
    max: number | null,
    k: (p: number) => boolean,
    count = 0,
  ): boolean {
    this.tick();
    const canMore = max === null || count < max;
    if (canMore) {
      const more = this.m(node, pos, (p2) => {
        // A zero-width iteration risks an infinite loop on an *unbounded* repeat,
        // but only once the minimum is already met: an empty iteration may be
        // exactly what lets the repeat reach its lower bound — e.g. /(a?)+/ on ""
        // or /(a?){3}/ on "aa" both need empty iterations. So we block an empty
        // step only when `count >= min` (further empties make no progress); the
        // first `min` empty iterations are still allowed. Bounded {m,n} repeats
        // are capped by `max`, so they never need this guard.
        if (p2 === pos && max === null && count >= min) return false;
        return this.greedyMany(node, p2, min, max, k, count + 1);
      });
      if (more) return true;
    }
    return count >= min ? k(pos) : false;
  }

  // Lazy {min,max}: stop as soon as the minimum is met, expand only if forced.
  private lazyMany(
    node: RegexNode,
    pos: number,
    min: number,
    max: number | null,
    k: (p: number) => boolean,
    count = 0,
  ): boolean {
    this.tick();
    if (count >= min && k(pos)) return true;
    const canMore = max === null || count < max;
    if (!canMore) return false;
    return this.m(node, pos, (p2) => {
      if (p2 === pos && max === null && count >= min) return false; // see greedyMany
      return this.lazyMany(node, p2, min, max, k, count + 1);
    });
  }

  // Attempt a match anchored at `start`. Records the whole-match end (greedy)
  // and a snapshot of the capture spans.
  matchAt(ast: RegexNode, start: number): VMMatch | null {
    this.caps = new Array(this.groupCount + 1).fill(null);
    let end = -1;
    const ok = this.m(ast, start, (p) => {
      end = p;
      return true;
    });
    if (!ok) return null;
    return { start, end, groups: [{ start, end }, ...this.caps.slice(1)] };
  }
}

// Leftmost single match (the engine's natural semantics).
export function runVM(ast: RegexNode, groupCount: number, text: string, opts: VMOptions = {}): VMRunResult {
  const codes = toCodePoints(text);
  const matcher = new Matcher(codes, groupCount, opts);
  try {
    for (let start = 0; start <= codes.length; start++) {
      const match = matcher.matchAt(ast, start);
      if (match) return { match, steps: matcher.steps, aborted: false };
    }
    return { match: null, steps: matcher.steps, aborted: false };
  } catch (e) {
    if (e instanceof StepLimitExceeded) return { match: null, steps: matcher.steps, aborted: true };
    throw e;
  }
}

// A single match attempt anchored at index 0. This isolates the *backtracking*
// cost of one starting position — exactly what a ReDoS attack exploits — without
// the extra O(n) factor of scanning every start that `runVM`/`searchVM` add.
export function runVMAt0(ast: RegexNode, groupCount: number, text: string, opts: VMOptions = {}): VMRunResult {
  const codes = toCodePoints(text);
  const matcher = new Matcher(codes, groupCount, opts);
  try {
    const match = matcher.matchAt(ast, 0);
    return { match, steps: matcher.steps, aborted: false };
  } catch (e) {
    if (e instanceof StepLimitExceeded) return { match: null, steps: matcher.steps, aborted: true };
    throw e;
  }
}

// All non-overlapping matches, left to right (zero-width matches advance by one).
export function searchVM(ast: RegexNode, groupCount: number, text: string, opts: VMOptions = {}): VMSearchResult {
  const codes = toCodePoints(text);
  const matcher = new Matcher(codes, groupCount, opts);
  const matches: VMMatch[] = [];
  try {
    let i = 0;
    while (i <= codes.length) {
      let found: VMMatch | null = null;
      for (let start = i; start <= codes.length; start++) {
        const m = matcher.matchAt(ast, start);
        if (m) {
          found = m;
          break;
        }
      }
      if (!found) break;
      if (found.end > found.start) {
        matches.push(found);
        i = found.end;
      } else {
        // zero-width match: record nothing visible, step forward to make progress
        i = found.start + 1;
      }
    }
    return { matches, steps: matcher.steps, aborted: false };
  } catch (e) {
    if (e instanceof StepLimitExceeded) return { matches, steps: matcher.steps, aborted: true };
    throw e;
  }
}
