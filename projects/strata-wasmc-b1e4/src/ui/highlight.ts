// A tolerant syntax highlighter for the editor overlay. Unlike the compiler's
// lexer it never throws and it preserves whitespace and comments, classifying
// every character so the rendered <pre> lines up exactly with the <textarea>.

export interface Tok {
  cls: string;
  text: string;
}

const KEYWORDS = new Set(['fn', 'let', 'if', 'else', 'while', 'do', 'for', 'switch', 'case', 'default', 'return', 'break', 'continue', 'struct']);
const CONSTS = new Set(['true', 'false', 'null']);
const TYPES = new Set(['int', 'long', 'float', 'f32', 'bool', 'str', 'void']);
const BUILTINS = new Set([
  'print', 'int_array', 'long_array', 'float_array', 'f32_array', 'str_array', 'struct_array', 'len', 'str', 'char', 'substr', 'index_of',
  'to_upper', 'to_lower', 'repeat', 'trim', 'replace', 'find', 'contains', 'starts_with',
  'ends_with', 'parse_int', 'parse_float', 'split', 'join', 'popcount', 'clz', 'ctz', 'rotl', 'rotr',
  'sqrt', 'floor', 'ceil', 'trunc', 'round', 'abs', 'fmin', 'fmax', 'copysign', 'f32',
  'exp', 'expm1', 'ln', 'log2', 'log10', 'log1p', 'sin', 'cos', 'tan',
  'asin', 'acos', 'atan', 'atan2', 'sinh', 'cosh', 'tanh', 'cbrt', 'pow', 'hypot', 'fmod',
]);

const isDigit = (c: string) => c >= '0' && c <= '9';
const isIdentStart = (c: string) => (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || c === '_';
const isIdentPart = (c: string) => isIdentStart(c) || isDigit(c);

export function highlight(src: string): Tok[] {
  const out: Tok[] = [];
  let i = 0;
  const n = src.length;
  const push = (cls: string, text: string) => out.push({ cls, text });

  while (i < n) {
    const c = src[i];
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r') {
      let j = i + 1;
      while (j < n && (src[j] === ' ' || src[j] === '\t' || src[j] === '\n' || src[j] === '\r')) j++;
      push('ws', src.slice(i, j));
      i = j;
      continue;
    }
    if (c === '/' && src[i + 1] === '/') {
      let j = i + 2;
      while (j < n && src[j] !== '\n') j++;
      push('comment', src.slice(i, j));
      i = j;
      continue;
    }
    if (c === '/' && src[i + 1] === '*') {
      let j = i + 2;
      while (j < n && !(src[j] === '*' && src[j + 1] === '/')) j++;
      j = Math.min(n, j + 2);
      push('comment', src.slice(i, j));
      i = j;
      continue;
    }
    if (c === '"') {
      let j = i + 1;
      while (j < n && src[j] !== '"' && src[j] !== '\n') {
        if (src[j] === '\\') j++; // skip escaped char
        j++;
      }
      if (src[j] === '"') j++;
      push('str', src.slice(i, j));
      i = j;
      continue;
    }
    if (isDigit(c) || (c === '.' && isDigit(src[i + 1] ?? ''))) {
      let j = i;
      if (c === '0' && (src[i + 1] === 'x' || src[i + 1] === 'X')) {
        j = i + 2;
        while (j < n && /[0-9a-fA-F]/.test(src[j])) j++;
      } else {
        while (j < n && (isDigit(src[j]) || src[j] === '.' || src[j] === 'e' || src[j] === 'E' || ((src[j] === '+' || src[j] === '-') && (src[j - 1] === 'e' || src[j - 1] === 'E')))) j++;
      }
      if (src[j] === 'L' || src[j] === 'l') j++; // long suffix
      push('num', src.slice(i, j));
      i = j;
      continue;
    }
    if (isIdentStart(c)) {
      let j = i + 1;
      while (j < n && isIdentPart(src[j])) j++;
      const word = src.slice(i, j);
      let k = j;
      while (k < n && (src[k] === ' ' || src[k] === '\t')) k++;
      const isCall = src[k] === '(';
      let cls = 'ident';
      if (KEYWORDS.has(word)) cls = 'kw';
      else if (CONSTS.has(word)) cls = 'const';
      else if (TYPES.has(word)) cls = 'type';
      else if (BUILTINS.has(word)) cls = 'builtin';
      else if (isCall) cls = 'fn';
      push(cls, word);
      i = j;
      continue;
    }
    // operators / punctuation
    let j = i + 1;
    const two = src.slice(i, i + 2);
    if (['->', '==', '!=', '<=', '>=', '&&', '||', '<<', '>>'].includes(two)) j = i + 2;
    const text = src.slice(i, j);
    const cls = '(){}[],;'.includes(text) ? 'punct' : 'op';
    push(cls, text);
    i = j;
  }
  return out;
}
