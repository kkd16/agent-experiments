import type { Block, Expr, Program, Stmt, StructDecl, Ty } from './ast';
import type { Span } from './diagnostics';
import type { ArrayVal, RtValue, StructVal } from './interp';
import { Trap, asI64, callBuiltin, formatBool, formatFloat, formatInt, formatLong, I64_MIN, i32 } from './interp';

// A generator-based, single-stepping tree-walking interpreter — the engine
// behind the Debug tab. It mirrors the reference interpreter's semantics (and
// shares its entire builtin library via `callBuiltin`, so the two cannot
// disagree about a builtin), but it *pauses* before every statement and steps
// *into* user function calls, exposing the live call stack, every variable in
// scope, and the program output as it is produced.
//
// Execution is driven by a generator: `execStmt` sets the current span and
// `yield`s before running each statement; the UI calls `.next()` to advance one
// statement at a time (or in a tight loop, to "run"). Expressions evaluate
// through generators too, so a function call buried inside an expression still
// steps into the callee.

interface RVar {
  v: RtValue;
  ty: Ty;
}
interface RFrame {
  fn: string;
  scopes: Map<string, RVar>[];
  span: Span;
}

class ReturnSignal {
  readonly value: RtValue | undefined;
  constructor(value: RtValue | undefined) {
    this.value = value;
  }
}
const BREAK = Symbol('break');
const CONTINUE = Symbol('continue');

export interface VarView {
  name: string;
  value: string;
  ty: string;
}
export interface FrameView {
  fn: string;
  line: number;
  col: number;
  vars: VarView[];
}
export interface DebugState {
  line: number;
  col: number;
  stack: FrameView[]; // outermost first, current frame last
  globals: VarView[];
  output: string[];
  steps: number;
  done: boolean;
  error?: string;
  result?: string;
}

function tyKindName(t: Ty): string {
  if (t.kind === 'array') return `${t.elem.kind}[]`;
  if (t.kind === 'struct') return t.name;
  return t.kind;
}

function fmtVal(v: RtValue, ty?: Ty): string {
  if (v === null) return 'null';
  if (typeof v === 'string') return JSON.stringify(v);
  if (typeof v === 'bigint') return formatLong(v);
  if (typeof v === 'object' && (v as StructVal).struct !== undefined) {
    const sv = v as StructVal;
    const parts = [...sv.fields.entries()].slice(0, 6).map(([k, fv]) => `${k}: ${fmtVal(fv)}`);
    const more = sv.fields.size > 6 ? ', …' : '';
    return `${sv.struct} { ${parts.join(', ')}${more} }`;
  }
  if (typeof v === 'object' && (v as ArrayVal).arr) {
    const a = v as ArrayVal;
    const head = a.data.slice(0, 8).map((x) =>
      a.elem === 'str' ? JSON.stringify(x)
      : a.elem === 'float' ? formatFloat(x as number)
      : a.elem === 'long' ? formatLong(x as bigint)
      : formatInt(x as number),
    );
    const more = a.data.length > 8 ? ', …' : '';
    return `[${head.join(', ')}${more}]`;
  }
  if (ty?.kind === 'bool') return formatBool(v as number);
  if (ty?.kind === 'float') return formatFloat(v as number);
  return formatInt(v as number);
}

export class Debugger {
  private fns = new Map<string, Extract<Program['decls'][number], { kind: 'fn' }>>();
  private structs = new Map<string, StructDecl>();
  private globals = new Map<string, RVar>();
  private frames: RFrame[] = [];
  output: string[] = [];
  steps = 0;
  done = false;
  error?: string;
  result?: RtValue;
  private gen: Generator<void, void, void> | null = null;
  private readonly stepLimit: number;

  constructor(prog: Program, entry = 'main', stepLimit = 5_000_000) {
    this.stepLimit = stepLimit;
    for (const d of prog.decls) {
      if (d.kind === 'fn') this.fns.set(d.name, d);
      else if (d.kind === 'struct') this.structs.set(d.name, d);
    }
    for (const d of prog.decls) {
      if (d.kind === 'global') {
        const v = drain(this.evalExpr(d.init, this.syntheticFrame()));
        this.globals.set(d.name, { v, ty: d.resolvedTy ?? { kind: 'int' } });
      }
    }
    const fn = this.fns.get(entry);
    if (fn) {
      this.gen = this.run(fn);
      this.step(); // advance to the first statement so the UI opens "paused" on it
    } else {
      this.done = true;
      this.error = `no function '${entry}'`;
    }
  }

  private syntheticFrame(): RFrame {
    return { fn: '<init>', scopes: [new Map()], span: { start: 0, end: 0, line: 1, col: 1 } };
  }

