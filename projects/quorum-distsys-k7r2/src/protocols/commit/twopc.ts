// Two-phase commit (2PC) — the canonical atomic-commit protocol, and a live
// demonstration of its fatal flaw. A coordinator asks every participant to
// PREPARE; if all vote yes it broadcasts COMMIT, otherwise ABORT. 2PC is *safe*
// (all participants reach the same decision) but not *live*: if the coordinator
// stalls after collecting yes votes but before announcing the decision, the
// prepared participants are stuck — they have promised to commit and may not
// unilaterally decide. Arm "stall" to watch exactly that blocking window.
import type { NodeId, Protocol } from '../../sim/types';

export type Vote = 'yes' | 'no';
export type CoordPhase = 'idle' | 'collecting' | 'committed' | 'aborted' | 'stalled';
export type PartState = 'idle' | 'prepared' | 'committed' | 'aborted' | 'uncertain';

export interface TwoPCState {
  role: 'coordinator' | 'participant';
  // coordinator
  phase: CoordPhase;
  votes: Record<NodeId, Vote>;
  stall: boolean;
  // participant
  pstate: PartState;
  willVote: Vote;
}

export type TwoPCCmd = { type: 'begin'; stall?: boolean } | { type: 'setvote'; vote: Vote };

export interface TwoPCConfig {
  decisionTimeout: number;
}

const DEFAULT: TwoPCConfig = { decisionTimeout: 700 };

export function createTwoPC(config: TwoPCConfig = DEFAULT): Protocol<TwoPCState, TwoPCCmd> {
  return {
    name: '2PC',

    init(ctx) {
      const role = ctx.self === ctx.all[0] ? 'coordinator' : 'participant';
      return { role, phase: 'idle', votes: {}, stall: false, pstate: 'idle', willVote: 'yes' };
    },

    onRestart() {
      // nothing volatile to rebuild for this teaching model
    },

    onCommand(ctx, s, cmd) {
      if (cmd.type === 'setvote') {
        if (s.role === 'participant') s.willVote = cmd.vote;
        return;
      }
      if (cmd.type === 'begin' && s.role === 'coordinator') {
        s.phase = 'collecting';
        s.votes = {};
        s.stall = !!cmd.stall;
        ctx.log('state', `PREPARE phase${s.stall ? ' (will stall before deciding)' : ''}`);
        ctx.broadcast('PREPARE', () => ({}));
      }
    },

    onTimer(ctx, s, name) {
      if (name === 'decision' && s.role === 'participant' && s.pstate === 'prepared') {
        s.pstate = 'uncertain';
        ctx.log('crash', 'BLOCKED: voted yes, no decision from coordinator');
      }
    },

    onMessage(ctx, s, msg) {
      if (msg.type === 'PREPARE' && s.role === 'participant') {
        s.pstate = s.willVote === 'yes' ? 'prepared' : 'aborted';
        ctx.send(msg.from, 'VOTE', { vote: s.willVote });
        ctx.log('state', `vote ${s.willVote} → ${s.pstate}`);
        if (s.willVote === 'yes') ctx.setTimer('decision', config.decisionTimeout);
        return;
      }
      if (msg.type === 'VOTE' && s.role === 'coordinator') {
        const { vote } = msg.payload as { vote: Vote };
        s.votes[msg.from] = vote;
        if (Object.values(s.votes).some((v) => v === 'no')) {
          s.phase = 'aborted';
          ctx.log('state', 'decision: ABORT (a participant voted no)');
          ctx.broadcast('ABORT', () => ({}));
        } else if (Object.keys(s.votes).length === ctx.peers.length) {
          if (s.stall) {
            s.phase = 'stalled';
            ctx.log('crash', 'all voted yes — coordinator STALLS (simulated crash); participants will block');
          } else {
            s.phase = 'committed';
            ctx.log('commit', 'decision: COMMIT (unanimous yes)');
            ctx.broadcast('COMMIT', () => ({}));
          }
        }
        return;
      }
      if (msg.type === 'COMMIT' && s.role === 'participant') {
        ctx.clearTimer('decision');
        s.pstate = 'committed';
        ctx.log('commit', 'committed');
      }
      if (msg.type === 'ABORT' && s.role === 'participant') {
        ctx.clearTimer('decision');
        s.pstate = 'aborted';
        ctx.log('state', 'aborted');
      }
    },

    invariants(nodes) {
      const parts = nodes.filter((n) => n.state.role === 'participant');
      const committed = parts.filter((p) => p.state.pstate === 'committed');
      const aborted = parts.filter((p) => p.state.pstate === 'aborted');
      const atomic = !(committed.length > 0 && aborted.length > 0);
      // Validity: a commit may only happen if every participant voted yes.
      const coord = nodes.find((n) => n.state.role === 'coordinator');
      const anyNo = coord ? Object.values(coord.state.votes).some((v) => v === 'no') : false;
      const validity = !(committed.length > 0 && anyNo);
      return [
        {
          name: 'Atomicity (uniform decision)',
          ok: atomic,
          detail: atomic
            ? 'no two participants decide differently'
            : 'a participant committed while another aborted — atomicity broken',
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
