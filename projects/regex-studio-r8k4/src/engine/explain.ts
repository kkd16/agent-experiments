// Render a parsed regex AST as plain English. Useful both as a learning aid and
// as a sanity check that the pattern says what you think it does.

import type { RegexNode } from './ast';
import { CharSet, DIGIT, DOT, MAX_CODE_POINT, SPACE, WORD } from './charset';

function charPhrase(set: CharSet, raw: string): string {
  if (set.equals(DIGIT)) return 'any digit';
  if (set.equals(DIGIT.negate())) return 'any non-digit';
  if (set.equals(WORD)) return 'any word character';
  if (set.equals(WORD.negate())) return 'any non-word character';
  if (set.equals(SPACE)) return 'any whitespace';
  if (set.equals(SPACE.negate())) return 'any non-whitespace';
  if (set.equals(DOT)) return 'any character except a line break';
  if (set.equals(CharSet.fromRange(0, MAX_CODE_POINT))) return 'any character';
  if (set.size() === 1) return `the character “${raw}”`;
  const neg = set.negate();
  if (neg.size() < set.size()) return `any character other than ${neg.label()}`;
  return `any character in ${set.label()}`;
}

function quant(body: string, lazyWord: string): string {
  return body + (lazyWord ? ` (${lazyWord})` : '');
}

export function explain(node: RegexNode): string {
  switch (node.type) {
    case 'empty':
      return 'the empty string';
    case 'char':
      return charPhrase(node.set, node.raw);
    case 'concat':
      return node.parts.map(explain).join(', then ');
    case 'alt':
      return 'either ' + node.options.map(explain).join(', or ');
    case 'star':
      return quant(`zero or more of [${explain(node.node)}]`, node.lazy ? 'lazy' : '');
    case 'plus':
      return quant(`one or more of [${explain(node.node)}]`, node.lazy ? 'lazy' : '');
    case 'opt':
      return quant(`an optional [${explain(node.node)}]`, node.lazy ? 'lazy' : '');
    case 'repeat': {
      const inner = explain(node.node);
      let count: string;
      if (node.max === null) count = `at least ${node.min}`;
      else if (node.max === node.min) count = `exactly ${node.min}`;
      else count = `between ${node.min} and ${node.max}`;
      return quant(`${count} of [${inner}]`, node.lazy ? 'lazy' : '');
    }
    case 'group':
      return `a captured group #${node.index} of [${explain(node.node)}]`;
    case 'anchor':
      return node.at === 'start' ? 'the start of the line/string' : 'the end of the line/string';
    case 'boundary':
      return node.negate ? 'a non-word-boundary position' : 'a word boundary';
    case 'backref':
      return `the same text previously captured by group #${node.index}`;
    case 'look': {
      const verb = node.dir === 'ahead' ? 'followed by' : 'preceded by';
      const not = node.negate ? 'not ' : '';
      return `a position ${not}${verb} [${explain(node.node)}]`;
    }
    case 'intersect':
      return 'a string matching every one of [' + node.parts.map(explain).join('] and [') + ']';
    case 'complement':
      return `any string that does NOT match [${explain(node.node)}]`;
  }
}

export function explainTopLevel(node: RegexNode): string {
  const body = explain(node);
  return `Match ${body}.`;
}
