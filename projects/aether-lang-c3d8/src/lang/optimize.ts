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
//   • static-arg xform — a loop-invariant parameter of a recursive function is
//                        lifted into a thin wrapper so the worker loop recurses on
//                        only the dynamic arguments (Aether 17.0; Santos 1995)
//   • float-in         — a pure, non-value `let` binding is *sunk* past a conditional
//                        to the smallest subexpression that dominates all its uses, so
//                        on paths that never reach the use the work is skipped — the
//                        dual of GVN's hoist-to-share (Aether 19.0; Peyton Jones,
//                        Partain & Santos, "Let-floating", ICFP 1996)
//   • dead-arg elim    — a parameter whose value never reaches the result (an unused
//                        parameter, or a useless accumulator that only feeds its own
//                        recursive position) is dropped from the function and from every
//                        saturated call site, shedding work per iteration (Aether 20.0)
//
// `known-match` + `field projection` + `inline` are what make the abstraction the
// front end adds — type-class dictionaries, `deriving`, `do`-notation, list
// comprehensions, the `|>` pipe — melt away: a dictionary record is inlined, the
// method projected out, the call β-reduced, and a `match` on a now-literal
// constructor collapses to its arm.

import type { BinaryOp, Expr, MatchCase, Pattern } from './ast.ts'
import { cloneExpr } from './ast.ts'
import { unparse } from './unparse.ts'
import { collectSiblings, compileMatches } from './decisiontree.ts'
import type { DtStats, DtView } from './decisiontree.ts'
import { analyzeTermination } from './termination.ts'
import type { TerminationResult } from './termination.ts'
import { equalitySaturate } from './egraph.ts'
import type { EqSatStats } from './egraph.ts'
import { fuseLists } from './fusion.ts'
import type { FusionStat } from './fusion.ts'

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
  /** one entry per expression the global value-numbering pass hoisted across a
   *  binder into a shared `let` (Aether 14.0) — for the Optimizer panel. */
  gvnHoists: { expr: string; sites: number }[]
  /** one entry per non-recursive function the call-site inliner copied into its
   *  saturated call sites (Aether 15.0) — for the Optimizer panel. */
  inlinedFns: { name: string; sites: number; size: number; escaped: boolean }[]
  /** one entry per recursive function the static-argument transformation lifted a
   *  loop-invariant argument out of (Aether 17.0) — for the Optimizer panel. */
  satTransforms: { name: string; arity: number; static: string[]; dynamic: string[]; calls: number }[]
  /** one entry per pure, non-value `let` binding the float-in pass sank past a
   *  conditional into the one branch that uses it (Aether 19.0) — for the panel. */
  floatIns: { name: string; value: string; into: string }[]
  /** one entry per recursive function the call-pattern specialisation (SpecConstr)
   *  pass unpacked a constructor/tuple-shaped argument out of (Aether 23.0). */
  specConstrs: { name: string; shape: string; arity: number; param: string; calls: number }[]
  /** one entry per function the dead-argument-elimination pass dropped a parameter
   *  from — one whose value never reaches the result (Aether 20.0). */
  deadParams: { name: string; dropped: string[]; recursive: boolean }[]
  /** one entry per eliminator the case-of-case pass pushed into an `if`/`match`
   *  producer's branches (Aether 21.0) — for the Optimizer panel. */
  commutes: { frame: string; producer: string; branches: number; exposed: number }[]
  /** one entry per `let`-bound record whose field projections the scalar-
   *  replacement-of-aggregates pass devirtualized to the field values themselves
   *  (Aether 24.0) — the dictionary-specialisation win, for the Optimizer panel. */
  sroaRecords: { record: string; fields: string[]; sites: number; eliminated: boolean }[]
  /** decision-tree compilation statistics (Aether 12.0) */
  dt: DtStats
  /** one entry per `match` rewritten into a decision tree (for the panel) */
  decisionTrees: DtView[]
  /** size-change termination analysis — the proof that lets the totality analysis
   *  admit *recursive* functions (Aether 13.0). Null only if it wasn't run. */
  termination: TerminationResult | null
  /** equality-saturation superoptimizer over the integer-arithmetic islands
   *  (Aether 16.0) — the islands found and the ones it improved. */
  eqsat: EqSatStats | null
  /** short-cut fusion (Aether 18.0) — one entry per fusion law that fired,
   *  with how many intermediate-list-deleting rewrites it performed. */
  fusions: FusionStat[]
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

// One entry per non-recursive function the call-site inliner copied into its
// saturated call sites this run (Aether 15.0). Module-level for the same reason
// as `freshCounter` — optimization is synchronous and single-shot — and surfaced
// in the Optimizer panel. Reset per run.
let INLINES: { name: string; sites: number; size: number; escaped: boolean }[] = []

// One entry per recursive function the static-argument transformation rewrote
// this run (Aether 17.0). Module-level for the same reason as `freshCounter` —
// optimization is synchronous and single-shot — and surfaced in the Optimizer
// panel. Reset per run.
let SATS: { name: string; arity: number; static: string[]; dynamic: string[]; calls: number }[] = []

// One entry per pure, non-value `let` binding the float-in pass sank past a
// conditional this run (Aether 19.0). Module-level for the same reason as
// `freshCounter` — optimization is synchronous and single-shot — and surfaced in
// the Optimizer panel. Reset per run.
let FLOATINS: { name: string; value: string; into: string }[] = []

// One entry per recursive function the call-pattern specialisation (SpecConstr)
// pass unpacked a constructor/tuple-shaped argument out of this run (Aether 23.0).
// Module-level for the same reason as `freshCounter` — optimization is synchronous
// and single-shot — and surfaced in the Optimizer panel. Reset per run.
let SPECCONSTRS: { name: string; shape: string; arity: number; param: string; calls: number }[] = []

// One entry per function the dead-argument-elimination pass dropped a parameter
// from this run (Aether 20.0). Module-level for the same reason as `freshCounter`
// — optimization is synchronous and single-shot — and surfaced in the Optimizer
// panel. Reset per run.
let DEADPARAMS: { name: string; dropped: string[]; recursive: boolean }[] = []

// One entry per eliminator the case-of-case pass pushed into an `if`/`match`
// producer this run (Aether 21.0). Module-level for the same reason as
// `freshCounter` — optimization is synchronous and single-shot — and surfaced in
// the Optimizer panel. Reset per run.
let COMMUTES: { frame: string; producer: string; branches: number; exposed: number }[] = []

// One entry per `let`-bound record whose field projections the scalar-replacement-
// of-aggregates pass devirtualized this run (Aether 24.0). Module-level for the
// same reason as `freshCounter` — optimization is synchronous and single-shot —
// and surfaced in the Optimizer panel. Reset per run.
let SROAS: { record: string; fields: string[]; sites: number; eliminated: boolean }[] = []

// Whether the multi-use call-site inliner is active. It melts *source-level*
// abstraction, so it runs in the main optimization phase but is switched off for
// the post-decision-tree cleanup fixpoint — that phase is reserved for copy-
// propagating the tree's own bindings, and inlining there would only re-duplicate
// the join-points the decision-tree pass deliberately introduced to share code.
let ALLOW_FN_INLINE = true

