// Multi-Paxos — consensus the other canonical way.
//
// Raft starts from a strong leader and a log; Paxos starts from the bottom up
// with the **Synod** (single-decree) protocol — a ballot, a Prepare/Promise
// phase and an Accept/Accepted phase — and is then assembled into Multi-Paxos
// for a replicated log by running Phase 1 *once* to become the distinguished
// proposer for all future slots.
//
// The whole point of Paxos is one safety theorem: **at most one value is ever
// chosen for a given slot**, no matter how messages are delayed, dropped,
// reordered or how nodes crash. Two rules make it true:
//
//   1. An acceptor only accepts a ballot ≥ the highest it has promised, and
//      promises are stable storage (they survive a crash).
//   2. Before proposing in Phase 2, a new leader must adopt the value already
//      accepted at the highest ballot it sees in its Phase-1 promises — so a
//      value that *might* already be chosen is never overwritten by a different
//      one. (`recoverValue` below.)
//
// Everything else — leader election by randomized timeout, heartbeats, learner
// catch-up, client forwarding — is operational scaffolding around that core.
import type { NodeContext, Message, Protocol } from '../../sim/types';
import {
  cmpBallot,
  ballotEq,
  ballotStr,
  valueStr,
  type Ballot,
  type PaxosValue,
  type PaxosState,
  type PaxosConfig,
  type PaxosCmd,
  type AcceptorSlot,
  type Prepare,
  type Promise,
  type Accept,
  type Accepted,
  type Chosen,
  type Heartbeat,
  type Forward,
  DEFAULT_PAXOS_CONFIG,
} from './types';

const majority = (n: number) => Math.floor(n / 2) + 1;

