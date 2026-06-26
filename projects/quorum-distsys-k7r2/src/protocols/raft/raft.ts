// A from-scratch implementation of the Raft consensus algorithm
// (Ongaro & Ousterhout, "In Search of an Understandable Consensus Algorithm").
//
// This follows the paper's rules precisely: persistent state (currentTerm,
// votedFor, log, snapshot) survives crashes; volatile state is rebuilt; elections
// use randomized timeouts; AppendEntries enforces the Log Matching property; and a
// leader only advances commitIndex for an entry from its *current* term once a
// majority has replicated it. The replicated state machine is a key/value store.
//
// On top of the core it implements three of Raft's harder extensions, each
// dormant unless used so the base algorithm is byte-for-byte unchanged:
//   • Log compaction via snapshots + InstallSnapshot (§7),
//   • Cluster membership changes via joint consensus, Cold,new → Cnew (§6),
//   • Linearizable reads via the ReadIndex / leader-confirmation protocol (§8).
import type { Message, NodeContext, NodeId, Protocol } from '../../sim/types';
import {
  DEFAULT_RAFT_CONFIG,
  type AppendEntries,
  type AppendEntriesResp,
  type ClusterConfig,
  type InstallSnapshot,
  type InstallSnapshotResp,
  type PendingRead,
  type RaftCommand,
  type RaftConfig,
  type RaftState,
  type ReadHeartbeat,
  type ReadHeartbeatResp,
  type RequestVote,
  type RequestVoteResp,
} from './types';

// ---- log-index helpers (account for the compacted snapshot prefix) ----
//
// With a snapshot, the live array `log` holds absolute indices
// `snapshotIndex+1 .. snapshotIndex+log.length`; array position p ↔ index
// `snapshotIndex + p + 1`. All callers speak in absolute 1-based indices.

const lastIndex = (s: RaftState) => s.snapshotIndex + s.log.length;
const lastTerm = (s: RaftState) => (s.log.length ? s.log[s.log.length - 1].term : s.snapshotTerm);

const entryAt = (s: RaftState, index: number) => {
  const i = index - s.snapshotIndex - 1;
  return i >= 0 && i < s.log.length ? s.log[i] : undefined;
};

const termAt = (s: RaftState, index: number): number => {
  if (index <= 0) return 0;
  if (index === s.snapshotIndex) return s.snapshotTerm;
  if (index < s.snapshotIndex) return -1; // folded into the snapshot — term unknown here
  const e = entryAt(s, index);
  return e ? e.term : -1;
};

// ---- cluster-configuration helpers (membership changes) ----

/** The configuration active as of absolute index `upto` (latest 'config' entry ≤ upto). */
const configAsOf = (s: RaftState, upto: number): ClusterConfig => {
  for (let i = s.log.length - 1; i >= 0; i--) {
    const absIdx = s.snapshotIndex + i + 1;
    if (absIdx > upto) continue;
    const c = s.log[i].cmd;
    if (c.op === 'config') return { old: c.old, next: c.next };
  }
  return s.snapshotIndex > 0 ? s.snapshotConfig : s.bootstrap;
};

/** The configuration Raft acts on: the most recent in the log, committed or not. */
const currentConfig = (s: RaftState): ClusterConfig => configAsOf(s, lastIndex(s));

/** Every server that participates in agreement under `cfg` (old ∪ new during a joint config). */
const voters = (cfg: ClusterConfig): NodeId[] => {
  if (!cfg.next) return cfg.old;
  return [...new Set([...cfg.old, ...cfg.next])];
};

const isVoter = (cfg: ClusterConfig, id: NodeId): boolean => voters(cfg).includes(id);

/** Does `granted` form a majority in `cfg`? Joint configs need a majority in BOTH sets. */
const hasMajority = (cfg: ClusterConfig, granted: Set<NodeId>): boolean => {
  const maj = (set: NodeId[]) => set.filter((id) => granted.has(id)).length >= Math.floor(set.length / 2) + 1;
  if (!cfg.next) return maj(cfg.old);
  return maj(cfg.old) && maj(cfg.next);
};

