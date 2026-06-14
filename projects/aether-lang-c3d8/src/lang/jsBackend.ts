// Aether — JavaScript backend
//
// A *second* compilation target beside the bytecode VM. Where `compiler.ts`
// lowers the AST to stack-machine bytecode, this module lowers the very same
// (prelude-wrapped) AST to readable, self-contained JavaScript and can run it
// directly in the browser.
//
// The generated code is paired with a tiny runtime that mirrors the VM's value
// model exactly — tagged ints/floats so `show` formats them identically, the
// same structural comparison used by `==`/`<`, the same turtle effect log — so
// the JS backend's result, printed output and drawing match the VM byte-for-byte.
//
// Compilation is a straightforward syntax-directed translation:
//   - functions are curried single-argument arrow functions (application is `f(x)`)
//   - `let` / `let rec` / `type` flatten into a `const` spine at the top level and
//     into block-scoped IIFEs when nested in an expression
//   - `match` becomes a chain of pattern tests with block-scoped bindings
//   - every binder is alpha-renamed to a unique JS identifier, so Aether's free
//     shadowing (`let x = … in let x = …`, prelude overrides) never collides.

import type { BinaryOp, Expr, Pattern, UnaryOp } from './ast.ts'
import { parse } from './parser.ts'
import { GLOBALS, PRELUDE_DEFS } from './prelude.ts'

