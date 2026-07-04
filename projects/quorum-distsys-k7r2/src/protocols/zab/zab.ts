// A from-scratch implementation of Zab — the ZooKeeper Atomic Broadcast protocol
// (Junqueira, Reed & Serafini, "Zab: High-performance broadcast for
// primary-backup systems", DSN 2011), the consensus engine inside ZooKeeper.
//
// Zab is the fourth canonical crash-fault consensus protocol beside Raft, Paxos
// and Viewstamped Replication, and the one purpose-built for the primary-backup
// model: an elected primary (leader) turns each client write into an ordered
// transaction stamped with a `zxid` = (epoch, counter), and atomically broadcasts
// it so that every replica delivers it in the same order — the guarantee ZooKeeper
// calls **primary order**. All four sub-protocols the paper defines run here on the
// shared kernel:
//
//   0. Fast Leader Election — servers exchange ballots (their currentEpoch +
//      lastZxid, ties broken by id) until a quorum backs the peer with the most
//      up-to-date log. That peer becomes the prospective leader.
//   1. Discovery — followers send FOLLOWERINFO(acceptedEpoch); the leader picks a
//      NEWEPOCH one past the largest it sees, and each follower ACKEPOCHs with its
//      full history so the leader can select the most up-to-date one in the quorum.
//   2. Synchronization — the leader forces that history onto a quorum (NEWLEADER →
//      ACK-LD), then UPTODATE lets everyone deliver it, so all replicas start the
//      new epoch identical. A late-joining learner is synced the same way, live.
//   3. Broadcast — normal operation: the leader PROPOSEs each transaction, commits
//      it once a quorum has ACKed, and COMMITs — two-phase atomic broadcast.
//
// Unlike VR, Zab keeps a DURABLE log: `history`, `acceptedEpoch`, `currentEpoch`,
// the committed prefix and the state machine all survive a crash (the kernel keeps
// a node's `state` across crash/restart; only volatile election/leader state is
// reset in `onRestart`). Recovery is therefore by log reconciliation through
// election + synchronization, not by replaying from peers.
import type { Message, NodeContext, Protocol } from '../../sim/types';
import {
  DEFAULT_ZAB_CONFIG,
  ZERO_ZXID,
  betterVote,
  cmpZxid,
  describeOp,
  fmtZxid,
  lastZxidOf,
  quorum,
  zxidKey,
  type Ack,
  type AckEpoch,
  type AckNewLeader,
  type CommitMsg,
  type FollowerInfo,
  type NewEpoch,
  type NewLeader,
  type Ping,
  type PingAck,
  type Propose,
  type UpToDate,
  type Vote,
  type VoteMsg,
  type ZabCommand,
  type ZabConfig,
  type ZabReply,
  type ZabRequest,
  type ZabState,
  type ZabTxn,
  type Zxid,
} from './types';

