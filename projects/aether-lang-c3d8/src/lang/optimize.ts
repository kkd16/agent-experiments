// Aether — the optimizing middle-end ("Aether Opt")
//
// A real, multi-pass, fixpoint optimizer that rewrites the *core* AST (the
// dictionary-passing-elaborated, class-free program) into a smaller, faster
// equivalent one. It runs after type inference + elaboration and before any of
// the three backends, so the bytecode VM, the JavaScript backend and the
// WebAssembly backend **all** compile the optimized program — and the existing
// "✓ matches the VM" equivalence checks re-prove, on every example, that the
// optimizer never changed an answer.
//
// Every rewrite below is *semantics-preserving for a strict, effectful language*.
// Aether is pure except for `print` and the turtle, whose effects are observable
// in order, so the optimizer is scrupulous about never reordering, duplicating or
// dropping a computation that could print, diverge or raise. The conservative
// engine for that is two predicates — `isValue` (evaluating it does no work and
// cannot diverge/raise) and `isPure` (no observable effect and terminates) — plus
// capture-avoiding substitution so inlining never captures a free variable.
//
// The passes (run to a fixpoint, bottom-up):
//   • const-fold       — arithmetic / comparison / boolean / string on literals
//   • algebra          — identity & absorbing laws (x+0, x*1, x++[], true&&x, …)
//   • if-fold          — `if true …`, `if c then e else e`
//   • beta             — `(fn x -> b) a` ⇒ `let x = a in b` (+ let-float so curried
//                        applications reduce), then η-contract `fn x -> f x` ⇒ f
//   • inline / copy-prop— substitute a let-bound *value* (atoms always; a lambda
//                        only when used at most once, so code never blows up)
//   • dead-binding     — drop an unused `let`/`letrec` binding whose value is pure
//   • known-match      — reduce `match` on a statically-known constructor / literal /
//                        tuple / list to the chosen arm (binding fields with `let`s),
//                        dropping arms that provably cannot match
//   • field projection — `{ a = e1, … }.a` ⇒ e1 (when the dropped fields are pure)
//   • seq cleanup      — `(); rest` and `pure; rest` ⇒ rest
//
// `known-match` + `field projection` + `inline` are what make the abstraction the
// front end adds — type-class dictionaries, `deriving`, `do`-notation, list
// comprehensions, the `|>` pipe — melt away: a dictionary record is inlined, the
// method projected out, the call β-reduced, and a `match` on a now-literal
// constructor collapses to its arm.

import type { BinaryOp, Expr, MatchCase, Pattern } from './ast.ts'
import { collectSiblings, compileMatches } from './decisiontree.ts'
import type { DtStats, DtView } from './decisiontree.ts'
import { analyzeTermination } from './termination.ts'
import type { TerminationResult } from './termination.ts'

export interface OptimizeStats {
  /** fixpoint rounds run */
  rounds: number
  /** total rewrites performed */
  total: number
  /** rewrites attributed to each named rule */
  passes: Record<string, number>
  /** AST node count before / after */
  nodesBefore: number
  nodesAfter: number
  /** per-round progress: the rewrites fired and the surviving node count after
   * each fixpoint round, so the UI can show the program *melting* step by step */
  trace: { round: number; rewrites: number; nodes: number }[]
  /** the functions the effect-&-totality analysis proved pure (effect-free and
   * total), whose saturated calls CSE / dead-code-elimination may share or drop */
  pureFns: string[]
  /** decision-tree compilation statistics (Aether 12.0) */
  dt: DtStats
  /** one entry per `match` rewritten into a decision tree (for the panel) */
  decisionTrees: DtView[]
  /** size-change termination analysis — the proof that lets the totality analysis
   *  admit *recursive* functions (Aether 13.0). Null only if it wasn't run. */
  termination: TerminationResult | null
}

export interface OptimizeResult {
  expr: Expr
  stats: OptimizeStats
}

const MAX_ROUNDS = 40

// Fresh-name generator for capture avoidance. `$`-prefixed names cannot be
// produced by the lexer (it forbids `$` in identifiers), so they never collide
// with anything in source; `$opt_` keeps them distinct from the elaborator's
// `$d_`/`$super_`. Reset per run for deterministic output.
let freshCounter = 0
function gensym(base: string): string {
  return `${base}$opt_${freshCounter++}`
}

// `ctorName -> arity` for every constructor declared in the program being
// optimized. Set once per run; read by the value/purity/match analyses to
// recognise (saturated) constructor applications as data. Module-level for the
// same reason as `freshCounter`: optimization is synchronous and single-shot.
let CTORS = new Map<string, number>()

// `ctorName -> the full set of sibling constructor names of its type`. Set once
// per run; read by `matchTotal` to decide (soundly) whether a `match`'s patterns
// are exhaustive — a total match cannot MATCH_FAIL, so it is pure & terminating.
let SIBLINGS = new Map<string, Set<string>>()

// The size-change termination analysis for this run (Aether 13.0). Computed by
// `analyzePurity` and surfaced in the Optimizer/Termination panels.
let TERMINATION: TerminationResult | null = null

// `fnName -> { arity, body }` for every function the effect-&-totality analysis
// proved **effect-free and total** — a non-recursive, never-shadowed binding
// whose body is pure (transitively, calling only other proven functions). A
// *saturated* application of one of these to pure arguments is itself pure, which
// is what lets CSE share a repeated call and dead-code elimination drop one. Set
// once per run by `analyzePurity`; read by the extended `isPure`. (See the long
// safety argument in the header: the gate is conservative, so it can never lie.)
let PURE_FNS = new Map<string, { arity: number; body: Expr }>()

// memoised per-run cost of a pure function's body (a lower bound on the VM steps
// one call performs), so `minCost` can see *through* a saturated pure call.
let bodyCostMemo = new Map<string, number>()

// Native builtins that are *total and effect-free* — a saturated call to one (on
// pure args) is pure, so CSE may share a repeat and DCE may drop an unused one.
// Deliberately excludes the partial natives (`head`/`tail` raise on `[]`) and the
// effectful ones (`print`, the turtle). Trusted only when NOT shadowed by a
// user binding of the same name (see SHADOWED).
const TOTAL_NATIVES = new Map<string, number>([
  ['sqrt', 1], ['sin', 1], ['cos', 1], ['floor', 1], ['toFloat', 1], ['abs', 1],
  ['strlen', 1], ['toUpper', 1], ['toLower', 1], ['parseInt', 1],
  ['min', 2], ['max', 2],
])

// Names bound somewhere in the program (so a `var` of one might *not* be the
// native of that name). Populated per run; guards the TOTAL_NATIVES shortcut.
let SHADOWED = new Set<string>()

// ---------------------------------------------------------------------------
// Public entry
// ---------------------------------------------------------------------------

export function optimizeCore(root: Expr): OptimizeResult {
  freshCounter = 0
  CTORS = collectCtors(root)
  SIBLINGS = collectSiblings(root)
  SHADOWED = new Set(collectBinderCounts(root).keys())
  TERMINATION = null
  PURE_FNS = analyzePurity(root)
  bodyCostMemo = new Map<string, number>()
  const passes: Record<string, number> = {}
  const bump = (name: string): void => {
    passes[name] = (passes[name] ?? 0) + 1
  }

  const nodesBefore = size(root)
  const trace: { round: number; rewrites: number; nodes: number }[] = []
  let expr = root
  let rounds = 0
  const fixpoint = (): void => {
    for (let local = 0; local < MAX_ROUNDS; local++, rounds++) {
      const before = passesTotal(passes)
      expr = step(expr, bump)
      const fired = passesTotal(passes) - before
      if (fired === 0) break // fixpoint
      trace.push({ round: rounds + 1, rewrites: fired, nodes: size(expr) })
    }
  }

  // Phase 1: rewrite to a fixpoint (folds, inlining, known-match, CSE, …) so the
  // abstraction the front end adds has already melted before we touch matching.
  fixpoint()

  // Phase 2: compile pattern matching to good decision trees (Aether 12.0). A
  // core-to-core pass that shares tests across arms; emits ordinary core, so all
  // three backends compile it unchanged.
  const dtResult = compileMatches(expr, { ctors: CTORS, siblings: SIBLINGS })
  const dt: DtStats = dtResult.stats
  const decisionTrees: DtView[] = dtResult.views
  if (dtResult.changed) {
    expr = dtResult.expr
    passes['dt'] = (passes['dt'] ?? 0) + dt.matchesCompiled
    // Phase 3: re-run the fixpoint to clean up the introduced bindings — copy-
    // propagate the `let v = occ` occurrence aliases and inline single-use
    // join-points — and to fold anything the new structure exposes.
    fixpoint()
  }

  return {
    expr,
    stats: {
      rounds,
      total: passesTotal(passes),
      passes,
      nodesBefore,
      nodesAfter: size(expr),
      trace,
      pureFns: [...PURE_FNS.keys()],
      dt,
      decisionTrees,
      termination: TERMINATION,
    },
  }
}

/** Back-compat thin wrapper used by older callers/tests. */
export function optimize(expr: Expr): { expr: Expr; folded: number } {
  const r = optimizeCore(expr)
  return { expr: r.expr, folded: r.stats.total }
}

function passesTotal(passes: Record<string, number>): number {
  let t = 0
  for (const k in passes) t += passes[k]
  return t
}

