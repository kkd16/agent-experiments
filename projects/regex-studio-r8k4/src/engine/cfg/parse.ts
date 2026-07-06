// A small BNF parser: grammar text → `Grammar`. One nonterminal per line (or
// several `|`-separated alternatives), `->` / `→` / `::=` as the arrow, and the
// usual tokenisation — an uppercase-led run is a nonterminal, any other single
// non-space character is a terminal, and `ε` / `epsilon` / an empty alternative
// is the empty string. `#` and `//` start a comment.

import type { Grammar, Rule, Sym } from './grammar';
import { makeGrammar, nt, term } from './grammar';

export interface CfgParseError {
  message: string;
  line: number; // 1-based
}

export type CfgParseResult = { grammar: Grammar; error: null } | { grammar: null; error: CfgParseError };

const ARROWS = ['::=', '->', '→', '⟶', '⇒'];

/** Is `ch` the start of a nonterminal token? Uppercase Latin letter. */
function isNtStart(ch: string): boolean {
  return ch >= 'A' && ch <= 'Z';
}
/** Characters that may continue a nonterminal token after its uppercase head. */
function isNtCont(ch: string): boolean {
  return (ch >= '0' && ch <= '9') || ch === "'" || ch === '_';
}

/** Tokenise one alternative (a run between `|`s) into a symbol sequence. */
function parseAlternative(text: string): Sym[] {
  const trimmed = text.trim();
  if (trimmed === '' || trimmed === 'ε' || trimmed === 'ϵ' || trimmed === '_') return [];
  // `epsilon` as a whole word is also the empty string
  if (/^epsilon$/i.test(trimmed)) return [];

  const out: Sym[] = [];
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (ch === ' ' || ch === '\t') {
      i++;
      continue;
    }
    if (ch === 'ε' || ch === 'ϵ') {
      // a stray ε inside a longer alternative contributes nothing
      i++;
      continue;
    }
    if (isNtStart(ch)) {
      let j = i + 1;
      while (j < text.length && isNtCont(text[j])) j++;
      out.push(nt(text.slice(i, j)));
      i = j;
      continue;
    }
    // any other non-space character is a single-character terminal
    out.push(term(ch));
    i++;
  }
  return out;
}

/** Find the first arrow in a line; returns its start index and the matched arrow, or null. */
function findArrow(line: string): { at: number; arrow: string } | null {
  let best: { at: number; arrow: string } | null = null;
  for (const arrow of ARROWS) {
    const at = line.indexOf(arrow);
    if (at >= 0 && (best === null || at < best.at)) best = { at, arrow };
  }
  return best;
}

function stripComment(line: string): string {
  const hash = line.indexOf('#');
  const slashes = line.indexOf('//');
  let cut = line.length;
  if (hash >= 0) cut = Math.min(cut, hash);
  if (slashes >= 0) cut = Math.min(cut, slashes);
  return line.slice(0, cut);
}

export function parseGrammar(source: string): CfgParseResult {
  const rawLines = source.split('\n');
  const rules: Rule[] = [];
  let start: string | null = null;

  for (let ln = 0; ln < rawLines.length; ln++) {
    const line = stripComment(rawLines[ln]);
    if (line.trim() === '') continue;

    const arrow = findArrow(line);
    if (!arrow) {
      return { grammar: null, error: { message: `no arrow (→, ->, ::=) on this line`, line: ln + 1 } };
    }
    const lhsText = line.slice(0, arrow.at).trim();
    const rhsText = line.slice(arrow.at + arrow.arrow.length);

    // The LHS must be exactly one nonterminal token.
    if (lhsText === '') {
      return { grammar: null, error: { message: `left-hand side is empty`, line: ln + 1 } };
    }
    if (!isNtStart(lhsText[0])) {
      return {
        grammar: null,
        error: { message: `left-hand side "${lhsText}" is not a nonterminal (must start with an uppercase letter)`, line: ln + 1 },
      };
    }
    let k = 1;
    while (k < lhsText.length && isNtCont(lhsText[k])) k++;
    if (k !== lhsText.length) {
      return {
        grammar: null,
        error: { message: `left-hand side "${lhsText}" must be a single nonterminal`, line: ln + 1 },
      };
    }
    const lhs = lhsText;
    if (start === null) start = lhs;

    const alts = rhsText.split('|');
    for (const alt of alts) {
      rules.push({ lhs, rhs: parseAlternative(alt) });
    }
  }

  if (start === null || rules.length === 0) {
    return { grammar: null, error: { message: `the grammar has no productions`, line: 1 } };
  }

  return { grammar: makeGrammar(start, rules), error: null };
}
