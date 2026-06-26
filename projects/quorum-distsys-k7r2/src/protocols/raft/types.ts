import type { NodeId } from '../../sim/types';

export type Role = 'follower' | 'candidate' | 'leader';

/** A command applied to the replicated key/value state machine. */
export type RaftCommand =
  | { op: 'set'; key: string; value: string }
  | { op: 'del'; key: string }
  | { op: 'noop' }
  /**
   * A cluster-membership change, replicated through the log like any other entry.
   * `old` is the set of voters before this entry; `next` is the new set. When both
   * are present (`next` non-null) the entry is the *joint* configuration Cold,new and
   * agreement requires a majority in BOTH sets. When `next` is null the entry is the
   * final single configuration Cnew. (Ongaro & Ousterhout §6.)
   */
  | { op: 'config'; old: NodeId[]; next: NodeId[] | null }
  /** A linearizable read request. It is NOT appended to the log; the leader confirms
   *  leadership with a heartbeat round (ReadIndex) before answering, so it never
   *  serves a stale value. `rid` makes the read identifiable to the UI / tests. */
  | { op: 'read'; key: string; rid: number };

/** The active cluster configuration: a single set, or a joint (transitional) pair. */
export interface ClusterConfig {
  old: NodeId[];
  next: NodeId[] | null;
}

export interface RaftLogEntry {
  /** Term in which the leader created this entry. */
  term: number;
  cmd: RaftCommand;
}

/** The result of a linearizable ReadIndex read, surfaced for the UI / tests. */
export interface ReadResult {
  rid: number;
  key: string;
  value: string | null;
  /** The commit index the read was linearized at. */
  readIndex: number;
  term: number;
}

/** A ReadIndex request in flight on the leader, waiting for a heartbeat quorum. */
export interface PendingRead {
  rid: number;
  key: string;
  readIndex: number;
  acks: Record<NodeId, boolean>;
}

export interface RaftState {
  // --- persistent (survives a crash) ---
  currentTerm: number;
  votedFor: NodeId | null;
  /**
   * The *suffix* of the log not yet folded into a snapshot. Entry `log[i]` holds
   * absolute Raft index `snapshotIndex + i + 1` (Raft logs are 1-based). With no
   * snapshot (`snapshotIndex === 0`) this is the whole log and index i ↔ i+1.
   */
  log: RaftLogEntry[];

  // --- snapshot / log compaction (persistent) ---
  snapshotIndex: number; // lastIncludedIndex — highest index folded into the snapshot (0 = none)
  snapshotTerm: number; // term of the entry at snapshotIndex
  snapshotKv: Record<string, string>; // the state machine as of snapshotIndex
  snapshotConfig: ClusterConfig; // the cluster configuration as of snapshotIndex

  // --- membership bootstrap (persistent) ---
  bootstrap: ClusterConfig; // the configuration before any 'config' entry exists

  // --- volatile (reset on restart) ---
  role: Role;
  leaderId: NodeId | null;
  commitIndex: number;
  lastApplied: number;
  kv: Record<string, string>; // the replicated state machine

  // --- leader-only volatile ---
  nextIndex: Record<NodeId, number>;
  matchIndex: Record<NodeId, number>;

  // --- candidate-only volatile ---
  votesGranted: Record<NodeId, boolean>;

  // --- pre-vote (volatile) ---
  lastLeaderContact: number; // virtual time we last heard from a valid leader
  preVoteTerm: number; // the would-be term we are currently canvassing for
  preVotes: Record<NodeId, boolean>;

  // --- linearizable reads (leader-only volatile) ---
  pendingReads: PendingRead[];
  lastRead: ReadResult | null; // most recently completed linearizable read

  // --- for the UI ---
  electionTimeout: number; // the most recently chosen randomized timeout (ms)
}

export interface RaftConfig {
  electionMin: number;
  electionMax: number;
  heartbeat: number;
  /** Run an extra pre-vote round so a partitioned node can't inflate terms. */
  preVote: boolean;
  /**
   * Compact the log into a snapshot once this many *applied* entries have piled up
   * past the previous snapshot. 0 disables compaction (logs grow without bound).
   */
  snapshotThreshold: number;
  /**
   * The initially-active voter set. Nodes outside it run but stay non-voting until
   * a membership change adds them. Defaults to the whole physical cluster.
   */
  initialMembers?: NodeId[];
}

export const DEFAULT_RAFT_CONFIG: RaftConfig = {
  electionMin: 300,
  electionMax: 600,
  heartbeat: 120,
  preVote: false,
  snapshotThreshold: 0,
};

// --- message payloads ---

export interface RequestVote {
  term: number;
  candidateId: NodeId;
  lastLogIndex: number;
  lastLogTerm: number;
}

export interface RequestVoteResp {
  term: number;
  voteGranted: boolean;
  from: NodeId;
}

export interface AppendEntries {
  term: number;
  leaderId: NodeId;
  prevLogIndex: number;
  prevLogTerm: number;
  entries: RaftLogEntry[];
  leaderCommit: number;
}

export interface AppendEntriesResp {
  term: number;
  success: boolean;
  from: NodeId;
  /** On success: the highest log index now known-replicated on the follower. */
  matchIndex: number;
  /** On failure: a hint for where the leader should back up nextIndex. */
  conflictIndex: number;
}

/**
 * Sent by a leader to a follower whose nextIndex has fallen below the leader's
 * compacted prefix — the leader no longer has those entries, so it ships the whole
 * snapshot instead. (We send it in one message; a real system chunks it.)
 */
export interface InstallSnapshot {
  term: number;
  leaderId: NodeId;
  lastIncludedIndex: number;
  lastIncludedTerm: number;
  kv: Record<string, string>;
  config: ClusterConfig;
}

export interface InstallSnapshotResp {
  term: number;
  from: NodeId;
  /** The index up to which the follower is now caught up (the snapshot point). */
  matchIndex: number;
}

/** A heartbeat round used to confirm leadership before answering a ReadIndex read. */
export interface ReadHeartbeat {
  term: number;
  leaderId: NodeId;
  rid: number;
}

export interface ReadHeartbeatResp {
  term: number;
  from: NodeId;
  rid: number;
}
