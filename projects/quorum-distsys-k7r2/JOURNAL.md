# Quorum — Distributed Systems Lab · journal

A **deterministic distributed-systems simulator that runs entirely in your browser**, built
from scratch on one seeded discrete-event **simulation kernel**. No backend, no real network —
every node, message, timer, partition and clock tick is simulated in a single tab, and the
whole run is a pure function of `(seed, scenario)`, so it is perfectly reproducible and can be
**scrubbed backwards and forwards in time** like a video.

The headline is that the hard algorithms are implemented for real, not faked:

- **Raft consensus** — leader election with randomized election timeouts, log replication via
  AppendEntries, term/vote rules, commit-index advancement by majority, and the full set of
  safety invariants (election safety, log matching, leader completeness, state-machine safety)
  checked live on every step. Crash nodes, heal them, drop links, partition the cluster, fire
  client commands, and watch a correct Raft survive it.
- **CRDTs** — convergent replicated data types (G-Counter, PN-Counter, OR-Set, LWW-Register,
  RGA sequence) replicated across nodes with concurrent edits; the invariant panel proves
  *strong eventual consistency* (all reachable replicas converge once messages drain).
- **Gossip / SWIM** — epidemic dissemination and SWIM-style failure detection (ping,
  ping-req, suspicion, incarnation numbers), so you can watch rumors and death spread.
- **Vector clocks** — causal-ordering lab that classifies every pair of events as
  happened-before or concurrent, drawn as a space-time diagram.
- **2PC / 3PC** — atomic-commit protocols, including the coordinator-crash window that makes
  2PC block and how 3PC dodges it.

Everything shares the same kernel: a seeded PRNG, a priority event queue, a network model
(per-link latency, jitter, drop rate, partitions), named per-node timers with cancellation,
crash/restart, a chaos driver, and full state snapshots for time travel.

## Architecture

```
src/sim/        the protocol-agnostic kernel
  prng.ts        splitmix64 / mulberry32 deterministic RNG
  pqueue.ts      binary min-heap event queue (time, seq) ordering
  types.ts       Message, Effect, Protocol<S,Cmd>, SimState, ...
  kernel.ts      the engine: schedule, deliver, timers, crash, snapshots, replay
  network.ts     latency/jitter/drop/partition model
src/protocols/  one folder per protocol, each implementing Protocol<S,Cmd>
  raft/  crdt/  gossip/  vclock/  commit/
src/ui/         shared visual components (network canvas, timeline, panels, controls)
src/labs/       one lab screen per protocol, wired to the kernel via a React hook
src/lib/        small helpers (formatting, colors, geometry, self-test runner)
```

## Roadmap / backlog

### Kernel (foundation)
- [x] Deterministic PRNG (splitmix64 + mulberry32) with unit self-tests
- [x] Binary min-heap priority event queue
- [x] Protocol interface + simulation kernel (schedule/deliver/timers/crash)
- [x] Network model: per-link latency, jitter, drop probability, partitions
- [x] Snapshot-based time travel (step, play, rewind, scrub)
- [x] Self-test harness that asserts kernel determinism

### Raft lab
- [x] Raft node state machine (follower/candidate/leader, terms, votes)
- [x] Leader election with randomized timeouts + heartbeats
- [x] Log replication (AppendEntries, nextIndex/matchIndex, commit by majority)
- [x] Client command injection + replicated state machine (a key/value store)
- [x] Live safety invariants (election safety, log matching, leader completeness, SM safety)
- [x] Network canvas: node ring, states, terms, animated in-flight messages
- [x] Per-node inspector: log entries, term, votedFor, commit/applied index
- [x] Log compaction / snapshots (InstallSnapshot) — opt-in threshold; the leader ships a
      snapshot to a follower whose nextIndex has fallen below the compacted prefix; the snapshot
      is persistent (survives a crash and restores the state machine); a new **Snapshot
      Agreement** invariant; UI badge + inspector section + dedicated self-tests