// Upper bound (in core-AST nodes) on the size of a function body the call-site
// inliner will copy. Inlining never increases *runtime* steps (an inlined call is
// cheaper than a real one and un-taken copies cost nothing), so this gate only
// bounds *code growth* — it keeps small, hot helpers inline-worthy while leaving
// large definitions a single shared closure.
const INLINE_SIZE_LIMIT = 20

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
  INLINES = []
  SATS = []
  FLOATINS = []
  SPECCONSTRS = []
  DEADPARAMS = []
  COMMUTES = []
  SROAS = []
  ALLOW_FN_INLINE = true
  const passes: Record<string, number> = {}
  const bump = (name: string): void => {
    passes[name] = (passes[name] ?? 0) + 1
  }

  const nodesBefore = size(root)
  const trace: { round: number; rewrites: number; nodes: number }[] = []
  const gvnHoists: { expr: string; sites: number }[] = []
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

  // Phase 0: short-cut fusion (Aether 18.0). Run *first*, on the pristine core,
  // before the fixpoint's β/inlining/SAT can rewrite the prelude combinators out
  // of their recognisable shape. It deletes the intermediate lists that flow
  // between combinator passes (`map f (map g xs)` ⇒ one pass, no list in between),
  // emitting ordinary core the fixpoint below then cleans up (β-reducing the
  // composed lambdas, inlining, folding what the merge exposed).
  let fusions: FusionStat[] = []
  {
    const isPureFnName = (name: string): boolean =>
      PURE_FNS.has(name) || (TOTAL_NATIVES.has(name) && !SHADOWED.has(name))
    const f = fuseLists(expr, { isPureTotal: isPure, isPureFnName })
    if (f.count > 0) {
      expr = f.expr
      fusions = f.fusions
      passes['fuse'] = (passes['fuse'] ?? 0) + f.count
    }
  }

  // Phase 1: rewrite to a fixpoint (folds, inlining, known-match, CSE, …) so the
  // abstraction the front end adds has already melted before we touch matching.
  fixpoint()

  // Phase 1b: global value numbering (Aether 14.0). The bottom-up CSE above only
  // shares an expression with its *binder-free strict frontier* siblings; this
  // top-down pass shares a pure, costly expression recomputed across `let` / `λ` /
  // `match` binders, hoisting it into one shared `let` at the dominating node. It
  // is gated on the expression being guaranteed-evaluated ≥ 2 times (so VM steps
  // can only fall), so it runs *after* the fixpoint melted the abstraction (more
  // redundancy is exposed) and re-runs the fixpoint to clean up what it uncovers.
  {
    const g = globalValueNumber(expr, bump)
    if (g.hoists.length > 0) {
      expr = g.expr
      gvnHoists.push(...g.hoists)
      fixpoint()
    }
  }

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
    // join-points — and to fold anything the new structure exposes. The multi-use
    // call-site inliner is held off here so it cannot re-duplicate the shared
    // join-points the decision-tree pass just introduced.
    ALLOW_FN_INLINE = false
    fixpoint()
  }

  // Phase 4: equality saturation (Aether 16.0). A non-destructive, e-graph based
  // superoptimizer for the integer-arithmetic islands the greedy fixpoint above
  // cannot fully simplify — it considers all reassociations / distributions /
  // factorings at once and extracts the cheapest equivalent form, then validates
  // each adopted rewrite by polynomial identity testing. Run last, on the already
  // shrunk core, and gated to *strictly cheaper* forms so VM steps only fall.
  const eqsatRun = equalitySaturate(expr, { isPure })
  const eqsat: EqSatStats = eqsatRun.stats
  if (eqsatRun.stats.rewrites.length > 0) {
    expr = eqsatRun.expr
    passes['eqsat'] = (passes['eqsat'] ?? 0) + eqsatRun.stats.rewrites.length
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
      gvnHoists,
      inlinedFns: INLINES,
      satTransforms: SATS,
      floatIns: FLOATINS,
      specConstrs: SPECCONSTRS,
      deadParams: DEADPARAMS,
      commutes: COMMUTES,
      sroaRecords: SROAS,
      dt,
      decisionTrees,
      termination: TERMINATION,
      eqsat,
      fusions,
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
      return reduceBinop(n, bump) ?? commute(n, bump) ?? tryCse(n, bump) ?? n
    }
    case 'unop': {
      const n = { ...e, operand: rec(e.operand) }
      return reduceUnop(n, bump) ?? commute(n, bump) ?? tryCse(n, bump) ?? n
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
      return (
        reduceMatch(n as Extract<Expr, { kind: 'match' }>, bump) ??
        commute(n, bump) ??
        tryCse(n, bump) ??
        n
      )
    }
    case 'record': {
      const n = { ...e, fields: e.fields.map((f) => ({ label: f.label, value: rec(f.value) })) }
      return tryCse(n, bump) ?? n
    }
    case 'field': {
      const n = { ...e, record: rec(e.record) }
      return reduceField(n, bump) ?? commute(n, bump) ?? tryCse(n, bump) ?? n
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
    // dead-argument elimination (Aether 20.0): drop a parameter whose value never
    // reaches the result (an unused param, or a useless accumulator that only feeds
    // its own recursive slot). Run before SAT so the loop is at its minimum arity
    // before SAT classifies the survivors static/dynamic.
    const dpe = deadArgumentElim(e, bump)
    if (dpe) return dpe
    // static-argument transformation (Aether 17.0): lift a loop-invariant
    // parameter out of the recursive loop, leaving it captured as a free var.
    const sat = staticArgumentTransform(e, bump)
    if (sat) return sat
    // call-pattern specialisation (Aether 23.0): unpack a loop-*varying* argument
    // that is rebuilt as the same constructor/tuple shape every iteration and torn
    // straight back apart, so the cell is never boxed and the `match` never runs.
    const sc = specConstr(e, bump)
    if (sc) return sc
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

  // Scalar replacement of aggregates (Aether 24.0). A *multi-use* `let`-bound
  // record literal is never inlined by the value rule above (it is a value but
  // not an atom, and `uses > 1`), so its field projections `x.f` stay live — a
  // load + a projection per use — and the cell stays allocated. This pass
  // devirtualizes each projection to the field's *value* directly, which removes
  // the projection (and, once every use is gone, the allocation too). Its headline
  // is dictionary specialisation: a `Disp a => …` function's shared dictionary
  // `{ disp = show }` collapses so `d.disp x` becomes the direct call `show x`,
  // even when the dictionary is reused across many call sites. Monotone by
  // construction (see `scalarReplaceRecord`), so it ships to all three backends.
  if (e.value.kind === 'record') {
    const sroa = scalarReplaceRecord(e, bump)
    if (sroa) return sroa
  }

  // Multi-use call-site inlining (Aether 15.0). A *small, non-recursive* function
  // bound here is worth copying into each of its *saturated call sites* — that
  // removes the closure-application + call overhead the site pays, and exposes the
  // body to const-folding/known-match at the site — while every *other* occurrence
  // (a partial application, or an escape into a higher-order argument) keeps
  // referring to the binding, so its one closure is built at most once. The rewrite
  // strictly lowers VM steps (an inlined call is cheaper than a real one, and a copy
  // on an un-taken path costs nothing at runtime) and never speculates, so the
  // harness's never-increase-steps invariant is preserved by construction.
  if (
    ALLOW_FN_INLINE &&
    e.value.kind === 'lambda' &&
    uses >= 2 &&
    !freeVars(e.value).has(e.name) && // the value never refers to its own binder
    lambdaBody(e.value).kind !== 'match' && // leave match-bodied fns to the DT pass
    size(e.value) <= INLINE_SIZE_LIMIT
  ) {
    const inlined = inlineCallSites(e.name, e.value, e.body, e.span, bump)
    if (inlined) return inlined
  }

  // Dead-argument elimination (Aether 20.0) for a non-recursive function the inliner
  // declined to copy (too large, or match-bodied): drop an unused parameter from the
  // lambda and from each saturated call site.
  if (e.value.kind === 'lambda' && lambdaArity(e.value) >= 2) {
    const dpe = deadArgumentElim(e, bump)
    if (dpe) return dpe
  }

  // Float-in (Aether 19.0): sink a pure, *non-value* binding past a conditional
  // into the one branch that uses it, so the other branches skip the work. Tried
  // after the inliners (a value/atom is copied or dropped, never sunk) and gated on
  // the move crossing a conditional, so every float-in is a strict potential win.
  if (isPure(e.value) && !isValue(e.value)) {
    const sunk = sinkBinding(e.name, e.value, freeVars(e.value), e.body)
    if (sunk && sunk.crossed) {
      bump('float-in')
      FLOATINS.push({ name: e.name, value: truncate(unparse(e.value), 40), into: sunk.landedIn })
      return cloneExpr(sunk.expr)
    }
  }

  // Linear inlining of a single-use *producer* (Aether 21.1). The value inliner
  // above copies a single-use *value*; this inlines a single-use, pure, *non-value*
  // binding (an `if`/`match`/projection — anything that does work) into its sole
  // occurrence, *provided that occurrence is not under a lambda* (so it is evaluated
  // at most as often as the binding was — never more, so VM steps can only fall).
  // It exists to feed case-of-case: `let z = if c then a else b in <strict use of z>`
  // becomes the eliminator sitting directly on the producer, which the commuting
  // pass then distributes into the branches (otherwise the `let` hides the producer
  // and the abstraction never melts).
  if (uses === 1 && isPure(e.value) && !isValue(e.value) && !occursUnderLambda(e.name, e.body)) {
    bump('inline-linear')
    return subst(e.name, e.value, e.body)
  }

  return null
}

// Does a *free* occurrence of `name` in `e` sit under a lambda (so it could be
// evaluated more than once, once per call)? Used to keep linear inlining of a
// single-use non-value binding from turning one evaluation into many. Shadowing
// binders (a nested λ/let/letrec/match arm that rebinds `name`) cut the search.
function occursUnderLambda(name: string, e: Expr): boolean {
  const go = (x: Expr, under: boolean): boolean => {
    switch (x.kind) {
      case 'var':
        return under && x.name === name
      case 'int':
      case 'float':
      case 'bool':
      case 'str':
      case 'unit':
        return false
      case 'lambda':
        return x.param === name ? false : go(x.body, true)
      case 'app':
        return go(x.fn, under) || go(x.arg, under)
      case 'let': {
        const valueShadowed = x.recursive && x.name === name
        if (!valueShadowed && go(x.value, under)) return true
        return x.name === name ? false : go(x.body, under)
      }
      case 'letrec':
        if (x.bindings.some((b) => b.name === name)) return false
        return x.bindings.some((b) => go(b.value, under)) || go(x.body, under)
      case 'if':
        return go(x.cond, under) || go(x.then, under) || go(x.else, under)
      case 'binop':
        return go(x.left, under) || go(x.right, under)
      case 'unop':
        return go(x.operand, under)
      case 'seq':
        return go(x.first, under) || go(x.rest, under)
      case 'list':
      case 'tuple':
        return x.elements.some((el) => go(el, under))
      case 'record':
        return x.fields.some((f) => go(f.value, under))
      case 'field':
        return go(x.record, under)
      case 'recordUpdate':
        return go(x.record, under) || x.fields.some((f) => go(f.value, under))
      case 'match': {
        if (go(x.scrutinee, under)) return true
        return x.cases.some((c) => {
          const bound = new Set<string>()
          patternVars(c.pattern, bound)
          if (bound.has(name)) return false
          return (c.guard ? go(c.guard, under) : false) || go(c.body, under)
        })
      }
      case 'typedecl':
        return go(x.body, under)
      case 'classdecl':
        return go(x.body, under)
      case 'instancedecl':
        return x.methods.some((m) => go(m.value, under)) || go(x.body, under)
    }
  }
  return go(e, false)
}

// ---------------------------------------------------------------------------
// Scalar replacement of aggregates — record-field SROA (Aether 24.0)
// ---------------------------------------------------------------------------
//
// A `let x = { f1 = v1, … } in body` binds an immutable record. Its single-use
// case is already handled (the value rule copies the whole record into its sole
// occurrence, then `reduceField` projects it). The MULTI-use case is the gap this
// pass fills: every `x.fi` then stays a *load + a projection* at runtime and the
// cell stays allocated. We rewrite `x.fi` to the field's value `vi` directly,
// "replacing the aggregate with scalars".
//
// The motivating instance is DICTIONARY SPECIALISATION. A constrained function
// `let twice = fn d -> fn x -> d.disp x ^ d.disp x` applied at one type elaborates
// to `twice {disp = show} 7` — and after the fixpoint inlines `twice`, the body is
// `({disp=show}.disp 7) ^ …` *only when the dictionary is single-use*. When the
// same dictionary feeds several call sites it is shared in one `let`, the inliner
// declines it (a value, multi-use), and `d.disp x` never devirtualizes. This pass
// closes that: `d.disp` collapses to `show`, so the indirect, dictionary-passing
// call becomes a direct `show x` even across many uses.
//
// MONOTONICITY (the harness's "VM steps never rise" invariant) holds by
// construction. Two field shapes are eligible:
//   • an ATOM field (a var or literal) — duplicating it is free and effect-free,
//     and a single load is never costlier than a load-then-project, so rewriting
//     any number of `x.fi` is a strict (weak) win whether or not the record
//     survives afterwards.
//   • a non-atom VALUE field (e.g. a λ) — eligible only when (a) `x` is used
//     *solely* through projections (so substituting them all leaves the record
//     dead and it is dropped) and (b) that field is projected at most once (so its
//     single closure moves to the call site rather than being built both in the
//     record and inline). Either way the field is built exactly once, minus a
//     projection — never more often.
// Substitution is capture-safe: it stops descending into any binder that re-binds
// `x` (an inner `x` is a different value there) or that re-binds a free variable
// of the field it would substitute (which would capture it).