export function createRaft(config: RaftConfig = DEFAULT_RAFT_CONFIG): Protocol<RaftState, RaftCommand> {
  const armElection = (ctx: NodeContext, s: RaftState) => {
    s.electionTimeout = ctx.rng.int(config.electionMin, config.electionMax);
    ctx.setTimer('election', s.electionTimeout);
  };

  // Peers we should replicate to: members of the active configuration, minus self.
  const replicaTargets = (ctx: NodeContext, s: RaftState): NodeId[] =>
    voters(currentConfig(s)).filter((id) => id !== ctx.self && ctx.all.includes(id));

  const becomeFollower = (ctx: NodeContext, s: RaftState, term: number, leader: NodeId | null) => {
    const wasLeader = s.role === 'leader';
    if (term > s.currentTerm) {
      s.currentTerm = term;
      s.votedFor = null;
    }
    s.role = 'follower';
    s.leaderId = leader;
    if (leader !== null) s.lastLeaderContact = ctx.now;
    if (wasLeader) {
      ctx.clearTimer('heartbeat');
      s.pendingReads = []; // a deposed leader abandons its in-flight reads
    }
    armElection(ctx, s);
  };

  const applyCommitted = (ctx: NodeContext, s: RaftState) => {
    let configChanged = false;
    while (s.lastApplied < s.commitIndex) {
      s.lastApplied++;
      const entry = entryAt(s, s.lastApplied);
      if (!entry) break; // shouldn't happen: applied indices are always present
      const c = entry.cmd;
      if (c.op === 'set') s.kv[c.key] = c.value;
      else if (c.op === 'del') delete s.kv[c.key];
      else if (c.op === 'config') configChanged = true;
      if (c.op === 'set' || c.op === 'del') ctx.log('commit', `applied #${s.lastApplied} ${describe(c)}`);
    }
    // When a joint configuration Cold,new commits, the leader appends the final Cnew.
    if (configChanged && s.role === 'leader') {
      const cfg = currentConfig(s);
      if (cfg.next) {
        s.log.push({ term: s.currentTerm, cmd: { op: 'config', old: cfg.next, next: null } });
        ctx.log('state', `Cold,new committed → appending Cnew {${cfg.next.join('')}}`);
        broadcastAppend(ctx, s);
      } else if (!isVoter(cfg, ctx.self)) {
        // Cnew committed and excludes us: a removed leader steps down.
        ctx.log('state', 'removed from configuration — stepping down');
        becomeFollower(ctx, s, s.currentTerm, null);
      }
    }
    maybeCompact(ctx, s);
  };

  // Fold every applied entry up to lastApplied into a snapshot once enough pile up.
  const maybeCompact = (ctx: NodeContext, s: RaftState) => {
    if (config.snapshotThreshold <= 0) return;
    if (s.lastApplied - s.snapshotIndex < config.snapshotThreshold) return;
    const upto = s.lastApplied;
    const t = termAt(s, upto);
    if (t < 0) return;
    s.snapshotConfig = configAsOf(s, upto);
    s.log = s.log.slice(upto - s.snapshotIndex);
    s.snapshotIndex = upto;
    s.snapshotTerm = t;
    s.snapshotKv = { ...s.kv };
    ctx.log('state', `compacted log ≤ #${upto} into a snapshot`);
  };

  const sendSnapshotTo = (ctx: NodeContext, s: RaftState, peer: NodeId) => {
    const payload: InstallSnapshot = {
      term: s.currentTerm,
      leaderId: ctx.self,
      lastIncludedIndex: s.snapshotIndex,
      lastIncludedTerm: s.snapshotTerm,
      kv: { ...s.snapshotKv },
      config: s.snapshotConfig,
    };
    ctx.send(peer, 'InstallSnapshot', payload);
  };

  const sendAppendTo = (ctx: NodeContext, s: RaftState, peer: NodeId) => {
    const next = s.nextIndex[peer] ?? lastIndex(s) + 1;
    if (next <= s.snapshotIndex) {
      sendSnapshotTo(ctx, s, peer); // entries before our snapshot are gone — ship the snapshot
      return;
    }
    const prevLogIndex = next - 1;
    const payload: AppendEntries = {
      term: s.currentTerm,
      leaderId: ctx.self,
      prevLogIndex,
      prevLogTerm: termAt(s, prevLogIndex),
      entries: s.log.slice(prevLogIndex - s.snapshotIndex),
      leaderCommit: s.commitIndex,
    };
    ctx.send(peer, 'AppendEntries', payload);
  };

  const broadcastAppend = (ctx: NodeContext, s: RaftState) => {
    for (const p of replicaTargets(ctx, s)) sendAppendTo(ctx, s, p);
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
    s.pendingReads = [];
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
    for (const p of replicaTargets(ctx, s)) ctx.send(p, 'PreVote', rv);
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
    for (const p of replicaTargets(ctx, s)) ctx.send(p, 'RequestVote', rv);
  };

  const advanceCommit = (ctx: NodeContext, s: RaftState) => {
    const cfg = currentConfig(s);
    for (let n = lastIndex(s); n > s.commitIndex; n--) {
      if (termAt(s, n) !== s.currentTerm) continue; // only commit current-term entries directly
      const granted = new Set<NodeId>([ctx.self]);
      for (const p of ctx.peers) if ((s.matchIndex[p] ?? 0) >= n) granted.add(p);
      if (hasMajority(cfg, granted)) {
        s.commitIndex = n;
        applyCommitted(ctx, s);
        break;
      }
    }
  };

  // ---- ReadIndex: a leader confirms it still leads before serving a read ----

  const startRead = (ctx: NodeContext, s: RaftState, rid: number, key: string) => {
    const pr: PendingRead = { rid, key, readIndex: s.commitIndex, acks: { [ctx.self]: true } };
    s.pendingReads.push(pr);
    ctx.log('state', `read#${rid} ${key} — confirming leadership at index ${pr.readIndex}`);
    const hb: ReadHeartbeat = { term: s.currentTerm, leaderId: ctx.self, rid };
    for (const p of replicaTargets(ctx, s)) ctx.send(p, 'ReadHeartbeat', hb);
    resolveReads(ctx, s); // single-node clusters resolve immediately
  };

  const resolveReads = (ctx: NodeContext, s: RaftState) => {
    const cfg = currentConfig(s);
    s.pendingReads = s.pendingReads.filter((pr) => {
      const granted = new Set(Object.keys(pr.acks).filter((id) => pr.acks[id]));
      if (!hasMajority(cfg, granted) || s.lastApplied < pr.readIndex) return true; // keep waiting
      const value = pr.key in s.kv ? s.kv[pr.key] : null;
      s.lastRead = { rid: pr.rid, key: pr.key, value, readIndex: pr.readIndex, term: s.currentTerm };
      ctx.log('commit', `read#${pr.rid} ${pr.key} = ${value ?? '∅'} (linearized @${pr.readIndex})`);
      return false;
    });
  };

  return {
    name: 'Raft',

    init(ctx) {
      const members = config.initialMembers ?? ctx.all;
      const bootstrap: ClusterConfig = { old: [...members], next: null };
      const s: RaftState = {
        currentTerm: 0,
        votedFor: null,
        log: [],
        snapshotIndex: 0,
        snapshotTerm: 0,
        snapshotKv: {},
        snapshotConfig: bootstrap,
        bootstrap,
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
        pendingReads: [],
        lastRead: null,
        electionTimeout: config.electionMin,
      };
      armElection(ctx, s);
      return s;
    },

    onRestart(ctx, s) {
      // Volatile state is rebuilt; persistent (term, votedFor, log, snapshot) survives.
      // The state machine and commit point are restored from the persistent snapshot.
      s.role = 'follower';
      s.leaderId = null;
      s.commitIndex = s.snapshotIndex;
      s.lastApplied = s.snapshotIndex;
      s.kv = { ...s.snapshotKv };
      s.nextIndex = {};
      s.matchIndex = {};
      s.votesGranted = {};
      s.lastLeaderContact = 0;
      s.preVoteTerm = 0;
      s.preVotes = {};
      s.pendingReads = [];
      s.lastRead = null;
      armElection(ctx, s);
      ctx.log('state', 'restarted; state machine restored from snapshot, log replays from leader');
    },

    onCommand(ctx, s, cmd) {
      if (cmd.op === 'read') {
        if (s.role !== 'leader') {
          ctx.log('info', `not leader; read rejected (leader=${s.leaderId ?? '?'})`);
          return;
        }
        startRead(ctx, s, cmd.rid, cmd.key);
        return;
      }
      if (s.role !== 'leader') {
        ctx.log('info', `not leader; client command rejected (leader=${s.leaderId ?? '?'})`);
        return;
      }
      if (cmd.op === 'config') {
        // Begin a membership change: append the joint configuration Cold,new.
        const cfg = currentConfig(s);
        if (cfg.next) {
          ctx.log('info', 'a membership change is already in progress');
          return;
        }
        s.log.push({ term: s.currentTerm, cmd: { op: 'config', old: cfg.old, next: cmd.next } });
        ctx.log('state', `appended #${lastIndex(s)} Cold,new {${cfg.old.join('')}}→{${(cmd.next ?? []).join('')}}`);
        broadcastAppend(ctx, s);
        return;
      }
      s.log.push({ term: s.currentTerm, cmd });
      ctx.log('state', `appended #${lastIndex(s)} ${describe(cmd)}`);
      broadcastAppend(ctx, s);
    },

    onTimer(ctx, s, name) {
      if (name === 'election') {
        // Only a voting member of the current configuration may stand for election.
        if (s.role !== 'leader' && isVoter(currentConfig(s), ctx.self)) {
          if (config.preVote) startPreVote(ctx, s);
          else startElection(ctx, s);
        } else if (s.role !== 'leader') {
          armElection(ctx, s); // non-voter: keep the timer alive but never disrupt
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
            const granted = new Set(Object.keys(s.preVotes).filter((id) => s.preVotes[id]));
            if (hasMajority(currentConfig(s), granted)) startElection(ctx, s);
          }
          break;
        }
        case 'RequestVote':
          handleRequestVote(ctx, s, msg.payload as RequestVote, becomeFollower, armElection);
          break;
        case 'RequestVoteResp':
          handleVoteResp(ctx, s, msg.payload as RequestVoteResp, becomeFollower, becomeLeader);
          break;
        case 'AppendEntries':
          handleAppendEntries(ctx, s, msg.payload as AppendEntries, becomeFollower, applyCommitted);
          break;
        case 'AppendEntriesResp':
          handleAppendResp(ctx, s, msg.payload as AppendEntriesResp, becomeFollower, sendAppendTo, advanceCommit);
          break;
        case 'InstallSnapshot':
          handleInstallSnapshot(ctx, s, msg.payload as InstallSnapshot, becomeFollower);
          break;
        case 'InstallSnapshotResp':
          handleSnapshotResp(ctx, s, msg.payload as InstallSnapshotResp, becomeFollower, sendAppendTo, advanceCommit);
          break;
        case 'ReadHeartbeat': {
          const hb = msg.payload as ReadHeartbeat;
          if (hb.term < s.currentTerm) {
            ctx.send(hb.leaderId, 'ReadHeartbeatResp', { term: s.currentTerm, from: ctx.self, rid: hb.rid });
            break;
          }
          becomeFollower(ctx, s, hb.term, hb.leaderId);
          ctx.send(hb.leaderId, 'ReadHeartbeatResp', { term: s.currentTerm, from: ctx.self, rid: hb.rid });
          break;
        }
        case 'ReadHeartbeatResp': {
          const r = msg.payload as ReadHeartbeatResp;
          if (r.term > s.currentTerm) {
            becomeFollower(ctx, s, r.term, null);
            break;
          }
          if (s.role !== 'leader' || r.term !== s.currentTerm) break;
          const pr = s.pendingReads.find((p) => p.rid === r.rid);
          if (pr) {
            pr.acks[r.from] = true;
            resolveReads(ctx, s);
          }
          break;
        }
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
) {
  if (r.term > s.currentTerm) {
    becomeFollower(ctx, s, r.term, null);
    return;
  }
  if (s.role !== 'candidate' || r.term !== s.currentTerm) return; // stale
  if (r.voteGranted) {
    s.votesGranted[r.from] = true;
    const granted = new Set(Object.keys(s.votesGranted).filter((id) => s.votesGranted[id]));
    if (hasMajority(currentConfig(s), granted)) becomeLeader(ctx, s);
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

  // The leader's prefix may reach into entries we have already folded into our
  // snapshot; those are committed and immutable, so skip the covered portion.
  let prevLogIndex = ae.prevLogIndex;
  let prevLogTerm = ae.prevLogTerm;
  let entries = ae.entries;
  if (prevLogIndex < s.snapshotIndex) {
    const covered = s.snapshotIndex - prevLogIndex;
    if (covered >= entries.length) {
      const end = prevLogIndex + entries.length;
      if (ae.leaderCommit > s.commitIndex) {
        s.commitIndex = Math.min(ae.leaderCommit, lastIndex(s));
        applyCommitted(ctx, s);
      }
      reply(true, end, 0);
      return;
    }
    entries = entries.slice(covered);
    prevLogIndex = s.snapshotIndex;
    prevLogTerm = s.snapshotTerm;
  }

  // Consistency check on the entry preceding the new ones.
  if (prevLogIndex > 0) {
    if (lastIndex(s) < prevLogIndex) {
      reply(false, 0, lastIndex(s) + 1); // we're too short; back up to our end
      return;
    }
    if (termAt(s, prevLogIndex) !== prevLogTerm) {
      // find the first index of the conflicting term for a fast back-up
      const badTerm = termAt(s, prevLogIndex);
      let ci = prevLogIndex;
      while (ci > s.snapshotIndex + 1 && termAt(s, ci - 1) === badTerm) ci--;
      reply(false, 0, ci);
      return;
    }
  }

  // Append any new entries, truncating on the first real conflict only.
  for (let i = 0; i < entries.length; i++) {
    const index = prevLogIndex + 1 + i;
    if (termAt(s, index) !== entries[i].term) {
      s.log.length = index - 1 - s.snapshotIndex; // truncate conflicting suffix
      for (let j = i; j < entries.length; j++) s.log.push(entries[j]);
      break;
    }
  }

  if (ae.leaderCommit > s.commitIndex) {
    s.commitIndex = Math.min(ae.leaderCommit, prevLogIndex + entries.length);
    applyCommitted(ctx, s);
  }
  reply(true, prevLogIndex + entries.length, 0);
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
    sendAppendTo(ctx, s, r.from); // retry immediately with an earlier prefix (or a snapshot)
  }
}

function handleInstallSnapshot(
  ctx: NodeContext,
  s: RaftState,
  is: InstallSnapshot,
  becomeFollower: (ctx: NodeContext, s: RaftState, term: number, leader: NodeId | null) => void,
) {
  const reply = (matchIndex: number) =>
    ctx.send(is.leaderId, 'InstallSnapshotResp', { term: s.currentTerm, from: ctx.self, matchIndex });

  if (is.term < s.currentTerm) {
    reply(0);
    return;
  }
  becomeFollower(ctx, s, is.term, is.leaderId);
  if (is.lastIncludedIndex <= s.snapshotIndex) {
    reply(lastIndex(s)); // we already have this snapshot (or a newer one)
    return;
  }
  // Keep any suffix we already hold past the snapshot point if it is consistent;
  // otherwise discard the whole log and adopt the snapshot wholesale.
  if (is.lastIncludedIndex < lastIndex(s) && termAt(s, is.lastIncludedIndex) === is.lastIncludedTerm) {
    s.log = s.log.slice(is.lastIncludedIndex - s.snapshotIndex);
  } else {
    s.log = [];
  }
  s.snapshotIndex = is.lastIncludedIndex;
  s.snapshotTerm = is.lastIncludedTerm;
  s.snapshotKv = { ...is.kv };
  s.snapshotConfig = is.config;
  s.kv = { ...is.kv };
  s.commitIndex = Math.max(s.commitIndex, is.lastIncludedIndex);
  s.lastApplied = is.lastIncludedIndex;
  ctx.log('state', `installed snapshot ≤ #${is.lastIncludedIndex} from ${is.leaderId}`);
  reply(is.lastIncludedIndex);
}

function handleSnapshotResp(
  ctx: NodeContext,
  s: RaftState,
  r: InstallSnapshotResp,
  becomeFollower: (ctx: NodeContext, s: RaftState, term: number, leader: NodeId | null) => void,
  sendAppendTo: (ctx: NodeContext, s: RaftState, peer: NodeId) => void,
  advanceCommit: (ctx: NodeContext, s: RaftState) => void,
) {
  if (r.term > s.currentTerm) {
    becomeFollower(ctx, s, r.term, null);
    return;
  }
  if (s.role !== 'leader' || r.term !== s.currentTerm) return;
  s.matchIndex[r.from] = Math.max(s.matchIndex[r.from] ?? 0, r.matchIndex);
  s.nextIndex[r.from] = s.matchIndex[r.from] + 1;
  advanceCommit(ctx, s);
  sendAppendTo(ctx, s, r.from); // keep the follower moving forward from the snapshot
}

function describe(c: RaftCommand): string {
  if (c.op === 'set') return `${c.key}=${c.value}`;
  if (c.op === 'del') return `del ${c.key}`;
  if (c.op === 'config') return c.next ? `Cold,new` : `Cnew`;
  if (c.op === 'read') return `read ${c.key}`;
  return 'noop';
}