// ---------------------------------------------------------------------------
// Runtime — emitted verbatim ahead of the compiled program. Defines the tagged
// value constructors, structural compare/show (ports of values.ts), and every
// primitive (`$print`, `$head`, the turtle ops, …) as a curried function.
// `OUT` and `EFFECTS` are provided by the wrapper that executes the module.
// ---------------------------------------------------------------------------
export const RUNTIME = `// — Aether runtime (mirrors the VM value model) —
class AErr extends Error {}
const U = { tag: 'unit' };
const NIL = { tag: 'nil' };
const I = (n) => ({ tag: 'int', n: n | 0 });
const F = (n) => ({ tag: 'float', n });
const S = (s) => ({ tag: 'str', s });
const cons = (head, tail) => ({ tag: 'cons', head, tail });
const T = (items) => ({ tag: 'tuple', items });
const D = (name, args) => ({ tag: 'data', name, args });
const R = (fields) => ({ tag: 'record', fields });

const listFromArr = (xs) => { let a = NIL; for (let i = xs.length - 1; i >= 0; i--) a = cons(xs[i], a); return a; };
const listToArr = (v) => { const out = []; while (v.tag === 'cons') { out.push(v.head); v = v.tail; } return out; };

const tagOf = (v) => (typeof v === 'boolean' ? 'bool' : typeof v === 'function' ? 'fn' : v.tag);

function cmp(a, b) {
  const ta = tagOf(a), tb = tagOf(b);
  if (ta !== tb) {
    if ((ta === 'int' || ta === 'float') && (tb === 'int' || tb === 'float')) return Math.sign(a.n - b.n);
    throw new AErr('cannot compare ' + ta + ' with ' + tb);
  }
  switch (ta) {
    case 'int': case 'float': return Math.sign(a.n - b.n);
    case 'bool': return (a ? 1 : 0) - (b ? 1 : 0);
    case 'str': return a.s < b.s ? -1 : a.s > b.s ? 1 : 0;
    case 'unit': case 'nil': return 0;
    case 'cons': {
      let x = a, y = b;
      while (x.tag === 'cons' && y.tag === 'cons') { const c = cmp(x.head, y.head); if (c !== 0) return c; x = x.tail; y = y.tail; }
      return (x.tag === 'cons' ? 1 : 0) - (y.tag === 'cons' ? 1 : 0);
    }
    case 'tuple': {
      const n = Math.min(a.items.length, b.items.length);
      for (let i = 0; i < n; i++) { const c = cmp(a.items[i], b.items[i]); if (c !== 0) return c; }
      return a.items.length - b.items.length;
    }
    case 'data': {
      if (a.name !== b.name) return a.name < b.name ? -1 : 1;
      const n = Math.min(a.args.length, b.args.length);
      for (let i = 0; i < n; i++) { const c = cmp(a.args[i], b.args[i]); if (c !== 0) return c; }
      return a.args.length - b.args.length;
    }
    case 'record': {
      const keys = Object.keys(a.fields).sort();
      for (const k of keys) { const c = cmp(a.fields[k], b.fields[k]); if (c !== 0) return c; }
      return 0;
    }
    default: throw new AErr('cannot compare functions');
  }
}
const eq = (a, b) => cmp(a, b) === 0;
const ne = (a, b) => cmp(a, b) !== 0;
const lt = (a, b) => cmp(a, b) < 0;
const gt = (a, b) => cmp(a, b) > 0;
const le = (a, b) => cmp(a, b) <= 0;
const ge = (a, b) => cmp(a, b) >= 0;

const addI = (a, b) => I(a.n + b.n);
const subI = (a, b) => I(a.n - b.n);
const mulI = (a, b) => I(a.n * b.n);
const divI = (a, b) => { if (b.n === 0) throw new AErr('division by zero'); return I(Math.trunc(a.n / b.n)); };
const modI = (a, b) => { if (b.n === 0) throw new AErr('modulo by zero'); return I(a.n % b.n); };
const negI = (a) => I(-a.n);
const addF = (a, b) => F(a.n + b.n);
const subF = (a, b) => F(a.n - b.n);
const mulF = (a, b) => F(a.n * b.n);
const divF = (a, b) => F(a.n / b.n);
const concatL = (a, b) => listFromArr(listToArr(a).concat(listToArr(b)));
const strcat = (a, b) => S(a.s + b.s);

function fmtFloat(n) { return Number.isInteger(n) ? n.toFixed(1) : String(n); }
function showVal(v) {
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (typeof v === 'function') return '<fn>';
  switch (v.tag) {
    case 'int': return String(v.n);
    case 'float': return fmtFloat(v.n);
    case 'str': return JSON.stringify(v.s);
    case 'unit': return '()';
    case 'nil': return '[]';
    case 'cons': return '[' + listToArr(v).map(showVal).join(', ') + ']';
    case 'tuple': return '(' + v.items.map(showVal).join(', ') + ')';
    case 'record': return '{ ' + Object.entries(v.fields).map(([k, x]) => k + ' = ' + showVal(x)).join(', ') + ' }';
    case 'data': {
      if (v.args.length === 0) return v.name;
      return v.name + ' ' + v.args.map((a) => {
        const s = showVal(a);
        return a && a.tag === 'data' && a.args.length > 0 ? '(' + s + ')' : s;
      }).join(' ');
    }
    default: return String(v);
  }
}

// — primitives —
const $print = (a) => { OUT.push(a && a.tag === 'str' ? a.s : showVal(a)); return U; };
const $show = (a) => S(showVal(a));
const $head = (v) => { if (v.tag === 'cons') return v.head; throw new AErr('head: empty list'); };
const $tail = (v) => { if (v.tag === 'cons') return v.tail; throw new AErr('tail: empty list'); };
const $empty = (v) => v.tag === 'nil';
const $sqrt = (a) => F(Math.sqrt(a.n));
const $sin = (a) => F(Math.sin(a.n));
const $cos = (a) => F(Math.cos(a.n));
const $floor = (a) => I(Math.floor(a.n));
const $toFloat = (a) => F(a.n);
const $strlen = (a) => I(a.s.length);
const $toUpper = (a) => S(a.s.toUpperCase());
const $toLower = (a) => S(a.s.toLowerCase());
const $chars = (a) => listFromArr([...a.s].map(S));
const $join = (sep) => (xs) => S(listToArr(xs).map((x) => x.s).join(sep.s));
const $parseInt = (a) => { const n = parseInt(a.s, 10); return I(Number.isNaN(n) ? 0 : n); };
const $abs = (a) => I(Math.abs(a.n));
const $min = (a) => (b) => (cmp(a, b) <= 0 ? a : b);
const $max = (a) => (b) => (cmp(a, b) >= 0 ? a : b);
const $forward = (a) => { EFFECTS.push({ op: 'forward', dist: a.n }); return U; };
const $back = (a) => { EFFECTS.push({ op: 'back', dist: a.n }); return U; };
const $turn = (a) => { EFFECTS.push({ op: 'turn', deg: a.n }); return U; };
const $width = (a) => { EFFECTS.push({ op: 'width', w: a.n }); return U; };
const $penUp = (_a) => { EFFECTS.push({ op: 'penUp' }); return U; };
const $penDown = (_a) => { EFFECTS.push({ op: 'penDown' }); return U; };
const $push = (_a) => { EFFECTS.push({ op: 'push' }); return U; };
const $pop = (_a) => { EFFECTS.push({ op: 'pop' }); return U; };
const $clear = (_a) => { EFFECTS.push({ op: 'clear' }); return U; };
const $color = (r) => (g) => (b) => { EFFECTS.push({ op: 'color', r: r.n | 0, g: g.n | 0, b: b.n | 0 }); return U; };
const $pi = F(Math.PI);`

