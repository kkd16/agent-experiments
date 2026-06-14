// Aether — Hindley–Milner type inference (Algorithm W)
//
// Unification is by mutation of type variables. `let` bindings are generalised
// over the variables not free in the surrounding environment (let-polymorphism),
// so `let id = fn x -> x` is inferred as `∀ a. a -> a`. Recursive bindings are
// typed monomorphically while their own body is checked, then generalised.

import type { BinaryOp, Expr, Pattern, TypeExpr } from './ast.ts'
import { cloneExpr } from './ast.ts'
import type { TypeCtorInfo } from './exhaustive.ts'
import { analyzeMatch } from './exhaustive.ts'
import type { Span } from './lexer.ts'
import type { Pred, Scheme, Type, TVar } from './types.ts'
import {
  ARROW,
  RECORD,
  ROW_EMPTY,
  freeVars,
  freshVar,
  isRow,
  isRowExtend,
  predToString,
  prune,
  rowExtend,
  rowLabelOf,
  tArrow,
  tBool,
  tcon,
  tFloat,
  tInt,
  tList,
  tRecord,
  tRowEmpty,
  tString,
  tTuple,
  tUnit,
} from './types.ts'
import type { ClassTables, Evidence } from './classes.ts'
import { EvCell, dictParamName, emptyTables } from './classes.ts'

export class TypeCheckError extends Error {
  span: Span | null
  constructor(message: string, span: Span | null) {
    super(message)
    this.name = 'TypeCheckError'
    this.span = span
  }
}

type Env = Map<string, Scheme>

function extend(env: Env, name: string, scheme: Scheme): Env {
  const next = new Map(env)
  next.set(name, scheme)
  return next
}

function monoScheme(t: Type): Scheme {
  return { vars: [], type: t }
}

export interface InferWarning {
  message: string
  span: Span | null
}

export interface InferResult {
  type: Type
  /** inferred type for every visited node (pruned lazily at display time) */
  nodeTypes: Map<Expr, Type>
  /** generalised scheme for every `let`-bound name */
  bindingSchemes: Map<Expr, Scheme>
  /** non-fatal warnings (e.g. non-exhaustive / redundant matches) */
  warnings: InferWarning[]
  /** type-class side-tables driving dictionary-passing elaboration */
  classTables: ClassTables
  /** every data constructor → its arity and curried scheme (for value generation) */
  ctorInfo: Map<string, { arity: number; scheme: Scheme }>
  /** every user-declared type → its parameters + constructor argument shapes */
  typeCtors: Map<string, TypeCtorInfo>
}

// --- type classes ----------------------------------------------------------

interface ClassDef {
  name: string
  param: string
  methods: Map<string, { type: TypeExpr; span: Span; default?: Expr }>
}

interface InstanceDef {
  /** head type constructor name (`Int`, `List`, `*`, a user type, …) */
  headCon: string
  /** arity of the head constructor (tuples vary, so it's part of the key) */
  headArity: number
  /** the name its dictionary is bound to in the elaborated program */
  dictName: string
  /** context predicates, each constraining one head argument by index */
  context: { cls: string; argIndex: number }[]
}

/** A pending class obligation: `cls type`, to be discharged with `cell`. */
interface Wanted {
  cls: string
  type: Type
  cell: EvCell
}

class Inferrer {
  nodeTypes = new Map<Expr, Type>()
  bindingSchemes = new Map<Expr, Scheme>()
  ctorInfo = new Map<string, { arity: number; scheme: Scheme }>()
  typeCtors = new Map<string, TypeCtorInfo>()
  warnings: InferWarning[] = []

  // type-class state
  classes = new Map<string, ClassDef>()
  methodToClass = new Map<string, string>()
  instances = new Map<string, InstanceDef[]>()
  wanted: Wanted[] = []
  tables: ClassTables = emptyTables()
  /** stack of in-progress recursive bindings, to thread dictionaries through
   * recursive (and nested) self-references */
  recStack: { names: Set<string>; refs: { node: Expr; name: string }[] }[] = []

  occurs(v: TVar, t: Type): boolean {
    const p = prune(t)
    if (p.kind === 'var') return p.id === v.id
    return p.args.some((a) => this.occurs(v, a))
  }

