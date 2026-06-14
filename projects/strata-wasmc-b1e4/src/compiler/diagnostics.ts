// Source positions and the single error type used across every compiler phase.
// A Span points back into the original source text so the UI can underline the
// exact characters that caused a problem.

export interface Span {
  start: number; // byte/char offset of the first character (inclusive)
  end: number; // offset just past the last character (exclusive)
  line: number; // 1-based line of `start`
  col: number; // 1-based column of `start`
}

export const NO_SPAN: Span = { start: 0, end: 0, line: 1, col: 1 };

/** Which phase produced a diagnostic — used for grouping/coloring in the UI. */
export type Phase = 'lex' | 'parse' | 'type' | 'ir' | 'codegen';

export class CompileError extends Error {
  readonly span: Span;
  readonly phase: Phase;
  constructor(message: string, span: Span, phase: Phase) {
    super(message);
    this.name = 'CompileError';
    this.span = span;
    this.phase = phase;
  }
}

/** Recover the 1-based line/column for an offset (used by the lexer). */
export function lineColAt(source: string, offset: number): { line: number; col: number } {
  let line = 1;
  let col = 1;
  for (let i = 0; i < offset && i < source.length; i++) {
    if (source[i] === '\n') {
      line++;
      col = 1;
    } else {
      col++;
    }
  }
  return { line, col };
}