/** Count how `x` is used in `e`: per-label projection counts (`x.label`) and the
 *  number of *whole* uses (a bare `x` not serving as the record of a projection).
 *  Respects shadowing — a binder that re-binds `x` cuts the walk. */
function classifyRecordUses(x: string, e: Expr): { proj: Map<string, number>; whole: number } {
  const proj = new Map<string, number>()
  let whole = 0
  const go = (n: Expr, live: boolean): void => {
    if (!live) return
    switch (n.kind) {
      case 'var':
        if (n.name === x) whole++
        return
      case 'field':
        if (n.record.kind === 'var' && n.record.name === x) {
          proj.set(n.label, (proj.get(n.label) ?? 0) + 1)
          return
        }
        go(n.record, live)
        return
      case 'app':
        go(n.fn, live)
        go(n.arg, live)
        return
      case 'lambda':
        go(n.body, n.param === x ? false : live)
        return
      case 'let':
        go(n.value, n.recursive && n.name === x ? false : live)
        go(n.body, n.name === x ? false : live)
        return
      case 'letrec': {
        const shadowed = n.bindings.some((b) => b.name === x)
        for (const b of n.bindings) go(b.value, shadowed ? false : live)
        go(n.body, shadowed ? false : live)
        return
      }
      case 'if':
        go(n.cond, live)
        go(n.then, live)
        go(n.else, live)
        return
      case 'binop':
        go(n.left, live)
        go(n.right, live)
        return
      case 'unop':
        go(n.operand, live)
        return
      case 'seq':
        go(n.first, live)
        go(n.rest, live)
        return
      case 'list':
      case 'tuple':
        for (const el of n.elements) go(el, live)
        return
      case 'record':
        for (const f of n.fields) go(f.value, live)
        return
      case 'recordUpdate':
        go(n.record, live)
        for (const f of n.fields) go(f.value, live)
        return
      case 'match': {
        go(n.scrutinee, live)
        for (const c of n.cases) {
          const bound = new Set<string>()
          patternVars(c.pattern, bound)
          const l2 = bound.has(x) ? false : live
          if (c.guard) go(c.guard, l2)
          go(c.body, l2)
        }
        return
      }
      case 'typedecl':
        go(n.body, live)
        return
      case 'classdecl':
        go(n.body, live)
        return
      case 'instancedecl':
        for (const m of n.methods) go(m.value, live)
        go(n.body, live)
        return
      default:
        return // literals
    }
  }
  go(e, true)
  return { proj, whole }
}

/** Replace each projection `x.label` (for `label` in `chosen`) with the chosen
 *  field value, capture-avoiding. `fvByLabel` is the precomputed free-var set of
 *  each chosen value; substitution of a label stops under any binder that would
 *  capture one of those vars (or that re-binds `x`). Returns the rewritten body
 *  and the number of projections actually replaced. */
function substProjections(
  x: string,
  chosen: Map<string, Expr>,
  fvByLabel: Map<string, Set<string>>,
  body: Expr,
): { expr: Expr; n: number } {
  let n = 0
  // Narrow `active` when entering a binder: drop `x` entirely if the binder
  // re-binds it; drop any label whose value's free vars clash with a bound name.
  const restrict = (active: Map<string, Expr>, bound: Iterable<string>): Map<string, Expr> => {
    const bset = bound instanceof Set ? bound : new Set(bound)
    if (bset.has(x)) return new Map()
    let out = active
    for (const [label] of active) {
      const fv = fvByLabel.get(label)!
      let clash = false
      for (const b of bset) {
        if (fv.has(b)) {
          clash = true
          break
        }
      }
      if (clash) {
        if (out === active) out = new Map(active)
        out.delete(label)
      }
    }
    return out
  }
  const go = (e: Expr, active: Map<string, Expr>): Expr => {
    if (active.size === 0) return e
    switch (e.kind) {
      case 'field':
        if (e.record.kind === 'var' && e.record.name === x && active.has(e.label)) {
          n++
          return active.get(e.label)!
        }
        return { ...e, record: go(e.record, active) }
      case 'var':
      case 'int':
      case 'float':
      case 'bool':
      case 'str':
      case 'unit':
        return e
      case 'app':
        return { ...e, fn: go(e.fn, active), arg: go(e.arg, active) }
      case 'lambda':
        return { ...e, body: go(e.body, restrict(active, [e.param])) }
      case 'let': {
        const av = e.recursive ? restrict(active, [e.name]) : active
        const ab = restrict(active, [e.name])
        return { ...e, value: go(e.value, av), body: go(e.body, ab) }
      }
      case 'letrec': {
        const a = restrict(active, e.bindings.map((b) => b.name))
        return {
          ...e,
          bindings: e.bindings.map((b) => ({ name: b.name, value: go(b.value, a) })),
          body: go(e.body, a),
        }
      }
      case 'if':
        return { ...e, cond: go(e.cond, active), then: go(e.then, active), else: go(e.else, active) }
      case 'binop':
        return { ...e, left: go(e.left, active), right: go(e.right, active) }
      case 'unop':
        return { ...e, operand: go(e.operand, active) }
      case 'seq':
        return { ...e, first: go(e.first, active), rest: go(e.rest, active) }
      case 'list':
      case 'tuple':
        return { ...e, elements: e.elements.map((el) => go(el, active)) }
      case 'record':
        return { ...e, fields: e.fields.map((f) => ({ label: f.label, value: go(f.value, active) })) }
      case 'recordUpdate':
        return {
          ...e,
          record: go(e.record, active),
          fields: e.fields.map((f) => ({ label: f.label, value: go(f.value, active) })),
        }
      case 'match':
        return {
          ...e,
          scrutinee: go(e.scrutinee, active),
          cases: e.cases.map((c) => {
            const bound = new Set<string>()
            patternVars(c.pattern, bound)
            const a = restrict(active, bound)
            return {
              pattern: c.pattern,
              guard: c.guard ? go(c.guard, a) : undefined,
              body: go(c.body, a),
            }
          }),
        }
      case 'typedecl':
        return { ...e, body: go(e.body, active) }
      case 'classdecl':
        return { ...e, body: go(e.body, active) }
      case 'instancedecl':
        return {
          ...e,
          methods: e.methods.map((m) => ({ ...m, value: go(m.value, active) })),
          body: go(e.body, active),
        }
      default:
        return e
    }
  }
  return { expr: go(body, chosen), n }
}

function scalarReplaceRecord(e: Extract<Expr, { kind: 'let' }>, bump: Bump): Expr | null {
  const rec = e.value
  if (rec.kind !== 'record' || rec.fields.length === 0) return null
  const x = e.name
  const { proj, whole } = classifyRecordUses(x, e.body)
  if (proj.size === 0) return null // nothing projected — leave it for dead-let/inlining

  // The record can be fully dissolved only when `x` is *never* used whole and every
  // field is eligible (atom, or a value projected ≤ once) — then substituting all
  // projections leaves `x` dead and the allocation is dropped. That gate also makes
  // non-atom field substitution monotone (the closure moves rather than duplicating).
  const allInlinable = rec.fields.every(
    (f) => isAtom(f.value) || (isValue(f.value) && (proj.get(f.label) ?? 0) <= 1),
  )
  const fullElim = whole === 0 && allInlinable

  const chosen = new Map<string, Expr>()
  const fvByLabel = new Map<string, Set<string>>()
  for (const f of rec.fields) {
    const count = proj.get(f.label) ?? 0
    if (count === 0) continue
    const eligible = isAtom(f.value) || (fullElim && isValue(f.value) && count <= 1)
    if (!eligible) continue
    chosen.set(f.label, f.value)
    fvByLabel.set(f.label, freeVars(f.value))
  }
  if (chosen.size === 0) return null

  const { expr: newBody, n } = substProjections(x, chosen, fvByLabel, e.body)
  if (n === 0) return null
  for (let i = 0; i < n; i++) bump('sroa')

  const remaining = countUses(x, newBody)
  const eliminated = remaining === 0 && isPure(rec)
  SROAS.push({ record: x, fields: [...chosen.keys()], sites: n, eliminated })
  // Record fully dead and pure ⇒ drop the allocation outright; otherwise keep the
  // binding (it is still used whole, or carries an effect) with its projections
  // devirtualized. Either way the rewrite has fired and strictly removed work.
  return eliminated ? newBody : { ...e, body: newBody }
}

// ---------------------------------------------------------------------------
// Call-site inlining of non-recursive functions (Aether 15.0)
// ---------------------------------------------------------------------------
//
// The single-use inliner above copies a function whose binding is used exactly
// once. This pass lifts that cap for *small, non-recursive* functions: it copies
// the body into every **saturated** call site (an application spine `f e1 … ek`
// of at least the lambda's arity `k`), while leaving partial applications and
// bare-`var` escapes pointing at a single retained closure. The three-step
// rewrite leans on the module's proven capture-avoiding machinery:
//
//   1. `markHeads` rewrites each saturated call-spine head `f` to a globally
//      fresh placeholder `inl$…`, leaving every other `f` occurrence untouched
//      (it stops at any binder that re-binds `f`, so inner shadows are safe);
//   2. `rename` renames the surviving (escape) `f` occurrences to a fresh `alt`;
//   3. `subst` replaces the placeholders with the lambda — and because `subst`
//      freshens any binder on the path that would capture one of the lambda's
//      free variables, the inlined copies denote exactly what the call did.
//
// If an escape remains, the lambda is re-bound to `alt` (one closure for all the
// escapes); if not, the function is fully inlined and no closure is ever built.

/** The head and ordered argument spine of a (possibly empty) application chain.
 *  `f a b` ⇒ `{ head: var f, args: [a, b] }`; a non-app ⇒ `{ head: e, args: [] }`. */
function appSpine(e: Expr): { head: Expr; args: Expr[] } {
  const args: Expr[] = []
  let cur: Expr = e
  while (cur.kind === 'app') {
    args.unshift(cur.arg)
    cur = cur.fn
  }
  return { head: cur, args }
}

/** Rewrite each saturated call-spine head `name e1 … e_arity …` to `var ph`,
 *  counting the rewrites, and leaving every other (escaping / partial) occurrence
 *  of `name` in place. Stops at any binder that shadows `name`. */
