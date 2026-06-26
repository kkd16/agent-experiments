// Three-phase commit (3PC) — 2PC's non-blocking cousin. It inserts a PRECOMMIT
// phase between the vote and the commit so that no participant ever sits in the
// fatal "I voted yes but don't know the decision and can't act" state that blocks
// 2PC. The extra phase buys a key property: a participant can only reach COMMIT
// after every participant has acknowledged PRECOMMIT, and it can only reach
// PRECOMMIT after every participant voted yes. So a participant that loses the
// coordinator can safely *finish on its own*, via a cooperative termination
// protocol: if anyone it can reach is (pre)committed, everyone commits; otherwise
// everyone aborts. Crash the coordinator at either stall point and watch the
// cluster terminate itself instead of blocking. (Like the textbook protocol, this
// assumes fail-stop without a network partition during termination.)
import type { NodeId, Protocol } from '../../sim/types';
import type { Vote } from './twopc';

export type TpcCoordPhase = 'idle' | 'cancommit' | 'precommit' | 'committed' | 'aborted' | 'stalled';
export type TpcPart = 'idle' | 'prepared' | 'precommitted' | 'committed' | 'aborted' | 'terminating';

export interface ThreePCState {
  role: 'coordinator' | 'participant';
  // coordinator
  phase: TpcCoordPhase;
  votes: Record<NodeId, Vote>;
  acks: Record<NodeId, boolean>;
  stallAt: 'none' | 'precommit' | 'docommit';
  // participant
  pstate: TpcPart;
  willVote: Vote;
  // participant termination bookkeeping
  term: Record<NodeId, TpcPart>;
  precommittedOnce: boolean; // remembers we reached PRECOMMIT even while terminating
}

export type ThreePCCmd =
  | { type: 'begin'; stall?: 'precommit' | 'docommit' }
  | { type: 'setvote'; vote: Vote };

export interface ThreePCConfig {
  decisionTimeout: number;
  terminateTimeout: number;
}

const DEFAULT: ThreePCConfig = { decisionTimeout: 600, terminateTimeout: 350 };

