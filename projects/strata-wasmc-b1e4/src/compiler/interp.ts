import { CompileError } from './diagnostics';
import type { Block, Expr, Program, Stmt } from './ast';

// A straightforward tree-walking interpreter. Its sole purpose is to be an
// independent oracle: the test harness runs every program through both this
// interpreter and the compiled WebAssembly and asserts the printed output is
// identical at every optimization level. Integer arithmetic mirrors wasm i32
// semantics (wrapping, truncating division, saturating float->int casts) so the
// two implementations agree bit-for-bit.

export type RtValue = number | ArrayVal;
export interface ArrayVal {
  arr: true;
  elem: 'int' | 'float';
  data: number[];
}

export class Trap extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = 'Trap';
  }
}

// Signals used to unwind structured control flow.
const BREAK = Symbol('break');
const CONTINUE = Symbol('continue');
class ReturnSignal {
  readonly value: RtValue | undefined;
  constructor(value: RtValue | undefined) {
    this.value = value;
  }
}

export const i32 = (x: number): number => x | 0;
export const satTruncI32 = (x: number): number => {
  if (Number.isNaN(x)) return 0;
  if (x >= 2147483647) return 2147483647;
  if (x <= -2147483648) return -2147483648;
  return Math.trunc(x);
};

export function formatInt(x: number): string {
  return String(i32(x));
}
export function formatFloat(x: number): string {
  if (Number.isNaN(x)) return 'nan';
  if (x === Infinity) return 'inf';
  if (x === -Infinity) return '-inf';
  // Match WebAssembly f64 -> string round-tripping by deferring to the engine.
  return Object.is(x, -0) ? '0' : String(x);
}
export function formatBool(x: number): string {
  return x !== 0 ? 'true' : 'false';
}

interface Frame {
  vars: Map<string, RtValue>[];
}

export class Interpreter {
  private fns = new Map<string, Extract<Program['decls'][number], { kind: 'fn' }>>();
  private globals = new Map<string, RtValue>();
  output: string[] = [];
  private steps = 0;
  private readonly stepLimit: number;

  constructor(prog: Program, stepLimit = 50_000_000) {
    this.stepLimit = stepLimit;
    for (const d of prog.decls) {
      if (d.kind === 'fn') this.fns.set(d.name, d);
    }
    for (const d of prog.decls) {
      if (d.kind === 'global') this.globals.set(d.name, this.evalConst(d.init));
    }
  }

  /** Evaluate a global initializer in an empty environment. */
  private evalConst(e: Expr): RtValue {
    const frame: Frame = { vars: [new Map()] };
    return this.evalExpr(e, frame);
  }

  run(entry = 'main', args: RtValue[] = []): RtValue | undefined {
    const fn = this.fns.get(entry);
    if (!fn) throw new Trap(`no function '${entry}'`);
    return this.call(fn, args);
  }

  private call(fn: Extract<Program['decls'][number], { kind: 'fn' }>, args: RtValue[]): RtValue | undefined {
    const frame: Frame = { vars: [new Map()] };
    fn.params.forEach((p, i) => frame.vars[0].set(p.name, args[i]));
    try {
      this.execBlock(fn.body, frame);
    } catch (sig) {
      if (sig instanceof ReturnSignal) return sig.value;
      throw sig;
    }
    return undefined;
  }

  private tick(): void {
    if (++this.steps > this.stepLimit) throw new Trap('step limit exceeded (possible infinite loop)');
  }

  private execBlock(b: Block, f: Frame): void {
    f.vars.push(new Map());
    try {
      for (const s of b.stmts) this.execStmt(s, f);
    } finally {
      f.vars.pop();
    }
  }

  private setVar(name: string, v: RtValue, f: Frame): void {
    for (let i = f.vars.length - 1; i >= 0; i--) {
      if (f.vars[i].has(name)) {
        f.vars[i].set(name, v);
        return;
      }
    }
    if (this.globals.has(name)) {
      this.globals.set(name, v);
      return;
    }
    throw new Trap(`assign to undefined '${name}'`);
  }
  private getVar(name: string, f: Frame): RtValue {
    for (let i = f.vars.length - 1; i >= 0; i--) {
      const v = f.vars[i].get(name);
      if (v !== undefined) return v;
    }
    const g = this.globals.get(name);
    if (g !== undefined) return g;
    throw new Trap(`read of undefined '${name}'`);
  }

  private execStmt(s: Stmt, f: Frame): void {
    this.tick();
    switch (s.node) {
      case 'let':
        f.vars[f.vars.length - 1].set(s.name, this.evalExpr(s.init, f));
        break;
      case 'assign':
        this.setVar(s.name, this.evalExpr(s.value, f), f);
        break;
      case 'index-assign': {
        const target = this.evalExpr(s.target, f) as ArrayVal;
        const idx = i32(this.evalExpr(s.index, f) as number);
        const val = this.evalExpr(s.value, f) as number;
        if (idx < 0 || idx >= target.data.length) throw new Trap('array index out of bounds');
        target.data[idx] = target.elem === 'int' ? i32(val) : val;
        break;
      }
      case 'expr':
        this.evalExpr(s.expr, f);
        break;
      case 'if':
        if (this.evalExpr(s.cond, f)) this.execBlock(s.then, f);
        else if (s.otherwise) this.execBlock(s.otherwise, f);
        break;
      case 'while':
        while (this.evalExpr(s.cond, f)) {
          this.tick();
          try {
            this.execBlock(s.body, f);
          } catch (sig) {
            if (sig === BREAK) break;
            if (sig === CONTINUE) continue;
            throw sig;
          }
        }
        break;
      case 'for': {
        f.vars.push(new Map());
        try {
          if (s.init) this.execStmt(s.init, f);
          while (s.cond ? this.evalExpr(s.cond, f) : true) {
            this.tick();
            try {
              this.execBlock(s.body, f);
            } catch (sig) {
              if (sig === BREAK) break;
              if (sig !== CONTINUE) throw sig;
            }
            if (s.update) this.execStmt(s.update, f);
          }
        } finally {
          f.vars.pop();
        }
        break;
      }
      case 'return':
        throw new ReturnSignal(s.value ? this.evalExpr(s.value, f) : undefined);
      case 'break':
        throw BREAK;
      case 'continue':
        throw CONTINUE;
      case 'block':
        this.execBlock(s.block, f);
        break;
    }
  }

