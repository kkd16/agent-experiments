// A from-scratch implementation of Ben-Or's randomized consensus (1983), the
// crash-fault (fail-stop) version for N > 2f. See types.ts for the algorithm.
//
// The protocol is purely message-driven: there are no timeouts in the safety
// path (that is the point — it makes no synchrony assumption). A small optional
// retry timer only re-broadcasts the current phase so a run can still terminate
// under a lossy network; it never affects safety. All randomness comes from the
// kernel's single seeded RNG, so an entire run is reproducible and time-travels.
import type { Message, NodeContext, Protocol } from '../../sim/types';
import {
  DEFAULT_BENOR_CONFIG,
  PROP_BOT,
  waitFor,
  type BenOrCommand,
  type BenOrConfig,
  type BenOrState,
  type Bit,
  type Proposal,
  type Propose,
  type Report,
} from './types';

export function createBenOr(
  config: BenOrConfig = DEFAULT_BENOR_CONFIG,
  inputs?: Bit[],
): Protocol<BenOrState, BenOrCommand> {
  const N = (s: BenOrState) => s.configuration.length;
  const others = (s: BenOrState) => s.configuration.filter((_, i) => i !== s.replicaNumber);
  const rk = (r: number) => String(r);

  // Begin an asynchronous round: record our own report and broadcast it.
  const startRound = (ctx: NodeContext, s: BenOrState, r: number) => {
    s.round = r;
    const bucket = (s.reports[rk(r)] ??= {});
    bucket[String(s.replicaNumber)] = s.estimate;
    ctx.setTimer('retry', config.retryMs);
    const rep: Report = { round: r, value: s.estimate, from: s.replicaNumber };
    for (const id of others(s)) ctx.send(id, 'BenReport', rep);
    tryPhase1(ctx, s, r);
  };

  // Phase 1: once N−f reports for round r are in, form a proposal and broadcast it.
  const tryPhase1 = (ctx: NodeContext, s: BenOrState, r: number) => {
    if (s.proposed[rk(r)]) return;
    const bucket = s.reports[rk(r)] ?? {};
    const votes = Object.values(bucket);
    if (votes.length < waitFor(N(s))) return;
    const ones = votes.filter((v) => v === 1).length;
    const zeros = votes.length - ones;
    // A strict majority of the *sample* implies a global majority, so at most one
    // value can ever be proposed in a round.
    let proposal: Proposal = PROP_BOT;
    if (zeros * 2 > N(s)) proposal = 0;
    else if (ones * 2 > N(s)) proposal = 1;
    s.proposed[rk(r)] = true;
    s.lastProposal = proposal;
    const pbucket = (s.proposals[rk(r)] ??= {});
    pbucket[String(s.replicaNumber)] = proposal;
    ctx.log('state', `round ${r} phase 1 → propose ${proposal === -1 ? '⊥' : proposal} (${zeros}×0 / ${ones}×1)`);
    const prop: Propose = { round: r, value: proposal, from: s.replicaNumber };
    for (const id of others(s)) ctx.send(id, 'BenPropose', prop);
    tryPhase2(ctx, s, r);
  };

  // Phase 2: once N−f proposals for round r are in, decide / adopt / coin-flip and
  // advance to the next round.
  const tryPhase2 = (ctx: NodeContext, s: BenOrState, r: number) => {
    if (s.advanced[rk(r)]) return;
    const bucket = s.proposals[rk(r)] ?? {};
    const props = Object.values(bucket);
    if (props.length < waitFor(N(s))) return;
    s.advanced[rk(r)] = true;

    const nonBot = props.filter((p) => p !== PROP_BOT) as Bit[];
    const countOf = (v: Bit) => nonBot.filter((p) => p === v).length;
    const f = Math.floor((N(s) - 1) / 2);

    let next: Bit;
    if (nonBot.length > 0) {
      // All non-⊥ proposals in a round are identical (majority uniqueness), so the
      // first non-⊥ is *the* value; adopt it.
      const v = nonBot[0];
      next = v;
      if (s.decided === null && countOf(v) >= f + 1) {
        s.decided = v;
        s.decidedRound = r;
        ctx.log('commit', `DECIDED ${v} in round ${r} (${countOf(v)} ≥ f+1 proposals)`);
      }
    } else {
      // No proposal carried a value: flip the shared "free choice" coin.
      next = ctx.rng.next() < 0.5 ? 0 : 1;
      s.lastCoin = next;
      ctx.log('state', `round ${r} phase 2 → all ⊥, coin = ${next}`);
    }
    s.estimate = s.decided ?? next;
    ctx.clearTimer('retry');
    prune(s, r);
    // A decided node keeps its value forever (estimate === decided), so it keeps
    // proposing that value in every subsequent round. That is exactly what drives
    // every other correct node to the same decision within one round — no special
    // "help" path is needed, and because a round can only advance at network speed
    // there is never a message storm. The run is non-quiescent by design (like the
    // gossip labs); old-round buffers are pruned so memory stays bounded.
    startRound(ctx, s, r + 1);
  };

  // Keep only the last few rounds of buffers so a long run can't grow without bound.
  const prune = (s: BenOrState, upto: number) => {
    const floor = upto - 3;
    for (const store of [s.reports, s.proposals, s.proposed, s.advanced] as Record<string, unknown>[]) {
      for (const key of Object.keys(store)) if (Number(key) < floor) delete store[key];
    }
  };

  const rebroadcast = (ctx: NodeContext, s: BenOrState) => {
    const r = s.round;
    if (!s.proposed[rk(r)]) {
      const rep: Report = { round: r, value: s.estimate, from: s.replicaNumber };
      for (const id of others(s)) ctx.send(id, 'BenReport', rep);
    } else if (!s.advanced[rk(r)]) {
      const prop: Propose = { round: r, value: s.lastProposal, from: s.replicaNumber };
      for (const id of others(s)) ctx.send(id, 'BenPropose', prop);
    }
    ctx.setTimer('retry', config.retryMs);
  };

  return {
    name: 'Ben-Or',

    init(ctx) {
      const configuration = [...ctx.all];
      const replicaNumber = configuration.indexOf(ctx.self);
      // Inputs come from the factory; the default is a deterministic split so a fresh
      // cluster already exercises the interesting (non-unanimous) case.
      const input: Bit = inputs?.[replicaNumber] ?? ((replicaNumber % 2) as Bit);
      const s: BenOrState = {
        configuration,
        replicaNumber,
        input,
        round: 0,
        estimate: input,
        decided: null,
        decidedRound: null,
        started: false,
        reports: {},
        proposals: {},
        proposed: {},
        advanced: {},
        lastCoin: null,
        lastProposal: PROP_BOT,
      };
      startRound(ctx, s, 1);
      s.started = true;
      return s;
    },

    onRestart(ctx, s) {
      // Ben-Or has no recovery protocol. A restarted replica simply re-announces its
      // current round; if the cluster has moved on it will fall silent (harmless).
      // A decided replica keeps its decision (it is final).
      ctx.setTimer('retry', config.retryMs);
      rebroadcast(ctx, s);
    },

    onTimer(ctx, s, name) {
      if (name === 'retry') rebroadcast(ctx, s);
    },

    onMessage(ctx, s, msg: Message) {
      if (msg.type === 'BenReport') {
        const r = msg.payload as Report;
        if (r.round < s.round && s.advanced[rk(r.round)]) return; // done with that round
        const bucket = (s.reports[rk(r.round)] ??= {});
        bucket[String(r.from)] = r.value;
        tryPhase1(ctx, s, r.round);
      } else if (msg.type === 'BenPropose') {
        const p = msg.payload as Propose;
        if (p.round < s.round && s.advanced[rk(p.round)]) return;
        const bucket = (s.proposals[rk(p.round)] ??= {});
        bucket[String(p.from)] = p.value;
        // We might still be finishing phase 1 of this round; make sure it runs first.
        tryPhase1(ctx, s, p.round);
        tryPhase2(ctx, s, p.round);
      }
    },
  };
}
