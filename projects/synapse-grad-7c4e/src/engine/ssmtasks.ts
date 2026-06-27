// Procedural sequence tasks for the State-Space (Mamba) lab. Like the Transformer lab's
// `seqtasks.ts`, every example is generated on the fly from a seeded RNG — no bundled data —
// and posed as a "<prompt> = <answer>" token sequence a causal language model learns by
// next-token prediction, graded by exact-match on the answer span. But where `seqtasks` are
// arithmetic, these are chosen to probe the things that *separate* a selective SSM from an LTI
// one (and from attention):
//
//   • copy            — the baseline: echo the digits back.
//   • selective-copy  — the Mamba paper's flagship synthetic: a long field of mostly *blanks*
//                       with a few data tokens scattered through it; reproduce just the data,
//                       in order. Solvable only by *content-based selection* (skip the blanks) —
//                       a linear-time-invariant SSM (S4) provably cannot do it; selective S6 can.
//   • induction       — associative recall (MQAR): a list of key→value pairs, then a query key;
//                       output its value. The canonical in-context-learning / "induction head"
//                       probe, and the task long-range SSMs are benchmarked on.
//   • reverse         — emit the digits in reverse (a second long-range dependency).
//
// Shared 13-token vocab keeps every task legible and the embedding table small.

export const TOKENS = ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9', '·', '=', '?'] as const;
export const VOCAB = TOKENS.length;
export const TOK_BLANK = 10;
export const TOK_EQ = 11;
export const TOK_QUERY = 12;

export function tokenLabel(id: number): string {
  return id >= 0 && id < TOKENS.length ? TOKENS[id] : '?';
}

export function tokensToString(ids: ArrayLike<number>): string {
  let s = '';
  for (let i = 0; i < ids.length; i++) s += tokenLabel(ids[i]);
  return s;
}

export type SsmTaskKind = 'copy' | 'selective' | 'induction' | 'reverse';

export interface SsmTaskInfo {
  kind: SsmTaskKind;
  label: string;
  blurb: string;
}

export const SSM_TASKS: SsmTaskInfo[] = [
  { kind: 'selective', label: 'Selective-copy', blurb: 'copy only the data tokens out of a field of blanks — needs content selection' },
  { kind: 'induction', label: 'Induction', blurb: 'recall the value paired with a queried key (associative recall)' },
  { kind: 'copy', label: 'Copy', blurb: 'echo the digits back unchanged' },
  { kind: 'reverse', label: 'Reverse', blurb: 'emit the digits in reverse order' },
];

export interface SsmSample {
  tokens: Int32Array;
  answerStart: number;
  answerEnd: number;
}

function randDigits(n: number, rng: () => number): number[] {
  const out: number[] = [];
  for (let i = 0; i < n; i++) out.push(Math.floor(rng() * 10));
  return out;
}

// The data-field length for selective-copy at difficulty n (density ≈ 1/3 data).
function selectiveFieldLen(n: number): number {
  return 3 * n;
}

// Largest sequence length a task of width n can produce — used to size buffers.
export function maxSeqLen(kind: SsmTaskKind, n: number): number {
  switch (kind) {
    case 'copy':
    case 'reverse':
      return 2 * n + 1; // n digits + '=' + n digits
    case 'selective':
      return selectiveFieldLen(n) + 1 + n; // field + '=' + n data
    case 'induction':
      return 2 * n + 3; // n (key,value) pairs + '?' + key + '=' + value
  }
}

export function makeSample(kind: SsmTaskKind, n: number, rng: () => number): SsmSample {
  if (kind === 'selective') {
    const fieldLen = selectiveFieldLen(n);
    const data = randDigits(n, rng);
    // choose n distinct positions in the field, in increasing order
    const positions = new Set<number>();
    while (positions.size < n) positions.add(Math.floor(rng() * fieldLen));
    const sorted = Array.from(positions).sort((a, b) => a - b);
    const field = new Array<number>(fieldLen).fill(TOK_BLANK);
    for (let i = 0; i < n; i++) field[sorted[i]] = data[i];
    const seq = [...field, TOK_EQ, ...data];
    return { tokens: Int32Array.from(seq), answerStart: fieldLen + 1, answerEnd: seq.length };
  }
  if (kind === 'induction') {
    // n pairs (distinct keys); query one key; answer is its value.
    const keys: number[] = [];
    const pool = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9];
    for (let i = pool.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      [pool[i], pool[j]] = [pool[j], pool[i]];
    }
    for (let i = 0; i < n; i++) keys.push(pool[i]);
    const values = randDigits(n, rng);
    const seq: number[] = [];
    for (let i = 0; i < n; i++) seq.push(keys[i], values[i]);
    const qi = Math.floor(rng() * n);
    seq.push(TOK_QUERY, keys[qi], TOK_EQ, values[qi]);
    return { tokens: Int32Array.from(seq), answerStart: seq.length - 1, answerEnd: seq.length };
  }
  // copy / reverse
  const digits = randDigits(n, rng);
  const answer = kind === 'reverse' ? digits.slice().reverse() : digits.slice();
  const seq = [...digits, TOK_EQ, ...answer];
  return { tokens: Int32Array.from(seq), answerStart: digits.length + 1, answerEnd: seq.length };
}

export function formatSample(s: SsmSample): { prompt: string; answer: string } {
  return {
    prompt: tokensToString(s.tokens.subarray(0, s.answerStart)),
    answer: tokensToString(s.tokens.subarray(s.answerStart, s.answerEnd)),
  };
}