  unify(a: Type, b: Type, span: Span | null): void {
    const pa = prune(a)
    const pb = prune(b)
    if (pa.kind === 'var' && pb.kind === 'var' && pa.id === pb.id) return
    if (pa.kind === 'var') {
      if (this.occurs(pa, pb)) {
        throw new TypeCheckError('cannot construct an infinite type (occurs check)', span)
      }
      pa.ref = pb
      return
    }
    if (pb.kind === 'var') {
      this.unify(pb, pa, span)
      return
    }
    // records & rows unify structurally regardless of field order
    if (pa.name === RECORD && pb.name === RECORD) {
      this.unifyRow(pa.args[0], pb.args[0], span)
      return
    }
    if (isRow(pa) || isRow(pb)) {
      this.unifyRow(pa, pb, span)
      return
    }
    if (pa.name !== pb.name || pa.args.length !== pb.args.length) {
      throw new TypeCheckError(
        `type mismatch: cannot unify ${describe(pa)} with ${describe(pb)}`,
        span,
      )
    }
    for (let i = 0; i < pa.args.length; i++) this.unify(pa.args[i], pb.args[i], span)
  }

  // Row unification (Rémy/Leijen): fields may appear in any order, and a tail
  // row variable absorbs fields present only in the other row.
  private unifyRow(r1: Type, r2: Type, span: Span | null): void {
    const p1 = prune(r1)
    if (p1.kind === 'var') {
      this.unify(p1, r2, span)
      return
    }
    if (isRowExtend(p1)) {
      const label = rowLabelOf(p1.name)
      const { field, rest } = this.rewriteRow(r2, label, span)
      this.unify(p1.args[0], field, span)
      this.unify(p1.args[1], rest, span)
      return
    }
    // p1 is the empty row
    const p2 = prune(r2)
    if (p2.kind === 'var') {
      p2.ref = p1
      return
    }
    if (p2.kind === 'con' && p2.name === ROW_EMPTY) return
    throw new TypeCheckError('records have different sets of fields', span)
  }

  // find `label` in a row, returning its field type and the remaining row;
  // a tail variable is extended on demand
  private rewriteRow(row: Type, label: string, span: Span | null): { field: Type; rest: Type } {
    const p = prune(row)
    if (isRowExtend(p)) {
      if (rowLabelOf(p.name) === label) return { field: p.args[0], rest: p.args[1] }
      const sub = this.rewriteRow(p.args[1], label, span)
      return { field: sub.field, rest: rowExtend(rowLabelOf(p.name), p.args[0], sub.rest) }
    }
    if (p.kind === 'var') {
      const field: Type = freshVar()
      const rest: Type = freshVar()
      p.ref = rowExtend(label, field, rest)
      return { field, rest }
    }
    throw new TypeCheckError(`record has no field '${label}'`, span)
  }

  instantiate(scheme: Scheme): Type {
    if (scheme.vars.length === 0) return scheme.type
    const mapping = new Map<number, Type>()
    for (const id of scheme.vars) mapping.set(id, freshVar())
    return subst(scheme.type, mapping)
  }

  generalize(env: Env, t: Type): Scheme {
    const envFree = new Set<number>()
    for (const scheme of env.values()) {
      const q = new Set(scheme.vars)
      for (const id of freeVars(scheme.type)) if (!q.has(id)) envFree.add(id)
    }
    const vars: number[] = []
    for (const id of freeVars(t)) if (!envFree.has(id)) vars.push(id)
    return { vars, type: t }
  }

  infer(env: Env, e: Expr): Type {
    const t = this.inferRaw(env, e)
    this.nodeTypes.set(e, t)
    return t
  }

