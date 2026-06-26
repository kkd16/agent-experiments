// A from-scratch implementation of the Raft consensus algorithm
// (Ongaro & Ousterhout, "In Search of an Understandable Consensus Algorithm").
//
// This follows the paper's rules precisely: persistent state (currentTerm,
// votedFor, log) survives crashes; volatile state is rebuilt; elections use
// randomized timeouts; AppendEntries enforces the Log Matching property; and a
// leader only advances commitIndex for an entry from its *current* term once a
// majority has replicated it. The replicated state machine is a key/value store.
import type { Message, NodeContext, Protocol } from '../../sim/types';
import type { NodeId } from '../../sim/types';
import {
  DEFAULT_RAFT_CONFIG,
  type AppendEntries,
  type AppendEntriesResp,
  type RaftCommand,
  type RaftConfig,
  type RaftState,
  type RequestVote,
  type RequestVoteResp,
} from './types';

const lastIndex = (s: RaftState) => s.log.length;
const lastTerm = (s: RaftState) => (s.log.length ? s.log[s.log.length - 1].term : 0);
const termAt = (s: RaftState, index: number): number => {
  if (index <= 0) return 0;
  if (index > s.log.length) return -1;
  return s.log[index - 1].term;
};

export function createRaft(config: RaftConfig = DEFAULT_RAFT_CONFIG): Protocol<RaftState, RaftCommand> {
  const armElection = (ctx: NodeContext, s: RaftState) => {
    s.electionTimeout = ctx.rng.int(config.electionMin, config.electionMax);
    ctx.setTimer('election', s.electionTimeout);
  };

  const majority = (ctx: NodeContext) => Math.floor(ctx.all.length / 2) + 1;

  const becomeFollower = (ctx: NodeContext, s: RaftState, term: number, leader: NodeId | null) => {
    const wasLeader = s.role === 'leader';
    if (term > s.currentTerm) {
      s.currentTerm = term;
      s.votedFor = null;
    }
    s.role = 'follower';
    s.leaderId = leader;
    if (leader !== null) s.lastLeaderContact = ctx.now;
    if (wasLeader) ctx.clearTimer('heartbeat');
    armElection(ctx, s);
  };

  const applyCommitted = (ctx: NodeContext, s: RaftState) => {
    while (s.lastApplied < s.commitIndex) {
      s.lastApplied++;
      const entry = s.log[s.lastApplied - 1];
      if (!entry) break;
      const c = entry.cmd;
      if (c.op === 'set') s.kv[c.key] = c.value;
      else if (c.op === 'del') delete s.kv[c.key];
      ctx.log('commit', `applied #${s.lastApplied} ${describe(c)}`);
    }
  };

  const sendAppendTo = (ctx: NodeContext, s: RaftState, peer: NodeId) => {
    const next = s.nextIndex[peer] ?? lastIndex(s) + 1;
    const prevLogIndex = next - 1;
    const payload: AppendEntries = {
      term: s.currentTerm,
      leaderId: ctx.self,
      prevLogIndex,
      prevLogTerm: termAt(s, prevLogIndex),
      entries: s.log.slice(prevLogIndex),
      leaderCommit: s.commitIndex,
    };
    ctx.send(peer, 'AppendEntries', payload);
  };

  const broadcastAppend = (ctx: NodeContext, s: RaftState) => {
    for (const p of ctx.peers) sendAppendTo(ctx, s, p);
  };

  const becomeLeader = (ctx: NodeContext, s: RaftState) => {
    s.role = 'leader';
    s.leaderId = ctx.self;
    s.nextIndex = {};
    s.matchIndex = {};
    for (const p of ctx.peers) {
      s.nextIndex[p] = lastIndex(s) + 1;
      s.matchIndex[p] = 0;
    }
    ctx.log('state', `became LEADER (term ${s.currentTerm})`);
    broadcastAppend(ctx, s);
    ctx.setTimer('heartbeat', config.heartbeat);
  };

  // Pre-vote: canvass for a would-be term WITHOUT bumping our own term or
  // persisting a vote. Only if a majority say "yes, I'd vote for you right now"
  // do we start a real, term-incrementing election. This stops a node that has
  // been partitioned away (and keeps timing out) from rejoining with a wildly
  // inflated term and forcing the healthy leader to step down.
  const startPreVote = (ctx: NodeContext, s: RaftState) => {
    s.preVoteTerm = s.currentTerm + 1;
    s.preVotes = { [ctx.self]: true };
    s.role = 'follower';
    armElection(ctx, s);
    ctx.log('state', `pre-vote for term ${s.preVoteTerm}`);
    const rv: RequestVote = {
      term: s.preVoteTerm,
      candidateId: ctx.self,
      lastLogIndex: lastIndex(s),
      lastLogTerm: lastTerm(s),
    };
    ctx.broadcast('PreVote', () => rv);
  };

  const startElection = (ctx: NodeContext, s: RaftState) => {
    s.currentTerm++;
    s.role = 'candidate';
    s.votedFor = ctx.self;
    s.leaderId = null;
    s.votesGranted = { [ctx.self]: true };
    armElection(ctx, s);
    ctx.log('state', `started election (term ${s.currentTerm})`);
    const rv: RequestVote = {
      term: s.currentTerm,
      candidateId: ctx.self,
      lastLogIndex: lastIndex(s),
      lastLogTerm: lastTerm(s),
    };
    ctx.broadcast('RequestVote', () => rv);
  };

  const advanceCommit = (ctx: NodeContext, s: RaftState) => {
    for (let n = lastIndex(s); n > s.commitIndex; n--) {
      if (termAt(s, n) !== s.currentTerm) continue; // only commit current-term entries directly
      let count = 1; // self
      for (const p of ctx.peers) if ((s.matchIndex[p] ?? 0) >= n) count++;
      if (count >= majority(ctx)) {
        s.commitIndex = n;
        applyCommitted(ctx, s);
        break;
      }
    }
  };

  return {
    name: 'Raft',

    init(ctx) {
      const s: RaftState = {
        currentTerm: 0,
        votedFor: null,
        log: [],
        role: 'follower',
        leaderId: null,
        commitIndex: 0,
        lastApplied: 0,
        kv: {},
        nextIndex: {},
        matchIndex: {},
        votesGranted: {},
        lastLeaderContact: 0,
        preVoteTerm: 0,
        preVotes: {},
        electionTimeout: config.electionMin,
      };
      armElection(ctx, s);
      return s;
    },

    onRestart(ctx, s) {
      // Volatile state is rebuilt; persistent (term, votedFor, log) survives.
      s.role = 'follower';
      s.leaderId = null;
      s.commitIndex = 0;
      s.lastApplied = 0;
      s.kv = {};
      s.nextIndex = {};
      s.matchIndex = {};
      s.votesGranted = {};
      s.lastLeaderContact = 0;
      s.preVoteTerm = 0;
      s.preVotes = {};
      armElection(ctx, s);
      ctx.log('state', 'restarted as follower; replaying log from leader');
    },

    onCommand(ctx, s, cmd) {
      if (s.role !== 'leader') {
        ctx.log('info', `not leader; client command rejected (leader=${s.leaderId ?? '?'})`);
        return;
      }
      s.log.push({ term: s.currentTerm, cmd });
      ctx.log('state', `appended #${lastIndex(s)} ${describe(cmd)}`);
      broadcastAppend(ctx, s);
    },

    onTimer(ctx, s, name) {
      if (name === 'election') {
        if (s.role !== 'leader') {
          if (config.preVote) startPreVote(ctx, s);
          else startElection(ctx, s);
        }
      } else if (name === 'heartbeat') {
        if (s.role === 'leader') {
          broadcastAppend(ctx, s);
          ctx.setTimer('heartbeat', config.heartbeat);
        }
      }
    },

    onMessage(ctx, s, msg: Message) {
      switch (msg.type) {
        case 'PreVote': {
          const rv = msg.payload as RequestVote;
          const upToDate =
            rv.lastLogTerm > lastTerm(s) || (rv.lastLogTerm === lastTerm(s) && rv.lastLogIndex >= lastIndex(s));
          const recentLeader = s.lastLeaderContact > 0 && ctx.now - s.lastLeaderContact < config.electionMin;
          const granted = rv.term >= s.currentTerm && upToDate && !recentLeader;
          // NB: pre-vote never mutates currentTerm or votedFor.
          ctx.send(rv.candidateId, 'PreVoteResp', { term: s.preVoteTerm, voteGranted: granted, from: ctx.self });
          break;
        }
        case 'PreVoteResp': {
          const r = msg.payload as RequestVoteResp;
          if (s.role === 'follower' && s.preVoteTerm === s.currentTerm + 1 && r.voteGranted) {
            s.preVotes[r.from] = true;
            if (Object.values(s.preVotes).filter(Boolean).length >= majority(ctx)) startElection(ctx, s);
          }
          break;
        }
        case 'RequestVote':
          handleRequestVote(ctx, s, msg.payload as RequestVote, becomeFollower, armElection);
          break;
        case 'RequestVoteResp':
          handleVoteResp(ctx, s, msg.payload as RequestVoteResp, becomeFollower, becomeLeader, majority);
          break;
        case 'AppendEntries':
          handleAppendEntries(ctx, s, msg.payload as AppendEntries, becomeFollower, applyCommitted);
          break;
        case 'AppendEntriesResp':
          handleAppendResp(ctx, s, msg.payload as AppendEntriesResp, becomeFollower, sendAppendTo, advanceCommit);
          break;
      }
    },
  };
}

