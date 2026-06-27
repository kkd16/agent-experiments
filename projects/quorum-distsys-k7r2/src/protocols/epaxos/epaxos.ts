// EPaxos (Egalitarian Paxos) — leaderless consensus.
//
// Raft and Multi-Paxos funnel every command through one elected leader. EPaxos
// throws the leader away: *any* replica commits a command directly into its own
// slice of a shared instance space. The trick is that it does not impose a total
// order — it records, per command, the set of already-seen **interfering**
// commands as a dependency set, and a sequence number for tie-breaking. Every
// replica then linearises the same dependency graph identically by computing its
// strongly-connected components. Non-interfering commands never wait on each
// other, so in the common case a command commits in **one round-trip to a fast
// quorum** with no leader in the path at all.
//
// ── The two commit paths ───────────────────────────────────────────────────
//   • PreAccept (Phase 1): the command leader L picks instance L.i, attaches the
//     deps/seq it computes locally, and asks a **fast quorum**. Each replica
//     folds in *its own* interfering commands and replies with the (possibly
//     enlarged) deps/seq.
//       – If every fast-quorum reply is **identical** to what L proposed, the
//         deps are final and L commits on the **fast path** — no second round.
//       – Otherwise L unions all the replies and runs an explicit **Accept**
//         (Phase 2, the classic Paxos round) over a simple majority — the
//         **slow path** — then commits.
//   • Commit is broadcast to everyone so every replica can execute.
//
// ── Why it is safe, and the one design choice that keeps recovery simple ────
// Each instance is a single-decree Paxos register with its own **ballot**, so a
// crashed command leader's instance is finished by any replica via explicit
// **Prepare** (recovery). The subtle part of EPaxos is making fast-path commits
// recoverable. We adopt the clean, provably-safe rule used by teaching
// implementations: a replica sends its **default-ballot** PreAccept to *exactly*
// one fast quorum. Then a default-ballot record can only exist on fast-quorum
// members, and if a value committed on the fast path every recovery quorum
// (a majority) intersects that fast quorum, so the recoverer always sees enough
// identical default-ballot PreAccept records (`⌊(F+1)/2⌋` of them, by quorum
// intersection) to reconstruct the committed value. This is the faithful EPaxos
// recovery condition; the original all-to-all variant needs an extra tie-break
// (see JOURNAL backlog).
import type { NodeContext, Message, Protocol } from '../../sim/types';
import {
  cmdInterferes,
  cmdStr,
  normDeps,
  depsEq,
  unionDeps,
  instKey,
  ownerOf,
  indexOf,
  cmpBallot,
  ballotEq,
  ballotStr,
  defaultBallot,
  isDefaultBallot,
  STATUS_RANK,
  slowQuorum,
  DEFAULT_EPAXOS_CONFIG,
  type Command,
  type Ballot,
  type Deps,
  type Instance,
  type Status,
  type EPaxosState,
  type EPaxosConfig,
  type EPaxosCmd,
  type PreAcceptMsg,
  type PreAcceptOkMsg,
  type AcceptMsg,
  type AcceptOkMsg,
  type CommitMsg,
  type PrepareMsg,
  type PrepareOkMsg,
  type SyncMsg,
} from './types';

const rank = (s: Status) => STATUS_RANK[s];
const maxBallot = (a: Ballot, b: Ballot): Ballot => (cmpBallot(a, b) >= 0 ? a : b);
const committedRank = STATUS_RANK.committed;

