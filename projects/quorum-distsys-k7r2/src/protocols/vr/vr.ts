// A from-scratch implementation of Viewstamped Replication
// (Liskov & Cowling, "Viewstamped Replication Revisited", 2012).
//
// VR reaches consensus on an ordered log without any stable storage. The three
// sub-protocols the paper defines are all here and run on the shared kernel:
//
//   • Normal operation — the primary (replica `view mod N`) assigns each client
//     request the next op-number, PREPAREs it to the backups, and commits it once
//     a quorum (f+1) has PREPAREOK'd it; COMMIT heartbeats carry the commit point.
//   • View change — when backups stop hearing from the primary they run
//     STARTVIEWCHANGE → DOVIEWCHANGE → STARTVIEW to rotate to the next primary,
//     reconstructing the log from the most up-to-date replica in the quorum.
//   • Recovery — a crashed replica that restarts rebuilds its state from a quorum
//     of peers (RECOVERY / RECOVERYRESPONSE) before it may participate again.
//
// State transfer (GETSTATE / NEWSTATE) fills gaps for a lagging-but-live backup.
// The replicated state machine is a key/value store; the client table gives the
// protocol's at-most-once execution guarantee.
import type { Message, NodeContext, Protocol } from '../../sim/types';
import {
  DEFAULT_VR_CONFIG,
  describeOp,
  isPrimary,
  primaryOf,
  quorum,
  type Commit,
  type DoViewChange,
  type GetState,
  type NewState,
  type Prepare,
  type PrepareOk,
  type Recovery,
  type RecoveryResponse,
  type StartView,
  type StartViewChange,
  type VrCommand,
  type VrConfig,
  type VrLogEntry,
  type VrReply,
  type VrRequest,
  type VrState,
} from './types';

