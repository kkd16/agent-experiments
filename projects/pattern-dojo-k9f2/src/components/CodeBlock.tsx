import { useMemo, useState } from "react";

const KEYWORDS = new Set([
  "def", "return", "if", "elif", "else", "for", "while", "in", "not", "and",
  "or", "class", "import", "from", "None", "True", "False", "break", "continue",
  "lambda", "yield", "with", "as", "pass", "self", "is", "global", "nonlocal",
  // JavaScript keywords (harmless for Python snippets — these words don't appear there)
  "function", "const", "let", "var", "new", "of", "typeof", "null", "undefined",
  "this", "void", "delete", "instanceof", "do", "switch", "case", "default",
]);

const BUILTINS = new Set([
  "range", "len", "enumerate", "max", "min", "sum", "sorted", "set", "dict",
  "list", "int", "str", "float", "abs", "map", "filter", "zip", "print",
  "deque", "heapq", "heappush", "heappop", "heapify", "setdefault", "append",
  "pop", "popleft", "add", "remove", "reverse", "get",
  // JavaScript built-ins / common methods
  "Math", "Map", "Set", "Array", "Number", "Infinity", "NaN", "Object", "String",
  "push", "shift", "unshift", "slice", "splice", "join", "split", "has", "fill",
]);

interface Token {
  text: string;
  cls?: string;
}

/** A tiny, dependency-free Python tokenizer good enough for teaching snippets. */
function tokenize(code: string): Token[] {
  const tokens: Token[] = [];
  // order matters: comments, strings, numbers, identifiers, punctuation
  const re =
    /(#[^\n]*)|("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*')|(\b\d+(?:\.\d+)?\b)|([A-Za-z_][A-Za-z0-9_]*)|([(){}[\]:,.;=+\-*/%<>!&|^~@]+)|(\s+)/g;
  let m: RegExpExecArray | null;
  let last = 0;
  while ((m = re.exec(code)) !== null) {
    if (m.index > last) tokens.push({ text: code.slice(last, m.index) });
    last = re.lastIndex;
    if (m[1]) tokens.push({ text: m[1], cls: "tok-com" });
    else if (m[2]) tokens.push({ text: m[2], cls: "tok-str" });
    else if (m[3]) tokens.push({ text: m[3], cls: "tok-num" });
    else if (m[4]) {
      const w = m[4];
      if (KEYWORDS.has(w)) tokens.push({ text: w, cls: "tok-kw" });
      else if (BUILTINS.has(w)) tokens.push({ text: w, cls: "tok-fn" });
      else tokens.push({ text: w });
    } else if (m[5]) tokens.push({ text: m[5], cls: "tok-punc" });
    else tokens.push({ text: m[6] });
  }
  if (last < code.length) tokens.push({ text: code.slice(last) });
  return tokens;
}

interface Props {
  code: string;
  label?: string;
  lang?: string;
}

export default function CodeBlock({ code, label, lang = "python" }: Props) {
  const tokens = useMemo(() => tokenize(code), [code]);
  const [copied, setCopied] = useState(false);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      setTimeout(() => setCopied(false), 1400);
    } catch {
      /* clipboard may be blocked */
    }
  };

  return (
    <div className="codeblock">
      <div className="codeblock-head">
        <span>{label ?? lang}</span>
        <button className="copy" onClick={copy}>
          {copied ? "✓ copied" : "copy"}
        </button>
      </div>
      <pre>
        <code>
          {tokens.map((t, i) =>
            t.cls ? (
              <span key={i} className={t.cls}>
                {t.text}
              </span>
            ) : (
              <span key={i}>{t.text}</span>
            ),
          )}
        </code>
      </pre>
    </div>
  );
}
