// Aether — compilation & execution pipeline
//
// Glue that runs source through every stage and collects each intermediate
// artifact (tokens, AST, types, bytecode, VM run) so the UI can show the whole
// journey. The user's program is wrapped in the Aether-source prelude before
// type-checking and compilation; the visualisers display only the user portion.

import type { Expr } from './ast.ts'
import type { Span, Token } from './lexer.ts'
import { LexError, tokenize } from './lexer.ts'
import { ParseError, parse } from './parser.ts'
import { TypeCheckError, baseEnvFrom, inferProgram } from './infer.ts'
import type { InferResult } from './infer.ts'
import { resetVarCounter, schemeToString, typeToString } from './types.ts'
import { GLOBALS, PRELUDE_DEFS } from './prelude.ts'
import { CompileError, compile } from './compiler.ts'
import { elaborate } from './classes.ts'
import { optimize } from './optimize.ts'
import type { FnProto } from './bytecode.ts'
import { VM } from './vm.ts'
import type { RunResult } from './vm.ts'

const SYNTH_SPAN: Span = { start: 0, end: 0, line: 0, col: 0 }

// Parse each prelude definition once.
const PRELUDE_PARSED: { name: string; recursive: boolean; value: Expr }[] = PRELUDE_DEFS.map(
  (d) => ({ name: d.name, recursive: d.recursive, value: parse(d.src) }),
)

/** Wrap the user's expression in nested prelude `let`s (lexical order). */
function withPrelude(userExpr: Expr): Expr {
  let acc = userExpr
  for (let i = PRELUDE_PARSED.length - 1; i >= 0; i--) {
    const def = PRELUDE_PARSED[i]
    acc = {
      kind: 'let',
      name: def.name,
      value: def.value,
      body: acc,
      recursive: def.recursive,
      span: SYNTH_SPAN,
    }
  }
  return acc
}

export interface PipelineError {
  stage: 'lex' | 'parse' | 'type' | 'compile' | 'run'
  message: string
  span: Span | null
}

export interface BindingType {
  name: string
  type: string
}

export interface PipelineWarning {
  message: string
  span: Span | null
}

export interface PipelineResult {
  source: string
  tokens: Token[] | null
  /** the user's AST (without the prelude wrapper) */
  ast: Expr | null
  /** the user's AST after dictionary-passing elaboration (core, class-free) */
  coreAst: Expr | null
  typeResult: InferResult | null
  programType: string | null
  bindingTypes: BindingType[]
  warnings: PipelineWarning[]
  /** number of nodes the optimizer folded (0 if optimization is off) */
  foldCount: number
  proto: FnProto | null
  run: RunResult | null
  error: PipelineError | null
}

export interface PipelineOptions {
  record?: boolean
  execute?: boolean
  optimize?: boolean
}

export function runPipeline(source: string, opts: PipelineOptions = {}): PipelineResult {
  const execute = opts.execute ?? true
  const record = opts.record ?? false
  const doOptimize = opts.optimize ?? true
  resetVarCounter()

  const result: PipelineResult = {
    source,
    tokens: null,
    ast: null,
    coreAst: null,
    typeResult: null,
    programType: null,
    bindingTypes: [],
    warnings: [],
    foldCount: 0,
    proto: null,
    run: null,
    error: null,
  }

  // 1. lex
  let tokens: Token[]
  try {
    tokens = tokenize(source)
    result.tokens = tokens
  } catch (e) {
    result.error = toError('lex', e)
    return result
  }

  // 2. parse
  let userAst: Expr
  try {
    userAst = parse(source)
  } catch (e) {
    result.error = toError('parse', e)
    return result
  }

  // 2b. optimize (constant folding, branch elimination, …)
  if (doOptimize) {
    const optimized = optimize(userAst)
    userAst = optimized.expr
    result.foldCount = optimized.folded
  }
  result.ast = userAst

  // 3. type-check (with prelude in scope)
  const program = withPrelude(userAst)
  let inferred: InferResult
  try {
    const baseEnv = baseEnvFrom(GLOBALS)
    inferred = inferProgram(program, baseEnv)
    result.typeResult = inferred
    result.programType = typeToString(inferred.type)
    result.bindingTypes = collectBindingTypes(userAst, inferred)
    result.warnings = inferred.warnings
  } catch (e) {
    result.error = toError('type', e)
    return result
  }

  // 3b. dictionary-passing elaboration (type classes → core AST). A no-op when
  // the program uses no classes. The user portion is exposed for the JS backend.
  const coreProgram = elaborate(program, inferred.classTables)
  result.coreAst = elaborate(userAst, inferred.classTables)

  // 4. compile
  let proto: FnProto
  try {
    proto = compile(coreProgram)
    result.proto = proto
  } catch (e) {
    result.error = toError('compile', e)
    return result
  }

  if (!execute) return result

  // 5. run
  try {
    const vm = new VM(proto, GLOBALS.map((g) => g.value))
    const run = vm.execute(record)
    result.run = run
    if (run.error) {
      result.error = { stage: 'run', message: run.error, span: run.errorSpan }
    }
  } catch (e) {
    result.error = toError('run', e)
  }

  return result
}

function collectBindingTypes(userAst: Expr, inferred: InferResult): BindingType[] {
  const out: BindingType[] = []
  let node: Expr = userAst
  while (node.kind === 'let' || node.kind === 'typedecl' || node.kind === 'letrec') {
    if (node.kind === 'let') {
      const scheme = inferred.bindingSchemes.get(node)
      out.push({ name: node.name, type: scheme ? schemeToString(scheme) : '?' })
    } else if (node.kind === 'letrec') {
      for (const b of node.bindings) {
        const scheme = inferred.bindingSchemes.get(b.value)
        out.push({ name: b.name, type: scheme ? schemeToString(scheme) : '?' })
      }
    }
    node = node.body
  }
  return out
}

function toError(stage: PipelineError['stage'], e: unknown): PipelineError {
  if (e instanceof LexError || e instanceof ParseError) {
    return { stage, message: e.message, span: e.span }
  }
  if (e instanceof TypeCheckError || e instanceof CompileError) {
    return { stage, message: e.message, span: e.span }
  }
  if (e instanceof Error) return { stage, message: e.message, span: null }
  return { stage, message: String(e), span: null }
}

/** Pretty-print the inferred type of any node (for AST hovers). */
export function nodeTypeString(inferred: InferResult | null, node: Expr): string | null {
  if (!inferred) return null
  const t = inferred.nodeTypes.get(node)
  return t ? typeToString(t) : null
}