  private inferRaw(env: Env, e: Expr): Type {
    switch (e.kind) {
      case 'int':
        return tInt
      case 'float':
        return tFloat
      case 'bool':
        return tBool
      case 'str':
        return tString
      case 'unit':
        return tUnit
      case 'var': {
        const scheme = env.get(e.name)
        if (!scheme) throw new TypeCheckError(`unbound variable: ${e.name}`, e.span)
        this.noteSelfRef(e)
        return this.instantiateScheme(scheme, e)
      }
      case 'lambda': {
        const a = freshVar()
        const env1 = extend(env, e.param, monoScheme(a))
        const tb = this.infer(env1, e.body)
        return tArrow(a, tb)
      }
      case 'app': {
        const tf = this.infer(env, e.fn)
        const ta = this.infer(env, e.arg)
        const r = freshVar()
        this.unify(tf, tArrow(ta, r), e.span)
        return r
      }
      case 'let': {
        if (e.recursive) {
          const a = freshVar()
          const env1 = extend(env, e.name, monoScheme(a))
          this.recStack.push({ names: new Set([e.name]), refs: [] })
          const t1 = this.infer(env1, e.value)
          const frame = this.recStack.pop()
          this.unify(a, t1, e.span)
          const { scheme, params } = this.generalizeWithPreds(env, t1)
          this.bindingSchemes.set(e, scheme)
          this.attachDicts(e, params, frame ? frame.refs : [])
          const env2 = extend(env, e.name, scheme)
          return this.infer(env2, e.body)
        }
        const t1 = this.infer(env, e.value)
        const { scheme, params } = this.generalizeWithPreds(env, t1)
        this.bindingSchemes.set(e, scheme)
        this.attachDicts(e, params, [])
        const env2 = extend(env, e.name, scheme)
        return this.infer(env2, e.body)
      }
      case 'classdecl':
        return this.inferClass(env, e)
      case 'instancedecl':
        return this.inferInstance(env, e)
      case 'if': {
        this.unify(this.infer(env, e.cond), tBool, e.cond.span)
        const tt = this.infer(env, e.then)
        const te = this.infer(env, e.else)
        this.unify(tt, te, e.span)
        return tt
      }
      case 'binop':
        return this.inferBinop(env, e)
      case 'unop': {
        const to = this.infer(env, e.operand)
        if (e.op === '-') {
          this.unify(to, tInt, e.span)
          return tInt
        }
        this.unify(to, tBool, e.span)
        return tBool
      }
      case 'list': {
        const elem = freshVar()
        for (const el of e.elements) this.unify(this.infer(env, el), elem, el.span)
        return tList(elem)
      }
      case 'tuple':
        return { kind: 'con', name: '*', args: e.elements.map((el) => this.infer(env, el)) }
      case 'seq':
        this.infer(env, e.first)
        return this.infer(env, e.rest)
      case 'match': {
        const ts = this.infer(env, e.scrutinee)
        const result = freshVar()
        for (const c of e.cases) {
          const bindings = new Map<string, Type>()
          this.inferPattern(c.pattern, ts, bindings)
          let env2 = env
          for (const [name, t] of bindings) env2 = extend(env2, name, monoScheme(t))
          if (c.guard) this.unify(this.infer(env2, c.guard), tBool, c.guard.span)
          this.unify(this.infer(env2, c.body), result, c.body.span)
        }
        this.checkMatch(e, ts)
        return result
      }
      case 'letrec': {
        // all names are in scope (monomorphically) while checking every binding
        const tvs = e.bindings.map(() => freshVar() as Type)
        let env1 = env
        e.bindings.forEach((b, i) => {
          env1 = extend(env1, b.name, monoScheme(tvs[i]))
        })
        const wantedBefore = this.wanted.length
        e.bindings.forEach((b, i) => {
          this.unify(this.infer(env1, b.value), tvs[i], b.value.span)
        })
        // constrained mutual recursion would need a shared dictionary context
        // across the group; reduce what we can, and reject anything left over.
        this.reduceConWanted(e.span)
        if (this.wanted.length > wantedBefore) {
          const stuck = this.wanted
            .slice(wantedBefore)
            .some((w) => prune(w.type).kind === 'var')
          if (stuck) {
            throw new TypeCheckError(
              'class constraints inside a `let rec … and …` group are not supported; ' +
                'use a single `let rec` for the overloaded function',
              e.span,
            )
          }
        }
        // then generalise each over the original environment
        let env2 = env
        e.bindings.forEach((b, i) => {
          const scheme = this.generalize(env, tvs[i])
          this.bindingSchemes.set(b.value, scheme)
          env2 = extend(env2, b.name, scheme)
        })
        return this.infer(env2, e.body)
      }
      case 'typedecl': {
        this.typeCtors.set(e.name, {
          params: e.params,
          ctors: e.ctors.map((c) => ({ name: c.name, argTypeExprs: c.args })),
        })
        const params = new Map<string, Type>()
        for (const p of e.params) params.set(p, freshVar())
        const resultType: Type = tcon(
          e.name,
          e.params.map((p) => params.get(p) as Type),
        )
        let env2 = env
        for (const ctor of e.ctors) {
          const argTypes = ctor.args.map((a) => convertTypeExpr(a, params))
          let schemeType: Type = resultType
          for (let i = argTypes.length - 1; i >= 0; i--) schemeType = tArrow(argTypes[i], schemeType)
          const scheme: Scheme = { vars: [...freeVars(schemeType)], type: schemeType }
          this.ctorInfo.set(ctor.name, { arity: argTypes.length, scheme })
          env2 = extend(env2, ctor.name, scheme)
        }
        return this.infer(env2, e.body)
      }
      case 'record': {
        const seen = new Set<string>()
        const fieldTypes = e.fields.map((f) => {
          if (seen.has(f.label)) {
            throw new TypeCheckError(`duplicate field '${f.label}' in record`, e.span)
          }
          seen.add(f.label)
          return { label: f.label, type: this.infer(env, f.value) }
        })
        let row: Type = tRowEmpty
        for (let i = fieldTypes.length - 1; i >= 0; i--) {
          row = rowExtend(fieldTypes[i].label, fieldTypes[i].type, row)
        }
        return tRecord(row)
      }
      case 'field': {
        const tr = this.infer(env, e.record)
        const field = freshVar()
        const rest = freshVar()
        this.unify(tr, tRecord(rowExtend(e.label, field, rest)), e.span)
        return field
      }
      case 'recordUpdate': {
        const tr = this.infer(env, e.record)
        // each updated field must already exist with a matching type; the
        // record's type is otherwise unchanged
        for (const f of e.fields) {
          const tv = this.infer(env, f.value)
          this.unify(tr, tRecord(rowExtend(f.label, tv, freshVar())), f.value.span)
        }
        return tr
      }
    }
  }

