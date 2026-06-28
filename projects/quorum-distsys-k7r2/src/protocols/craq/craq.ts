// Chain Replication + CRAQ — the engine.
//
// Roles. One node is the **master** (`role: 'master'`); the rest are chain
// **replicas**. The master owns membership: it pings replicas, and when one stops
// answering it removes it from the chain, bumps the epoch and hands every replica
// the new configuration. A replica refreshes a short *lease* on each ping; if its
// lease lapses (it has lost the master) it goes **passive** and refuses to serve —
// that lease is what keeps a partitioned-off replica from answering a stale read
// while the chain has moved on, so linearizability survives partitions.
//
// Updates (writes). A write enters at the head, which stamps it with the next
// per-key version, stores it *dirty*, and forwards it down the chain. Each node
// stores it dirty and forwards; the tail commits it (clean) and sends an ack back
// up. Each node, on the ack, marks that version clean, prunes older versions and
// forwards the ack; when it reaches the head the write is done.
//
// Queries (reads, the CRAQ part). Any replica can answer. If its latest version
// of the key is clean it returns it immediately (an apportioned, locally-served
// read). If the latest is dirty it asks the tail for the latest committed version
// and returns that — so it can never answer ahead of, or behind, the real
// committed state.
//
// Reconfiguration. When the config changes a node state-transfers (`Sync`) its
// store to its new successor, a fresh tail commits whatever it is holding, and a
// fresh head resumes version numbering above what survived — so the chain knits
// itself back together and the invariants hold across crashes and restarts.
import type { NodeContext, Message, Protocol } from '../../sim/types';
import {
  DEFAULT_CRAQ_CONFIG,
  emptyKeyStore,
  maxVer,
  isDirty,
  valueAt,
  latestValue,
  committedValue,
  putVersion,
  versionAt,
  highestHeldUpTo,
  pruneBelowCommitted,
  epochBase,
  headOf,
  tailOf,
  succOf,
  predOf,
  inChain,
  type CraqConfig,
  type CraqState,
  type CraqCmd,
  type ChainConfig,
  type KeyStore,
  type CompletedOp,
  type PingMsg,
  type PongMsg,
  type ConfigMsg,
  type ClientWriteMsg,
  type UpdateMsg,
  type AckMsg,
  type VersionQueryMsg,
  type VersionReplyMsg,
  type SyncMsg,
  type SyncReqMsg,
  type FrontierReqMsg,
  type FrontierReplyMsg,
  type BeatMsg,
} from './types';

export interface CraqOptions {
  /** Which node id is the master. */
  master: string;
  config?: CraqConfig;
}