export function createVR(config: VrConfig = DEFAULT_VR_CONFIG): Protocol<VrState, VrCommand> {
  const N = (s: VrState) => s.configuration.length;
  const self = (s: VrState) => s.configuration[s.replicaNumber];
  const others = (s: VrState) => s.configuration.filter((_, i) => i !== s.replicaNumber);

  const armPrimaryTimeout = (ctx: NodeContext, s: VrState) => {
    s.timeoutMs = ctx.rng.int(config.timeoutMin, config.timeoutMax);
    ctx.setTimer('primary', s.timeoutMs);
  };

  const startHeartbeat = (ctx: NodeContext) => {
    ctx.setTimer('heartbeat', config.heartbeat);
  };

  // Execute every committed-but-unexecuted op into the state machine, recording a
  // reply in the client table (at-most-once). Only ops ≤ commitNumber run, and never
  // past what we actually hold in the log.
  const executeUpTo = (ctx: NodeContext, s: VrState, target: number) => {
    const limit = Math.min(target, s.opNumber);
    while (s.commitNumber < limit) {
      const entry = s.log[s.commitNumber]; // op-number commitNumber+1 lives at index commitNumber
      if (!entry) break;
      s.commitNumber++;
      const req = entry.request;
      let result: string | null = null;
      if (req.op.op === 'set') {
        s.kv[req.op.key] = req.op.value;
        result = req.op.value;
      } else if (req.op.op === 'del') {
        result = req.op.key in s.kv ? s.kv[req.op.key] : null;
        delete s.kv[req.op.key];
      }
      const reply: VrReply = { requestNumber: req.requestNumber, result };
      s.clientTable[req.clientId] = reply;
      if (req.op.op !== 'noop') ctx.log('commit', `executed #${s.commitNumber} ${describeOp(req.op)}`);
      if (isPrimary(s)) s.lastReply = reply;
    }
  };

  // The primary advances its commit point to the highest op-number a quorum
  // (itself + the PrepareOk tallies) has stored, then executes and announces it.
  const advanceCommit = (ctx: NodeContext, s: VrState) => {
    if (!isPrimary(s) || s.status !== 'normal') return;
    const need = quorum(N(s));
    let newCommit = s.commitNumber;
    for (let n = s.opNumber; n > s.commitNumber; n--) {
      let count = 1; // the primary itself holds every op it assigned
      for (const id of others(s)) {
        const idx = s.configuration.indexOf(id);
        if ((s.prepareOk[String(idx)] ?? 0) >= n) count++;
      }
      if (count >= need) {
        newCommit = n;
        break;
      }
    }
    if (newCommit > s.commitNumber) {
      executeUpTo(ctx, s, newCommit);
      broadcastCommit(ctx, s);
    }
  };

  const broadcastCommit = (ctx: NodeContext, s: VrState) => {
    const c: Commit = { view: s.view, commitNumber: s.commitNumber, from: s.replicaNumber };
    for (const id of others(s)) ctx.send(id, 'VrCommit', c);
  };

  const becomeNormalPrimary = (ctx: NodeContext, s: VrState) => {
    s.status = 'normal';
    s.lastNormalView = s.view;
    s.prepareOk = { [String(s.replicaNumber)]: s.opNumber };
    s.startViewChange = [];
    s.doViewChange = {};
    ctx.clearTimer('primary');
    ctx.clearTimer('viewchange');
    startHeartbeat(ctx);
    ctx.log('state', `became PRIMARY of view ${s.view} (op ${s.opNumber}, commit ${s.commitNumber})`);
  };

  const becomeNormalBackup = (ctx: NodeContext, s: VrState) => {
    s.status = 'normal';
    s.lastNormalView = s.view;
    s.startViewChange = [];
    s.doViewChange = {};
    ctx.clearTimer('heartbeat');
    ctx.clearTimer('viewchange');
    armPrimaryTimeout(ctx, s);
  };

  // Move to `newView` and solicit a view change. Any replica that sees a message
  // from a later view than its own follows it here; a suspected-primary timeout
  // starts one for view+1.
  const startViewChange = (ctx: NodeContext, s: VrState, newView: number) => {
    if (newView < s.view) return;
    if (newView === s.view && s.status !== 'view-change') return; // already settled here
    if (newView === s.view && s.status === 'view-change') return; // already changing to it
    s.view = newView;
    s.status = 'view-change';
    s.startViewChange = [s.replicaNumber];
    s.doViewChange = {};
    ctx.clearTimer('heartbeat');
    ctx.setTimer('viewchange', config.viewChangeTimeout);
    ctx.log('state', `start view change → view ${s.view}`);
    const svc: StartViewChange = { view: s.view, from: s.replicaNumber };
    for (const id of others(s)) ctx.send(id, 'VrStartViewChange', svc);
    maybeSendDoViewChange(ctx, s);
  };

  // Once we have heard StartViewChange from a quorum (f+1 incl. self) we send our
  // log to the new primary in a DoViewChange.
  const maybeSendDoViewChange = (ctx: NodeContext, s: VrState) => {
    if (s.status !== 'view-change') return;
    if (s.startViewChange.length < quorum(N(s))) return;
    const dvc: DoViewChange = {
      view: s.view,
      log: s.log.slice(),
      lastNormalView: s.lastNormalView,
      opNumber: s.opNumber,
      commitNumber: s.commitNumber,
      from: s.replicaNumber,
    };
    const primary = primaryOf(s.view, s.configuration);
    if (primary === self(s)) {
      s.doViewChange[String(s.replicaNumber)] = dvc; // deliver to self directly
      maybeStartView(ctx, s);
    } else {
      ctx.send(primary, 'VrDoViewChange', dvc);
    }
  };

  // The new primary, once it holds DoViewChange from a quorum, picks the most
  // up-to-date log among them (largest lastNormalView, ties broken by op-number),
  // adopts it, and broadcasts StartView.
  const maybeStartView = (ctx: NodeContext, s: VrState) => {
    if (primaryOf(s.view, s.configuration) !== self(s)) return;
    if (s.status !== 'view-change') return;
    const msgs = Object.values(s.doViewChange);
    if (msgs.length < quorum(N(s))) return;
    let best = msgs[0];
    for (const m of msgs) {
      if (m.lastNormalView > best.lastNormalView || (m.lastNormalView === best.lastNormalView && m.opNumber > best.opNumber)) {
        best = m;
      }
    }
    s.log = best.log.slice();
    s.opNumber = best.opNumber;
    const maxCommit = Math.max(...msgs.map((m) => m.commitNumber));
    becomeNormalPrimary(ctx, s);
    executeUpTo(ctx, s, maxCommit);
    const sv: StartView = { view: s.view, log: s.log.slice(), opNumber: s.opNumber, commitNumber: s.commitNumber };
    for (const id of others(s)) ctx.send(id, 'VrStartView', sv);
  };

  const adoptStartView = (ctx: NodeContext, s: VrState, sv: StartView) => {
    s.view = sv.view;
    s.log = sv.log.slice();
    s.opNumber = sv.opNumber;
    if (primaryOf(s.view, s.configuration) === self(s)) {
      // Rare: we are the primary of a view someone else drove to StartView. Adopt as primary.
      becomeNormalPrimary(ctx, s);
    } else {
      becomeNormalBackup(ctx, s);
    }
    executeUpTo(ctx, s, sv.commitNumber);
    // Ack any uncommitted tail so the primary can (re)commit it under the new view.
    if (s.opNumber > s.commitNumber && !isPrimary(s)) {
      const ok: PrepareOk = { view: s.view, opNumber: s.opNumber, from: s.replicaNumber };
      ctx.send(primaryOf(s.view, s.configuration), 'VrPrepareOk', ok);
    }
    ctx.log('state', `entered view ${s.view} (op ${s.opNumber}, commit ${s.commitNumber})`);
  };

  const requestState = (ctx: NodeContext, s: VrState) => {
    const gs: GetState = { view: s.view, opNumber: s.opNumber, from: s.replicaNumber };
    ctx.send(primaryOf(s.view, s.configuration), 'VrGetState', gs);
  };

  // ---- recovery ----

  const startRecovery = (ctx: NodeContext, s: VrState) => {
    s.status = 'recovering';
    s.log = [];
    s.opNumber = 0;
    s.commitNumber = 0;
    s.kv = {};
    s.clientTable = {};
    s.prepareOk = {};
    s.startViewChange = [];
    s.doViewChange = {};
    s.recoveryResponses = {};
    s.recoveryNonce = ctx.rng.int(1, 2 ** 30);
    ctx.clearTimer('heartbeat');
    ctx.clearTimer('primary');
    ctx.clearTimer('viewchange');
    ctx.setTimer('recovery', config.recoveryTimeout);
    ctx.log('state', `recovering (nonce ${s.recoveryNonce})`);
    const rec: Recovery = { from: s.replicaNumber, nonce: s.recoveryNonce };
    for (const id of others(s)) ctx.send(id, 'VrRecovery', rec);
  };

  const maybeFinishRecovery = (ctx: NodeContext, s: VrState) => {
    if (s.status !== 'recovering') return;
    const resps = Object.values(s.recoveryResponses).filter((r) => r.nonce === s.recoveryNonce);
    if (resps.length < quorum(N(s))) return;
    const latestView = Math.max(...resps.map((r) => r.view));
    const primaryResp = resps.find((r) => r.view === latestView && r.log !== null);
    if (!primaryResp) return; // need the latest view's primary in the quorum
    s.view = latestView;
    s.log = (primaryResp.log ?? []).slice();
    s.opNumber = primaryResp.opNumber ?? s.log.length;
    s.recoveryResponses = {};
    if (primaryOf(s.view, s.configuration) === self(s)) becomeNormalPrimary(ctx, s);
    else becomeNormalBackup(ctx, s);
    executeUpTo(ctx, s, primaryResp.commitNumber ?? 0);
    ctx.log('state', `recovered into view ${s.view} (op ${s.opNumber}, commit ${s.commitNumber})`);
  };

  // ---- request handling ----

  const alreadyServed = (s: VrState, req: VrRequest): VrReply | null => {
    const prev = s.clientTable[req.clientId];
    if (prev && prev.requestNumber === req.requestNumber) return prev;
    return null;
  };

  const handleRequest = (ctx: NodeContext, s: VrState, req: VrRequest) => {
    if (s.status !== 'normal' || !isPrimary(s)) {
      ctx.log('info', `not primary/normal; request dropped (primary=${primaryOf(s.view, s.configuration)})`);
      return;
    }
    const prev = s.clientTable[req.clientId];
    if (prev && req.requestNumber < prev.requestNumber) return; // stale
    if (alreadyServed(s, req)) {
      s.lastReply = s.clientTable[req.clientId];
      return; // duplicate of the latest — resend result, no new op
    }
    s.opNumber++;
    const entry: VrLogEntry = { view: s.view, request: req };
    s.log.push(entry);
    s.prepareOk[String(s.replicaNumber)] = s.opNumber;
    ctx.log('state', `prepare #${s.opNumber} ${describeOp(req.op)}`);
    const p: Prepare = {
      view: s.view,
      entry,
      opNumber: s.opNumber,
      commitNumber: s.commitNumber,
      from: s.replicaNumber,
    };
    for (const id of others(s)) ctx.send(id, 'VrPrepare', p);
    if (N(s) === 1) advanceCommit(ctx, s);
  };

  return {
    name: 'Viewstamped Replication',

    init(ctx) {
      const configuration = [...ctx.all];
      const replicaNumber = configuration.indexOf(ctx.self);
      const s: VrState = {
        configuration,
        replicaNumber,
        view: 0,
        status: 'normal',
        opNumber: 0,
        commitNumber: 0,
        log: [],
        kv: {},
        clientTable: {},
        prepareOk: {},
        startViewChange: [],
        doViewChange: {},
        lastNormalView: 0,
        recoveryNonce: 0,
        recoveryResponses: {},
        lastReply: null,
        timeoutMs: config.timeoutMin,
      };
      if (primaryOf(0, configuration) === ctx.self) {
        s.prepareOk = { [String(replicaNumber)]: 0 };
        startHeartbeat(ctx);
      } else {
        armPrimaryTimeout(ctx, s);
      }
      return s;
    },

    onRestart(ctx, s) {
      startRecovery(ctx, s);
    },

    onCommand(ctx, s, cmd) {
      if (cmd.type === 'timeout') {
        if (!isPrimary(s) && s.status === 'normal') startViewChange(ctx, s, s.view + 1);
        return;
      }
      handleRequest(ctx, s, { clientId: cmd.clientId, requestNumber: cmd.requestNumber, op: cmd.op });
    },

    onTimer(ctx, s, name) {
      if (name === 'heartbeat') {
        if (isPrimary(s) && s.status === 'normal') {
          broadcastCommit(ctx, s);
          startHeartbeat(ctx);
        }
      } else if (name === 'primary') {
        if (s.status === 'normal' && !isPrimary(s)) {
          startViewChange(ctx, s, s.view + 1);
        } else if (s.status === 'normal') {
          armPrimaryTimeout(ctx, s); // primary keeps the timer harmlessly alive
        }
      } else if (name === 'viewchange') {
        if (s.status === 'view-change') {
          startViewChange(ctx, s, s.view + 1); // escalate: the new primary may also be down
        }
      } else if (name === 'recovery') {
        if (s.status === 'recovering') {
          ctx.setTimer('recovery', config.recoveryTimeout);
          const rec: Recovery = { from: s.replicaNumber, nonce: s.recoveryNonce };
          for (const id of others(s)) ctx.send(id, 'VrRecovery', rec);
        }
      }
    },

    onMessage(ctx, s, msg: Message) {
      // A recovering replica ignores everything except its recovery responses.
      if (s.status === 'recovering' && msg.type !== 'VrRecoveryResponse') return;

      switch (msg.type) {
        case 'VrPrepare':
          onPrepare(ctx, s, msg.payload as Prepare);
          break;
        case 'VrPrepareOk':
          onPrepareOk(ctx, s, msg.payload as PrepareOk);
          break;
        case 'VrCommit':
          onCommit(ctx, s, msg.payload as Commit);
          break;
        case 'VrStartViewChange':
          onStartViewChange(ctx, s, msg.payload as StartViewChange);
          break;
        case 'VrDoViewChange':
          onDoViewChange(ctx, s, msg.payload as DoViewChange);
          break;
        case 'VrStartView':
          onStartViewMsg(ctx, s, msg.payload as StartView);
          break;
        case 'VrGetState':
          onGetState(ctx, s, msg.payload as GetState);
          break;
        case 'VrNewState':
          onNewState(ctx, s, msg.payload as NewState);
          break;
        case 'VrRecovery':
          onRecovery(ctx, s, msg.payload as Recovery);
          break;
        case 'VrRecoveryResponse':
          onRecoveryResponse(ctx, s, msg.payload as RecoveryResponse);
          break;
      }
    },
  };

  // ---- message handlers ----

  function onPrepare(ctx: NodeContext, s: VrState, p: Prepare) {
    if (p.view < s.view) return; // stale primary
    if (p.view > s.view) {
      startViewChange(ctx, s, p.view); // we're behind — move to the newer view
      return;
    }
    if (s.status !== 'normal') return; // e.g. mid view-change; StartView will settle us
    armPrimaryTimeout(ctx, s); // heard from the primary
    if (p.opNumber === s.opNumber + 1) {
      s.log.push(p.entry);
      s.opNumber = p.opNumber;
      const ok: PrepareOk = { view: s.view, opNumber: s.opNumber, from: s.replicaNumber };
      ctx.send(primaryOf(s.view, s.configuration), 'VrPrepareOk', ok);
      if (p.commitNumber > s.commitNumber) executeUpTo(ctx, s, p.commitNumber);
    } else if (p.opNumber > s.opNumber + 1) {
      requestState(ctx, s); // a gap — pull the missing suffix
    } else {
      // duplicate/older prepare: re-ack our current op-number and follow the commit
      const ok: PrepareOk = { view: s.view, opNumber: s.opNumber, from: s.replicaNumber };
      ctx.send(primaryOf(s.view, s.configuration), 'VrPrepareOk', ok);
      if (p.commitNumber > s.commitNumber) executeUpTo(ctx, s, p.commitNumber);
    }
  }

  function onPrepareOk(ctx: NodeContext, s: VrState, r: PrepareOk) {
    if (r.view !== s.view || s.status !== 'normal' || !isPrimary(s)) return;
    const key = String(r.from);
    s.prepareOk[key] = Math.max(s.prepareOk[key] ?? 0, r.opNumber);
    advanceCommit(ctx, s);
  }

  function onCommit(ctx: NodeContext, s: VrState, c: Commit) {
    if (c.view < s.view) return;
    if (c.view > s.view) {
      startViewChange(ctx, s, c.view);
      return;
    }
    if (s.status !== 'normal') return;
    armPrimaryTimeout(ctx, s);
    if (c.commitNumber > s.opNumber) {
      requestState(ctx, s); // behind — need the ops before we can commit them
    } else if (c.commitNumber > s.commitNumber) {
      executeUpTo(ctx, s, c.commitNumber);
    }
  }

  function onStartViewChange(ctx: NodeContext, s: VrState, svc: StartViewChange) {
    // A view change only ever moves to a *higher* view. A replica already normal in
    // view v ignores StartViewChange for view ≤ v — treating a stale one as a trigger
    // would knock a healthy primary back into a view change and could lose committed
    // ops. If we are the primary of the straggler's view, re-send StartView to pull it in.
    if (svc.view < s.view) return;
    if (svc.view === s.view && s.status === 'normal') {
      if (primaryOf(s.view, s.configuration) === self(s)) {
        const sv: StartView = { view: s.view, log: s.log.slice(), opNumber: s.opNumber, commitNumber: s.commitNumber };
        ctx.send(s.configuration[svc.from], 'VrStartView', sv);
      }
      return;
    }
    if (svc.view > s.view) startViewChange(ctx, s, svc.view);
    if (svc.view === s.view && s.status === 'view-change') {
      if (!s.startViewChange.includes(svc.from)) s.startViewChange.push(svc.from);
      maybeSendDoViewChange(ctx, s);
    }
  }

  function onDoViewChange(ctx: NodeContext, s: VrState, dvc: DoViewChange) {
    if (dvc.view < s.view) return;
    if (dvc.view > s.view) {
      // A quorum is clearly forming for a later view; join it so we can contribute.
      startViewChange(ctx, s, dvc.view);
    }
    if (primaryOf(dvc.view, s.configuration) !== self(s)) return; // not the target primary
    if (dvc.view !== s.view) return;
    s.doViewChange[String(dvc.from)] = dvc;
    maybeStartView(ctx, s);
  }

  function onStartViewMsg(ctx: NodeContext, s: VrState, sv: StartView) {
    if (sv.view < s.view) return;
    if (sv.view === s.view && s.status === 'normal' && !isPrimary(s)) return; // already here
    adoptStartView(ctx, s, sv);
  }

  function onGetState(ctx: NodeContext, s: VrState, gs: GetState) {
    if (gs.view !== s.view || s.status !== 'normal') return;
    if (gs.opNumber > s.opNumber) return;
    const ns: NewState = {
      view: s.view,
      afterOpNumber: gs.opNumber,
      suffix: s.log.slice(gs.opNumber),
      opNumber: s.opNumber,
      commitNumber: s.commitNumber,
    };
    ctx.send(s.configuration[gs.from], 'VrNewState', ns);
  }

  function onNewState(ctx: NodeContext, s: VrState, ns: NewState) {
    if (ns.view !== s.view || s.status !== 'normal') return;
    if (ns.afterOpNumber !== s.opNumber) return; // raced; ignore, we'll ask again
    for (const e of ns.suffix) s.log.push(e);
    s.opNumber = ns.opNumber;
    if (!isPrimary(s)) {
      const ok: PrepareOk = { view: s.view, opNumber: s.opNumber, from: s.replicaNumber };
      ctx.send(primaryOf(s.view, s.configuration), 'VrPrepareOk', ok);
    }
    if (ns.commitNumber > s.commitNumber) executeUpTo(ctx, s, ns.commitNumber);
  }

  function onRecovery(ctx: NodeContext, s: VrState, rec: Recovery) {
    if (s.status !== 'normal') return; // only a normal replica may answer
    const amPrimary = isPrimary(s);
    const resp: RecoveryResponse = {
      view: s.view,
      nonce: rec.nonce,
      from: s.replicaNumber,
      log: amPrimary ? s.log.slice() : null,
      opNumber: amPrimary ? s.opNumber : null,
      commitNumber: amPrimary ? s.commitNumber : null,
    };
    ctx.send(s.configuration[rec.from], 'VrRecoveryResponse', resp);
  }

  function onRecoveryResponse(ctx: NodeContext, s: VrState, resp: RecoveryResponse) {
    if (s.status !== 'recovering' || resp.nonce !== s.recoveryNonce) return;
    s.recoveryResponses[String(resp.from)] = resp;
    maybeFinishRecovery(ctx, s);
  }
}
