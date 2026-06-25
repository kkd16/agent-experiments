// The abstract syntax tree the parser produces and the evaluator walks. A plain
// discriminated union — no classes — so it serializes trivially and pattern-matches
// exhaustively under `strict`.

import type { CellRef } from './address'
import type { ErrorCode } from './values'

export type BinaryOp = '+' | '-' | '*' | '/' | '^' | '&' | '=' | '<>' | '<' | '>' | '<=' | '>='
export type UnaryOp = '-' | '+'

export type Node =
  | { type: 'num'; value: number }
  | { type: 'str'; value: string }
  | { type: 'bool'; value: boolean }
  | { type: 'error'; code: ErrorCode }
  | { type: 'ref'; ref: CellRef }
  | { type: 'range'; from: CellRef; to: CellRef }
  // Spilled-range reference (`A1#`): the whole dynamic array anchored at `ref`.
  | { type: 'spillref'; ref: CellRef }
  | { type: 'name'; name: string }
  | { type: 'unary'; op: UnaryOp; operand: Node }
  | { type: 'percent'; operand: Node }
  | { type: 'binary'; op: BinaryOp; left: Node; right: Node }
  | { type: 'call'; name: string; args: Node[] }
  // Postfix application of a computed function value, e.g. `LAMBDA(x, x+1)(5)`.
  | { type: 'apply'; fn: Node; args: Node[] }
