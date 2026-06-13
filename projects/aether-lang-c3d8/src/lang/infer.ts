// Aether — Hindley–Milner type inference (Algorithm W)
//
// Unification is by mutation of type variables. `let` bindings are generalised
// over the variables not free in the surrounding environment (let-polymorphism),
// so `let id = fn x -> x` is inferred as `∀ a. a -> a`. Recursive bindings are
// typed monomorphically while their own body is checked, then generalised.

import type { BinaryOp, Expr } from './ast.ts'
import type { Span } from './lexer.ts'
import type { Scheme, Type, TVar } from './types.ts'
import {
  freeVars,
  freshVar,
  prune,
  tArrow,
  tBool,
  tFloat,
  tInt,
  tList,
  tString,
  tUnit,
} from './types.ts'

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

export interface InferResult {
  type: Type
  /** inferred type for every visited node (pruned lazily at display time) */
  nodeTypes: Map<Expr, Type>
  /** generalised scheme for every `let`-bound name */
  bindingSchemes: Map<Expr, Scheme>
}

class Inferrer {
  nodeTypes = new Map<Expr, Type>()
  bindingSchemes = new Map<Expr, Scheme>()

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
    if (pa.name !== pb.name || pa.args.length !== pb.args.length) {
      throw new TypeCheckError(
        `type mismatch: cannot unify ${describe(pa)} with ${describe(pb)}`,
        span,
      )
    }
    for (let i = 0; i < pa.args.length; i++) this.unify(pa.args[i], pb.args[i], span)
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
        return this.instantiate(scheme)
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
          const t1 = this.infer(env1, e.value)
          this.unify(a, t1, e.span)
          const scheme = this.generalize(env, t1)
          this.bindingSchemes.set(e, scheme)
          const env2 = extend(env, e.name, scheme)
          return this.infer(env2, e.body)
        }
        const t1 = this.infer(env, e.value)
        const scheme = this.generalize(env, t1)
        this.bindingSchemes.set(e, scheme)
        const env2 = extend(env, e.name, scheme)
        return this.infer(env2, e.body)
      }
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
  return { type, nodeTypes: inf.nodeTypes, bindingSchemes: inf.bindingSchemes }
}

/** Build the base typing environment from the prelude globals. */
export function baseEnvFrom(globals: { name: string; scheme: Scheme }[]): Env {
  const env: Env = new Map()
  for (const g of globals) env.set(g.name, g.scheme)
  return env
}
