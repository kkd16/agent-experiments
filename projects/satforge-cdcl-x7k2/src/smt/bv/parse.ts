// A tolerant SMT-LIB 2 parser for the QF_BV fragment: declarations of bit-vector
// and Bool constants, `let` bindings, indexed operators ((_ extract i j),
// (_ zero_extend k), …), the three literal forms (#b…, #x…, (_ bvN m)), every
// core bit-vector operator, and the unsigned/signed comparisons. Widths are
// resolved as the tree is built, so the produced AST is fully width-annotated.

import { mask, type BoolForm, type BvBinOp, type BvCmp, type BvScript, type BvTerm } from './ast'

export class BvSyntaxError extends Error {}

type SExpr = string | SExpr[]

function tokenize(src: string): string[] {
  const toks: string[] = []
  let i = 0
  while (i < src.length) {
    const ch = src[i]
    if (ch === ';') {
      while (i < src.length && src[i] !== '\n') i++
    } else if (ch === '(' || ch === ')') {
      toks.push(ch)
      i++
    } else if (/\s/.test(ch)) {
      i++
    } else if (ch === '|') {
      let j = i + 1
      while (j < src.length && src[j] !== '|') j++
      toks.push(src.slice(i, j + 1))
      i = j + 1
    } else {
      let j = i
      while (j < src.length && !/[\s()]/.test(src[j]) && src[j] !== ';') j++
      toks.push(src.slice(i, j))
      i = j
    }
  }
  return toks
}

function readSExprs(toks: string[]): SExpr[] {
  let pos = 0
  const read = (): SExpr => {
    if (pos >= toks.length) throw new BvSyntaxError('unexpected end of input')
    const t = toks[pos++]
    if (t === '(') {
      const list: SExpr[] = []
      while (toks[pos] !== ')') {
        if (pos >= toks.length) throw new BvSyntaxError('missing )')
        list.push(read())
      }
      pos++
      return list
    }
    if (t === ')') throw new BvSyntaxError('unexpected )')
    return t
  }
  const out: SExpr[] = []
  while (pos < toks.length) out.push(read())
  return out
}

const isSym = (e: SExpr): e is string => typeof e === 'string'

type Decl = { kind: 'bv'; width: number } | { kind: 'bool' }
type Binding = { sort: 'bv'; term: BvTerm } | { sort: 'bool'; form: BoolForm }

const BIN_OPS: Record<string, BvBinOp> = {
  bvand: 'bvand', bvor: 'bvor', bvxor: 'bvxor', bvnand: 'bvnand', bvnor: 'bvnor', bvxnor: 'bvxnor',
  bvadd: 'bvadd', bvsub: 'bvsub', bvmul: 'bvmul',
  bvudiv: 'bvudiv', bvurem: 'bvurem', bvsdiv: 'bvsdiv', bvsrem: 'bvsrem', bvsmod: 'bvsmod',
  bvshl: 'bvshl', bvlshr: 'bvlshr', bvashr: 'bvashr',
}
const CMP_OPS: Record<string, BvCmp> = {
  bvult: 'bvult', bvule: 'bvule', bvugt: 'bvugt', bvuge: 'bvuge',
  bvslt: 'bvslt', bvsle: 'bvsle', bvsgt: 'bvsgt', bvsge: 'bvsge',
}
const BOOL_HEADS = new Set(['and', 'or', 'not', '=>', 'xor', '=', 'distinct', ...Object.keys(CMP_OPS)])

