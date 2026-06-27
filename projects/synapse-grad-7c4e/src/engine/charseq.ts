// Procedural sequence tasks for the Recurrent lab. Like the Transformer lab's `seqtasks`,
// every example is generated on the fly from a seeded RNG — there is no bundled dataset. But
// where the Transformer tasks are short algebra that attention solves in one parallel glance,
// these are *temporal* problems that reward a memory carried through time:
//
//   • recall  — emit the symbol seen `lag` steps ago, after a wall of distractors. The
//               canonical long-range credit-assignment probe: trivial for an LSTM, the place a
//               plain RNN's gradient vanishes.
//   • parity  — stream the running XOR of a bit string. One bit of state, but it must survive
//               the whole sequence — the textbook task a feed-forward net provably cannot do
//               online and a recurrent net can.
//   • copy    — memorise a whole block, then reproduce it on a GO token (delayed copy).
//   • lang    — a character-level language model over a tiny procedural grammar; the one task
//               you *generate* from, watching the net learn to spell and order words.
//
// Unlike the Transformer lab's single token stream split into prompt/answer, a task here returns
// an explicit (input, target, keep) triple of equal length — general enough to cover both
// next-token prediction (recall/copy/lang) and aligned sequence labelling (parity).

export type RnnTaskKind = 'recall' | 'parity' | 'copy' | 'lang';

export interface RnnTaskInfo {
  kind: RnnTaskKind;
  label: string;
  blurb: string;
  generative: boolean; // can you autoregressively sample a continuation?
  lenLabel: string; // what the difficulty slider controls
  lenMin: number;
  lenMax: number;
  lenDefault: number;
}

export const RNN_TASKS: RnnTaskInfo[] = [
  {
    kind: 'recall',
    label: 'Recall',
    blurb: 'remember the first symbol across a wall of distractors, then recall it on the query',
    generative: true,
    lenLabel: 'lag',
    lenMin: 3,
    lenMax: 40,
    lenDefault: 12,
  },
  {
    kind: 'parity',
    label: 'Parity',
    blurb: 'stream the running parity (XOR-so-far) of a bit string — one bit of state for the whole run',
    generative: false,
    lenLabel: 'length',
    lenMin: 4,
    lenMax: 40,
    lenDefault: 16,
  },
  {
    kind: 'copy',
    label: 'Copy',
    blurb: 'memorise a block of symbols, then reproduce it verbatim after the GO marker',
    generative: true,
    lenLabel: 'block',
    lenMin: 2,
    lenMax: 12,
    lenDefault: 5,
  },
  {
    kind: 'lang',
    label: 'Language',
    blurb: 'a char-level language model over a tiny grammar — train it, then sample sentences',
    generative: true,
    lenLabel: 'sentences',
    lenMin: 1,
    lenMax: 4,
    lenDefault: 2,
  },
];

// One worked example. `input`, `target` and `keep` are the same length T: the model reads
// `input` and at every step t where keep[t]=1 is graded on predicting target[t]. `promptLen`
// is how many input tokens to feed before autoregressive generation takes over (generative
// tasks only).
export interface RnnSample {
  input: Int32Array;
  target: Int32Array;
  keep: Uint8Array;
  promptLen: number;
}

// ---- recall / copy share a symbol alphabet -------------------------------------------------
const RECALL_SYMS = 5; // cue symbols A..E
const COPY_SYMS = 6; // cue symbols A..F

// ---- the procedural grammar for the language model -----------------------------------------
const SUBJECTS = ['the cat', 'the dog', 'a bird', 'my fish', 'the fox'];
const VERBS = ['sees', 'eats', 'likes', 'finds', 'wants'];
const OBJECTS = ['the sun', 'a star', 'the moon', 'some food', 'a nest'];
// The closed alphabet those words live in, plus space and the sentence terminator.
const LANG_ALPHABET = (() => {
  const set = new Set<string>([' ', '.']);
  for (const w of [...SUBJECTS, ...VERBS, ...OBJECTS]) for (const c of w) set.add(c);
  return Array.from(set).sort();
})();
const LANG_INDEX = new Map(LANG_ALPHABET.map((c, i) => [c, i]));

export function vocabSize(kind: RnnTaskKind): number {
  switch (kind) {
    case 'recall':
      return RECALL_SYMS + 1; // + query marker
    case 'parity':
      return 2;
    case 'copy':
      return COPY_SYMS + 1; // + GO marker
    case 'lang':
      return LANG_ALPHABET.length;
  }
}

