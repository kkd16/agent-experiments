// A real, multi-replica collaborative text editor built on an RGA (Replicated
// Growable Array) — the conflict-free sequence CRDT behind systems like Yjs and
// Automerge. Every node holds its own replica of the document; a local edit is an
// insert/delete on the RGA and is pushed to peers, and a gossip timer re-syncs
// after partitions. Because RGA's insert ordering is a total order on unique
// character ids, every replica that has seen the same set of edits reads the
// EXACT same string — no central server, no operational transform, no conflicts.
import type { InvariantResult, NodeContext, NodeView, Protocol } from '../../sim/types';

/** One character cell in the RGA. `id` is globally unique and totally ordered. */
export interface RgaCell {
  id: string; // `${lamport.padded}:${node}` — Lamport-then-node, so ids never collide
  ch: string;
  after: string | null; // id of the predecessor cell; null anchors at the document head
  del: boolean; // tombstone — kept so concurrent edits still resolve deterministically
}

export interface RgaDoc {
  cells: Record<string, RgaCell>;
  lamport: number;
}

export interface CoeditState {
  doc: RgaDoc;
}

export type CoeditOp = { t: 'ins'; index: number; ch: string } | { t: 'del'; index: number };

interface SyncPayload {
  cells: Record<string, RgaCell>;
  lamport: number;
}

const pad = (n: number) => String(n).padStart(8, '0');

/** Linearize the RGA into document order. Concurrent inserts at the same anchor
 *  break ties by higher id first — the canonical RGA rule, identical on every replica. */
export function rgaOrder(doc: RgaDoc): RgaCell[] {
  const children = new Map<string, RgaCell[]>();
  for (const c of Object.values(doc.cells)) {
    const key = c.after ?? '';
    let arr = children.get(key);
    if (!arr) children.set(key, (arr = []));
    arr.push(c);
  }
  for (const arr of children.values()) arr.sort((a, b) => (a.id < b.id ? 1 : a.id > b.id ? -1 : 0));
  const out: RgaCell[] = [];
  const walk = (anchor: string) => {
    for (const c of children.get(anchor) ?? []) {
      out.push(c);
      walk(c.id);
    }
  };
  walk('');
  return out;
}

/** The visible (non-tombstoned) cells, in order — what the user actually reads. */
export const visibleCells = (doc: RgaDoc): RgaCell[] => rgaOrder(doc).filter((c) => !c.del);

export const docText = (doc: RgaDoc): string => visibleCells(doc).map((c) => c.ch).join('');

function insertAt(doc: RgaDoc, index: number, ch: string, node: string) {
  const vis = visibleCells(doc);
  const i = Math.max(0, Math.min(index, vis.length));
  const after = i === 0 ? null : vis[i - 1].id;
  doc.lamport += 1;
  const id = `${pad(doc.lamport)}:${node}`;
  doc.cells[id] = { id, ch, after, del: false };
}

function deleteAt(doc: RgaDoc, index: number) {
  const vis = visibleCells(doc);
  const i = Math.max(0, Math.min(index, vis.length - 1));
  const target = vis[i];
  if (target) doc.cells[target.id].del = true;
}

function mergeDoc(a: RgaDoc, into: RgaDoc) {
  for (const id in a.cells) {
    const incoming = a.cells[id];
    const have = into.cells[id];
    if (!have) into.cells[id] = { ...incoming };
    else if (incoming.del && !have.del) have.del = true; // tombstones win
  }
  into.lamport = Math.max(into.lamport, a.lamport);
}

export interface CoeditConfig {
  gossipInterval: number;
}

export function createCoedit(config: CoeditConfig = { gossipInterval: 240 }): Protocol<CoeditState, CoeditOp> {
  const armGossip = (ctx: NodeContext) =>
    ctx.setTimer('gossip', ctx.rng.int(config.gossipInterval, config.gossipInterval * 2));

  return {
    name: 'CoEdit',

    init(ctx) {
      armGossip(ctx);
      return { doc: { cells: {}, lamport: 0 } };
    },

    onRestart(ctx) {
      armGossip(ctx);
    },

    onCommand(ctx, s, op) {
      if (op.t === 'ins') insertAt(s.doc, op.index, op.ch, ctx.self);
      else deleteAt(s.doc, op.index);
      ctx.log('state', op.t === 'ins' ? `insert '${op.ch}' @${op.index}` : `delete @${op.index}`);
      ctx.broadcast('sync', () => ({ cells: structuredClone(s.doc.cells), lamport: s.doc.lamport }) as SyncPayload);
    },

    onTimer(ctx, s, name) {
      if (name !== 'gossip') return;
      const peer = ctx.rng.pick(ctx.peers);
      if (peer) ctx.send(peer, 'sync', { cells: structuredClone(s.doc.cells), lamport: s.doc.lamport } as SyncPayload);
      armGossip(ctx);
    },

    onMessage(ctx, s, msg) {
      if (msg.type !== 'sync') return;
      const p = msg.payload as SyncPayload;
      const before = docText(s.doc);
      mergeDoc({ cells: p.cells, lamport: p.lamport }, s.doc);
      const after = docText(s.doc);
      if (before !== after) ctx.log('recv', `merged ← ${msg.from}`);
    },

    invariants(nodes: ReadonlyArray<NodeView<CoeditState>>): InvariantResult[] {
      const up = nodes.filter((n) => n.up);
      const texts = up.map((n) => docText(n.state.doc));
      const agree = texts.every((t) => t === texts[0]);
      return [
        {
          name: 'Convergent document',
          ok: agree,
          detail: agree
            ? `all ${up.length} replicas read the same ${texts[0]?.length ?? 0} characters`
            : 'replicas differ — they converge once the sync messages drain',
        },
      ];
    },
  };
}
