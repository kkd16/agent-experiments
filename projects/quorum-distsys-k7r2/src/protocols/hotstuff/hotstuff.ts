// Chained HotStuff — the streamlined, pipelined BFT consensus protocol.
//
// THE PIPELINE. Every view, the leader proposes one block that extends the
// highest QC it has seen (`qcHigh`) and carries that QC as the block's `justify`.
// Backups apply a one-line voting rule and send their vote to that view's leader,
// which aggregates 2f+1 votes into a fresh QC and disseminates it; the next view's
// leader proposes on top of it, and the cycle repeats — O(N) messages per block.
// (This is the Tendermint/Casper-style hand-off, where each view's leader collects
// its own block's votes. The original HotStuff routes votes to the *next* leader to
// shave a message delay, at the cost of coupling two consecutive views to every
// leader — which is what stalls a round-robin N=4 cluster under a single persistent
// fault; collecting-at-the-proposer keeps liveness with f faults at N = 3f+1.)
//
// THE 3-CHAIN COMMIT RULE. Because each block's `justify` certifies an earlier
// block, a run of blocks threads a run of QCs. Walk back three links from a new
// block b*:  b'' = b*.justify.node,  b' = b''.justify.node,  b = b'.justify.node.
// If those three are linked by *direct, consecutive* parent edges
// (b''.parent = b' and b'.parent = b), then b is committed. Two QCs lock the
// chain (safety); the third makes the decision irrevocable.
//
// THE PACEMAKER. Leaders rotate every view (round-robin), so a faulty leader
// costs exactly one view. A replica with outstanding work arms a view timer; if
// the view does not advance in time it broadcasts a TIMEOUT carrying its highest
// QC. 2f+1 TIMEOUTs form a timeout certificate that jumps every honest replica
// to the next view, where the new leader proposes on top of the highest QC any
// of those 2f+1 reported — so nothing an honest replica might have committed is
// ever lost.
//
// SAFETY rests entirely on the voting rule + quorum intersection, exactly as in
// PBFT: a block is safe to vote for iff it extends the locked block, OR its
// justify QC is newer than the lock (the liveness escape). Two conflicting
// blocks can never both gather 2f+1 votes, so no two honest replicas ever commit
// conflicting blocks — which is the invariant this lab checks live.
import type { NodeContext, Message, Protocol, NodeId } from '../../sim/types';
import {
  faultBudget,
  quorum,
  leaderOf,
  blockHash,
  genesisBlock,
  genesisQC,
  opStr,
  NOOP,
  GENESIS_HASH,
  type HsState,
  type HsConfig,
  type HsCmd,
  type Block,
  type QC,
  type Command,
  type ProposeMsg,
  type VoteMsg,
  type QCMsg,
  type TimeoutMsg,
  type StatusMsg,
  type CatchupMsg,
  type RequestMsg,
  DEFAULT_HOTSTUFF_CONFIG,
} from './types';

/** How many blocks below the committed tip to retain — wide enough that a replica
 *  isolated by a partition can be brought current from peers' block bodies once it
 *  heals, while still bounding the serialized snapshot size. */
const PRUNE_KEEP = 64;

