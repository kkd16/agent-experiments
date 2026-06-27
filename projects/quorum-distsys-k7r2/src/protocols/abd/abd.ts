// ABD — a linearizable multi-writer/multi-reader register, no consensus.
//
// Every node is identical: it stores one (value, tag) per key and can coordinate
// any client operation. Both reads and writes are two phases over majority
// quorums:
//
//   write(k, v):  query a majority for the latest tag → pick tag (maxSeq+1, self)
//                 → write (tag, v) to a majority.            [strictly newer tag]
//   read(k):      query a majority for the latest (tag,val) → write that same
//                 (tag, val) back to a majority → return val.   [the write-back]
//
// Majority quorums intersect, so a write's chosen tag is strictly above every
// completed write, and a read's write-back makes the value it returns durable —
// together that is exactly atomicity. There is no leader, no log, and no agreed
// order of operations: just quorums and tags. See `invariants.ts` for the live
// linearizability proof.
import type { NodeContext, Message, Protocol } from '../../sim/types';
import {
  BOTTOM,
  cmpTag,
  tagStr,
  DEFAULT_ABD_CONFIG,
  type AbdState,
  type AbdConfig,
  type AbdCmd,
  type OpRec,
  type Tag,
  type Register,
  type CompletedOp,
  type QueryMsg,
  type QueryAckMsg,
  type WriteMsg,
  type WriteAckMsg,
} from './types';

const majority = (n: number) => Math.floor(n / 2) + 1;