  private checkMatch(e: Extract<Expr, { kind: 'match' }>, scrutType: Type): void {
    const analysis = analyzeMatch(
      e.cases.map((c) => c.pattern),
      e.cases.map((c) => c.guard !== undefined),
      scrutType,
      this.typeCtors,
      convertTypeExpr,
    )
    if (analysis.missing.length > 0) {
      this.warnings.push({
        message: `non-exhaustive match — not covered: ${analysis.missing.join(', ')}`,
        span: e.span,
      })
    }
    for (const idx of analysis.redundant) {
      this.warnings.push({
        message: 'redundant match clause — it can never be reached',
        span: e.cases[idx].pattern.span,
      })
    }
  }

  private inferPattern(pat: Pattern, expected: Type, bindings: Map<string, Type>): void {
    switch (pat.kind) {
      case 'pwild':
        return
      case 'pvar':
        if (bindings.has(pat.name)) {
          throw new TypeCheckError(`variable ${pat.name} is bound twice in the same pattern`, pat.span)
        }
        bindings.set(pat.name, expected)
        return
      case 'pint':
        this.unify(expected, tInt, pat.span)
        return
      case 'pfloat':
        this.unify(expected, tFloat, pat.span)
        return
      case 'pbool':
        this.unify(expected, tBool, pat.span)
        return
      case 'pstr':
        this.unify(expected, tString, pat.span)
        return
      case 'punit':
        this.unify(expected, tUnit, pat.span)
        return
      case 'pnil':
        this.unify(expected, tList(freshVar()), pat.span)
        return
      case 'pcons': {
        const elem = freshVar()
        this.unify(expected, tList(elem), pat.span)
        this.inferPattern(pat.head, elem, bindings)
        this.inferPattern(pat.tail, tList(elem), bindings)
        return
      }
      case 'ptuple': {
        const elems = pat.elements.map(() => freshVar() as Type)
        this.unify(expected, tTuple(elems), pat.span)
        pat.elements.forEach((p, i) => this.inferPattern(p, elems[i], bindings))
        return
      }
      case 'pcon': {
        const info = this.ctorInfo.get(pat.name)
        if (!info) throw new TypeCheckError(`unknown constructor: ${pat.name}`, pat.span)
        if (pat.args.length !== info.arity) {
          throw new TypeCheckError(
            `constructor ${pat.name} expects ${info.arity} argument(s) but got ${pat.args.length}`,
            pat.span,
          )
        }
        let cur = this.instantiate(info.scheme)
        const argTs: Type[] = []
        for (let i = 0; i < info.arity; i++) {
          const p = prune(cur)
          if (p.kind !== 'con' || p.name !== ARROW) {
            throw new TypeCheckError(`constructor ${pat.name} is not a function`, pat.span)
          }
          argTs.push(p.args[0])
          cur = p.args[1]
        }
        this.unify(expected, cur, pat.span)
        pat.args.forEach((p, i) => this.inferPattern(p, argTs[i], bindings))
        return
      }
    }
  }