  private evalExpr(e: Expr, f: Frame): RtValue {
    switch (e.node) {
      case 'int':
        return i32(e.value);
      case 'float':
        return e.value;
      case 'bool':
        return e.value ? 1 : 0;
      case 'ident':
        return this.getVar(e.name, f);
      case 'unary':
        return this.evalUnary(e, f);
      case 'binary':
        return this.evalBinary(e, f);
      case 'index': {
        const target = this.evalExpr(e.target, f) as ArrayVal;
        const idx = i32(this.evalExpr(e.index, f) as number);
        if (idx < 0 || idx >= target.data.length) throw new Trap('array index out of bounds');
        return target.data[idx];
      }
      case 'call':
        return this.evalCall(e, f);
    }
  }

  private evalUnary(e: Extract<Expr, { node: 'unary' }>, f: Frame): RtValue {
    const v = this.evalExpr(e.operand, f) as number;
    const isInt = e.operand.ty?.kind === 'int' || e.operand.ty?.kind === 'bool';
    switch (e.op) {
      case '-':
        return isInt ? i32(-v) : -v;
      case '+':
        return v;
      case '!':
        return v ? 0 : 1;
      case '~':
        return i32(~v);
    }
  }

  private evalBinary(e: Extract<Expr, { node: 'binary' }>, f: Frame): RtValue {
    // Short-circuit logical operators.
    if (e.op === '&&') return this.evalExpr(e.left, f) ? (this.evalExpr(e.right, f) ? 1 : 0) : 0;
    if (e.op === '||') return this.evalExpr(e.left, f) ? 1 : (this.evalExpr(e.right, f) ? 1 : 0);

    const a = this.evalExpr(e.left, f) as number;
    const b = this.evalExpr(e.right, f) as number;
    const isInt = e.left.ty?.kind === 'int' || e.left.ty?.kind === 'bool';
    switch (e.op) {
      case '+':
        return isInt ? i32(a + b) : a + b;
      case '-':
        return isInt ? i32(a - b) : a - b;
      case '*':
        return isInt ? Math.imul(a, b) : a * b;
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
      case '&':
        return i32(a & b);
      case '|':
        return i32(a | b);
      case '^':
        return i32(a ^ b);
      case '<<':
        return i32(a << (b & 31));
      case '>>':
        return i32(a >> (b & 31));
      case '<':
        return a < b ? 1 : 0;
      case '<=':
        return a <= b ? 1 : 0;
      case '>':
        return a > b ? 1 : 0;
      case '>=':
        return a >= b ? 1 : 0;
      case '==':
        return a === b ? 1 : 0;
      case '!=':
        return a !== b ? 1 : 0;
    }
  }

  private evalCall(e: Extract<Expr, { node: 'call' }>, f: Frame): RtValue {
    const name = e.callee;
    if (name === 'print') {
      const v = this.evalExpr(e.args[0], f) as number;
      const k = e.args[0].ty?.kind;
      this.output.push(k === 'float' ? formatFloat(v) : k === 'bool' ? formatBool(v) : formatInt(v));
      return 0;
    }
    if (name === 'int') {
      const v = this.evalExpr(e.args[0], f) as number;
      const k = e.args[0].ty?.kind;
      return k === 'float' ? satTruncI32(v) : i32(v);
    }
    if (name === 'float') {
      return this.evalExpr(e.args[0], f) as number;
    }
    if (name === 'int_array' || name === 'float_array') {
      const n = i32(this.evalExpr(e.args[0], f) as number);
      if (n < 0) throw new Trap('negative array length');
      return { arr: true, elem: name === 'int_array' ? 'int' : 'float', data: new Array(n).fill(0) };
    }
    if (name === 'len') {
      return (this.evalExpr(e.args[0], f) as ArrayVal).data.length;
    }
    const fn = this.fns.get(name);
    if (!fn) throw new Trap(`call to undefined '${name}'`);
    const args = e.args.map((a) => this.evalExpr(a, f));
    const r = this.call(fn, args);
    return r === undefined ? 0 : r;
  }
}

export function interpret(prog: Program, entry = 'main'): { output: string[]; result: RtValue | undefined; error?: string } {
  const interp = new Interpreter(prog);
  try {
    const result = interp.run(entry);
    return { output: interp.output, result };
  } catch (e) {
    if (e instanceof Trap) return { output: interp.output, result: undefined, error: e.message };
    if (e instanceof CompileError) throw e;
    return { output: interp.output, result: undefined, error: String(e) };
  }
}