export function createThreePC(config: ThreePCConfig = DEFAULT): Protocol<ThreePCState, ThreePCCmd> {
  const decideCommit = (ctx: NodeContextLike, s: ThreePCState, why: string) => {
    if (s.pstate === 'committed' || s.pstate === 'aborted') return;
    s.pstate = 'committed';
    ctx.clearTimer('decision');
    ctx.clearTimer('terminate');
    ctx.log('commit', `committed (${why})`);
    ctx.broadcast('DOCOMMIT', () => ({})); // help peers converge
  };
  const decideAbort = (ctx: NodeContextLike, s: ThreePCState, why: string) => {
    if (s.pstate === 'committed' || s.pstate === 'aborted') return;
    s.pstate = 'aborted';
    ctx.clearTimer('decision');
    ctx.clearTimer('terminate');
    ctx.log('state', `aborted (${why})`);
    ctx.broadcast('ABORT', () => ({}));
  };

  return {
    name: '3PC',

    init(ctx) {
      const role = ctx.self === ctx.all[0] ? 'coordinator' : 'participant';
      return {
        role,
        phase: 'idle',
        votes: {},
        acks: {},
        stallAt: 'none',
        pstate: 'idle',
        willVote: 'yes',
        term: {},
        precommittedOnce: false,
      };
    },

    onRestart() {
      // teaching model: nothing volatile to rebuild
    },

    onCommand(ctx, s, cmd) {
      if (cmd.type === 'setvote') {
        if (s.role === 'participant') s.willVote = cmd.vote;
        return;
      }
      if (cmd.type === 'begin' && s.role === 'coordinator') {
        s.phase = 'cancommit';
        s.votes = {};
        s.acks = {};
        s.stallAt = cmd.stall ?? 'none';
        ctx.log('state', `CAN-COMMIT phase${cmd.stall ? ` (will stall at ${cmd.stall})` : ''}`);
        ctx.broadcast('CANCOMMIT', () => ({}));
      }
    },

    onTimer(ctx, s, name) {
      if (s.role !== 'participant') return;
      if (name === 'decision' && (s.pstate === 'prepared' || s.pstate === 'precommitted')) {
        // Lost contact with the coordinator — run the cooperative termination protocol.
        s.precommittedOnce = s.precommittedOnce || s.pstate === 'precommitted';
        s.pstate = 'terminating';
        s.term = {};
        ctx.log('crash', 'coordinator silent — starting cooperative termination');
        ctx.broadcast('STATEQ', () => ({}));
        ctx.setTimer('terminate', config.terminateTimeout);
        return;
      }
      if (name === 'terminate' && s.pstate === 'terminating') {
        // No one resolved it; decide from what we know (non-blocking by construction).
        if (s.precommittedOnce || Object.values(s.term).some((v) => v === 'precommitted' || v === 'committed')) {
          decideCommit(ctx, s, 'termination: a replica had pre-committed');
        } else {
          decideAbort(ctx, s, 'termination: no replica pre-committed');
        }
      }
    },

    onMessage(ctx, s, msg) {
      switch (msg.type) {
        case 'CANCOMMIT':
          if (s.role !== 'participant') return;
          s.pstate = s.willVote === 'yes' ? 'prepared' : 'aborted';
          ctx.send(msg.from, 'VOTE', { vote: s.willVote });
          ctx.log('state', `vote ${s.willVote} → ${s.pstate}`);
          if (s.willVote === 'yes') ctx.setTimer('decision', config.decisionTimeout);
          return;

        case 'VOTE': {
          if (s.role !== 'coordinator') return;
          const { vote } = msg.payload as { vote: Vote };
          s.votes[msg.from] = vote;
          if (Object.values(s.votes).some((v) => v === 'no')) {
            s.phase = 'aborted';
            ctx.log('state', 'decision: ABORT (a participant voted no)');
            ctx.broadcast('ABORT', () => ({}));
          } else if (Object.keys(s.votes).length === ctx.peers.length) {
            if (s.stallAt === 'precommit') {
              s.phase = 'stalled';
              ctx.log('crash', 'all voted yes — coordinator STALLS before PRE-COMMIT; participants will terminate');
            } else {
              s.phase = 'precommit';
              s.acks = {};
              ctx.log('state', 'PRE-COMMIT phase (all voted yes)');
              ctx.broadcast('PRECOMMIT', () => ({}));
            }
          }
          return;
        }

        case 'PRECOMMIT':
          if (s.role !== 'participant') return;
          s.pstate = 'precommitted';
          s.precommittedOnce = true;
          ctx.send(msg.from, 'ACK', {});
          ctx.setTimer('decision', config.decisionTimeout);
          ctx.log('state', 'pre-committed → ACK');
          return;

        case 'ACK': {
          if (s.role !== 'coordinator') return;
          s.acks[msg.from] = true;
          if (Object.keys(s.acks).length === ctx.peers.length) {
            if (s.stallAt === 'docommit') {
              s.phase = 'stalled';
              ctx.log('crash', 'all pre-committed — coordinator STALLS before DO-COMMIT; participants will commit themselves');
            } else {
              s.phase = 'committed';
              ctx.log('commit', 'decision: COMMIT (all pre-committed)');
              ctx.broadcast('DOCOMMIT', () => ({}));
            }
          }
          return;
        }

        case 'DOCOMMIT':
          if (s.role !== 'participant') return;
          decideCommit(ctx, s, 'do-commit');
          return;

        case 'ABORT':
          if (s.role !== 'participant') return;
          decideAbort(ctx, s, 'abort');
          return;

        case 'STATEQ':
          if (s.role !== 'participant') return;
          // Report our effective state so a terminating peer can decide.
          ctx.send(msg.from, 'STATER', { state: s.precommittedOnce && s.pstate === 'terminating' ? 'precommitted' : s.pstate });
          return;

        case 'STATER': {
          if (s.role !== 'participant' || s.pstate !== 'terminating') return;
          const { state } = msg.payload as { state: TpcPart };
          s.term[msg.from] = state;
          if (state === 'precommitted' || state === 'committed' || s.precommittedOnce) {
            decideCommit(ctx, s, 'termination: a replica had pre-committed');
          } else if (Object.keys(s.term).length >= ctx.peers.length) {
            decideAbort(ctx, s, 'termination: no replica pre-committed');
          }
          return;
        }
      }
    },

    invariants(nodes) {
      const parts = nodes.filter((n) => n.state.role === 'participant');
      const committed = parts.filter((p) => p.state.pstate === 'committed');
      const aborted = parts.filter((p) => p.state.pstate === 'aborted');
      const atomic = !(committed.length > 0 && aborted.length > 0);
      const coord = nodes.find((n) => n.state.role === 'coordinator');
      const anyNo = coord ? Object.values(coord.state.votes).some((v) => v === 'no') : false;
      const validity = !(committed.length > 0 && anyNo);
      // Non-blocking: once the coordinator is gone, no live participant is stuck
      // forever — they reach a decision (we surface 'terminating' as transient).
      return [
        {
          name: 'Atomicity (uniform decision)',
          ok: atomic,
          detail: atomic ? 'no two participants decide differently' : 'a participant committed while another aborted',
        },
        {
          name: 'Validity',
          ok: validity,
          detail: validity ? 'commit only after a unanimous yes' : 'committed despite a no vote',
        },
      ];
    },
  };
}

/** The slice of NodeContext the termination helpers use (keeps them tidy). */
interface NodeContextLike {
  broadcast(type: string, make: (peer: NodeId) => unknown): void;
  clearTimer(name: string): void;
  log(kind: string, text: string): void;
}