  private inferBinop(env: Env, e: Extract<Expr, { kind: 'binop' }>): Type {
    const tl = this.infer(env, e.left)
    const tr = this.infer(env, e.right)
    const op: BinaryOp = e.op
    switch (op) {
      case '+':
      case '-':
      case '*':
      case '/':
      case '%':
        this.unify(tl, tInt, e.left.span)
        this.unify(tr, tInt, e.right.span)
        return tInt
      case '+.':
      case '-.':
      case '*.':
      case '/.':
        this.unify(tl, tFloat, e.left.span)
        this.unify(tr, tFloat, e.right.span)
        return tFloat
      case '==':
      case '!=':
      case '<':
      case '>':
      case '<=':
      case '>=':
        this.unify(tl, tr, e.span)
        return tBool
      case '&&':
      case '||':
        this.unify(tl, tBool, e.left.span)
        this.unify(tr, tBool, e.right.span)
        return tBool
      case '::': {
        this.unify(tr, tList(tl), e.span)
        return tList(tl)
      }
      case '^':
        this.unify(tl, tString, e.left.span)
        this.unify(tr, tString, e.right.span)
        return tString
      case '++': {
        const elem = freshVar()
        this.unify(tl, tList(elem), e.left.span)
        this.unify(tr, tList(elem), e.right.span)
        return tList(elem)
      }
    }
  }

  // --- type classes --------------------------------------------------------

  /** Record a reference to an in-progress recursive binding, so elaboration can
   * thread its dictionaries through the recursive call. */
  private noteSelfRef(e: Extract<Expr, { kind: 'var' }>): void {
    for (let i = this.recStack.length - 1; i >= 0; i--) {
      if (this.recStack[i].names.has(e.name)) {
        this.recStack[i].refs.push({ node: e, name: e.name })
        return
      }
    }
  }

  /** Instantiate a scheme, generating a class obligation per predicate and
   * recording on `node` how to apply the resolved evidence. */
  private instantiateScheme(scheme: Scheme, node: Extract<Expr, { kind: 'var' }>): Type {
    if (!scheme.preds || scheme.preds.length === 0) return this.instantiate(scheme)
    const mapping = new Map<number, Type>()
    for (const id of scheme.vars) mapping.set(id, freshVar())
    const type = subst(scheme.type, mapping)
    const cells: EvCell[] = []
    for (const p of scheme.preds) {
      const cell = new EvCell()
      this.wanted.push({ cls: p.cls, type: subst(p.type, mapping), cell })
      cells.push(cell)
    }
    this.tables.used = true
    if (this.methodToClass.has(node.name) && cells.length === 1) {
      this.tables.methodUse.set(node, { method: node.name, cell: cells[0] })
    } else {
      this.tables.evidenceArgs.set(node, cells)
    }
    return type
  }

  /** Generalise `t` over the environment, additionally capturing the class
   * constraints over the generalised variables as the binding's context. */
  private generalizeWithPreds(
    env: Env,
    t: Type,
  ): { scheme: Scheme; params: { name: string; cls: string; varId: number }[] } {
    // discharge any ground constraints first, so what remains is var-headed
    this.reduceConWanted(null)
    const base = this.generalize(env, t)
    const G = new Set(base.vars)
    const preds: Pred[] = []
    const params: { name: string; cls: string; varId: number }[] = []
    const seen = new Set<string>()
    const remaining: Wanted[] = []
    for (const w of this.wanted) {
      const pt = prune(w.type)
      if (pt.kind === 'var' && G.has(pt.id)) {
        const name = dictParamName(w.cls, pt.id)
        w.cell.ev = { kind: 'param', name }
        const key = w.cls + '|' + pt.id
        if (!seen.has(key)) {
          seen.add(key)
          preds.push({ cls: w.cls, type: pt })
          params.push({ name, cls: w.cls, varId: pt.id })
        }
      } else {
        remaining.push(w)
      }
    }
    this.wanted = remaining
    const scheme: Scheme = preds.length ? { vars: base.vars, type: base.type, preds } : base
    return { scheme, params }
  }