  /** Advance one statement. Returns false when the program has finished. */
  step(): boolean {
    if (this.done || !this.gen) return false;
    try {
      const r = this.gen.next();
      if (r.done) {
        this.done = true;
        this.gen = null;
      }
    } catch (e) {
      this.done = true;
      this.gen = null;
      this.error = e instanceof Trap ? e.message : String((e as Error)?.message ?? e);
    }
    return !this.done;
  }

  /** Run to completion (or the step budget), capping iterations to stay responsive. */
  runToEnd(maxSteps = 2_000_000): void {
    let n = 0;
    while (!this.done && n++ < maxSteps) this.step();
  }

  state(): DebugState {
    const top = this.frames[this.frames.length - 1];
    return {
      line: top ? top.span.line : -1,
      col: top ? top.span.col : -1,
      stack: this.frames.map((f) => ({
        fn: f.fn,
        line: f.span.line,
        col: f.span.col,
        vars: this.frameVars(f),
      })),
      globals: [...this.globals.entries()].map(([name, rv]) => ({ name, value: fmtVal(rv.v, rv.ty), ty: tyKindName(rv.ty) })),
      output: this.output,
      steps: this.steps,
      done: this.done,
      error: this.error,
      result: this.done && this.result !== undefined ? fmtVal(this.result) : undefined,
    };
  }

  private frameVars(f: RFrame): VarView[] {
    const seen = new Map<string, RVar>();
    // innermost scope wins (shadowing), but show the value actually visible
    for (const sc of f.scopes) for (const [k, rv] of sc) seen.set(k, rv);
    return [...seen.entries()].map(([name, rv]) => ({ name, value: fmtVal(rv.v, rv.ty), ty: tyKindName(rv.ty) }));
  }

  // --- execution ---

  private *run(fn: Extract<Program['decls'][number], { kind: 'fn' }>): Generator<void, void, void> {
    this.result = yield* this.call(fn, []);
  }

  private *call(
    fn: Extract<Program['decls'][number], { kind: 'fn' }>,
    args: RtValue[],
  ): Generator<void, RtValue | undefined, void> {
    const frame: RFrame = { fn: fn.name, scopes: [new Map()], span: fn.span };
    fn.params.forEach((p, i) => frame.scopes[0].set(p.name, { v: args[i], ty: p.ty }));
    this.frames.push(frame);
    let ret: RtValue | undefined;
    try {
      yield* this.execBlock(fn.body, frame);
    } catch (sig) {
      if (sig instanceof ReturnSignal) ret = sig.value;
      else {
        this.frames.pop();
        throw sig;
      }
    }
    this.frames.pop();
    return ret;
  }

  private tick(): void {
    if (++this.steps > this.stepLimit) throw new Trap('step limit exceeded (possible infinite loop)');
  }

  private *execBlock(b: Block, f: RFrame): Generator<void, void, void> {
    f.scopes.push(new Map());
    try {
      for (const s of b.stmts) yield* this.execStmt(s, f);
    } finally {
      f.scopes.pop();
    }
  }

  private declare(f: RFrame, name: string, v: RtValue, ty: Ty): void {
    f.scopes[f.scopes.length - 1].set(name, { v, ty });
  }
  private lookup(name: string, f: RFrame): RVar | undefined {
    for (let i = f.scopes.length - 1; i >= 0; i--) {
      const rv = f.scopes[i].get(name);
      if (rv) return rv;
    }
    return this.globals.get(name);
  }