export function createEPaxos(config: EPaxosConfig = DEFAULT_EPAXOS_CONFIG): Protocol<EPaxosState, EPaxosCmd> {
  // ---- instance helpers --------------------------------------------------

  /** Materialise an instance record, defaulting to a value-less placeholder. */
  function ensureInst(s: EPaxosState, key: string): Instance {
    let inst = s.inst[key];
    if (!inst) {
      const owner = ownerOf(key);
      inst = {
        owner,
        index: indexOf(key),
        cmd: null,
        deps: [],
        seq: 0,
        status: 'preaccepted',
        ballot: defaultBallot(owner),
        // b < 0 marks "never (pre)accepted a value" — used by recovery.
        acceptedBallot: { b: -1, node: owner },
      };
      s.inst[key] = inst;
    }
    return inst;
  }

  const hasValue = (inst: Instance) => inst.cmd !== null && inst.acceptedBallot.b >= 0;

  /**
   * Compute the dependencies and sequence number for `cmd` from everything this
   * replica currently knows: every known instance carrying an interfering
   * command becomes a dependency, and seq is one past the largest among them.
   */
  function localDepsSeq(s: EPaxosState, cmd: Command, excludeKey: string): { deps: Deps; seq: number } {
    const deps: string[] = [];
    let maxSeq = 0;
    for (const k of Object.keys(s.inst)) {
      if (k === excludeKey) continue;
      const inst = s.inst[k];
      if (!inst.cmd || inst.cmd.op === 'noop') continue;
      if (cmdInterferes(cmd, inst.cmd)) {
        deps.push(k);
        if (inst.seq > maxSeq) maxSeq = inst.seq;
      }
    }
    return { deps: normDeps(deps), seq: maxSeq + 1 };
  }

  // ---- Phase 1: propose a command into our own instance ------------------

  function propose(ctx: NodeContext, s: EPaxosState, cmd: Command): void {
    const index = s.nextIndex++;
    const key = instKey(ctx.self, index);
    const { deps, seq } = localDepsSeq(s, cmd, key);
    const ballot = defaultBallot(ctx.self);
    s.inst[key] = { owner: ctx.self, index, cmd, deps, seq, status: 'preaccepted', ballot, acceptedBallot: ballot };
    s.lead[key] = { phase: 'preaccept', recovery: false, ballot, cmd, deps, seq, fast: [...ctx.all], pa: { [ctx.self]: { deps, seq } }, acc: {} };
    ctx.log('state', `PreAccept ${cmdStr(cmd)} → ${key} (deps ${deps.length}, seq ${seq})`);
    ctx.broadcast('PreAccept', () => ({ key, owner: ctx.self, index, ballot, cmd, deps, seq } as PreAcceptMsg));
    ctx.setTimer('fast:' + key, config.fastTimeout);
    s.note = `proposing ${cmdStr(cmd)} @ ${key}`;
    maybePhase1(ctx, s, key);
  }

  /** Acceptor side of PreAccept: fold in our own conflicts, persist, reply. */
  function onPreAccept(ctx: NodeContext, s: EPaxosState, p: PreAcceptMsg, from: string): void {
    const inst = ensureInst(s, p.key);
    if (cmpBallot(p.ballot, inst.ballot) < 0) {
      ctx.send(from, 'PreAcceptOk', { key: p.key, ballot: p.ballot, ok: false, promised: inst.ballot, deps: [], seq: 0, from: ctx.self } as PreAcceptOkMsg);
      return;
    }
    inst.ballot = maxBallot(inst.ballot, p.ballot);
    // Already locked at >= this ballot with a value: don't downgrade; echo it.
    if (rank(inst.status) >= STATUS_RANK.accepted && hasValue(inst)) {
      ctx.send(from, 'PreAcceptOk', { key: p.key, ballot: p.ballot, ok: true, promised: inst.ballot, deps: inst.deps, seq: inst.seq, from: ctx.self } as PreAcceptOkMsg);
      return;
    }
    const local = localDepsSeq(s, p.cmd, p.key);
    const deps = unionDeps(p.deps, local.deps);
    const seq = Math.max(p.seq, local.seq);
    inst.cmd = p.cmd;
    inst.deps = deps;
    inst.seq = seq;
    inst.status = 'preaccepted';
    inst.acceptedBallot = p.ballot;
    ctx.send(from, 'PreAcceptOk', { key: p.key, ballot: p.ballot, ok: true, promised: inst.ballot, deps, seq, from: ctx.self } as PreAcceptOkMsg);
  }

  function onPreAcceptOk(ctx: NodeContext, s: EPaxosState, p: PreAcceptOkMsg): void {
    const L = s.lead[p.key];
    if (!L || L.phase !== 'preaccept' || !ballotEq(p.ballot, L.ballot)) return;
    if (!p.ok) {
      // Superseded by a higher ballot (a recovery is underway): stand down.
      delete s.lead[p.key];
      ctx.clearTimer('fast:' + p.key);
      s.note = `PreAccept ${p.key} superseded by ${ballotStr(p.promised)}`;
      return;
    }
    L.pa[p.from] = { deps: p.deps, seq: p.seq };
    if (L.recovery) {
      // Recovery never fast-commits: once a majority has folded in its conflicts,
      // proceed straight to the Accept round with the union.
      if (Object.keys(L.pa).length >= slowQuorum(ctx.all.length)) goSlow(ctx, s, p.key);
    } else {
      maybePhase1(ctx, s, p.key);
    }
  }

  /**
   * Decide the fate of a Phase-1 (PreAccept) round.
   *
   * Fast path is **unanimous**: only if *every* replica replies with deps/seq
   * identical to what the leader proposed does the command commit in one round.
   * The moment any replica reports a different (enlarged) dep set — or once a
   * majority has answered and a conflict is already visible — the leader unions
   * the replies and takes the explicit Accept (slow) path. Either way the deps it
   * commits were folded over a set of replicas of size ≥ a majority, so they
   * intersect the quorum of any other interfering command — which is exactly what
   * guarantees the dependency graph captures every conflict (and hence that every
   * replica executes interfering commands in the same order).
   */
  function maybePhase1(ctx: NodeContext, s: EPaxosState, key: string): void {
    const L = s.lead[key];
    if (!L || L.phase !== 'preaccept') return;
    const N = ctx.all.length;
    const replied = Object.keys(L.pa);
    const identicalTo = (from: string) => depsEq(L.pa[from].deps, L.deps) && L.pa[from].seq === L.seq;
    const allAgree = replied.every(identicalTo);

    if (replied.length === N && allAgree) {
      ctx.clearTimer('fast:' + key);
      s.fastCommits++;
      ctx.log('commit', `${key} committed on the FAST path (${cmdStr(L.cmd)})`);
      commitInstance(ctx, s, key, L.cmd, L.deps, L.seq);
      delete s.lead[key];
      return;
    }
    // A disagreement is already known and we hold a majority of replies: no point
    // waiting for unanimity that won't come — go slow now over what we have.
    if (replied.length >= slowQuorum(N) && !allAgree) goSlow(ctx, s, key);
  }

  // ---- Phase 2: explicit Accept (slow path) ------------------------------

  function goSlow(ctx: NodeContext, s: EPaxosState, key: string): void {
    const L = s.lead[key];
    if (!L || L.phase !== 'preaccept') return;
    ctx.clearTimer('fast:' + key);
    let deps = L.deps;
    let seq = L.seq;
    for (const m of Object.keys(L.pa)) {
      deps = unionDeps(deps, L.pa[m].deps);
      seq = Math.max(seq, L.pa[m].seq);
    }
    L.phase = 'accept';
    L.deps = deps;
    L.seq = seq;
    L.acc = { [ctx.self]: true };
    recordAccepted(s, key, L.ballot, L.cmd, deps, seq);
    ctx.log('state', `Accept ${cmdStr(L.cmd)} → ${key} (slow path, deps ${deps.length}, seq ${seq})`);
    ctx.broadcast('Accept', () => ({ key, owner: ownerOf(key), index: indexOf(key), ballot: L.ballot, cmd: L.cmd, deps, seq } as AcceptMsg));
    maybeSlowDecision(ctx, s, key);
  }

  function recordAccepted(s: EPaxosState, key: string, ballot: Ballot, cmd: Command, deps: Deps, seq: number): void {
    const inst = ensureInst(s, key);
    inst.ballot = maxBallot(inst.ballot, ballot);
    if (rank(inst.status) < committedRank) {
      inst.cmd = cmd;
      inst.deps = deps;
      inst.seq = seq;
      inst.status = 'accepted';
      inst.acceptedBallot = ballot;
    }
  }

  function onAccept(ctx: NodeContext, s: EPaxosState, a: AcceptMsg, from: string): void {
    const inst = ensureInst(s, a.key);
    if (cmpBallot(a.ballot, inst.ballot) < 0) {
      ctx.send(from, 'AcceptOk', { key: a.key, ballot: a.ballot, ok: false, promised: inst.ballot, from: ctx.self } as AcceptOkMsg);
      return;
    }
    recordAccepted(s, a.key, a.ballot, a.cmd, a.deps, a.seq);
    ctx.send(from, 'AcceptOk', { key: a.key, ballot: a.ballot, ok: true, promised: inst.ballot, from: ctx.self } as AcceptOkMsg);
  }

  function onAcceptOk(ctx: NodeContext, s: EPaxosState, a: AcceptOkMsg): void {
    const L = s.lead[a.key];
    if (!L || L.phase !== 'accept' || !ballotEq(a.ballot, L.ballot)) return;
    if (!a.ok) {
      delete s.lead[a.key];
      s.note = `Accept ${a.key} superseded by ${ballotStr(a.promised)}`;
      return;
    }
    L.acc[a.from] = true;
    maybeSlowDecision(ctx, s, a.key);
  }

  function maybeSlowDecision(ctx: NodeContext, s: EPaxosState, key: string): void {
    const L = s.lead[key];
    if (!L || L.phase !== 'accept') return;
    if (Object.keys(L.acc).length < slowQuorum(ctx.all.length)) return;
    if (isDefaultBallot(L.ballot)) s.slowCommits++;
    ctx.log('commit', `${key} committed on the SLOW path (${cmdStr(L.cmd)})`);
    commitInstance(ctx, s, key, L.cmd, L.deps, L.seq);
    delete s.lead[key];
  }

  // ---- Commit + execution ------------------------------------------------

  function commitInstance(ctx: NodeContext, s: EPaxosState, key: string, cmd: Command, deps: Deps, seq: number): void {
    const inst = ensureInst(s, key);
    if (rank(inst.status) < committedRank) {
      inst.cmd = cmd;
      inst.deps = deps;
      inst.seq = seq;
      inst.status = 'committed';
    }
    delete s.recover[key];
    delete s.recoverArmed[key];
    ctx.broadcast('Commit', () => ({ key, owner: ownerOf(key), index: indexOf(key), cmd, deps, seq } as CommitMsg));
    executeAll(s);
    armRecoveries(ctx, s);
  }

  function onCommit(ctx: NodeContext, s: EPaxosState, c: CommitMsg): void {
    const inst = ensureInst(s, c.key);
    if (rank(inst.status) < committedRank) {
      inst.cmd = c.cmd;
      inst.deps = c.deps;
      inst.seq = c.seq;
      inst.status = 'committed';
      delete s.lead[c.key];
      delete s.recover[c.key];
      delete s.recoverArmed[c.key];
      ctx.clearTimer('fast:' + c.key);
    }
    executeAll(s);
    armRecoveries(ctx, s);
  }

  /** Is every transitive dependency of `key` committed (and known) here? */
  function blockingDep(s: EPaxosState, key: string, seen: Set<string>): string | null {
    seen.add(key);
    const inst = s.inst[key];
    if (!inst) return key;
    for (const d of inst.deps) {
      const di = s.inst[d];
      if (!di || rank(di.status) < committedRank) return d;
      if (!seen.has(d)) {
        const r = blockingDep(s, d, seen);
        if (r) return r;
      }
    }
    return null;
  }

  function applyExec(s: EPaxosState, key: string): void {
    if (s.executed[key]) return;
    const inst = s.inst[key];
    s.executed[key] = true;
    s.executedOrder.push(key);
    inst.status = 'executed';
    const c = inst.cmd;
    if (c && c.op === 'set') s.kv[c.key] = c.value;
    else if (c && c.op === 'del') delete s.kv[c.key];
  }

  /**
   * Execute every instance whose entire dependency closure is committed, in the
   * canonical EPaxos order: Tarjan SCCs in reverse-topological order, ties within
   * an SCC broken by (seq, instance-id). Because every replica commits the same
   * (cmd, deps, seq) for every instance, every replica builds the same graph and
   * therefore executes interfering commands in the same relative order.
   */
  function executeAll(s: EPaxosState): void {
    let changed = true;
    while (changed) {
      changed = false;
      const roots = Object.keys(s.inst)
        .filter((k) => rank(s.inst[k].status) === committedRank && !s.executed[k])
        .sort();
      for (const root of roots) {
        if (s.executed[root]) continue;
        if (blockingDep(s, root, new Set()) !== null) continue; // not ready
        executeFrom(s, root);
        changed = true;
        break;
      }
    }
  }

  function executeFrom(s: EPaxosState, root: string): void {
    let counter = 0;
    const idx: Record<string, number> = {};
    const low: Record<string, number> = {};
    const onStack: Record<string, boolean> = {};
    const stack: string[] = [];

    const strongConnect = (v: string): void => {
      idx[v] = low[v] = counter++;
      stack.push(v);
      onStack[v] = true;
      const inst = s.inst[v];
      for (const w of inst.deps) {
        if (s.executed[w]) continue; // already applied — a resolved leaf
        if (idx[w] === undefined) {
          strongConnect(w);
          low[v] = Math.min(low[v], low[w]);
        } else if (onStack[w]) {
          low[v] = Math.min(low[v], idx[w]);
        }
      }
      if (low[v] === idx[v]) {
        const scc: string[] = [];
        for (;;) {
          const w = stack.pop()!;
          onStack[w] = false;
          scc.push(w);
          if (w === v) break;
        }
        scc.sort((a, b) => {
          const sa = s.inst[a].seq;
          const sb = s.inst[b].seq;
          if (sa !== sb) return sa - sb;
          return a < b ? -1 : a > b ? 1 : 0;
        });
        for (const m of scc) applyExec(s, m);
      }
    };

    strongConnect(root);
  }

  // ---- Recovery (explicit Prepare) ---------------------------------------

  /** Arm a recovery timer for any committed instance blocked on an unknown/uncommitted dep. */
  function armRecoveries(ctx: NodeContext, s: EPaxosState): void {
    for (const k of Object.keys(s.inst)) {
      if (rank(s.inst[k].status) !== committedRank) continue;
      if (s.executed[k]) continue;
      const dep = blockingDep(s, k, new Set());
      if (dep && !s.recover[dep] && !s.lead[dep] && !s.recoverArmed[dep]) {
        s.recoverArmed[dep] = true;
        ctx.setTimer('recover:' + dep, config.recoverTimeout);
      }
    }
  }

  // ---- Anti-entropy catch-up (liveness, not safety) ----------------------

  /** The highest contiguous committed index per owner — our catch-up watermark. */
  function watermarks(s: EPaxosState, owners: string[]): Record<string, number> {
    const w: Record<string, number> = {};
    for (const o of owners) {
      let i = 1;
      while (s.inst[instKey(o, i)] && rank(s.inst[instKey(o, i)].status) >= committedRank) i++;
      w[o] = i - 1;
    }
    return w;
  }

  /**
   * Once per tick: (1) recover any *gap* — an uncommitted instance sitting below a
   * committed one — so watermarks can advance, and (2) ask one peer for committed
   * instances we're missing above our watermarks. Together these let a replica that
   * was crashed or partitioned for a long time rejoin and reconverge, with no leader
   * to stream the log from. Pure liveness — it touches nothing the invariants rest on.
   */
  function catchUp(ctx: NodeContext, s: EPaxosState): void {
    const maxComm: Record<string, number> = {};
    for (const k of Object.keys(s.inst)) {
      const it = s.inst[k];
      if (rank(it.status) >= committedRank) maxComm[it.owner] = Math.max(maxComm[it.owner] ?? 0, it.index);
    }
    for (const o of ctx.all) {
      const hi = maxComm[o] ?? 0;
      for (let i = 1; i < hi; i++) {
        const key = instKey(o, i);
        const it = s.inst[key];
        if ((!it || rank(it.status) < committedRank) && !s.recover[key] && !s.lead[key] && !s.recoverArmed[key]) {
          s.recoverArmed[key] = true;
          ctx.setTimer('recover:' + key, config.recoverTimeout);
        }
      }
    }
    if (ctx.peers.length > 0) {
      const peer = ctx.peers[ctx.rng.int(0, ctx.peers.length - 1)];
      ctx.send(peer, 'Sync', { have: watermarks(s, ctx.all) } as SyncMsg);
    }
  }

  /** Reply to a Sync by shipping every committed instance the peer lacks. */
  function onSync(ctx: NodeContext, s: EPaxosState, msg: SyncMsg, from: string): void {
    for (const k of Object.keys(s.inst)) {
      const it = s.inst[k];
      if (rank(it.status) < committedRank) continue;
      const lo = msg.have[it.owner] ?? 0;
      if (it.index > lo) {
        ctx.send(from, 'Commit', { key: k, owner: it.owner, index: it.index, cmd: it.cmd, deps: it.deps, seq: it.seq } as CommitMsg);
      }
    }
  }

  function startRecovery(ctx: NodeContext, s: EPaxosState, key: string): void {
    const inst = s.inst[key];
    if (inst && rank(inst.status) >= committedRank) return; // already done
    delete s.lead[key]; // a fresh, higher-ballot recovery supersedes any stalled drive
    // Bump above the highest ballot we've seen for this instance, including any
    // earlier recovery attempt of our own that stalled (lost messages) — so the
    // retry strictly supersedes it.
    const base = Math.max(inst ? inst.ballot.b : 0, s.recover[key] ? s.recover[key].ballot.b : 0);
    const ballot: Ballot = { b: base + 1, node: ctx.self };
    const me = ensureInst(s, key);
    me.ballot = maxBallot(me.ballot, ballot);
    const selfReply: PrepareOkMsg['rec'] = hasValue(me)
      ? { cmd: me.cmd, deps: me.deps, seq: me.seq, status: me.status, acceptedBallot: me.acceptedBallot }
      : null;
    s.recover[key] = { ballot, replies: { [ctx.self]: { from: ctx.self, cmd: selfReply?.cmd ?? null, deps: selfReply?.deps ?? [], seq: selfReply?.seq ?? 0, status: selfReply?.status ?? 'preaccepted', acceptedBallot: selfReply?.acceptedBallot ?? { b: -1, node: ownerOf(key) } } }, decided: false };
    ctx.log('state', `recover ${key} — Prepare ${ballotStr(ballot)}`);
    s.note = `recovering ${key}`;
    ctx.broadcast('Prepare', () => ({ key, owner: ownerOf(key), index: indexOf(key), ballot, from: ctx.self } as PrepareMsg));
    // Arm a single retry timer (the recoverArmed guard stops the tick re-arming and
    // starving it). If this attempt stalls — its Prepares or replies were lost — the
    // timer fires and we re-Prepare at a yet-higher ballot until the instance commits.
    s.recoverArmed[key] = true;
    ctx.setTimer('recover:' + key, config.recoverTimeout);
    maybeDecideRecovery(ctx, s, key);
  }

  function onPrepare(ctx: NodeContext, s: EPaxosState, p: PrepareMsg, from: string): void {
    const inst = ensureInst(s, p.key);
    if (cmpBallot(p.ballot, inst.ballot) < 0) {
      ctx.send(from, 'PrepareOk', { key: p.key, ballot: p.ballot, ok: false, promised: inst.ballot, rec: null, from: ctx.self } as PrepareOkMsg);
      return;
    }
    inst.ballot = maxBallot(inst.ballot, p.ballot);
    const rec = hasValue(inst)
      ? { cmd: inst.cmd, deps: inst.deps, seq: inst.seq, status: inst.status, acceptedBallot: inst.acceptedBallot }
      : null;
    ctx.send(from, 'PrepareOk', { key: p.key, ballot: p.ballot, ok: true, promised: inst.ballot, rec, from: ctx.self } as PrepareOkMsg);
  }

  function onPrepareOk(ctx: NodeContext, s: EPaxosState, p: PrepareOkMsg): void {
    const R = s.recover[p.key];
    if (!R || R.decided || !ballotEq(p.ballot, R.ballot)) return;
    if (!p.ok) {
      R.decided = true;
      delete s.recover[p.key];
      s.note = `recovery of ${p.key} superseded by ${ballotStr(p.promised)}`;
      return;
    }
    R.replies[p.from] = {
      from: p.from,
      cmd: p.rec?.cmd ?? null,
      deps: p.rec?.deps ?? [],
      seq: p.rec?.seq ?? 0,
      status: p.rec?.status ?? 'preaccepted',
      acceptedBallot: p.rec?.acceptedBallot ?? { b: -1, node: ownerOf(p.key) },
    };
    maybeDecideRecovery(ctx, s, p.key);
  }

  function maybeDecideRecovery(ctx: NodeContext, s: EPaxosState, key: string): void {
    const R = s.recover[key];
    if (!R || R.decided) return;
    const replies = Object.values(R.replies);
    if (replies.length < slowQuorum(ctx.all.length)) return;
    R.decided = true;
    delete s.recover[key];

    const valued = replies.filter((r) => r.acceptedBallot.b >= 0 && r.cmd !== null);

    // 1. A committed value already exists somewhere — adopt it verbatim.
    const done = valued.find((r) => rank(r.status) >= committedRank);
    if (done) {
      ctx.log('commit', `recovered ${key}: already committed (${cmdStr(done.cmd)})`);
      commitInstance(ctx, s, key, done.cmd!, done.deps, done.seq);
      return;
    }

    if (valued.length === 0) {
      // 4. Nobody ever (pre)accepted anything — fill the slot with a no-op.
      ctx.log('state', `recovered ${key}: no record anywhere → no-op`);
      recoverAccept(ctx, s, key, R.ballot, { op: 'noop' }, [], 0);
      return;
    }

    // 2. An Accept got through somewhere — re-drive the highest-ballot Accepted value.
    let topBallot = valued[0].acceptedBallot;
    for (const r of valued) if (cmpBallot(r.acceptedBallot, topBallot) > 0) topBallot = r.acceptedBallot;
    const atTop = valued.filter((r) => cmpBallot(r.acceptedBallot, topBallot) === 0);
    const accepted = atTop.find((r) => r.status === 'accepted');
    if (accepted) {
      ctx.log('state', `recovered ${key}: re-driving Accepted value (${cmdStr(accepted.cmd)})`);
      recoverAccept(ctx, s, key, R.ballot, accepted.cmd!, accepted.deps, accepted.seq);
      return;
    }

    // 3. Only PreAccepted records. If a whole **majority** of our replies hold an
    //    identical default-ballot (cmd, deps, seq), that value's deps were folded
    //    over a majority of replicas (each replica folds its own conflicts before
    //    PreAccept-ing). A majority intersects every other committed command's
    //    quorum, so those deps already capture every conflict — it is safe to
    //    preserve the value verbatim (and it also covers the case where the value
    //    actually committed on the unanimous fast path).
    const threshold = slowQuorum(ctx.all.length);
    const defaults = valued.filter((r) => isDefaultBallot(r.acceptedBallot));
    const groups = new Map<string, { rec: typeof defaults[number]; count: number }>();
    for (const r of defaults) {
      const sig = `${cmdStr(r.cmd)}|${r.seq}|${r.deps.join(',')}`;
      const g = groups.get(sig);
      if (g) g.count++;
      else groups.set(sig, { rec: r, count: 1 });
    }
    for (const g of groups.values()) {
      if (g.count >= threshold) {
        ctx.log('state', `recovered ${key}: a majority hold an identical PreAccept → re-Accept verbatim`);
        recoverAccept(ctx, s, key, R.ballot, g.rec.cmd!, g.rec.deps, g.rec.seq);
        return;
      }
    }

    // No safe fast-path evidence: nothing was chosen, so re-run consensus from the
    // recovered command. We must re-run a full **PreAccept** (conflict-folding)
    // round, not just compute deps locally: a majority of replies is guaranteed to
    // intersect the quorum of any *other* interfering command that has committed,
    // so that command lands in this one's deps. (Computing deps only at the
    // recoverer would miss a conflict it never heard of — and silently break the
    // dependency property, hence execution order, under failures.)
    const cmd = valued[0].cmd!;
    ctx.log('state', `recovered ${key}: re-running PreAccept for ${cmdStr(cmd)}`);
    recoverPreAccept(ctx, s, key, R.ballot, cmd);
  }

  /** Re-run Phase 1 (PreAccept) at the recovery ballot over a majority, folding in
   *  every replica's conflicts, then Accept the union — the safe recovery default. */
  function recoverPreAccept(ctx: NodeContext, s: EPaxosState, key: string, ballot: Ballot, cmd: Command): void {
    const { deps, seq } = localDepsSeq(s, cmd, key);
    const inst = ensureInst(s, key);
    inst.ballot = maxBallot(inst.ballot, ballot);
    if (rank(inst.status) < committedRank) {
      inst.cmd = cmd;
      inst.deps = deps;
      inst.seq = seq;
      inst.status = 'preaccepted';
      inst.acceptedBallot = ballot;
    }
    s.lead[key] = { phase: 'preaccept', recovery: true, ballot, cmd, deps, seq, fast: [...ctx.all], pa: { [ctx.self]: { deps, seq } }, acc: {} };
    ctx.broadcast('PreAccept', () => ({ key, owner: ownerOf(key), index: indexOf(key), ballot, cmd, deps, seq } as PreAcceptMsg));
    ctx.setTimer('fast:' + key, config.fastTimeout);
    if (Object.keys(s.lead[key].pa).length >= slowQuorum(ctx.all.length)) goSlow(ctx, s, key);
  }

  /** Drive a recovered (cmd, deps, seq) through an Accept round at the recovery ballot. */
  function recoverAccept(ctx: NodeContext, s: EPaxosState, key: string, ballot: Ballot, cmd: Command, deps: Deps, seq: number): void {
    recordAccepted(s, key, ballot, cmd, deps, seq);
    s.lead[key] = { phase: 'accept', recovery: true, ballot, cmd, deps, seq, fast: [], pa: {}, acc: { [ctx.self]: true } };
    ctx.broadcast('Accept', () => ({ key, owner: ownerOf(key), index: indexOf(key), ballot, cmd, deps, seq } as AcceptMsg));
    maybeSlowDecision(ctx, s, key);
  }

  // ---- protocol object ---------------------------------------------------

  return {
    name: 'EPaxos',

    init(ctx) {
      const s: EPaxosState = {
        self: ctx.self,
        inst: {},
        nextIndex: 1,
        executedOrder: [],
        executed: {},
        kv: {},
        lead: {},
        recover: {},
        recoverArmed: {},
        pending: [],
        note: 'idle',
        fastCommits: 0,
        slowCommits: 0,
      };
      ctx.setTimer('tick', config.tick);
      return s;
    },

    onRestart(ctx, s) {
      // Instance records (the acceptor's stable storage) survive a crash; the
      // volatile command-leader / recovery bookkeeping is rebuilt by re-driving.
      s.lead = {};
      s.recover = {};
      s.recoverArmed = {};
      s.pending = [];
      s.note = 'restarted (instances intact)';
      ctx.setTimer('tick', config.tick);
      executeAll(s);
    },

    onTimer(ctx, s, name) {
      if (name === 'tick') {
        ctx.setTimer('tick', config.tick);
        const queued = s.pending;
        s.pending = [];
        for (const c of queued) propose(ctx, s, c);
        executeAll(s);
        armRecoveries(ctx, s);
        catchUp(ctx, s);
        return;
      }
      if (name.startsWith('fast:')) {
        const key = name.slice(5);
        const L = s.lead[key];
        if (!L || L.phase !== 'preaccept') return;
        if (Object.keys(L.pa).length >= slowQuorum(ctx.all.length)) {
          // Have a majority of replies but never reached unanimity — commit slow.
          goSlow(ctx, s, key);
        } else {
          // Couldn't even gather a majority (peers down / messages lost): escalate
          // to recovery at a higher ballot, which re-drives over a fresh majority.
          delete s.lead[key];
          startRecovery(ctx, s, key);
        }
        return;
      }
      if (name.startsWith('recover:')) {
        const key = name.slice(8);
        delete s.recoverArmed[key];
        const inst = s.inst[key];
        if (inst && rank(inst.status) >= committedRank) return;
        startRecovery(ctx, s, key);
        return;
      }
    },

    onCommand(ctx, s, cmd) {
      if (cmd.type === 'recover') {
        startRecovery(ctx, s, cmd.key);
        return;
      }
      // propose: only the addressed node leads it (egalitarian — any node can).
      propose(ctx, s, cmd.cmd);
    },

    onMessage(ctx, s, msg: Message) {
      switch (msg.type) {
        case 'PreAccept':
          onPreAccept(ctx, s, msg.payload as PreAcceptMsg, msg.from);
          return;
        case 'PreAcceptOk':
          onPreAcceptOk(ctx, s, msg.payload as PreAcceptOkMsg);
          return;
        case 'Accept':
          onAccept(ctx, s, msg.payload as AcceptMsg, msg.from);
          return;
        case 'AcceptOk':
          onAcceptOk(ctx, s, msg.payload as AcceptOkMsg);
          return;
        case 'Commit':
          onCommit(ctx, s, msg.payload as CommitMsg);
          return;
        case 'Prepare':
          onPrepare(ctx, s, msg.payload as PrepareMsg, msg.from);
          return;
        case 'PrepareOk':
          onPrepareOk(ctx, s, msg.payload as PrepareOkMsg);
          return;
        case 'Sync':
          onSync(ctx, s, msg.payload as SyncMsg, msg.from);
          return;
      }
    },
  };
}
