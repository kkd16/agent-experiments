// Aether — editor semantics (a tiny language server, in-process)
//
// A pure query layer that turns the live pipeline artifacts (the user's typed
// AST plus the inference result) into the answers an IDE needs: the inferred
// type under the cursor, where a name is bound and every place it is used, and
// the set of in-scope completions at a point. It owns *no* type theory of its
// own — it only re-reads what `infer.ts` already computed (`nodeTypes`,
// `bindingSchemes`, `ctorInfo`) and what the parser already recorded (every
// node's source `span`). That keeps the editor's intelligence honest: a hover
// shows exactly the type the three backends compile, never a second guess.

import type { Expr, Pattern } from './ast.ts'
import { children } from './ast.ts'
import type { Span } from './lexer.ts'
import type { InferResult } from './infer.ts'
import type { Scheme } from './types.ts'
import { schemeToString, typeToString } from './types.ts'
import type { GlobalEntry } from './prelude.ts'

const IDENT_RE = /[A-Za-z0-9_']/

/** Kinds of thing a name can be bound by, used to colour completions/hovers. */
export type BinderKind = 'let' | 'letrec' | 'param' | 'match' | 'ctor' | 'method'

/** One resolved name: where it is defined and every span that refers to it. */
export interface BinderInfo {
  name: string
  kind: BinderKind
  defSpan: Span
  /** the binding's generalised scheme, pretty-printed, when inference knows it */
  scheme: string | null
  /** def + every use, in source order */
  occurrences: Span[]
}

/** A pre-computed semantic view of one program, keyed for fast cursor queries. */
export interface SemanticIndex {
  ast: Expr | null
  types: InferResult | null
  source: string
  binders: BinderInfo[]
  /** the `var`/use node → the binder it resolves to (null for globals/free) */
  useBinder: Map<Expr, BinderInfo>
}

/** Information shown in a hover card. */
export interface HoverInfo {
  /** the source range the card describes (anchors the tooltip) */
  span: Span
  /** a short title, e.g. `let twice`, `parameter n`, `expression` */
  title: string
  /** the inferred type at this point */
  type: string | null
  /** the generalised scheme, when this is (or refers to) a binding */
  scheme: string | null
  /** how the name resolves: 'local' | 'prelude' | 'constructor' | … */
  origin: string | null
}

/** A single completion candidate offered at the cursor. */
export interface Completion {
  label: string
  kind: 'keyword' | 'local' | 'param' | 'global' | 'prelude' | 'ctor' | 'method'
  /** the type/scheme shown to the right of the label */
  detail: string
}

/** Where a completion request replaces text, plus its ranked candidates. */
export interface CompletionResult {
  from: number
  to: number
  prefix: string
  items: Completion[]
}

// ---------------------------------------------------------------------------
// source helpers
// ---------------------------------------------------------------------------

function within(span: Span, offset: number): boolean {
  return offset >= span.start && offset <= span.end
}

function spanWidth(span: Span): number {
  return span.end - span.start
}

/** 1-based line/col of an absolute offset (mirrors the lexer's convention). */
export function offsetToLineCol(source: string, offset: number): { line: number; col: number } {
  let line = 1
  let col = 1
  for (let i = 0; i < offset && i < source.length; i++) {
    if (source[i] === '\n') {
      line++
      col = 1
    } else {
      col++
    }
  }
  return { line, col }
}

/** Find the span of `name` as a whole identifier at/after `from` in `source`. */
function findWordSpan(source: string, name: string, from: number): Span | null {
  let idx = source.indexOf(name, Math.max(0, from))
  while (idx >= 0) {
    const before = idx > 0 ? source[idx - 1] : ' '
    const after = idx + name.length < source.length ? source[idx + name.length] : ' '
    if (!IDENT_RE.test(before) && !IDENT_RE.test(after)) {
      const { line, col } = offsetToLineCol(source, idx)
      return { start: idx, end: idx + name.length, line, col }
    }
    idx = source.indexOf(name, idx + 1)
  }
  return null
}

function schemeStr(scheme: Scheme | undefined): string | null {
  return scheme ? schemeToString(scheme) : null
}

/** All variable names a pattern binds, with their source spans. */
function patternVars(p: Pattern): { name: string; span: Span }[] {
  switch (p.kind) {
    case 'pvar':
      return [{ name: p.name, span: p.span }]
    case 'pcons':
      return [...patternVars(p.head), ...patternVars(p.tail)]
    case 'ptuple':
      return p.elements.flatMap(patternVars)
    case 'pcon':
      return p.args.flatMap(patternVars)
    default:
      return []
  }
}

// ---------------------------------------------------------------------------
// name resolution — build the binder table
// ---------------------------------------------------------------------------

/**
 * Walk the AST with a lexical environment, recording for every binding where it
 * is defined and which `var` nodes resolve to it. Shadowing is honoured because
 * each scope gets a fresh `Map`. Globals, constructors not declared in-program,
 * and genuinely free names simply never enter the table.
 */
export function buildSemanticIndex(
  ast: Expr | null,
  types: InferResult | null,
  source: string,
): SemanticIndex {
  const binders: BinderInfo[] = []
  const useBinder = new Map<Expr, BinderInfo>()

  const record = (b: BinderInfo): BinderInfo => {
    binders.push(b)
    return b
  }

  const go = (node: Expr, env: Map<string, BinderInfo>): void => {
    switch (node.kind) {
      case 'var': {
        const b = env.get(node.name)
        if (b) {
          b.occurrences.push(node.span)
          useBinder.set(node, b)
        }
        return
      }
      case 'let': {
        const defSpan = findWordSpan(source, node.name, node.span.start) ?? node.span
        const b = record({
          name: node.name,
          kind: 'let',
          defSpan,
          scheme: schemeStr(types?.bindingSchemes.get(node)),
          occurrences: [defSpan],
        })
        const inner = new Map(env)
        inner.set(node.name, b)
        go(node.value, node.recursive ? inner : env)
        go(node.body, inner)
        return
      }
      case 'letrec': {
        const inner = new Map(env)
        for (const bd of node.bindings) {
          const defSpan = findWordSpan(source, bd.name, node.span.start) ?? bd.value.span
          const b = record({
            name: bd.name,
            kind: 'letrec',
            defSpan,
            scheme: schemeStr(types?.bindingSchemes.get(bd.value)),
            occurrences: [defSpan],
          })
          inner.set(bd.name, b)
        }
        for (const bd of node.bindings) go(bd.value, inner)
        go(node.body, inner)
        return
      }
      case 'lambda': {
        const defSpan = findWordSpan(source, node.param, node.span.start) ?? node.span
        const b = record({
          name: node.param,
          kind: 'param',
          defSpan,
          scheme: null,
          occurrences: [defSpan],
        })
        const inner = new Map(env)
        inner.set(node.param, b)
        go(node.body, inner)
        return
      }
      case 'match': {
        go(node.scrutinee, env)
        for (const c of node.cases) {
          const inner = new Map(env)
          for (const pv of patternVars(c.pattern)) {
            const b = record({
              name: pv.name,
              kind: 'match',
              defSpan: pv.span,
              scheme: null,
              occurrences: [pv.span],
            })
            inner.set(pv.name, b)
          }
          if (c.guard) go(c.guard, inner)
          go(c.body, inner)
        }
        return
      }
      case 'typedecl': {
        const inner = new Map(env)
        for (const ct of node.ctors) {
          const b = record({
            name: ct.name,
            kind: 'ctor',
            defSpan: ct.span,
            scheme: schemeStr(types?.ctorInfo.get(ct.name)?.scheme),
            occurrences: [ct.span],
          })
          inner.set(ct.name, b)
        }
        go(node.body, inner)
        return
      }
      case 'classdecl': {
        const inner = new Map(env)
        for (const m of node.methods) {
          const defSpan = findWordSpan(source, m.name, m.span.start) ?? m.span
          const b = record({
            name: m.name,
            kind: 'method',
            defSpan,
            scheme: null,
            occurrences: [defSpan],
          })
          inner.set(m.name, b)
          if (m.default) go(m.default, inner)
        }
        go(node.body, inner)
        return
      }
      case 'instancedecl': {
        for (const m of node.methods) go(m.value, env)
        go(node.body, env)
        return
      }
      default:
        for (const ch of children(node)) go(ch, env)
    }
  }

  if (ast) go(ast, new Map())
  return { ast, types, source, binders, useBinder }
}

// ---------------------------------------------------------------------------
// cursor queries
// ---------------------------------------------------------------------------

/** Smallest typed expression node whose span covers `offset`. */
function smallestTypedNode(ast: Expr, types: InferResult, offset: number): Expr | null {
  let best: Expr | null = null
  const visit = (node: Expr): void => {
    if (within(node.span, offset) && types.nodeTypes.has(node)) {
      if (!best || spanWidth(node.span) <= spanWidth(best.span)) best = node
    }
    for (const ch of children(node)) visit(ch)
  }
  visit(ast)
  return best
}

/** The binder whose definition or a use covers `offset`, most-specific first. */
function binderAt(index: SemanticIndex, offset: number): BinderInfo | null {
  let best: BinderInfo | null = null
  let bestWidth = Infinity
  for (const b of index.binders) {
    for (const occ of b.occurrences) {
      if (within(occ, offset) && spanWidth(occ) < bestWidth) {
        best = b
        bestWidth = spanWidth(occ)
      }
    }
  }
  return best
}

/** Def + every use of the name under `offset` (for occurrence highlighting). */
export function occurrencesAt(index: SemanticIndex, offset: number): Span[] | null {
  const b = binderAt(index, offset)
  return b ? b.occurrences : null
}

/** The definition span of the name under `offset` (for go-to-definition). */
export function definitionAt(index: SemanticIndex, offset: number): Span | null {
  const b = binderAt(index, offset)
  return b ? b.defSpan : null
}

/** The binder under `offset` — used by rename to know what's renameable. */
export function binderUnder(index: SemanticIndex, offset: number): BinderInfo | null {
  return binderAt(index, offset)
}

/**
 * Rename every occurrence of the binder under `offset` to `newName`, returning
 * the rewritten source and the caret offset to land on. Because renaming only
 * touches the spans the resolver already proved refer to *this* binding, a
 * shadowed name elsewhere is never disturbed. Spans are rewritten right-to-left
 * so earlier offsets stay valid as the text length changes.
 */
export function renameBinder(
  index: SemanticIndex,
  offset: number,
  newName: string,
): { source: string; caret: number } | null {
  const b = binderAt(index, offset)
  if (!b) return null
  const spans = [...b.occurrences].sort((x, y) => y.start - x.start)
  let src = index.source
  for (const s of spans) src = src.slice(0, s.start) + newName + src.slice(s.end)
  return { source: src, caret: b.defSpan.start + newName.length }
}

/** Whether `name` is a syntactically valid lower/upper identifier for rename. */
export function isValidName(name: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_']*$/.test(name)
}

/** The hover card for `offset`, or null if there's nothing meaningful there. */
export function hoverAt(index: SemanticIndex, offset: number): HoverInfo | null {
  const { ast, types } = index
  // 1. directly on a binder's definition → show its generalised scheme
  const onBinder = binderAt(index, offset)
  if (onBinder && within(onBinder.defSpan, offset)) {
    return {
      span: onBinder.defSpan,
      title: binderTitle(onBinder),
      type: null,
      scheme: onBinder.scheme,
      origin: kindOrigin(onBinder.kind),
    }
  }

  if (!ast || !types) return null
  const node = smallestTypedNode(ast, types, offset)
  if (!node) return null
  const nodeType = types.nodeTypes.get(node)
  const typeStr = nodeType ? typeToString(nodeType) : null

  // 2. on a use of a known name → use-site type + the binder's scheme
  if (node.kind === 'var') {
    const bound = index.useBinder.get(node)
    return {
      span: node.span,
      title: bound ? binderTitle(bound) : node.name,
      type: typeStr,
      scheme: bound ? bound.scheme : null,
      origin: bound ? kindOrigin(bound.kind) : null,
    }
  }

  // 3. any other typed sub-expression
  return {
    span: node.span,
    title: exprTitle(node),
    type: typeStr,
    scheme: null,
    origin: null,
  }
}

function binderTitle(b: BinderInfo): string {
  switch (b.kind) {
    case 'let':
      return `let ${b.name}`
    case 'letrec':
      return `let rec ${b.name}`
    case 'param':
      return `parameter ${b.name}`
    case 'match':
      return `pattern ${b.name}`
    case 'ctor':
      return `constructor ${b.name}`
    case 'method':
      return `method ${b.name}`
  }
}

function kindOrigin(kind: BinderKind): string {
  switch (kind) {
    case 'let':
    case 'letrec':
      return 'local binding'
    case 'param':
      return 'lambda parameter'
    case 'match':
      return 'pattern variable'
    case 'ctor':
      return 'data constructor'
    case 'method':
      return 'class method'
  }
}

function exprTitle(node: Expr): string {
  switch (node.kind) {
    case 'app':
      return 'application'
    case 'binop':
      return `operator ${node.op}`
    case 'unop':
      return `operator ${node.op}`
    case 'if':
      return 'if-expression'
    case 'match':
      return 'match-expression'
    case 'lambda':
      return 'lambda'
    case 'list':
      return 'list'
    case 'tuple':
      return 'tuple'
    case 'record':
      return 'record'
    case 'field':
      return `field .${node.label}`
    default:
      return 'expression'
  }
}

// ---------------------------------------------------------------------------
// inlay hints — end-of-line type annotations for let bindings
// ---------------------------------------------------------------------------

export interface InlayHint {
  /** offset of the binding name (the editor turns this into a screen row) */
  anchor: number
  /** the text to show as ghost, e.g. `: Int -> Int` */
  text: string
}

/** A faded `: type` for every `let`/`let rec`/`λ`-parameter binding. */
export function inlayHints(index: SemanticIndex): InlayHint[] {
  const out: InlayHint[] = []
  for (const b of index.binders) {
    if (b.kind === 'param' || b.kind === 'match' || b.kind === 'ctor' || b.kind === 'method') continue
    if (!b.scheme) continue
    // strip a leading `∀`-binder list so the ghost stays short and readable
    const body = b.scheme.replace(/^forall[^.]*\.\s*/, '').replace(/^∀[^.]*\.\s*/, '')
    out.push({ anchor: b.defSpan.start, text: `: ${body}` })
  }
  return out
}

// ---------------------------------------------------------------------------
// completion
// ---------------------------------------------------------------------------

const KEYWORDS = [
  'let',
  'rec',
  'in',
  'fn',
  'if',
  'then',
  'else',
  'match',
  'with',
  'when',
  'type',
  'class',
  'instance',
  'where',
  'deriving',
  'true',
  'false',
]

/**
 * The Aether-source prelude library (functions written in Aether, not TS
 * primitives) and their types — kept here so completions describe them without
 * a second inference pass over the prelude.
 */
const PRELUDE_SIGS: Record<string, string> = {
  map: '(a -> b) -> List a -> List b',
  filter: '(a -> Bool) -> List a -> List a',
  foldl: '(b -> a -> b) -> b -> List a -> b',
  foldr: '(a -> b -> b) -> b -> List a -> b',
  length: 'List a -> Int',
  append: 'List a -> List a -> List a',
  reverse: 'List a -> List a',
  sum: 'List Int -> Int',
  range: 'Int -> Int -> List Int',
  take: 'Int -> List a -> List a',
  drop: 'Int -> List a -> List a',
  elem: 'a -> List a -> Bool',
  all: '(a -> Bool) -> List a -> Bool',
  any: '(a -> Bool) -> List a -> Bool',
  concat: 'List (List a) -> List a',
  zip: 'List a -> List b -> List (a, b)',
  replicate: 'Int -> a -> List a',
}

/** Binders that are lexically in scope at `offset` (names + best-effort type). */
function scopeAt(index: SemanticIndex, offset: number): BinderInfo[] {
  const { ast } = index
  if (!ast) return []
  const acc: BinderInfo[] = []
  const byName = new Map<string, BinderInfo>()
  const add = (b: BinderInfo): void => {
    byName.set(b.name, b) // inner scopes shadow outer
  }

  const go = (node: Expr): void => {
    switch (node.kind) {
      case 'let': {
        const b = lookupBinder(index, node.name, findWordSpan(index.source, node.name, node.span.start))
        if (node.recursive && within(node.value.span, offset)) {
          if (b) add(b)
          go(node.value)
          return
        }
        if (within(node.body.span, offset)) {
          if (b) add(b)
          go(node.body)
          return
        }
        if (within(node.value.span, offset)) go(node.value)
        return
      }
      case 'letrec': {
        const here =
          node.bindings.find((bd) => within(bd.value.span, offset)) ?? null
        const inBody = within(node.body.span, offset)
        if (here || inBody) {
          for (const bd of node.bindings) {
            const b = lookupBinder(index, bd.name, findWordSpan(index.source, bd.name, node.span.start))
            if (b) add(b)
          }
        }
        if (here) go(here.value)
        else if (inBody) go(node.body)
        return
      }
      case 'lambda': {
        if (within(node.body.span, offset)) {
          const b = lookupBinder(index, node.param, findWordSpan(index.source, node.param, node.span.start))
          if (b) add(b)
          go(node.body)
        }
        return
      }
      case 'match': {
        if (within(node.scrutinee.span, offset)) {
          go(node.scrutinee)
          return
        }
        for (const c of node.cases) {
          const region = c.guard
            ? within(c.guard.span, offset) || within(c.body.span, offset)
            : within(c.body.span, offset)
          if (!region) continue
          for (const pv of patternVars(c.pattern)) {
            const b = lookupBinder(index, pv.name, pv.span)
            if (b) add(b)
          }
          if (c.guard && within(c.guard.span, offset)) go(c.guard)
          else go(c.body)
          return
        }
        return
      }
      case 'typedecl': {
        for (const ct of node.ctors) {
          const b = lookupBinder(index, ct.name, ct.span)
          if (b) add(b)
        }
        if (within(node.body.span, offset)) go(node.body)
        return
      }
      case 'classdecl': {
        for (const m of node.methods) {
          const b = lookupBinder(index, m.name, findWordSpan(index.source, m.name, m.span.start))
          if (b) add(b)
        }
        if (within(node.body.span, offset)) go(node.body)
        return
      }
      case 'instancedecl': {
        const m = node.methods.find((mm) => within(mm.value.span, offset))
        if (m) go(m.value)
        else if (within(node.body.span, offset)) go(node.body)
        return
      }
      default:
        for (const ch of children(node)) {
          if (within(ch.span, offset)) {
            go(ch)
            return
          }
        }
    }
  }

  go(ast)
  acc.push(...byName.values())
  return acc
}

/** Find the recorded binder matching a name whose def is at `span` (identity). */
function lookupBinder(index: SemanticIndex, name: string, span: Span | null): BinderInfo | null {
  if (!span) return index.binders.find((b) => b.name === name) ?? null
  return (
    index.binders.find((b) => b.name === name && b.defSpan.start === span.start) ??
    index.binders.find((b) => b.name === name) ??
    null
  )
}

/**
 * Ranked completions at `offset`. Combines the lexical scope (locals, params,
 * pattern vars, constructors, class methods), the TypeScript primitives, the
 * Aether prelude library, user data constructors, and keywords — each filtered
 * by the identifier prefix immediately left of the cursor.
 */
export function completionItems(
  index: SemanticIndex,
  source: string,
  offset: number,
  globals: GlobalEntry[],
): CompletionResult {
  // identifier prefix being typed
  let from = offset
  while (from > 0 && IDENT_RE.test(source[from - 1])) from--
  const prefix = source.slice(from, offset)

  const seen = new Set<string>()
  const items: Completion[] = []
  const push = (label: string, kind: Completion['kind'], detail: string): void => {
    if (seen.has(label)) return
    seen.add(label)
    items.push({ label, kind, detail })
  }

  // 1. lexical scope (most specific — added first so it shadows globals)
  for (const b of scopeAt(index, from)) {
    const kind: Completion['kind'] =
      b.kind === 'param' || b.kind === 'match'
        ? 'param'
        : b.kind === 'ctor'
          ? 'ctor'
          : b.kind === 'method'
            ? 'method'
            : 'local'
    push(b.name, kind, b.scheme ?? '')
  }

  // 2. user data constructors anywhere in the program
  if (index.types) {
    for (const [name, info] of index.types.ctorInfo) {
      push(name, 'ctor', schemeToString(info.scheme))
    }
  }

  // 3. TypeScript primitives
  for (const g of globals) push(g.name, 'global', schemeToString(g.scheme))

  // 4. Aether prelude library
  for (const [name, sig] of Object.entries(PRELUDE_SIGS)) push(name, 'prelude', sig)

  // 5. keywords
  for (const kw of KEYWORDS) push(kw, 'keyword', '')

  const lower = prefix.toLowerCase()
  const filtered = prefix
    ? items.filter((it) => it.label.toLowerCase().startsWith(lower))
    : items
  filtered.sort((a, b) => rank(a, prefix) - rank(b, prefix) || a.label.localeCompare(b.label))

  return { from, to: offset, prefix, items: filtered.slice(0, 60) }
}

const KIND_RANK: Record<Completion['kind'], number> = {
  local: 0,
  param: 0,
  ctor: 1,
  method: 1,
  prelude: 2,
  global: 3,
  keyword: 4,
}

function rank(it: Completion, prefix: string): number {
  // exact-case prefix matches sort above case-insensitive ones, then by kind
  const exact = prefix && it.label.startsWith(prefix) ? 0 : 1
  return exact * 10 + KIND_RANK[it.kind]
}