  private *execStmt(s: Stmt, f: RFrame): Generator<void, void, void> {
    this.tick();
    f.span = s.span;
    yield; // pause: this statement is about to execute
    switch (s.node) {
      case 'let': {
        const v = yield* this.evalExpr(s.init, f);
        this.declare(f, s.name, v, s.resolvedTy ?? { kind: 'int' });
        break;
      }
      case 'assign': {
        const v = yield* this.evalExpr(s.value, f);
        const rv = this.lookup(s.name, f);
        if (!rv) throw new Trap(`assign to undefined '${s.name}'`);
        rv.v = v;
        break;
      }
      case 'index-assign': {
        const target = (yield* this.evalExpr(s.target, f)) as ArrayVal;
        const idx = i32((yield* this.evalExpr(s.index, f)) as number);
        const val = yield* this.evalExpr(s.value, f);
        if (idx < 0 || idx >= target.data.length) throw new Trap('array index out of bounds');
        if (target.elem === 'str') target.data[idx] = val as string;
        else if (target.elem === 'long') target.data[idx] = asI64(val as bigint);
        else target.data[idx] = target.elem === 'int' ? i32(val as number) : (val as number);
        break;
      }
      case 'member-assign': {
        const obj = yield* this.evalExpr(s.target, f);
        if (obj === null) throw new Trap('field assignment on a null struct');
        (obj as StructVal).fields.set(s.field, yield* this.evalExpr(s.value, f));
        break;
      }
      case 'expr':
        yield* this.evalExpr(s.expr, f);
        break;
      case 'if': {
        const c = yield* this.evalExpr(s.cond, f);
        if (c) yield* this.execBlock(s.then, f);
        else if (s.otherwise) yield* this.execBlock(s.otherwise, f);
        break;
      }
      case 'while':
        while (yield* this.evalExpr(s.cond, f)) {
          this.tick();
          try {
            yield* this.execBlock(s.body, f);
          } catch (sig) {
            if (sig === BREAK) break;
            if (sig === CONTINUE) continue;
            throw sig;
          }
        }
        break;
      case 'switch': {
        const d = i32((yield* this.evalExpr(s.disc, f)) as number);
        let matched = false;
        for (const c of s.cases) {
          if (c.nums!.includes(d)) {
            yield* this.execBlock(c.body, f);
            matched = true;
            break;
          }
        }
        if (!matched && s.default) yield* this.execBlock(s.default, f);
        break;
      }
      case 'for': {
        f.scopes.push(new Map());
        try {
          if (s.init) yield* this.execStmt(s.init, f);
          while (s.cond ? yield* this.evalExpr(s.cond, f) : true) {
            this.tick();
            try {
              yield* this.execBlock(s.body, f);
            } catch (sig) {
              if (sig === BREAK) break;
              if (sig !== CONTINUE) throw sig;
            }
            if (s.update) yield* this.execStmt(s.update, f);
          }
        } finally {
          f.scopes.pop();
        }
        break;
      }
      case 'return':
        throw new ReturnSignal(s.value ? yield* this.evalExpr(s.value, f) : undefined);
      case 'break':
        throw BREAK;
      case 'continue':
        throw CONTINUE;
      case 'block':
        yield* this.execBlock(s.block, f);
        break;
    }
  }

  private *evalExpr(e: Expr, f: RFrame): Generator<void, RtValue, void> {
    switch (e.node) {
      case 'int':
        return i32(e.value);
      case 'long':
        return asI64(e.value);
      case 'float':
        return e.value;
      case 'bool':
        return e.value ? 1 : 0;
      case 'string':
        return e.value;
      case 'null':
        return null;
      case 'member': {
        const obj = yield* this.evalExpr(e.target, f);
        if (obj === null) throw new Trap('field access on a null struct');
        return (obj as StructVal).fields.get(e.field)!;
      }
      case 'ident': {
        const rv = this.lookup(e.name, f);
        if (!rv) throw new Trap(`read of undefined '${e.name}'`);
        return rv.v;
      }
      case 'unary': {
        if (e.operand.ty?.kind === 'long') {
          const lv = (yield* this.evalExpr(e.operand, f)) as bigint;
          switch (e.op) {
            case '-': return asI64(-lv);
            case '+': return lv;
            case '~': return asI64(~lv);
            case '!': return lv ? 0 : 1;
          }
          return 0n;
        }
        const v = (yield* this.evalExpr(e.operand, f)) as number;
        const isInt = e.operand.ty?.kind === 'int' || e.operand.ty?.kind === 'bool';
        switch (e.op) {
          case '-': return isInt ? i32(-v) : -v;
          case '+': return v;
          case '!': return v ? 0 : 1;
          case '~': return i32(~v);
        }
        return 0;
      }
      case 'binary':
        return yield* this.evalBinary(e, f);
      case 'index': {
        const target = yield* this.evalExpr(e.target, f);
        const idx = i32((yield* this.evalExpr(e.index, f)) as number);
        if (typeof target === 'string') {
          if (idx < 0 || idx >= target.length) throw new Trap('string index out of bounds');
          return target.charCodeAt(idx);
        }
        const arr = target as ArrayVal;
        if (idx < 0 || idx >= arr.data.length) throw new Trap('array index out of bounds');
        return arr.data[idx];
      }
      case 'ternary':
        return (yield* this.evalExpr(e.cond, f)) ? yield* this.evalExpr(e.then, f) : yield* this.evalExpr(e.otherwise, f);
      case 'call':
        return yield* this.evalCall(e, f);
    }
  }

