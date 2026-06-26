import type { NodeId } from '../../sim/types';

export type Role = 'follower' | 'candidate' | 'leader';

/** A command applied to the replicated key/value state machine. */
export type RaftCommand =
  | { op: 'set'; key: string; value: string }
  | { op: 'del'; key: string }
  | { op: 'noop' };

export interface RaftLogEntry {
  /** Term in which the leader created this entry. */
  term: number;
  cmd: RaftCommand;
}

export interface RaftState {
  // --- persistent (survives a crash) ---
  currentTerm: number;
  votedFor: NodeId | null;
  log: RaftLogEntry[]; // index i holds log index i+1 (Raft logs are 1-based)

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

  // --- for the UI ---
  electionTimeout: number; // the most recently chosen randomized timeout (ms)
}

export interface RaftConfig {
  electionMin: number;
  electionMax: number;
  heartbeat: number;
  /** Run an extra pre-vote round so a partitioned node can't inflate terms. */
  preVote: boolean;
}

export const DEFAULT_RAFT_CONFIG: RaftConfig = {
  electionMin: 300,
  electionMax: 600,
  heartbeat: 120,
  preVote: false,
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