export function createZab(config: ZabConfig = DEFAULT_ZAB_CONFIG): Protocol<ZabState, ZabCommand> {
  const N = (s: ZabState) => s.configuration.length;
  const idName = (s: ZabState, sid: number) => s.configuration[sid];
  const others = (s: ZabState) => s.configuration.filter((_, i) => i !== s.serverId);
  const isLeader = (s: ZabState) => s.role === 'leading' && s.leader === s.serverId;

  const myVote = (s: ZabState): Vote => ({
    leader: s.serverId,
    epoch: s.currentEpoch,
    zxid: lastZxidOf(s.history),
  });

  // The zxid this server expects next in the broadcast stream: the first counter
  // of the current epoch, or one past the last entry if we are already in it.
  const nextExpectedZxid = (s: ZabState): Zxid => {
    const last = lastZxidOf(s.history);
    if (last.epoch === s.currentEpoch) return { epoch: s.currentEpoch, counter: last.counter + 1 };
    return { epoch: s.currentEpoch, counter: 1 };
  };

  // Deliver (execute) every committed-but-undelivered transaction into the state
  // machine, in zxid order, recording a reply in the client table (at-most-once).
  const deliverUpTo = (ctx: NodeContext, s: ZabState, targetCount: number) => {
    const limit = Math.min(targetCount, s.history.length);
    while (s.lastCommitted < limit) {
      const txn = s.history[s.lastCommitted];
      s.lastCommitted++;
      const req = txn.request;
      let result: string | null = null;
      if (req.op.op === 'set') {
        s.kv[req.op.key] = req.op.value;
        result = req.op.value;
      } else if (req.op.op === 'del') {
        result = req.op.key in s.kv ? s.kv[req.op.key] : null;
        delete s.kv[req.op.key];
      }
      const reply: ZabReply = { requestNumber: req.requestNumber, result };
      s.clientTable[req.clientId] = reply;
      if (req.op.op !== 'noop') ctx.log('commit', `delivered ${fmtZxid(txn.zxid)} ${describeOp(req.op)}`);
      if (isLeader(s)) s.lastReply = reply;
    }
  };

  /** How many contiguous leading history entries have zxid ≤ z. */
  const countUpToZxid = (s: ZabState, z: Zxid): number => {
    let c = 0;
    while (c < s.history.length && cmpZxid(s.history[c].zxid, z) <= 0) c++;
    return c;
  };

  // A follower delivers whatever contiguous prefix of its history the leader has
  // told it is committed (works even when proposals arrived out of order and only
  // a shorter prefix is present yet).
  const commitFollower = (ctx: NodeContext, s: ZabState) => {
    deliverUpTo(ctx, s, countUpToZxid(s, s.leaderCommitZxid));
  };

  // ---- timers ----

  const armFollow = (ctx: NodeContext, s: ZabState) => {
    s.timeoutMs = ctx.rng.int(config.timeoutMin, config.timeoutMax);
    ctx.setTimer('follow', s.timeoutMs);
  };
  const armTick = (ctx: NodeContext) => ctx.setTimer('tick', config.electionTimeout);
  const armHeartbeat = (ctx: NodeContext) => ctx.setTimer('heartbeat', config.heartbeat);

  const clearAllTimers = (ctx: NodeContext) => {
    ctx.clearTimer('follow');
    ctx.clearTimer('tick');
    ctx.clearTimer('heartbeat');
    ctx.clearTimer('finalize');
  };

  // ---- Phase 0: Fast Leader Election ----

  const resetVolatile = (s: ZabState) => {
    s.followerInfo = {};
    s.ackEpoch = {};
    s.ackLeader = [];
    s.proposalAcks = {};
    s.followerAlive = {};
    s.pendingProposals = {};
    s.newEpoch = 0;
    s.syncing = false;
  };

  const startElection = (ctx: NodeContext, s: ZabState) => {
    s.role = 'looking';
    s.phase = 'election';
    s.leader = null;
    s.logicalClock++;
    resetVolatile(s);
    s.vote = myVote(s);
    s.votes = { [String(s.serverId)]: s.vote };
    s.outOfElection = {};
    s.finalizePending = false;
    clearAllTimers(ctx);
    armTick(ctx);
    ctx.log('state', `election round ${s.logicalClock} → vote ${idName(s, s.vote.leader)}`);
    broadcastVote(ctx, s);
    checkElectionDecision(ctx, s); // N===1 decides immediately
  };

  const broadcastVote = (ctx: NodeContext, s: ZabState) => {
    const m: VoteMsg = { round: s.logicalClock, vote: s.vote, from: s.serverId, state: s.role };
    for (const id of others(s)) ctx.send(id, 'ZabVote', m);
  };

  const cancelFinalize = (ctx: NodeContext, s: ZabState) => {
    if (s.finalizePending) {
      s.finalizePending = false;
      ctx.clearTimer('finalize');
    }
  };

  const adoptVote = (ctx: NodeContext, s: ZabState, v: Vote) => {
    if (betterVote(v, s.vote)) {
      s.vote = { ...v };
      cancelFinalize(ctx, s); // the ballot moved — any pending conclusion is stale
      broadcastVote(ctx, s);
    }
  };

  const voteTally = (s: ZabState): number =>
    Object.values(s.votes).filter((v) => v.leader === s.vote.leader).length;

  // On first reaching a quorum for the current ballot, wait a short window for the
  // votes to settle before concluding (ZK's finalizeWait) — this is what stops two
  // nodes from each latching onto a transient quorum and becoming rival leaders.
  const checkElectionDecision = (ctx: NodeContext, s: ZabState) => {
    if (s.role !== 'looking') return;
    if (voteTally(s) >= quorum(N(s)) && !s.finalizePending) {
      s.finalizePending = true;
      ctx.setTimer('finalize', Math.max(60, Math.floor(config.electionTimeout / 2)));
    }
  };

  const decideLeader = (ctx: NodeContext, s: ZabState, leaderId: number) => {
    s.leader = leaderId;
    ctx.clearTimer('tick');
    if (leaderId === s.serverId) {
      // Become the prospective leader and open Discovery: wait for FOLLOWERINFO.
      s.role = 'leading';
      s.phase = 'discovery';
      resetVolatile(s);
      s.followerInfo[String(s.serverId)] = s.acceptedEpoch; // count ourselves
      armTick(ctx); // retry timer drives NEWEPOCH/NEWLEADER resends
      armFollow(ctx, s); // ...but give up and re-elect if recovery stalls (split vote)
      ctx.log('state', `won election → prospective LEADER (discovery), lastZxid ${fmtZxid(lastZxidOf(s.history))}`);
    } else {
      // Follow the winner: send FOLLOWERINFO and await NEWEPOCH.
      s.role = 'following';
      s.phase = 'discovery';
      resetVolatile(s);
      armTick(ctx); // resends FOLLOWERINFO until NEWEPOCH arrives
      armFollow(ctx, s); // gives up on a dead prospective leader
      sendFollowerInfo(ctx, s);
      ctx.log('state', `following ${idName(s, leaderId)} → discovery`);
    }
  };

  const sendFollowerInfo = (ctx: NodeContext, s: ZabState) => {
    if (s.leader === null) return;
    const m: FollowerInfo = { acceptedEpoch: s.acceptedEpoch, from: s.serverId };
    ctx.send(idName(s, s.leader), 'ZabFollowerInfo', m);
  };

  function onVote(ctx: NodeContext, s: ZabState, m: VoteMsg) {
    // An established (leading/following) server answers an election notification
    // with the CURRENT leader, so a lone looking node (e.g. one that just
    // restarted) learns who is in charge instead of stalling forever. It replies
    // ONLY to a looking peer — never to another established node, or two of them
    // would echo notifications back and forth forever.
    if (s.role !== 'looking') {
      if (s.leader !== null && m.state === 'looking') {
        const reply: VoteMsg = {
          round: s.logicalClock,
          vote: { leader: s.leader, epoch: s.currentEpoch, zxid: lastZxidOf(s.history) },
          from: s.serverId,
          state: s.role,
        };
        ctx.send(idName(s, m.from), 'ZabVote', reply);
      }
      return;
    }

    // A notification from a peer that is already FOLLOWING / LEADING is evidence of
    // an established leader, NOT a fresh ballot. Keep it out of the ballot set so a
    // crashed ex-leader (still highest-ranked) can't poison a new election, and only
    // join that leader once a quorum backs it and the leader has confirmed itself.
    if (m.state !== 'looking') {
      s.outOfElection[String(m.from)] = { vote: m.vote, state: m.state, from: m.from };
      checkOutOfElection(ctx, s);
      return;
    }

    if (m.round > s.logicalClock) {
      // A newer election is underway — join it, keeping the better of the ballots.
      s.logicalClock = m.round;
      s.votes = { [String(s.serverId)]: s.vote };
      cancelFinalize(ctx, s);
      if (betterVote(m.vote, s.vote)) s.vote = { ...m.vote };
      s.votes[String(m.from)] = m.vote;
      broadcastVote(ctx, s);
      checkElectionDecision(ctx, s);
    } else if (m.round === s.logicalClock) {
      s.votes[String(m.from)] = m.vote;
      adoptVote(ctx, s, m.vote);
      checkElectionDecision(ctx, s);
    } else {
      // Sender is behind: nudge it forward with our current ballot.
      const reply: VoteMsg = { round: s.logicalClock, vote: s.vote, from: s.serverId, state: s.role };
      ctx.send(idName(s, m.from), 'ZabVote', reply);
    }
  }

  // Join an already-established leader L iff a quorum of FOLLOWING/LEADING peers
  // back L *and* L itself has confirmed leadership (a LEADING self-vote). The
  // confirmation is the crucial guard: a dead ex-leader never sends it, so it can
  // never be re-elected, even though it may still outrank every live candidate.
  const checkOutOfElection = (ctx: NodeContext, s: ZabState) => {
    if (s.role !== 'looking') return;
    const tally = new Map<number, number>();
    for (const e of Object.values(s.outOfElection)) tally.set(e.vote.leader, (tally.get(e.vote.leader) ?? 0) + 1);
    for (const [leaderId, count] of tally) {
      if (count < quorum(N(s))) continue;
      const confirmed = Object.values(s.outOfElection).some(
        (e) => e.vote.leader === leaderId && e.from === leaderId && e.state === 'leading',
      );
      if (confirmed) {
        decideLeader(ctx, s, leaderId);
        return;
      }
    }
  };

  // ---- Phase 1: Discovery ----

  function onFollowerInfo(ctx: NodeContext, s: ZabState, m: FollowerInfo) {
    if (s.role !== 'leading') return;
    if (s.phase === 'discovery') {
      s.followerInfo[String(m.from)] = m.acceptedEpoch;
      maybeSendNewEpoch(ctx, s);
    } else if (s.phase === 'broadcast') {
      // A learner joining an already-established epoch: sync it directly.
      syncLearner(ctx, s, m.from);
    }
  }

  const maybeSendNewEpoch = (ctx: NodeContext, s: ZabState) => {
    if (s.role !== 'leading' || s.phase !== 'discovery') return;
    const infos = Object.keys(s.followerInfo);
    if (infos.length < quorum(N(s))) return;
    if (s.newEpoch === 0) {
      const maxAccepted = Math.max(s.acceptedEpoch, ...Object.values(s.followerInfo));
      s.newEpoch = maxAccepted + 1;
      s.acceptedEpoch = s.newEpoch; // the leader accepts its own new epoch
      ctx.log('state', `discovery quorum → NEWEPOCH ${s.newEpoch}`);
    }
    const m: NewEpoch = { epoch: s.newEpoch, from: s.serverId };
    for (const sid of Object.keys(s.followerInfo)) {
      if (Number(sid) !== s.serverId) ctx.send(idName(s, Number(sid)), 'ZabNewEpoch', m);
    }
    maybeSelectHistory(ctx, s); // a single-node ensemble needs no ACKEPOCH from peers
  };

  // Once a quorum (incl. self) has ACKEPOCH'd, adopt the most up-to-date history
  // among them and move to synchronization.
  const maybeSelectHistory = (ctx: NodeContext, s: ZabState) => {
    if (s.role !== 'leading' || s.phase !== 'discovery' || s.newEpoch === 0) return;
    if (Object.keys(s.ackEpoch).length + 1 < quorum(N(s))) return;
    let bestEpoch = s.currentEpoch;
    let bestZxid = lastZxidOf(s.history);
    let bestHistory = s.history;
    for (const a of Object.values(s.ackEpoch)) {
      if (a.currentEpoch > bestEpoch || (a.currentEpoch === bestEpoch && cmpZxid(a.lastZxid, bestZxid) > 0)) {
        bestEpoch = a.currentEpoch;
        bestZxid = a.lastZxid;
        bestHistory = a.history;
      }
    }
    s.history = bestHistory.slice();
    ctx.log('state', `selected newest history (epoch ${bestEpoch}, lastZxid ${fmtZxid(bestZxid)}) → synchronization`);
    enterSynchronization(ctx, s);
  };

  function onNewEpoch(ctx: NodeContext, s: ZabState, m: NewEpoch) {
    if (s.role !== 'following' || s.phase !== 'discovery') return;
    if (s.leader === null || m.from !== s.leader) return;
    if (m.epoch < s.acceptedEpoch) {
      // A stale prospective leader — abandon it and re-elect.
      startElection(ctx, s);
      return;
    }
    s.acceptedEpoch = m.epoch;
    armFollow(ctx, s);
    const reply: AckEpoch = {
      epoch: m.epoch,
      currentEpoch: s.currentEpoch,
      lastZxid: lastZxidOf(s.history),
      history: s.history.slice(),
      from: s.serverId,
    };
    ctx.send(idName(s, s.leader), 'ZabAckEpoch', reply);
    ctx.log('state', `accepted epoch ${m.epoch}; ACKEPOCH (currentEpoch ${s.currentEpoch})`);
  }

  function onAckEpoch(ctx: NodeContext, s: ZabState, m: AckEpoch) {
    if (s.role !== 'leading' || s.phase !== 'discovery' || m.epoch !== s.newEpoch) return;
    s.ackEpoch[String(m.from)] = m;
    maybeSelectHistory(ctx, s);
  }

  // ---- Phase 2: Synchronization ----

  const enterSynchronization = (ctx: NodeContext, s: ZabState) => {
    s.phase = 'synchronization';
    s.currentEpoch = s.newEpoch;
    s.counter = 0; // new epoch numbers its own proposals from 1
    s.ackLeader = [String(s.serverId)]; // the leader has the history by construction
    armFollow(ctx, s); // re-elect if synchronization stalls
    sendNewLeaderToAll(ctx, s);
    maybeUpToDate(ctx, s); // N===1 completes immediately
  };

  const sendNewLeaderToAll = (ctx: NodeContext, s: ZabState) => {
    // Initial epoch sync: the whole recovered history becomes committed once a
    // quorum ACK-LDs, so the commit point is the last zxid of that history.
    const m: NewLeader = {
      epoch: s.currentEpoch,
      history: s.history.slice(),
      commitZxid: lastZxidOf(s.history),
      from: s.serverId,
    };
    for (const sid of Object.keys(s.ackEpoch)) {
      if (Number(sid) !== s.serverId) ctx.send(idName(s, Number(sid)), 'ZabNewLeader', m);
    }
  };

  // Sync one learner that is joining an already-established epoch mid-broadcast.
  // It must adopt the full log (so future proposals are contiguous) but deliver
  // only the leader's COMMITTED prefix — the uncommitted tail waits for COMMIT.
  const syncLearner = (ctx: NodeContext, s: ZabState, sid: number) => {
    const m: NewLeader = {
      epoch: s.currentEpoch,
      history: s.history.slice(),
      commitZxid: s.leaderCommitZxid,
      from: s.serverId,
    };
    ctx.send(idName(s, sid), 'ZabNewLeader', m);
  };

  function onNewLeader(ctx: NodeContext, s: ZabState, m: NewLeader) {
    if (s.role !== 'following' || s.leader === null || m.from !== s.leader) return;
    if (m.epoch < s.acceptedEpoch) return; // stale
    // Adopt the leader's authoritative history (it contains our committed prefix).
    s.acceptedEpoch = m.epoch;
    s.currentEpoch = m.epoch;
    s.history = m.history.slice();
    s.pendingProposals = {};
    s.leaderCommitZxid = m.commitZxid;
    if (s.lastCommitted > s.history.length) s.lastCommitted = s.history.length;
    s.syncing = true;
    s.phase = 'synchronization';
    armFollow(ctx, s);
    const reply: AckNewLeader = { epoch: m.epoch, from: s.serverId };
    ctx.send(idName(s, s.leader), 'ZabAckNewLeader', reply);
    ctx.log('state', `NEWLEADER epoch ${m.epoch}: adopted ${s.history.length}-entry history; ACK-LD`);
  }

  function onAckNewLeader(ctx: NodeContext, s: ZabState, m: AckNewLeader) {
    if (s.role !== 'leading' || m.epoch !== s.currentEpoch) return;
    if (!s.ackLeader.includes(String(m.from))) s.ackLeader.push(String(m.from));
    s.followerAlive[String(m.from)] = ctx.now; // ACK-LD is a liveness signal
    if (s.phase === 'synchronization') {
      maybeUpToDate(ctx, s);
    } else if (s.phase === 'broadcast') {
      // A learner that joined an established epoch: send it UPTODATE directly.
      ctx.send(idName(s, m.from), 'ZabUpToDate', { epoch: s.currentEpoch, from: s.serverId } as UpToDate);
    }
  }

  const maybeUpToDate = (ctx: NodeContext, s: ZabState) => {
    if (s.role !== 'leading' || s.phase !== 'synchronization') return;
    if (s.ackLeader.length < quorum(N(s))) return;
    // A quorum durably holds the initial history: deliver it and go live.
    s.phase = 'broadcast';
    s.leaderCommitZxid = lastZxidOf(s.history);
    deliverUpTo(ctx, s, s.history.length);
    // Seed proposal-ack tallies for the synced history (a quorum ACK-LD'd it) and
    // treat those ACK-LDs as fresh liveness so we don't step down before pings flow.
    for (const txn of s.history) s.proposalAcks[zxidKey(txn.zxid)] = [...s.ackLeader];
    const m: UpToDate = { epoch: s.currentEpoch, from: s.serverId };
    for (const sid of s.ackLeader) {
      if (Number(sid) === s.serverId) continue;
      ctx.send(idName(s, Number(sid)), 'ZabUpToDate', m);
      s.followerAlive[sid] = ctx.now;
    }
    ctx.clearTimer('tick');
    ctx.clearTimer('follow'); // now live: heartbeats replace the recovery timeout
    armHeartbeat(ctx);
    ctx.log('state', `LEADER of epoch ${s.currentEpoch} (committed ${s.lastCommitted}); broadcasting`);
  };

  function onUpToDate(ctx: NodeContext, s: ZabState, m: UpToDate) {
    if (s.role !== 'following' || s.leader === null || m.from !== s.leader) return;
    if (m.epoch !== s.currentEpoch) return;
    s.syncing = false;
    s.phase = 'broadcast';
    // Deliver only up to the commit point the leader gave us in NEWLEADER — the
    // whole log for an initial epoch sync, the committed prefix for a live learner.
    commitFollower(ctx, s);
    ctx.clearTimer('tick');
    armFollow(ctx, s);
    // ACK back so the leader counts us among its live followers.
    ctx.send(idName(s, s.leader), 'ZabPingAck', { epoch: s.currentEpoch, from: s.serverId } as PingAck);
    ctx.log('state', `UPTODATE epoch ${m.epoch}: synced & serving (committed ${s.lastCommitted})`);
  }

  // ---- Phase 3: Broadcast ----

  const handleRequest = (ctx: NodeContext, s: ZabState, req: ZabRequest) => {
    if (!isLeader(s) || s.phase !== 'broadcast') {
      ctx.log('info', `not leader/broadcast; request dropped (leader=${s.leader !== null ? idName(s, s.leader) : '∅'})`);
      return;
    }
    const prev = s.clientTable[req.clientId];
    if (prev && req.requestNumber < prev.requestNumber) return; // stale
    if (prev && prev.requestNumber === req.requestNumber) {
      s.lastReply = prev; // duplicate of the latest — resend, no new txn
      return;
    }
    const zxid: Zxid = { epoch: s.currentEpoch, counter: ++s.counter };
    const txn: ZabTxn = { zxid, request: req };
    s.history.push(txn);
    s.proposalAcks[zxidKey(zxid)] = [String(s.serverId)]; // the leader holds it
    ctx.log('state', `PROPOSE ${fmtZxid(zxid)} ${describeOp(req.op)}`);
    const m: Propose = { epoch: s.currentEpoch, txn, from: s.serverId };
    for (const id of others(s)) ctx.send(id, 'ZabPropose', m);
    if (N(s) === 1) leaderAdvanceCommit(ctx, s);
  };

  const leaderAdvanceCommit = (ctx: NodeContext, s: ZabState) => {
    if (!isLeader(s) || s.phase !== 'broadcast') return;
    const need = quorum(N(s));
    let idx = s.lastCommitted;
    while (idx < s.history.length) {
      const acks = s.proposalAcks[zxidKey(s.history[idx].zxid)];
      if (!acks || acks.length < need) break;
      idx++;
    }
    if (idx > s.lastCommitted) {
      const committedZxid = s.history[idx - 1].zxid;
      s.leaderCommitZxid = committedZxid;
      deliverUpTo(ctx, s, idx);
      const m: CommitMsg = { epoch: s.currentEpoch, zxid: committedZxid, from: s.serverId };
      for (const id of others(s)) ctx.send(id, 'ZabCommit', m);
    }
  };

  // Drain buffered out-of-order proposals into the history in zxid order, ACKing
  // each as it becomes contiguous.
  const drainPending = (ctx: NodeContext, s: ZabState) => {
    let progressed = true;
    while (progressed) {
      progressed = false;
      const want = nextExpectedZxid(s);
      const txn = s.pendingProposals[zxidKey(want)];
      if (txn) {
        s.history.push(txn);
        delete s.pendingProposals[zxidKey(want)];
        if (s.leader !== null) ctx.send(idName(s, s.leader), 'ZabAck', { epoch: s.currentEpoch, zxid: txn.zxid, from: s.serverId } as Ack);
        progressed = true;
      }
    }
    commitFollower(ctx, s);
  };

  function onPropose(ctx: NodeContext, s: ZabState, m: Propose) {
    if (s.role !== 'following' || s.leader === null || m.from !== s.leader) return;
    if (m.epoch > s.currentEpoch) {
      startElection(ctx, s); // a newer leader exists — rejoin
      return;
    }
    if (m.epoch < s.currentEpoch || s.phase !== 'broadcast') return;
    armFollow(ctx, s);
    if (cmpZxid(m.txn.zxid, lastZxidOf(s.history)) <= 0) return; // already have it
    s.pendingProposals[zxidKey(m.txn.zxid)] = m.txn;
    drainPending(ctx, s);
  }

  function onAck(ctx: NodeContext, s: ZabState, m: Ack) {
    if (!isLeader(s) || m.epoch !== s.currentEpoch || s.phase !== 'broadcast') return;
    s.followerAlive[String(m.from)] = ctx.now;
    const key = zxidKey(m.zxid);
    const acks = s.proposalAcks[key] ?? (s.proposalAcks[key] = []);
    if (!acks.includes(String(m.from))) acks.push(String(m.from));
    leaderAdvanceCommit(ctx, s);
  }

  function onCommit(ctx: NodeContext, s: ZabState, m: CommitMsg) {
    if (s.role !== 'following' || s.leader === null || m.from !== s.leader) return;
    if (m.epoch > s.currentEpoch) {
      startElection(ctx, s);
      return;
    }
    if (m.epoch < s.currentEpoch || s.phase !== 'broadcast') return;
    armFollow(ctx, s);
    if (cmpZxid(m.zxid, s.leaderCommitZxid) > 0) s.leaderCommitZxid = m.zxid;
    commitFollower(ctx, s);
  }

  function onPing(ctx: NodeContext, s: ZabState, m: Ping) {
    if (s.role !== 'following' || s.leader === null || m.from !== s.leader) return;
    if (m.epoch > s.currentEpoch) {
      startElection(ctx, s);
      return;
    }
    if (m.epoch < s.currentEpoch) return;
    if (s.phase !== 'broadcast') return;
    armFollow(ctx, s);
    if (cmpZxid(m.lastCommittedZxid, s.leaderCommitZxid) > 0) s.leaderCommitZxid = m.lastCommittedZxid;
    commitFollower(ctx, s);
    ctx.send(idName(s, s.leader), 'ZabPingAck', { epoch: s.currentEpoch, from: s.serverId } as PingAck);
  }

  function onPingAck(ctx: NodeContext, s: ZabState, m: PingAck) {
    if (!isLeader(s)) return;
    if (m.epoch > s.currentEpoch) {
      startElection(ctx, s); // deposed
      return;
    }
    if (m.epoch === s.currentEpoch) s.followerAlive[String(m.from)] = ctx.now;
  }

  return {
    name: 'ZooKeeper Atomic Broadcast',

    init(ctx) {
      const configuration = [...ctx.all];
      const serverId = configuration.indexOf(ctx.self);
      const s: ZabState = {
        configuration,
        serverId,
        acceptedEpoch: 0,
        currentEpoch: 0,
        history: [],
        lastCommitted: 0,
        kv: {},
        clientTable: {},
        role: 'looking',
        phase: 'election',
        leader: null,
        logicalClock: 0,
        vote: { leader: serverId, epoch: 0, zxid: ZERO_ZXID },
        votes: {},
        outOfElection: {},
        finalizePending: false,
        newEpoch: 0,
        followerInfo: {},
        ackEpoch: {},
        ackLeader: [],
        proposalAcks: {},
        followerAlive: {},
        counter: 0,
        syncing: false,
        pendingProposals: {},
        leaderCommitZxid: ZERO_ZXID,
        lastReply: null,
        timeoutMs: config.timeoutMin,
      };
      startElection(ctx, s);
      return s;
    },

    onRestart(ctx, s) {
      // Durable state (history, epochs, committed prefix, kv) survives the crash;
      // rejoin the ensemble through a fresh election.
      startElection(ctx, s);
    },

    onCommand(ctx, s, cmd) {
      if (cmd.type === 'elect') {
        startElection(ctx, s);
        return;
      }
      handleRequest(ctx, s, { clientId: cmd.clientId, requestNumber: cmd.requestNumber, op: cmd.op });
    },

    onTimer(ctx, s, name) {
      if (name === 'tick') {
        if (s.role === 'looking') {
          broadcastVote(ctx, s);
          armTick(ctx);
        } else if (s.role === 'following' && s.phase === 'discovery') {
          sendFollowerInfo(ctx, s);
          armTick(ctx);
        } else if (s.role === 'leading' && s.phase === 'discovery') {
          if (s.newEpoch === 0) maybeSendNewEpoch(ctx, s);
          else {
            const m: NewEpoch = { epoch: s.newEpoch, from: s.serverId };
            for (const sid of Object.keys(s.followerInfo)) if (Number(sid) !== s.serverId) ctx.send(idName(s, Number(sid)), 'ZabNewEpoch', m);
          }
          armTick(ctx);
        } else if (s.role === 'leading' && s.phase === 'synchronization') {
          sendNewLeaderToAll(ctx, s);
          armTick(ctx);
        }
      } else if (name === 'finalize') {
        // The finalize window elapsed: conclude the election iff the ballot still
        // holds a quorum (else it is still in flux — re-arm and keep waiting).
        s.finalizePending = false;
        if (s.role === 'looking') {
          if (voteTally(s) >= quorum(N(s))) decideLeader(ctx, s, s.vote.leader);
          else checkElectionDecision(ctx, s);
        }
      } else if (name === 'follow') {
        // Lost the leader, a prospective leader died, or our own recovery stalled
        // (a split vote) — start a fresh election.
        if (s.role === 'following' || (s.role === 'leading' && s.phase !== 'broadcast')) startElection(ctx, s);
      } else if (name === 'heartbeat') {
        if (isLeader(s) && s.phase === 'broadcast') {
          const alive = Object.entries(s.followerAlive).filter(([, t]) => ctx.now - t <= config.leaderTimeout).length;
          if (alive + 1 < quorum(N(s)) && N(s) > 1) {
            ctx.log('state', `lost follower quorum (${alive + 1}/${quorum(N(s))}) — stepping down`);
            startElection(ctx, s);
            return;
          }
          const m: Ping = { epoch: s.currentEpoch, lastCommittedZxid: s.leaderCommitZxid, from: s.serverId };
          for (const id of others(s)) ctx.send(id, 'ZabPing', m);
          armHeartbeat(ctx);
        }
      }
    },

    onMessage(ctx, s, msg: Message) {
      switch (msg.type) {
        case 'ZabVote':
          onVote(ctx, s, msg.payload as VoteMsg);
          break;
        case 'ZabFollowerInfo':
          onFollowerInfo(ctx, s, msg.payload as FollowerInfo);
          break;
        case 'ZabNewEpoch':
          onNewEpoch(ctx, s, msg.payload as NewEpoch);
          break;
        case 'ZabAckEpoch':
          onAckEpoch(ctx, s, msg.payload as AckEpoch);
          break;
        case 'ZabNewLeader':
          onNewLeader(ctx, s, msg.payload as NewLeader);
          break;
        case 'ZabAckNewLeader':
          onAckNewLeader(ctx, s, msg.payload as AckNewLeader);
          break;
        case 'ZabUpToDate':
          onUpToDate(ctx, s, msg.payload as UpToDate);
          break;
        case 'ZabPropose':
          onPropose(ctx, s, msg.payload as Propose);
          break;
        case 'ZabAck':
          onAck(ctx, s, msg.payload as Ack);
          break;
        case 'ZabCommit':
          onCommit(ctx, s, msg.payload as CommitMsg);
          break;
        case 'ZabPing':
          onPing(ctx, s, msg.payload as Ping);
          break;
        case 'ZabPingAck':
          onPingAck(ctx, s, msg.payload as PingAck);
          break;
      }
    },
  };
}