function markHeads(
  name: string,
  ph: string,
  arity: number,
  e: Expr,
  counter: { n: number },
): Expr {
  if (!freeVars(e).has(name)) return e
  const rec = (x: Expr): Expr => markHeads(name, ph, arity, x, counter)
  switch (e.kind) {
    case 'app': {
      const { head, args } = appSpine(e)
      if (head.kind === 'var' && head.name === name && args.length >= arity) {
        counter.n++
        let out: Expr = { kind: 'var', name: ph, span: head.span }
        for (const a of args) out = { kind: 'app', fn: out, arg: rec(a), span: e.span }
        return out
      }
      return { ...e, fn: rec(e.fn), arg: rec(e.arg) }
    }
    case 'var':
      return e // a bare escape occurrence — left for `rename` to redirect
    case 'lambda':
      return e.param === name ? e : { ...e, body: rec(e.body) }
    case 'let': {
      const value = e.recursive && e.name === name ? e.value : rec(e.value)
      const body = e.name === name ? e.body : rec(e.body)
      return { ...e, value, body }
    }
    case 'letrec':
      if (e.bindings.some((b) => b.name === name)) return e
      return {
        ...e,
        bindings: e.bindings.map((b) => ({ name: b.name, value: rec(b.value) })),
        body: rec(e.body),
      }
    case 'match':
      return {
        ...e,
        scrutinee: rec(e.scrutinee),
        cases: e.cases.map((c) => {
          const bound = new Set<string>()
          patternVars(c.pattern, bound)
          if (bound.has(name)) return c
          return { pattern: c.pattern, guard: c.guard ? rec(c.guard) : undefined, body: rec(c.body) }
        }),
      }
    case 'typedecl':
      return e.ctors.some((c) => c.name === name) ? e : { ...e, body: rec(e.body) }
    default:
      return mapAllChildren(e, rec)
  }
}

/** Inline `name = lam` into its saturated call sites within `body`. Returns the
 *  replacement for the whole `let name = lam in body` node, or null if there is no
 *  saturated call to gain from. */
function inlineCallSites(
  name: string,
  lam: Expr,
  body: Expr,
  span: Expr['span'],
  bump: Bump,
): Expr | null {
  const arity = lambdaArity(lam)
  const ph = gensym('inl')
  const counter = { n: 0 }
  const marked = markHeads(name, ph, arity, body, counter)
  if (counter.n === 0) return null // nothing saturated to inline — skip (no win)

  const alt = gensym(name)
  const escaped = rename(name, alt, marked)
  let out = subst(ph, lam, escaped)
  const escapes = countUses(alt, out)
  if (escapes > 0) {
    out = { kind: 'let', name: alt, value: lam, body: out, recursive: false, span }
  }
  for (let i = 0; i < counter.n; i++) bump('inline-fn')
  INLINES.push({ name, sites: counter.n, size: size(lam), escaped: escapes > 0 })
  // Freshen every node's identity (`subst` shares the lambda object across the
  // inlined sites), so the identity-keyed passes that run later stay sound.
  return cloneExpr(out)
}

// ---------------------------------------------------------------------------
// Static-argument transformation (Aether 17.0)
// ---------------------------------------------------------------------------
//
// The classic GHC pass (Santos 1995; Peyton Jones & Santos, "A transformation-
// based optimiser for Haskell", 1998). A *recursive* function often threads an
// argument through its loop completely unchanged — the canonical example is the
// function argument of a recursive `map`/`filter`/`foldr`:
//
//     let rec map = fn f -> fn xs ->
//       match xs with [] -> [] | x :: t -> f x :: map f t
//
// Here `f` is **static**: every recursive call `map f t` passes it *as itself*.
// Threading it round the loop is pure overhead — each iteration re-binds and
// re-passes a value that never moves. SAT splits the function into a thin outer
// **wrapper** that binds the static parameters once and an inner **worker loop**
// that recurses on only the *dynamic* arguments, capturing the static ones as
// free variables of its closure:
//
//     let map = fn f -> fn xs ->                 -- wrapper: binds the static `f`
//       let rec go = fn xs ->                    -- worker: recurses on `xs` only
//         match xs with [] -> [] | x :: t -> f x :: go t   -- `f` is now FREE
//       in go xs
//
// The worker's loop now passes one fewer argument per iteration, so the VM step
// count per recursive call falls. Crucially, the wrapper is no longer recursive,
// so once a *known* function flows into a static position (e.g. `map (fn x -> x*2)
// ys`) the existing call-site inliner can copy the wrapper into the call site,
// turning `f` into a literal lambda the loop body can β-reduce — a SpecConstr-like
// specialisation that the greedy passes alone could never reach. Every rewrite is
// re-proved semantics-preserving by the byte-for-byte VM ≡ JS ≡ WASM checks.
//
// Soundness conditions (all conservative):
//   • the binding is a genuinely self-recursive `let rec f = fn p0 … p_{k-1} -> body`;
//   • EVERY free occurrence of `f` in `body` is a *saturated* call (spine of ≥ k
//     args) — a bare or partially-applied `f` would escape and is left untouched
//     (we simply decline to transform);
//   • a position is *static* only if every recursive call passes exactly `var p_i`
//     there AND `p_i` is not shadowed at that call site (so the variable really is
//     the parameter, not an inner rebinding);
//   • at least one static AND one dynamic parameter remain (a loop with no varying
//     argument is left alone — there is nothing to recurse on to lift it past).

function staticArgumentTransform(
  e: Extract<Expr, { kind: 'let' }>,
  bump: Bump,
): Expr | null {
  const f = e.name
  // Peel the curried parameters off the recursive value.
  const params: string[] = []
  let cur: Expr = e.value
  while (cur.kind === 'lambda') {
    params.push(cur.param)
    cur = cur.body
  }
  const body0 = cur
  const k = params.length
  if (k === 0) return null
  if (new Set(params).size !== k) return null // duplicate params: bail (rare)
  if (!freeVars(body0).has(f)) return null // not actually recursive in the body

  // Pass 1 — analyse: classify each position static/dynamic and verify that
  // every recursive occurrence of `f` is a saturated call (otherwise it escapes).
  const staticMask = params.map(() => true)
  let eligible = true
  let calls = 0
  const scan = (node: Expr, scope: Set<string>): void => {
    if (!eligible) return
    if (node.kind === 'var') {
      if (node.name === f && !scope.has(f)) eligible = false // bare escape
      return
    }
    if (node.kind === 'app') {
      const sp = spineHead(node)
      if (sp && sp.name === f && !scope.has(f)) {
        if (sp.args.length < k) {
          eligible = false // partial application — `f` escapes under-saturated
          return
        }
        calls++
        for (let i = 0; i < k; i++) {
          const a = sp.args[i]
          const isStatic = a.kind === 'var' && a.name === params[i] && !scope.has(params[i])
          if (!isStatic) staticMask[i] = false
        }
        for (const a of sp.args) scan(a, scope) // arguments only; head chain is `f`
        return
      }
    }
    for (const c of scopedChildren(node, true, scope)) scan(c.child, c.bound)
  }
  scan(body0, new Set())

  if (!eligible || calls === 0) return null
  const staticIdx = staticMask.flatMap((s, i) => (s ? [i] : []))
  const dynamicIdx = staticMask.flatMap((s, i) => (s ? [] : [i]))
  if (staticIdx.length === 0 || dynamicIdx.length === 0) return null

  // Pass 2 — rewrite. Rename the dynamic parameters to fresh names inside the
  // worker (so the worker's loop variables never collide with the wrapper's
  // identically-named parameters), then redirect every recursive call to the
  // worker, dropping the static arguments.
  const worker = gensym('sat')
  const dynFresh = dynamicIdx.map((i) => gensym(params[i]))
  let bodyR: Expr = body0
  dynamicIdx.forEach((i, j) => {
    bodyR = rename(params[i], dynFresh[j], bodyR)
  })

  const rw = (node: Expr, scope: Set<string>): Expr => {
    if (node.kind === 'app') {
      const sp = spineHead(node)
      if (sp && sp.name === f && !scope.has(f)) {
        // dynamic arguments (recursively rewritten) + any over-application tail
        const passed: Expr[] = []
        dynamicIdx.forEach((i) => passed.push(rw(sp.args[i], scope)))
        for (let i = k; i < sp.args.length; i++) passed.push(rw(sp.args[i], scope))
        let call: Expr = { kind: 'var', name: worker, span: node.span }
        for (const a of passed) call = { kind: 'app', fn: call, arg: a, span: node.span }
        return call
      }
    }
    return mapChildrenScoped(node, scope, rw)
  }
  // The recursive-call args reference the *renamed* dynamic params, so `worker`'s
  // scope must shield those fresh names from being treated as the original `f`.
  const workerBody = rw(bodyR, new Set())

  // Build the worker loop: `let rec go = fn d0 … dm -> workerBody in go d0 … dm`.
  const span = e.span
  let loop: Expr = workerBody
  for (let j = dynFresh.length - 1; j >= 0; j--) {
    loop = { kind: 'lambda', param: dynFresh[j], body: loop, span }
  }
  let seed: Expr = { kind: 'var', name: worker, span }
  for (const i of dynamicIdx) seed = { kind: 'app', fn: seed, arg: { kind: 'var', name: params[i], span }, span }
  const inner: Expr = { kind: 'let', name: worker, value: loop, body: seed, recursive: true, span }

  // Wrap it back under the original parameters → the public `f` keeps its arity.
  let wrapper: Expr = inner
  for (let i = k - 1; i >= 0; i--) {
    wrapper = { kind: 'lambda', param: params[i], body: wrapper, span }
  }

  bump('sat')
  SATS.push({
    name: f,
    arity: k,
    static: staticIdx.map((i) => params[i]),
    dynamic: dynamicIdx.map((i) => params[i]),
    calls,
  })
  // Fresh identities everywhere — later identity-keyed passes (CSE/GVN) stay sound.
  return cloneExpr({ ...e, recursive: false, value: wrapper, body: e.body })
}