export function createCraq(opts: CraqOptions): Protocol<CraqState, CraqCmd> {
  const cfg = opts.config ?? DEFAULT_CRAQ_CONFIG;
  const MASTER = opts.master;

  // -------- small helpers over a replica's store ---------------------------

  const ks = (s: CraqState, key: string): KeyStore => (s.store[key] ??= emptyKeyStore());

  function recordOp(s: CraqState, op: CompletedOp): void {
    s.history.push(op);
    if (s.history.length > cfg.historyCap) s.history.splice(0, s.history.length - cfg.historyCap);
  }

  /**
   * Is this replica allowed to serve a client? It must be in the chain, hold a live
   * config lease from the master (so a node partitioned from the master steps down),
   * and be *ready* (caught up for its position, so a node partitioned from its
   * chain predecessor can't answer with stale data). Those two leases together keep
   * reads linearizable under arbitrary partitions, not just crashes.
   */
  function active(ctx: NodeContext, s: CraqState): boolean {
    if (!inChain(s.config, ctx.self) || ctx.now > s.leaseUntil || !s.ready) return false;
    // The head is the source of currency; every other node must have heard a recent
    // in-frontier Beat from upstream, or it may have silently gone stale.
    return headOf(s.config) === ctx.self || ctx.now <= s.chainLeaseUntil;
  }

  /**
   * May this node *commit* (advance the committed watermark) right now? Only once
   * its configuration is active — i.e. enough time has passed since the config was
   * formed that every replica's lease under the previous config has expired. Until
   * then the chain is read-only at the last committed value, so an about-to-go-
   * passive old replica can't serve a read that a new commit would contradict.
   */
  function committable(ctx: NodeContext, s: CraqState): boolean {
    return active(ctx, s) && ctx.now >= s.config.activeAt;
  }

  /** This node's committed (version) frontier, per key — what the head beats down. */
  function committedFrontier(s: CraqState): Record<string, number> {
    const out: Record<string, number> = {};
    for (const key of Object.keys(s.store)) if (s.store[key].committed > 0) out[key] = s.store[key].committed;
    return out;
  }

  /** Send a state-transfer of our (current) store to our successor, if any. */
  function syncToSuccessor(ctx: NodeContext, s: CraqState): void {
    const succ = succOf(s.config, ctx.self);
    if (succ !== undefined) ctx.send(succ, 'Sync', { epoch: s.config.epoch, store: cloneStore(s.store) } as SyncMsg);
  }

  // -------- write path -----------------------------------------------------

  /** The head stamps a fresh version and starts it down the chain. */
  function coordinateWrite(ctx: NodeContext, s: CraqState, opId: string, key: string, value: string, origin: string, startedAt: number): void {
    const store = ks(s, key);
    // Stride the version by config epoch so two heads never collide on a number.
    const ver = Math.max(s.nextVer[key] ?? 0, maxVer(store) + 1, store.committed + 1, epochBase(s.config.epoch) + 1);
    s.nextVer[key] = ver + 1;
    putVersion(store, ver, value, { opId, origin, startedAt });
    s.pendingWrites[opId] = { opId, key, value, ver, startedAt, origin, retries: 0 };
    s.note = `head: write ${key}=${value} → v${ver} (dirty), propagating`;
    ctx.log('state', `head stamps ${key}=${value} as v${ver} and sends it down the chain`);

    const succ = succOf(s.config, ctx.self);
    if (succ === undefined) {
      // Single-node chain: the head is also the tail. Commit once the config is
      // active; until then the retry timer re-drives it (the write stays pending).
      if (committable(ctx, s) && commitAt(ctx, s, key, ver)) {
        recordCommittedWrite(ctx, s, key, ver);
        finishWriteAtHead(ctx, s, opId);
      } else {
        ctx.setTimer('wretry:' + opId, cfg.retry);
      }
    } else {
      ctx.send(succ, 'Update', { opId, key, value, ver, origin, startedAt, epoch: s.config.epoch } as UpdateMsg);
      ctx.setTimer('wretry:' + opId, cfg.retry);
    }
  }

  /** Record a write at its commit point (the tail), using the version's metadata. */
  function recordCommittedWrite(ctx: NodeContext, s: CraqState, key: string, ver: number): void {
    const v = versionAt(ks(s, key), ver);
    if (!v || !v.opId) return; // value learned without provenance (already recorded elsewhere)
    if (s.history.some((o) => o.id === v.opId)) return; // de-dupe within this node
    recordOp(s, {
      id: v.opId,
      kind: 'write',
      key,
      value: v.value,
      ver,
      startedAt: v.startedAt ?? ctx.now,
      finishedAt: ctx.now,
      coord: v.origin ?? ctx.self,
    });
    s.writes++;
  }

  /**
   * Mark a version clean locally and drop superseded ones. We only ever advance the
   * watermark to a version we actually *hold* — committing a version we never
   * received (e.g. its Update was dropped and only the ack reached us after a
   * reconfiguration) would leave `committed` pointing at a value we can't serve. If
   * we don't hold it, we ignore the ack; the head re-drives the Update and a later
   * ack commits it for real.
   */
  function commitAt(ctx: NodeContext, s: CraqState, key: string, ver: number): boolean {
    const store = ks(s, key);
    if (ver <= store.committed) return false; // already known clean
    if (!versionAt(store, ver)) return false; // we don't hold this version's value yet
    store.committed = ver;
    pruneBelowCommitted(store);
    ctx.log('commit', `${ctx.self}: v${ver} of ${key} now clean (committed)`);
    return true;
  }

  /**
   * The head learns (via the upstream ack) that its write committed. The op was
   * already recorded into the history at the tail (the commit point), so here we
   * just retire the head's bookkeeping and stop retrying.
   */
  function finishWriteAtHead(ctx: NodeContext, s: CraqState, opId: string): void {
    const pw = s.pendingWrites[opId];
    if (!pw) return;
    delete s.pendingWrites[opId];
    ctx.clearTimer('wretry:' + opId);
    s.note = `write ${pw.key}=${pw.value} committed @ v${pw.ver}`;
  }

  // -------- read path (CRAQ) ----------------------------------------------

  function coordinateRead(ctx: NodeContext, s: CraqState, opId: string, key: string, startedAt: number): void {
    const store = ks(s, key);
    if (!isDirty(store)) {
      // Clean: answer locally — the apportioned read that makes CRAQ scale.
      const ver = store.committed;
      const value = committedValue(store);
      recordOp(s, { id: opId, kind: 'read', key, value, ver, startedAt, finishedAt: ctx.now, coord: ctx.self, readPath: 'clean' });
      s.reads++;
      s.cleanReads++;
      s.note = `clean read ${key} → ${value || '∅'} @ v${ver} (served locally)`;
      ctx.log('state', `${ctx.self}: clean read of ${key} answered locally → ${value || '∅'} (v${ver})`);
      return;
    }
    // Dirty: an update is in flight — ask the tail for its committed version.
    const tail = tailOf(s.config);
    s.pendingReads[opId] = { opId, key, startedAt, retries: 0 };
    s.dirtyReads++;
    s.note = `dirty read ${key} — asking tail ${tail ?? '?'} for the committed version`;
    ctx.log('state', `${ctx.self}: ${key} is dirty → version query to tail ${tail ?? '?'}`);
    if (tail === ctx.self) {
      // We *are* the tail: our committed version is authoritative.
      finishDirtyRead(ctx, s, opId, store.committed, committedValue(store));
    } else if (tail !== undefined) {
      ctx.send(tail, 'VersionQuery', { opId, key, origin: ctx.self } as VersionQueryMsg);
      ctx.setTimer('rretry:' + opId, cfg.retry);
    }
  }

  function finishDirtyRead(ctx: NodeContext, s: CraqState, opId: string, ver: number, value: string): void {
    const pr = s.pendingReads[opId];
    if (!pr) return;
    recordOp(s, { id: opId, kind: 'read', key: pr.key, value, ver, startedAt: pr.startedAt, finishedAt: ctx.now, coord: ctx.self, readPath: 'dirty' });
    s.reads++;
    delete s.pendingReads[opId];
    ctx.clearTimer('rretry:' + opId);
    s.note = `dirty read ${pr.key} → ${value || '∅'} @ v${ver} (tail-confirmed)`;
  }

  // -------- master: membership + reconfiguration ---------------------------

  function aliveMembers(s: CraqState, now: number): string[] {
    return s.members.filter((m) => now - (s.lastSeen[m] ?? -Infinity) <= cfg.suspectTimeout);
  }

  /** Recompute the chain (order ∩ alive, joiners appended) and publish on change. */
  function reconcileChain(ctx: NodeContext, s: CraqState): void {
    const alive = new Set(aliveMembers(s, ctx.now));
    // CONTINUITY / no data loss: a new chain must retain at least one live node from
    // the current chain, which carries the committed prefix forward and syncs it to
    // the rest. If *every* current chain member is down, we must NOT form a fresh
    // chain from stale survivors (that would silently drop committed writes) — the
    // chain stays unavailable until a member that holds the data returns. This is
    // chain replication's CP choice: safety over liveness.
    if (s.config.chain.length > 0 && !s.config.chain.some((m) => alive.has(m))) {
      return; // no live carrier of the committed state — keep the (unavailable) chain
    }
    // Keep existing order for survivors; append any alive member not yet ordered.
    const next = s.order.filter((m) => alive.has(m));
    for (const m of s.members) if (alive.has(m) && !next.includes(m)) next.push(m);
    const changed = next.length !== s.config.chain.length || next.some((m, i) => m !== s.config.chain[i]);
    s.order = next;
    if (!changed) return;
    // The new config becomes committable one lease-period out, by which time every
    // replica's lease under the previous config has expired.
    const activeAt = ctx.now + cfg.leaseTimeout;
    s.config = { epoch: s.config.epoch + 1, chain: next, activeAt };
    ctx.log('info', `master: new config #${s.config.epoch} — chain ${next.join('→') || '(empty)'} (active in ${cfg.leaseTimeout}ms)`);
    for (const m of s.members) ctx.send(m, 'Config', { epoch: s.config.epoch, chain: next, activeAt } as ConfigMsg);
  }

  // -------- replica: adopt a new configuration -----------------------------

  function adoptConfig(ctx: NodeContext, s: CraqState, epoch: number, chain: string[], activeAt: number): void {
    if (epoch <= s.config.epoch) return;
    const oldConfig = s.config;
    const prevPred = predOf(oldConfig, ctx.self);
    const wasReady = s.ready;
    const wasInChain = inChain(oldConfig, ctx.self);
    s.config = { epoch, chain, activeAt };
    s.leaseUntil = ctx.now + cfg.leaseTimeout;

    if (!inChain(s.config, ctx.self)) {
      s.ready = false;
      s.note = `removed from chain @ config #${epoch} — passive`;
      return;
    }

    const newPred = predOf(s.config, ctx.self);
    const isHead = headOf(s.config) === ctx.self;

    if (isHead) {
      if (wasInChain && headOf(oldConfig) === ctx.self && wasReady) {
        // We were already the (ready) head and still are — stay current, just renumber.
        s.ready = true;
        resumeNumbering(s, epoch);
        syncToSuccessor(ctx, s);
      } else {
        // A freshly-installed head: committed data only flows *down*, so we might be
        // missing a committed version that lives downstream. Pull every chain
        // member's committed frontier before serving, so we hold the whole committed
        // history; only then become ready and push it down.
        s.ready = false;
        s.frontierAcks = {};
        collectFrontier(ctx, s);
      }
    } else if (wasInChain && wasReady && newPred === prevPred) {
      // Our position relative to our predecessor is unchanged and we were current —
      // stay ready, and re-push state to our successor (which may have changed).
      s.ready = true;
      syncToSuccessor(ctx, s);
      if (tailOf(s.config) === ctx.self) commitAllAndAck(ctx, s);
    } else {
      // We just joined the chain, or our predecessor changed: we may be behind, so
      // go *not ready* and pull a fresh state-transfer from our new predecessor
      // before serving anything.
      s.ready = false;
      if (newPred !== undefined) ctx.send(newPred, 'SyncReq', { epoch, from: ctx.self } as SyncReqMsg);
    }

    s.note = `config #${epoch}: ${role(s.config, ctx.self)} of ${chain.join('→')}${s.ready ? '' : ' (syncing)'}`;
  }

  /** Resume the head's per-key version counter above what survived + the epoch floor. */
  function resumeNumbering(s: CraqState, epoch: number): void {
    const floor = epochBase(epoch) + 1;
    for (const key of Object.keys(s.store)) {
      const store = s.store[key];
      s.nextVer[key] = Math.max(s.nextVer[key] ?? 0, maxVer(store) + 1, store.committed + 1, floor);
    }
  }

  /** A new head asks every other chain member for its committed frontier. */
  function collectFrontier(ctx: NodeContext, s: CraqState): void {
    const others = s.config.chain.filter((id) => id !== ctx.self);
    if (others.length === 0) {
      // Sole chain member — nothing to pull; we are trivially current.
      finishHeadInstall(ctx, s);
      return;
    }
    for (const id of others) ctx.send(id, 'FrontierReq', { epoch: s.config.epoch, from: ctx.self } as FrontierReqMsg);
    s.note = `new head — pulling committed frontier from ${others.join(',')}`;
  }

  /** Adopt one member's reported committed frontier (max-committed per key wins). */
  function applyFrontierReply(ctx: NodeContext, s: CraqState, p: FrontierReplyMsg): void {
    if (headOf(s.config) !== ctx.self || s.ready || p.epoch !== s.config.epoch) return;
    for (const key of Object.keys(p.frontier)) {
      const f = p.frontier[key];
      const local = ks(s, key);
      if (f.ver > local.committed) {
        putVersion(local, f.ver, f.value); // adopt the newer committed value
        local.committed = f.ver;
        pruneBelowCommitted(local);
      }
    }
    s.frontierAcks[p.from] = true;
    const others = s.config.chain.filter((id) => id !== ctx.self);
    if (others.every((id) => s.frontierAcks[id])) finishHeadInstall(ctx, s);
  }

  /** The head has the full committed frontier — become ready and push it down. */
  function finishHeadInstall(ctx: NodeContext, s: CraqState): void {
    s.ready = true;
    resumeNumbering(s, s.config.epoch);
    syncToSuccessor(ctx, s);
    s.note = `head ready @ config #${s.config.epoch} (${role(s.config, ctx.self)})`;
  }

  function role(c: ChainConfig, id: string): string {
    if (!inChain(c, id)) return 'passive';
    if (c.chain.length === 1) return 'head+tail';
    if (headOf(c) === id) return 'head';
    if (tailOf(c) === id) return 'tail';
    return 'middle';
  }

  /**
   * Tail-on-takeover: commit every *inherited* version this node already holds,
   * record it, and ack upstream. This runs immediately (it is NOT lease-gated):
   * an inherited value was already committed/visible under the previous config, so
   * preserving it can never expose anything new — and skipping it would *lose* a
   * write the old tail committed before it crashed. New writes (which the head only
   * stamps once the config is active) are gated separately, at ingestion.
   */
  function commitAllAndAck(ctx: NodeContext, s: CraqState): void {
    // Committing inherited backlog is pure durability preservation (the values were
    // already replicated), so it runs whenever we're the tail — independent of the
    // serving-readiness gate. (New writes are gated separately, at ingestion.)
    if (tailOf(s.config) !== ctx.self) return;
    const pred = predOf(s.config, ctx.self);
    for (const key of Object.keys(s.store)) {
      const store = s.store[key];
      const top = maxVer(store);
      if (top > store.committed) {
        commitAt(ctx, s, key, top);
        recordCommittedWrite(ctx, s, key, top); // a force-committed in-flight write is now durable
        if (pred !== undefined) ctx.send(pred, 'Ack', { opId: 'takeover', key, ver: top } as AckMsg);
      }
    }
  }

  function cloneStore(store: Record<string, KeyStore>): Record<string, KeyStore> {
    const out: Record<string, KeyStore> = {};
    for (const k of Object.keys(store)) out[k] = { versions: store[k].versions.map((v) => ({ ...v })), committed: store[k].committed };
    return out;
  }

  /**
   * Merge a state-transfer from our current predecessor: adopt the more-advanced
   * version set, mark ourselves ready, and cascade the now-current state to our own
   * successor so readiness flows head→tail. (The sender is verified to be our live
   * predecessor in the onMessage 'Sync' branch before this runs.)
   */
  function applySync(ctx: NodeContext, s: CraqState, sync: SyncMsg): void {
    for (const key of Object.keys(sync.store)) {
      const incoming = sync.store[key];
      const local = ks(s, key);
      // The predecessor is upstream (authoritative). Adopt its versions when it is
      // at least as advanced; never lower our own committed watermark.
      if (maxVer(incoming) >= maxVer(local)) {
        local.versions = incoming.versions.map((v) => ({ ...v }));
      }
      // Advance committed, but never past a version we actually hold (so a clean read
      // can always produce the committed value).
      const want = Math.max(local.committed, incoming.committed);
      local.committed = highestHeldUpTo(local, want);
      pruneBelowCommitted(local);
    }
    s.ready = true; // caught up — we may now serve
    s.chainLeaseUntil = Math.max(s.chainLeaseUntil, ctx.now + cfg.chainLeaseTimeout); // fresh from upstream
    if (tailOf(s.config) === ctx.self) commitAllAndAck(ctx, s); // a fresh tail commits its in-flight
    syncToSuccessor(ctx, s); // cascade the now-current state down the chain
    s.note = `synced from predecessor @ config #${sync.epoch} — ready (${role(s.config, ctx.self)})`;
  }

  // -------- the protocol object -------------------------------------------

  return {
    name: 'CRAQ',

    init(ctx) {
      const isMaster = ctx.self === MASTER;
      const members = ctx.all.filter((id) => id !== MASTER);
      const chain = [...members]; // initial chain: every replica, in id order
      const s: CraqState = {
        self: ctx.self,
        role: isMaster ? 'master' : 'replica',
        config: { epoch: 0, chain, activeAt: 0 },
        store: {},
        nextVer: {},
        pendingWrites: {},
        pendingReads: {},
        history: [],
        leaseUntil: ctx.now + cfg.initialGrace,
        ready: true, // bootstrap: every replica starts current (empty, consistent) state
        frontierAcks: {},
        chainLeaseUntil: ctx.now + cfg.initialGrace,
        opCounter: 0,
        reads: 0,
        writes: 0,
        cleanReads: 0,
        dirtyReads: 0,
        note: isMaster ? 'master: heartbeating the chain' : `replica: ${role({ epoch: 0, chain, activeAt: 0 }, ctx.self)}`,
        members,
        lastSeen: {},
        order: [...members],
      };
      if (isMaster) {
        for (const m of members) s.lastSeen[m] = ctx.now;
        ctx.setTimer('hb', cfg.hbInterval);
      } else {
        ctx.setTimer('lease', cfg.leaseTimeout);
        ctx.setTimer('beat', cfg.beatInterval);
      }
      return s;
    },

    onRestart(ctx, s) {
      // The store is stable storage and survives a crash; volatile coordination
      // state does not. The master re-pings and re-admits us at the tail.
      s.pendingWrites = {};
      s.pendingReads = {};
      if (s.role === 'master') {
        // Give every member a fresh grace window so a stale `lastSeen` from before
        // the crash doesn't trigger a spurious mass reconfiguration on restart.
        for (const m of s.members) s.lastSeen[m] = ctx.now;
        ctx.setTimer('hb', cfg.hbInterval);
        s.note = 'master restarted';
      } else {
        s.leaseUntil = ctx.now; // lapsed until we hear the master again
        s.chainLeaseUntil = ctx.now; // lapsed until we hear a fresh Beat
        s.ready = false; // possibly stale after the downtime — re-sync before serving
        ctx.setTimer('lease', cfg.leaseTimeout);
        ctx.setTimer('beat', cfg.beatInterval);
        s.note = 'replica restarted (store intact, awaiting config + sync)';
      }
    },

    onTimer(ctx, s, name) {
      if (name === 'hb' && s.role === 'master') {
        for (const m of s.members) ctx.send(m, 'Ping', { epoch: s.config.epoch, chain: s.config.chain, activeAt: s.config.activeAt } as PingMsg);
        reconcileChain(ctx, s);
        ctx.setTimer('hb', cfg.hbInterval);
        return;
      }
      if (name === 'beat' && s.role === 'replica') {
        // The head beats its committed frontier down the chain so every node can tell
        // whether it is current; non-heads just keep the timer alive.
        if (headOf(s.config) === ctx.self && s.ready) {
          const succ = succOf(s.config, ctx.self);
          if (succ !== undefined) ctx.send(succ, 'Beat', { epoch: s.config.epoch, frontier: committedFrontier(s) } as BeatMsg);
        }
        ctx.setTimer('beat', cfg.beatInterval);
        return;
      }
      if (name === 'lease' && s.role === 'replica') {
        if (ctx.now > s.leaseUntil && inChain(s.config, ctx.self)) {
          s.note = 'lease lapsed — passive (lost the master)';
        }
        ctx.setTimer('lease', cfg.leaseTimeout);
        return;
      }
      if (name.startsWith('wretry:')) {
        const opId = name.slice(7);
        const pw = s.pendingWrites[opId];
        if (!pw) return;
        if (pw.retries++ >= cfg.maxRetries) {
          // The write never made it (e.g. superseded after a head change). Abandon.
          delete s.pendingWrites[opId];
          ctx.clearTimer('wretry:' + opId);
          s.note = `write ${pw.key}=${pw.value} abandoned (no tail ack)`;
          return;
        }
        const succ = succOf(s.config, ctx.self);
        if (headOf(s.config) === ctx.self) {
          if (succ !== undefined) {
            ctx.send(succ, 'Update', { opId, key: pw.key, value: pw.value, ver: pw.ver, origin: pw.origin, startedAt: pw.startedAt, epoch: s.config.epoch } as UpdateMsg);
          } else if (committable(ctx, s) && commitAt(ctx, s, pw.key, pw.ver)) {
            // Single-node chain that has now become committable — commit + finish.
            recordCommittedWrite(ctx, s, pw.key, pw.ver);
            finishWriteAtHead(ctx, s, opId);
            return;
          }
        }
        ctx.setTimer('wretry:' + opId, cfg.retry);
        return;
      }
      if (name.startsWith('rretry:')) {
        const opId = name.slice(7);
        const pr = s.pendingReads[opId];
        if (!pr) return;
        if (pr.retries++ >= cfg.maxRetries) {
          delete s.pendingReads[opId];
          ctx.clearTimer('rretry:' + opId);
          s.note = `read ${pr.key} abandoned (tail unreachable)`;
          return;
        }
        const tail = tailOf(s.config);
        if (tail !== undefined && tail !== ctx.self) ctx.send(tail, 'VersionQuery', { opId, key: pr.key, origin: ctx.self } as VersionQueryMsg);
        ctx.setTimer('rretry:' + opId, cfg.retry);
        return;
      }
    },

    onCommand(ctx, s, cmd) {
      if (s.role === 'master') return; // the master is not a data node
      const opId = `${ctx.self}:${s.opCounter++}`;
      if (cmd.type === 'write') {
        if (!active(ctx, s)) {
          s.note = 'write refused — not serving (passive/syncing)';
          return;
        }
        const head = headOf(s.config);
        if (head === ctx.self) {
          // Only ingest a new write once the config is active, so no new value is
          // stamped (and could commit) before old-config leases have expired.
          if (committable(ctx, s)) coordinateWrite(ctx, s, opId, cmd.key, cmd.value, ctx.self, ctx.now);
          else s.note = 'write held — config activating (lease wait)';
        } else if (head !== undefined) {
          // Forward to the head, which coordinates and records completion.
          ctx.send(head, 'ClientWrite', { opId, key: cmd.key, value: cmd.value, origin: ctx.self } as ClientWriteMsg);
        }
      } else {
        if (!active(ctx, s)) {
          s.note = 'read refused — not serving (passive/syncing)';
          return;
        }
        coordinateRead(ctx, s, opId, cmd.key, ctx.now);
      }
    },

    onMessage(ctx, s, msg: Message) {
      switch (msg.type) {
        // ---- membership ----
        case 'Ping': {
          if (s.role !== 'replica') return;
          const p = msg.payload as PingMsg;
          s.leaseUntil = ctx.now + cfg.leaseTimeout;
          adoptConfig(ctx, s, p.epoch, p.chain, p.activeAt);
          // While not yet caught up, keep pulling state so we don't stay stuck: a
          // head re-collects the committed frontier, a non-head re-pulls a Sync.
          if (!s.ready && inChain(s.config, ctx.self)) {
            if (headOf(s.config) === ctx.self) collectFrontier(ctx, s);
            else {
              const pred = predOf(s.config, ctx.self);
              if (pred !== undefined) ctx.send(pred, 'SyncReq', { epoch: s.config.epoch, from: ctx.self } as SyncReqMsg);
            }
          }
          ctx.send(MASTER, 'Pong', { from: ctx.self } as PongMsg);
          return;
        }
        case 'Pong': {
          if (s.role !== 'master') return;
          const p = msg.payload as PongMsg;
          s.lastSeen[p.from] = ctx.now;
          reconcileChain(ctx, s); // a returning member rejoins at the tail
          return;
        }
        case 'Config': {
          if (s.role !== 'replica') return;
          const p = msg.payload as ConfigMsg;
          adoptConfig(ctx, s, p.epoch, p.chain, p.activeAt);
          return;
        }
        // ---- writes ----
        case 'ClientWrite': {
          const p = msg.payload as ClientWriteMsg;
          if (headOf(s.config) === ctx.self && committable(ctx, s)) {
            coordinateWrite(ctx, s, p.opId, p.key, p.value, p.origin, ctx.now);
          }
          return;
        }
        case 'Update': {
          const p = msg.payload as UpdateMsg;
          const store = ks(s, p.key);
          putVersion(store, p.ver, p.value, { opId: p.opId, origin: p.origin, startedAt: p.startedAt }); // dirty (idempotent, upstream wins)
          if (tailOf(s.config) === ctx.self) {
            // The tail is the commit point. An *inherited* update (stamped under an
            // earlier, already-active epoch) commits as soon as we're ready — it was
            // safe to ingest then, so it can't be lost. A *new* update (this epoch)
            // waits until the config is active, so it can't commit before old leases
            // expire. Either way a not-ready tail commits nothing (no stale data).
            const inherited = p.ver < epochBase(s.config.epoch);
            const mayCommit = inherited ? active(ctx, s) : committable(ctx, s);
            if (mayCommit && commitAt(ctx, s, p.key, p.ver)) {
              recordCommittedWrite(ctx, s, p.key, p.ver);
              const pred = predOf(s.config, ctx.self);
              if (pred !== undefined) ctx.send(pred, 'Ack', { opId: p.opId, key: p.key, ver: p.ver } as AckMsg);
            }
          } else {
            const succ = succOf(s.config, ctx.self);
            if (succ !== undefined) ctx.send(succ, 'Update', p);
          }
          return;
        }
        case 'Ack': {
          const p = msg.payload as AckMsg;
          const advanced = commitAt(ctx, s, p.key, p.ver);
          if (headOf(s.config) === ctx.self && s.pendingWrites[p.opId]) {
            finishWriteAtHead(ctx, s, p.opId);
          } else if (advanced) {
            const pred = predOf(s.config, ctx.self);
            if (pred !== undefined) ctx.send(pred, 'Ack', p);
          }
          return;
        }
        // ---- reads (CRAQ) ----
        case 'VersionQuery': {
          const p = msg.payload as VersionQueryMsg;
          // Only a ready tail answers — a not-ready or non-tail node stays silent so
          // it can never hand back a stale committed version (the asker retries).
          if (tailOf(s.config) !== ctx.self || !active(ctx, s)) return;
          const store = ks(s, p.key);
          ctx.send(p.origin, 'VersionReply', { opId: p.opId, key: p.key, ver: store.committed, value: committedValue(store) } as VersionReplyMsg);
          return;
        }
        case 'VersionReply': {
          const p = msg.payload as VersionReplyMsg;
          finishDirtyRead(ctx, s, p.opId, p.ver, p.value);
          return;
        }
        // ---- reconfiguration ----
        case 'SyncReq': {
          // Our successor is asking to be caught up. Answer only if we're ready and
          // the requester really is our current successor.
          if (s.role !== 'replica') return;
          const p = msg.payload as SyncReqMsg;
          if (s.ready && succOf(s.config, ctx.self) === p.from) {
            ctx.send(p.from, 'Sync', { epoch: s.config.epoch, store: cloneStore(s.store) } as SyncMsg);
          }
          return;
        }
        case 'Sync': {
          // Accept a state-transfer only from our *current* predecessor, for our
          // current (or a newer) epoch — never a stale sync from an old neighbour.
          if (s.role !== 'replica') return;
          const p = msg.payload as SyncMsg;
          if (!inChain(s.config, ctx.self) || msg.from !== predOf(s.config, ctx.self) || p.epoch < s.config.epoch) return;
          applySync(ctx, s, p);
          return;
        }
        case 'FrontierReq': {
          // A new head wants our committed frontier. Report it (committed data only,
          // which is always sound) so the head can pull up anything it is missing.
          if (s.role !== 'replica') return;
          const p = msg.payload as FrontierReqMsg;
          if (p.epoch < s.config.epoch) return;
          // If we're the tail, commit our inherited backlog first so the frontier we
          // report includes writes the old tail committed before it failed.
          if (tailOf(s.config) === ctx.self) commitAllAndAck(ctx, s);
          const frontier: Record<string, { ver: number; value: string }> = {};
          for (const key of Object.keys(s.store)) {
            const st = s.store[key];
            if (st.committed > 0) frontier[key] = { ver: st.committed, value: committedValue(st) };
          }
          ctx.send(p.from, 'FrontierReply', { epoch: p.epoch, from: ctx.self, frontier } as FrontierReplyMsg);
          return;
        }
        case 'FrontierReply': {
          if (s.role !== 'replica') return;
          applyFrontierReply(ctx, s, msg.payload as FrontierReplyMsg);
          return;
        }
        case 'Beat': {
          // A currency heartbeat from upstream. Accept it only from our current
          // predecessor; refresh our chain lease; if it shows we're behind, stop
          // serving and pull a fresh sync; then pass it on down the chain.
          if (s.role !== 'replica') return;
          const p = msg.payload as BeatMsg;
          if (!inChain(s.config, ctx.self) || msg.from !== predOf(s.config, ctx.self) || p.epoch < s.config.epoch) return;
          s.chainLeaseUntil = ctx.now + cfg.chainLeaseTimeout;
          let behind = false;
          for (const key of Object.keys(p.frontier)) if (p.frontier[key] > ks(s, key).committed) behind = true;
          if (behind) {
            s.ready = false;
            const pred = predOf(s.config, ctx.self);
            if (pred !== undefined) ctx.send(pred, 'SyncReq', { epoch: s.config.epoch, from: ctx.self } as SyncReqMsg);
            s.note = 'behind the head frontier — re-syncing, not serving';
          }
          const succ = succOf(s.config, ctx.self);
          if (succ !== undefined) ctx.send(succ, 'Beat', p);
          return;
        }
      }
    },
  };
}

// Re-export the storage helper the lab/invariants reach for.
export { valueAt, latestValue, committedValue, isDirty, maxVer };
