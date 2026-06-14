// Cosmetic C syntax highlighting for the Compiler tab's editor. It reuses the studio's
// existing `tok-*` colour classes (comment/string/char/directive/mnemonic/reg/num/punct).
// Block comments are tracked across lines; anything unrecognised falls back to plain text.

export interface HlToken {
  value: string;
  kind: string;
}

const TYPE_KW = new Set(['int', 'char', 'void', 'struct', 'unsigned', 'signed', 'const', 'static', 'va_list']);
const CTRL_KW = new Set([
  'if',
  'else',
  'while',
  'for',
  'do',
  'return',
  'break',
  'continue',
  'sizeof',
  'va_start',
  'va_arg',
  'va_end',
]);

function isIdentStart(c: string): boolean {
  return /[A-Za-z_]/.test(c);
}
function isIdentPart(c: string): boolean {
  return /[A-Za-z0-9_]/.test(c);
}
function isDigit(c: string): boolean {
  return c >= '0' && c <= '9';
}

/** Tokenize a whole source into per-line token arrays for the highlight overlay. */
export function highlightC(source: string): HlToken[][] {
  const lines: HlToken[][] = [[]];
  let cur = lines[0];
  let i = 0;
  const n = source.length;
  let inBlock = false;

  const push = (value: string, kind: string) => {
    // values may contain newlines (block comments / strings shouldn't, but be safe)
    const parts = value.split('\n');
    for (let p = 0; p < parts.length; p++) {
      if (p > 0) {
        cur = [];
        lines.push(cur);
      }
      if (parts[p].length) cur.push({ value: parts[p], kind });
    }
  };

  while (i < n) {
    const c = source[i];

    if (c === '\n') {
      cur = [];
      lines.push(cur);
      i++;
      continue;
    }

    if (inBlock) {
      const end = source.indexOf('*/', i);
      if (end === -1) {
        push(source.slice(i), 'comment');
        break;
      }
      push(source.slice(i, end + 2), 'comment');
      i = end + 2;
      inBlock = false;
      continue;
    }

    // line comment
    if (c === '/' && source[i + 1] === '/') {
      const nl = source.indexOf('\n', i);
      const end = nl === -1 ? n : nl;
      push(source.slice(i, end), 'comment');
      i = end;
      continue;
    }
    // block comment start
    if (c === '/' && source[i + 1] === '*') {
      inBlock = true;
      continue;
    }
    // preprocessor
    if (c === '#') {
      const nl = source.indexOf('\n', i);
      const end = nl === -1 ? n : nl;
      push(source.slice(i, end), 'directive');
      i = end;
      continue;
    }
    // string / char
    if (c === '"' || c === "'") {
      const quote = c;
      let j = i + 1;
      while (j < n && source[j] !== quote && source[j] !== '\n') {
        if (source[j] === '\\') j++;
        j++;
      }
      j = Math.min(j + 1, n);
      push(source.slice(i, j), quote === '"' ? 'string' : 'char');
      i = j;
      continue;
    }
    // number
    if (isDigit(c)) {
      let j = i;
      while (j < n && /[0-9a-fA-FxX]/.test(source[j])) j++;
      push(source.slice(i, j), 'num');
      i = j;
      continue;
    }
    // identifier / keyword
    if (isIdentStart(c)) {
      let j = i;
      while (j < n && isIdentPart(source[j])) j++;
      const word = source.slice(i, j);
      let k = j;
      while (k < n && (source[k] === ' ' || source[k] === '\t')) k++;
      let kind = 'text';
      if (TYPE_KW.has(word)) kind = 'reg';
      else if (CTRL_KW.has(word)) kind = 'mnemonic';
      else if (source[k] === '(') kind = 'label'; // call or definition
      push(word, kind);
      i = j;
      continue;
    }
    // whitespace
    if (c === ' ' || c === '\t' || c === '\r') {
      let j = i;
      while (j < n && (source[j] === ' ' || source[j] === '\t' || source[j] === '\r')) j++;
      push(source.slice(i, j), 'text');
      i = j;
      continue;
    }
    // punctuation
    push(c, 'punct');
    i++;
  }

  return lines;
}