  /** Record the dictionary parameters a binding abstracts, and feed the same
   * dictionaries to its recursive self-references. */
  private attachDicts(
    node: Expr,
    params: { name: string; cls: string; varId: number }[],
    refs: { node: Expr; name: string }[],
  ): void {
    if (params.length === 0) return
    this.tables.bindingDicts.set(node, params.map((p) => p.name))
    this.tables.used = true
    for (const ref of refs) {
      const cells = params.map((p) => {
        const c = new EvCell()
        c.ev = { kind: 'param', name: p.name }
        return c
      })
      this.tables.evidenceArgs.set(ref.node, cells)
    }
  }

  /** Discharge every pending constraint whose head is a concrete type
   * constructor, resolving it to an instance dictionary (recursively). */
  private reduceConWanted(span: Span | null): void {
    const input = this.wanted
    this.wanted = []
    for (const w of input) {
      const pt = prune(w.type)
      if (pt.kind === 'con') {
        w.cell.ev = this.evidenceFor(w.cls, pt, span)
      } else {
        this.wanted.push(w)
      }
    }
  }

  /** Evidence that builds a dictionary for `cls type`: a concrete instance
   * dictionary, or a dictionary parameter when the head is still a variable. */
  private evidenceFor(cls: string, type: Type, span: Span | null): Evidence {
    const t = prune(type)
    if (t.kind === 'var') {
      const name = dictParamName(cls, t.id)
      const cell = new EvCell()
      cell.ev = { kind: 'param', name }
      // register so an enclosing generalisation/instance abstracts this param
      this.wanted.push({ cls, type: t, cell })
      return { kind: 'param', name }
    }
    const insts = this.instances.get(cls)
    if (!insts) throw new TypeCheckError(`no instance of class '${cls}' is in scope`, span)
    const inst = insts.find((i) => i.headCon === t.name && i.headArity === t.args.length)
    if (!inst) {
      throw new TypeCheckError(`no instance for ${predToString({ cls, type: t })}`, span)
    }
    const args = inst.context.map((ce) => this.evidenceFor(ce.cls, t.args[ce.argIndex], span))
    return { kind: 'instance', dictName: inst.dictName, args }
  }

  private inferClass(env: Env, e: Extract<Expr, { kind: 'classdecl' }>): Type {
    if (this.classes.has(e.name)) {
      throw new TypeCheckError(`class ${e.name} is already defined`, e.span)
    }
    const methods = new Map<string, { type: TypeExpr; span: Span; default?: Expr }>()
    for (const m of e.methods) {
      if (methods.has(m.name)) {
        throw new TypeCheckError(`duplicate method ${m.name} in class ${e.name}`, m.span)
      }
      const owner = this.methodToClass.get(m.name)
      if (owner) {
        throw new TypeCheckError(`method ${m.name} already belongs to class ${owner}`, m.span)
      }
      methods.set(m.name, { type: m.type, span: m.span, default: m.default })
      this.methodToClass.set(m.name, e.name)
    }
    this.classes.set(e.name, { name: e.name, param: e.param, methods })
    if (!this.instances.has(e.name)) this.instances.set(e.name, [])
    this.tables.used = true
    let env2 = env
    for (const m of e.methods) {
      env2 = extend(env2, m.name, this.methodScheme(e.name, e.param, m.type))
    }
    return this.infer(env2, e.body)
  }