// ---------------------------------------------------------------------------
// The combined bottom-up rewriter: optimize children, then fire (at most) one
// local rule. Repeated to a fixpoint by the round loop above.
// ---------------------------------------------------------------------------

type Bump = (name: string) => void

function step(e: Expr, bump: Bump): Expr {
  const rec = (x: Expr): Expr => step(x, bump)
  switch (e.kind) {
    case 'int':
    case 'float':
    case 'bool':
    case 'str':
    case 'unit':
    case 'var':
      return e
    case 'lambda': {
      const n = { ...e, body: rec(e.body) }
      return etaContract(n, bump) ?? n
    }
    case 'app': {
      const n = { ...e, fn: rec(e.fn), arg: rec(e.arg) }
      return reduceApp(n, bump) ?? tryCse(n, bump) ?? n
    }
    case 'let': {
      const n = { ...e, value: rec(e.value), body: rec(e.body) }
      return reduceLet(n, bump) ?? n
    }
    case 'letrec': {
      const n = {
        ...e,
        bindings: e.bindings.map((b) => ({ name: b.name, value: rec(b.value) })),
        body: rec(e.body),
      }
      return reduceLetrec(n, bump) ?? n
    }
    case 'if': {
      const n = { ...e, cond: rec(e.cond), then: rec(e.then), else: rec(e.else) }
      return reduceIf(n, bump) ?? tryCse(n, bump) ?? n
    }
    case 'binop': {
      const n = { ...e, left: rec(e.left), right: rec(e.right) }
      return reduceBinop(n, bump) ?? tryCse(n, bump) ?? n
    }
    case 'unop': {
      const n = { ...e, operand: rec(e.operand) }
      return reduceUnop(n, bump) ?? tryCse(n, bump) ?? n
    }
    case 'seq': {
      const n = { ...e, first: rec(e.first), rest: rec(e.rest) }
      return reduceSeq(n, bump) ?? tryCse(n, bump) ?? n
    }
    case 'list': {
      const n = { ...e, elements: e.elements.map(rec) }
      return tryCse(n, bump) ?? n
    }
    case 'tuple': {
      const n = { ...e, elements: e.elements.map(rec) }
      return tryCse(n, bump) ?? n
    }
    case 'match': {
      const n: Expr = {
        ...e,
        scrutinee: rec(e.scrutinee),
        cases: e.cases.map((c) => ({
          pattern: c.pattern,
          guard: c.guard ? rec(c.guard) : undefined,
          body: rec(c.body),
        })),
      }
      return reduceMatch(n as Extract<Expr, { kind: 'match' }>, bump) ?? tryCse(n, bump) ?? n
    }
    case 'record': {
      const n = { ...e, fields: e.fields.map((f) => ({ label: f.label, value: rec(f.value) })) }
      return tryCse(n, bump) ?? n
    }
    case 'field': {
      const n = { ...e, record: rec(e.record) }
      return reduceField(n, bump) ?? tryCse(n, bump) ?? n
    }
    case 'recordUpdate': {
      const n = {
        ...e,
        record: rec(e.record),
        fields: e.fields.map((f) => ({ label: f.label, value: rec(f.value) })),
      }
      return tryCse(n, bump) ?? n
    }
    case 'typedecl':
      // never dropped — it carries constructor information the compiler needs
      return { ...e, body: rec(e.body) }
    case 'classdecl':
      return { ...e, body: rec(e.body) }
    case 'instancedecl':
      return {
        ...e,
        methods: e.methods.map((m) => ({ ...m, value: rec(m.value) })),
        body: rec(e.body),
      }
  }
}

// ---------------------------------------------------------------------------
// β-reduction, let-floating and η-contraction
// ---------------------------------------------------------------------------

function reduceApp(e: Extract<Expr, { kind: 'app' }>, bump: Bump): Expr | null {
  // (fn x -> body) arg  ⇒  let x = arg in body   (always sound: it *is* the
  // operational meaning of application; removes a closure allocation + call and
  // exposes `body` to the let-based passes)
  if (e.fn.kind === 'lambda') {
    bump('beta')
    return {
      kind: 'let',
      name: e.fn.param,
      value: e.arg,
      body: e.fn.body,
      recursive: false,
      span: e.span,
    }
  }
  // (let x = v in f) arg  ⇒  let x = v in (f arg)   so a curried application
  // peels through the `let`s a previous β-step introduced and keeps reducing.
  // Guarded by capture: `x` must not be free in `arg`.
  if (e.fn.kind === 'let' && !e.fn.recursive && !freeVars(e.arg).has(e.fn.name)) {
    bump('beta-float')
    return {
      ...e.fn,
      body: { kind: 'app', fn: e.fn.body, arg: e.arg, span: e.span },
    }
  }
  return null
}

function etaContract(e: Extract<Expr, { kind: 'lambda' }>, bump: Bump): Expr | null {
  // fn x -> f x  ⇒  f   when x ∉ fv(f) and f is duplicable-free of x.
  const b = e.body
  if (b.kind === 'app' && b.arg.kind === 'var' && b.arg.name === e.param) {
    if (!freeVars(b.fn).has(e.param)) {
      bump('eta')
      return b.fn
    }
  }
  return null
}

// ---------------------------------------------------------------------------
// let / letrec: inline, copy-propagate, drop dead bindings
// ---------------------------------------------------------------------------

function reduceLet(e: Extract<Expr, { kind: 'let' }>, bump: Bump): Expr | null {
  if (e.recursive) {
    // a `let rec` whose binder never appears in its own value is not actually
    // recursive — demote it to a plain `let` so it can be inlined/copy-propagated
    // (this is how instance dictionaries that don't self-reference melt away).
    if (!freeVars(e.value).has(e.name)) {
      bump('derec')
      return { ...e, recursive: false }
    }
    // self-recursive value binding: only drop if entirely unused & pure
    if (countUses(e.name, e.body) === 0 && isPure(e.value)) {
      bump('dead-let')
      return e.body
    }
    return null
  }

  const uses = countUses(e.name, e.body)

  if (uses === 0) {
    if (isPure(e.value)) {
      bump('dead-let')
      return e.body
    }
    // value has an effect but its result is unused: keep the effect, drop the slot
    if (e.value.kind === 'seq' || e.value.kind === 'app' || e.value.kind === 'match') {
      bump('dead-let-seq')
      return { kind: 'seq', first: e.value, rest: e.body, span: e.span }
    }
    return null
  }

  // Inline a binding whose value is a syntactic *value* (no effect, no work):
  //   • atoms (var / literal): always — duplication is free and bounded
  //   • lambda / compound value: only when used exactly once (no code blow-up)
  if (isValue(e.value) && (isAtom(e.value) || uses === 1)) {
    bump(e.value.kind === 'var' ? 'copy-prop' : 'inline')
    return subst(e.name, e.value, e.body)
  }

  return null
}

function reduceLetrec(e: Extract<Expr, { kind: 'letrec' }>, bump: Bump): Expr | null {
  if (e.bindings.length === 0) {
    bump('dead-letrec')
    return e.body
  }
  // If *no* binder is referenced from *any* binding value, the group is neither
  // self- nor mutually-recursive — lower it to a chain of plain `let`s so each
  // binding becomes inlinable (multi-method instance dictionaries melt this way).
  const valueFv = new Set<string>()
  for (const b of e.bindings) for (const v of freeVars(b.value)) valueFv.add(v)
  if (e.bindings.every((b) => !valueFv.has(b.name))) {
    bump('letrec-split')
    let body = e.body
    for (let i = e.bindings.length - 1; i >= 0; i--) {
      const b = e.bindings[i]
      body = { kind: 'let', name: b.name, value: b.value, body, recursive: false, span: e.span }
    }
    return body
  }
  // Reachability: keep a binding only if it is used by the body or by another
  // (transitively) kept binding. Drop pure, unreachable bindings (instance-dict
  // helpers a program never actually calls, etc.).
  const names = e.bindings.map((b) => b.name)
  const usedBy = new Map<string, Set<string>>() // name -> names referenced in its value
  for (const b of e.bindings) {
    const fv = freeVars(b.value)
    usedBy.set(b.name, new Set(names.filter((n) => n !== b.name && fv.has(n))))
  }
  const reachable = new Set<string>()
  const bodyFv = freeVars(e.body)
  const worklist = names.filter((n) => bodyFv.has(n))
  while (worklist.length) {
    const n = worklist.pop()!
    if (reachable.has(n)) continue
    reachable.add(n)
    for (const m of usedBy.get(n) ?? []) if (!reachable.has(m)) worklist.push(m)
  }
  const dropped = e.bindings.filter((b) => !reachable.has(b.name))
  if (dropped.length > 0 && dropped.every((b) => isPure(b.value))) {
    const kept = e.bindings.filter((b) => reachable.has(b.name))
    bump('dead-letrec')
    if (kept.length === 0) return e.body
    return { ...e, bindings: kept }
  }
  return null
}

// ---------------------------------------------------------------------------
// if / binop / unop / seq folding + algebraic identities
// ---------------------------------------------------------------------------

function reduceIf(e: Extract<Expr, { kind: 'if' }>, bump: Bump): Expr | null {
  if (e.cond.kind === 'bool') {
    bump('if-fold')
    return e.cond.value ? e.then : e.else
  }
  // if c then e else e  ⇒  e   (only when c is pure — else its effect is lost)
  if (exprEqual(e.then, e.else) && isPure(e.cond)) {
    bump('if-fold')
    return e.then
  }
  // if c then true else false ⇒ c  ;  if c then false else true ⇒ !c
  if (e.then.kind === 'bool' && e.else.kind === 'bool' && e.then.value !== e.else.value) {
    bump('if-fold')
    return e.then.value ? e.cond : { kind: 'unop', op: '!', operand: e.cond, span: e.span }
  }
  return null
}

