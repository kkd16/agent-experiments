// PBFT — Practical Byzantine Fault Tolerance (Castro & Liskov, OSDI '99).
//
// State-machine replication that survives up to f Byzantine (arbitrary,
// possibly malicious) replicas out of N = 3f+1. The normal case is a three-phase
// agreement on a sequence number for each client request:
//
//   PRE-PREPARE   primary assigns request d the next sequence number n (view v)
//   PREPARE       every backup that accepts it echoes (v, n, d) to all
//   COMMIT        once a replica has the pre-prepare + 2f matching prepares
//                 ("prepared"), it broadcasts COMMIT; once it has 2f+1 matching
//                 commits ("committed-local") it executes n in order.
//
// Two certificate sizes do all the work. A *prepared* certificate (pre-prepare +
// 2f prepares = 2f+1 distinct replicas) guarantees order **within** a view: two
// such certificates for the same n would need two 2f+1 quorums, which intersect
// in an honest replica that would have had to vouch for both digests — it never
// does. A *committed* certificate (2f+1 commits) guarantees that a prepared
// certificate survives **across** views: any 2f+1 set of VIEW-CHANGE messages
// contains an honest replica that holds it, so the next primary re-proposes it.
//
// When the primary is faulty (silent or equivocating), backups time out and run
// the VIEW-CHANGE / NEW-VIEW sub-protocol to rotate to the next primary while
// preserving every request that any honest replica might already have executed.
import type { NodeContext, Message, Protocol, NodeId } from '../../sim/types';
import {
  faultBudget,
  quorum,
  digestOf,
  opStr,
  NOOP_REQUEST,
  NOOP_DIGEST,
  type PbftState,
  type PbftConfig,
  type PbftCmd,
  type Slot,
  type ClientRequest,
  type PreparedProof,
  type RequestMsg,
  type PrePrepare,
  type PrepareMsg,
  type CommitMsg,
  type ViewChange,
  type NewView,
  type StatusMsg,
  type CatchupMsg,
  DEFAULT_PBFT_CONFIG,
} from './types';

/** How often a replica gossips its execution watermark for catch-up. */
const SYNC_PERIOD = 280;

const primaryOf = (all: NodeId[], view: number): NodeId => all[((view % all.length) + all.length) % all.length];

/** Count distinct senders in `votes` whose claimed digest equals `digest`. */
function countMatching(votes: Record<NodeId, string>, digest: string): number {
  let c = 0;
  for (const k of Object.keys(votes)) if (votes[k] === digest) c++;
  return c;
}

function emptySlot(view: number): Slot {
  return {
    view,
    digest: '',
    request: null,
    prepares: {},
    commits: {},
    preprepared: false,
    prepared: false,
    committed: false,
    sentPrepare: false,
    sentCommit: false,
  };
}