// --- message handlers (kept as free functions to stay readable) ---

function handleRequestVote(
  ctx: NodeContext,
  s: RaftState,
  rv: RequestVote,
  becomeFollower: (ctx: NodeContext, s: RaftState, term: number, leader: NodeId | null) => void,
  armElection: (ctx: NodeContext, s: RaftState) => void,
) {
  if (rv.term > s.currentTerm) becomeFollower(ctx, s, rv.term, null);
  let granted = false;
  const logOk =
    rv.lastLogTerm > lastTerm(s) || (rv.lastLogTerm === lastTerm(s) && rv.lastLogIndex >= lastIndex(s));
  if (rv.term === s.currentTerm && (s.votedFor === null || s.votedFor === rv.candidateId) && logOk) {
    granted = true;
    s.votedFor = rv.candidateId;
    armElection(ctx, s); // granting a vote resets our election timer
    ctx.log('state', `voted for ${rv.candidateId} (term ${s.currentTerm})`);
  }
  const resp: RequestVoteResp = { term: s.currentTerm, voteGranted: granted, from: ctx.self };
  ctx.send(rv.candidateId, 'RequestVoteResp', resp);
}

function handleVoteResp(
  ctx: NodeContext,
  s: RaftState,
  r: RequestVoteResp,
  becomeFollower: (ctx: NodeContext, s: RaftState, term: number, leader: NodeId | null) => void,
  becomeLeader: (ctx: NodeContext, s: RaftState) => void,
  majority: (ctx: NodeContext) => number,
) {
  if (r.term > s.currentTerm) {
    becomeFollower(ctx, s, r.term, null);
    return;
  }
  if (s.role !== 'candidate' || r.term !== s.currentTerm) return; // stale
  if (r.voteGranted) {
    s.votesGranted[r.from] = true;
    const votes = Object.values(s.votesGranted).filter(Boolean).length;
    if (votes >= majority(ctx)) becomeLeader(ctx, s);
  }
}