- [x] Cluster membership changes (joint consensus) — Cold,new two-phase reconfiguration:
      add/remove voters live; during the overlap the leader requires a majority in *both* the
      old and new configurations, then commits Cnew; live **Configuration Agreement** safety
      invariant; add/remove-server self-tests including a chaos run
- [x] Pre-vote (opt-in toggle; stops a partitioned node inflating terms) — verified by self-test
- [x] Leader lease / linearizable ReadIndex reads — the leader confirms it still commands a
      majority (a heartbeat round) before answering a read, so a partitioned ex-leader can't
      serve a stale value; self-tested against a deposed leader

### CRDT lab
- [x] G-Counter, PN-Counter, OR-Set, LWW-Register, RGA sequence
- [x] Concurrent-edit playground with anti-entropy sync
- [x] Convergence (strong eventual consistency) invariant
- [x] Collaborative text demo on top of RGA — a real multi-replica live text editor: type into
      any replica, partition the cluster, edit concurrently on both sides, heal, and watch every
      replica converge to the same document character-for-character (no central server)

### Gossip / SWIM lab
- [x] Epidemic rumor spread with configurable fanout
- [x] SWIM failure detector (ping / ping-req / suspect / confirm, incarnations)

### Vector-clock lab
- [x] Vector clocks with send/receive/internal events
- [x] Happened-before / concurrent classification

### 2PC / 3PC lab
- [x] Two-phase commit with coordinator + participants
- [x] Coordinator-crash blocking window demonstration
- [x] Three-phase commit (3PC) — a pre-commit phase plus a cooperative termination protocol
      makes it non-blocking: crash the coordinator after pre-commit and participants commit
      themselves; crash it before and they abort themselves. 2PC/3PC toggle in the lab; four
      self-tests including both stall-then-crash paths, all atomic.

### Paxos lab (Multi-Paxos consensus) — NEW
The headline complement to Raft: consensus the *other* canonical way. Where Raft is leader-first
and log-first, Paxos is built bottom-up from the **Synod** (single-decree) protocol and assembled
into **Multi-Paxos** for a replicated log. Implemented for real on the same kernel, with the core
safety theorem ("at most one value is ever chosen per instance") checked live.

- [x] **Ballots** — totally-ordered, globally-unique proposal numbers `(n, nodeId)` with a clean
      compare; `null` = ⊥. This is the spine of Paxos safety.
- [x] **Acceptor** — persistent (survives crash) `minProposal` (highest promised ballot, covers all
      slots) plus per-slot `acceptedBallot` / `acceptedValue`. Promise/Accept obey the ballot rules
      exactly; a rejection carries the acceptor's `minProposal` so a proposer learns it was superseded.
- [x] **Phase 1 (Prepare/Promise)** — a node becomes a proposer by canvassing a majority with a
      ballot higher than any it has seen; each Promise carries back the acceptor's already-accepted
      values so the proposer can honour them.
- [x] **Leader recovery (the safety crux)** — on a majority of Promises the new leader, for every
      slot, **re-proposes the value accepted at the highest ballot** (and fills true gaps with a
      no-op). This is *the* mechanism that makes a value, once chosen, un-unchoosable.
- [x] **Phase 2 (Accept/Accepted)** — the leader drives a value into a slot; a majority of Accepted
      at the same ballot **chooses** it; the leader broadcasts `Chosen` so learners apply it.
- [x] **Multi-Paxos optimisation** — one successful Phase 1 makes a node the stable distinguished
      proposer for *all* future slots, so steady-state commits cost a single Accept round-trip
      (no per-command Prepare), exactly as in production Paxos.
- [x] **Replicated KV state machine** — chosen values applied in slot order (set/del/noop), with a
      contiguous `applied` watermark; learners catch up missing slots from leader heartbeats.
- [x] **Leadership via randomized election timeouts + heartbeats** — no leader heartbeat → a node
      starts Phase 1 with a higher ballot; randomized backoff dissolves the classic dueling-proposer
      livelock (and a no-backoff toggle lets you *watch* the livelock first).
