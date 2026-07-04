// Streamlet — the textbook streamlined BFT consensus protocol (Chan & Shi, 2020).
//
// The entire protocol is three rules and a shared epoch clock:
//
//   PROPOSE. At the start of each epoch e the epoch's leader broadcasts one block
//   extending (one of) the longest notarized chain(s) it has seen. Empty blocks
//   are fine and expected — the leader proposes every epoch it has outstanding
//   work, because finalization needs *adjacent* blocks.
//
//   VOTE. On the leader's proposal, every honest replica votes for it iff the
//   block extends a longest notarized chain in *its* view (its parent is the tip
//   of a maximal notarized chain), the epoch matches the current epoch, and the
//   replica has not already voted this epoch. Votes are broadcast to everyone.
//
//   NOTARIZE + FINALIZE. A block is notarized once a replica sees 2f+1 votes for
//   it; a chain is notarized when all its blocks are. If a notarized chain ever
//   holds three *adjacent* blocks with *consecutive* epochs (e, e+1, e+2), the
//   MIDDLE block and its whole prefix are finalized — irrevocably.
//
// There is no pacemaker, no view-change, no lock, no highest-QC. A bad epoch just
// produces nothing and the clock rolls on. SAFETY (no two honest replicas
// finalize conflicting blocks) needs only the two voting rules + 2f+1 quorum
// intersection and holds under full asynchrony; synchrony buys only liveness.
//
// The shared clock. Our discrete-event kernel has one global virtual time that
// every node reads through ctx.now, which is *exactly* Streamlet's synchronized
// epoch assumption made concrete: epoch(t) = ⌊t / epochLen⌋ + 1. Nodes arm a
// timer to the next epoch boundary, so they advance epochs perfectly in step —
// no skew, no clock protocol needed. A crashed node that restarts re-reads the
// global clock and rejoins the current epoch immediately.
import type { NodeContext, Message, Protocol } from '../../sim/types';
import {
  faultBudget,
  quorum,
  leaderOf,
  blockHash,
  genesisBlock,
  opStr,
  NOOP,
  GENESIS_HASH,
  type StreamletState,
  type StreamletConfig,
  type StreamletCmd,
  type Block,
  type Command,
  type ProposeMsg,
  type VoteMsg,
  type StatusMsg,
  type CatchupMsg,
  type RequestMsg,
  DEFAULT_STREAMLET_CONFIG,
} from './types';

/** How many blocks below the finalized tip to retain — wide enough that a replica
 *  isolated by a partition can be brought current once it heals, while bounding
 *  the serialized snapshot size. */
const PRUNE_KEEP = 64;