// ---------------------------------------------------------------------------
// Compiler
// ---------------------------------------------------------------------------

type Env = Map<string, string>

/** Map an Aether identifier to a safe JS identifier base (`$`-prefixed). */
function mangle(name: string): string {
  return '$' + name.replace(/[^A-Za-z0-9_$]/g, (c) => '_' + c.charCodeAt(0) + '_')
}

const BUILTIN_NAMES = GLOBALS.map((g) => g.name)

// Parse each prelude definition once (independent of the VM pipeline).
const PRELUDE_PARSED = PRELUDE_DEFS.map((d) => ({
  name: d.name,
  recursive: d.recursive,
  value: parse(d.src),
}))

export interface JsModule {
  /** the fixed runtime preamble (value model + primitives) */
  runtime: string
  /** the standard library, compiled to JS `const`s */
  prelude: string
  /** the user's program, compiled to JS `const`s ending in `__result` */
  user: string
  /** a complete, executable function body returning { result, output, effects } */
  full: string
}

class JsGen {
  private used = new Set<string>()

  /** Allocate a globally-unique JS name for an Aether binder. */
  fresh(name: string): string {
    const base = mangle(name)
    let cand = base
    let k = 1
    while (this.used.has(cand)) cand = `${base}_${k++}`
    this.used.add(cand)
    return cand
  }

  seedBuiltins(): Env {
    const env: Env = new Map()
    for (const name of BUILTIN_NAMES) {
      const j = mangle(name)
      this.used.add(j)
      env.set(name, j)
    }
    return env
  }

  // Consume a run of `let` / `let rec` / `type` bindings, pushing JS `const`
  // statements and returning the trailing (non-binding) expression + scope.
  private spine(node: Expr, env: Env, out: string[]): { node: Expr; env: Env } {
    let cur = node
    let scope = env
    for (;;) {
      if (cur.kind === 'let') {
        if (cur.recursive) {
          const j = this.fresh(cur.name)
          scope = extend(scope, cur.name, j)
          out.push(`const ${j} = ${this.expr(cur.value, scope)};`)
        } else {
          const code = this.expr(cur.value, scope)
          const j = this.fresh(cur.name)
          scope = extend(scope, cur.name, j)
          out.push(`const ${j} = ${code};`)
        }
        cur = cur.body
      } else if (cur.kind === 'letrec') {
        const names = cur.bindings.map((b) => {
          const j = this.fresh(b.name)
          scope = extend(scope, b.name, j)
          return j
        })
        cur.bindings.forEach((b, i) => out.push(`const ${names[i]} = ${this.expr(b.value, scope)};`))
        cur = cur.body
      } else if (cur.kind === 'typedecl') {
        for (const ctor of cur.ctors) {
          const j = this.fresh(ctor.name)
          scope = extend(scope, ctor.name, j)
          out.push(this.ctorBinding(j, ctor.name, ctor.args.length))
        }
        cur = cur.body
      } else {
        return { node: cur, env: scope }
      }
    }
  }

  private ctorBinding(jsName: string, ctorName: string, arity: number): string {
    const tag = JSON.stringify(ctorName)
    if (arity === 0) return `const ${jsName} = D(${tag}, []);`
    const params = Array.from({ length: arity }, (_, i) => `a${i}`)
    const body = params.reduceRight((acc, p) => `(${p}) => ${acc}`, `D(${tag}, [${params.join(', ')}])`)
    return `const ${jsName} = ${body};`
  }