function reduceUnop(e: Extract<Expr, { kind: 'unop' }>, bump: Bump): Expr | null {
  const o = e.operand
  if (e.op === '-' && o.kind === 'int') {
    bump('const-fold')
    return { kind: 'int', value: -o.value | 0, span: e.span }
  }
  if (e.op === '-' && o.kind === 'float') {
    bump('const-fold')
    return { kind: 'float', value: -o.value, span: e.span }
  }
  if (e.op === '!' && o.kind === 'bool') {
    bump('const-fold')
    return { kind: 'bool', value: !o.value, span: e.span }
  }
  // !!x ⇒ x
  if (e.op === '!' && o.kind === 'unop' && o.op === '!') {
    bump('const-fold')
    return o.operand
  }
  return null
}

function reduceBinop(e: Extract<Expr, { kind: 'binop' }>, bump: Bump): Expr | null {
  const { op, left: l, right: r, span } = e

  // short-circuit boolean simplification
  if (op === '&&') {
    if (l.kind === 'bool') {
      bump('algebra')
      return l.value ? r : { kind: 'bool', value: false, span }
    }
    if (r.kind === 'bool' && r.value) {
      bump('algebra')
      return l
    }
  }
  if (op === '||') {
    if (l.kind === 'bool') {
      bump('algebra')
      return l.value ? { kind: 'bool', value: true, span } : r
    }
    if (r.kind === 'bool' && !r.value) {
      bump('algebra')
      return l
    }
  }

  // constant folding over matching literal kinds
  const folded = foldBinop(op, l, r, span)
  if (folded) {
    bump('const-fold')
    return folded
  }

  // algebraic identities that *keep* the surviving operand (always sound)
  const alg = algebra(op, l, r)
  if (alg) {
    bump('algebra')
    return alg
  }
  return null
}

// identities where the result still evaluates the kept operand exactly once
function algebra(op: BinaryOp, l: Expr, r: Expr): Expr | null {
  const zeroI = (x: Expr): boolean => x.kind === 'int' && x.value === 0
  const oneI = (x: Expr): boolean => x.kind === 'int' && x.value === 1
  const zeroF = (x: Expr): boolean => x.kind === 'float' && x.value === 0
  const oneF = (x: Expr): boolean => x.kind === 'float' && x.value === 1
  const nil = (x: Expr): boolean => x.kind === 'list' && x.elements.length === 0
  const emptyS = (x: Expr): boolean => x.kind === 'str' && x.value === ''
  switch (op) {
    case '+':
      if (zeroI(r)) return l
      if (zeroI(l)) return r
      break
    case '-':
      if (zeroI(r)) return l
      break
    case '*':
      if (oneI(r)) return l
      if (oneI(l)) return r
      break
    case '/':
      if (oneI(r)) return l
      break
    case '+.':
      if (zeroF(r)) return l
      if (zeroF(l)) return r
      break
    case '-.':
      if (zeroF(r)) return l
      break
    case '*.':
      if (oneF(r)) return l
      if (oneF(l)) return r
      break
    case '/.':
      if (oneF(r)) return l
      break
    case '++':
      if (nil(r)) return l
      if (nil(l)) return r
      break
    case '^':
      if (emptyS(r)) return l
      if (emptyS(l)) return r
      break
  }
  return null
}

function reduceSeq(e: Extract<Expr, { kind: 'seq' }>, bump: Bump): Expr | null {
  // pure first half is a no-op: `(); rest` / `42; rest` ⇒ rest
  if (isPure(e.first)) {
    bump('seq-clean')
    return e.rest
  }
  return null
}

function reduceField(e: Extract<Expr, { kind: 'field' }>, bump: Bump): Expr | null {
  // { a = e1, b = e2, … }.a  ⇒  e1   when the *other* fields are pure (so
  // dropping their construction loses no effect). Dictionary records are
  // records of lambdas — all pure values — so a method projection reduces to
  // the method body, which β-reduction then applies.
  if (e.record.kind === 'record') {
    const hit = e.record.fields.find((f) => f.label === e.label)
    if (hit && e.record.fields.every((f) => f.label === e.label || isPure(f.value))) {
      bump('field-proj')
      return hit.value
    }
  }
  return null
}

// ---------------------------------------------------------------------------
// known-constructor match reduction
// ---------------------------------------------------------------------------

type MatchOutcome =
  | { tag: 'yes'; bindings: { name: string; value: Expr }[] }
  | { tag: 'no' }
  | { tag: 'unknown' }

function reduceMatch(e: Extract<Expr, { kind: 'match' }>, bump: Bump): Expr | null {
  const scrut = e.scrutinee
  // only reduce when the scrutinee is a constructed value we can read off
  // statically; otherwise the construction's effects/divergence must run.
  if (!isStaticShape(scrut)) return null
  // ...and only when it is *pure*: reduction drops the scrutinee components that
  // a pattern doesn't bind, so a discarded sub-expression with an effect (e.g.
  // `match (Some (print 1)) with Some _ -> 0`) must not be optimized away.
  if (!isPure(scrut)) return null

  let changed = false
  const survivors: MatchCase[] = []
  for (let i = 0; i < e.cases.length; i++) {
    const c = e.cases[i]
    const outcome = tryMatch(c.pattern, scrut)
    if (outcome.tag === 'no') {
      changed = true // this arm provably cannot match — drop it
      continue
    }
    if (outcome.tag === 'unknown') {
      // can't decide here; this and all following arms must remain
      survivors.push(...e.cases.slice(i))
      break
    }
    // tag === 'yes'
    if (c.guard) {
      // a guard might still fail; keep this arm (and the rest)
      survivors.push(...e.cases.slice(i))
      break
    }
    // definite, unguarded match: reduce to this arm, binding pattern vars.
    bump('known-match')
    let body = c.body
    // wrap bindings as lets in source order (scrutinee already evaluated once)
    for (let k = outcome.bindings.length - 1; k >= 0; k--) {
      const b = outcome.bindings[k]
      body = { kind: 'let', name: b.name, value: b.value, body, recursive: false, span: e.span }
    }
    return body
  }

  if (changed && survivors.length > 0) {
    bump('known-match')
    return { ...e, cases: survivors }
  }
  return null
}

// Is `e` a value whose top constructor we can read off statically?
function isStaticShape(e: Expr): boolean {
  switch (e.kind) {
    case 'int':
    case 'float':
    case 'bool':
    case 'str':
    case 'unit':
    case 'tuple':
    case 'list':
      return true
    case 'binop':
      return e.op === '::'
    default:
      return ctorAppHead(e) !== null
  }
}

// If `e` is a *saturated* application of a known constructor, return its name +
// argument expressions; else null.
function ctorAppHead(e: Expr): { name: string; args: Expr[] } | null {
  const args: Expr[] = []
  let cur: Expr = e
  while (cur.kind === 'app') {
    args.unshift(cur.arg)
    cur = cur.fn
  }
  if (cur.kind === 'var' && CTORS.get(cur.name) === args.length) {
    return { name: cur.name, args }
  }
  return null
}

function tryMatch(p: Pattern, scrut: Expr): MatchOutcome {
  switch (p.kind) {
    case 'pwild':
      return { tag: 'yes', bindings: [] }
    case 'pvar':
      return { tag: 'yes', bindings: [{ name: p.name, value: scrut }] }
    case 'pint':
      if (scrut.kind === 'int') return scrut.value === p.value ? yes() : no()
      return unknown()
    case 'pfloat':
      if (scrut.kind === 'float') return scrut.value === p.value ? yes() : no()
      return unknown()
    case 'pbool':
      if (scrut.kind === 'bool') return scrut.value === p.value ? yes() : no()
      return unknown()
    case 'pstr':
      if (scrut.kind === 'str') return scrut.value === p.value ? yes() : no()
      return unknown()
    case 'punit':
      return scrut.kind === 'unit' ? yes() : unknown()
    case 'pnil':
      if (scrut.kind === 'list') return scrut.elements.length === 0 ? yes() : no()
      if (scrut.kind === 'binop' && scrut.op === '::') return no()
      return unknown()
    case 'pcons': {
      let head: Expr, tail: Expr
      if (scrut.kind === 'binop' && scrut.op === '::') {
        head = scrut.left
        tail = scrut.right
      } else if (scrut.kind === 'list' && scrut.elements.length > 0) {
        head = scrut.elements[0]
        tail = { ...scrut, elements: scrut.elements.slice(1) }
      } else if (scrut.kind === 'list') {
        return no() // empty list
      } else {
        return unknown()
      }
      return combine([tryMatch(p.head, head), tryMatch(p.tail, tail)])
    }
    case 'ptuple':
      if (scrut.kind === 'tuple' && scrut.elements.length === p.elements.length) {
        return combine(p.elements.map((sub, i) => tryMatch(sub, scrut.elements[i])))
      }
      return unknown()
    case 'pcon': {
      const head = ctorAppHead(scrut)
      if (!head) return unknown()
      if (head.name !== p.name) return no()
      if (head.args.length !== p.args.length) return no()
      return combine(p.args.map((sub, i) => tryMatch(sub, head.args[i])))
    }
  }
}