export function createStreamlet(config: StreamletConfig = DEFAULT_STREAMLET_CONFIG): Protocol<StreamletState, StreamletCmd> {
  const N = (ctx: NodeContext) => ctx.all.length;
  const f = (ctx: NodeContext) => faultBudget(N(ctx));
  const Q = (ctx: NodeContext) => quorum(N(ctx));

  // ---- the epoch clock ---------------------------------------------------

  /** The active epoch at time `now` (epoch 1 is the first proposing epoch). */
  const epochAt = (now: number) => Math.floor(now / config.epochLen) + 1;
  /** Arm the timer for the next epoch boundary (kept in lock-step across nodes). */
  function armEpoch(ctx: NodeContext): void {
    const nextBoundary = Math.floor(ctx.now / config.epochLen + 1e-9) * config.epochLen + config.epochLen;
    ctx.setTimer('epoch', Math.max(1, nextBoundary - ctx.now));
  }

  // ---- notarized-chain queries ------------------------------------------

  /** Is every block from `b` down to genesis notarized in this replica's view? */
  function onNotarizedChain(s: StreamletState, b: Block): boolean {
    let cur: Block | undefined = b;
    let guard = 0;
    while (cur && guard++ < 4096) {
      if (cur.hash === GENESIS_HASH) return true; // genesis is notarized by definition
      if (!s.notarized[cur.hash]) return false;
      if (cur.parent === '') return false;
      cur = s.blocks[cur.parent];
    }
    return false;
  }

  /** The length (height) of the longest notarized chain this replica knows. */
  function longestNotarizedHeight(s: StreamletState): number {
    let best = 0;
    for (const h of Object.keys(s.blocks)) {
      const b = s.blocks[h];
      if (b.height > best && onNotarizedChain(s, b)) best = b.height;
    }
    return best;
  }

  /** A deterministic tip of a longest notarized chain (lowest hash breaks ties). */
  function longestNotarizedTip(s: StreamletState): Block {
    let best: Block = s.blocks[GENESIS_HASH];
    for (const h of Object.keys(s.blocks)) {
      const b = s.blocks[h];
      if (!onNotarizedChain(s, b)) continue;
      if (b.height > best.height || (b.height === best.height && b.hash < best.hash)) best = b;
    }
    return best;
  }

  function hasWork(s: StreamletState): boolean {
    if (s.pending.some((c) => !s.executedCid[c.cid])) return true;
    // A real (non-empty) command sits in a not-yet-finalized block → keep flushing
    // so the two trailing epochs that close its triple get proposed.
    for (const h of Object.keys(s.blocks)) {
      const b = s.blocks[h];
      if (b.height > s.finalHeight && b.cmd.op.op !== 'noop' && !s.executedCid[b.cmd.cid]) return true;
    }
    return false;
  }

  // ---- proposing ---------------------------------------------------------

  /** Commands already in flight on the current longest notarized chain. */
  function onChainCids(s: StreamletState): Set<string> {
    const set = new Set<string>();
    let cur: Block | undefined = longestNotarizedTip(s);
    let guard = 0;
    while (cur && cur.height > s.finalHeight && guard++ < 4096) {
      set.add(cur.cmd.cid);
      cur = s.blocks[cur.parent];
    }
    return set;
  }

  function nextPendingCmd(s: StreamletState): Command | null {
    const inflight = onChainCids(s);
    for (const c of s.pending) {
      if (!s.executedCid[c.cid] && !inflight.has(c.cid)) return c;
    }
    return null;
  }

  function makeBlock(epoch: number, proposer: string, parent: Block, cmd: Command): Block {
    const height = parent.height + 1;
    const hash = blockHash(epoch, parent.hash, proposer, cmd);
    return { hash, epoch, height, parent: parent.hash, proposer, cmd };
  }

  /** A faulty leader's conflicting command (same key, mutated value/id). */
  function forge(cmd: Command): Command {
    if (cmd.op.op === 'set') return { cid: cmd.cid + '✗', op: { op: 'set', key: cmd.op.key, value: cmd.op.value + '✗' } };
    if (cmd.op.op === 'del') return { cid: cmd.cid + '✗', op: { op: 'set', key: cmd.op.key, value: '✗' } };
    return { cid: '✗' + cmd.cid, op: { op: 'set', key: 'x', value: '✗' } };
  }

  /** At the start of `s.epoch`, if this replica leads it, propose a block. */
  function maybePropose(ctx: NodeContext, s: StreamletState): void {
    if (leaderOf(ctx.all, s.epoch) !== ctx.self) return;
    if (s.fault === 'silent') return; // a silent leader proposes nothing
    if (!hasWork(s)) return; // nothing outstanding → let the epoch pass quietly
    const parent = longestNotarizedTip(s);
    const cmd = nextPendingCmd(s) ?? NOOP;

    if (s.fault === 'equivocate') {
      // Byzantine leader: two conflicting blocks at the SAME epoch on the SAME
      // parent, one to each half of the backups — and vote for both (worst case).
      const realCmd = cmd.op.op === 'noop' ? { cid: 'q' + s.epoch, op: { op: 'set', key: 'x', value: String(s.epoch) } as Command['op'] } : cmd;
      const blockA = makeBlock(s.epoch, ctx.self, parent, realCmd);
      const blockB = makeBlock(s.epoch, ctx.self, parent, forge(realCmd));
      s.blocks[blockA.hash] = blockA;
      s.blocks[blockB.hash] = blockB;
      const backups = ctx.peers;
      ctx.broadcast('Propose', (peer) => {
        const idx = backups.indexOf(peer);
        return { block: idx >= Math.ceil(backups.length / 2) ? blockB : blockA } as ProposeMsg;
      });
      // Double-vote: broadcast a vote for each fork (safety must survive this).
      s.votedInEpoch[s.epoch] = blockA.hash;
      recordVote(ctx, s, blockA, ctx.self);
      recordVote(ctx, s, blockB, ctx.self);
      ctx.broadcast('Vote', () => ({ block: blockA, from: ctx.self } as VoteMsg));
      ctx.broadcast('Vote', () => ({ block: blockB, from: ctx.self } as VoteMsg));
      ctx.log('state', `⚠ equivocates e${s.epoch}: "${opStr(blockA.cmd)}" vs "${opStr(blockB.cmd)}"`);
      s.note = `EQUIVOCATING @ e${s.epoch}`;
      return;
    }

    const block = makeBlock(s.epoch, ctx.self, parent, cmd);
    s.blocks[block.hash] = block;
    ctx.broadcast('Propose', () => ({ block } as ProposeMsg));
    ctx.log('state', `propose b#${block.height} e${s.epoch} = ${opStr(cmd)}`);
    s.note = `leader e${s.epoch}`;
    // The leader votes on its own proposal, like any honest replica.
    tryVote(ctx, s, block);
  }

  // ---- receiving a proposal / voting ------------------------------------

  function acceptProposal(ctx: NodeContext, s: StreamletState, block: Block): void {
    // Only the legitimate leader of an epoch may propose in it.
    if (block.proposer !== leaderOf(ctx.all, block.epoch)) return;
    if (block.height <= s.finalHeight) return; // already finalized past here
    if (!s.blocks[block.hash]) s.blocks[block.hash] = block;
    tryVote(ctx, s, block);
    reevaluate(ctx, s);
  }

  /** The Streamlet voting rule — the heart of safety. */
  function tryVote(ctx: NodeContext, s: StreamletState, block: Block): void {
    if (s.fault === 'silent') return; // silent backups withhold votes
    if (block.epoch !== s.epoch) return; // vote only in the current epoch
    if (s.votedInEpoch[block.epoch] !== undefined) return; // one vote per epoch
    const parent = s.blocks[block.parent];
    if (!parent) return; // need the parent to judge "extends a notarized chain"
    if (block.height !== parent.height + 1) return;
    if (block.epoch <= parent.epoch) return; // epochs strictly increase along a chain
    if (!onNotarizedChain(s, parent)) return; // parent's whole chain must be notarized
    if (parent.height !== longestNotarizedHeight(s)) return; // …and be a *longest* one

    // Cast our vote: an honest replica votes for the real hash; a 'conflict'
    // Byzantine backup votes for a corrupted hash that matches no real block.
    if (s.fault === 'conflict') {
      const fake: Block = { ...block, hash: block.hash + '✗' };
      s.votedInEpoch[block.epoch] = fake.hash;
      ctx.broadcast('Vote', () => ({ block: fake, from: ctx.self } as VoteMsg));
      return;
    }
    s.votedInEpoch[block.epoch] = block.hash;
    recordVote(ctx, s, block, ctx.self);
    ctx.broadcast('Vote', () => ({ block, from: ctx.self } as VoteMsg));
  }

  // ---- notarization + finalization --------------------------------------

  function recordVote(ctx: NodeContext, s: StreamletState, block: Block, from: string): void {
    if (!s.blocks[block.hash]) s.blocks[block.hash] = block; // learn the body from the vote
    const set = (s.votes[block.hash] ??= {});
    set[from] = true;
    if (!s.notarized[block.hash] && Object.keys(set).length >= Q(ctx)) {
      s.notarized[block.hash] = true;
      ctx.log('state', `notarized b#${block.height} e${block.epoch} (${Object.keys(set).length} votes)`);
    }
    reevaluate(ctx, s);
  }

  /** Re-check the finalization rule around a block that just changed. A block is
   *  finalized when it is the MIDDLE of three adjacent notarized blocks whose
   *  epochs are consecutive (e, e+1, e+2). We scan the (short) window near the
   *  affected block: any block can be the top of a triple. */
  function reevaluate(ctx: NodeContext, s: StreamletState): void {
    // Consider every notarized block as the potential *top* (b2) of a triple.
    for (const h of Object.keys(s.notarized)) {
      const b2 = s.blocks[h];
      if (!b2 || b2.height < 3) continue;
      if (!onNotarizedChain(s, b2)) continue;
      const b1 = s.blocks[b2.parent];
      if (!b1) continue;
      const b0 = s.blocks[b1.parent];
      if (!b0) continue;
      if (b1.epoch === b2.epoch - 1 && b0.epoch === b1.epoch - 1) {
        // Consecutive-epoch triple → finalize the middle block b1 and its prefix.
        finalize(ctx, s, b1);
      }
    }
  }

  /** Mark a block (and un-executed ancestors) final, then execute in order. */
  function finalize(ctx: NodeContext, s: StreamletState, b: Block): void {
    if (b.height <= s.finalHeight) return;
    let cur: Block | undefined = b;
    let guard = 0;
    while (cur && cur.height > s.finalHeight && guard++ < 4096) {
      s.finalized[cur.height] = cur.hash;
      if (cur.parent === '') break;
      cur = s.blocks[cur.parent];
    }
    tryExecute(ctx, s);
  }

  /** Execute the longest gap-free, properly-chained prefix of finalized blocks. */
  function tryExecute(ctx: NodeContext, s: StreamletState): void {
    let advanced = false;
    for (;;) {
      const h = s.finalHeight + 1;
      const hash = s.finalized[h];
      if (!hash) break;
      const blk = s.blocks[hash];
      if (!blk) break; // body still missing
      if (blk.parent !== s.finalHash) break; // must chain directly off the executed tip
      const o = blk.cmd.op;
      if (o.op === 'set') s.kv[o.key] = o.value;
      else if (o.op === 'del') delete s.kv[o.key];
      s.finalHeight = h;
      s.finalHash = hash;
      s.executedCid[blk.cmd.cid] = true;
      s.pending = s.pending.filter((c) => c.cid !== blk.cmd.cid);
      const via = s.catchup[h] && s.catchup[h][hash] && Object.keys(s.catchup[h][hash]).length >= f(ctx) + 1 ? 'catchup' : 'triple';
      s.committed.push({ height: h, epoch: blk.epoch, hash, cmd: blk.cmd, via });
      if (blk.cmd.op.op !== 'noop') ctx.log('commit', `finalize #${h} = ${opStr(blk.cmd)} (e${blk.epoch})`);
      delete s.finalized[h];
      s.lastFinalHeight = h;
      advanced = true;
    }
    if (advanced) {
      if (s.committed.length > 300) s.committed.splice(0, s.committed.length - 300);
      onProgress(ctx, s);
    }
  }

  // ---- pacemaker-free progress bookkeeping ------------------------------

  /** Streamlet needs no timeout, but we still (dis)arm nothing here — the epoch
   *  clock does all the driving. This hook only refreshes the UI note. */
  function onProgress(_ctx: NodeContext, s: StreamletState): void {
    if (!hasWork(s) && s.fault === 'honest') s.note = `idle e${s.epoch}`;
  }

  // ---- catch-up gossip (lets a lagging / restarted replica converge) -----

  function gossipStatus(ctx: NodeContext, s: StreamletState): void {
    if (s.fault === 'silent') return;
    ctx.broadcast('Status', () => ({ from: ctx.self, finalHeight: s.finalHeight } as StatusMsg));
  }

  // ---- pruning -----------------------------------------------------------

  function prune(s: StreamletState): void {
    const floor = s.finalHeight - PRUNE_KEEP;
    if (floor > 0) {
      const keep = new Set<string>([GENESIS_HASH, s.finalHash]);
      for (const h of Object.keys(s.blocks)) {
        const b = s.blocks[h];
        if (b.height < floor && !keep.has(h)) {
          delete s.blocks[h];
          delete s.votes[h];
          delete s.notarized[h];
        }
      }
    }
    const efloor = s.epoch - 16;
    for (const k of Object.keys(s.votedInEpoch)) if (Number(k) < efloor) delete s.votedInEpoch[Number(k)];
    for (const k of Object.keys(s.finalized)) if (Number(k) <= s.finalHeight) delete s.finalized[Number(k)];
    for (const k of Object.keys(s.catchup)) if (Number(k) <= s.finalHeight) delete s.catchup[Number(k)];
  }

  // ---- protocol object ---------------------------------------------------

  return {
    name: 'Streamlet',

    init(ctx) {
      const g = genesisBlock();
      const s: StreamletState = {
        fault: 'honest',
        epoch: epochAt(ctx.now),
        blocks: { [g.hash]: g },
        votes: {},
        notarized: { [GENESIS_HASH]: true },
        votedInEpoch: {},
        finalized: {},
        finalHeight: 0,
        finalHash: GENESIS_HASH,
        kv: {},
        committed: [],
        executedCid: {},
        catchup: {},
        pending: [],
        note: 'replica',
        lastFinalHeight: 0,
      };
      armEpoch(ctx);
      ctx.setTimer('sync', Math.round(config.syncPeriod + ctx.rng.float(0, 80)));
      return s;
    },

    onRestart(ctx, s) {
      // Everything is durable (blocks, votes, notarization, votes-per-epoch, the
      // finalized log). A restart only re-reads the shared clock and re-arms timers.
      s.epoch = epochAt(ctx.now);
      s.note = 'restarted';
      armEpoch(ctx);
      ctx.setTimer('sync', Math.round(config.syncPeriod + ctx.rng.float(0, 80)));
    },

    onCommand(ctx, s, cmd) {
      if (cmd.type === 'set-fault') {
        s.fault = cmd.mode;
        s.note = cmd.mode === 'honest' ? 'replica' : `BYZANTINE: ${cmd.mode}`;
        ctx.log('info', `fault mode → ${cmd.mode}`);
        return;
      }
      const c = cmd.command;
      if (s.executedCid[c.cid] || s.pending.some((p) => p.cid === c.cid)) return;
      s.pending.push(c);
      // Do NOT propose mid-epoch: Streamlet leaders propose once, at the epoch
      // boundary. The command waits for the next epoch's leader.
    },

    onTimer(ctx, s, name) {
      if (name === 'epoch') {
        s.epoch = epochAt(ctx.now);
        armEpoch(ctx);
        maybePropose(ctx, s);
        return;
      }
      if (name === 'sync') {
        ctx.setTimer('sync', Math.round(config.syncPeriod + ctx.rng.float(0, 80)));
        gossipStatus(ctx, s);
        prune(s);
        return;
      }
    },

    onMessage(ctx, s, msg: Message) {
      switch (msg.type) {
        case 'Request': {
          const c = (msg.payload as RequestMsg).command;
          if (!s.executedCid[c.cid] && !s.pending.some((p) => p.cid === c.cid)) s.pending.push(c);
          return;
        }

        case 'Propose': {
          acceptProposal(ctx, s, (msg.payload as ProposeMsg).block);
          return;
        }

        case 'Vote': {
          const v = msg.payload as VoteMsg;
          // Only count votes for a block whose stated hash matches its content —
          // this is what makes a 'conflict' backup's forged-hash votes worthless.
          if (v.block.hash !== blockHash(v.block.epoch, v.block.parent, v.block.proposer, v.block.cmd)) return;
          if (v.block.proposer !== leaderOf(ctx.all, v.block.epoch)) return;
          recordVote(ctx, s, v.block, v.from);
          return;
        }

        case 'Status': {
          const st = msg.payload as StatusMsg;
          if (s.fault === 'silent' || st.finalHeight >= s.finalHeight) return;
          const entries: Block[] = [];
          for (let h = st.finalHeight + 1; h <= s.finalHeight && entries.length < 64; h++) {
            const hash = s.committed.find((e) => e.height === h)?.hash;
            const blk = hash ? s.blocks[hash] : undefined;
            if (blk) entries.push(blk);
          }
          if (entries.length) ctx.send(st.from, 'Catchup', { from: ctx.self, entries } as CatchupMsg);
          return;
        }

        case 'Catchup': {
          // Adopt a finalized block only once f+1 distinct replicas report it —
          // ≥1 reporter is honest, and an honest replica only reports what it
          // finalized, which Agreement makes consistent. Bodies arrive with the
          // report, so we can apply immediately.
          const cu = msg.payload as CatchupMsg;
          for (const blk of cu.entries) {
            if (blk.height <= s.finalHeight) continue;
            if (!s.blocks[blk.hash]) s.blocks[blk.hash] = blk;
            const bySeq = (s.catchup[blk.height] ??= {});
            (bySeq[blk.hash] ??= {})[cu.from] = true;
            if (Object.keys(bySeq[blk.hash]).length >= f(ctx) + 1) s.finalized[blk.height] = blk.hash;
          }
          tryExecute(ctx, s);
          return;
        }
      }
    },
  };
}
