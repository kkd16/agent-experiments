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

// ---------------------------------------------------------------------------
// Public entry
// ---------------------------------------------------------------------------

export function optimizeCore(root: Expr): OptimizeResult {
  freshCounter = 0
  CTORS = collectCtors(root)
  const passes: Record<string, number> = {}
  const bump = (name: string): void => {
    passes[name] = (passes[name] ?? 0) + 1
  }

  const nodesBefore = size(root)
  let expr = root
  let rounds = 0
  for (; rounds < MAX_ROUNDS; rounds++) {
    const before = passesTotal(passes)
    expr = step(expr, bump)
    if (passesTotal(passes) === before) break // fixpoint
  }

  return {
    expr,
    stats: {
      rounds,
      total: passesTotal(passes),
      passes,
      nodesBefore,
      nodesAfter: size(expr),
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
      return reduceApp(n, bump) ?? n
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
      return reduceIf(n, bump) ?? n
    }
    case 'binop': {
      const n = { ...e, left: rec(e.left), right: rec(e.right) }
      return reduceBinop(n, bump) ?? n
    }
    case 'unop': {
      const n = { ...e, operand: rec(e.operand) }
      return reduceUnop(n, bump) ?? n
    }
    case 'seq': {
      const n = { ...e, first: rec(e.first), rest: rec(e.rest) }
      return reduceSeq(n, bump) ?? n
    }
    case 'list':
      return { ...e, elements: e.elements.map(rec) }
    case 'tuple':
      return { ...e, elements: e.elements.map(rec) }
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
      return reduceMatch(n as Extract<Expr, { kind: 'match' }>, bump) ?? n
    }
    case 'record':
      return { ...e, fields: e.fields.map((f) => ({ label: f.label, value: rec(f.value) })) }
    case 'field': {
      const n = { ...e, record: rec(e.record) }
      return reduceField(n, bump) ?? n
    }
    case 'recordUpdate':
      return {
        ...e,
        record: rec(e.record),
        fields: e.fields.map((f) => ({ label: f.label, value: rec(f.value) })),
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
      return head !== null && head.args.every(isPure)
    }
    case 'match': {
      // a match on a statically-known, *pure* shape with a definite, unguarded,
      // pure arm is pure & total (the scrutinee has no effect and the chosen
      // branch cannot fail)
      if (!isStaticShape(e.scrutinee) || !isPure(e.scrutinee)) return false
      for (const c of e.cases) {
        const o = tryMatch(c.pattern, e.scrutinee)
        if (o.tag === 'no') continue
        if (o.tag === 'unknown' || c.guard) return false
        return o.bindings.every((b) => isPure(b.value)) && isPure(c.body)
      }
      return false
    }
    default:
      return false
  }
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