  private inferInstance(env: Env, e: Extract<Expr, { kind: 'instancedecl' }>): Type {
    const cls = this.classes.get(e.cls)
    if (!cls) throw new TypeCheckError(`unknown class '${e.cls}' in instance`, e.span)

    // build the head type, recording which variable sits at each argument
    const headMap = new Map<string, Type>()
    const headType = prune(this.convertFresh(e.head, headMap))
    if (headType.kind !== 'con') {
      throw new TypeCheckError('an instance head must be a type constructor', e.span)
    }
    const headCon = headType.name
    const headArity = headType.args.length
    const argVarId = headType.args.map((a) => {
      const p = prune(a)
      return p.kind === 'var' ? p.id : null
    })
    const headVarIds = new Set<number>(argVarId.filter((x): x is number => x !== null))
    const dictName = `$dict_${e.cls}_${dictTag(headCon, headArity)}`

    const existing = (this.instances.get(e.cls) ?? []).find(
      (i) => i.headCon === headCon && i.headArity === headArity,
    )
    if (existing) {
      throw new TypeCheckError(`duplicate instance ${e.cls} for ${headCon}`, e.span)
    }

    // The context is taken from the written `… =>` constraints, mapping each
    // constrained variable to its position in the head. This is what lets a
    // *recursive* instance resolve a use of its own class on a sub-value: the
    // context dictionary is in scope as a parameter while the methods run.
    const context: { cls: string; argIndex: number; name: string }[] = []
    const providedNames = new Set<string>()
    for (const c of e.context) {
      const tv = headMap.get(c.param)
      if (!tv) {
        throw new TypeCheckError(
          `instance context variable '${c.param}' does not appear in the head ${headCon}`,
          c.span,
        )
      }
      const p = prune(tv)
      if (p.kind !== 'var') continue
      const argIndex = argVarId.indexOf(p.id)
      const name = dictParamName(c.cls, p.id)
      context.push({ cls: c.cls, argIndex, name })
      providedNames.add(name)
    }
    const def: InstanceDef = {
      headCon,
      headArity,
      dictName,
      context: context.map((c) => ({ cls: c.cls, argIndex: c.argIndex })),
    }
    this.addInstance(e.cls, def) // register before checking methods (recursive instances)

    // index the instance's provided methods, validating names and duplicates
    const provided = new Map<string, { value: Expr; span: Span }>()
    for (const impl of e.methods) {
      if (!cls.methods.has(impl.name)) {
        throw new TypeCheckError(`class ${e.cls} has no method '${impl.name}'`, impl.span)
      }
      if (provided.has(impl.name)) {
        throw new TypeCheckError(`duplicate method '${impl.name}' in instance`, impl.span)
      }
      provided.set(impl.name, { value: impl.value, span: impl.span })
    }
    // for every class method, take the instance's impl or fall back to the
    // class default (cloned so its elaboration is independent per instance)
    const finalMethods: { name: string; value: Expr }[] = []
    for (const [mname, sig] of cls.methods) {
      const p = provided.get(mname)
      let value: Expr
      let span = e.span
      if (p) {
        value = p.value
        span = p.span
      } else if (sig.default) {
        value = cloneExpr(sig.default)
      } else {
        throw new TypeCheckError(`instance ${e.cls} ${headCon} is missing method '${mname}'`, e.span)
      }
      const expected = this.methodSigType(sig.type, cls.param, headType)
      const got = this.infer(env, value)
      this.unify(got, expected, span)
      finalMethods.push({ name: mname, value })
    }

    // discharge the method bodies' constraints. Ground ones resolve to other
    // instances; constraints over a head variable must be covered by the
    // written context (and resolve to its dictionary parameter).
    this.reduceConWanted(e.span)
    const remaining: Wanted[] = []
    for (const w of this.wanted) {
      const pt = prune(w.type)
      if (pt.kind === 'var' && headVarIds.has(pt.id)) {
        const name = dictParamName(w.cls, pt.id)
        if (!providedNames.has(name)) {
          throw new TypeCheckError(
            `instance ${e.cls} ${headCon} needs a '${w.cls}' context on one of its ` +
              'type variables — add it before `=>`',
            e.span,
          )
        }
        w.cell.ev = { kind: 'param', name }
      } else {
        remaining.push(w)
      }
    }
    this.wanted = remaining

    this.tables.instanceElab.set(e, {
      dictName,
      paramNames: context.map((c) => c.name),
      methods: finalMethods,
    })
    this.tables.used = true
    return this.infer(env, e.body)
  }

  private addInstance(cls: string, def: InstanceDef): void {
    const arr = this.instances.get(cls)
    if (arr) arr.push(def)
    else this.instances.set(cls, [def])
  }

  /** The qualified scheme of a class method: `∀a…. (Cls a) => methodType`. */
  private methodScheme(className: string, classParam: string, sig: TypeExpr): Scheme {
    const map = new Map<string, Type>()
    const classVar = freshVar()
    map.set(classParam, classVar)
    const type = this.convertFresh(sig, map)
    const ids = new Set<number>([classVar.id, ...freeVars(type)])
    return { vars: [...ids], type, preds: [{ cls: className, type: classVar }] }
  }

