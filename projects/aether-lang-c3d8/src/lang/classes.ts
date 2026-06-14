// Aether — type classes: evidence & dictionary-passing elaboration
//
// Type classes are implemented as a *type-directed translation* into the
// existing core AST. Inference (in `infer.ts`) resolves, for every class
// constraint, a piece of **evidence** describing how to build the dictionary it
// needs at runtime — either a concrete instance dictionary (possibly applied to
// the evidence its context demands) or a dictionary parameter passed in from an
// enclosing binding. This module owns the evidence representation and the
// elaboration pass that consumes inference's side-tables to rewrite the program:
//
//   • an `instance` becomes a `let rec` of a **dictionary** (a record of methods,
//     abstracted over the dictionaries its context needs),
//   • a constrained binding (`let p = …`) gains leading **dictionary parameters**,
//   • a **method use** becomes a field access on its evidence dictionary,
//   • every **use site** applies its resolved evidence.
//
// Because the output is ordinary core AST (lets, lambdas, records, field access),
// the bytecode compiler and the JavaScript backend run dictionaries like any
// other code — neither needed a single change.

import type { Expr } from './ast.ts'
import type { Span } from './lexer.ts'

/** How to construct a dictionary at runtime. */
export type Evidence =
  // a dictionary parameter that some enclosing binding/instance abstracts over
  | { kind: 'param'; name: string }
  // a named instance dictionary, applied to the evidence its context requires
  | { kind: 'instance'; dictName: string; args: Evidence[] }

/** A mutable cell inference fills in once a constraint is resolved. */
export class EvCell {
  ev: Evidence | null = null
}

/** The deterministic name of the dictionary parameter for `cls` over var `id`. */
export function dictParamName(cls: string, varId: number): string {
  return `$d_${cls}_${varId}`
}

/** The elaboration recipe for one `instance` declaration. */
export interface InstanceElab {
  /** the (globally unique) name the instance dictionary is bound to */
  dictName: string
  /** dictionary parameters the builder abstracts (its context), in order */
  paramNames: string[]
  /** the method implementations, by declared name (still surface AST) */
  methods: { name: string; value: Expr }[]
}

/**
 * The side-tables inference produces for elaboration. All maps are keyed by the
 * exact `Expr` node objects from the surface AST.
 */
export interface ClassTables {
  /** did the program use type classes at all? (if not, elaboration is identity) */
  used: boolean
  /** a `var` node that is a class-method use → the method name + its dictionary */
  methodUse: Map<Expr, { method: string; cell: EvCell }>
  /** a `var` node referring to a constrained binding → the evidence to apply */
  evidenceArgs: Map<Expr, EvCell[]>
  /** a `let` node / `letrec` binding-value node → dictionary params to abstract */
  bindingDicts: Map<Expr, string[]>
  /** an `instancedecl` node → its dictionary elaboration */
  instanceElab: Map<Expr, InstanceElab>
}

export function emptyTables(): ClassTables {
  return {
    used: false,
    methodUse: new Map(),
    evidenceArgs: new Map(),
    bindingDicts: new Map(),
    instanceElab: new Map(),
  }
}

function evToExpr(ev: Evidence, span: Span): Expr {
  if (ev.kind === 'param') return { kind: 'var', name: ev.name, span }
  let acc: Expr = { kind: 'var', name: ev.dictName, span }
  for (const a of ev.args) acc = { kind: 'app', fn: acc, arg: evToExpr(a, span), span }
  return acc
}

function wrapDicts(value: Expr, params: string[], span: Span): Expr {
  let acc = value
  for (let i = params.length - 1; i >= 0; i--) {
    acc = { kind: 'lambda', param: params[i], body: acc, span }
  }
  return acc
}

/**
 * Rewrite the (surface) AST into pure core AST with dictionaries threaded
 * through. A no-op when the program used no classes.
 */
export function elaborate(root: Expr, t: ClassTables): Expr {
  if (!t.used) return root

  const go = (e: Expr): Expr => {
    switch (e.kind) {
      case 'int':
      case 'float':
      case 'bool':
      case 'str':
      case 'unit':
        return e
      case 'var': {
        const m = t.methodUse.get(e)
        if (m) {
          const dict = evToExpr(cellEv(m.cell), e.span)
          return { kind: 'field', record: dict, label: m.method, span: e.span }
        }
        const cells = t.evidenceArgs.get(e)
        if (cells && cells.length > 0) {
          let acc: Expr = { kind: 'var', name: e.name, span: e.span }
          for (const c of cells) acc = { kind: 'app', fn: acc, arg: evToExpr(cellEv(c), e.span), span: e.span }
          return acc
        }
        return e
      }
      case 'lambda':
        return { ...e, body: go(e.body) }
      case 'app':
        return { ...e, fn: go(e.fn), arg: go(e.arg) }
      case 'let': {
        let value = go(e.value)
        const dicts = t.bindingDicts.get(e)
        if (dicts && dicts.length > 0) value = wrapDicts(value, dicts, e.span)
        return { ...e, value, body: go(e.body) }
      }
      case 'letrec':
        return {
          ...e,
          bindings: e.bindings.map((b) => {
            let value = go(b.value)
            const dicts = t.bindingDicts.get(b.value)
            if (dicts && dicts.length > 0) value = wrapDicts(value, dicts, b.value.span)
            return { name: b.name, value }
          }),
          body: go(e.body),
        }
      case 'if':
        return { ...e, cond: go(e.cond), then: go(e.then), else: go(e.else) }
      case 'binop':
        return { ...e, left: go(e.left), right: go(e.right) }
      case 'unop':
        return { ...e, operand: go(e.operand) }
      case 'list':
      case 'tuple':
        return { ...e, elements: e.elements.map(go) }
      case 'seq':
        return { ...e, first: go(e.first), rest: go(e.rest) }
      case 'match':
        return {
          ...e,
          scrutinee: go(e.scrutinee),
          cases: e.cases.map((c) => ({
            pattern: c.pattern,
            guard: c.guard ? go(c.guard) : undefined,
            body: go(c.body),
          })),
        }
      case 'typedecl':
        return { ...e, body: go(e.body) }
      case 'record':
        return { ...e, fields: e.fields.map((f) => ({ label: f.label, value: go(f.value) })) }
      case 'field':
        return { ...e, record: go(e.record) }
      case 'recordUpdate':
        return {
          ...e,
          record: go(e.record),
          fields: e.fields.map((f) => ({ label: f.label, value: go(f.value) })),
        }
      case 'classdecl':
        // a class introduces no runtime artifact; its methods become field
        // accesses on dictionaries at the use sites
        return go(e.body)
      case 'instancedecl': {
        const ie = t.instanceElab.get(e)
        if (!ie) return go(e.body)
        const fields = ie.methods.map((m) => ({ label: m.name, value: go(m.value) }))
        const record: Expr = { kind: 'record', fields, span: e.span }
        const value = wrapDicts(record, ie.paramNames, e.span)
        return {
          kind: 'let',
          name: ie.dictName,
          value,
          // recursive: the dictionary may reference itself (recursive instances)
          recursive: true,
          body: go(e.body),
          span: e.span,
        }
      }
    }
  }

  return go(root)
}

function cellEv(cell: EvCell): Evidence {
  if (cell.ev) return cell.ev
  // Should never happen once inference's resolver has run; degrade gracefully so
  // a bug surfaces as a clear runtime "unbound" rather than a crash here.
  return { kind: 'param', name: '$unresolved_dictionary' }
}