export function createAbd(config: AbdConfig = DEFAULT_ABD_CONFIG): Protocol<AbdState, AbdCmd> {
  function regOf(s: AbdState, key: string): Register {
    return s.store[key] ?? { tag: BOTTOM, value: '' };
  }

  /** Adopt (tag, value) for a key iff it is strictly newer than what we hold. */
  function applyWrite(s: AbdState, key: string, tag: Tag, value: string): void {
    const cur = regOf(s, key);
    if (cmpTag(tag, cur.tag) > 0) s.store[key] = { tag, value };
  }

  function startOp(ctx: NodeContext, s: AbdState, kind: 'read' | 'write', key: string, value: string): void {
    const id = `${ctx.self}:${s.opCounter++}`;
    const reg = regOf(s, key);
    const op: OpRec = {
      id,
      kind,
      key,
      value,
      phase: 'query',
      startedAt: ctx.now,
      queryAcks: { [ctx.self]: { tag: reg.tag, value: reg.value } },
      writeAcks: {},
      tag: BOTTOM,
    };
    s.pending[id] = op;
    s.note = `${kind} ${key}${kind === 'write' ? '=' + value : ''} · query phase`;
    ctx.log('state', `${kind} ${key}${kind === 'write' ? '=' + value : ''} — phase 1 (query majority)`);
    ctx.broadcast('Query', () => ({ opId: id, key } as QueryMsg));
    ctx.setTimer('retry:' + id, config.retry);
    maybeQueryDone(ctx, s, id);
  }

  function maybeQueryDone(ctx: NodeContext, s: AbdState, id: string): void {
    const op = s.pending[id];
    if (!op || op.phase !== 'query') return;
    const acks = Object.values(op.queryAcks);
    if (acks.length < majority(ctx.all.length)) return;

    // The highest (tag, value) any quorum member holds.
    let maxTag: Tag = BOTTOM;
    let maxVal = '';
    for (const a of acks) {
      if (cmpTag(a.tag, maxTag) > 0) {
        maxTag = a.tag;
        maxVal = a.value;
      }
    }
    if (op.kind === 'write') {
      // Strictly newer than anything seen *and* than any tag this node already
      // issued — the per-node floor stops two concurrent writes colliding.
      const seq = Math.max(maxTag.seq, s.lastWriteSeq) + 1;
      s.lastWriteSeq = seq;
      op.tag = { seq, node: ctx.self };
    } else {
      op.tag = maxTag; // a read writes back exactly what it found
      op.value = maxVal;
    }
    op.phase = 'write';
    op.writeAcks = { [ctx.self]: true };
    applyWrite(s, op.key, op.tag, op.value);
    ctx.log('state', `${op.kind} ${op.key} — phase 2 (write-back ${tagStr(op.tag)})`);
    ctx.broadcast('Write', () => ({ opId: op.id, key: op.key, tag: op.tag, value: op.value } as WriteMsg));
    maybeWriteDone(ctx, s, id);
  }

  function maybeWriteDone(ctx: NodeContext, s: AbdState, id: string): void {
    const op = s.pending[id];
    if (!op || op.phase !== 'write') return;
    if (Object.keys(op.writeAcks).length < majority(ctx.all.length)) return;

    const done: CompletedOp = {
      id: op.id,
      kind: op.kind,
      key: op.key,
      value: op.value,
      tag: op.tag,
      startedAt: op.startedAt,
      finishedAt: ctx.now,
      coord: ctx.self,
    };
    s.history.push(done);
    if (s.history.length > config.historyCap) s.history.splice(0, s.history.length - config.historyCap);
    if (op.kind === 'read') s.reads++;
    else s.writes++;
    delete s.pending[id];
    ctx.clearTimer('retry:' + id);
    s.note = `${op.kind} ${op.key} ${op.kind === 'read' ? '→ ' + (op.value || '∅') : '=' + op.value} done @ ${tagStr(op.tag)}`;
    ctx.log('commit', `${op.kind} ${op.key} ${op.kind === 'read' ? '→ ' + (op.value || '∅') : '=' + op.value} committed @ tag ${tagStr(op.tag)}`);
  }

  return {
    name: 'ABD',

    init(ctx) {
      const s: AbdState = {
        self: ctx.self,
        store: {},
        pending: {},
        history: [],
        opCounter: 0,
        lastWriteSeq: 0,
        note: 'idle',
        reads: 0,
        writes: 0,
      };
      return s;
    },

    onRestart(_ctx, s) {
      // The register store is stable storage and survives. In-flight operations
      // this node was coordinating are abandoned (their client will retry).
      s.pending = {};
      s.note = 'restarted (register store intact)';
    },

    onTimer(ctx, s, name) {
      if (name.startsWith('retry:')) {
        const id = name.slice(6);
        const op = s.pending[id];
        if (!op) return;
        // Re-drive the current phase — covers messages lost to a partition that
        // has since healed, so a stalled operation finishes instead of hanging.
        if (op.phase === 'query') ctx.broadcast('Query', () => ({ opId: id, key: op.key } as QueryMsg));
        else ctx.broadcast('Write', () => ({ opId: op.id, key: op.key, tag: op.tag, value: op.value } as WriteMsg));
        ctx.setTimer('retry:' + id, config.retry);
        return;
      }
    },

    onCommand(ctx, s, cmd) {
      if (cmd.type === 'write') startOp(ctx, s, 'write', cmd.key, cmd.value);
      else startOp(ctx, s, 'read', cmd.key, '');
    },

    onMessage(ctx, s, msg: Message) {
      switch (msg.type) {
        case 'Query': {
          const p = msg.payload as QueryMsg;
          const reg = regOf(s, p.key);
          ctx.send(msg.from, 'QueryAck', { opId: p.opId, key: p.key, tag: reg.tag, value: reg.value, from: ctx.self } as QueryAckMsg);
          return;
        }
        case 'QueryAck': {
          const p = msg.payload as QueryAckMsg;
          const op = s.pending[p.opId];
          if (!op || op.phase !== 'query') return;
          op.queryAcks[p.from] = { tag: p.tag, value: p.value };
          maybeQueryDone(ctx, s, p.opId);
          return;
        }
        case 'Write': {
          const p = msg.payload as WriteMsg;
          applyWrite(s, p.key, p.tag, p.value);
          ctx.send(msg.from, 'WriteAck', { opId: p.opId, from: ctx.self } as WriteAckMsg);
          return;
        }
        case 'WriteAck': {
          const p = msg.payload as WriteAckMsg;
          const op = s.pending[p.opId];
          if (!op || op.phase !== 'write') return;
          op.writeAcks[p.from] = true;
          maybeWriteDone(ctx, s, p.opId);
          return;
        }
      }
    },
  };
}