const yes = (): MatchOutcome => ({ tag: 'yes', bindings: [] })
const no = (): MatchOutcome => ({ tag: 'no' })
const unknown = (): MatchOutcome => ({ tag: 'unknown' })

function combine(parts: MatchOutcome[]): MatchOutcome {
  const bindings: { name: string; value: Expr }[] = []
  let sawUnknown = false
  for (const part of parts) {
    if (part.tag === 'no') return no() // any definite mismatch ⇒ whole pattern fails
    if (part.tag === 'unknown') sawUnknown = true
    else bindings.push(...part.bindings)
  }
  // A sub-pattern we couldn't decide makes the whole match indeterminate — but
  // only if nothing definitely failed (handled above).
  return sawUnknown ? unknown() : { tag: 'yes', bindings }
}

// ---------------------------------------------------------------------------
// Constant folding of binary operators over literals
// ---------------------------------------------------------------------------

function foldBinop(op: BinaryOp, l: Expr, r: Expr, span: Expr['span']): Expr | null {
  if (l.kind === 'int' && r.kind === 'int') {
    switch (op) {
      case '+':
        return { kind: 'int', value: (l.value + r.value) | 0, span }
      case '-':
        return { kind: 'int', value: (l.value - r.value) | 0, span }
      case '*':
        return { kind: 'int', value: Math.trunc(l.value * r.value), span }
      case '/':
        return r.value === 0 ? null : { kind: 'int', value: Math.trunc(l.value / r.value), span }
      case '%':
        return r.value === 0 ? null : { kind: 'int', value: l.value % r.value, span }
    }
  }
  if (l.kind === 'float' && r.kind === 'float') {
    switch (op) {
      case '+.':
        return { kind: 'float', value: l.value + r.value, span }
      case '-.':
        return { kind: 'float', value: l.value - r.value, span }
      case '*.':
        return { kind: 'float', value: l.value * r.value, span }
      case '/.':
        return r.value === 0 ? null : { kind: 'float', value: l.value / r.value, span }
    }
  }
  if (op === '^' && l.kind === 'str' && r.kind === 'str') {
    return { kind: 'str', value: l.value + r.value, span }
  }
  const cmp = compareLiterals(l, r)
  if (cmp !== null) {
    switch (op) {
      case '==':
        return { kind: 'bool', value: cmp === 0, span }
      case '!=':
        return { kind: 'bool', value: cmp !== 0, span }
      case '<':
        return { kind: 'bool', value: cmp < 0, span }
      case '>':
        return { kind: 'bool', value: cmp > 0, span }
      case '<=':
        return { kind: 'bool', value: cmp <= 0, span }
      case '>=':
        return { kind: 'bool', value: cmp >= 0, span }
    }
  }
  return null
}

function compareLiterals(l: Expr, r: Expr): number | null {
  if ((l.kind === 'int' || l.kind === 'float') && (r.kind === 'int' || r.kind === 'float')) {
    return Math.sign(l.value - r.value)
  }
  if (l.kind === 'str' && r.kind === 'str') {
    return l.value < r.value ? -1 : l.value > r.value ? 1 : 0
  }
  if (l.kind === 'bool' && r.kind === 'bool') {
    return (l.value ? 1 : 0) - (r.value ? 1 : 0)
  }
  if (l.kind === 'unit' && r.kind === 'unit') return 0
  return null
}

// ---------------------------------------------------------------------------
// Value / purity analysis
// ---------------------------------------------------------------------------

/** An atom: duplicating it is free and bounded. */
function isAtom(e: Expr): boolean {
  return (
    e.kind === 'var' ||
    e.kind === 'int' ||
    e.kind === 'float' ||
    e.kind === 'bool' ||
    e.kind === 'str' ||
    e.kind === 'unit'
  )
}

/**
 * A syntactic *value*: evaluating it performs no work and cannot diverge or
 * raise, so it may be substituted into the program without changing meaning.
 * (A bare `var` is a value — referencing a binding runs nothing.)
 */
function isValue(e: Expr): boolean {
  switch (e.kind) {
    case 'int':
    case 'float':
    case 'bool':
    case 'str':
    case 'unit':
    case 'var':
    case 'lambda':
      return true
    case 'tuple':
    case 'list':
      return e.elements.every(isValue)
    case 'record':
      return e.fields.every((f) => isValue(f.value))
    case 'binop':
      // a cons of values is a value (an immutable list cell)
      return e.op === '::' && isValue(e.left) && isValue(e.right)
    case 'app': {
      // a *saturated* constructor application of values is data — a value
      const head = ctorAppHead(e)
      return head !== null && head.args.every(isValue)
    }
    default:
      return false
  }
}

/**
 * Pure *and* terminating: evaluating it has no observable effect and always
 * returns normally. Used to decide whether a computation may be dropped.
 * Deliberately conservative — anything that could `print`, loop or raise
 * (`app`, `match`, `field`, `recordUpdate`, division/mod that might be by zero)
 * is treated as impure.
 */
function isPure(e: Expr): boolean {
  switch (e.kind) {
    case 'int':
    case 'float':
    case 'bool':
    case 'str':
    case 'unit':
    case 'var':
    case 'lambda':
      return true
    case 'tuple':
    case 'list':
      return e.elements.every(isPure)
    case 'record':
      return e.fields.every((f) => isPure(f.value))
    case 'if':
      return isPure(e.cond) && isPure(e.then) && isPure(e.else)
    case 'unop':
      return isPure(e.operand)
    case 'binop':
      // arithmetic that could trap (÷0, %0) is pure only with a nonzero literal divisor
      if (e.op === '/' || e.op === '%' || e.op === '/.') {
        const r = e.right
        const nonZero =
          (r.kind === 'int' && r.value !== 0) || (r.kind === 'float' && r.value !== 0)
        return nonZero && isPure(e.left)
      }
      return isPure(e.left) && isPure(e.right)
    case 'seq':
      return isPure(e.first) && isPure(e.rest)
    case 'let':
      return isPure(e.value) && isPure(e.body)
    case 'app': {
      // a saturated constructor application of pure args is pure & total
      const head = ctorAppHead(e)
      if (head !== null) return head.args.every(isPure)
      // an application of a *proven* effect-free, total function (see PURE_FNS /
      // analyzePurity) to pure arguments is pure: a partial application is just a
      // closure (a value), and a saturated one runs a body we proved pure & total.
      // Over-application stays conservative (the returned function is unknown).
      const f = spineHead(e)
      if (f && PURE_FNS.has(f.name) && f.args.length <= PURE_FNS.get(f.name)!.arity) {
        return f.args.every(isPure)
      }
      // a saturated call to a total, effect-free native (when not shadowed)
      if (
        f &&
        !SHADOWED.has(f.name) &&
        TOTAL_NATIVES.get(f.name) === f.args.length
      ) {
        return f.args.every(isPure)
      }
      return false
    }
    case 'match': {
      if (!isPure(e.scrutinee)) return false
      // a match on a statically-known shape with a definite, unguarded, pure arm
      // is pure & total (the scrutinee has no effect and the chosen branch cannot
      // fail). If the shape is known but the chosen arm is guarded/indeterminate,
      // fall through to the general totality test below.
      if (isStaticShape(e.scrutinee)) {
        for (const c of e.cases) {
          const o = tryMatch(c.pattern, e.scrutinee)
          if (o.tag === 'no') continue
          if (o.tag === 'unknown' || c.guard) break
          return o.bindings.every((b) => isPure(b.value)) && isPure(c.body)
        }
      }
      // General case (Aether 13.0): a match whose *unguarded* patterns already
      // cover every value cannot raise MATCH_FAIL, so — when its scrutinee, every
      // guard, and every arm body are pure — the whole match is pure & total even
      // on an unknown scrutinee (e.g. a function matching its own parameter). This
      // is what lets a recursive, structurally-decreasing function be proven pure.
      return (
        matchTotal(e) &&
        e.cases.every((c) => (!c.guard || isPure(c.guard)) && isPure(c.body))
      )
    }
    default:
      return false
  }
}

// ---------------------------------------------------------------------------
// Match totality (sound exhaustiveness, for purity)
// ---------------------------------------------------------------------------
//
// A `match` cannot raise `MATCH_FAIL` when its (unguarded) patterns already cover
// every value. We decide that with Maranget's "usefulness" algorithm specialised
// to Aether's pattern domain: the patterns are exhaustive iff a fresh wildcard row
// is *not useful* against them. The constructor signature of a type is read from
// `CTORS`/`SIBLINGS` (built-ins for bool/unit/list/tuple, the declared sibling set
// for user ADTs); Int/Float/String — and any constructor we can't classify — are
// treated as *infinite*, so only a wildcard covers them. Every fallback here is
// conservative: an undecidable case answers "not total", never a false "total".

type NPat = { wild: true } | { wild: false; ctor: string; arity: number; args: NPat[] }
const NWILD: NPat = { wild: true }