- [x] **Client command routing / forwarding** — a command at a follower is forwarded to the leader;
      with no known leader the node elects itself and flushes its queue once it wins.
- [x] **Crash/restart correctness** — acceptor state is stable storage (persists); proposer/leader
      state is volatile and rebuilt by re-running Phase 1.
- [x] **Live safety invariants** — **Agreement** (no two learners ever disagree on a slot),
      **Quorum-backing** (every chosen value is still held by a majority of acceptors — proves it
      can never be overwritten), and **Validity** (only client-proposed values, or no-ops, get chosen).
- [x] **Paxos lab UI** — network canvas with per-node ballot/role; acceptor inspector (minProposal +
      per-slot accepted); the chosen log + replicated KV; propose buttons, a "force Phase 1" button,
      crash/partition controls, and the live invariant panel.
- [x] **Curated scenarios + deep links** — dueling proposers (watch ballots leapfrog), leader
      failover, partition-and-heal catch-up; the whole configuration round-trips through the URL hash.
- [x] **Self-tests** — single value chosen under contention; dueling proposers converge; majority
      partition keeps making progress while the minority cannot; partition-heal catch-up; a 1,000+
      step randomized chaos run (proposes + crashes + partitions) asserting Agreement & Quorum-backing
      hold throughout and all live nodes converge to one chosen log + KV.

### Chord DHT lab (peer-to-peer routing) — NEW
A scalable distributed hash table on one consistent-hashing ring, the classic Stoica et al. (2001)
design — implemented for real on the same kernel, with a purpose-built ring visualisation.

- [x] **Consistent-hashing ring** — nodes and keys share an m-bit id space (m=8); a key is owned by
      its successor. Ids are FNV-hashed from node names with deterministic collision probing, so every
      node agrees on the id↔name directory.
- [x] **Finger tables** — m shortcuts per node (`finger[i] = successor(id+2^i)`); `closest_preceding`
      routes a lookup in **O(log N) hops** instead of a linear ring scan.
- [x] **Recursive lookups** — a `FindSuccessor` is forwarded hop-by-hop and the answer returns straight
      to the origin, carrying the **path it travelled** (drawn as a glowing route on the ring).
- [x] **Stabilization** — the coordinator-free maintenance protocol: `stabilize` (adopt a closer
      successor + notify), `notify` (accept a closer predecessor), `fix_fingers` (refresh one finger per
      tick) and `check_predecessor` (ping; drop a dead predecessor). The lone bootstrap stabilizes
      against itself so a real cycle forms as nodes join.
- [x] **Failure handling** — a successor list (depth r) for failover; an outstanding-probe guard so the
      RPC timeout can actually fire (it must — otherwise a re-armed timeout starves failure detection);
      a crashed node's successors/predecessors are repaired and the ring re-converges with no operator.
- [x] **Ring health invariants** — Identifier uniqueness (always-on safety) plus Successor- and
      Predecessor-convergence gauges (eventual: they dip during churn and heal back to green).
- [x] **Chord ring UI** (`ui/ChordRing.tsx`, `labs/ChordLab.tsx`) — nodes placed by id, successor
      pointers as perimeter arcs, the selected node's finger table as chords across the ring, sample
      keys on the rim tinted by owner, the last lookup's hop-path highlighted; a node inspector
      (successor/predecessor/successor-list/finger table), a key-ownership table, deep links.
- [x] **Self-tests** — 7-node ring converges (every successor & predecessor correct); lookups resolve
      to the true owner for a sweep of keys; lookups stay short (≤ m hops); the ring heals after a node
      crashes (re-converges + lookups stay correct); collision-free id placement.

### Future labs / ideas (backlog)
- [ ] **Dynamo-style quorums** — tunable (N, R, W), sloppy quorums + hinted handoff, read-repair,
      and a vector-clock conflict view, with the R+W>N consistency invariant.
