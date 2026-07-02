// A tiny, forgiving textual format for alternating automata, so the panel can
// let you *write* one. Positive boolean formulas only — negation is intentionally
// absent (that is the whole point of alternation: complement comes from the dual,
// not from ¬ in the transition).
//
//   # comments and blank lines are ignored
//   alphabet: a b            (or "a, b"; optional — inferred from the rules)
//   init: q0                 (a positive boolean formula: & | ( ) true false)
//   q0, a -> q0 & q1         (a transition:  <state> , <symbol> -> <formula>)
//   q0, b -> q0
//   q1, a -> q1
//   q1, b -> q1
//   final: q1                (space/comma list; may be empty)
//
// A missing (state, symbol) rule defaults to ⊥ (a dead obligation). Any
// identifier appearing anywhere becomes a state, in first-seen order.

import { BF_FALSE, bfAnd, bfOr, bfVar, type BF, type AFA } from './afa';

export interface AfaParseError {
  message: string;
  line: number; // 1-based
}

export interface AfaParseResult {
  afa: AFA | null;
  error: AfaParseError | null;
}

interface RawTransition {
  state: string;
  symbol: string;
  expr: string;
  line: number;
}

const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;

// ── Formula tokeniser + recursive-descent parser (over known state names) ────

type Tok = { t: 'id'; v: string } | { t: '&' } | { t: '|' } | { t: '(' } | { t: ')' };

function lexFormula(src: string): Tok[] | { error: string } {
  const toks: Tok[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (/\s/.test(c)) {
      i++;
      continue;
    }
    if (c === '&' || c === '∧') {
      toks.push({ t: '&' });
      i++;
    } else if (c === '|' || c === '∨') {
      toks.push({ t: '|' });
      i++;
    } else if (c === '(') {
      toks.push({ t: '(' });
      i++;
    } else if (c === ')') {
      toks.push({ t: ')' });
      i++;
    } else if (c === '~' || c === '!' || c === '¬') {
      return { error: 'negation is not allowed in an AFA transition (formulas are positive — use the complement/dual instead)' };
    } else if (/[A-Za-z0-9_]/.test(c)) {
      let j = i;
      while (j < src.length && /[A-Za-z0-9_]/.test(src[j])) j++;
      toks.push({ t: 'id', v: src.slice(i, j) });
      i = j;
    } else {
      return { error: `unexpected character '${c}'` };
    }
  }
  return toks;
}

function parseFormula(src: string, index: (name: string) => number | null): BF | { error: string } {
  const lexed = lexFormula(src);
  if ('error' in lexed) return lexed;
  const toks = lexed;
  let p = 0;
  const peek = () => toks[p];
  let failure: string | null = null;

  // expr := term ('|' term)*  ;  term := factor ('&' factor)*
  const parseAtom = (): BF => {
    const tk = peek();
    if (!tk) {
      failure ??= 'unexpected end of formula';
      return BF_FALSE;
    }
    if (tk.t === '(') {
      p++;
      const e = parseExpr();
      if (peek()?.t === ')') p++;
      else failure ??= "missing ')'";
      return e;
    }
    if (tk.t === 'id') {
      p++;
      const lc = tk.v.toLowerCase();
      if (lc === 'true' || lc === '1' || lc === '⊤') return { k: 'true' };
      if (lc === 'false' || lc === '0' || lc === '⊥') return BF_FALSE;
      const q = index(tk.v);
      if (q === null) {
        failure ??= `unknown state '${tk.v}'`;
        return BF_FALSE;
      }
      return bfVar(q);
    }
    failure ??= 'expected a state, ⊤/⊥ or (';
    return BF_FALSE;
  };
  const parseTerm = (): BF => {
    let e = parseAtom();
    while (peek()?.t === '&') {
      p++;
      e = bfAnd(e, parseAtom());
    }
    return e;
  };
  const parseExpr = (): BF => {
    let e = parseTerm();
    while (peek()?.t === '|') {
      p++;
      e = bfOr(e, parseTerm());
    }
    return e;
  };

  const result = parseExpr();
  if (p < toks.length) failure ??= 'trailing tokens after the formula';
  if (failure) return { error: failure };
  return result;
}

// ── The line-oriented driver ─────────────────────────────────────────────────

function identsIn(expr: string): string[] {
  const out: string[] = [];
  for (const m of expr.matchAll(/[A-Za-z_][A-Za-z0-9_]*/g)) {
    const v = m[0];
    const lc = v.toLowerCase();
    if (lc === 'true' || lc === 'false') continue;
    out.push(v);
  }
  return out;
}

