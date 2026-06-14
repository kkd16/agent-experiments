// The compiler driver. `compile(source)` runs the whole pipeline — lex, parse, type-check,
// codegen — over the user's program (linked with the self-hosted prelude) and returns the
// generated RV32IM assembly text plus everything the IDE wants to visualize (tokens, the
// user AST, and any diagnostics). Diagnostics carry a `line` so the editor can point at them.

import { lex, CError } from './lexer';
import type { Tok } from './token';
import { parse, Parser } from './parser';
import type { Program } from './ast';
import { Sema } from './sema';
import { generate, CodegenError } from './codegen';
import { PRELUDE_SOURCE } from './prelude';

export interface Diag {
  line: number;
  message: string;
  where: 'lex' | 'parse' | 'type' | 'codegen';
}

export interface CompileResult {
  ok: boolean;
  diags: Diag[];
  tokens: Tok[];
  ast: Program | null;
  asm: string | null;
}

let preludeCache: Program | null = null;
function prelude(): Program {
  if (!preludeCache) preludeCache = parse(PRELUDE_SOURCE);
  return preludeCache;
}

export function compile(source: string): CompileResult {
  const diags: Diag[] = [];
  let tokens: Tok[] = [];
  try {
    tokens = lex(source);
  } catch (e) {
    return fail(diags, e, 'lex', tokens, null);
  }

  let userProg: Program;
  try {
    userProg = parse(source);
  } catch (e) {
    return fail(diags, e, 'parse', tokens, null);
  }

  // Link the prelude in front of the user's program. Parsing them separately keeps user
  // line numbers intact (prelude AST nodes carry their own, harmless, line numbers).
  let pre: Program;
  try {
    pre = prelude();
  } catch (e) {
    return fail(diags, e, 'parse', tokens, userProg);
  }
  const merged: Program = {
    funcs: [...pre.funcs, ...userProg.funcs],
    globals: [...pre.globals, ...userProg.globals],
  };

  const sema = new Sema();
  const semaErrors = sema.check(merged);
  if (semaErrors.length) {
    for (const e of semaErrors) diags.push({ line: e.line, message: e.message, where: 'type' });
    return { ok: false, diags, tokens, ast: userProg, asm: null };
  }

  let asm: string;
  try {
    asm = generate(merged, sema.strings);
  } catch (e) {
    if (e instanceof CodegenError) {
      diags.push({ line: e.line, message: e.message, where: 'codegen' });
      return { ok: false, diags, tokens, ast: userProg, asm: null };
    }
    throw e;
  }

  return { ok: true, diags, tokens, ast: userProg, asm };
}

function fail(diags: Diag[], e: unknown, where: Diag['where'], tokens: Tok[], ast: Program | null): CompileResult {
  if (e instanceof CError) diags.push({ line: e.line, message: e.message, where });
  else diags.push({ line: 0, message: (e as Error).message, where });
  return { ok: false, diags, tokens, ast, asm: null };
}

// Expose the parser for callers that want only an AST (e.g. tests).
export { Parser };