  /** Compile the whole user program into a statement list (ends with `__result`). */
  topLevel(ast: Expr, env: Env): string {
    const out: string[] = []
    const { node, env: env2 } = this.spine(ast, env, out)
    out.push(`const __result = ${this.expr(node, env2)};`)
    return out.join('\n')
  }

  /** Compile the prelude definitions into a statement list. */
  preludeStatements(env: Env): { code: string; env: Env } {
    const out: string[] = []
    let scope = env
    for (const def of PRELUDE_PARSED) {
      if (def.recursive) {
        const j = this.fresh(def.name)
        scope = extend(scope, def.name, j)
        out.push(`const ${j} = ${this.expr(def.value, scope)};`)
      } else {
        const code = this.expr(def.value, scope)
        const j = this.fresh(def.name)
        scope = extend(scope, def.name, j)
        out.push(`const ${j} = ${code};`)
      }
    }
    return { code: out.join('\n'), env: scope }
  }

  // A `let`/`type` spine in expression position becomes a single block IIFE.
  private blockExpr(e: Expr, env: Env): string {
    const out: string[] = []
    const { node, env: env2 } = this.spine(e, env, out)
    return `(() => { ${out.join(' ')} return ${this.expr(node, env2)}; })()`
  }

  expr(e: Expr, env: Env): string {
    switch (e.kind) {
      case 'int':
        return `I(${e.value})`
      case 'float':
        return `F(${e.value})`
      case 'bool':
        return e.value ? 'true' : 'false'
      case 'str':
        return `S(${JSON.stringify(e.value)})`
      case 'unit':
        return 'U'
      case 'var': {
        const j = env.get(e.name)
        return j ?? mangle(e.name)
      }
      case 'lambda': {
        const j = this.fresh(e.param)
        return `(${j}) => ${this.expr(e.body, extend(env, e.param, j))}`
      }
      case 'app':
        return `${this.expr(e.fn, env)}(${this.expr(e.arg, env)})`
      case 'let':
      case 'letrec':
      case 'typedecl':
        return this.blockExpr(e, env)
      case 'if':
        return `(${this.expr(e.cond, env)} ? ${this.expr(e.then, env)} : ${this.expr(e.else, env)})`
      case 'binop':
        return this.binop(e.op, this.expr(e.left, env), this.expr(e.right, env))
      case 'unop':
        return this.unop(e.op, this.expr(e.operand, env))
      case 'list':
        return `listFromArr([${e.elements.map((x) => this.expr(x, env)).join(', ')}])`
      case 'tuple':
        return `T([${e.elements.map((x) => this.expr(x, env)).join(', ')}])`
      case 'seq':
        return `(${this.expr(e.first, env)}, ${this.expr(e.rest, env)})`
      case 'record':
        return `R({ ${e.fields.map((f) => `${JSON.stringify(f.label)}: ${this.expr(f.value, env)}`).join(', ')} })`
      case 'field':
        return `(${this.expr(e.record, env)}).fields[${JSON.stringify(e.label)}]`
      case 'recordUpdate':
        return `R({ ...(${this.expr(e.record, env)}).fields, ${e.fields
          .map((f) => `${JSON.stringify(f.label)}: ${this.expr(f.value, env)}`)
          .join(', ')} })`
      case 'match':
        return this.match(e, env)
    }
  }

  private match(e: Extract<Expr, { kind: 'match' }>, env: Env): string {
    const scrut = `$$s${this.scrutId++}`
    const lines: string[] = []
    for (const c of e.cases) {
      const { tests, binds, env: env2 } = this.pattern(c.pattern, scrut, env)
      const cond = tests.length ? tests.join(' && ') : 'true'
      const body: string[] = [...binds]
      if (c.guard) {
        body.push(`if (${this.expr(c.guard, env2)}) return ${this.expr(c.body, env2)};`)
      } else {
        body.push(`return ${this.expr(c.body, env2)};`)
      }
      lines.push(`if (${cond}) { ${body.join(' ')} }`)
    }
    lines.push(`throw new AErr('match: no pattern matched the value');`)
    return `((${scrut}) => { ${lines.join(' ')} })(${this.expr(e.scrutinee, env)})`
  }

  private scrutId = 0