- [ ] **PBFT** — practical Byzantine fault tolerance (pre-prepare/prepare/commit), tolerating ⌊(n−1)/3⌋
      liars, with equivocation visualised.
- [ ] **Hybrid Logical Clocks** in the vector-clock lab — one-line causal timestamps that stay close
      to physical time.
- [ ] **EPaxos / leaderless Paxos** — dependency graphs and out-of-order commit.

### Polish
- [x] Landing page / lab switcher with hash routing
- [x] Shared control bar (seed, speed, play/step/reset, scrub)
- [x] Self-test panel surfacing kernel + protocol invariants
- [x] Keyboard shortcuts (space/step/scrub/reset)
- [x] Deep-linkable scenarios / export a run as a seed+scenario URL — the Raft lab encodes its
      full configuration (seed, size, network, toggles, snapshot threshold) into the URL hash
      and offers one-click "Copy link"; curated scenario presets set up classic situations
      (split vote, leader crash, snapshot catch-up, partition heal) in a single click

## Session log

- 2026-06-26 (claude): created the project; built the deterministic kernel (PRNG, event
  queue, network model, timers, crash/restart, snapshot time-travel), the full Raft lab
  (election + replication + KV state machine + live safety invariants + animated network
  canvas + node inspector), plus CRDT, gossip/SWIM, vector-clock and 2PC labs, the shared UI
  shell with hash routing, and a live self-test lab. The self-test suite passes 12/12 —
  including a randomized chaos run that hits Raft with 1,200 crashes/restarts/partitions and
  asserts all four safety invariants hold throughout, CRDT convergence after partition heal,
  OR-Set add-wins, 2PC atomicity + the blocking window, and exact time-travel replay. Verified
  with `node scripts/verify-project.mjs` — scope + conformance + lint + build all green.
- 2026-06-26 (claude): added Raft **pre-vote** as an opt-in toggle (a partitioned node now
  canvasses for votes before incrementing its term, so it can't disrupt a healthy leader on
  rejoin) and global keyboard shortcuts. Extended the self-test suite to 14/14, including a
  second 1,200-step chaos run with pre-vote on and a term-inflation comparison (an isolated
  node reaches term 17 without pre-vote vs term 1 with it).
- 2026-06-26 (claude): a big push to make the Raft lab genuinely deep and add a new lab.
  Implemented **three of Raft's hardest extensions**, each dormant unless used so the base
  algorithm stays byte-for-byte identical:
  • **Log compaction via snapshots + InstallSnapshot** — all log-index math is now
    snapshot-offset-aware; a leader ships its snapshot to a follower whose nextIndex has fallen
    below the compacted prefix; snapshots are persistent and rebuild the state machine across a
    crash; a new **Snapshot Agreement** invariant proves compacted prefixes never disagree.
  • **Cluster membership changes via joint consensus** (Cold,new → Cnew) — add/remove voters
    live; during the overlap the leader needs a majority in *both* configurations; a new
    **Configuration Agreement** invariant proves nodes agree on the config at every
    commonly-committed index (and tolerates propagation lag).
  • **Linearizable reads (ReadIndex)** — the leader confirms it still leads with a heartbeat
    quorum before answering, so a deposed/partitioned ex-leader can never serve a stale value.
  Built a brand-new **Collaborative text** lab: a real, server-less multi-replica editor on a
  from-scratch RGA sequence CRDT — type into any replica, partition the network, edit both
  sides concurrently, heal, and every replica converges character-for-character (each glyph is
  tinted by the replica that authored it). Wired the new Raft features into the lab UI
  (compaction control + snapshot badge/inspector, live membership add/remove with non-voters
  dimmed and a joint-config pill, a linearizable Read button), added **deep-linkable
  scenarios** (the whole Raft configuration round-trips through the URL hash, with a Copy-link
  button and curated scenario presets), and a new Configuration/Snapshot-aware invariant panel.
  Self-test suite grown 14 → **25/25**: snapshot compaction + catch-up via InstallSnapshot +
  restart-from-snapshot + deterministic chaos with compaction on; cluster grow/shrink + a
  membership change under churn; ReadIndex freshness incl. a deposed-leader stale-read check;
  and two RGA convergence tests. Verified the full gate (scope + conformance + lint + build)
  and drove the built app in a headless Chromium across all eight routes — zero runtime errors,
  membership/reads/compaction/concurrent-editing all confirmed working live.