// ---------------------------------------------------------------------------
// Call-pattern specialisation — SpecConstr (Aether 23.0)
// ---------------------------------------------------------------------------
//
// The other half of GHC's loop-specialisation toolkit (Peyton Jones, "Call-
// pattern specialisation for Haskell programs", ICFP 2007). The 17.0 static-
// argument transform lifts a loop-invariant *argument* out of a recursive loop;
// SpecConstr attacks the dual waste — a loop-*varying* argument that is rebuilt
// as the *same constructor / tuple shape* on every iteration only to be taken
// straight back apart by the function's own `match`:
//
//     let rec go = fn st -> fn i ->                 -- threads a 2-tuple accumulator
//       match st with (s, p) ->
//         if i == 0 then (s, p)
//         else go (s + i, p * i) (i - 1)            -- ALLOCATES a fresh (·,·) each turn…
//     in go (0, 1) 10                               -- …only for `match st` to rip it apart
//
// Every iteration boxes `(s + i, p * i)` into a heap tuple and the next call's
// `match` immediately unboxes it: pure alloc-then-project churn. SpecConstr
// *specialises `go` for that call pattern* — it recurses on the tuple's two
// *fields* directly, so the cell is never built and the `match` never runs:
//
//     let rec go' = fn s -> fn p -> fn i ->         -- worker over the unpacked fields
//       let st = (s, p) in                          -- the whole value, rebuilt at most once…
//       match st with (s, p) -> …                   -- …and only where `go` used `st` *whole*
//     in go' 0 1 10                                 -- seed unpacked too: no entry tuple
//
// The reconstruction `let st = (s, p) in …` is the load-bearing trick: because we
// only fire when `st` is used *exactly once* — as that `match` scrutinee — the
// single-use value inliner copies the literal tuple onto the `match`, the 11.0
// known-constructor rule fires (`match (s, p) with (s, p) -> …` ⇒ the body, no
// cell, no test), and the whole box/unbox pair evaporates. We emit only ordinary
// core and lean on machinery the middle-end already proves correct, exactly as
// SAT does, so the VM, JS and WASM backends compile the result unchanged and the
// byte-for-byte equivalence checks re-prove the answer never moved.
//
// Soundness & the never-increase-steps invariant (all conservative):
//   • `f` is a genuinely self-recursive `let rec f = fn p0 … p_{k-1} -> body`,
//     *immediately driven* by its own `in`-expression — a single saturated call
//     `f s0 … s_{k-1}` (the SAT-style seed). A use of `f` anywhere else, or a
//     non-call driver, is out of scope (we decline) — this keeps the rewrite a
//     whole-loop replacement that needs no fallback wrapper;
//   • EVERY free occurrence of `f` in `body` is a *saturated* call (a bare or
//     partial `f` escapes — we decline), mirroring SAT's escape analysis;
//   • some slot `j` carries the SAME shape (a tuple of fixed arity, or one fixed
//     constructor) at the seed AND at every recursive call — so `p_j` is *always*
//     that shape at run time and rebuilding it from its fields is exactly equal;
//   • `p_j` is consumed *exactly once*, as that shape's destructuring `match`
//     scrutinee — so the rebuilt cell is single-use (inlined, then the match
//     folds away) and is rebuilt **no more often than it was allocated before**.
//     A value used twice, or kept whole, is left for a future worker/wrapper pass.
// Hence steps(optimized) ≤ steps(unoptimized) by construction: the per-iteration
// allocation and projection are removed and nothing is ever duplicated or moved.

type ScShape =
  | { kind: 'tuple'; arity: number }
  | { kind: 'con'; name: string; arity: number }

/** Read `e` as a fixed-shape construction (a tuple, or a saturated constructor
 *  application), returning the shape and its field expressions — else null. */
function scShapeOf(e: Expr): { shape: ScShape; fields: Expr[] } | null {
  if (e.kind === 'tuple' && e.elements.length >= 1) {
    return { shape: { kind: 'tuple', arity: e.elements.length }, fields: e.elements }
  }
  const c = ctorAppHead(e)
  if (c && c.args.length >= 1) {
    return { shape: { kind: 'con', name: c.name, arity: c.args.length }, fields: c.args }
  }
  return null
}

function scSameShape(a: ScShape, b: ScShape): boolean {
  if (a.kind === 'tuple' && b.kind === 'tuple') return a.arity === b.arity
  if (a.kind === 'con' && b.kind === 'con') return a.name === b.name && a.arity === b.arity
  return false
}

/** Does `name`'s sole free occurrence in `body` sit as the scrutinee of a `match`
 *  whose arms actually *destructure* `shape` (a `ptuple`/`pcon` of the right
 *  arity / constructor)? That is the case SpecConstr can melt: unpacking the
 *  fields lets the rebuilt cell inline onto the match and the projection vanish.
 *  A bare `pvar`/`pwild` scrutinee would only rebind the whole value — no win —
 *  so it is rejected. Shadowing binders cut the search. */
function scSoleDestructure(name: string, body: Expr, shape: ScShape): boolean {
  let ok = false
  const destructures = (p: Pattern): boolean =>
    shape.kind === 'tuple'
      ? p.kind === 'ptuple' && p.elements.length === shape.arity
      : p.kind === 'pcon' && p.name === shape.name && p.args.length === shape.arity
  const go = (x: Expr, scope: Set<string>): void => {
    if (scope.has(name)) return
    if (
      x.kind === 'match' &&
      x.scrutinee.kind === 'var' &&
      x.scrutinee.name === name &&
      x.cases.some((c) => destructures(c.pattern))
    ) {
      ok = true
    }
    for (const c of scopedChildren(x, true, scope)) go(c.child, c.bound)
  }
  go(body, new Set())
  return ok
}

function scBuildApp(head: Expr, args: Expr[], span: Expr['span']): Expr {
  let out = head
  for (const a of args) out = { kind: 'app', fn: out, arg: a, span }
  return out
}

function specConstr(e: Extract<Expr, { kind: 'let' }>, bump: Bump): Expr | null {
  const f = e.name

  // The driver: `in <body>` must be a single saturated self-call `f s0 … s_{k-1}`
  // (the immediately-driven loop — the same shape SAT seeds). A non-call driver,
  // an over-application, or a second use of `f` here is out of scope for v1.
  const drive = spineHead(e.body)
  if (!drive || drive.name !== f) return null
  if (countUses(f, e.body) !== 1) return null

  // Peel the curried parameters off the recursive value.
  const params: string[] = []
  let cur: Expr = e.value
  while (cur.kind === 'lambda') {
    params.push(cur.param)
    cur = cur.body
  }
  const body0 = cur
  const k = params.length
  if (k === 0) return null
  if (new Set(params).size !== k) return null // duplicate params: bail (rare)
  if (drive.args.length !== k) return null // driver must saturate `f` exactly
  if (!freeVars(body0).has(f)) return null // not actually recursive in the body

  // Pass 1 — collect, per slot, the argument every recursive call passes, and
  // verify each occurrence of `f` is a saturated call (otherwise it escapes).
  let eligible = true
  let calls = 0
  const argsBySlot: Expr[][] = params.map(() => [])
  const scan = (node: Expr, scope: Set<string>): void => {
    if (!eligible) return
    if (node.kind === 'var') {
      if (node.name === f && !scope.has(f)) eligible = false // bare escape
      return
    }
    if (node.kind === 'app') {
      const sp = spineHead(node)
      if (sp && sp.name === f && !scope.has(f)) {
        if (sp.args.length < k) {
          eligible = false // partial application — `f` escapes under-saturated
          return
        }
        calls++
        for (let i = 0; i < k; i++) argsBySlot[i].push(sp.args[i])
        for (const a of sp.args) scan(a, scope) // arguments only; head chain is `f`
        return
      }
    }
    for (const c of scopedChildren(node, true, scope)) scan(c.child, c.bound)
  }
  scan(body0, new Set())
  if (!eligible || calls === 0) return null

  // Pass 2 — pick a slot whose seed and every recursive argument share one shape,
  // and whose parameter is consumed by exactly that one destructuring `match`.
  let chosen: { j: number; shape: ScShape } | null = null
  for (let j = 0; j < k; j++) {
    const seed = scShapeOf(drive.args[j])
    if (!seed) continue
    let uniform = true
    for (const a of argsBySlot[j]) {
      const s = scShapeOf(a)
      if (!s || !scSameShape(s.shape, seed.shape)) {
        uniform = false
        break
      }
    }
    if (!uniform) continue
    if (countUses(params[j], body0) !== 1) continue
    if (!scSoleDestructure(params[j], body0, seed.shape)) continue
    chosen = { j, shape: seed.shape }
    break
  }
  if (!chosen) return null
  const { j, shape } = chosen
  const m = shape.arity
  const span = e.span

  // Pass 3 — rewrite. The specialised worker `g` takes the `m` unpacked fields
  // (fresh names, so they can never collide with anything in `body0`) in slot
  // `j`'s place, followed by the surviving parameters in their original order.
  const g = gensym('spec')
  const fieldVars = Array.from({ length: m }, () => gensym('scf'))
  const others = params.filter((_, i) => i !== j)
  const rebuild = (): Expr => {
    const vs: Expr[] = fieldVars.map((n) => ({ kind: 'var', name: n, span }))
    return shape.kind === 'tuple'
      ? { kind: 'tuple', elements: vs, span }
      : scBuildApp({ kind: 'var', name: shape.name, span }, vs, span)
  }

  // Redirect every saturated recursive call to `g`, passing slot `j`'s shape
  // *fields* in place of the boxed cell and the surviving arguments after them.
  const rw = (node: Expr, scope: Set<string>): Expr => {
    if (node.kind === 'app') {
      const sp = spineHead(node)
      if (sp && sp.name === f && !scope.has(f)) {
        const sh = scShapeOf(sp.args[j])! // uniform check above guarantees a shape
        const passed: Expr[] = []
        for (const h of sh.fields) passed.push(rw(h, scope))
        for (let i = 0; i < k; i++) if (i !== j) passed.push(rw(sp.args[i], scope))
        for (let i = k; i < sp.args.length; i++) passed.push(rw(sp.args[i], scope)) // tail
        return scBuildApp({ kind: 'var', name: g, span: node.span }, passed, node.span)
      }
    }
    return mapChildrenScoped(node, scope, rw)
  }
  const body0rw = rw(body0, new Set())

  // Reconstruct `p_j` from its fields at the worker's head — used exactly once,
  // so the single-use value inliner copies it onto the `match` and the 11.0
  // known-constructor rule then deletes both the cell and the projection.
  const inner: Expr = { kind: 'let', name: params[j], value: rebuild(), body: body0rw, recursive: false, span }
  let lam: Expr = inner
  const gParams = [...fieldVars, ...others]
  for (let p = gParams.length - 1; p >= 0; p--) {
    lam = { kind: 'lambda', param: gParams[p], body: lam, span }
  }

  // Seed the worker with the entry shape unpacked too — no tuple is built to enter.
  const seedShape = scShapeOf(drive.args[j])!
  const seedArgs: Expr[] = []
  for (const h of seedShape.fields) seedArgs.push(h)
  for (let i = 0; i < k; i++) if (i !== j) seedArgs.push(drive.args[i])
  for (let i = k; i < drive.args.length; i++) seedArgs.push(drive.args[i])
  const driver = scBuildApp({ kind: 'var', name: g, span }, seedArgs, span)

  bump('specconstr')
  SPECCONSTRS.push({
    name: f,
    shape:
      shape.kind === 'tuple' ? `(${Array.from({ length: m }, () => '·').join(', ')})` : shape.name,
    arity: m,
    param: params[j],
    calls,
  })
  // Fresh identities everywhere — later identity-keyed passes (CSE/GVN) stay sound.
  return cloneExpr({ kind: 'let', name: g, value: lam, body: driver, recursive: true, span })
}