  // Lower a pattern against a JS access expression into boolean tests + the
  // `const` bindings its variables introduce (and the extended scope).
  private pattern(pat: Pattern, access: string, env: Env): { tests: string[]; binds: string[]; env: Env } {
    const tests: string[] = []
    const binds: string[] = []
    let scope = env
    const go = (p: Pattern, acc: string): void => {
      switch (p.kind) {
        case 'pwild':
        case 'punit':
          return
        case 'pvar': {
          const j = this.fresh(p.name)
          scope = extend(scope, p.name, j)
          binds.push(`const ${j} = ${acc};`)
          return
        }
        case 'pint':
        case 'pfloat':
          tests.push(`${acc}.n === ${p.value}`)
          return
        case 'pbool':
          tests.push(`${acc} === ${p.value}`)
          return
        case 'pstr':
          tests.push(`${acc}.s === ${JSON.stringify(p.value)}`)
          return
        case 'pnil':
          tests.push(`${acc}.tag === 'nil'`)
          return
        case 'pcons':
          tests.push(`${acc}.tag === 'cons'`)
          go(p.head, `${acc}.head`)
          go(p.tail, `${acc}.tail`)
          return
        case 'ptuple':
          p.elements.forEach((el, i) => go(el, `${acc}.items[${i}]`))
          return
        case 'pcon':
          tests.push(`${acc}.tag === 'data' && ${acc}.name === ${JSON.stringify(p.name)}`)
          p.args.forEach((a, i) => go(a, `${acc}.args[${i}]`))
          return
      }
    }
    go(pat, access)
    return { tests, binds, env: scope }
  }

  private binop(op: BinaryOp, l: string, r: string): string {
    switch (op) {
      case '+':
        return `addI(${l}, ${r})`
      case '-':
        return `subI(${l}, ${r})`
      case '*':
        return `mulI(${l}, ${r})`
      case '/':
        return `divI(${l}, ${r})`
      case '%':
        return `modI(${l}, ${r})`
      case '+.':
        return `addF(${l}, ${r})`
      case '-.':
        return `subF(${l}, ${r})`
      case '*.':
        return `mulF(${l}, ${r})`
      case '/.':
        return `divF(${l}, ${r})`
      case '==':
        return `eq(${l}, ${r})`
      case '!=':
        return `ne(${l}, ${r})`
      case '<':
        return `lt(${l}, ${r})`
      case '>':
        return `gt(${l}, ${r})`
      case '<=':
        return `le(${l}, ${r})`
      case '>=':
        return `ge(${l}, ${r})`
      case '&&':
        return `(${l} && ${r})`
      case '||':
        return `(${l} || ${r})`
      case '::':
        return `cons(${l}, ${r})`
      case '++':
        return `concatL(${l}, ${r})`
      case '^':
        return `strcat(${l}, ${r})`
    }
  }

  private unop(op: UnaryOp, x: string): string {
    return op === '-' ? `negI(${x})` : `(!${x})`
  }
}

function extend(env: Env, name: string, jsName: string): Env {
  const next = new Map(env)
  next.set(name, jsName)
  return next
}

/** Compile a user AST (already optimized/desugared) to a JS module. */
export function compileToJs(userAst: Expr): JsModule {
  const gen = new JsGen()
  const env0 = gen.seedBuiltins()
  const { code: prelude, env: env1 } = gen.preludeStatements(env0)
  const user = gen.topLevel(userAst, env1)
  const full = [
    'const OUT = [], EFFECTS = [];',
    RUNTIME,
    '// — standard library —',
    prelude,
    '// — your program —',
    user,
    'return { result: showVal(__result), output: OUT, effects: EFFECTS };',
  ].join('\n')
  return { runtime: RUNTIME, prelude, user, full }
}

export interface JsRunResult {
  result: string | null
  output: string[]
  effects: unknown[]
  error: string | null
}

/** Execute a compiled module body in the host JS engine, sandboxed in try/catch. */
export function runJsModule(full: string): JsRunResult {
  try {
    const fn = new Function(full) as () => { result: string; output: string[]; effects: unknown[] }
    const { result, output, effects } = fn()
    return { result, output, effects, error: null }
  } catch (e) {
    return {
      result: null,
      output: [],
      effects: [],
      error: e instanceof Error ? e.message : String(e),
    }
  }
}