export function parseAFA(source: string): AfaParseResult {
  const lines = source.split(/\r?\n/);
  let initExpr: string | null = null;
  let initLine = 0;
  const finalNames: string[] = [];
  const declaredSymbols: string[] = [];
  const transitions: RawTransition[] = [];

  for (let li = 0; li < lines.length; li++) {
    const rawLine = lines[li];
    const line = rawLine.replace(/#.*$/, '').trim();
    if (line === '') continue;
    const lower = line.toLowerCase();

    if (lower.startsWith('alphabet:')) {
      const rest = line.slice(line.indexOf(':') + 1);
      for (const s of rest.split(/[,\s]+/).filter(Boolean)) {
        if ([...s].length !== 1) return err(`alphabet symbols must be single characters (got '${s}')`, li + 1);
        if (!declaredSymbols.includes(s)) declaredSymbols.push(s);
      }
      continue;
    }
    if (lower.startsWith('init:')) {
      initExpr = line.slice(line.indexOf(':') + 1).trim();
      initLine = li + 1;
      continue;
    }
    if (lower.startsWith('final:')) {
      const rest = line.slice(line.indexOf(':') + 1);
      for (const nm of rest.split(/[,\s]+/).filter(Boolean)) {
        if (!IDENT.test(nm)) return err(`invalid state name in final: '${nm}'`, li + 1);
        finalNames.push(nm);
      }
      continue;
    }

    // A transition:  state , symbol -> formula
    const arrow = line.indexOf('->');
    if (arrow < 0) return err(`expected a transition 'state, symbol -> formula' (or a header line)`, li + 1);
    const lhs = line.slice(0, arrow).trim();
    const expr = line.slice(arrow + 2).trim();
    const parts = lhs.split(/[,\s]+/).filter(Boolean);
    if (parts.length !== 2) return err(`the left of -> must be 'state, symbol' (got '${lhs}')`, li + 1);
    const [state, symbol] = parts;
    if (!IDENT.test(state)) return err(`invalid state name '${state}'`, li + 1);
    if ([...symbol].length !== 1) return err(`the symbol must be a single character (got '${symbol}')`, li + 1);
    if (expr === '') return err('the transition formula is empty', li + 1);
    if (!declaredSymbols.includes(symbol)) declaredSymbols.push(symbol);
    transitions.push({ state, symbol, expr, line: li + 1 });
  }

  if (initExpr === null) return err("missing an 'init:' line (the initial formula)", 1);
  if (declaredSymbols.length === 0) return err('the alphabet is empty — declare one or add a transition', 1);

  // Collect state names in first-seen order: init, then transitions (LHS + RHS), then final.
  const nameOrder: string[] = [];
  const seenName = new Set<string>();
  const add = (nm: string) => {
    if (!seenName.has(nm)) {
      seenName.add(nm);
      nameOrder.push(nm);
    }
  };
  for (const nm of identsIn(initExpr)) add(nm);
  for (const t of transitions) {
    add(t.state);
    for (const nm of identsIn(t.expr)) add(nm);
  }
  for (const nm of finalNames) add(nm);

  if (nameOrder.length === 0) return err('no states — the init formula and transitions mention none', initLine || 1);

  const index = new Map(nameOrder.map((nm, i) => [nm, i]));
  const idx = (nm: string): number | null => (index.has(nm) ? index.get(nm)! : null);
  const n = nameOrder.length;
  const symbols = declaredSymbols;

  const initBF = parseFormula(initExpr, idx);
  if ('error' in initBF) return err(`in init: ${initBF.error}`, initLine || 1);

  const delta: BF[][] = Array.from({ length: n }, () => symbols.map(() => BF_FALSE));
  for (const t of transitions) {
    const q = idx(t.state)!;
    const si = symbols.indexOf(t.symbol);
    const bf = parseFormula(t.expr, idx);
    if ('error' in bf) return err(`in rule for (${t.state}, ${t.symbol}): ${bf.error}`, t.line);
    delta[q][si] = bf;
  }

  const final = nameOrder.map((nm) => finalNames.includes(nm));
  const afa: AFA = { n, names: nameOrder, symbols, init: initBF, delta, final };
  return { afa, error: null };
}

function err(message: string, line: number): AfaParseResult {
  return { afa: null, error: { message, line } };
}

/** Serialise an AFA back to the textual format (for closure results, the gallery, …). */
export function afaToSource(afa: AFA): string {
  const bfStr = (f: BF): string => {
    switch (f.k) {
      case 'true':
        return 'true';
      case 'false':
        return 'false';
      case 'var':
        return afa.names[f.q];
      case 'and':
        return `${wrap(f.a)} & ${wrap(f.b)}`;
      case 'or':
        return `${bfStr(f.a)} | ${bfStr(f.b)}`;
    }
  };
  const wrap = (f: BF): string => (f.k === 'or' ? `(${bfStr(f)})` : bfStr(f));
  const lines: string[] = [];
  lines.push(`alphabet: ${afa.symbols.join(' ')}`);
  lines.push(`init: ${bfStr(afa.init)}`);
  for (let q = 0; q < afa.n; q++) {
    for (let si = 0; si < afa.symbols.length; si++) {
      const f = afa.delta[q][si];
      if (f.k === 'false') continue;
      lines.push(`${afa.names[q]}, ${afa.symbols[si]} -> ${bfStr(f)}`);
    }
  }
  const fin = afa.names.filter((_, q) => afa.final[q]);
  lines.push(`final: ${fin.join(' ')}`);
  return lines.join('\n');
}