export function parseBv(src: string): BvScript {
  const decls = new Map<string, Decl>()
  const assertions: BoolForm[] = []
  let expected: 'sat' | 'unsat' | undefined
  let logic: string | undefined
  const scopes: Map<string, Binding>[] = []

  const lookup = (name: string): Binding | undefined => {
    for (let i = scopes.length - 1; i >= 0; i--) {
      const b = scopes[i].get(name)
      if (b) return b
    }
    return undefined
  }

  const parseSort = (e: SExpr): Decl => {
    if (isSym(e)) {
      if (e === 'Bool') return { kind: 'bool' }
      throw new BvSyntaxError(`unknown sort: ${e}`)
    }
    if (e.length === 3 && e[0] === '_' && e[1] === 'BitVec') {
      const w = Number(e[2])
      if (!Number.isInteger(w) || w <= 0) throw new BvSyntaxError('BitVec width must be a positive integer')
      return { kind: 'bv', width: w }
    }
    throw new BvSyntaxError('unsupported sort')
  }

  const parseLiteral = (s: string): BvTerm | null => {
    if (/^#b[01]+$/.test(s)) {
      const bits = s.slice(2)
      return { kind: 'const', value: BigInt('0b' + bits), width: bits.length }
    }
    if (/^#x[0-9a-fA-F]+$/.test(s)) {
      const hex = s.slice(2)
      return { kind: 'const', value: BigInt('0x' + hex), width: hex.length * 4 }
    }
    return null
  }

  // ---- terms -----------------------------------------------------------------
  const parseTerm = (e: SExpr): BvTerm => {
    if (isSym(e)) {
      const lit = parseLiteral(e)
      if (lit) return lit
      const b = lookup(e)
      if (b) {
        if (b.sort === 'bv') return b.term
        throw new BvSyntaxError(`'${e}' is a Bool, used where a bit-vector is needed`)
      }
      const d = decls.get(e)
      if (d && d.kind === 'bv') return { kind: 'var', name: e, width: d.width }
      throw new BvSyntaxError(`unknown bit-vector symbol: ${e}`)
    }
    const head = e[0]
    if (Array.isArray(head)) {
      if (head[0] === '_') return parseIndexedApp(head, e.slice(1))
      throw new BvSyntaxError('unexpected nested application head')
    }
    if (head === '_') {
      const name = e[1]
      if (isSym(name) && /^bv\d+$/.test(name)) {
        const width = Number(e[2])
        if (!Number.isInteger(width) || width <= 0) throw new BvSyntaxError('bad bit-vector literal width')
        return { kind: 'const', value: mask(BigInt(name.slice(2)), width), width }
      }
      throw new BvSyntaxError(`unsupported indexed term: ${JSON.stringify(e)}`)
    }
    if (!isSym(head)) throw new BvSyntaxError('term head must be a symbol')
    const args = e.slice(1)
    if (head === 'let') return letScoped(args, parseTerm) as BvTerm
    if (head in BIN_OPS) {
      const op = BIN_OPS[head]
      const ts = args.map(parseTerm)
      let acc = ts[0]
      for (let i = 1; i < ts.length; i++) {
        sameWidth(acc, ts[i], head)
        acc = { kind: 'bin', op, a: acc, b: ts[i], width: acc.width }
      }
      return acc
    }
    if (head === 'bvnot' || head === 'bvneg') {
      const a = parseTerm(args[0])
      return { kind: 'un', op: head, arg: a, width: a.width }
    }
    if (head === 'concat') {
      const ts = args.map(parseTerm)
      return ts.reduce((a, b) => ({ kind: 'concat', a, b, width: a.width + b.width }))
    }
    if (head === 'bvcomp') {
      const a = parseTerm(args[0])
      const b = parseTerm(args[1])
      sameWidth(a, b, 'bvcomp')
      return { kind: 'bvcomp', a, b, width: 1 }
    }
    if (head === 'ite') {
      const c = parseForm(args[0])
      const t = parseTerm(args[1])
      const el = parseTerm(args[2])
      sameWidth(t, el, 'ite')
      return { kind: 'ite', c, t, e: el, width: t.width }
    }
    throw new BvSyntaxError(`'${head}' is not a known bit-vector operator`)
  }

  const parseIndexedApp = (idx: SExpr[], rest: SExpr[]): BvTerm => {
    const op = idx[1]
    const a = parseTerm(rest[0])
    if (op === 'extract') {
      const hi = Number(idx[2])
      const lo = Number(idx[3])
      if (!(lo >= 0 && hi >= lo && hi < a.width)) throw new BvSyntaxError(`bad extract bounds ${hi}:${lo} on width ${a.width}`)
      return { kind: 'extract', hi, lo, arg: a, width: hi - lo + 1 }
    }
    if (op === 'zero_extend' || op === 'sign_extend') {
      const by = Number(idx[2])
      if (!(by >= 0)) throw new BvSyntaxError('extend amount must be ≥ 0')
      return { kind: 'extend', signed: op === 'sign_extend', by, arg: a, width: a.width + by }
    }
    if (op === 'repeat') {
      const times = Number(idx[2])
      if (!(times >= 1)) throw new BvSyntaxError('repeat count must be ≥ 1')
      return { kind: 'repeat', times, arg: a, width: a.width * times }
    }
    if (op === 'rotate_left' || op === 'rotate_right') {
      return { kind: 'rotate', left: op === 'rotate_left', amount: Number(idx[2]), arg: a, width: a.width }
    }
    throw new BvSyntaxError(`unsupported indexed operator: ${String(op)}`)
  }

  // ---- formulas --------------------------------------------------------------
  const parseForm = (e: SExpr): BoolForm => {
    if (isSym(e)) {
      if (e === 'true') return { kind: 'true' }
      if (e === 'false') return { kind: 'false' }
      const b = lookup(e)
      if (b) {
        if (b.sort === 'bool') return b.form
        throw new BvSyntaxError(`'${e}' is a bit-vector, used where a Bool is needed`)
      }
      const d = decls.get(e)
      if (d && d.kind === 'bool') return { kind: 'boolvar', name: e }
      throw new BvSyntaxError(`unknown Boolean symbol: ${e}`)
    }
    const head = e[0]
    if (Array.isArray(head)) throw new BvSyntaxError('a bit-vector term cannot stand alone as a formula')
    if (!isSym(head)) throw new BvSyntaxError('formula head must be a symbol')
    const args = e.slice(1)
    switch (head) {
      case 'and': return { kind: 'and', args: args.map(parseForm) }
      case 'or': return { kind: 'or', args: args.map(parseForm) }
      case 'not': return { kind: 'not', arg: parseForm(args[0]) }
      case 'xor': return { kind: 'xor', args: args.map(parseForm) }
      case '=>': {
        const fs = args.map(parseForm)
        let acc = fs[fs.length - 1]
        for (let i = fs.length - 2; i >= 0; i--) acc = { kind: 'imp', a: fs[i], b: acc }
        return acc
      }
      case 'ite': return { kind: 'iteb', c: parseForm(args[0]), t: parseForm(args[1]), e: parseForm(args[2]) }
      case 'let': return letScoped(args, parseForm) as BoolForm
      case '=': {
        if (looksBool(args[0])) return chainForm(args.map(parseForm), (a, b) => ({ kind: 'iff', a, b }))
        const ts = args.map(parseTerm)
        for (let i = 1; i < ts.length; i++) sameWidth(ts[0], ts[i], '=')
        const parts: BoolForm[] = []
        for (let i = 0; i + 1 < ts.length; i++) parts.push({ kind: 'eq', a: ts[i], b: ts[i + 1] })
        return parts.length === 1 ? parts[0] : { kind: 'and', args: parts }
      }
      case 'distinct': {
        const ts = args.map(parseTerm)
        for (let i = 1; i < ts.length; i++) sameWidth(ts[0], ts[i], 'distinct')
        return { kind: 'distinct', args: ts }
      }
      default: {
        if (head in CMP_OPS) {
          const a = parseTerm(args[0])
          const b = parseTerm(args[1])
          sameWidth(a, b, head)
          return { kind: 'cmp', op: CMP_OPS[head], a, b }
        }
        throw new BvSyntaxError(`'${head}' is not a known predicate or connective`)
      }
    }
  }

  // ---- `let` (shared by terms and formulas) ----------------------------------
  function letScoped<T>(args: SExpr[], parseBody: (e: SExpr) => T): T {
    const binds = args[0]
    if (!Array.isArray(binds)) throw new BvSyntaxError('let bindings must be a list')
    const scope = new Map<string, Binding>()
    for (const pair of binds) {
      if (!Array.isArray(pair) || pair.length !== 2 || !isSym(pair[0])) throw new BvSyntaxError('malformed let binding')
      scope.set(pair[0], looksBool(pair[1]) ? { sort: 'bool', form: parseForm(pair[1]) } : { sort: 'bv', term: parseTerm(pair[1]) })
    }
    scopes.push(scope)
    const body = parseBody(args[1])
    scopes.pop()
    return body
  }

  // Heuristic: does this s-expr denote a Boolean (vs a bit-vector)?
  function looksBool(e: SExpr): boolean {
    if (isSym(e)) {
      if (e === 'true' || e === 'false') return true
      const b = lookup(e)
      if (b) return b.sort === 'bool'
      return decls.get(e)?.kind === 'bool'
    }
    const h = e[0]
    if (Array.isArray(h)) return false // indexed-op application ⇒ bit-vector
    if (h === 'ite') return looksBool(e[2])
    if (h === 'let') return looksBool(e[2])
    if (isSym(h)) return BOOL_HEADS.has(h)
    return false
  }

  // ---- commands --------------------------------------------------------------
  for (const form of readSExprs(tokenize(src))) {
    if (!Array.isArray(form) || form.length === 0) continue
    const head = form[0]
    if (!isSym(head)) continue
    switch (head) {
      case 'set-logic':
        if (isSym(form[1])) logic = form[1]
        break
      case 'set-info':
        if (form[1] === ':status' && isSym(form[2]) && (form[2] === 'sat' || form[2] === 'unsat')) expected = form[2]
        break
      case 'declare-const':
        decls.set(asSymbol(form[1]), parseSort(form[2]))
        break
      case 'declare-fun': {
        const argList = form[2]
        if (Array.isArray(argList) && argList.length > 0) throw new BvSyntaxError('only 0-ary declarations are supported in QF_BV')
        decls.set(asSymbol(form[1]), parseSort(form[3]))
        break
      }
      case 'assert':
        assertions.push(parseForm(form[1]))
        break
      default:
        break
    }
  }

  const bvVars = new Map<string, number>()
  const boolVars = new Set<string>()
  for (const [name, d] of decls) {
    if (d.kind === 'bv') bvVars.set(name, d.width)
    else boolVars.add(name)
  }
  return { bvVars, boolVars, assertions, expected, logic }

  // ---- small helpers ---------------------------------------------------------
  function asSymbol(e: SExpr): string {
    if (!isSym(e)) throw new BvSyntaxError('expected a symbol')
    return e
  }
  function sameWidth(a: BvTerm, b: BvTerm, op: string): void {
    if (a.width !== b.width) throw new BvSyntaxError(`${op}: width mismatch ${a.width} vs ${b.width}`)
  }
  function chainForm(fs: BoolForm[], op: (a: BoolForm, b: BoolForm) => BoolForm): BoolForm {
    const parts: BoolForm[] = []
    for (let i = 0; i + 1 < fs.length; i++) parts.push(op(fs[i], fs[i + 1]))
    return parts.length === 1 ? parts[0] : { kind: 'and', args: parts }
  }
}
