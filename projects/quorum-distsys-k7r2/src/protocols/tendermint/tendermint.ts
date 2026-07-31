// Tendermint — gossip-based BFT state-machine replication (Buchman 2016;
// Buchman, Kwon & Milošević, "The latest gossip on BFT consensus", 2018).
//
// This is a faithful implementation of the paper's **Algorithm 1**. Every state
// variable and every "upon …" rule maps onto the code below; the comments cite
// the paper's line numbers. The one thing the sim adds is a block-sync gossip so
// a validator that crashed or was partitioned can rejoin — the paper assumes a
// gossip layer and leaves sync abstract.
//
// The state machine, in one breath: decide one block per HEIGHT by climbing a
// ladder of ROUNDS, each round three STEPS (propose → prevote → precommit). The
// round's proposer is validators[(H+R) mod N]. A value that gathers 2f+1 prevotes
// is a **Polka**; seeing one makes a validator LOCK the value and precommit it;
// 2f+1 precommits for a value (at ANY round) DECIDE it. The lock — and the rule
// that a locked validator will not prevote a different value in a later round
// unless it sees an even-later Polka — is precisely what keeps two rounds of one
// height from deciding differently. Safety holds under full asynchrony; growing
// per-round timeouts buy liveness once the network is synchronous.
import type { NodeContext, Message, Protocol } from '../../sim/types';
import {
  faultBudget,
  quorum,
  proposerOf,
  blockHash,
  validBlock,
  opStr,
  NOOP,
  NIL,
  GENESIS_HASH,
  type TendermintState,
  type TendermintConfig,
  type TendermintCmd,
  type Block,
  type Command,
  type Step,
  type ProposalMsg,
  type PrevoteMsg,
  type PrecommitMsg,
  type StatusMsg,
  type SyncMsg,
  type RequestMsg,
  DEFAULT_TENDERMINT_CONFIG,
} from './types';

/** How many heights of decided blocks to retain for serving block-sync. */
const SYNC_KEEP = 64;
/** How many finished rounds of vote logs to retain within a height. */
const ROUND_KEEP = 8;

const STEP_RANK: Record<Step, number> = { propose: 0, prevote: 1, precommit: 2 };
const stepGE = (a: Step, b: Step) => STEP_RANK[a] >= STEP_RANK[b];