- 2026-06-26 (claude): **added a full Multi-Paxos lab** — the headline complement to Raft, and
  consensus the *other* canonical way. Built it from the Synod up on three new files
  (`protocols/paxos/{types,paxos,invariants}.ts`): totally-ordered, globally-unique **ballots**
  `(n, node)`; an **acceptor** with stable `minProposal` + per-slot accepted state; **Phase 1**
  (Prepare/Promise) to become a proposer; the **leader-recovery rule** (re-propose the value
  accepted at the highest ballot — the crux that makes a chosen value un-unchoosable); **Phase 2**
  (Accept/Accepted → a majority *chooses*); the **Multi-Paxos** optimisation (one Phase 1 ⇒ stable
  leader for all future slots, steady-state commits in a single round-trip); a replicated KV state
  machine applied in slot order with learner catch-up over heartbeats; **leader election** by
  randomized timeout with a no-backoff toggle that lets you *watch* the dueling-proposer livelock,
  then fix it; and client forwarding. Three live safety invariants: **Agreement** (no two learners
  ever disagree on a slot), **Quorum-backing** (every chosen value is still held by a majority of
  acceptors — the live witness that it can't be overwritten) and **Replicated-log integrity**.
  New **Paxos lab UI** (`labs/PaxosLab.tsx`): network canvas coloured by role with each node's
  ballot, an acceptor inspector (minProposal + per-slot accepted), the chosen log + KV, propose /
  force-Phase-1 / silence-leader / dueling-proposers controls, curated scenarios (incl. the
  livelock preset) and deep links. Self-test suite grown **25 → 33/33**: single value chosen under
  contention; dueling proposers converge; a majority partition makes progress while the minority
  cannot; partition-heal catch-up; leader-failover value preservation; a **1,200-step randomized
  chaos run** asserting Agreement + Quorum-backing hold throughout; and a post-chaos all-nodes
  convergence check. Verified the full gate (scope + conformance + lint + build) and drove the
  built app in headless Chromium — leader election, choosing, dueling-proposer resolution and
  leader failover all confirmed working live with safety HOLDING throughout.
- 2026-06-26 (claude): **added a Chord DHT lab** — the iconic peer-to-peer routing algorithm, to
  complement the consensus labs. New files `protocols/chord/{types,ring,chord,invariants}.ts`:
  a consistent-hashing m-bit ring (FNV ids with collision probing), finger tables giving O(log N)
  lookups, recursive `FindSuccessor` routing that carries its hop-path, and the full coordinator-free
  **stabilization** protocol (stabilize / notify / fix_fingers / check_predecessor) with successor-list
  failover. Subtle bugs found & fixed along the way: the lone bootstrap must stabilize against itself
  (the (n,n) interval is the whole ring) or its successor never forms; and the RPC timeout must not be
  re-armed while a probe is outstanding (rpcTimeout > stabilizeInterval was starving successor-failure
  detection). A bespoke **ring visualisation** (`ui/ChordRing.tsx`) draws nodes by id, successor arcs,
  the selected node's finger chords, sample keys tinted by owner, and the last lookup's glowing route;
  the lab adds a node inspector, a key-ownership table and deep links. Self-tests grown **33 → 38/38**
  (5 Chord tests: convergence, correct lookups, O(log N) hops, heal-after-crash, collision-free ids).
  Verified the full gate (scope + conformance + lint + build) and drove the built app in headless
  Chromium — the ring converges (health HOLDING), a key lookup routes and resolves, and after crashing
  a node the ring re-converges back to HOLDING with lookups still correct.