export function createHotStuff(config: HsConfig = DEFAULT_HOTSTUFF_CONFIG): Protocol<HsState, HsCmd> {
  // ---- small helpers -----------------------------------------------------

  const N = (ctx: NodeContext) => ctx.all.length;
  const f = (ctx: NodeContext) => faultBudget(N(ctx));
  const Q = (ctx: NodeContext) => quorum(N(ctx));

  /** Does `block` extend `ancestorHash` (is the ancestor on its parent chain)? */
  function extendsFrom(s: HsState, block: Block, ancestorHash: string): boolean {
    let cur: Block | undefined = block;
    // Walk down by parent links; stop once we drop below the ancestor's height.
    const anc = s.blocks[ancestorHash];
    const floor = anc ? anc.height : 0;
    let guard = 0;
    while (cur && cur.height >= floor && guard++ < 4096) {
      if (cur.hash === ancestorHash) return true;
      if (cur.parent === '') break;
      cur = s.blocks[cur.parent];
    }
    return false;
  }

  /** The HotStuff safe-node predicate: safety rule OR liveness rule. */
  function safeNode(s: HsState, block: Block): boolean {
    const safety = extendsFrom(s, block, s.lockedHash); // extends the locked block
    const liveness = block.justify.view > s.lockedView; // ...or carries a newer QC
    return safety || liveness;
  }

  function hasWork(s: HsState): boolean {
    if (s.pending.some((c) => !s.executedCid[c.cid])) return true;
    // A real (non-noop) command sits in an uncommitted block → keep flushing.
    for (const h of Object.keys(s.blocks)) {
      const b = s.blocks[h];
      if (b.height > s.bExecHeight && b.cmd.op.op !== 'noop' && !s.executedCid[b.cmd.cid]) return true;
    }
    return false;
  }

  // ---- the three safety variables ---------------------------------------

  function updateQcHigh(s: HsState, qc: QC): void {
    if (qc.view > s.qcHigh.view) {
      s.qcHigh = qc;
      s.timeoutStreak = 0; // genuine progress — reset the pacemaker backoff
    }
  }

  // ---- chained state update (lock + 3-chain commit) ----------------------

  /** Process a block we have accepted: advance the lock and decide via 3-chain. */
  function update(ctx: NodeContext, s: HsState, bNew: Block): void {
    updateQcHigh(s, bNew.justify); // PRE-COMMIT: adopt the carried QC if newer
    const bDD = s.blocks[bNew.justify.block]; // b'' — certified by bNew's QC
    if (!bDD) return;
    const bD = s.blocks[bDD.justify.block]; // b'
    if (!bD) return;
    const b = s.blocks[bD.justify.block]; // b
    // COMMIT/LOCK on b' (the head of the 2-chain).
    if (bD.height > s.lockedHeight) {
      s.lockedHeight = bD.height;
      s.lockedHash = bD.hash;
      s.lockedView = bD.view;
    }
    // DECIDE b iff the 3-chain is linked by direct, consecutive parent edges.
    if (b && bDD.parent === bD.hash && bD.parent === b.hash) {
      decide(ctx, s, b);
    }
  }

  /** Mark a block (and any un-executed ancestors) final, then execute in order. */
  function decide(ctx: NodeContext, s: HsState, b: Block): void {
    if (b.height <= s.bExecHeight) return;
    // Mark every uncommitted ancestor up to the execution tip as decided.
    let cur: Block | undefined = b;
    let guard = 0;
    while (cur && cur.height > s.bExecHeight && guard++ < 4096) {
      s.decided[cur.height] = cur.hash;
      if (cur.parent === '') break;
      cur = s.blocks[cur.parent];
    }
    tryExecute(ctx, s);
  }

  /** Execute the longest gap-free, properly-chained prefix of decided blocks. */
  function tryExecute(ctx: NodeContext, s: HsState): void {
    let advanced = false;
    for (;;) {
      const h = s.bExecHeight + 1;
      const hash = s.decided[h];
      if (!hash) break;
      const blk = s.blocks[hash];
      if (!blk) break; // body still missing
      if (blk.parent !== s.bExecHash) break; // must chain directly off the executed tip
      // apply
      const o = blk.cmd.op;
      if (o.op === 'set') s.kv[o.key] = o.value;
      else if (o.op === 'del') delete s.kv[o.key];
      s.bExecHeight = h;
      s.bExecHash = hash;
      s.executedCid[blk.cmd.cid] = true;
      s.pending = s.pending.filter((c) => c.cid !== blk.cmd.cid);
      const via = s.catchup[h] && s.catchup[h][hash] && Object.keys(s.catchup[h][hash]).length >= f(ctx) + 1 ? 'catchup' : 'chain';
      s.committed.push({ height: h, view: blk.view, hash, cmd: blk.cmd, via });
      if (blk.cmd.op.op !== 'noop') ctx.log('commit', `commit #${h} = ${opStr(blk.cmd)} (v${blk.view})`);
      delete s.decided[h];
      s.lastCommitHeight = h;
      advanced = true;
    }
    if (advanced) {
      if (s.committed.length > 300) s.committed.splice(0, s.committed.length - 300);
      s.timeoutStreak = 0;
      onProgress(ctx, s);
    }
  }

  // ---- proposing ---------------------------------------------------------

  /** Commands already in flight on the current certified chain (don't re-propose). */
  function onChainCids(s: HsState): Set<string> {
    const set = new Set<string>();
    let cur: Block | undefined = s.blocks[s.qcHigh.block];
    let guard = 0;
    while (cur && cur.height > s.bExecHeight && guard++ < 4096) {
      set.add(cur.cmd.cid);
      cur = s.blocks[cur.parent];
    }
    return set;
  }

  function nextPendingCmd(s: HsState): Command | null {
    const inflight = onChainCids(s);
    for (const c of s.pending) {
      if (!s.executedCid[c.cid] && !inflight.has(c.cid)) return c;
    }
    return null;
  }

  function maybePropose(ctx: NodeContext, s: HsState, force = false): void {
    if (leaderOf(ctx.all, s.curView) !== ctx.self) return;
    if (s.proposedView >= s.curView) return;
    if (s.fault === 'silent') return; // a silent leader proposes nothing
    // `force` is set when we advanced via a timeout certificate: a TC means 2f+1
    // replicas have outstanding work, so the new leader proposes (a no-op if its
    // own queue is empty) to flush the pipeline and let laggards' 3-chains close.
    if (!force && !hasWork(s)) return;
    proposeBlock(ctx, s);
  }

  function makeBlock(s: HsState, view: number, proposer: NodeId, cmd: Command): Block {
    const parentHash = s.qcHigh.block;
    const parent = s.blocks[parentHash];
    const height = (parent ? parent.height : 0) + 1;
    const hash = blockHash(view, parentHash, proposer, cmd);
    return { hash, view, height, parent: parentHash, proposer, cmd, justify: s.qcHigh };
  }

  /** A faulty leader's conflicting command (same key, mutated value/id). */
  function forge(cmd: Command): Command {
    if (cmd.op.op === 'set') return { cid: cmd.cid + '✗', op: { op: 'set', key: cmd.op.key, value: cmd.op.value + '✗' } };
    if (cmd.op.op === 'del') return { cid: cmd.cid + '✗', op: { op: 'set', key: cmd.op.key, value: '✗' } };
    return { cid: '✗' + cmd.cid, op: { op: 'set', key: 'x', value: '✗' } };
  }

  function proposeBlock(ctx: NodeContext, s: HsState): void {
    s.proposedView = s.curView;
    const cmd = nextPendingCmd(s) ?? NOOP;
    const block = makeBlock(s, s.curView, ctx.self, cmd);

    if (s.fault === 'equivocate') {
      // Byzantine leader: forge a conflicting block at the SAME view & parent and
      // send each half of the backups a different one.
      const fake = makeBlock(s, s.curView, ctx.self, forge(cmd.op.op === 'noop' ? { cid: 'q' + s.curView, op: { op: 'set', key: 'x', value: String(s.curView) } } : cmd));
      s.blocks[block.hash] = block;
      s.blocks[fake.hash] = fake;
      const backups = ctx.peers;
      ctx.broadcast('Propose', (peer) => {
        const idx = backups.indexOf(peer);
        return { block: idx >= Math.ceil(backups.length / 2) ? fake : block } as ProposeMsg;
      });
      ctx.log('state', `⚠ equivocates v${s.curView}: "${opStr(block.cmd)}" vs "${opStr(fake.cmd)}"`);
      s.note = `EQUIVOCATING @ v${s.curView}`;
      onProgress(ctx, s);
      return;
    }

    s.blocks[block.hash] = block;
    ctx.broadcast('Propose', () => ({ block } as ProposeMsg));
    ctx.log('state', `propose b#${block.height} v${s.curView} = ${opStr(cmd)}`);
    s.note = `leader v${s.curView}`;
    acceptProposal(ctx, s, block); // the leader processes its own proposal
  }

  // ---- receiving a proposal ---------------------------------------------

  function acceptProposal(ctx: NodeContext, s: HsState, block: Block): void {
    // Only the legitimate leader of a view may propose in it.
    if (block.proposer !== leaderOf(ctx.all, block.view)) return;
    if (block.view <= s.bExecHeight && block.height <= s.bExecHeight) return;
    if (!s.blocks[block.hash]) s.blocks[block.hash] = block;

    // Adopt the proposal's view if it is ahead (the QC/leader legitimises it).
    if (block.view > s.curView) advanceView(ctx, s, block.view);

    // Chain update: lock + maybe commit.
    update(ctx, s, block);

    // If we are this view's leader, a buffered-vote QC may now form.
    if (leaderOf(ctx.all, block.view) === ctx.self) recomputeQC(ctx, s, block.view);

    // Voting rule: vote at most once per height, and only for a safe node.
    if (block.height > s.vheight && safeNode(s, block) && block.view >= s.curView && s.fault !== 'silent') {
      s.vheight = block.height;
      castVote(ctx, s, block);
    }
    onProgress(ctx, s);
  }

  function castVote(ctx: NodeContext, s: HsState, block: Block): void {
    // A 'conflict' backup votes for a corrupted hash that matches no real block.
    const claimed = s.fault === 'conflict' ? block.hash + '✗' : block.hash;
    const target = leaderOf(ctx.all, block.view); // votes go to this view's leader
    const vote: VoteMsg = { view: block.view, block: claimed, from: ctx.self };
    if (target === ctx.self) {
      recordVote(ctx, s, vote);
    } else {
      ctx.send(target, 'Vote', vote);
    }
  }

  // ---- leader-side vote aggregation -------------------------------------

  function recordVote(ctx: NodeContext, s: HsState, v: VoteMsg): void {
    ((s.votes[v.view] ??= {})[v.block] ??= {})[v.from] = true;
    recomputeQC(ctx, s, v.view);
  }

  function recomputeQC(ctx: NodeContext, s: HsState, view: number): void {
    if (s.formedQC[view]) return;
    const byBlock = s.votes[view];
    if (!byBlock) return;
    for (const hash of Object.keys(byBlock)) {
      const blk = s.blocks[hash];
      if (!blk || blk.view !== view) continue; // ignore votes for unknown / forged blocks
      const voters = Object.keys(byBlock[hash]);
      if (voters.length >= Q(ctx)) {
        s.formedQC[view] = true;
        const qc: QC = { view, block: hash, voters };
        ctx.log('state', `QC v${view} on b#${blk.height} (${voters.length} votes)`);
        // Disseminate the certificate (the linear hand-off) and adopt it locally.
        if (s.fault !== 'silent') ctx.broadcast('QC', () => ({ qc } as QCMsg));
        onNewQC(ctx, s, qc);
        return;
      }
    }
  }

  /** Adopt a quorum certificate (locally formed or received): advance & maybe propose. */
  function onNewQC(ctx: NodeContext, s: HsState, qc: QC): void {
    updateQcHigh(s, qc);
    // The certified block + its 3-chain ancestors may let us lock / commit.
    const cert = s.blocks[qc.block];
    if (cert) {
      const bD = s.blocks[cert.justify.block];
      if (bD) {
        if (bD.height > s.lockedHeight) {
          s.lockedHeight = bD.height;
          s.lockedHash = bD.hash;
          s.lockedView = bD.view;
        }
        const b = s.blocks[bD.justify.block];
        if (b && cert.parent === bD.hash && bD.parent === b.hash) decide(ctx, s, b);
      }
    }
    advanceView(ctx, s, qc.view + 1);
    maybePropose(ctx, s);
  }

  // ---- the pacemaker -----------------------------------------------------

  function advanceView(ctx: NodeContext, s: HsState, v: number): void {
    if (v <= s.curView) return;
    s.curView = v;
    s.timedOutView = -1;
    onProgress(ctx, s);
    // A new leader reached via a timeout certificate proposes here.
    maybePropose(ctx, s);
  }

  function viewTimeoutMs(s: HsState): number {
    return Math.round(config.viewTimeout * (1 + 0.3 * Math.min(s.timeoutStreak, 6)));
  }

  /** (Re)arm the view timer iff there is work to time out on; disarm otherwise. */
  function onProgress(ctx: NodeContext, s: HsState): void {
    if (hasWork(s)) {
      ctx.setTimer('view', viewTimeoutMs(s) + Math.round(ctx.rng.float(0, 120)));
    } else {
      ctx.clearTimer('view');
    }
  }

  function recordTimeout(ctx: NodeContext, s: HsState, t: TimeoutMsg): void {
    (s.timeouts[t.view] ??= {})[t.from] = t.highQC;
    updateQcHigh(s, t.highQC);
    // A QC for view v proves view v finished, so a lagging replica can jump to
    // v+1. This is what re-synchronises views when one replica raced ahead — without
    // it, honest replicas can deadlock by timing out on *different* views and never
    // assembling a 2f+1 certificate for any single one.
    if (s.qcHigh.view + 1 > s.curView) advanceView(ctx, s, s.qcHigh.view + 1);
    const movers = Object.keys(s.timeouts[t.view]).length;
    if (movers >= Q(ctx) && t.view >= s.curView) {
      // Timeout certificate: jump to the next view on the highest QC seen, and
      // force the new leader to propose so the cluster's pending work can flush.
      ctx.log('state', `TC v${t.view} → advance to v${t.view + 1}`);
      advanceView(ctx, s, t.view + 1);
      maybePropose(ctx, s, true);
    } else if (movers >= f(ctx) + 1 && t.view >= s.curView && s.timedOutView !== t.view && s.fault !== 'silent') {
      // Liveness boost: f+1 peers have given up on this view, so join them.
      s.timedOutView = t.view;
      s.timeoutStreak++;
      const mine: TimeoutMsg = { view: t.view, highQC: s.qcHigh, from: ctx.self };
      (s.timeouts[t.view] ??= {})[ctx.self] = s.qcHigh;
      ctx.broadcast('Timeout', () => mine);
      recordTimeout(ctx, s, mine); // re-check now that we counted ourselves
    }
  }

  // ---- catch-up gossip (lets a lagging / restarted replica converge) -----

  function gossipStatus(ctx: NodeContext, s: HsState): void {
    if (s.fault === 'silent') return;
    ctx.broadcast('Status', () => ({ from: ctx.self, bExecHeight: s.bExecHeight } as StatusMsg));
  }

  // ---- pruning -----------------------------------------------------------

  function prune(s: HsState): void {
    const floor = s.bExecHeight - PRUNE_KEEP;
    if (floor > 0) {
      for (const h of Object.keys(s.blocks)) {
        const b = s.blocks[h];
        if (b.height < floor && h !== s.lockedHash && h !== s.qcHigh.block && h !== s.bExecHash && h !== GENESIS_HASH) {
          delete s.blocks[h];
        }
      }
    }
    const vfloor = s.curView - 8;
    for (const k of Object.keys(s.votes)) if (Number(k) < vfloor) delete s.votes[Number(k)];
    for (const k of Object.keys(s.timeouts)) if (Number(k) < vfloor) delete s.timeouts[Number(k)];
    for (const k of Object.keys(s.formedQC)) if (Number(k) < vfloor) delete s.formedQC[Number(k)];
    for (const k of Object.keys(s.decided)) if (Number(k) <= s.bExecHeight) delete s.decided[Number(k)];
    for (const k of Object.keys(s.catchup)) if (Number(k) <= s.bExecHeight) delete s.catchup[Number(k)];
  }

  // ---- protocol object ---------------------------------------------------

  return {
    name: 'HotStuff',

    init(ctx) {
      const g = genesisBlock();
      const s: HsState = {
        fault: 'honest',
        curView: 1,
        proposedView: 0,
        timedOutView: -1,
        timeoutStreak: 0,
        blocks: { [g.hash]: g },
        qcHigh: genesisQC(),
        lockedView: 0,
        lockedHash: GENESIS_HASH,
        lockedHeight: 0,
        vheight: 0,
        bExecHeight: 0,
        bExecHash: GENESIS_HASH,
        kv: {},
        committed: [],
        executedCid: {},
        votes: {},
        formedQC: {},
        timeouts: {},
        decided: {},
        catchup: {},
        pending: [],
        note: 'replica',
        lastCommitHeight: 0,
      };
      ctx.setTimer('sync', Math.round(config.syncPeriod + ctx.rng.float(0, 80)));
      return s;
    },

    onRestart(ctx, s) {
      // Durable: blocks, the three safety variables (qcHigh/lock/vheight), and the
      // committed state machine (kv/committed/bExec). Volatile: vote & timeout
      // collection and per-view proposal flags — rebuilt as the replica catches up.
      s.votes = {};
      s.timeouts = {};
      s.formedQC = {};
      s.timedOutView = -1;
      s.timeoutStreak = 0;
      s.note = 'restarted';
      ctx.setTimer('sync', Math.round(config.syncPeriod + ctx.rng.float(0, 80)));
      onProgress(ctx, s);
    },

    onCommand(ctx, s, cmd) {
      if (cmd.type === 'set-fault') {
        s.fault = cmd.mode;
        s.note = cmd.mode === 'honest' ? 'replica' : `BYZANTINE: ${cmd.mode}`;
        ctx.log('info', `fault mode → ${cmd.mode}`);
        if (cmd.mode === 'honest') maybePropose(ctx, s);
        return;
      }
      // A client request: the client multicasts to every replica.
      const c = cmd.command;
      if (s.executedCid[c.cid] || s.pending.some((p) => p.cid === c.cid)) return;
      s.pending.push(c);
      onProgress(ctx, s);
      maybePropose(ctx, s);
    },

    onTimer(ctx, s, name) {
      if (name === 'sync') {
        ctx.setTimer('sync', Math.round(config.syncPeriod + ctx.rng.float(0, 80)));
        gossipStatus(ctx, s);
        prune(s);
        return;
      }
      if (name === 'view') {
        if (!hasWork(s)) return; // nothing outstanding → no false alarm
        if (s.timedOutView === s.curView) {
          s.timeoutStreak++;
          ctx.setTimer('view', viewTimeoutMs(s) + Math.round(ctx.rng.float(0, 120)));
          return;
        }
        s.timedOutView = s.curView;
        const t: TimeoutMsg = { view: s.curView, highQC: s.qcHigh, from: ctx.self };
        ctx.log('state', `⏱ timeout v${s.curView} (suspect leader ${leaderOf(ctx.all, s.curView)})`);
        if (s.fault !== 'silent') ctx.broadcast('Timeout', () => t);
        ctx.setTimer('view', viewTimeoutMs(s) + Math.round(ctx.rng.float(0, 120)));
        recordTimeout(ctx, s, t); // count our own
        return;
      }
    },

    onMessage(ctx, s, msg: Message) {
      switch (msg.type) {
        case 'Request': {
          const c = (msg.payload as RequestMsg).command;
          if (!s.executedCid[c.cid] && !s.pending.some((p) => p.cid === c.cid)) {
            s.pending.push(c);
            onProgress(ctx, s);
            maybePropose(ctx, s);
          }
          return;
        }

        case 'Propose': {
          const block = (msg.payload as ProposeMsg).block;
          acceptProposal(ctx, s, block);
          return;
        }

        case 'Vote': {
          const v = msg.payload as VoteMsg;
          if (leaderOf(ctx.all, v.view) !== ctx.self) return; // only this view's leader tallies
          recordVote(ctx, s, v);
          return;
        }

        case 'QC': {
          onNewQC(ctx, s, (msg.payload as QCMsg).qc);
          return;
        }

        case 'Timeout': {
          recordTimeout(ctx, s, msg.payload as TimeoutMsg);
          return;
        }

        case 'Status': {
          const st = msg.payload as StatusMsg;
          if (s.fault === 'silent' || st.bExecHeight >= s.bExecHeight) return;
          const entries: Block[] = [];
          for (let h = st.bExecHeight + 1; h <= s.bExecHeight && entries.length < 64; h++) {
            const hash = s.committed.find((e) => e.height === h)?.hash;
            const blk = hash ? s.blocks[hash] : undefined;
            if (blk) entries.push(blk);
          }
          if (entries.length) ctx.send(st.from, 'Catchup', { from: ctx.self, entries } as CatchupMsg);
          return;
        }

        case 'Catchup': {
          // Record each reported committed block; once f+1 distinct replicas agree
          // on a (height, hash) it is safe to adopt (≥1 reporter is honest, and an
          // honest replica only reports what it committed — which Agreement makes
          // consistent). The block bodies arrive with the report, so we can apply.
          const cu = msg.payload as CatchupMsg;
          for (const blk of cu.entries) {
            if (blk.height <= s.bExecHeight) continue;
            if (!s.blocks[blk.hash]) s.blocks[blk.hash] = blk;
            const bySeq = (s.catchup[blk.height] ??= {});
            (bySeq[blk.hash] ??= {})[cu.from] = true;
            if (Object.keys(bySeq[blk.hash]).length >= f(ctx) + 1) {
              s.decided[blk.height] = blk.hash;
            }
          }
          tryExecute(ctx, s);
          return;
        }
      }
    },
  };
}