function toNPat(p: Pattern): NPat {
  switch (p.kind) {
    case 'pwild':
    case 'pvar':
      return NWILD
    case 'pint':
      return { wild: false, ctor: 'int:' + p.value, arity: 0, args: [] }
    case 'pfloat':
      return { wild: false, ctor: 'float:' + p.value, arity: 0, args: [] }
    case 'pstr':
      return { wild: false, ctor: 'str:' + JSON.stringify(p.value), arity: 0, args: [] }
    case 'pbool':
      return { wild: false, ctor: p.value ? 'true' : 'false', arity: 0, args: [] }
    case 'punit':
      return { wild: false, ctor: 'unit', arity: 0, args: [] }
    case 'pnil':
      return { wild: false, ctor: 'nil', arity: 0, args: [] }
    case 'pcons':
      return { wild: false, ctor: 'cons', arity: 2, args: [toNPat(p.head), toNPat(p.tail)] }
    case 'ptuple':
      return { wild: false, ctor: 'tuple', arity: p.elements.length, args: p.elements.map(toNPat) }
    case 'pcon':
      return { wild: false, ctor: p.name, arity: p.args.length, args: p.args.map(toNPat) }
  }
}

/** The constructors present in column 0 of a matrix, with their arity. */
function columnCtors(matrix: NPat[][]): Map<string, number> {
  const m = new Map<string, number>()
  for (const row of matrix) {
    const h = row[0]
    if (!h.wild) m.set(h.ctor, h.arity)
  }
  return m
}

/** Given the constructors *present* in a column, the type's full signature (with
 *  arities) and whether the present set already completes it. An infinite or
 *  unrecognised domain is never complete. */
function signatureOf(present: Map<string, number>): { complete: boolean; all: Map<string, number> } {
  if (present.size === 0) return { complete: false, all: present }
  type SigKind = 'bool' | 'unit' | 'list' | 'tuple' | 'user' | 'inf'
  let kind: SigKind | null = null
  for (const n of present.keys()) {
    let k: SigKind
    if (n === 'true' || n === 'false') k = 'bool'
    else if (n === 'unit') k = 'unit'
    else if (n === 'nil' || n === 'cons') k = 'list'
    else if (n === 'tuple') k = 'tuple'
    else if (n.startsWith('int:') || n.startsWith('float:') || n.startsWith('str:')) k = 'inf'
    else if (CTORS.has(n)) k = 'user'
    else k = 'inf'
    if (kind === null) kind = k
    else if (kind !== k) return { complete: false, all: present } // mixed ⇒ bail
  }
  switch (kind) {
    case 'bool': {
      const all = new Map([['true', 0], ['false', 0]])
      return { complete: present.has('true') && present.has('false'), all }
    }
    case 'unit':
      return { complete: true, all: new Map([['unit', 0]]) }
    case 'list': {
      const all = new Map([['nil', 0], ['cons', 2]])
      return { complete: present.has('nil') && present.has('cons'), all }
    }
    case 'tuple':
      return { complete: true, all: present } // a tuple type has exactly one ctor
    case 'user': {
      const some = [...present.keys()][0]
      const sibs = SIBLINGS.get(some)
      if (!sibs) return { complete: false, all: present }
      const all = new Map<string, number>()
      for (const s of sibs) all.set(s, CTORS.get(s) ?? 0)
      let complete = true
      for (const s of sibs) if (!present.has(s)) complete = false
      return { complete, all }
    }
    default:
      return { complete: false, all: present }
  }
}

/** Specialise a matrix by constructor `c` of arity `a` (Maranget's S). */
function specialize(matrix: NPat[][], c: string, a: number): NPat[][] {
  const out: NPat[][] = []
  for (const row of matrix) {
    const h = row[0]
    if (h.wild) out.push([...Array<NPat>(a).fill(NWILD), ...row.slice(1)])
    else if (h.ctor === c) out.push([...h.args, ...row.slice(1)])
  }
  return out
}

/** The default matrix (Maranget's D): rows whose first pattern is a wildcard. */
function defaultMatrix(matrix: NPat[][]): NPat[][] {
  const out: NPat[][] = []
  for (const row of matrix) if (row[0].wild) out.push(row.slice(1))
  return out
}

/** Is query `q` useful against `matrix` — does it match some value no row does? */
function usefulRows(matrix: NPat[][], q: NPat[]): boolean {
  if (q.length === 0) return matrix.length === 0
  const head = q[0]
  if (!head.wild) {
    return usefulRows(specialize(matrix, head.ctor, head.arity), [...head.args, ...q.slice(1)])
  }
  const present = columnCtors(matrix)
  const sig = signatureOf(present)
  if (sig.complete) {
    for (const [c, a] of sig.all) {
      const sq: NPat[] = [...Array<NPat>(a).fill(NWILD), ...q.slice(1)]
      if (usefulRows(specialize(matrix, c, a), sq)) return true
    }
    return false
  }
  return usefulRows(defaultMatrix(matrix), q.slice(1))
}

/** A `match` is *total* when its unguarded patterns are exhaustive — i.e. a fresh
 *  wildcard is not useful against them — so it can never fall through to a fail. */
function matchTotal(e: Expr & { kind: 'match' }): boolean {
  const rows = e.cases.filter((c) => !c.guard).map((c) => [toNPat(c.pattern)])
  if (rows.length === 0) return false
  return !usefulRows(rows, [NWILD])
}

// ---------------------------------------------------------------------------
// Structural equality (for `if c then e else e`)
// ---------------------------------------------------------------------------

function exprEqual(a: Expr, b: Expr): boolean {
  if (a.kind !== b.kind) return false
  switch (a.kind) {
    case 'int':
    case 'float':
      return a.value === (b as typeof a).value
    case 'bool':
      return a.value === (b as typeof a).value
    case 'str':
      return a.value === (b as typeof a).value
    case 'unit':
      return true
    case 'var':
      return a.name === (b as typeof a).name
    default:
      return false // conservative: only collapse trivially-identical branches
  }
}

// ---------------------------------------------------------------------------
// Free variables, use counting, capture-avoiding substitution
// ---------------------------------------------------------------------------

function patternVars(p: Pattern, acc: Set<string>): void {
  switch (p.kind) {
    case 'pvar':
      acc.add(p.name)
      break
    case 'pcons':
      patternVars(p.head, acc)
      patternVars(p.tail, acc)
      break
    case 'ptuple':
      for (const sub of p.elements) patternVars(sub, acc)
      break
    case 'pcon':
      for (const sub of p.args) patternVars(sub, acc)
      break
    default:
      break
  }
}

const fvCache = new WeakMap<Expr, Set<string>>()

function freeVars(e: Expr): Set<string> {
  const cached = fvCache.get(e)
  if (cached) return cached
  const s = computeFreeVars(e)
  fvCache.set(e, s)
  return s
}

function computeFreeVars(e: Expr): Set<string> {
  const u = (...sets: Set<string>[]): Set<string> => {
    const out = new Set<string>()
    for (const s of sets) for (const x of s) out.add(x)
    return out
  }
  switch (e.kind) {
    case 'var':
      return new Set([e.name])
    case 'int':
    case 'float':
    case 'bool':
    case 'str':
    case 'unit':
      return new Set()
    case 'lambda': {
      const s = new Set(freeVars(e.body))
      s.delete(e.param)
      return s
    }
    case 'app':
      return u(freeVars(e.fn), freeVars(e.arg))
    case 'let': {
      const sv = new Set(freeVars(e.value))
      if (e.recursive) sv.delete(e.name)
      const sb = new Set(freeVars(e.body))
      sb.delete(e.name)
      return u(sv, sb)
    }
    case 'letrec': {
      const s = u(...e.bindings.map((b) => freeVars(b.value)), freeVars(e.body))
      for (const b of e.bindings) s.delete(b.name)
      return s
    }
    case 'if':
      return u(freeVars(e.cond), freeVars(e.then), freeVars(e.else))
    case 'binop':
      return u(freeVars(e.left), freeVars(e.right))
    case 'unop':
      return freeVars(e.operand)
    case 'list':
    case 'tuple':
      return u(...e.elements.map(freeVars))
    case 'seq':
      return u(freeVars(e.first), freeVars(e.rest))
    case 'match': {
      let s = new Set(freeVars(e.scrutinee))
      for (const c of e.cases) {
        const bound = new Set<string>()
        patternVars(c.pattern, bound)
        let cs = new Set(freeVars(c.body))
        if (c.guard) cs = u(cs, freeVars(c.guard))
        for (const n of bound) cs.delete(n)
        s = u(s, cs)
      }
      return s
    }
    case 'typedecl': {
      const s = new Set(freeVars(e.body))
      for (const ctor of e.ctors) s.delete(ctor.name)
      return s
    }
    case 'record':
      return u(...e.fields.map((f) => freeVars(f.value)))
    case 'field':
      return freeVars(e.record)
    case 'recordUpdate':
      return u(freeVars(e.record), ...e.fields.map((f) => freeVars(f.value)))
    case 'classdecl':
      return freeVars(e.body)
    case 'instancedecl':
      return u(...e.methods.map((m) => freeVars(m.value)), freeVars(e.body))
  }
}