export function createPbft(config: PbftConfig = DEFAULT_PBFT_CONFIG): Protocol<PbftState, PbftCmd> {
  // ---- timer management --------------------------------------------------
  // The view-change timer measures "how long since I had an outstanding request
  // the primary hasn't gotten executed". It is armed once when work appears and
  // cleared when work drains — never reset by ordinary message traffic, or a slow
  // trickle of messages from a faulty primary could mask the fault forever.

  function armViewTimer(ctx: NodeContext, s: PbftState): void {
    if (s.inViewChange || s.pending.length === 0 || s.vcArmed) return;
    const base = config.requestTimeout * (1 + 0.3 * s.view);
    ctx.setTimer('viewchange', Math.round(base + ctx.rng.float(0, 160)));
    s.vcArmed = true;
  }

  function disarmViewTimer(ctx: NodeContext, s: PbftState): void {
    if (!s.vcArmed) return;
    ctx.clearTimer('viewchange');
    s.vcArmed = false;
  }

  // ---- request intake ----------------------------------------------------

  function addPending(ctx: NodeContext, s: PbftState, req: ClientRequest): void {
    if (s.executedCid[req.cid]) return; // already applied
    if (s.pending.some((p) => p.cid === req.cid)) return; // already queued
    s.pending.push(req);
    s.requests[digestOf(req)] = req;
    armViewTimer(ctx, s);
  }

  // ---- primary: propose --------------------------------------------------

  /** Is there already a slot in the current view carrying this digest? */
  function digestInFlight(s: PbftState, digest: string): boolean {
    for (const k of Object.keys(s.log)) {
      const sl = s.log[Number(k)];
      if (sl.view === s.view && sl.digest === digest) return true;
    }
    return false;
  }

  function proposeIfPrimary(ctx: NodeContext, s: PbftState): void {
    if (primaryOf(ctx.all, s.view) !== ctx.self) return;
    if (s.inViewChange) return;
    if (s.fault === 'silent') return; // a silent primary proposes nothing
    for (const req of s.pending) {
      const d = digestOf(req);
      if (s.executedCid[req.cid] || digestInFlight(s, d)) continue;
      proposeOne(ctx, s, req, d);
    }
  }

  function proposeOne(ctx: NodeContext, s: PbftState, req: ClientRequest, digest: string): void {
    const seq = s.nextSeq++;
    const slot = emptySlot(s.view);
    slot.digest = digest;
    slot.request = req;
    slot.preprepared = true; // the primary's own pre-prepare
    s.log[seq] = slot;
    s.requests[digest] = req;

    if (s.fault === 'equivocate') {
      // Byzantine: fabricate a conflicting request and send each half of the
      // backups a different (digest, request) for the SAME sequence number.
      const fake: ClientRequest = forge(req);
      const fd = digestOf(fake);
      s.requests[fd] = fake;
      const backups = ctx.peers;
      ctx.broadcast('PrePrepare', (peer) => {
        const idx = backups.indexOf(peer);
        const sendFake = idx >= Math.ceil(backups.length / 2);
        return { view: s.view, seq, digest: sendFake ? fd : digest, request: sendFake ? fake : req } as PrePrepare;
      });
      ctx.log('state', `⚠ equivocates on seq ${seq}: "${opStr(req)}" vs "${opStr(fake)}"`);
      s.note = `EQUIVOCATING @ seq ${seq}`;
    } else {
      ctx.broadcast('PrePrepare', () => ({ view: s.view, seq, digest, request: req } as PrePrepare));
      ctx.log('state', `pre-prepare seq ${seq} = ${opStr(req)} (v${s.view})`);
    }
    recompute(ctx, s, seq); // the primary may already be able to commit in tiny N
  }

  /** A faulty primary's conflicting request: same key, mutated value/id. */
  function forge(req: ClientRequest): ClientRequest {
    if (req.op.op === 'set') return { cid: req.cid + '✗', op: { op: 'set', key: req.op.key, value: req.op.value + '✗' } };
    if (req.op.op === 'del') return { cid: req.cid + '✗', op: { op: 'set', key: req.op.key, value: '✗' } };
    return { cid: req.cid + '✗', op: { op: 'noop' } };
  }

  // ---- the heart: recompute prepared / committed for a slot --------------

  function ensureSlot(s: PbftState, seq: number): Slot {
    let sl = s.log[seq];
    if (!sl) {
      sl = emptySlot(s.view);
      s.log[seq] = sl;
    }
    return sl;
  }

  function recompute(ctx: NodeContext, s: PbftState, seq: number): void {
    const sl = s.log[seq];
    if (!sl || !sl.preprepared) return;
    const N = ctx.all.length;
    const f = faultBudget(N);

    // prepared-local: pre-prepare + 2f matching PREPAREs from distinct replicas.
    if (!sl.prepared && countMatching(sl.prepares, sl.digest) >= 2 * f) {
      sl.prepared = true;
      ctx.log('state', `prepared seq ${seq} = ${opStr(sl.request)} (v${sl.view})`);
      sendCommit(ctx, s, seq, sl);
    }

    // committed-local: prepared + 2f+1 matching COMMITs from distinct replicas.
    if (sl.prepared && !sl.committed && countMatching(sl.commits, sl.digest) >= quorum(N)) {
      sl.committed = true;
      ctx.log('commit', `committed-local seq ${seq} = ${opStr(sl.request)}`);
      tryExecute(ctx, s);
    }
  }

  function sendPrepare(ctx: NodeContext, s: PbftState, seq: number, sl: Slot): void {
    if (sl.sentPrepare) return;
    sl.sentPrepare = true;
    // Backups echo a PREPARE; the primary's pre-prepare stands in for its prepare.
    if (primaryOf(ctx.all, s.view) === ctx.self) return;
    // A silent/equivocating Byzantine node withholds its honest votes.
    if (s.fault === 'silent' || s.fault === 'equivocate') return;
    const claimed = s.fault === 'conflict' ? sl.digest + '✗' : sl.digest;
    sl.prepares[ctx.self] = claimed; // count our own honest prepare locally
    ctx.broadcast('Prepare', () => ({ view: s.view, seq, digest: claimed, from: ctx.self } as PrepareMsg));
  }

  function sendCommit(ctx: NodeContext, s: PbftState, seq: number, sl: Slot): void {
    if (sl.sentCommit) return;
    sl.sentCommit = true;
    if (s.fault === 'silent' || s.fault === 'equivocate') return;
    const claimed = s.fault === 'conflict' ? sl.digest + '✗' : sl.digest;
    sl.commits[ctx.self] = claimed;
    ctx.broadcast('Commit', () => ({ view: s.view, seq, digest: claimed, from: ctx.self } as CommitMsg));
    recompute(ctx, s, seq);
  }

  // ---- in-order execution ------------------------------------------------

  /**
   * Execute the next contiguous sequence number when its decision is final. A
   * decision is final either locally (its slot is committed-local) or by
   * catch-up (f+1 distinct replicas reported executing the same digest — at
   * least one is honest, so the digest is the agreed one). The catch-up path is
   * what lets a lagging or restarted replica rejoin without a full state copy.
   */
  function tryExecute(ctx: NodeContext, s: PbftState): void {
    const f = faultBudget(ctx.all.length);
    let advanced = false;
    for (;;) {
      const seq = s.lastExec + 1;
      let digest: string | null = null;
      let req: ClientRequest | null = null;

      const sl = s.log[seq];
      if (sl?.committed) {
        digest = sl.digest;
        req = sl.request ?? s.requests[sl.digest] ?? null;
      } else {
        const votes = s.catchup[seq];
        if (votes) {
          for (const d of Object.keys(votes)) {
            if (Object.keys(votes[d]).length >= f + 1) {
              digest = d;
              req = s.requests[d] ?? null;
              break;
            }
          }
        }
      }
      if (digest === null || req === null) break; // not final, or body still missing

      apply(s, req);
      s.executed[seq] = digest;
      s.lastExec = seq;
      s.executedCid[req.cid] = true;
      s.pending = s.pending.filter((p) => p.cid !== req.cid);
      s.execLog.push({ seq, digest, summary: opStr(req) });
      ctx.log('commit', `execute #${seq}: ${opStr(req)}`);
      advanced = true;
    }
    if (advanced) {
      if (s.pending.length === 0) disarmViewTimer(ctx, s);
      s.note = s.fault !== 'honest' ? s.note : `executed ≤ #${s.lastExec}`;
    }
  }

  function apply(s: PbftState, req: ClientRequest): void {
    const o = req.op;
    if (o.op === 'set') s.kv[o.key] = o.value;
    else if (o.op === 'del') delete s.kv[o.key];
  }

  // ---- view change -------------------------------------------------------

  /** Collect this replica's prepared certificates to carry into the next view. */
  function preparedProofs(s: PbftState): PreparedProof[] {
    const out: PreparedProof[] = [];
    for (const k of Object.keys(s.log)) {
      const seq = Number(k);
      const sl = s.log[seq];
      if (sl.prepared && sl.request) out.push({ seq, view: sl.view, digest: sl.digest, request: sl.request });
    }
    // Executed (committed) slots are prepared too — include them so a request that
    // some honest replica already executed is never lost across the view change.
    for (const k of Object.keys(s.executed)) {
      const seq = Number(k);
      if (out.some((p) => p.seq === seq)) continue;
      const digest = s.executed[seq];
      const req = s.requests[digest] ?? NOOP_REQUEST;
      const sl = s.log[seq];
      out.push({ seq, view: sl ? sl.view : s.view, digest, request: req });
    }
    return out;
  }

  function startViewChange(ctx: NodeContext, s: PbftState, target: number): void {
    if (target <= s.view) target = s.view + 1;
    s.inViewChange = true;
    s.targetView = target;
    disarmViewTimer(ctx, s);
    const vc: ViewChange = { newView: target, from: ctx.self, prepared: preparedProofs(s), lastExec: s.lastExec };
    // Record our own view-change so a self-primary can count itself.
    (s.viewChanges[target] ??= {})[ctx.self] = vc;
    ctx.broadcast('ViewChange', () => vc);
    ctx.setTimer('newview', Math.round(config.newViewTimeout * (1 + 0.3 * (target - 1)) + ctx.rng.float(0, 200)));
    ctx.log('state', `→ VIEW-CHANGE to v${target} (suspect primary ${primaryOf(ctx.all, s.view)})`);
    s.note = `view-change → v${target}`;
    maybeIssueNewView(ctx, s, target);
  }

  /** New primary: once 2f+1 VIEW-CHANGEs for `target` are in, publish NEW-VIEW. */
  function maybeIssueNewView(ctx: NodeContext, s: PbftState, target: number): void {
    if (primaryOf(ctx.all, target) !== ctx.self) return;
    if (s.newViewSent >= target) return;
    if (s.fault === 'silent') return;
    const collected = Object.values(s.viewChanges[target] ?? {});
    if (collected.length < quorum(ctx.all.length)) return;

    s.newViewSent = target;
    // The carried-over slots (prepared in earlier views) ...
    const carried = computeNewViewLog(collected);
    let maxSeq = s.lastExec;
    const inSet = new Set<string>();
    for (const p of carried) {
      maxSeq = Math.max(maxSeq, p.seq);
      inSet.add(p.digest);
    }
    // ... plus fresh pre-prepares for anything still pending. Folding these into
    // the NEW-VIEW (rather than sending them as separate PRE-PREPARE messages
    // that could race ahead of NEW-VIEW and be dropped as "wrong view") makes
    // re-establishing service atomic: a backup that adopts the view also gets the
    // pre-prepares it must PREPARE in the very same message.
    const fresh: { seq: number; digest: string; request: ClientRequest }[] = [];
    for (const req of s.pending) {
      const d = digestOf(req);
      if (s.executedCid[req.cid] || inSet.has(d)) continue;
      inSet.add(d);
      fresh.push({ seq: ++maxSeq, digest: d, request: req });
    }
    const preprepares = [...carried, ...fresh];
    const nv: NewView = { view: target, viewChanges: collected, preprepares };
    ctx.broadcast('NewView', () => nv);
    ctx.log('commit', `NEW-VIEW v${target} (${preprepares.length} slots re-proposed)`);
    adoptNewView(ctx, s, nv, true);
  }

  /**
   * The NEW-VIEW log computation (§4.4): for every sequence number from the
   * lowest unexecuted slot up to the highest that appears with a prepared
   * certificate, re-propose the request prepared at the **highest view**; fill
   * any genuine gap with a no-op so the log has no holes.
   */
  function computeNewViewLog(vcs: ViewChange[]): { seq: number; digest: string; request: ClientRequest }[] {
    let minExec = Infinity;
    let maxSeq = 0;
    const best: Record<number, PreparedProof> = {};
    for (const vc of vcs) {
      minExec = Math.min(minExec, vc.lastExec);
      for (const p of vc.prepared) {
        maxSeq = Math.max(maxSeq, p.seq);
        const cur = best[p.seq];
        if (!cur || p.view > cur.view) best[p.seq] = p;
      }
    }
    if (!isFinite(minExec)) minExec = 0;
    const out: { seq: number; digest: string; request: ClientRequest }[] = [];
    for (let seq = minExec + 1; seq <= maxSeq; seq++) {
      const p = best[seq];
      if (p) out.push({ seq, digest: p.digest, request: p.request });
      else out.push({ seq, digest: NOOP_DIGEST, request: NOOP_REQUEST });
    }
    return out;
  }

  function adoptNewView(ctx: NodeContext, s: PbftState, nv: NewView, asPrimary: boolean): void {
    s.view = nv.view;
    s.targetView = nv.view;
    s.inViewChange = false;
    s.newViewSent = Math.max(s.newViewSent, nv.view);
    ctx.clearTimer('newview');

    // Discard every unexecuted slot from the old view: prepares/commits are only
    // valid within the view they were cast in, so the new view starts clean and
    // is rebuilt entirely from the NEW-VIEW's re-proposed pre-prepares (the O-set).
    for (const k of Object.keys(s.log)) {
      const seq = Number(k);
      if (seq > s.lastExec) delete s.log[seq];
    }

    let maxSeq = s.lastExec;
    for (const pp of nv.preprepares) {
      maxSeq = Math.max(maxSeq, pp.seq);
      if (pp.seq <= s.lastExec) continue; // already executed; keep our history
      const slot = emptySlot(nv.view);
      slot.digest = pp.digest;
      slot.request = pp.request;
      slot.preprepared = true;
      s.log[pp.seq] = slot;
      s.requests[pp.digest] = pp.request;
      // Backups echo a PREPARE for each re-proposed slot; the primary doesn't.
      if (!asPrimary) sendPrepare(ctx, s, pp.seq, slot);
      recompute(ctx, s, pp.seq);
    }
    s.nextSeq = Math.max(s.nextSeq, maxSeq + 1);
    s.note = asPrimary ? `primary of v${nv.view}` : `following v${nv.view}`;
    ctx.log('state', `adopt NEW-VIEW v${nv.view}; next seq ${s.nextSeq}`);

    // Resume normal service: (re-)propose anything still pending if we're primary,
    // and re-arm the request timer so a faulty new primary is caught too.
    if (asPrimary) proposeIfPrimary(ctx, s);
    armViewTimer(ctx, s);
  }

  // ---- protocol object ---------------------------------------------------

  return {
    name: 'PBFT',

    init(ctx) {
      const s: PbftState = {
        fault: 'honest',
        view: 0,
        inViewChange: false,
        targetView: 0,
        log: {},
        nextSeq: 1,
        executed: {},
        lastExec: 0,
        kv: {},
        execLog: [],
        requests: {},
        pending: [],
        vcArmed: false,
        executedCid: {},
        catchup: {},
        viewChanges: {},
        newViewSent: -1,
        note: 'replica',
      };
      ctx.setTimer('sync', Math.round(SYNC_PERIOD + ctx.rng.float(0, 80)));
      return s;
    },

    onRestart(ctx, s) {
      // A restarted replica keeps its durable log (executed/kv) but rejoins as a
      // follower: volatile view-change collection and timers are rebuilt. It will
      // catch up on any decisions it missed via the Status/Catchup gossip.
      s.inViewChange = false;
      s.vcArmed = false;
      s.viewChanges = {};
      s.note = 'restarted';
      ctx.setTimer('sync', Math.round(SYNC_PERIOD + ctx.rng.float(0, 80)));
      armViewTimer(ctx, s);
    },

    onCommand(ctx, s, cmd) {
      if (cmd.type === 'set-fault') {
        s.fault = cmd.mode;
        s.note = cmd.mode === 'honest' ? 'replica' : `BYZANTINE: ${cmd.mode}`;
        ctx.log('info', `fault mode → ${cmd.mode}`);
        // A node turned honest again should resume any duties it skipped.
        if (cmd.mode === 'honest') {
          proposeIfPrimary(ctx, s);
          for (const k of Object.keys(s.log)) recompute(ctx, s, Number(k));
        }
        return;
      }
      // A client request: the client multicasts to every replica (the lab does
      // this), so each replica independently sees it and arms its timer.
      addPending(ctx, s, cmd.request);
      proposeIfPrimary(ctx, s);
    },

    onTimer(ctx, s, name) {
      if (name === 'viewchange') {
        s.vcArmed = false;
        if (s.inViewChange || s.pending.length === 0) return;
        startViewChange(ctx, s, s.view + 1);
        return;
      }
      if (name === 'newview') {
        // No NEW-VIEW arrived in time — escalate to the next view.
        if (!s.inViewChange) return;
        startViewChange(ctx, s, s.targetView + 1);
        return;
      }
      if (name === 'sync') {
        ctx.setTimer('sync', Math.round(SYNC_PERIOD + ctx.rng.float(0, 80)));
        if (s.fault === 'silent') return; // a silent node gossips nothing
        ctx.broadcast('Status', () => ({ from: ctx.self, lastExec: s.lastExec } as StatusMsg));
        return;
      }
    },

    onMessage(ctx, s, msg: Message) {
      switch (msg.type) {
        case 'Request': {
          addPending(ctx, s, (msg.payload as RequestMsg).request);
          proposeIfPrimary(ctx, s);
          return;
        }

        case 'PrePrepare': {
          const p = msg.payload as PrePrepare;
          if (s.inViewChange || p.view !== s.view) return; // wrong view / paused
          if (msg.from !== primaryOf(ctx.all, p.view)) return; // only the primary pre-prepares
          if (p.seq <= s.lastExec) return; // already executed
          if (digestOf(p.request) !== p.digest) return; // request/digest must bind
          const existing = s.log[p.seq];
          if (existing && existing.preprepared && existing.digest !== p.digest) {
            ctx.log('drop', `reject 2nd pre-prepare for seq ${p.seq} (equivocation caught)`);
            return; // accept only the first pre-prepare per (view, seq)
          }
          const sl = ensureSlot(s, p.seq);
          sl.view = p.view;
          sl.digest = p.digest;
          sl.request = p.request;
          sl.preprepared = true;
          s.requests[p.digest] = p.request;
          sendPrepare(ctx, s, p.seq, sl);
          recompute(ctx, s, p.seq);
          return;
        }

        case 'Prepare': {
          const p = msg.payload as PrepareMsg;
          if (s.inViewChange || p.view !== s.view) return;
          if (p.seq <= s.lastExec) return;
          const sl = ensureSlot(s, p.seq);
          sl.prepares[p.from] = p.digest; // store the claim; only matches count
          recompute(ctx, s, p.seq);
          return;
        }

        case 'Commit': {
          const p = msg.payload as CommitMsg;
          if (s.inViewChange || p.view !== s.view) return;
          if (p.seq <= s.lastExec) return;
          const sl = ensureSlot(s, p.seq);
          sl.commits[p.from] = p.digest;
          recompute(ctx, s, p.seq);
          return;
        }

        case 'ViewChange': {
          const vc = msg.payload as ViewChange;
          if (vc.newView <= s.view) return; // stale
          (s.viewChanges[vc.newView] ??= {})[vc.from] = vc;
          // Byzantine-liveness boost: if f+1 replicas are moving to a higher view,
          // join them even if our own timer hasn't fired yet (§4.5.2).
          const f = faultBudget(ctx.all.length);
          const movers = Object.keys(s.viewChanges[vc.newView]).length;
          if (!s.inViewChange && movers >= f + 1) {
            startViewChange(ctx, s, vc.newView);
          } else {
            maybeIssueNewView(ctx, s, vc.newView);
          }
          return;
        }

        case 'NewView': {
          const nv = msg.payload as NewView;
          if (nv.view <= s.view) return;
          if (msg.from !== primaryOf(ctx.all, nv.view)) return; // only the new primary
          if (nv.viewChanges.length < quorum(ctx.all.length)) return; // unjustified
          adoptNewView(ctx, s, nv, false);
          return;
        }

        case 'Status': {
          // A peer told us where it is. If it's behind us, ship it what it misses.
          const st = msg.payload as StatusMsg;
          if (s.fault === 'silent' || st.lastExec >= s.lastExec) return;
          const entries: CatchupMsg['entries'] = [];
          for (let seq = st.lastExec + 1; seq <= s.lastExec && entries.length < 64; seq++) {
            const digest = s.executed[seq];
            const req = s.requests[digest] ?? NOOP_REQUEST;
            entries.push({ seq, digest, request: req });
          }
          if (entries.length) ctx.send(st.from, 'Catchup', { from: ctx.self, entries } as CatchupMsg);
          return;
        }

        case 'Catchup': {
          // Record each reported decision; once f+1 distinct replicas agree on a
          // (seq, digest) it is safe to adopt (at least one reporter is honest).
          const cu = msg.payload as CatchupMsg;
          for (const e of cu.entries) {
            if (e.seq <= s.lastExec) continue;
            if (digestOf(e.request) !== e.digest && e.digest !== NOOP_DIGEST) continue; // body must bind
            s.requests[e.digest] = e.request;
            const bySeq = (s.catchup[e.seq] ??= {});
            (bySeq[e.digest] ??= {})[cu.from] = true;
          }
          tryExecute(ctx, s);
          return;
        }
      }
    },
  };
}
