// Convergent / commutative replicated data types (state-based CRDTs).
//
// Each type exposes a pure, commutative, idempotent, associative `merge`, so
// replicas that exchange full state via anti-entropy always converge to the same
// value regardless of message order, duplication or delay — "strong eventual
// consistency". All state is plain JSON so it snapshots and time-travels.

export type CrdtKind = 'gcounter' | 'pncounter' | 'lww' | 'orset' | 'rga';

export interface CrdtOp {
  id: string;
  arg?: string | number;
}

export interface OpDef {
  id: string;
  label: string;
  /** What argument the op needs from the UI. */
  arg: 'none' | 'elem' | 'value' | 'index';
  hint?: string;
}

export interface CrdtSpec<S> {
  kind: CrdtKind;
  title: string;
  blurb: string;
  ops: OpDef[];
  init(): S;
  merge(a: S, b: S): S;
  apply(s: S, op: CrdtOp, node: string, clock: () => number): void;
  value(s: S): string;
}

// ---------- G-Counter ----------

type GCounter = Record<string, number>;
const gcounter: CrdtSpec<GCounter> = {
  kind: 'gcounter',
  title: 'G-Counter',
  blurb: 'Grow-only counter. Each replica owns one slot; the value is the sum, merge takes the per-slot max.',
  ops: [{ id: 'inc', label: '+1 increment', arg: 'none' }],
  init: () => ({}),
  merge(a, b) {
    const out: GCounter = { ...a };
    for (const k in b) out[k] = Math.max(out[k] ?? 0, b[k]);
    return out;
  },
  apply(s, op, node) {
    if (op.id === 'inc') s[node] = (s[node] ?? 0) + 1;
  },
  value: (s) => String(Object.values(s).reduce((a, b) => a + b, 0)),
};

// ---------- PN-Counter ----------

interface PNCounter {
  p: GCounter;
  n: GCounter;
}
const pncounter: CrdtSpec<PNCounter> = {
  kind: 'pncounter',
  title: 'PN-Counter',
  blurb: 'Increment/decrement counter built from two G-Counters (P − N). Still purely mergeable.',
  ops: [
    { id: 'inc', label: '+1', arg: 'none' },
    { id: 'dec', label: '−1', arg: 'none' },
  ],
  init: () => ({ p: {}, n: {} }),
  merge(a, b) {
    return { p: gcounter.merge(a.p, b.p), n: gcounter.merge(a.n, b.n) };
  },
  apply(s, op, node) {
    if (op.id === 'inc') s.p[node] = (s.p[node] ?? 0) + 1;
    if (op.id === 'dec') s.n[node] = (s.n[node] ?? 0) + 1;
  },
  value(s) {
    const sum = (g: GCounter) => Object.values(g).reduce((a, b) => a + b, 0);
    return String(sum(s.p) - sum(s.n));
  },
};

// ---------- LWW-Register ----------

interface LWW {
  value: string | null;
  ts: number;
  node: string;
}
const lww: CrdtSpec<LWW> = {
  kind: 'lww',
  title: 'LWW-Register',
  blurb: 'Last-writer-wins register. Concurrent writes are resolved by (timestamp, node-id); merge keeps the winner.',
  ops: [{ id: 'set', label: 'set', arg: 'value', hint: 'value' }],
  init: () => ({ value: null, ts: -1, node: '' }),
  merge(a, b) {
    if (b.ts > a.ts || (b.ts === a.ts && b.node > a.node)) return { ...b };
    return { ...a };
  },
  apply(s, op, node, clock) {
    if (op.id === 'set') {
      s.value = String(op.arg ?? '');
      s.ts = clock();
      s.node = node;
    }
  },
  value: (s) => (s.value === null ? '∅' : s.value),
};

// ---------- OR-Set ----------