/** Count free occurrences of `name` in `e` (respecting shadowing). */
function countUses(name: string, e: Expr): number {
  if (!freeVars(e).has(name)) return 0
  switch (e.kind) {
    case 'var':
      return e.name === name ? 1 : 0
    case 'int':
    case 'float':
    case 'bool':
    case 'str':
    case 'unit':
      return 0
    case 'lambda':
      return e.param === name ? 0 : countUses(name, e.body)
    case 'app':
      return countUses(name, e.fn) + countUses(name, e.arg)
    case 'let': {
      const inValue = e.recursive && e.name === name ? 0 : countUses(name, e.value)
      const inBody = e.name === name ? 0 : countUses(name, e.body)
      return inValue + inBody
    }
    case 'letrec': {
      if (e.bindings.some((b) => b.name === name)) return 0 // shadowed by the group
      return e.bindings.reduce((n, b) => n + countUses(name, b.value), 0) + countUses(name, e.body)
    }
    case 'if':
      return countUses(name, e.cond) + countUses(name, e.then) + countUses(name, e.else)
    case 'binop':
      return countUses(name, e.left) + countUses(name, e.right)
    case 'unop':
      return countUses(name, e.operand)
    case 'list':
    case 'tuple':
      return e.elements.reduce((n, x) => n + countUses(name, x), 0)
    case 'seq':
      return countUses(name, e.first) + countUses(name, e.rest)
    case 'match': {
      let n = countUses(name, e.scrutinee)
      for (const c of e.cases) {
        const bound = new Set<string>()
        patternVars(c.pattern, bound)
        if (bound.has(name)) continue
        if (c.guard) n += countUses(name, c.guard)
        n += countUses(name, c.body)
      }
      return n
    }
    case 'typedecl':
      return e.ctors.some((c) => c.name === name) ? 0 : countUses(name, e.body)
    case 'record':
      return e.fields.reduce((n, f) => n + countUses(name, f.value), 0)
    case 'field':
      return countUses(name, e.record)
    case 'recordUpdate':
      return (
        countUses(name, e.record) + e.fields.reduce((n, f) => n + countUses(name, f.value), 0)
      )
    case 'classdecl':
      return countUses(name, e.body)
    case 'instancedecl':
      return (
        e.methods.reduce((n, m) => n + countUses(name, m.value), 0) + countUses(name, e.body)
      )
  }
}

/** Consistently rename free occurrences of `from` to a *fresh* `to` (no capture
 * possible because `to` is globally fresh). Stops at binders that shadow `from`. */
function rename(from: string, to: string, e: Expr): Expr {
  if (!freeVars(e).has(from)) return e
  switch (e.kind) {
    case 'var':
      return e.name === from ? { ...e, name: to } : e
    case 'lambda':
      return e.param === from ? e : { ...e, body: rename(from, to, e.body) }
    case 'app':
      return { ...e, fn: rename(from, to, e.fn), arg: rename(from, to, e.arg) }
    case 'let': {
      const value = e.recursive && e.name === from ? e.value : rename(from, to, e.value)
      const body = e.name === from ? e.body : rename(from, to, e.body)
      return { ...e, value, body }
    }
    case 'letrec': {
      if (e.bindings.some((b) => b.name === from)) return e
      return {
        ...e,
        bindings: e.bindings.map((b) => ({ name: b.name, value: rename(from, to, b.value) })),
        body: rename(from, to, e.body),
      }
    }
    case 'if':
      return {
        ...e,
        cond: rename(from, to, e.cond),
        then: rename(from, to, e.then),
        else: rename(from, to, e.else),
      }
    case 'binop':
      return { ...e, left: rename(from, to, e.left), right: rename(from, to, e.right) }
    case 'unop':
      return { ...e, operand: rename(from, to, e.operand) }
    case 'list':
    case 'tuple':
      return { ...e, elements: e.elements.map((x) => rename(from, to, x)) }
    case 'seq':
      return { ...e, first: rename(from, to, e.first), rest: rename(from, to, e.rest) }
    case 'match':
      return {
        ...e,
        scrutinee: rename(from, to, e.scrutinee),
        cases: e.cases.map((c) => {
          const bound = new Set<string>()
          patternVars(c.pattern, bound)
          if (bound.has(from)) return c
          return {
            pattern: c.pattern,
            guard: c.guard ? rename(from, to, c.guard) : undefined,
            body: rename(from, to, c.body),
          }
        }),
      }
    case 'typedecl':
      return e.ctors.some((c) => c.name === from) ? e : { ...e, body: rename(from, to, e.body) }
    case 'record':
      return { ...e, fields: e.fields.map((f) => ({ label: f.label, value: rename(from, to, f.value) })) }
    case 'field':
      return { ...e, record: rename(from, to, e.record) }
    case 'recordUpdate':
      return {
        ...e,
        record: rename(from, to, e.record),
        fields: e.fields.map((f) => ({ label: f.label, value: rename(from, to, f.value) })),
      }
    default:
      return e
  }
}

/** Capture-avoiding substitution: replace free `name` by `repl` in `e`. */
function subst(name: string, repl: Expr, e: Expr): Expr {
  if (!freeVars(e).has(name)) return e
  const replFv = freeVars(repl)
  const sub = (x: Expr): Expr => subst(name, repl, x)

  switch (e.kind) {
    case 'var':
      return e.name === name ? repl : e
    case 'lambda': {
      if (e.param === name) return e // shadowed (unreachable: fv excluded it)
      if (replFv.has(e.param)) {
        const fresh = gensym(e.param)
        return { ...e, param: fresh, body: subst(name, repl, rename(e.param, fresh, e.body)) }
      }
      return { ...e, body: sub(e.body) }
    }
    case 'app':
      return { ...e, fn: sub(e.fn), arg: sub(e.arg) }
    case 'let': {
      // non-recursive: binder scopes over body only; recursive: over value+body
      if (e.name === name) {
        // body (and value, if recursive) shadow `name`
        return e.recursive ? e : { ...e, value: sub(e.value) }
      }
      if (replFv.has(e.name)) {
        const fresh = gensym(e.name)
        const body = subst(name, repl, rename(e.name, fresh, e.body))
        const value = e.recursive
          ? subst(name, repl, rename(e.name, fresh, e.value))
          : sub(e.value)
        return { ...e, name: fresh, value, body }
      }
      return { ...e, value: sub(e.value), body: sub(e.body) }
    }
    case 'letrec': {
      if (e.bindings.some((b) => b.name === name)) return e // shadowed by the group
      // freshen any group binder that would capture a free var of `repl`
      let bindings = e.bindings
      let body = e.body
      for (const b of e.bindings) {
        if (replFv.has(b.name)) {
          const fresh = gensym(b.name)
          bindings = bindings.map((bb) => ({
            name: bb.name === b.name ? fresh : bb.name,
            value: rename(b.name, fresh, bb.value),
          }))
          body = rename(b.name, fresh, body)
        }
      }
      return {
        ...e,
        bindings: bindings.map((b) => ({ name: b.name, value: subst(name, repl, b.value) })),
        body: subst(name, repl, body),
      }
    }
    case 'if':
      return { ...e, cond: sub(e.cond), then: sub(e.then), else: sub(e.else) }
    case 'binop':
      return { ...e, left: sub(e.left), right: sub(e.right) }
    case 'unop':
      return { ...e, operand: sub(e.operand) }
    case 'list':
    case 'tuple':
      return { ...e, elements: e.elements.map(sub) }
    case 'seq':
      return { ...e, first: sub(e.first), rest: sub(e.rest) }
    case 'match':
      return {
        ...e,
        scrutinee: sub(e.scrutinee),
        cases: e.cases.map((c) => {
          const bound = new Set<string>()
          patternVars(c.pattern, bound)
          if (bound.has(name)) return c // pattern shadows `name`
          // freshen any pattern var that would capture a free var of `repl`
          if ([...bound].some((b) => replFv.has(b))) {
            let pattern = c.pattern
            let guard = c.guard
            let body = c.body
            for (const b of bound) {
              if (replFv.has(b)) {
                const fresh = gensym(b)
                pattern = renamePattern(b, fresh, pattern)
                if (guard) guard = rename(b, fresh, guard)
                body = rename(b, fresh, body)
              }
            }
            return {
              pattern,
              guard: guard ? subst(name, repl, guard) : undefined,
              body: subst(name, repl, body),
            }
          }
          return {
            pattern: c.pattern,
            guard: c.guard ? sub(c.guard) : undefined,
            body: sub(c.body),
          }
        }),
      }
    case 'typedecl':
      return e.ctors.some((c) => c.name === name) ? e : { ...e, body: sub(e.body) }
    case 'record':
      return { ...e, fields: e.fields.map((f) => ({ label: f.label, value: sub(f.value) })) }
    case 'field':
      return { ...e, record: sub(e.record) }
    case 'recordUpdate':
      return {
        ...e,
        record: sub(e.record),
        fields: e.fields.map((f) => ({ label: f.label, value: sub(f.value) })),
      }
    default:
      return e
  }
}

function renamePattern(from: string, to: string, p: Pattern): Pattern {
  switch (p.kind) {
    case 'pvar':
      return p.name === from ? { ...p, name: to } : p
    case 'pcons':
      return { ...p, head: renamePattern(from, to, p.head), tail: renamePattern(from, to, p.tail) }
    case 'ptuple':
      return { ...p, elements: p.elements.map((s) => renamePattern(from, to, s)) }
    case 'pcon':
      return { ...p, args: p.args.map((s) => renamePattern(from, to, s)) }
    default:
      return p
  }
}

// ---------------------------------------------------------------------------
// Interprocedural effect-&-totality analysis (powers PURE_FNS)
// ---------------------------------------------------------------------------

// Effectful native builtins — a function that calls one of these can never be
// pure. They are natives (never `let`-bound), so they are already excluded from
// PURE_FNS; this set is belt-and-suspenders against a user *shadowing* one with
// a pure binding of the same name.
const EFFECTFUL_NATIVES = new Set([
  'print', 'forward', 'back', 'turn', 'width', 'penUp', 'penDown', 'push', 'pop', 'clear', 'color',
])