export function tokenLabel(kind: RnnTaskKind, id: number): string {
  switch (kind) {
    case 'recall':
      return id < RECALL_SYMS ? String.fromCharCode(65 + id) : '▸';
    case 'parity':
      return id === 0 ? '0' : '1';
    case 'copy':
      return id < COPY_SYMS ? String.fromCharCode(65 + id) : '⇥';
    case 'lang':
      return LANG_ALPHABET[id] ?? '?';
  }
}

export function tokensToString(kind: RnnTaskKind, ids: ArrayLike<number>, from = 0, to?: number): string {
  let s = '';
  const end = to ?? ids.length;
  for (let i = from; i < end; i++) s += tokenLabel(kind, ids[i]);
  return s;
}

function randInt(rng: () => number, n: number): number {
  return Math.floor(rng() * n) % n;
}

function pick<T>(rng: () => number, arr: T[]): T {
  return arr[randInt(rng, arr.length)];
}

function langSentence(rng: () => number): string {
  return `${pick(rng, SUBJECTS)} ${pick(rng, VERBS)} ${pick(rng, OBJECTS)}.`;
}

function langCorpus(rng: () => number, sentences: number): number[] {
  const ids: number[] = [];
  for (let i = 0; i < sentences; i++) {
    const s = langSentence(rng) + (i < sentences - 1 ? ' ' : '');
    for (const c of s) ids.push(LANG_INDEX.get(c) ?? 0);
  }
  return ids;
}

// Build one training example for the given task at the given difficulty `len`.
export function makeSample(kind: RnnTaskKind, len: number, rng: () => number): RnnSample {
  if (kind === 'recall') {
    const cue = randInt(rng, RECALL_SYMS);
    const QUERY = RECALL_SYMS;
    const full: number[] = [cue];
    for (let i = 0; i < len; i++) full.push(randInt(rng, RECALL_SYMS));
    full.push(QUERY, cue);
    const input = Int32Array.from(full.slice(0, full.length - 1));
    const target = Int32Array.from(full.slice(1));
    const keep = new Uint8Array(input.length); // grade only the recall, the very last step
    keep[keep.length - 1] = 1;
    return { input, target, keep, promptLen: input.length };
  }

  if (kind === 'parity') {
    const bits = new Int32Array(len);
    const target = new Int32Array(len);
    let par = 0;
    for (let i = 0; i < len; i++) {
      bits[i] = rng() < 0.5 ? 0 : 1;
      par ^= bits[i];
      target[i] = par; // running parity *including* the current bit
    }
    const keep = new Uint8Array(len).fill(1);
    return { input: bits, target, keep, promptLen: len };
  }

  if (kind === 'copy') {
    const GO = COPY_SYMS;
    const block: number[] = [];
    for (let i = 0; i < len; i++) block.push(randInt(rng, COPY_SYMS));
    const full = [...block, GO, ...block];
    const input = Int32Array.from(full.slice(0, full.length - 1));
    const target = Int32Array.from(full.slice(1));
    const keep = new Uint8Array(input.length);
    for (let i = 0; i < input.length; i++) keep[i] = i >= len ? 1 : 0; // grade the reproduced block
    return { input, target, keep, promptLen: len + 1 };
  }

  // lang
  const ids = langCorpus(rng, len);
  const input = Int32Array.from(ids.slice(0, ids.length - 1));
  const target = Int32Array.from(ids.slice(1));
  const keep = new Uint8Array(input.length).fill(1);
  return { input, target, keep, promptLen: 1 };
}

// Pretty one-line rendering of a sample for the predictions table.
export function describeSample(kind: RnnTaskKind, s: RnnSample): { prompt: string; answer: string } {
  if (kind === 'parity') {
    return {
      prompt: tokensToString(kind, s.input),
      answer: tokensToString(kind, s.target),
    };
  }
  // for next-token tasks the "prompt" is the fed context and the "answer" the graded targets
  let firstKeep = s.keep.length;
  for (let i = 0; i < s.keep.length; i++)
    if (s.keep[i]) {
      firstKeep = i;
      break;
    }
  return {
    prompt: tokensToString(kind, s.input, 0, firstKeep + 1),
    answer: tokensToString(kind, s.target, firstKeep),
  };
}

// A held-out probe used by the gradient-flow visualizer: a single recall sample at a fixed lag
// so the same long-range dependency drives every cell type's gradient-through-time curve.
export function gradientProbe(lag: number, rng: () => number): RnnSample {
  return makeSample('recall', lag, rng);
}
