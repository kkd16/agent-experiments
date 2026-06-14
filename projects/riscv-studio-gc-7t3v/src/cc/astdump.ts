// A readable, indented dump of the user AST for the Compiler tab's "AST" panel. Purely for
// display — it walks the parsed program and renders functions, statements and expressions.

import { typeName } from './ctype';
import type { Program, Stmt, Expr } from './ast';

export function dumpProgram(prog: Program): string {
  const out: string[] = [];
  for (const g of prog.globals) {
    out.push(`global ${g.name}: ${typeName(g.type)}${g.init ? ' = ' + expr(g.init) : ''}`);
  }
  if (prog.globals.length) out.push('');
  for (const f of prog.funcs) {
    const params = f.params.map((p) => `${p.name}: ${typeName(p.type)}`).join(', ');
    out.push(`fn ${f.name}(${params}${f.variadic ? ', ...' : ''}) -> ${typeName(f.retType)}`);
    if (f.body) for (const s of f.body.stmts) stmt(s, 1, out);
    else out.push('  (prototype)');
    out.push('');
  }
  return out.join('\n');
}

function pad(d: number): string {
  return '  '.repeat(d);
}

function stmt(s: Stmt, d: number, out: string[]): void {
  switch (s.kind) {
    case 'block':
      out.push(`${pad(d)}{`);
      for (const st of s.stmts) stmt(st, d + 1, out);
      out.push(`${pad(d)}}`);
      break;
    case 'decl':
      for (const v of s.decls)
        out.push(`${pad(d)}let ${v.name}: ${typeName(v.type)}${v.init ? ' = ' + expr(v.init) : ''}`);
      break;
    case 'expr':
      out.push(`${pad(d)}${expr(s.expr)}`);
      break;
    case 'if':
      out.push(`${pad(d)}if (${expr(s.cond)})`);
      stmt(s.then, d + 1, out);
      if (s.els) {
        out.push(`${pad(d)}else`);
        stmt(s.els, d + 1, out);
      }
      break;
    case 'while':
      out.push(`${pad(d)}while (${expr(s.cond)})`);
      stmt(s.body, d + 1, out);
      break;
    case 'dowhile':
      out.push(`${pad(d)}do`);
      stmt(s.body, d + 1, out);
      out.push(`${pad(d)}while (${expr(s.cond)})`);
      break;
    case 'for':
      out.push(`${pad(d)}for (…; ${s.cond ? expr(s.cond) : ''}; ${s.step ? expr(s.step) : ''})`);
      if (s.init) stmt(s.init, d + 1, out);
      stmt(s.body, d + 1, out);
      break;
    case 'return':
      out.push(`${pad(d)}return${s.expr ? ' ' + expr(s.expr) : ''}`);
      break;
    case 'break':
      out.push(`${pad(d)}break`);
      break;
    case 'continue':
      out.push(`${pad(d)}continue`);
      break;
    case 'empty':
      break;
  }
}

function expr(e: Expr): string {
  switch (e.kind) {
    case 'num':
      return String(e.value);
    case 'str':
      return JSON.stringify(e.value);
    case 'ident':
      return e.name;
    case 'call':
      return `${expr(e.callee)}(${e.args.map(expr).join(', ')})`;
    case 'unary':
      return `${e.op}(${expr(e.operand)})`;
    case 'binary':
      return `(${expr(e.lhs)} ${e.op} ${expr(e.rhs)})`;
    case 'logical':
      return `(${expr(e.lhs)} ${e.op} ${expr(e.rhs)})`;
    case 'assign':
      return `(${expr(e.target)} ${e.op ?? ''}= ${expr(e.value)})`;
    case 'cond':
      return `(${expr(e.cond)} ? ${expr(e.then)} : ${expr(e.els)})`;
    case 'comma':
      return `(${expr(e.lhs)}, ${expr(e.rhs)})`;
    case 'member':
      return `${expr(e.obj)}${e.arrow ? '->' : '.'}${e.name}`;
    case 'index':
      return `${expr(e.base)}[${expr(e.index)}]`;
    case 'cast':
      return `(${typeName(e.toType)})${expr(e.operand)}`;
    case 'sizeof':
      return `sizeof(${e.argType ? typeName(e.argType) : expr(e.argExpr!)})`;
    case 'va_arg':
      return `va_arg(${expr(e.ap)}, ${typeName(e.argType)})`;
    case 'vactl':
      return `va_${e.which}(${expr(e.ap)}${e.last ? ', ' + expr(e.last) : ''})`;
  }
}