/** The variable head + argument spine of an application (or null if not headed
 *  by a variable). `f a b` ⇒ `{ name: 'f', args: [a, b] }`. */
function spineHead(e: Expr): { name: string; args: Expr[] } | null {
  const args: Expr[] = []
  let cur: Expr = e
  while (cur.kind === 'app') {
    args.unshift(cur.arg)
    cur = cur.fn
  }
  return cur.kind === 'var' ? { name: cur.name, args } : null
}

/** Number of leading parameters of a (curried) lambda. */
function lambdaArity(e: Expr): number {
  let n = 0
  let cur: Expr = e
  while (cur.kind === 'lambda') {
    n++
    cur = cur.body
  }
  return n
}

/** The body beneath all of a curried lambda's parameters. */
function lambdaBody(e: Expr): Expr {
  let cur: Expr = e
  while (cur.kind === 'lambda') cur = cur.body
  return cur
}

/**
 * Count every value-binder occurrence of each name (`let` / `letrec` / `lambda`
 * params / `match`-pattern variables). A name bound *exactly once* in the whole
 * program can never be shadowed, so a plain `var name` always resolves to that
 * one binding — which is exactly what makes the name-keyed purity analysis sound
 * (`isPure` has no scope, so it must only trust unambiguous names).
 */
function collectBinderCounts(root: Expr): Map<string, number> {
  const m = new Map<string, number>()
  const add = (n: string): void => {
    m.set(n, (m.get(n) ?? 0) + 1)
  }
  const walk = (e: Expr): void => {
    switch (e.kind) {
      case 'lambda':
        add(e.param)
        break
      case 'let':
        add(e.name)
        break
      case 'letrec':
        for (const b of e.bindings) add(b.name)
        break
      case 'match':
        for (const c of e.cases) {
          const s = new Set<string>()
          patternVars(c.pattern, s)
          for (const n of s) add(n)
        }
        break
      default:
        break
    }
    for (const c of childrenOf(e)) walk(c)
  }
  walk(root)
  return m
}

/**
 * Discover the functions that are provably **effect-free and total**.
 *
 * A candidate is a never-shadowed `let`/`letrec`-bound lambda whose body is pure
 * (transitively: it may only call constructors, total natives, and other proven
 * functions). Two kinds qualify:
 *
 *  • **non-recursive** functions — admitted exactly as before, by a monotone
 *    fixpoint: a candidate joins the set once its body type-checks as pure under
 *    the set discovered so far;
 *
 *  • **recursive** functions (Aether 13.0) — admitted when the size-change
 *    termination analysis proves their whole mutual-recursion group terminates
 *    *and* the bodies are effect-free. A group is committed all-or-nothing: we
 *    tentatively assume the members pure (so their own recursive calls resolve),
 *    check every body, and keep them only if all check out — otherwise roll the
 *    whole group back. Termination comes from the proof; effect-freedom from the
 *    body check; together they give totality. Conservative by construction.
 */
function analyzePurity(root: Expr): Map<string, { arity: number; body: Expr }> {
  const counts = collectBinderCounts(root)
  TERMINATION = analyzeTermination(root)

  const candidates: { name: string; lam: Expr }[] = []
  const consider = (name: string, value: Expr, recursive: boolean): void => {
    if (value.kind !== 'lambda') return
    if (counts.get(name) !== 1) return // bound more than once → could be shadowed
    if (EFFECTFUL_NATIVES.has(name)) return
    if (recursive && freeVars(value).has(name)) return // genuinely self-recursive
    candidates.push({ name, lam: value })
  }
  // Every never-shadowed, non-effectful lambda binding by name — used to look up
  // the members of a proven-terminating recursive group.
  const fnByName = new Map<string, Expr>()
  const noteFn = (name: string, value: Expr): void => {
    if (value.kind === 'lambda' && counts.get(name) === 1 && !EFFECTFUL_NATIVES.has(name)) {
      fnByName.set(name, value)
    }
  }
  const walk = (e: Expr): void => {
    if (e.kind === 'let') {
      consider(e.name, e.value, e.recursive)
      noteFn(e.name, e.value)
    } else if (e.kind === 'letrec') {
      // a group is recursive iff any binder is referenced from any value; only a
      // group with no internal references at all is total *without* a proof.
      const groupFv = new Set<string>()
      for (const b of e.bindings) for (const v of freeVars(b.value)) groupFv.add(v)
      if (!e.bindings.some((b) => groupFv.has(b.name))) {
        for (const b of e.bindings) consider(b.name, b.value, false)
      }
      for (const b of e.bindings) noteFn(b.name, b.value)
    }
    for (const c of childrenOf(e)) walk(c)
  }
  walk(root)

  // Proven-terminating recursive groups, restricted to clean (named, unshadowed)
  // members we can actually look up — admitted as whole groups below.
  const recGroups: string[][] = TERMINATION.recursiveGroups
    .map((g) => g.members)
    .filter((members) => members.every((m) => fnByName.has(m)))

  const known = new Map<string, { arity: number; body: Expr }>()
  PURE_FNS = known // isPure consults PURE_FNS while the set is being built
  const triedGroups = new Set<string>()
  let changed = true
  while (changed) {
    changed = false
    // non-recursive candidates: admit any whose body is now pure
    for (const c of candidates) {
      if (known.has(c.name)) continue
      if (isPure(lambdaBody(c.lam))) {
        known.set(c.name, { arity: lambdaArity(c.lam), body: lambdaBody(c.lam) })
        changed = true
      }
    }
    // recursive groups: tentative all-or-nothing commit
    for (const members of recGroups) {
      const key = members.join(',')
      if (triedGroups.has(key)) continue
      if (members.some((m) => known.has(m))) continue
      for (const m of members) {
        const lam = fnByName.get(m)!
        known.set(m, { arity: lambdaArity(lam), body: lambdaBody(lam) })
      }
      if (members.every((m) => isPure(lambdaBody(fnByName.get(m)!)))) {
        triedGroups.add(key) // committed for good
        changed = true
      } else {
        for (const m of members) known.delete(m) // roll back; retry after deps grow
      }
    }
  }
  return known
}

// ---------------------------------------------------------------------------
// Common-subexpression elimination
// ---------------------------------------------------------------------------

/**
 * A conservative **lower bound** on the VM steps to evaluate `e` once. Used only
 * to gate CSE: because a shared `let` costs exactly one extra VM instruction over
 * evaluating its value and body, sharing an expression of cost ≥ 4 between ≥ 2
 * guaranteed evaluations is always a *strict* step win. So this must never
 * *over*-count — every branch below counts only work that definitely happens
 * (one `if`/`match` arm, only the left of `&&`/`||`, never a closure body unless
 * the call is a proven-total saturated one).
 */
function minCost(e: Expr): number {
  switch (e.kind) {
    case 'int':
    case 'float':
    case 'bool':
    case 'str':
    case 'unit':
    case 'var':
    case 'lambda':
      return 1
    case 'unop':
      return 1 + minCost(e.operand)
    case 'binop':
      return e.op === '&&' || e.op === '||'
        ? 1 + minCost(e.left)
        : 1 + minCost(e.left) + minCost(e.right)
    case 'if':
      return 1 + minCost(e.cond) + Math.min(minCost(e.then), minCost(e.else))
    case 'seq':
      return minCost(e.first) + minCost(e.rest)
    case 'let':
      return 1 + minCost(e.value) + minCost(e.body)
    case 'tuple':
    case 'list':
      return 1 + e.elements.reduce((n, x) => n + minCost(x), 0)
    case 'record':
      return 1 + e.fields.reduce((n, f) => n + minCost(f.value), 0)
    case 'recordUpdate':
      return 1 + minCost(e.record) + e.fields.reduce((n, f) => n + minCost(f.value), 0)
    case 'field':
      return 1 + minCost(e.record)
    case 'match':
      return 1 + minCost(e.scrutinee) + Math.min(...e.cases.map((c) => minCost(c.body)))
    case 'app': {
      const f = spineHead(e)
      if (f && PURE_FNS.has(f.name) && f.args.length === PURE_FNS.get(f.name)!.arity) {
        // a saturated proven-total call: at least its args + its (terminating) body
        return 1 + f.args.reduce((n, a) => n + minCost(a), 0) + bodyCost(f.name)
      }
      return 1 + minCost(e.fn) + minCost(e.arg)
    }
    default:
      return 1
  }
}

/** Memoised lower-bound cost of a proven-pure function's body. The pure-call
 *  graph is acyclic (no recursion is admitted), so this terminates. */
function bodyCost(name: string): number {
  const cached = bodyCostMemo.get(name)
  if (cached !== undefined) return cached
  bodyCostMemo.set(name, 1) // conservative guard against any unexpected cycle
  const c = minCost(PURE_FNS.get(name)!.body)
  bodyCostMemo.set(name, c)
  return c
}

// The strict, binder-free evaluation *frontier* of a node: the children that are
// guaranteed to be evaluated, exactly once, before the node yields its value,
// without crossing a binder. Conditional positions (an `if`'s / `match`'s arms,
// the right of `&&`/`||`) and lambda bodies are deliberately NOT on the frontier,
// so anything CSE shares from here already ran on every path to the others.
function frontierChildren(e: Expr): Expr[] {
  switch (e.kind) {
    case 'app':
      return [e.fn, e.arg]
    case 'binop':
      return e.op === '&&' || e.op === '||' ? [e.left] : [e.left, e.right]
    case 'unop':
      return [e.operand]
    case 'tuple':
    case 'list':
      return e.elements
    case 'record':
      return e.fields.map((f) => f.value)
    case 'recordUpdate':
      return [e.record, ...e.fields.map((f) => f.value)]
    case 'field':
      return [e.record]
    case 'seq':
      return [e.first, e.rest]
    case 'if':
      return [e.cond]
    case 'match':
      return [e.scrutinee]
    default:
      return [] // let / letrec / lambda / var / literals: a binder or a leaf — stop
  }
}