// ---------------------------------------------------------------------------
// Float-in (let-floating inward) — Aether 19.0
// ---------------------------------------------------------------------------
//
// The dual of the 14.0 global value-numbering pass. GVN floats a pure expression
// *up* to a dominating binder so it is computed once and *shared* by the ≥ 2
// guaranteed evaluations below it (steps fall: no recomputation). Float-in floats
// a pure binding *down* — to the smallest subexpression of its body that dominates
// all of its uses — so when that subexpression sits behind a conditional, every
// run that takes the *other* branch skips the binding's work entirely (steps fall:
// no speculation). Together they place each pure `let` at exactly the scope its
// uses demand: no higher (which would speculate), no lower (which, past a `λ`,
// would recompute).
//
// Classic motivation (Peyton Jones, Partain & Santos, "Let-floating: moving
// bindings to give faster programs", ICFP 1996):
//
//     let h = <expensive, pure> in       =>     if c then (let h = <expensive> in h + h)
//     if c then h + h else 0                    else 0
//
// In a *strict* language the left form always evaluates `<expensive>`; the right
// only evaluates it when `c` is true. The win is real and the rewrite emits
// ordinary core, so the VM, JS and WASM backends compile it unchanged and the
// byte-for-byte equivalence checks re-prove the answer never moved.
//
// Soundness & the never-increase-steps invariant (all conservative):
//   • only a **pure** binding moves (`isPure`): it has no observable effect and
//     terminates, so delaying or skipping its evaluation is invisible in a strict
//     language — no effect is lost, no divergence introduced;
//   • the binding is sunk only through positions evaluated **at most once** per
//     evaluation of the host (`if`/`match` arms & guards, `&&`/`||` right operands,
//     `let`/`seq` sub-positions — every child `scopedChildren` exposes) — it is
//     **never** pushed inside a `λ` body, whose work would multiply by call count;
//   • it is sunk only to a child that is the **sole** user of the binder, so the
//     value is never duplicated (it stays evaluated ≤ once on any path);
//   • it is committed only when the sink path **crosses a conditional** — i.e. the
//     binding ends up somewhere not guaranteed to run — so every float-in is a
//     strict potential win and the pass never churns the AST for a no-op move;
//   • capture is impossible: a step into a position that binds a free variable of
//     the moved value (a `λ` param or `match` pattern var), or that re-binds the
//     binder itself, ends the descent before that binder is crossed.
// Hence steps(optimized) ≤ steps(unoptimized) by construction.

/** Sink `let name = value in <host>` as deep into `host` as is legal, returning the
 *  rewritten host, whether the chosen path crossed a conditionally-evaluated
 *  position (the gate that makes the move a win), and the kind of construct the
 *  binding finally landed inside. Returns null when the binding cannot move at
 *  least one level deeper (its uses span >1 child, or the sole user is unenterable). */
function sinkBinding(
  name: string,
  value: Expr,
  valueFv: Set<string>,
  host: Expr,
): { expr: Expr; crossed: boolean; landedIn: string } | null {
  // Never push a binding inside a `λ` body: it would be re-evaluated per call.
  if (host.kind === 'lambda') return null
  const kids = scopedChildren(host, true, new Set())
  // The binder must be free in exactly one child (its sole dominated user).
  let idx = -1
  for (let i = 0; i < kids.length; i++) {
    if (freeVars(kids[i].child).has(name)) {
      if (idx >= 0) return null // used in two siblings — `host` itself is the dominator
      idx = i
    }
  }
  if (idx < 0) return null
  const p = kids[idx]
  if (p.bound.has(name)) return null // the sole user re-binds `name` (shadow)
  for (const fv of valueFv) if (p.bound.has(fv)) return null // would capture a free var
  const deeper = sinkBinding(name, value, valueFv, p.child)
  const newChild: Expr = deeper
    ? deeper.expr
    : { kind: 'let', name, value, body: p.child, recursive: false, span: value.span }
  const crossed = (deeper?.crossed ?? false) || !p.guaranteed
  const landedIn = deeper ? deeper.landedIn : host.kind
  return { expr: replaceScopedChild(host, idx, newChild), crossed, landedIn }
}

/** Rebuild `host` with its `idx`-th scoped child (in `scopedChildren` order, which
 *  `mapChildrenScoped` walks identically) replaced by `repl`. */
function replaceScopedChild(host: Expr, idx: number, repl: Expr): Expr {
  let i = 0
  return mapChildrenScoped(host, new Set(), (child) => (i++ === idx ? repl : child))
}

// ---------------------------------------------------------------------------
// Dead-argument elimination — Aether 20.0
// ---------------------------------------------------------------------------
//
// A parameter is worth nothing if its value can never affect the answer. Two
// shapes qualify, and this pass drops both — from the function *and* from every
// saturated call site, so the closure shrinks and each call (and each loop
// iteration) passes one fewer argument:
//
//   1. an **unused parameter** — `p` never appears in the body at all (the call-
//      back that ignores an argument, an interface-conformance slot). The 15.0
//      inliner already melts these for small non-recursive helpers, but it cannot
//      touch a recursive function — this pass can.
//
//   2. a **useless accumulator** — `p` is referenced only inside the argument the
//      function passes to *its own* slot `p` in a recursive call, and nowhere else.
//      Its value is a pure dataflow dead-end: it is computed every iteration purely
//      to be fed back into the next iteration's copy of itself, never reaching the
//      result. The canonical example is a counter or sum threaded round a loop and
//      then thrown away:
//
//        let rec go = fn dead -> fn n ->                 let rec go = fn n ->
//          if n == 0 then 100                       =>     if n == 0 then 100
//          else go (dead + n) (n - 1) in                   else go (n - 1) in
//        go 0 200                                        go 200
//
//      The `dead + n` addition — run once per iteration for nothing — disappears.
//
// Both are detected the same way: strip every self-call's slot-`i` argument to a
// constant and ask whether `p_i` still occurs. If not, `p_i` only ever fed itself
// (or was wholly unused), so dropping it is sound — provided every dropped argument
// (at self-calls and at the outer entry calls) is **pure**, so not evaluating it
// loses no effect. Like SAT, the pass fires only on a single self-recursive (or
// plain) `let` binding whose every free occurrence is a *saturated* call (an escape
// or partial application means the arity is observed, so we decline), and it keeps
// at least one parameter. It emits ordinary core, re-proved by the VM ≡ JS ≡ WASM
// equivalence checks; dropping a pure computation can only lower the VM step count.

function deadArgumentElim(e: Extract<Expr, { kind: 'let' }>, bump: Bump): Expr | null {
  const f = e.name
  const params: string[] = []
  let cur: Expr = e.value
  while (cur.kind === 'lambda') {
    params.push(cur.param)
    cur = cur.body
  }
  const body0 = cur
  const k = params.length
  if (k < 2) return null // must retain ≥ 1 parameter after dropping one
  if (new Set(params).size !== k) return null // duplicate params: bail (rare)

  // Pass 1 — eligibility: every free occurrence of `f` (in the recursive value and
  // in the let body) must be a *saturated* call, else `f`'s arity is observed and we
  // cannot change it. Collect, per position, the argument expressions at every call.
  let eligible = true
  const argsAt: Expr[][] = params.map(() => [])
  const scan = (node: Expr, scope: Set<string>): void => {
    if (!eligible) return
    if (node.kind === 'var') {
      if (node.name === f && !scope.has(f)) eligible = false // bare escape
      return
    }
    if (node.kind === 'app') {
      const sp = spineHead(node)
      if (sp && sp.name === f && !scope.has(f)) {
        if (sp.args.length < k) {
          eligible = false // partial application — arity observed
          return
        }
        for (let i = 0; i < k; i++) argsAt[i].push(sp.args[i])
        for (const a of sp.args) scan(a, scope)
        return
      }
    }
    for (const c of scopedChildren(node, true, scope)) scan(c.child, c.bound)
  }
  if (e.recursive) scan(body0, new Set())
  scan(e.body, new Set())
  if (!eligible) return null

  // Pass 2 — find the first droppable parameter. `p_i` is dead iff, after stripping
  // every self-call's slot-`i` argument out of the body, `p_i` no longer occurs (so
  // its only uses, if any, were feeding its own recursive position); and every
  // argument ever passed in slot `i` is pure (so dropping its evaluation is invisible).
  let dropIdx = -1
  for (let i = 0; i < k; i++) {
    if (!argsAt[i].every(isPure)) continue
    const stripped = e.recursive ? stripSlot(f, i, k, body0, new Set()) : body0
    if (countUses(params[i], stripped) === 0) {
      dropIdx = i
      break
    }
  }
  if (dropIdx < 0) return null

  // Pass 3 — rewrite: drop param `dropIdx` from the lambda and the matching argument
  // from every saturated call site.
  const rw = (node: Expr, scope: Set<string>): Expr => {
    if (node.kind === 'app') {
      const sp = spineHead(node)
      if (sp && sp.name === f && !scope.has(f)) {
        let call: Expr = { kind: 'var', name: f, span: node.span }
        sp.args.forEach((a, i) => {
          if (i === dropIdx) return // drop this argument (proven pure)
          call = { kind: 'app', fn: call, arg: rw(a, scope), span: node.span }
        })
        return call
      }
    }
    return mapChildrenScoped(node, scope, rw)
  }
  const newInner = e.recursive ? rw(body0, new Set()) : body0
  let lam: Expr = newInner
  for (let i = k - 1; i >= 0; i--) {
    if (i === dropIdx) continue
    lam = { kind: 'lambda', param: params[i], body: lam, span: e.span }
  }
  const newBody = rw(e.body, new Set())

  bump('dead-param')
  DEADPARAMS.push({ name: f, dropped: [params[dropIdx]], recursive: e.recursive })
  // Fresh identities everywhere — later identity-keyed passes (CSE/GVN) stay sound.
  return cloneExpr({ ...e, value: lam, body: newBody })
}