  private *evalBinary(e: Extract<Expr, { node: 'binary' }>, f: RFrame): Generator<void, RtValue, void> {
    if (e.op === '&&') return (yield* this.evalExpr(e.left, f)) ? ((yield* this.evalExpr(e.right, f)) ? 1 : 0) : 0;
    if (e.op === '||') return (yield* this.evalExpr(e.left, f)) ? 1 : (yield* this.evalExpr(e.right, f)) ? 1 : 0;

    if (e.op === '==' || e.op === '!=') {
      const lk = e.left.ty?.kind;
      const rk = e.right.ty?.kind;
      if (lk === 'struct' || lk === 'null' || rk === 'struct' || rk === 'null') {
        const a = yield* this.evalExpr(e.left, f);
        const b = yield* this.evalExpr(e.right, f);
        const eq = a === b;
        return (e.op === '==' ? eq : !eq) ? 1 : 0;
      }
    }

    if (e.left.ty?.kind === 'str') {
      const sa = (yield* this.evalExpr(e.left, f)) as string;
      const sb = (yield* this.evalExpr(e.right, f)) as string;
      switch (e.op) {
        case '+': return sa + sb;
        case '==': return sa === sb ? 1 : 0;
        case '!=': return sa !== sb ? 1 : 0;
        case '<': return sa < sb ? 1 : 0;
        case '<=': return sa <= sb ? 1 : 0;
        case '>': return sa > sb ? 1 : 0;
        case '>=': return sa >= sb ? 1 : 0;
        default: throw new Trap(`unsupported string operator '${e.op}'`);
      }
    }

    if (e.left.ty?.kind === 'long') return yield* this.evalLongBinary(e, f);

    const a = (yield* this.evalExpr(e.left, f)) as number;
    const b = (yield* this.evalExpr(e.right, f)) as number;
    const isInt = e.left.ty?.kind === 'int' || e.left.ty?.kind === 'bool';
    switch (e.op) {
      case '+': return isInt ? i32(a + b) : a + b;
      case '-': return isInt ? i32(a - b) : a - b;
      case '*': return isInt ? Math.imul(a, b) : a * b;
      case '/':
        if (isInt) {
          if (b === 0) throw new Trap('integer divide by zero');
          if (a === -2147483648 && b === -1) throw new Trap('integer overflow');
          return i32(Math.trunc(a / b));
        }
        return a / b;
      case '%':
        if (b === 0) throw new Trap('integer divide by zero');
        if (a === -2147483648 && b === -1) return 0;
        return i32(a % b);
      case '&': return i32(a & b);
      case '|': return i32(a | b);
      case '^': return i32(a ^ b);
      case '<<': return i32(a << (b & 31));
      case '>>': return i32(a >> (b & 31));
      case '<': return a < b ? 1 : 0;
      case '<=': return a <= b ? 1 : 0;
      case '>': return a > b ? 1 : 0;
      case '>=': return a >= b ? 1 : 0;
      case '==': return a === b ? 1 : 0;
      case '!=': return a !== b ? 1 : 0;
    }
    return 0;
  }

  private *evalLongBinary(e: Extract<Expr, { node: 'binary' }>, f: RFrame): Generator<void, RtValue, void> {
    const a = (yield* this.evalExpr(e.left, f)) as bigint;
    const b = (yield* this.evalExpr(e.right, f)) as bigint;
    switch (e.op) {
      case '+': return asI64(a + b);
      case '-': return asI64(a - b);
      case '*': return asI64(a * b);
      case '/':
        if (b === 0n) throw new Trap('integer divide by zero');
        if (a === I64_MIN && b === -1n) throw new Trap('integer overflow');
        return asI64(a / b);
      case '%':
        if (b === 0n) throw new Trap('integer divide by zero');
        if (a === I64_MIN && b === -1n) return 0n;
        return asI64(a % b);
      case '&': return asI64(a & b);
      case '|': return asI64(a | b);
      case '^': return asI64(a ^ b);
      case '<<': return asI64(a << (b & 63n));
      case '>>': return asI64(a >> (b & 63n));
      case '<': return a < b ? 1 : 0;
      case '<=': return a <= b ? 1 : 0;
      case '>': return a > b ? 1 : 0;
      case '>=': return a >= b ? 1 : 0;
      case '==': return a === b ? 1 : 0;
      case '!=': return a !== b ? 1 : 0;
      default: return 0;
    }
  }

  private *evalCall(e: Extract<Expr, { node: 'call' }>, f: RFrame): Generator<void, RtValue, void> {
    const argv: RtValue[] = [];
    for (const a of e.args) argv.push(yield* this.evalExpr(a, f));
    const sd = this.structs.get(e.callee);
    if (sd) {
      const fields = new Map<string, RtValue>();
      sd.fields.forEach((fld, i) => fields.set(fld.name, argv[i]));
      return { struct: e.callee, fields };
    }
    const argKinds = e.args.map((a) => a.ty?.kind);
    const b = callBuiltin(e.callee, argv, argKinds, this.output);
    if (b.handled) return b.value;
    const fn = this.fns.get(e.callee);
    if (!fn) throw new Trap(`call to undefined '${e.callee}'`);
    const r = yield* this.call(fn, argv);
    return r === undefined ? 0 : r;
  }
}

// Run a generator to completion, discarding pauses (used for global initializers).
function drain(gen: Generator<void, RtValue, void>): RtValue {
  let r = gen.next();
  while (!r.done) r = gen.next();
  return r.value;
}