/** Rebuild `e`, mapping its frontier children through `f` and leaving every
 *  non-frontier child untouched (mirrors `frontierChildren` exactly). */
function rebuildFrontier(e: Expr, f: (x: Expr) => Expr): Expr {
  switch (e.kind) {
    case 'app':
      return { ...e, fn: f(e.fn), arg: f(e.arg) }
    case 'binop':
      return e.op === '&&' || e.op === '||'
        ? { ...e, left: f(e.left) }
        : { ...e, left: f(e.left), right: f(e.right) }
    case 'unop':
      return { ...e, operand: f(e.operand) }
    case 'tuple':
    case 'list':
      return { ...e, elements: e.elements.map(f) }
    case 'record':
      return { ...e, fields: e.fields.map((fl) => ({ label: fl.label, value: f(fl.value) })) }
    case 'recordUpdate':
      return {
        ...e,
        record: f(e.record),
        fields: e.fields.map((fl) => ({ label: fl.label, value: f(fl.value) })),
      }
    case 'field':
      return { ...e, record: f(e.record) }
    case 'seq':
      return { ...e, first: f(e.first), rest: f(e.rest) }
    case 'if':
      return { ...e, cond: f(e.cond) }
    case 'match':
      return { ...e, scrutinee: f(e.scrutinee) }
    default:
      return e
  }
}

/** Replace every frontier occurrence whose canonical form equals `key` with `v`,
 *  *not* touching the root node itself (only its frontier descendants). */
function replaceFrontier(node: Expr, key: string, v: Expr): Expr {
  const repl = (e: Expr): Expr => (canon(e) === key ? v : rebuildFrontier(e, repl))
  return rebuildFrontier(node, repl)
}

// Sharing an expression of evaluation-cost ≥ 3 across ≥ 2 guaranteed evaluations
// never increases VM steps: the saving is `(n−1)·cost`, the overhead a single
// extra `let` instruction plus one variable load per site, so the net step change
// is `1 + n − (n−1)·cost ≤ 0` once `cost ≥ 3`. (Verified against the compiler:
// a non-recursive `let` is exactly one `POP_BELOW`, a `var` one `GET_LOCAL`.)
const COST_THRESHOLD = 3

/**
 * Common-subexpression elimination. On a strict combinator node, find a pure,
 * costly expression that the node's binder-free strict frontier evaluates more
 * than once and hoist it into a single fresh `let`, sharing the result. Safe by
 * three invariants (see the file header): only **pure** (effect-free + total)
 * expressions are touched; only **guaranteed-evaluated** occurrences are merged
 * (so VM steps can only fall); and the hoist crosses **no binder** (so it is
 * scope-safe with no α-renaming).
 */
function tryCse(node: Expr, bump: Bump): Expr | null {
  const groups = new Map<string, Expr[]>()
  const visit = (e: Expr): void => {
    if (isPure(e) && minCost(e) >= COST_THRESHOLD) {
      const k = canon(e)
      const arr = groups.get(k)
      if (arr) arr.push(e)
      else groups.set(k, [e])
    }
    for (const c of frontierChildren(e)) visit(c)
  }
  for (const c of frontierChildren(node)) visit(c)

  // pick the duplicate group with the largest guaranteed saving
  let bestKey: string | null = null
  let bestSaving = 0
  for (const [k, arr] of groups) {
    if (arr.length < 2) continue
    const saving = (arr.length - 1) * minCost(arr[0])
    if (saving > bestSaving) {
      bestSaving = saving
      bestKey = k
    }
  }
  if (bestKey === null) return null

  const s = groups.get(bestKey)![0]
  const name = gensym('cse')
  const body = replaceFrontier(node, bestKey, { kind: 'var', name, span: s.span })
  bump('cse')
  return { kind: 'let', name, value: s, body, recursive: false, span: node.span }
}

// Span-insensitive canonical form, used to recognise identical subexpressions.
// Variables compare by name (sound only inside a binder-free region, which is the
// only place CSE compares them). Memoised like `freeVars`.
const canonCache = new WeakMap<Expr, string>()
function canon(e: Expr): string {
  const c = canonCache.get(e)
  if (c !== undefined) return c
  const s = canonCompute(e)
  canonCache.set(e, s)
  return s
}

function canonCompute(e: Expr): string {
  switch (e.kind) {
    case 'int':
      return 'i' + e.value
    case 'float':
      return 'f' + e.value
    case 'bool':
      return 'b' + (e.value ? 1 : 0)
    case 'str':
      return 's' + JSON.stringify(e.value)
    case 'unit':
      return 'u'
    case 'var':
      return 'v' + e.name
    case 'lambda':
      return 'L' + e.param + '.' + canon(e.body)
    case 'app':
      return '(' + canon(e.fn) + ' ' + canon(e.arg) + ')'
    case 'binop':
      return '[' + e.op + canon(e.left) + canon(e.right) + ']'
    case 'unop':
      return '{' + e.op + canon(e.operand) + '}'
    case 'if':
      return '?' + canon(e.cond) + ':' + canon(e.then) + ':' + canon(e.else)
    case 'let':
      return 'let' + (e.recursive ? '*' : '') + e.name + '=' + canon(e.value) + ';' + canon(e.body)
    case 'letrec':
      return 'ltr[' + e.bindings.map((b) => b.name + '=' + canon(b.value)).join(',') + '];' + canon(e.body)
    case 'tuple':
      return 'T(' + e.elements.map(canon).join(',') + ')'
    case 'list':
      return 'Li[' + e.elements.map(canon).join(',') + ']'
    case 'seq':
      return canon(e.first) + ';;' + canon(e.rest)
    case 'match':
      return (
        'M' +
        canon(e.scrutinee) +
        '{' +
        e.cases
          .map((c) => canonPat(c.pattern) + (c.guard ? '|' + canon(c.guard) : '') + '>' + canon(c.body))
          .join(';') +
        '}'
      )
    case 'record':
      return 'R{' + e.fields.map((f) => f.label + '=' + canon(f.value)).join(',') + '}'
    case 'field':
      return canon(e.record) + '.' + e.label
    case 'recordUpdate':
      return canon(e.record) + '{|' + e.fields.map((f) => f.label + '=' + canon(f.value)).join(',') + '}'
    case 'typedecl':
      return 'ty;' + canon(e.body)
    case 'classdecl':
      return 'cl;' + canon(e.body)
    case 'instancedecl':
      return 'in;' + canon(e.body)
  }
}

function canonPat(p: Pattern): string {
  switch (p.kind) {
    case 'pwild':
      return '_'
    case 'pvar':
      return '@' + p.name
    case 'pint':
      return 'i' + p.value
    case 'pfloat':
      return 'f' + p.value
    case 'pbool':
      return 'b' + (p.value ? 1 : 0)
    case 'pstr':
      return 's' + JSON.stringify(p.value)
    case 'punit':
      return 'u'
    case 'pnil':
      return 'n'
    case 'pcons':
      return '(' + canonPat(p.head) + '::' + canonPat(p.tail) + ')'
    case 'ptuple':
      return 'T(' + p.elements.map(canonPat).join(',') + ')'
    case 'pcon':
      return 'C' + p.name + '(' + p.args.map(canonPat).join(',') + ')'
  }
}

// ---------------------------------------------------------------------------
// Misc
// ---------------------------------------------------------------------------

/** Collect `ctorName -> arity` from every `type` declaration in the program. */
function collectCtors(root: Expr): Map<string, number> {
  const m = new Map<string, number>()
  const walk = (e: Expr): void => {
    if (e.kind === 'typedecl') for (const c of e.ctors) m.set(c.name, c.args.length)
    for (const child of childrenOf(e)) walk(child)
  }
  walk(root)
  return m
}

function size(e: Expr): number {
  let n = 1
  for (const c of childrenOf(e)) n += size(c)
  return n
}

function childrenOf(e: Expr): Expr[] {
  switch (e.kind) {
    case 'lambda':
      return [e.body]
    case 'app':
      return [e.fn, e.arg]
    case 'let':
      return [e.value, e.body]
    case 'if':
      return [e.cond, e.then, e.else]
    case 'binop':
      return [e.left, e.right]
    case 'unop':
      return [e.operand]
    case 'list':
    case 'tuple':
      return e.elements
    case 'seq':
      return [e.first, e.rest]
    case 'match':
      return [e.scrutinee, ...e.cases.flatMap((c) => (c.guard ? [c.guard, c.body] : [c.body]))]
    case 'typedecl':
      return [e.body]
    case 'letrec':
      return [...e.bindings.map((b) => b.value), e.body]
    case 'record':
      return e.fields.map((f) => f.value)
    case 'field':
      return [e.record]
    case 'recordUpdate':
      return [e.record, ...e.fields.map((f) => f.value)]
    case 'classdecl':
      return [e.body]
    case 'instancedecl':
      return [...e.methods.map((m) => m.value), e.body]
    default:
      return []
  }
}
