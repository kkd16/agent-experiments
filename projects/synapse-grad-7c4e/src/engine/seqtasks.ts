// Procedural sequence tasks for the Transformer lab. Every example is generated on the fly
// from a seeded RNG — there is no bundled dataset. Each task is a tiny algorithmic problem
// posed as a token sequence "<prompt> = <answer>", so a decoder-only language model can be
// trained on it with next-token prediction and graded by exact-match on the answer span.
//
// Vocabulary (fixed, 12 tokens): digits 0–9, then '+' and '='. The same vocab covers every
// task, which keeps the embedding table and the UI legible.

export const TOKENS = ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9', '+', '='] as const;
export const VOCAB = TOKENS.length;
export const TOK_PLUS = 10;
export const TOK_EQ = 11;

export function tokenLabel(id: number): string {
  return id >= 0 && id < TOKENS.length ? TOKENS[id] : '?';
}

export function tokensToString(ids: ArrayLike<number>): string {
  let s = '';
  for (let i = 0; i < ids.length; i++) s += tokenLabel(ids[i]);
  return s;
}

export type SeqTaskKind = 'copy' | 'reverse' | 'sort' | 'add';

export interface SeqTaskInfo {
  kind: SeqTaskKind;
  label: string;
  blurb: string;
}

export const SEQ_TASKS: SeqTaskInfo[] = [
  { kind: 'copy', label: 'Copy', blurb: 'echo the digits back unchanged' },
  { kind: 'reverse', label: 'Reverse', blurb: 'emit the digits in reverse order' },
  { kind: 'sort', label: 'Sort', blurb: 'sort the digits ascending' },
  { kind: 'add', label: 'Add', blurb: 'add two n-digit numbers' },
];

// One worked example. `tokens` is the whole "<prompt> = <answer>" sequence; the answer span
// is [answerStart, answerEnd). Decoding feeds tokens[0..answerStart) as the prompt and must
// reproduce tokens[answerStart..answerEnd).
export interface SeqSample {
  tokens: Int32Array;
  answerStart: number;
  answerEnd: number;
}

function randDigits(n: number, rng: () => number): number[] {
  const out: number[] = [];
  for (let i = 0; i < n; i++) out.push(Math.floor(rng() * 10));
  return out;
}

// Largest sequence length a task of width n can produce — used to size the position table.
export function maxSeqLen(kind: SeqTaskKind, n: number): number {
  switch (kind) {
    case 'copy':
    case 'reverse':
    case 'sort':
      return 2 * n + 1; // n digits + '=' + n digits
    case 'add':
      return 3 * n + 3; // a(n) + '+' + b(n) + '=' + sum(n+1)
  }
}

export function makeSample(kind: SeqTaskKind, n: number, rng: () => number): SeqSample {
  if (kind === 'add') {
    const a = randDigits(n, rng);
    const b = randDigits(n, rng);
    const av = a.reduce((s, d) => s * 10 + d, 0);
    const bv = b.reduce((s, d) => s * 10 + d, 0);
    const sumStr = (av + bv).toString().padStart(n + 1, '0');
    const sum = sumStr.split('').map((c) => c.charCodeAt(0) - 48);
    const seq = [...a, TOK_PLUS, ...b, TOK_EQ, ...sum];
    const answerStart = a.length + 1 + b.length + 1;
    return { tokens: Int32Array.from(seq), answerStart, answerEnd: seq.length };
  }
  const digits = randDigits(n, rng);
  let answer: number[];
  if (kind === 'copy') answer = digits.slice();
  else if (kind === 'reverse') answer = digits.slice().reverse();
  else answer = digits.slice().sort((x, y) => x - y);
  const seq = [...digits, TOK_EQ, ...answer];
  const answerStart = digits.length + 1;
  return { tokens: Int32Array.from(seq), answerStart, answerEnd: seq.length };
}

// Pretty one-line rendering of a sample, e.g. "37+58=095" or "5 3 1 = 1 3 5".
export function formatSample(s: SeqSample): { prompt: string; answer: string } {
  return {
    prompt: tokensToString(s.tokens.subarray(0, s.answerStart)),
    answer: tokensToString(s.tokens.subarray(s.answerStart, s.answerEnd)),
  };
}