export function createTendermint(config: TendermintConfig = DEFAULT_TENDERMINT_CONFIG): Protocol<TendermintState, TendermintCmd> {
  const N = (ctx: NodeContext) => ctx.all.length;
  const f = (ctx: NodeContext) => faultBudget(N(ctx));
  const Q = (ctx: NodeContext) => quorum(N(ctx));
  const proposer = (ctx: NodeContext, h: number, r: number) => proposerOf(ctx.all, h, r);

  // ---- vote-tally helpers ------------------------------------------------

  /** Distinct validators that voted `id` in `round` of the given tally. */
  const idCount = (log: Record<number, Record<string, Record<string, true>>>, round: number, id: string): number => {
    const byId = log[round];
    if (!byId || !byId[id]) return 0;
    return Object.keys(byId[id]).length;
  };
  /** Distinct validators that cast ANY vote in `round` of the given tally. */
  const anyCount = (log: Record<number, Record<string, Record<string, true>>>, round: number): number => {
    const byId = log[round];
    if (!byId) return 0;
    const voters = new Set<string>();
    for (const id of Object.keys(byId)) for (const v of Object.keys(byId[id])) voters.add(v);
    return voters.size;
  };
  /** The id (≠ nil) that reached the quorum in `round`, if any. */
  const quorumId = (log: Record<number, Record<string, Record<string, true>>>, round: number, q: number): string | null => {
    const byId = log[round];
    if (!byId) return null;
    for (const id of Object.keys(byId)) {
      if (id !== NIL && Object.keys(byId[id]).length >= q) return id;
    }
    return null;
  };

  // ---- timers ------------------------------------------------------------

  /** Step timeout, growing linearly with the round (partial synchrony) but capped
   *  so a long partition — which can climb many rounds with no progress — does not
   *  leave the cluster with multi-minute timeouts once it heals. */
  const timeoutFor = (step: Step, round: number): number => {
    const base = step === 'propose' ? config.timeoutPropose : step === 'prevote' ? config.timeoutPrevote : config.timeoutPrecommit;
    return base + Math.min(round, 8) * config.timeoutDelta;
  };
  /** Arm a step timeout, tagging the name with (height, round) so a stale timer
   *  from an old height/round is recognised and ignored when it fires. */
  const armTimeout = (ctx: NodeContext, s: TendermintState, step: Step, round: number): void => {
    ctx.setTimer(`${step}#${s.height}#${round}`, timeoutFor(step, round));
  };

  // ---- learning block bodies --------------------------------------------

  /** Remember a value's body (from a proposal or a vote) so we can recognise its
   *  id later — but only if the body is well-formed and matches its stated id. */
  function learn(s: TendermintState, block: Block | undefined): void {
    if (!block) return;
    if (!validBlock(block)) return;
    if (!s.blocks[block.hash]) s.blocks[block.hash] = block;
  }

  // ---- getValue / proposing ---------------------------------------------

  const hasWork = (s: TendermintState) => s.pending.some((c) => !s.executedCid[c.cid]);
  function nextCmd(s: TendermintState): Command {
    for (const c of s.pending) if (!s.executedCid[c.cid]) return c;
    return NOOP;
  }
  const makeBlock = (h: number, round: number, self: string, cmd: Command): Block => ({
    hash: blockHash(h, round, self, cmd),
    height: h,
    round,
    proposer: self,
    cmd,
  });
  /** A faulty proposer's conflicting command (same key, mutated value/id). */
  function forgeCmd(cmd: Command): Command {
    if (cmd.op.op === 'set') return { cid: cmd.cid + '✗', op: { op: 'set', key: cmd.op.key, value: cmd.op.value + '✗' } };
    if (cmd.op.op === 'del') return { cid: cmd.cid + '✗', op: { op: 'set', key: cmd.op.key, value: '✗' } };
    return { cid: '✗' + cmd.cid, op: { op: 'set', key: 'x', value: '✗' } };
  }

  // ---- StartRound (Algorithm 1, lines 11-21) -----------------------------

  /** Begin (or jump to) `round` of the current height. Resets the step and,
   *  if this replica is the proposer, proposes; otherwise arms the propose
   *  timeout. A totally-idle replica at round 0 parks instead (no work → no
   *  empty-block churn), and wakes when a request arrives or a proposal lands. */
  function startRound(ctx: NodeContext, s: TendermintState, round: number): void {
    s.round = round;
    s.step = 'propose';
    enterPropose(ctx, s);
  }

  /** The propose-step entry, made lazy so an idle cluster stays quiet. */
  function enterPropose(ctx: NodeContext, s: TendermintState): void {
    const r = s.round;
    if (s.step !== 'propose') return;
    if (s.proposeEntered[r]) return;
    // Park while genuinely idle at round 0 (nothing to order, nothing locked).
    if (r === 0 && !hasWork(s) && !s.validValue) return;
    s.proposeEntered[r] = true;

    if (proposer(ctx, s.height, r) === ctx.self && s.fault !== 'silent') {
      proposeValue(ctx, s);
    } else {
      armTimeout(ctx, s, 'propose', r);
    }
  }

  /** This replica is the round's proposer: broadcast a value (lines 15-19). */
  function proposeValue(ctx: NodeContext, s: TendermintState): void {
    const r = s.round;

    // Byzantine proposer: equivocate — two conflicting values in the SAME round,
    // one to each half of the validators, and double-prevote both (worst case).
    if (s.fault === 'equivocate') {
      const base = nextCmd(s);
      const realCmd = base.op.op === 'noop' ? ({ cid: 'q' + s.height + '.' + r, op: { op: 'set', key: 'x', value: `${s.height}.${r}` } } as Command) : base;
      const a = makeBlock(s.height, r, ctx.self, realCmd);
      const b = makeBlock(s.height, r, ctx.self, forgeCmd(realCmd));
      learn(s, a);
      learn(s, b);
      const peers = ctx.peers;
      ctx.broadcast('Proposal', (peer) => {
        const half = peers.indexOf(peer) >= Math.ceil(peers.length / 2);
        return { height: s.height, round: r, block: half ? b : a, validRound: -1 } as ProposalMsg;
      });
      // Double-prevote for BOTH forks — safety must survive this.
      s.step = 'prevote';
      broadcastPrevote(ctx, s, r, a.hash, a);
      broadcastPrevote(ctx, s, r, b.hash, b);
      ctx.log('state', `⚠ equivocates H${s.height} r${r}: "${opStr(a.cmd)}" vs "${opStr(b.cmd)}"`);
      s.note = `EQUIVOCATING @ H${s.height} r${r}`;
      return;
    }

    // Honest proposer: re-propose the valid value if we hold one (so a lock the
    // cluster formed in an earlier round is honoured), else draw a fresh block.
    const block = s.validValue ?? makeBlock(s.height, r, ctx.self, nextCmd(s));
    const validRound = s.validValue ? s.validRound : -1;
    learn(s, block);
    ctx.broadcast('Proposal', () => ({ height: s.height, round: r, block, validRound } as ProposalMsg));
    ctx.log('state', `propose H${s.height} r${r} = ${opStr(block.cmd)}${validRound >= 0 ? ` (valid r${validRound})` : ''}`);
    s.note = `proposer H${s.height} r${r}`;
    // The proposer processes its own proposal like any validator.
    applyProposal(ctx, s, s.height, r, block, validRound, ctx.self);
  }

  // ---- receiving a proposal ---------------------------------------------

  function applyProposal(ctx: NodeContext, s: TendermintState, h: number, r: number, block: Block, validRound: number, from: string): void {
    if (h !== s.height) return; // only the current height's proposals matter
    if (from !== proposer(ctx, h, r)) return; // only the legitimate proposer may propose
    learn(s, block);
    noteSender(s, r, from);
    if (!s.proposals[r]) s.proposals[r] = { block, validRound };
    reevaluate(ctx, s);
  }

  // ---- casting votes -----------------------------------------------------

  function broadcastPrevote(ctx: NodeContext, s: TendermintState, round: number, id: string, block: Block | undefined): void {
    if (s.fault === 'silent') return;
    if (s.fault === 'conflict' && id !== NIL) {
      // Lying validator: vote a corrupted id that matches no real block.
      const fake = id + '✗';
      ctx.broadcast('Prevote', () => ({ height: s.height, round, id: fake, from: ctx.self } as PrevoteMsg));
      recordPrevote(ctx, s, round, fake, undefined, ctx.self);
      return;
    }
    ctx.broadcast('Prevote', () => ({ height: s.height, round, id, block, from: ctx.self } as PrevoteMsg));
    recordPrevote(ctx, s, round, id, block, ctx.self);
  }

  function broadcastPrecommit(ctx: NodeContext, s: TendermintState, round: number, id: string, block: Block | undefined): void {
    if (s.fault === 'silent') return;
    if (s.fault === 'conflict' && id !== NIL) {
      const fake = id + '✗';
      ctx.broadcast('Precommit', () => ({ height: s.height, round, id: fake, from: ctx.self } as PrecommitMsg));
      recordPrecommit(ctx, s, round, fake, undefined, ctx.self);
      return;
    }
    ctx.broadcast('Precommit', () => ({ height: s.height, round, id, block, from: ctx.self } as PrecommitMsg));
    recordPrecommit(ctx, s, round, id, block, ctx.self);
  }

  function noteSender(s: TendermintState, round: number, from: string): void {
    (s.roundSenders[round] ??= {})[from] = true;
  }

  function recordPrevote(ctx: NodeContext, s: TendermintState, round: number, id: string, block: Block | undefined, from: string): void {
    learn(s, block);
    noteSender(s, round, from);
    const byId = (s.prevotes[round] ??= {});
    (byId[id] ??= {})[from] = true;
    reevaluate(ctx, s);
  }

  function recordPrecommit(ctx: NodeContext, s: TendermintState, round: number, id: string, block: Block | undefined, from: string): void {
    learn(s, block);
    noteSender(s, round, from);
    const byId = (s.precommits[round] ??= {});
    (byId[id] ??= {})[from] = true;
    reevaluate(ctx, s);
  }

  // ---- the prevote decision (lines 22-27 and 28-33) ----------------------

  /** Decide this round's prevote for a proposal that arrived with `validRound`.
   *  This is the safety-critical rule: a locked validator prevotes the proposal
   *  only if it is (a) its own locked value, or (b) backed by a Polka from a round
   *  ≥ its lock round; otherwise it prevotes nil. */
  function prevoteOnProposal(ctx: NodeContext, s: TendermintState, block: Block, validRound: number): void {
    if (s.step !== 'propose') return;
    const okLock = s.lockedRound <= validRound || (s.lockedValue !== null && s.lockedValue.hash === block.hash);
    const id = validBlock(block) && okLock ? block.hash : NIL;
    s.step = 'prevote';
    broadcastPrevote(ctx, s, s.round, id, id === NIL ? undefined : block);
  }

  // ---- the "upon" rules, re-evaluated after every state change -----------

  function reevaluate(ctx: NodeContext, s: TendermintState): void {
    const q = Q(ctx);
    const r = s.round;

    // Line 22: proposal for the current round with validRound = −1, in step
    // propose → cast the initial prevote.
    const cur = s.proposals[r];
    if (cur && cur.validRound === -1 && s.step === 'propose') {
      prevoteOnProposal(ctx, s, cur.block, -1);
    }

    // Line 28: proposal carrying a Proof-of-Lock (validRound vr, 0 ≤ vr < r) AND
    // 2f+1 prevotes for id(v) in round vr, in step propose → prevote on it.
    if (cur && cur.validRound >= 0 && cur.validRound < r && s.step === 'propose') {
      if (idCount(s.prevotes, cur.validRound, cur.block.hash) >= q) {
        prevoteOnProposal(ctx, s, cur.block, cur.validRound);
      }
    }

    // Line 34: 2f+1 prevotes for *anything* in round r, in step prevote, first
    // time → arm the prevote timeout (waits a bounded time for a Polka to form).
    if (s.step === 'prevote' && !s.timeoutPrevoteArmed[r] && anyCount(s.prevotes, r) >= q) {
      s.timeoutPrevoteArmed[r] = true;
      armTimeout(ctx, s, 'prevote', r);
    }

    // Line 36: a Polka — proposal for round r AND 2f+1 prevotes for id(v),
    // v valid, step ≥ prevote, first time → LOCK and precommit (if still in
    // prevote); always refresh validValue/validRound.
    if (cur && !s.lockFired[r] && validBlock(cur.block) && stepGE(s.step, 'prevote') && idCount(s.prevotes, r, cur.block.hash) >= q) {
      s.lockFired[r] = true;
      if (s.step === 'prevote') {
        s.lockedValue = cur.block;
        s.lockedRound = r;
        s.step = 'precommit';
        broadcastPrecommit(ctx, s, r, cur.block.hash, cur.block);
        ctx.log('state', `🔒 lock H${s.height} r${r} = ${opStr(cur.block.cmd)} → precommit`);
      }
      s.validValue = cur.block;
      s.validRound = r;
    }

    // Line 44: 2f+1 prevotes for nil in round r, step prevote → precommit nil.
    if (s.step === 'prevote' && idCount(s.prevotes, r, NIL) >= q) {
      s.step = 'precommit';
      broadcastPrecommit(ctx, s, r, NIL, undefined);
    }

    // Line 47: 2f+1 precommits for *anything* in round r, first time → arm the
    // precommit timeout (bounded wait before climbing to the next round).
    if (!s.timeoutPrecommitArmed[r] && anyCount(s.precommits, r) >= q) {
      s.timeoutPrecommitArmed[r] = true;
      armTimeout(ctx, s, 'precommit', r);
    }

    // Line 49: for SOME round rr, a value with 2f+1 precommits that we hold and
    // that is valid → DECIDE it at this height. (rr need not be our current
    // round — this is why a validator that precommitted nil can still decide.)
    if (!s.decision[s.height]) {
      for (const key of Object.keys(s.precommits)) {
        const rr = Number(key);
        const id = quorumId(s.precommits, rr, q);
        if (!id) continue;
        const block = s.blocks[id];
        if (block && validBlock(block) && block.height === s.height) {
          decide(ctx, s, block, rr);
          return; // height advanced; state reset — stop evaluating the old height
        }
      }
    }

    // Line 55: f+1 messages from a higher round hint the cluster has moved on —
    // jump straight to that round so a lagging replica catches up.
    for (const key of Object.keys(s.roundSenders)) {
      const rr = Number(key);
      if (rr > s.round && Object.keys(s.roundSenders[rr]).length >= f(ctx) + 1) {
        startRound(ctx, s, rr);
        return;
      }
    }
  }

  // ---- deciding a height (lines 49-54) -----------------------------------

  function decide(ctx: NodeContext, s: TendermintState, block: Block, round: number): void {
    if (s.decision[s.height]) return;
    s.decision[s.height] = block;
    applyDecision(ctx, s, block, round, 'commit');
    if (block.cmd.op.op !== 'noop') ctx.log('commit', `decide H${block.height} = ${opStr(block.cmd)} (r${round})`);
    advanceHeight(ctx, s);
  }

  /** Execute a decided block into the KV state machine and the log. */
  function applyDecision(ctx: NodeContext, s: TendermintState, block: Block, round: number, via: 'commit' | 'sync'): void {
    const o = block.cmd.op;
    if (o.op === 'set') s.kv[o.key] = o.value;
    else if (o.op === 'del') delete s.kv[o.key];
    s.decidedHeight = block.height;
    s.executedCid[block.cmd.cid] = true;
    s.pending = s.pending.filter((c) => c.cid !== block.cmd.cid);
    s.committed.push({ height: block.height, round, hash: block.hash, cmd: block.cmd, via });
    if (s.committed.length > 400) s.committed.splice(0, s.committed.length - 400);
    void ctx;
  }

  /** Move to the next height: reset per-height consensus state, then StartRound(0). */
  function advanceHeight(ctx: NodeContext, s: TendermintState): void {
    s.height = s.decidedHeight + 1;
    s.round = 0;
    s.step = 'propose';
    s.lockedValue = null;
    s.lockedRound = -1;
    s.validValue = null;
    s.validRound = -1;
    s.proposals = {};
    s.prevotes = {};
    s.precommits = {};
    s.roundSenders = {};
    s.proposeEntered = {};
    s.timeoutPrevoteArmed = {};
    s.timeoutPrecommitArmed = {};
    s.lockFired = {};
    s.note = `H${s.height}`;
    startRound(ctx, s, 0);
  }

  // ---- timeouts (OnTimeout*, lines 57-67) --------------------------------

  function onTimeout(ctx: NodeContext, s: TendermintState, step: Step, h: number, r: number): void {
    if (h !== s.height || r !== s.round) return; // stale timer from an old height/round
    if (step === 'propose') {
      // Line 57: still waiting on a proposal → prevote nil, advance to prevote.
      if (s.step === 'propose') {
        s.step = 'prevote';
        broadcastPrevote(ctx, s, r, NIL, undefined);
      }
    } else if (step === 'prevote') {
      // Line 61: saw 2f+1 prevotes but no Polka → precommit nil.
      if (s.step === 'prevote') {
        s.step = 'precommit';
        broadcastPrecommit(ctx, s, r, NIL, undefined);
      }
    } else {
      // Line 65: no decision this round → climb to the next round.
      startRound(ctx, s, r + 1);
    }
  }

  // ---- block-sync gossip (lets a lagging / restarted replica converge) ---

  function gossipStatus(ctx: NodeContext, s: TendermintState): void {
    if (s.fault === 'silent') return;
    ctx.broadcast('Status', () => ({ from: ctx.self, decidedHeight: s.decidedHeight } as StatusMsg));
  }

  /** The id (possibly nil) this replica itself voted in `round` of a tally. */
  function myVote(log: Record<number, Record<string, Record<string, true>>>, round: number, self: string): string | null {
    const byId = log[round];
    if (!byId) return null;
    for (const id of Object.keys(byId)) if (byId[id][self]) return id;
    return null;
  }

  /** Anti-entropy: periodically re-broadcast our current-round proposal and votes.
   *  Real Tendermint runs a continuous gossip layer, so a message dropped on its
   *  first send is re-shared until every peer has it. Without this, a single drop
   *  would silently fail a round; with it, the cluster is live under message loss. */
  function regossip(ctx: NodeContext, s: TendermintState): void {
    if (s.fault === 'silent') return;
    const r = s.round;
    if (proposer(ctx, s.height, r) === ctx.self && s.proposals[r]) {
      const p = s.proposals[r];
      ctx.broadcast('Proposal', () => ({ height: s.height, round: r, block: p.block, validRound: p.validRound } as ProposalMsg));
    }
    const pv = myVote(s.prevotes, r, ctx.self);
    if (pv) ctx.broadcast('Prevote', () => ({ height: s.height, round: r, id: pv, block: s.blocks[pv], from: ctx.self } as PrevoteMsg));
    const pc = myVote(s.precommits, r, ctx.self);
    if (pc) ctx.broadcast('Precommit', () => ({ height: s.height, round: r, id: pc, block: s.blocks[pc], from: ctx.self } as PrecommitMsg));
  }

  /** Apply any contiguous decided heights we have collected an f+1 certificate
   *  for (≥1 honest reporter ⇒ the value is the truly-decided one). */
  function applySync(ctx: NodeContext, s: TendermintState): void {
    let advanced = false;
    for (;;) {
      const h = s.decidedHeight + 1;
      const bySeq = s.sync[h];
      if (!bySeq) break;
      let chosen: Block | null = null;
      for (const hash of Object.keys(bySeq)) {
        if (Object.keys(bySeq[hash]).length >= f(ctx) + 1) {
          const b = s.blocks[hash];
          if (b && validBlock(b) && b.height === h) chosen = b;
        }
      }
      if (!chosen) break;
      s.decision[h] = chosen;
      applyDecision(ctx, s, chosen, chosen.round, 'sync');
      advanced = true;
    }
    if (advanced) advanceHeight(ctx, s);
  }

  // ---- pruning -----------------------------------------------------------

  function prune(s: TendermintState): void {
    const efloor = s.round - ROUND_KEEP;
    for (const map of [s.proposals, s.prevotes, s.precommits, s.roundSenders, s.proposeEntered, s.timeoutPrevoteArmed, s.timeoutPrecommitArmed, s.lockFired]) {
      for (const k of Object.keys(map)) if (Number(k) < efloor) delete (map as Record<number, unknown>)[Number(k)];
    }
    const hfloor = s.decidedHeight - SYNC_KEEP;
    if (hfloor > 0) {
      for (const k of Object.keys(s.decision)) if (Number(k) < hfloor && Number(k) !== 0) delete s.decision[Number(k)];
      for (const k of Object.keys(s.sync)) if (Number(k) <= s.decidedHeight) delete s.sync[Number(k)];
      for (const h of Object.keys(s.blocks)) {
        const b = s.blocks[h];
        if (b.height < hfloor && b.hash !== GENESIS_HASH) delete s.blocks[h];
      }
    }
  }

  // ---- protocol object ---------------------------------------------------

  const genesis = (): Block => ({ hash: GENESIS_HASH, height: 0, round: 0, proposer: '∅', cmd: NOOP });

  return {
    name: 'Tendermint',

    init(ctx) {
      const g = genesis();
      const s: TendermintState = {
        fault: 'honest',
        height: 1,
        round: 0,
        step: 'propose',
        lockedValue: null,
        lockedRound: -1,
        validValue: null,
        validRound: -1,
        proposals: {},
        prevotes: {},
        precommits: {},
        roundSenders: {},
        proposeEntered: {},
        timeoutPrevoteArmed: {},
        timeoutPrecommitArmed: {},
        lockFired: {},
        blocks: { [GENESIS_HASH]: g },
        decision: { 0: g },
        decidedHeight: 0,
        kv: {},
        committed: [],
        executedCid: {},
        sync: {},
        pending: [],
        note: 'validator',
      };
      ctx.setTimer('sync', Math.round(config.syncPeriod + ctx.rng.float(0, 80)));
      return s;
    },

    onRestart(ctx, s) {
      // lockedValue / lockedRound / the decided log are durable — a restart must
      // never let a validator unlock and equivocate. We re-derive our position in
      // the current height and re-arm the sync timer; peers catch us up via gossip.
      s.note = 'restarted';
      s.step = 'propose';
      s.proposeEntered = {};
      s.timeoutPrevoteArmed = {};
      s.timeoutPrecommitArmed = {};
      ctx.setTimer('sync', Math.round(config.syncPeriod + ctx.rng.float(0, 80)));
      startRound(ctx, s, s.round);
    },

    onCommand(ctx, s, cmd) {
      if (cmd.type === 'set-fault') {
        s.fault = cmd.mode;
        s.note = cmd.mode === 'honest' ? 'validator' : `BYZANTINE: ${cmd.mode}`;
        ctx.log('info', `fault mode → ${cmd.mode}`);
        return;
      }
      const c = cmd.command;
      if (s.executedCid[c.cid] || s.pending.some((p) => p.cid === c.cid)) return;
      s.pending.push(c);
      enterPropose(ctx, s); // wake an idle validator to drive the height
    },

    onTimer(ctx, s, name) {
      if (name === 'sync') {
        ctx.setTimer('sync', Math.round(config.syncPeriod + ctx.rng.float(0, 80)));
        gossipStatus(ctx, s);
        regossip(ctx, s);
        prune(s);
        return;
      }
      const [step, h, r] = name.split('#');
      if (step === 'propose' || step === 'prevote' || step === 'precommit') {
        onTimeout(ctx, s, step as Step, Number(h), Number(r));
      }
    },

    onMessage(ctx, s, msg: Message) {
      switch (msg.type) {
        case 'Request': {
          const c = (msg.payload as RequestMsg).command;
          if (!s.executedCid[c.cid] && !s.pending.some((p) => p.cid === c.cid)) {
            s.pending.push(c);
            enterPropose(ctx, s);
          }
          return;
        }

        case 'Proposal': {
          const p = msg.payload as ProposalMsg;
          applyProposal(ctx, s, p.height, p.round, p.block, p.validRound, msg.from);
          return;
        }

        case 'Prevote': {
          const v = msg.payload as PrevoteMsg;
          if (v.height !== s.height) return;
          recordPrevote(ctx, s, v.round, v.id, v.block, v.from);
          return;
        }

        case 'Precommit': {
          const v = msg.payload as PrecommitMsg;
          if (v.height !== s.height) return;
          recordPrecommit(ctx, s, v.round, v.id, v.block, v.from);
          return;
        }

        case 'Status': {
          const st = msg.payload as StatusMsg;
          if (s.fault === 'silent' || st.decidedHeight >= s.decidedHeight) return;
          const entries: Block[] = [];
          for (let h = st.decidedHeight + 1; h <= s.decidedHeight && entries.length < SYNC_KEEP; h++) {
            const b = s.decision[h];
            if (b) entries.push(b);
          }
          if (entries.length) ctx.send(st.from, 'Sync', { from: ctx.self, entries } as SyncMsg);
          return;
        }

        case 'Sync': {
          const sy = msg.payload as SyncMsg;
          for (const b of sy.entries) {
            if (b.height <= s.decidedHeight) continue;
            learn(s, b);
            const bySeq = (s.sync[b.height] ??= {});
            (bySeq[b.hash] ??= {})[sy.from] = true;
          }
          applySync(ctx, s);
          return;
        }
      }
    },
  };
}