export function createPaxos(config: PaxosConfig = DEFAULT_PAXOS_CONFIG): Protocol<PaxosState, PaxosCmd> {
  // ---- election / heartbeat timers ---------------------------------------

  function pickTimeout(ctx: NodeContext): number {
    if (!config.randomizedBackoff) return config.electionMin;
    return Math.round(ctx.rng.float(config.electionMin, config.electionMax));
  }

  function armElection(ctx: NodeContext, s: PaxosState): void {
    s.electionTimeout = pickTimeout(ctx);
    ctx.setTimer('election', s.electionTimeout);
  }

  function slotOf(s: PaxosState, i: number): AcceptorSlot {
    let slot = s.slots[i];
    if (!slot) {
      slot = { acceptedBallot: null, acceptedValue: null };
      s.slots[i] = slot;
    }
    if (i > s.maxSlot) s.maxSlot = i;
    return slot;
  }

  // ---- learner: apply chosen slots to the KV state machine ---------------

  function learn(s: PaxosState, slot: number, value: PaxosValue): void {
    s.chosen[slot] = value;
    if (slot > s.maxSlot) s.maxSlot = slot;
    // Advance the contiguous applied watermark.
    while (s.chosen[s.applied + 1] !== undefined) {
      s.applied += 1;
      const v = s.chosen[s.applied];
      if (v.op === 'set') s.kv[v.key] = v.value;
      else if (v.op === 'del') delete s.kv[v.key];
    }
  }

  // ---- Phase 1: become a proposer ----------------------------------------

  function startPhase1(ctx: NodeContext, s: PaxosState): void {
    const base = s.minProposal ? s.minProposal.n : 0;
    const ballot: Ballot = { n: base + 1, node: ctx.self };
    s.role = 'preparing';
    s.myBallot = ballot;
    s.promises = {};
    s.promised = {};
    s.accepts = {};
    s.proposing = {};
    s.leaderId = null;
    s.note = `Phase 1 · prepare ${ballotStr(ballot)}`;
    ctx.log('state', `→ Phase 1 (prepare ${ballotStr(ballot)})`);
    // The proposer is also an acceptor: it promises to its own ballot.
    applyPromise(s, ctx.self, ballot);
    recordPromise(s, ctx.self);
    ctx.broadcast('Prepare', () => ({ ballot } as Prepare));
    maybeWinPhase1(ctx, s);
  }

  /** Fold an acceptor's own promise (used when the proposer self-promises). */
  function applyPromise(s: PaxosState, _self: string, ballot: Ballot): void {
    if (cmpBallot(ballot, s.minProposal) > 0) s.minProposal = ballot;
  }

  function recordPromise(s: PaxosState, from: string): void {
    s.promised[from] = true;
    const acc: Record<number, { ballot: Ballot; value: PaxosValue }> = {};
    for (const k of Object.keys(s.slots)) {
      const i = Number(k);
      const sl = s.slots[i];
      if (sl.acceptedBallot && sl.acceptedValue) acc[i] = { ballot: sl.acceptedBallot, value: sl.acceptedValue };
    }
    s.promises[from] = acc;
  }

  /** The leader-recovery rule: among promises, the value accepted at the highest
   *  ballot for `slot`, or null if nobody has accepted anything there yet. */
  function recoverValue(s: PaxosState, slot: number): PaxosValue | null {
    let best: { ballot: Ballot; value: PaxosValue } | null = null;
    for (const from of Object.keys(s.promises)) {
      const a = s.promises[from][slot];
      if (a && (best === null || cmpBallot(a.ballot, best.ballot) > 0)) best = a;
    }
    return best ? best.value : null;
  }

  function maybeWinPhase1(ctx: NodeContext, s: PaxosState): void {
    if (s.role !== 'preparing') return;
    const count = Object.keys(s.promised).length;
    if (count < majority(ctx.all.length)) return;

    // Won Phase 1. Become the distinguished leader for ballot myBallot.
    s.role = 'leader';
    s.leaderId = ctx.self;
    s.lastLeaderContact = ctx.now;
    s.hbOff = false;

    // Determine the highest slot anyone reported (recovery range).
    let maxReported = -1;
    for (const from of Object.keys(s.promises)) {
      for (const k of Object.keys(s.promises[from])) maxReported = Math.max(maxReported, Number(k));
    }
    const firstUndecided = s.applied + 1;

    // Re-propose recovered values across the whole [firstUndecided, maxReported]
    // window; fill any genuine gap with a no-op so the log has no holes.
    for (let slot = firstUndecided; slot <= maxReported; slot++) {
      if (s.chosen[slot] !== undefined) continue;
      const recovered = recoverValue(s, slot);
      driveAccept(ctx, s, slot, recovered ?? { op: 'noop' });
    }
    s.nextSlot = Math.max(firstUndecided, maxReported + 1);

    ctx.log('commit', `won Phase 1 — leader at ${ballotStr(s.myBallot)} (recovered ≤ slot ${maxReported})`);
    s.note = `leader ${ballotStr(s.myBallot)}`;

    // Flush any client values queued while we had no leadership.
    const queued = s.pending;
    s.pending = [];
    for (const v of queued) leaderPropose(ctx, s, v);

    sendHeartbeat(ctx, s);
  }

  // ---- Phase 2: drive a value into a slot --------------------------------

  function driveAccept(ctx: NodeContext, s: PaxosState, slot: number, value: PaxosValue): void {
    if (!s.myBallot) return;
    s.proposing[slot] = value;
    s.accepts[slot] = {};
    // The leader accepts its own proposal.
    acceptLocally(s, s.myBallot, slot, value);
    s.accepts[slot][ctx.self] = true;
    ctx.broadcast('Accept', () => ({ ballot: s.myBallot!, slot, value } as Accept));
    maybeChosen(ctx, s, slot);
  }

  function leaderPropose(ctx: NodeContext, s: PaxosState, value: PaxosValue): void {
    const slot = s.nextSlot++;
    ctx.log('state', `propose ${valueStr(value)} → slot ${slot} @ ${ballotStr(s.myBallot)}`);
    driveAccept(ctx, s, slot, value);
  }

  function acceptLocally(s: PaxosState, ballot: Ballot, slot: number, value: PaxosValue): boolean {
    if (cmpBallot(ballot, s.minProposal) < 0) return false;
    s.minProposal = ballot;
    const sl = slotOf(s, slot);
    sl.acceptedBallot = ballot;
    sl.acceptedValue = value;
    return true;
  }

  function maybeChosen(ctx: NodeContext, s: PaxosState, slot: number): void {
    if (s.chosen[slot] !== undefined) return;
    const acks = s.accepts[slot];
    if (!acks) return;
    if (Object.keys(acks).length < majority(ctx.all.length)) return;
    const value = s.proposing[slot];
    if (value === undefined) return;
    learn(s, slot, value);
    ctx.log('commit', `slot ${slot} CHOSEN = ${valueStr(value)}`);
    ctx.broadcast('Chosen', () => ({ slot, value } as Chosen));
  }

  // ---- heartbeats / catch-up ---------------------------------------------

  function sendHeartbeat(ctx: NodeContext, s: PaxosState): void {
    if (s.role !== 'leader' || s.hbOff || !s.myBallot) return;
    ctx.broadcast('Heartbeat', () => ({ ballot: s.myBallot!, leader: ctx.self, chosen: s.chosen } as Heartbeat));
  }

  // ---- proposer / leader: become candidate if there's no leader ----------

  function ensureLeadership(ctx: NodeContext, s: PaxosState): void {
    if (s.role === 'leader') return;
    if (s.role === 'preparing') return; // already trying
    startPhase1(ctx, s);
  }

  return {
    name: 'Multi-Paxos',

    init(ctx) {
      const s: PaxosState = {
        minProposal: null,
        slots: {},
        chosen: {},
        maxSlot: -1,
        kv: {},
        applied: 0,
        role: 'idle',
        myBallot: null,
        leaderId: null,
        promises: {},
        promised: {},
        accepts: {},
        proposing: {},
        nextSlot: 1,
        pending: [],
        electionTimeout: config.electionMin,
        lastLeaderContact: 0,
        hbOff: false,
        note: 'idle',
      };
      armElection(ctx, s);
      ctx.setTimer('heartbeat', config.heartbeat);
      return s;
    },

    onRestart(ctx, s) {
      // Acceptor state (minProposal, slots, chosen, kv, applied) is stable storage
      // and survives. Proposer/leader state is volatile — rebuild it by re-electing.
      s.role = 'idle';
      s.myBallot = null;
      s.leaderId = null;
      s.promises = {};
      s.promised = {};
      s.accepts = {};
      s.proposing = {};
      s.pending = [];
      s.hbOff = false;
      s.note = 'restarted (acceptor state intact)';
      armElection(ctx, s);
      ctx.setTimer('heartbeat', config.heartbeat);
    },

    onTimer(ctx, s, name) {
      if (name === 'election') {
        armElection(ctx, s);
        if (s.role === 'leader') return;
        if (ctx.now - s.lastLeaderContact < s.electionTimeout) return; // heard a leader recently
        startPhase1(ctx, s);
        return;
      }
      if (name === 'heartbeat') {
        ctx.setTimer('heartbeat', config.heartbeat);
        sendHeartbeat(ctx, s);
        return;
      }
    },

    onCommand(ctx, s, cmd) {
      if (cmd.type === 'prepare') {
        startPhase1(ctx, s);
        return;
      }
      if (cmd.type === 'heartbeat-disable') {
        s.hbOff = cmd.on;
        s.note = cmd.on ? 'leader silent (no heartbeats)' : s.note;
        ctx.log('info', cmd.on ? 'heartbeats OFF (silent leader)' : 'heartbeats ON');
        return;
      }
      // propose
      const value = cmd.value;
      if (s.role === 'leader') {
        leaderPropose(ctx, s, value);
      } else if (s.leaderId && s.leaderId !== ctx.self) {
        ctx.send(s.leaderId, 'Forward', { value } as Forward);
        ctx.log('send', `forward ${valueStr(value)} → leader ${s.leaderId}`);
      } else {
        s.pending.push(value);
        ensureLeadership(ctx, s);
      }
    },

    onMessage(ctx, s, msg: Message) {
      switch (msg.type) {
        case 'Prepare': {
          const p = msg.payload as Prepare;
          if (cmpBallot(p.ballot, s.minProposal) > 0) {
            s.minProposal = p.ballot;
            // A higher ballot from someone else: we are no longer the leader.
            if (s.role !== 'idle' && cmpBallot(p.ballot, s.myBallot) > 0) {
              s.role = 'idle';
              s.myBallot = null;
              s.note = `yielded to ${ballotStr(p.ballot)}`;
            }
          }
          // Reply with our promise: the highest ballot we've now promised, and our
          // accepted values per slot (so the proposer can honour them in Phase 2).
          const accepted: Record<number, { ballot: Ballot; value: PaxosValue }> = {};
          for (const k of Object.keys(s.slots)) {
            const i = Number(k);
            const sl = s.slots[i];
            if (sl.acceptedBallot && sl.acceptedValue) accepted[i] = { ballot: sl.acceptedBallot, value: sl.acceptedValue };
          }
          ctx.send(msg.from, 'Promise', {
            ballot: p.ballot,
            promised: s.minProposal,
            accepted,
            from: ctx.self,
          } as Promise);
          return;
        }

        case 'Promise': {
          const p = msg.payload as Promise;
          if (s.role !== 'preparing' || !ballotEq(p.ballot, s.myBallot)) return; // stale round
          if (cmpBallot(p.promised, s.myBallot) > 0) {
            // Superseded: someone promised a higher ballot. Step down and back off.
            s.role = 'idle';
            s.myBallot = null;
            s.note = `superseded by ${ballotStr(p.promised)}`;
            ctx.log('drop', `prepare superseded by ${ballotStr(p.promised)}`);
            return;
          }
          s.promised[p.from] = true;
          s.promises[p.from] = p.accepted;
          maybeWinPhase1(ctx, s);
          return;
        }

        case 'Accept': {
          const a = msg.payload as Accept;
          const ok = acceptLocally(s, a.ballot, a.slot, a.value);
          ctx.send(msg.from, 'Accepted', {
            ballot: a.ballot,
            slot: a.slot,
            ok,
            promised: ok ? null : s.minProposal,
            from: ctx.self,
          } as Accepted);
          if (ok) ctx.log('recv', `accept slot ${a.slot} ${valueStr(a.value)} @ ${ballotStr(a.ballot)}`);
          return;
        }

        case 'Accepted': {
          const a = msg.payload as Accepted;
          if (s.role !== 'leader' || !ballotEq(a.ballot, s.myBallot)) {
            // A rejection can still tell us we've been deposed.
            if (!a.ok && cmpBallot(a.promised, s.myBallot) > 0) {
              s.role = 'idle';
              s.myBallot = null;
              s.note = `deposed by ${ballotStr(a.promised)}`;
            }
            return;
          }
          if (!a.ok) {
            if (cmpBallot(a.promised, s.myBallot) > 0) {
              s.role = 'idle';
              s.myBallot = null;
              s.note = `deposed by ${ballotStr(a.promised)}`;
            }
            return;
          }
          (s.accepts[a.slot] ??= {})[a.from] = true;
          maybeChosen(ctx, s, a.slot);
          return;
        }

        case 'Chosen': {
          const c = msg.payload as Chosen;
          if (s.chosen[c.slot] === undefined) learn(s, c.slot, c.value);
          return;
        }

        case 'Heartbeat': {
          const h = msg.payload as Heartbeat;
          if (cmpBallot(h.ballot, s.minProposal) >= 0) {
            // A legitimate (≥ our floor) leader: follow it.
            s.lastLeaderContact = ctx.now;
            s.leaderId = h.leader;
            if (h.leader !== ctx.self) {
              if (cmpBallot(h.ballot, s.minProposal) > 0) s.minProposal = h.ballot;
              if (s.role === 'leader' || s.role === 'preparing') {
                s.role = 'idle';
                s.myBallot = null;
              }
              s.note = `following ${h.leader} @ ${ballotStr(h.ballot)}`;
              // Forward any client values we were holding to the real leader.
              if (s.pending.length > 0) {
                const queued = s.pending;
                s.pending = [];
                for (const v of queued) ctx.send(h.leader, 'Forward', { value: v } as Forward);
              }
            }
            // Catch up any chosen slots we missed.
            for (const k of Object.keys(h.chosen)) {
              const i = Number(k);
              if (s.chosen[i] === undefined) learn(s, i, h.chosen[i]);
            }
          }
          return;
        }

        case 'Forward': {
          const f = msg.payload as Forward;
          if (s.role === 'leader') leaderPropose(ctx, s, f.value);
          else s.pending.push(f.value); // we lost leadership in the meantime; retry on next election
          return;
        }
      }
    },
  };
}