  /** The expected type of a method implementation at a given instance head. */
  private methodSigType(sig: TypeExpr, classParam: string, headType: Type): Type {
    const map = new Map<string, Type>()
    map.set(classParam, headType)
    return this.convertFresh(sig, map)
  }

  /** Convert a syntactic type, auto-allocating a fresh variable for any type
   * variable not already bound in `map` (used for class/instance signatures). */
  private convertFresh(te: TypeExpr, map: Map<string, Type>): Type {
    switch (te.kind) {
      case 'tvar': {
        let tv = map.get(te.name)
        if (!tv) {
          tv = freshVar()
          map.set(te.name, tv)
        }
        return tv
      }
      case 'tarrow':
        return tArrow(this.convertFresh(te.from, map), this.convertFresh(te.to, map))
      case 'ttuple':
        return tTuple(te.elements.map((x) => this.convertFresh(x, map)))
      case 'tcon': {
        const args = te.args.map((x) => this.convertFresh(x, map))
        switch (te.name) {
          case 'Int':
            return tInt
          case 'Float':
            return tFloat
          case 'Bool':
            return tBool
          case 'String':
            return tString
          case 'Unit':
            return tUnit
          case 'List':
            return tList(args[0] ?? freshVar())
          default:
            return tcon(te.name, args)
        }
      }
    }
  }

  /** Discharge all remaining constraints at the top level; anything left is a
   * missing instance or an ambiguous constraint. */
  finish(): void {
    this.reduceConWanted(null)
    if (this.wanted.length > 0) {
      const w = this.wanted[0]
      throw new TypeCheckError(
        `unresolved or ambiguous class constraint ${predToString({ cls: w.cls, type: w.type })} — ` +
          'add an instance or constrain the type',
        null,
      )
    }
  }
}

/** A filesystem-safe tag for an instance dictionary's head constructor. */
function dictTag(con: string, arity: number): string {
  if (con === '*') return `Tuple${arity}`
  if (con === '->') return 'Fun'
  return con.replace(/[^A-Za-z0-9_]/g, '_')
}

// Convert a syntactic type expression (from a `type` declaration) into a real
// type, mapping the declaration's parameter names to their type variables.
function convertTypeExpr(te: TypeExpr, params: Map<string, Type>): Type {
  switch (te.kind) {
    case 'tvar': {
      const tv = params.get(te.name)
      if (!tv) throw new TypeCheckError(`unbound type variable: ${te.name}`, te.span)
      return tv
    }
    case 'tarrow':
      return tArrow(convertTypeExpr(te.from, params), convertTypeExpr(te.to, params))
    case 'ttuple':
      return tTuple(te.elements.map((x) => convertTypeExpr(x, params)))
    case 'tcon': {
      const args = te.args.map((x) => convertTypeExpr(x, params))
      switch (te.name) {
        case 'Int':
          return tInt
        case 'Float':
          return tFloat
        case 'Bool':
          return tBool
        case 'String':
          return tString
        case 'Unit':
          return tUnit
        case 'List':
          return tList(args[0] ?? freshVar())
        default:
          return tcon(te.name, args)
      }
    }
  }
}

function subst(t: Type, mapping: Map<number, Type>): Type {
  const p = prune(t)
  if (p.kind === 'var') {
    const replacement = mapping.get(p.id)
    return replacement ?? p
  }
  return { kind: 'con', name: p.name, args: p.args.map((a) => subst(a, mapping)) }
}

function describe(t: Type): string {
  if (t.kind === 'var') return 'a type variable'
  if (t.args.length === 0) return t.name
  return t.name
}

export function inferProgram(program: Expr, base: Env): InferResult {
  const inf = new Inferrer()
  const type = inf.infer(base, program)
  inf.finish()
  return {
    type,
    nodeTypes: inf.nodeTypes,
    bindingSchemes: inf.bindingSchemes,
    warnings: inf.warnings,
    classTables: inf.tables,
    ctorInfo: inf.ctorInfo,
    typeCtors: inf.typeCtors,
  }
}

/** Build the base typing environment from the prelude globals. */
export function baseEnvFrom(globals: { name: string; scheme: Scheme }[]): Env {
  const env: Env = new Map()
  for (const g of globals) env.set(g.name, g.scheme)
  return env
}