function handleAppendEntries(
  ctx: NodeContext,
  s: RaftState,
  ae: AppendEntries,
  becomeFollower: (ctx: NodeContext, s: RaftState, term: number, leader: NodeId | null) => void,
  applyCommitted: (ctx: NodeContext, s: RaftState) => void,
) {
  const reply = (success: boolean, matchIndex: number, conflictIndex: number) => {
    const resp: AppendEntriesResp = { term: s.currentTerm, success, from: ctx.self, matchIndex, conflictIndex };
    ctx.send(ae.leaderId, 'AppendEntriesResp', resp);
  };

  if (ae.term < s.currentTerm) {
    reply(false, 0, 0);
    return;
  }
  // Valid leader for this (or a newer) term: recognize it and reset the timer.
  becomeFollower(ctx, s, ae.term, ae.leaderId);

  // Consistency check on the entry preceding the new ones.
  if (ae.prevLogIndex > 0) {
    if (s.log.length < ae.prevLogIndex) {
      reply(false, 0, s.log.length + 1); // we're too short; back up to our end
      return;
    }
    if (termAt(s, ae.prevLogIndex) !== ae.prevLogTerm) {
      // find the first index of the conflicting term for a fast back-up
      const badTerm = termAt(s, ae.prevLogIndex);
      let ci = ae.prevLogIndex;
      while (ci > 1 && termAt(s, ci - 1) === badTerm) ci--;
      reply(false, 0, ci);
      return;
    }
  }

  // Append any new entries, truncating on the first real conflict only.
  for (let i = 0; i < ae.entries.length; i++) {
    const index = ae.prevLogIndex + 1 + i;
    if (termAt(s, index) !== ae.entries[i].term) {
      s.log.length = index - 1; // truncate conflicting suffix
      for (let j = i; j < ae.entries.length; j++) s.log.push(ae.entries[j]);
      break;
    }
  }

  if (ae.leaderCommit > s.commitIndex) {
    s.commitIndex = Math.min(ae.leaderCommit, ae.prevLogIndex + ae.entries.length);
    applyCommitted(ctx, s);
  }
  reply(true, ae.prevLogIndex + ae.entries.length, 0);
}

function handleAppendResp(
  ctx: NodeContext,
  s: RaftState,
  r: AppendEntriesResp,
  becomeFollower: (ctx: NodeContext, s: RaftState, term: number, leader: NodeId | null) => void,
  sendAppendTo: (ctx: NodeContext, s: RaftState, peer: NodeId) => void,
  advanceCommit: (ctx: NodeContext, s: RaftState) => void,
) {
  if (r.term > s.currentTerm) {
    becomeFollower(ctx, s, r.term, null);
    return;
  }
  if (s.role !== 'leader' || r.term !== s.currentTerm) return; // stale
  if (r.success) {
    s.matchIndex[r.from] = Math.max(s.matchIndex[r.from] ?? 0, r.matchIndex);
    s.nextIndex[r.from] = s.matchIndex[r.from] + 1;
    advanceCommit(ctx, s);
  } else {
    s.nextIndex[r.from] = Math.max(1, r.conflictIndex);
    sendAppendTo(ctx, s, r.from); // retry immediately with an earlier prefix
  }
}

function describe(c: RaftCommand): string {
  if (c.op === 'set') return `${c.key}=${c.value}`;
  if (c.op === 'del') return `del ${c.key}`;
  return 'noop';
}