interface ORSet {
  // element -> set of unique add-tags
  adds: Record<string, Record<string, true>>;
  // removed tags (tombstones)
  rem: Record<string, true>;
}
const orset: CrdtSpec<ORSet> = {
  kind: 'orset',
  title: 'OR-Set',
  blurb:
    'Observed-remove set. Each add gets a unique tag; remove tombstones the tags it has seen, so concurrent add-wins. Merge unions everything.',
  ops: [
    { id: 'add', label: 'add', arg: 'elem', hint: 'element' },
    { id: 'remove', label: 'remove', arg: 'elem', hint: 'element' },
  ],
  init: () => ({ adds: {}, rem: {} }),
  merge(a, b) {
    const adds: ORSet['adds'] = {};
    for (const e of new Set([...Object.keys(a.adds), ...Object.keys(b.adds)])) {
      adds[e] = { ...(a.adds[e] ?? {}), ...(b.adds[e] ?? {}) };
    }
    return { adds, rem: { ...a.rem, ...b.rem } };
  },
  apply(s, op, node, clock) {
    const elem = String(op.arg ?? '');
    if (!elem) return;
    if (op.id === 'add') {
      const tag = `${node}:${clock()}`;
      (s.adds[elem] ??= {})[tag] = true;
    } else if (op.id === 'remove') {
      for (const tag in s.adds[elem] ?? {}) s.rem[tag] = true;
    }
  },
  value(s) {
    const present = Object.keys(s.adds).filter((e) =>
      Object.keys(s.adds[e]).some((tag) => !s.rem[tag]),
    );
    return `{ ${present.sort().join(', ')} }`;
  },
};

// ---------- RGA (replicated growable array / sequence) ----------

interface RgaNode {
  id: string; // `${lamport}:${node}` — totally ordered, unique
  ch: string;
  after: string | null; // id of the predecessor, null for the head
  del: boolean;
}
interface RGA {
  nodes: Record<string, RgaNode>;
  lamport: number;
}

function rgaOrdered(s: RGA): RgaNode[] {
  const children = new Map<string, RgaNode[]>();
  for (const n of Object.values(s.nodes)) {
    const key = n.after ?? '';
    (children.get(key) ?? children.set(key, []).get(key)!).push(n);
  }
  // concurrent inserts at the same anchor: higher id first (RGA tie-break)
  for (const arr of children.values()) arr.sort((a, b) => (a.id < b.id ? 1 : a.id > b.id ? -1 : 0));
  const out: RgaNode[] = [];
  const walk = (anchor: string) => {
    for (const n of children.get(anchor) ?? []) {
      out.push(n);
      walk(n.id);
    }
  };
  walk('');
  return out;
}

const rga: CrdtSpec<RGA> = {
  kind: 'rga',
  title: 'RGA sequence',
  blurb:
    'Replicated growable array — the data structure behind collaborative text. Each character has a unique id; concurrent inserts at the same spot order deterministically, so all replicas read the same string.',
  ops: [
    { id: 'push', label: 'append char', arg: 'value', hint: 'a char' },
    { id: 'insert', label: 'insert@', arg: 'index', hint: 'index' },
    { id: 'delete', label: 'delete@', arg: 'index', hint: 'index' },
  ],
  init: () => ({ nodes: {}, lamport: 0 }),
  merge(a, b) {
    const nodes: RGA['nodes'] = { ...a.nodes };
    for (const id in b.nodes) {
      if (!nodes[id]) nodes[id] = { ...b.nodes[id] };
      else if (b.nodes[id].del) nodes[id] = { ...nodes[id], del: true };
    }
    return { nodes, lamport: Math.max(a.lamport, b.lamport) };
  },
  apply(s, op, node, clock) {
    clock(); // keep the kernel clock advancing in lockstep
    const visible = rgaOrdered(s).filter((n) => !n.del);
    if (op.id === 'push' || op.id === 'insert') {
      const ch = op.id === 'push' ? String(op.arg ?? '·') : '◆';
      const idx = op.id === 'push' ? visible.length : Math.max(0, Math.min(Number(op.arg) || 0, visible.length));
      const after = idx === 0 ? null : visible[idx - 1].id;
      s.lamport += 1;
      const id = `${String(s.lamport).padStart(6, '0')}:${node}`;
      s.nodes[id] = { id, ch, after, del: false };
    } else if (op.id === 'delete') {
      const idx = Math.max(0, Math.min(Number(op.arg) || 0, visible.length - 1));
      const target = visible[idx];
      if (target) s.nodes[target.id].del = true;
    }
  },
  value(s) {
    const str = rgaOrdered(s)
      .filter((n) => !n.del)
      .map((n) => n.ch)
      .join('');
    return str.length ? `"${str}"` : '""';
  },
};

export const CRDT_SPECS: Record<CrdtKind, CrdtSpec<unknown>> = {
  gcounter: gcounter as CrdtSpec<unknown>,
  pncounter: pncounter as CrdtSpec<unknown>,
  lww: lww as CrdtSpec<unknown>,
  orset: orset as CrdtSpec<unknown>,
  rga: rga as CrdtSpec<unknown>,
};

export const CRDT_ORDER: CrdtKind[] = ['gcounter', 'pncounter', 'lww', 'orset', 'rga'];