/** `body` with every saturated self-call's slot-`i` argument replaced by `unit`,
 *  so a deadness check can ask whether the parameter occurs *outside* its own
 *  recursive feedback. Scope-aware: stops at any binder that shadows `f`. */
function stripSlot(f: string, i: number, k: number, body: Expr, scope: Set<string>): Expr {
  const rec = (node: Expr, sc: Set<string>): Expr => {
    if (node.kind === 'app') {
      const sp = spineHead(node)
      if (sp && sp.name === f && !sc.has(f) && sp.args.length >= k) {
        let call: Expr = { kind: 'var', name: f, span: node.span }
        sp.args.forEach((a, j) => {
          const arg: Expr = j === i ? { kind: 'unit', span: a.span } : rec(a, sc)
          call = { kind: 'app', fn: call, arg, span: node.span }
        })
        return call
      }
    }
    return mapChildrenScoped(node, sc, rec)
  }
  return rec(body, scope)
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

// ---------------------------------------------------------------------------
// Case-of-case — commuting conversions (Aether 21.0)
//
// Push a *strict eliminator* (a `match` scrutinee, a record `.field`
// projection, a strict `binop`/`unop` operand) inward through an `if`/`match`
// *producer* sitting in its evaluated position:
//
//     match (if c then Some x else None) with         if c then x + 1   (Some x reduced)
//       | None   -> 0                          ⇒            else 0       (None    reduced)
//       | Some y -> y + 1
//
// The eliminator is *strict* in its hole, so the producer's chosen branch is
// evaluated either way and the eliminator still runs exactly once — the VM-step
// count is unchanged by the move itself. But every branch now meets the
// eliminator *statically*, so the existing known-match / field-projection /
// const-fold / algebra rules fire on it and the intermediate constructor,
// record or boxed value is never built at all (Peyton Jones & Santos, "A
// transformation-based optimiser for Haskell", 1998 — the case-of-case law).
//
// Two guards keep it sound and profitable:
//   • exposure — it fires only when ≥ 1 producer branch, placed in the hole,
//     immediately reduces via the frame's own local rule, so duplicating the
//     eliminator into the branches always buys a reduction (and the result
//     converges: a reduced branch sheds its producer, a non-reduced one keeps a
//     plain eliminator whose hole is no longer a producer).
//   • capture-avoidance — a `match` producer whose arm binds a variable the
//     eliminator's other parts mention has that binder freshened before the
//     eliminator is moved under the arm (the same freshening `subst` uses).
// Effects are never duplicated or reordered: the eliminator's non-hole parts are
// inert (`match` arms run only when chosen) or proven values (a `binop`'s
// sibling operand), and a short-circuit `&&`/`||` only ever hosts the producer
// in its always-evaluated left operand.

const NOP_BUMP: Bump = () => {}

interface ElimFrame {
  /** the strict, evaluated sub-expression that may hold a producer */
  hole: Expr
  /** rebuild the eliminator with `b` in the hole */
  rebuild: (b: Expr) => Expr
  /** the eliminator's own local reducer — the redex we want each branch to hit */
  reduce: (x: Expr) => Expr | null
  /** free variables of the eliminator's *other* parts (capture set) */
  fv: Set<string>
  /** a short label for the Optimizer panel */
  label: string
}

/** View `e` as a one-hole strict eliminator frame, or null if it isn't one. */
function elimFrame(e: Expr): ElimFrame | null {
  switch (e.kind) {
    case 'match':
      return {
        hole: e.scrutinee,
        rebuild: (b) => ({ ...e, scrutinee: b }),
        reduce: (x) => reduceMatch(x as Extract<Expr, { kind: 'match' }>, NOP_BUMP),
        fv: freeVars({ ...e, scrutinee: { kind: 'unit', span: e.span } }),
        label: 'match',
      }
    case 'field':
      return {
        hole: e.record,
        rebuild: (b) => ({ ...e, record: b }),
        reduce: (x) => reduceField(x as Extract<Expr, { kind: 'field' }>, NOP_BUMP),
        fv: new Set(),
        label: `.${e.label}`,
      }
    case 'unop':
      return {
        hole: e.operand,
        rebuild: (b) => ({ ...e, operand: b }),
        reduce: (x) => reduceUnop(x as Extract<Expr, { kind: 'unop' }>, NOP_BUMP),
        fv: new Set(),
        label: `${e.op}_`,
      }
    case 'binop': {
      // Pick a producer-holding operand whose *sibling* operand is a value, so
      // moving the op under the producer duplicates no work and reorders no
      // effect. For the short-circuit ops `&&`/`||` only the left operand is
      // strict, so only it may host the producer.
      const isProd = (x: Expr): boolean => x.kind === 'if' || x.kind === 'match'
      const rightStrict = e.op !== '&&' && e.op !== '||'
      if (isProd(e.left) && isValue(e.right)) {
        return {
          hole: e.left,
          rebuild: (b) => ({ ...e, left: b }),
          reduce: (x) => reduceBinop(x as Extract<Expr, { kind: 'binop' }>, NOP_BUMP),
          fv: freeVars(e.right),
          label: `_${e.op}`,
        }
      }
      if (isProd(e.right) && rightStrict && isValue(e.left)) {
        return {
          hole: e.right,
          rebuild: (b) => ({ ...e, right: b }),
          reduce: (x) => reduceBinop(x as Extract<Expr, { kind: 'binop' }>, NOP_BUMP),
          fv: freeVars(e.left),
          label: `${e.op}_`,
        }
      }
      return null
    }
    default:
      return null
  }
}

function commute(e: Expr, bump: Bump): Expr | null {
  const frame = elimFrame(e)
  if (!frame) return null
  const prod = frame.hole
  if (prod.kind !== 'if' && prod.kind !== 'match') return null
  const branches = prod.kind === 'if' ? [prod.then, prod.else] : prod.cases.map((c) => c.body)
  if (branches.length === 0) return null

  // exposure gate: at least one branch, in the hole, must immediately reduce.
  let exposed = 0
  for (const b of branches) {
    if (frame.reduce(frame.rebuild(b)) !== null) exposed++
  }
  if (exposed === 0) return null

  const wrap = (b: Expr): Expr => cloneExpr(frame.rebuild(b))
  const out = distributeProducer(prod, frame.fv, wrap)
  bump('case-of-case')
  COMMUTES.push({ frame: frame.label, producer: prod.kind, branches: branches.length, exposed })
  return out
}

/** Rebuild a producer (`if`/`match`) with `wrap` applied to each branch body,
 *  freshening any `match`-arm binder that would capture a free var of the
 *  eliminator (`fv`) being moved under it. */
function distributeProducer(prod: Expr, fv: Set<string>, wrap: (b: Expr) => Expr): Expr {
  if (prod.kind === 'if') {
    return {
      kind: 'if',
      cond: prod.cond,
      then: wrap(prod.then),
      else: wrap(prod.else),
      span: prod.span,
    }
  }
  if (prod.kind === 'match') {
    return {
      ...prod,
      cases: prod.cases.map((c) => {
        let pattern = c.pattern
        let guard = c.guard
        let body = c.body
        const bound = new Set<string>()
        patternVars(c.pattern, bound)
        for (const b of bound) {
          if (fv.has(b)) {
            const fresh = gensym(b)
            pattern = renamePattern(b, fresh, pattern)
            if (guard) guard = rename(b, fresh, guard)
            body = rename(b, fresh, body)
          }
        }
        return { pattern, guard, body: wrap(body) }
      }),
    }
  }
  return prod
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
        // `Math.imul` — exact low-32-bit Int product, matching the VM (`Op.MUL`) and
        // the WASM `i32.mul`; plain `*`/`Math.trunc` rounds past 2^53 and would fold a
        // constant the VM would have wrapped to a different value.
        return { kind: 'int', value: Math.imul(l.value, r.value), span }
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
// Global value numbering — common-subexpression elimination across binders
// (Aether 14.0)
// ---------------------------------------------------------------------------
//
// The bottom-up `tryCse` above only shares an expression among the children on a
// single node's *binder-free strict frontier*. That deliberately misses the most
// valuable redundancy — the same pure work recomputed on either side of a `let`,
// inside a `λ` body, or across a `match` — because handling it needs a *global*
// view: a top-down pass that knows, at each node, which pure values are already
// computed and still in scope. This is that pass: a dominator-style available-
// expressions / value-numbering optimizer.
//
// For a node N it finds a pure, costly expression `s` that
//   (1) is **guaranteed-evaluated ≥ 2 times** within N (so sharing can only *cut*
//       VM steps — the existing step-count invariant the harness enforces), and
//   (2) has every free variable **bound above N** (so N may legally bind it), with
//       no occurrence sitting under a binder that re-binds one of those variables;
// then hoists `s` into a single fresh `let gvn = s in N[every occurrence ↦ gvn]`.
// Occurrences that are only *conditionally* evaluated (a `match`/`if` arm, a `λ`
// body) are replaced too — pure bonus, never a cost, since the value is computed
// once on the mainline regardless. The hoist is:
//   • effect-safe — only effect-free, terminating `s` is ever moved, and moving a
//     pure/total computation earlier on a guaranteed path is observationally
//     invisible in a strict language;
//   • scope- & capture-safe — `s`'s free vars are all in scope at N and the bound
//     name is `$`-fresh, so no variable is captured and none is shadowed; and
//   • non-speculative — the ≥ 2 guaranteed evaluations mean the shared value would
//     have been computed at least twice anyway, so steps never rise.
// Because it emits an ordinary `let`, all three backends compile it unchanged and
// the byte-for-byte equivalence checks re-prove that the answer never changed.

interface GvnGroup {
  nodes: Expr[] // every occurrence (guaranteed and conditional), by identity
  guaranteed: number // how many sit on a guaranteed-evaluation path
  cost: number // minCost of the (shared) expression
}

/** Run the global value-numbering pass to a fixpoint. */
function globalValueNumber(root: Expr, bump: Bump): { expr: Expr; hoists: { expr: string; sites: number }[] } {
  const hoists: { expr: string; sites: number }[] = []
  let expr = root
  for (let round = 0; round < MAX_ROUNDS; round++) {
    let changed = false
    const go = (e: Expr, scope: Set<string>): Expr => {
      const h = tryHoist(e)
      if (h) {
        changed = true
        bump('gvn')
        hoists.push({ expr: truncate(unparse(h.value), 60), sites: h.sites })
        // recurse into the wrapped `let gvn = value in body`
        const value = go(h.value, scope)
        const body = go(h.body, new Set(scope).add(h.name))
        return { kind: 'let', name: h.name, value, body, recursive: false, span: e.span }
      }
      return mapChildrenScoped(e, scope, go)
    }
    expr = go(expr, new Set())
    if (!changed) break
  }
  return { expr, hoists }
}

/** Try a single value-numbering hoist at node `e`. Returns the chosen expression,
 *  its fresh binder name, the rewritten body and the number of replaced sites — or
 *  null if nothing here is worth hoisting. A node qualifies only if its free
 *  variables are all bound *above* `e` (disjoint from names bound inside it), so
 *  binding it to wrap `e` is always in scope. */
function tryHoist(e: Expr): { name: string; value: Expr; body: Expr; sites: number } | null {
  const groups = new Map<string, GvnGroup>()
  const record = (n: Expr, guaranteed: boolean): void => {
    const k = canon(n)
    let g = groups.get(k)
    if (!g) {
      g = { nodes: [], guaranteed: 0, cost: minCost(n) }
      groups.set(k, g)
    }
    g.nodes.push(n)
    if (guaranteed) g.guaranteed++
  }
  // Walk `e`'s descendants (never `e` itself), recording every pure, costly node
  // whose free variables are all bound *above* `e` (disjoint from the names bound
  // on the way down to it) — so it is both hoistable to `e` and denotes the same
  // value wherever it recurs.
  const scan = (n: Expr, guaranteed: boolean, boundInside: Set<string>): void => {
    if (
      isPure(n) &&
      minCost(n) >= COST_THRESHOLD &&
      disjoint(freeVars(n), boundInside)
    ) {
      record(n, guaranteed)
    }
    for (const c of scopedChildren(n, guaranteed, boundInside)) {
      scan(c.child, c.guaranteed, c.bound)
    }
  }
  for (const c of scopedChildren(e, true, new Set())) scan(c.child, c.guaranteed, c.bound)

  // Pick the duplicate group with the largest guaranteed saving. Requiring two
  // *guaranteed* evaluations is what makes the hoist provably non-increasing.
  let best: GvnGroup | null = null
  let bestSaving = 0
  for (const g of groups.values()) {
    if (g.guaranteed < 2) continue
    const saving = (g.guaranteed - 1) * g.cost
    if (saving > bestSaving) {
      bestSaving = saving
      best = g
    }
  }
  if (!best || bestSaving < COST_THRESHOLD) return null

  const value = best.nodes[0]
  const targets = new Set(best.nodes)
  const name = gensym('gvn')
  const body = replaceNodes(e, targets, name)
  return { name, value, body, sites: best.nodes.length }
}

/** Replace every node in `targets` (by identity) with `var name`, rebuilding the
 *  rest of the tree. The fresh `name` is in scope throughout, so this is safe. */
function replaceNodes(e: Expr, targets: Set<Expr>, name: string): Expr {
  const rep = (n: Expr): Expr =>
    targets.has(n) ? { kind: 'var', name, span: n.span } : mapAllChildren(n, rep)
  return rep(e)
}

interface ScopedChild {
  child: Expr
  /** is this child guaranteed-evaluated whenever the parent is (and the parent's
   *  own guaranteed flag held)? */
  guaranteed: boolean
  /** the names bound *inside* the parent that are in scope for this child */
  bound: Set<string>
}

/** The children of `e`, each tagged with whether it stays on a guaranteed-
 *  evaluation path and which freshly-bound names are visible to it. Mirrors the
 *  cost model in `minCost`/`frontierChildren`: an `if`/`match` arm, a `&&`/`||`
 *  right operand and a `λ` body are *not* guaranteed; everything strict is. */
function scopedChildren(e: Expr, guaranteed: boolean, bound: Set<string>): ScopedChild[] {
  const ext = (...names: string[]): Set<string> => {
    if (names.length === 0) return bound
    const s = new Set(bound)
    for (const n of names) s.add(n)
    return s
  }
  const G = (child: Expr): ScopedChild => ({ child, guaranteed, bound })
  const C = (child: Expr, b = bound): ScopedChild => ({ child, guaranteed: false, bound: b })
  switch (e.kind) {
    case 'lambda':
      return [C(e.body, ext(e.param))]
    case 'app':
      return [G(e.fn), G(e.arg)]
    case 'let': {
      const inner = ext(e.name)
      return [
        { child: e.value, guaranteed, bound: e.recursive ? inner : bound },
        { child: e.body, guaranteed, bound: inner },
      ]
    }
    case 'letrec': {
      const inner = ext(...e.bindings.map((b) => b.name))
      return [
        ...e.bindings.map((b) => ({ child: b.value, guaranteed, bound: inner })),
        { child: e.body, guaranteed, bound: inner },
      ]
    }
    case 'if':
      return [G(e.cond), C(e.then), C(e.else)]
    case 'binop':
      return e.op === '&&' || e.op === '||' ? [G(e.left), C(e.right)] : [G(e.left), G(e.right)]
    case 'unop':
      return [G(e.operand)]
    case 'seq':
      return [G(e.first), G(e.rest)]
    case 'tuple':
    case 'list':
      return e.elements.map(G)
    case 'record':
      return e.fields.map((f) => G(f.value))
    case 'recordUpdate':
      return [G(e.record), ...e.fields.map((f) => G(f.value))]
    case 'field':
      return [G(e.record)]
    case 'match': {
      const out: ScopedChild[] = [G(e.scrutinee)]
      for (const c of e.cases) {
        const pv = new Set<string>()
        patternVars(c.pattern, pv)
        const inner = ext(...pv)
        if (c.guard) out.push(C(c.guard, inner))
        out.push(C(c.body, inner))
      }
      return out
    }
    case 'typedecl':
      return [{ child: e.body, guaranteed, bound: ext(...e.ctors.map((c) => c.name)) }]
    case 'classdecl':
      return [G(e.body)]
    case 'instancedecl':
      return [...e.methods.map((m) => C(m.value)), G(e.body)]
    default:
      return []
  }
}

/** Rebuild `e`, mapping *every* child through `f` (scope-unaware; used only where
 *  the replacement variable is in scope everywhere, i.e. node-identity rewrites). */
function mapAllChildren(e: Expr, f: (x: Expr) => Expr): Expr {
  switch (e.kind) {
    case 'lambda':
      return { ...e, body: f(e.body) }
    case 'app':
      return { ...e, fn: f(e.fn), arg: f(e.arg) }
    case 'let':
      return { ...e, value: f(e.value), body: f(e.body) }
    case 'letrec':
      return {
        ...e,
        bindings: e.bindings.map((b) => ({ name: b.name, value: f(b.value) })),
        body: f(e.body),
      }
    case 'if':
      return { ...e, cond: f(e.cond), then: f(e.then), else: f(e.else) }
    case 'binop':
      return { ...e, left: f(e.left), right: f(e.right) }
    case 'unop':
      return { ...e, operand: f(e.operand) }
    case 'seq':
      return { ...e, first: f(e.first), rest: f(e.rest) }
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
    case 'match':
      return {
        ...e,
        scrutinee: f(e.scrutinee),
        cases: e.cases.map((c) => ({
          pattern: c.pattern,
          guard: c.guard ? f(c.guard) : undefined,
          body: f(c.body),
        })),
      }
    case 'typedecl':
      return { ...e, body: f(e.body) }
    case 'classdecl':
      return { ...e, body: f(e.body) }
    case 'instancedecl':
      return {
        ...e,
        methods: e.methods.map((m) => ({ ...m, value: f(m.value) })),
        body: f(e.body),
      }
    default:
      return e
  }
}

/** Rebuild `e`, mapping each child through `f` with the scope each child sees. */
function mapChildrenScoped(e: Expr, scope: Set<string>, f: (x: Expr, s: Set<string>) => Expr): Expr {
  const kids = scopedChildren(e, true, scope)
  let i = 0
  const next = (): Expr => {
    const c = kids[i++]
    return f(c.child, c.bound)
  }
  switch (e.kind) {
    case 'lambda':
      return { ...e, body: next() }
    case 'app': {
      const fn = next()
      const arg = next()
      return { ...e, fn, arg }
    }
    case 'let': {
      const value = next()
      const body = next()
      return { ...e, value, body }
    }
    case 'letrec': {
      const bindings = e.bindings.map((b) => ({ name: b.name, value: next() }))
      const body = next()
      return { ...e, bindings, body }
    }
    case 'if': {
      const cond = next()
      const then = next()
      const els = next()
      return { ...e, cond, then, else: els }
    }
    case 'binop': {
      const left = next()
      const right = next()
      return { ...e, left, right }
    }
    case 'unop':
      return { ...e, operand: next() }
    case 'seq': {
      const first = next()
      const rest = next()
      return { ...e, first, rest }
    }
    case 'tuple':
    case 'list':
      return { ...e, elements: e.elements.map(() => next()) }
    case 'record':
      return { ...e, fields: e.fields.map((fl) => ({ label: fl.label, value: next() })) }
    case 'recordUpdate': {
      const record = next()
      return { ...e, record, fields: e.fields.map((fl) => ({ label: fl.label, value: next() })) }
    }
    case 'field':
      return { ...e, record: next() }
    case 'match': {
      const scrutinee = next()
      const cases = e.cases.map((c) => {
        const guard = c.guard ? next() : undefined
        const body = next()
        return { pattern: c.pattern, guard, body }
      })
      return { ...e, scrutinee, cases }
    }
    case 'typedecl':
      return { ...e, body: next() }
    case 'classdecl':
      return { ...e, body: next() }
    case 'instancedecl': {
      const methods = e.methods.map((m) => ({ ...m, value: next() }))
      const body = next()
      return { ...e, methods, body }
    }
    default:
      return e
  }
}

function disjoint(a: Set<string>, b: Set<string>): boolean {
  if (a.size > b.size) [a, b] = [b, a]
  for (const x of a) if (b.has(x)) return false
  return true
}

function truncate(s: string, n: number): string {
  const flat = s.replace(/\s+/g, ' ').trim()
  return flat.length > n ? flat.slice(0, n - 1) + '…' : flat
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
