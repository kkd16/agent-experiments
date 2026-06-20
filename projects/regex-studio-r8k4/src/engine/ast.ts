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
  | { type: 'group'; node: RegexNode; index: number }; // ( ... )

export interface ParseError {
  message: string;
  index: number; // position in the source pattern
}
