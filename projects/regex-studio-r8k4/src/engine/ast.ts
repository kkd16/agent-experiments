// The regular-expression abstract syntax tree. Quantifiers stay distinct here
// (so the AST view reads naturally) and are desugared during NFA construction.
import type { CharSet } from './charset';

export type RegexNode =
  | { type: 'empty' } // matches the empty string (ε)
  | { type: 'char'; set: CharSet; raw: string } // a single character, class or dot
  | { type: 'concat'; parts: RegexNode[] }
  | { type: 'alt'; options: RegexNode[] }
  | { type: 'star'; node: RegexNode; lazy: boolean } // *
  | { type: 'plus'; node: RegexNode; lazy: boolean } // +
  | { type: 'opt'; node: RegexNode; lazy: boolean } // ?
  | { type: 'repeat'; node: RegexNode; min: number; max: number | null; lazy: boolean } // {m,n}
  | { type: 'group'; node: RegexNode; index: number; name?: string } // ( ... ) and (?<name>…)
  // --- positional / non-regular constructs (handled by the backtracking VM) ---
  | { type: 'anchor'; at: 'start' | 'end' } // ^  $
  | { type: 'boundary'; negate: boolean } // \b  \B
  | { type: 'backref'; index: number; name?: string } // \1 … \9 and \k<name>
  | { type: 'look'; dir: 'ahead' | 'behind'; negate: boolean; node: RegexNode }; // (?=) (?!) (?<=) (?<!)

export interface ParseError {
  message: string;
  index: number; // position in the source pattern
}

// Which extra capabilities a pattern uses. The automata pipeline only handles
// the strictly-regular subset; anything here routes the pattern to the VM.
export interface AstFeatures {
  regular: boolean; // true ⇒ the NFA/DFA pipeline can represent it exactly
  anchors: boolean;
  boundaries: boolean;
  backrefs: boolean;
  lookaround: boolean;
  reasons: string[]; // human-readable list of the non-regular features used
}

export function analyzeFeatures(ast: RegexNode): AstFeatures {
  const f: AstFeatures = {
    regular: true,
    anchors: false,
    boundaries: false,
    backrefs: false,
    lookaround: false,
    reasons: [],
  };
  const walk = (n: RegexNode): void => {
    switch (n.type) {
      case 'empty':
      case 'char':
        return;
      case 'concat':
        n.parts.forEach(walk);
        return;
      case 'alt':
        n.options.forEach(walk);
        return;
      case 'star':
      case 'plus':
      case 'opt':
      case 'repeat':
      case 'group':
        walk(n.node);
        return;
      case 'anchor':
        f.anchors = true;
        return;
      case 'boundary':
        f.boundaries = true;
        return;
      case 'backref':
        f.backrefs = true;
        return;
      case 'look':
        f.lookaround = true;
        walk(n.node);
        return;
    }
  };
  walk(ast);
  if (f.anchors) f.reasons.push('anchors (^ $)');
  if (f.boundaries) f.reasons.push('word boundaries (\\b)');
  if (f.backrefs) f.reasons.push('backreferences (\\1)');
  if (f.lookaround) f.reasons.push('lookaround ((?=…))');
  // Anchors and boundaries are positional assertions; backrefs and lookaround
  // can describe non-regular languages. All four fall outside the plain
  // alphabet-driven NFA/DFA model this app's automata views are built on.
  f.regular = f.reasons.length === 0;
  return f;
}
