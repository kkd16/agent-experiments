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
  raft/  paxos/  pbft/  chord/  crdt/  coedit/  gossip/  vclock/  commit/
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

### PBFT lab (Byzantine fault tolerance) — NEW
The first lab to drop the crash-fault assumption: up to **f** replicas can be *Byzantine* (silent,
two-faced, or actively lying) and a cluster of **N = 3f+1** still agrees on one total order. Three
new files (`protocols/pbft/{types,pbft,invariants}.ts`) plus a lab.
- [x] **Three-phase agreement** — `PRE-PREPARE` (the primary orders a request at a sequence number),
      `PREPARE` (backups echo their acceptance), `COMMIT` (irrevocable once 2f+1 agree); *prepared*
      (pre-prepare + 2f matching prepares) gives order **within** a view, *committed* (2f+1 commits)
      gives order **across** views. Votes are stored as `from → digest`, so out-of-order arrivals and
      Byzantine digest mismatches are both handled by simply counting matches.
- [x] **Quorum intersection** — the whole safety argument: two 2f+1 quorums share an honest replica
      that never vouches for two digests at one (view, seq), so two conflicting requests can't both
      gather a quorum. The lab makes this *visible*.
- [x] **In-order execution** to a replicated KV state machine, with a durable `executed` log.
- [x] **View change / NEW-VIEW** — when the primary is faulty, backups time out, broadcast
      `VIEW-CHANGE` with their prepared certificates, and the next primary's `NEW-VIEW` re-proposes
      the highest-view prepared request per slot (no-op for gaps) so nothing any honest replica may
      have executed is lost. Pending requests are folded into NEW-VIEW so re-establishing service is
      atomic (no pre-prepare can race ahead of the view and be dropped). An f+1 "early join" speeds up
      Byzantine-liveness, and a `newview` timer escalates if a new primary is also faulty.
- [x] **Byzantine fault modes** (toggled live per node): `silent` (a dead-looking node — a silent
      primary forces a view change), `equivocate` (a malicious primary that sends conflicting requests
      for the same sequence number — the canonical ordering attack), and `conflict` (a backup that
      votes for a corrupted digest — its votes never count). Messages are authenticated (the kernel
      stamps `from`), so a faulty node can lie about its own messages' content but never forge another
      node's — exactly PBFT's model.
- [x] **Safe state catch-up** — a lagging or restarted replica rejoins via Status/Catchup gossip:
      it adopts a decision once f+1 distinct replicas report the same (seq, digest) — at least one is
      honest, so the digest is the agreed one. No full state copy needed.
- [x] **Live safety invariants** (evaluated over the *honest* replicas — a Byzantine replica's state
      is untrustworthy by definition): **Fault budget** (faulty ≤ f, the precondition), **Agreement**
      (no two honest replicas execute different requests at one sequence number — the headline),
      **Total-order execution** (gap-free prefix; KV = prefix replayed) and **Certified execution**
      (every execution backed by a 2f+1 commit quorum *or* an f+1 catch-up certificate). Plus a
      friendly Progress line.
- [x] **PBFT lab UI** (`labs/PbftLab.tsx`) — network canvas coloured by role (primary/backup) and
      fault (Byzantine nodes glow red/orange), each node showing its view / view-change state / exec
      watermark; a one-click "Corrupt primary" button; a per-node fault-mode switch + crash/restart;
      an executed-log panel, KV view and replica inspector (per-slot phase: pre-prepared → prepared →
      committed); curated scenarios incl. **"Beyond f (unsafe!)"** that deliberately exceeds the fault
      budget so you can watch the boundary of the theorem; deep links.
- [x] **Self-tests** (10) — quorum arithmetic; healthy execution + convergence; a silent primary
      recovering via view change; an **equivocating primary that cannot break agreement**; a lying
      backup ignored; a 7-node cluster tolerating 2 simultaneous faults; a restarted replica catching
      up via gossip; **Agreement holding through 1,500 faults with an equivocating primary**;
      post-chaos convergence; and determinism (same seed ⇒ byte-identical Byzantine run).

### HotStuff lab (modern BFT consensus) — NEW
The headline complement to PBFT, and the second Byzantine lab: **HotStuff** (Yin et al., PODC 2019) —
the BFT engine behind Diem/Libra and a generation of BFT blockchains. Same fault model as PBFT (up to
**f** Byzantine of **N = 3f+1**, safety by quorum intersection) but built the *modern* way, and the
contrast is the whole point. Three new files (`protocols/hotstuff/{types,hotstuff,invariants}.ts`),
a lab (`labs/HotStuffLab.tsx`) and a bespoke chain visualiser (`ui/ChainView.tsx`).
- [x] **Block tree + quorum certificates** — agreement runs over a chain of blocks; a **QC** is the
      counted proof that 2f+1 replicas voted for a block in a view. Every block carries a `justify` QC
      for an earlier block — the object that threads the pipeline and makes communication linear.
- [x] **Rotating leaders** — `leader(view) = all[view % N]`, round-robin, so a faulty leader costs
      exactly one view (PBFT keeps a primary until suspected). Verified by a self-test.
- [x] **Linear hand-off** — votes funnel to a single leader who packs 2f+1 into one QC and disseminates
      it (O(N) per view), versus PBFT's all-to-all PREPARE/COMMIT (O(N²)). We collect at the block's
      *own* leader (Tendermint/Casper-style) rather than the *next* leader (original HotStuff): the
      original shaves a message delay but couples two consecutive views to each leader, which stalls a
      round-robin N=4 cluster under a single persistent fault — collecting-at-the-proposer keeps
      liveness with f faults at N=3f+1. (This subtlety is documented in the protocol header.)
- [x] **Pipelined 3-chain commit rule** — each block plays one phase for each of its three
      predecessors. Walk back three `justify` links from a new block b\*: b″=b\*.justify, b′=b″.justify,
      b=b′.justify; if those are linked by *direct, consecutive* parent edges, **b commits**. Two QCs
      lock the chain (safety), the third makes it irrevocable.
- [x] **The voting rule (safety crux)** — a replica votes for a block iff it is past its last-voted
      height *and* the block either extends its `lockedQC` (safety) or carries a strictly-newer QC
      (liveness). Quorum intersection then guarantees two conflicting blocks can never both be certified.
- [x] **A real pacemaker** — a view timer (armed only while work is outstanding, with exponential
      backoff) suspects a stalled leader; 2f+1 `TIMEOUT`s (each carrying the sender's highest QC) form a
      **timeout certificate** that jumps every honest replica to the next view, where the new leader
      proposes on top of the highest QC any of those 2f+1 reported — so nothing committable is lost. A
      TC also *forces* the new leader to propose (a no-op if idle) to flush laggards' chains, and a
      replica re-synchronises its view from any QC it learns (curing the timed-out-on-different-views
      deadlock that exact-quorum clusters can hit).
- [x] **Byzantine fault modes** (toggled live per node): `silent` (rotated out by the pacemaker),
      `equivocate` (a leader proposing conflicting blocks at one view — cannot break agreement, only
      burns a view) and `conflict` (a backup voting for a corrupted block hash — never counted).
- [x] **Safe catch-up** — Status/Catchup gossip ships committed block bodies; a replica adopts a height
      once f+1 distinct replicas report the same (height, hash). Restarted/lagging replicas reconverge
      without a full state copy. Durable state (block tree, the three safety variables, the KV) survives
      a crash; volatile vote/timeout collection is rebuilt.
- [x] **Live safety invariants** (over the honest replicas): **Fault budget** (≤ f), **Agreement** (no
      two honest replicas commit different blocks at one height — the headline), **Chain integrity** (a
      gap-free, parent-linked committed chain) and **State-machine safety** (KV = committed log replayed),
      plus a Progress line.
- [x] **Bespoke chain visualiser** (`ui/ChainView.tsx`) — the signature picture: the tail of the chain
      as a row of blocks linked to their parents, with the dashed gold QC "justify" arcs overlaid, each
      block tinted by how far agreement carried it (**proposed → certified → locked → committed**) and a
      "3-chain ⇒ commit" bracket over the block the rule just decided. Watching a block march through the
      four colours *is* the protocol.
- [x] **HotStuff lab UI** (`labs/HotStuffLab.tsx`) — network canvas coloured by role (leader/backup) and
      fault, the chain view, a one-click "Corrupt leader" button + per-node fault switch + crash/restart,
      a committed-log panel, KV view, replica inspector (view / locked / qcHigh / per-block phase),
      curated scenarios incl. **"Beyond f (unsafe!)"**, and deep links.
- [x] **Self-tests** (11) — quorum/leader-rotation arithmetic; healthy 3-chain commit + convergence;
      many distinct leaders committing blocks; a silent leader rotated out by the pacemaker; an
      **equivocating leader that cannot break agreement**; a lying backup ignored; a 7-node cluster
      tolerating 2 simultaneous faults; a restarted replica catching up via gossip; **Agreement holding
      through 1,500 faults with an equivocating leader**; post-chaos convergence; and determinism.
- [ ] **Original-HotStuff vote routing as a toggle** — offer the "vote to the *next* leader" variant
      side-by-side to show the latency/liveness trade-off in the same lab.
- [ ] **Pacemaker view-synchronisation animation** — draw the TC assembling and the view counter ticking
      over on the canvas, so a silent-leader rotation is watchable step by step.
- [ ] **Threshold-signature QCs** — model a (k, n) threshold signature so a QC is one O(1) object rather
      than a list of voters, the real reason HotStuff is linear in *bandwidth* too.
- [ ] **Forensics / accountability** — when faulty > f and agreement breaks, identify the ≥ f+1 replicas
      that signed two conflicting QCs (the culprit-exposure HotStuff enables).

### Dynamo lab (tunable-quorum replication) — NEW
The **AP counterpoint** to every consensus lab here, and the headline backlog item now shipped. Where
Raft/Paxos/PBFT/HotStuff buy consistency with a leader and an agreed order, Dynamo (DeCandia et al.,
SOSP 2007) keeps the store *always writeable* and reconciles divergence after the fact with vector
clocks. Built for real on the same kernel: four new files (`protocols/dynamo/{types,ring,dynamo,
invariants}.ts`) + `labs/DynamoLab.tsx`.
- [x] **Consistent-hashing ring + preference lists** (`ring.ts`) — FNV node positions with collision
      probing; a key's N owners are the nodes clockwise of its hash, so adding/removing a node moves
      only a 1/N slice.
- [x] **Vector clocks + reconciliation** (`types.ts`) — the heart of the lab: `descends` / `dominates`
      / `concurrent`, and `reconcile` that prunes causally-dominated versions to a maximal **antichain
      of siblings**. The merge is commutative, associative and idempotent (what makes anti-entropy
      converge).
- [x] **Tunable (N, R, W) quorums** — a write returns after **W** of N acks, a read gathers **R**
      replies and reconciles them. Live sliders for N/R/W and a **strong (R+W>N) vs eventual (R+W≤N)**
      consistency pill.
- [x] **Coordinator get/put with read-modify-write vs blind writes** — a read-modify-write inherits
      the causal context so it collapses existing siblings; a **blind** write ignores context so it can
      *fork* a sibling (the proliferation Dynamo warns about). Either way the coordinator's own clock
      component advances monotonically, so a node can never collide a clock with itself.
- [x] **Sloppy quorum + hinted handoff** — a ping/pong failure detector lets the coordinator route
      around unreachable owners: an absent owner's slot goes to the next healthy node clockwise, which
      stores the data as a **hint**; when the owner recovers, a handoff timer ships the hint back and
      clears it. This is the "always writeable" property — crash an owner and writes still ack.
- [x] **Read repair** — a GET that sees a stale/partial replica pushes the reconciled result back to it
      (the anti-entropy that rides on every read).
- [x] **Anti-entropy** — a background timer pushes each owned key to its co-replicas, so replicas that
      diverged during a partition reconverge even with no client reads.
- [x] **Live safety invariants** (`invariants.ts`, always green under chaos): **Causality** (every
      stored set is a clean vector-clock antichain — reconciliation never keeps a dominated version)
      and **Durability** (no write the cluster has *acknowledged* to a client is ever lost: its causal
      fingerprint is always recoverable from the live data, proved at the clock level via a per-key
      acked-frontier ≤ the held join). **Convergence** is reported separately as an *eventual* gauge —
      it dips during a partition and heals — rather than asserted under chaos.
- [x] **Dynamo lab UI** (`labs/DynamoLab.tsx`) — a ring canvas that colours each node by its role for
      the selected key (home replica / hint-holding substitute / siblings glow), a per-key **conflict
      view** listing every replica's version set with vector clocks (siblings highlighted), the latest
      PUT/GET across the cluster, an outstanding-hints metric, live N/R/W/sloppy controls, crash /
      partition / heal, and three curated scenarios: **concurrent → siblings**, **sloppy + handoff**,
      **read repair**.
- [x] **Self-tests** (12) — quorum-overlap arithmetic; vector-clock reconciliation (drops dominated,
      keeps concurrent); healthy write-read-converge; R+W>N read-your-writes; **concurrent partitioned
      writes fork siblings then a read-modify-write heals them**; **sloppy quorum + hinted handoff**
      under a dead owner; strict quorum's availability cost (with safety still held); read repair of a
      stale replica; anti-entropy convergence with no reads; a **1,200-step randomized chaos run**
      (crashes/restarts/partitions/heals + mixed puts/gets/blind writes) asserting Causality &
      Durability throughout; post-chaos convergence; and determinism (same seed ⇒ byte-identical run).
- [x] **Deep-linkable configuration** — the whole Dynamo setup (seed, node count, N, R, W, sloppy
      on/off, key) round-trips through the URL hash with a one-click "🔗 link" button, exactly like the
      Raft and Paxos labs.
- [ ] **Merkle-tree anti-entropy** — replace the push-everything sync with Dynamo's real Merkle-tree
      diff so only the keys that actually differ are exchanged.
- [ ] **Quorum-state machine view** — animate a single PUT's W-ack collection and a GET's R-reply
      reconciliation step by step on the canvas.

### Future labs / ideas (backlog)
- [x] **Dynamo-style quorums** — shipped; see the Dynamo lab section above (tunable N/R/W, sloppy
      quorums + hinted handoff, read repair, vector-clock siblings, R+W>N consistency pill).
- [ ] **PBFT checkpoints + garbage collection** — stable 2f+1-certified checkpoints to bound the log
      and give Byzantine-robust state transfer (the current catch-up is f+1-report gossip).
- [ ] **PBFT view-change attacks** — extend the Byzantine modes to forge view-change certificates,
      then add the NEW-VIEW validation that defeats them.
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
- 2026-06-26 (claude): **added a full PBFT (Practical Byzantine Fault Tolerance) lab** — the headline
  new capability and the first lab to abandon the crash-fault model: replicas can now be *Byzantine*
  (malicious). Three new files (`protocols/pbft/{types,pbft,invariants}.ts`) + `labs/PbftLab.tsx`,
  all on the existing kernel. Implemented the real protocol: the three-phase agreement
  (PRE-PREPARE → PREPARE → COMMIT) with *prepared* (pre-prepare + 2f prepares) and *committed* (2f+1
  commits) certificates; in-order execution to a replicated KV; and the **VIEW-CHANGE / NEW-VIEW**
  sub-protocol that rotates away from a faulty primary while carrying every honest replica's prepared
  certificates forward so safety is preserved. Three **Byzantine fault modes** togglable live per
  node — `silent`, `equivocate` (a primary sending conflicting orders for one sequence number — the
  canonical ordering attack) and `conflict` (a backup voting for a bogus digest) — modelled under
  PBFT's authentication assumption (the kernel stamps `from`, so a node can lie about its own
  messages but never forge another's). Four live safety invariants evaluated **over the honest
  replicas only**: Fault budget (≤ f), **Agreement** (the headline — no two honest replicas execute
  different requests at one sequence number), Total-order execution and Certified execution. Two real
  PBFT bugs found & fixed while bringing it up on a strong test harness: (1) stale per-view slots
  leaked old-view prepares into a new view (must clear unexecuted slots on view change), and (2) a
  new primary's separate PRE-PREPARE could race ahead of its NEW-VIEW and be dropped as "wrong view"
  (fold pending requests into NEW-VIEW so view re-establishment is atomic). Added a safe **f+1-report
  state catch-up** gossip so a lagging/restarted replica rejoins without a full state copy. The
  **lab UI** colours nodes by role and fault (Byzantine glow red/orange), has a one-click "Corrupt
  primary" button + per-node fault switch, an executed-log/KV/per-slot-phase inspector, and curated
  scenarios including **"Beyond f (unsafe!)"** that deliberately exceeds the budget to show the
  theorem's boundary. Self-test suite grown **42 → 52/52** (10 PBFT tests incl. an equivocating
  primary that cannot break agreement and a **1,500-step chaos run with a Byzantine primary** asserting
  Agreement throughout; stress-tested separately across 30 adversarial runs with partitions + 3% drops
  + crashes + active equivocation: **zero agreement violations**). Verified the full gate (scope +
  conformance + lint + build) and drove the built app in headless Chromium across the PBFT scenarios:
  the equivocating-primary and 7-node/2-faulty runs both stay **HOLDING**, "Beyond f" correctly flips
  the fault-budget invariant to **VIOLATED**, and the in-browser self-tests report **52/52 passing**.
- 2026-06-26 (claude): **added a full HotStuff lab** — the *modern* BFT consensus protocol (Yin et al.,
  PODC 2019; the engine behind Diem/Libra and many BFT blockchains) and the second Byzantine lab, a
  deliberate counterpoint to PBFT. Three new files (`protocols/hotstuff/{types,hotstuff,invariants}.ts`),
  a lab (`labs/HotStuffLab.tsx`) and a bespoke **chain visualiser** (`ui/ChainView.tsx`), all on the
  existing kernel. Implemented **chained/pipelined** HotStuff for real: a block tree where every block
  carries a **quorum certificate** (`justify`) for an earlier block; **round-robin rotating leaders**
  (a faulty leader costs exactly one view); **linear** vote aggregation into a single QC that the
  leader disseminates (O(N) vs PBFT's O(N²)); and the **3-chain commit rule** (a block commits the
  instant a run of three QCs with consecutive direct-parent edges forms on top of it). Safety is the
  one-line HotStuff voting rule (extend the locked QC *or* carry a strictly-newer QC) + quorum
  intersection. Built a real **pacemaker**: a backoff view timer, 2f+1 `TIMEOUT`s forming a timeout
  certificate that rotates a stalled leader, view re-synchronisation from any learned QC, and a
  forced flush-proposal on a TC so laggards' chains close. The same three Byzantine fault modes as
  PBFT, togglable live (`silent` / `equivocate` / `conflict`). Three genuine design issues found &
  fixed while bringing it up on a strong test harness: (1) **the vote-routing trap** — routing votes to
  the *next* leader (original HotStuff) couples two consecutive views to each leader, which provably
  stalls a round-robin N=4 cluster under one persistent fault (you need 3 consecutive clean views and a
  single fault poisons two); switched to collecting at the block's own leader (Tendermint/Casper-style),
  restoring liveness with f faults at N=3f+1, and documented the trade-off; (2) **a view-desync
  deadlock** — with exactly 2f+1 honest replicas, one racing ahead made them time out on *different*
  views so no 2f+1 timeout certificate could ever form; fixed by re-syncing a replica's view from any
  QC carried in a TIMEOUT; (3) **a flush stall** — a caught-up leader went idle while a follower still
  lagged, so the follower never got its deciding block; fixed by forcing the post-TC leader to propose.
  Four live safety invariants over the honest replicas (Fault budget, **Agreement**, Chain integrity,
  State-machine safety) plus Progress, and curated scenarios incl. **"Beyond f (unsafe!)"** that flips
  the boundary. Self-tests grown **52 → 63/63** (11 HotStuff tests incl. an equivocating leader that
  cannot break agreement and a **1,500-step chaos run with a Byzantine leader** asserting Agreement
  throughout). Stress-tested separately across **180 randomised chaos runs** (N=4/7/10, partitions +
  drops + crashes + up to f Byzantine of every kind): **zero safety violations**, and "beyond f"
  detected 30/30. Verified the full gate (scope + conformance + lint + build) and drove the built app
  in headless Chromium: the HotStuff lab commits blocks through the pipeline (invariants **HOLDING**),
  the equivocating-leader scenario stays **HOLDING**, "Beyond f" flips to **VIOLATED**, and the in-app
  self-tests report **63/63 passing**.
- 2026-06-27 (claude): **added a full Dynamo lab** — the headline backlog item, and the simulator's
  first deliberately-**AP** protocol: a leaderless, always-writeable key/value store that is the exact
  counterpoint to the consensus labs. Four new files (`protocols/dynamo/{types,ring,dynamo,
  invariants}.ts`) + `labs/DynamoLab.tsx`, all on the existing kernel. Implemented Dynamo for real:
  a consistent-hashing ring with N-node **preference lists**; **vector-clock** versioning with
  `reconcile` that prunes causally-dominated versions to a maximal antichain of **siblings**; tunable
  **(N, R, W)** quorums (a write returns after W of N acks, a read reconciles R replies) with a live
  **strong (R+W>N) vs eventual** consistency pill; **read-modify-write vs blind** writes (blind forks a
  sibling, RMW collapses them, and a coordinator's own clock component always advances monotonically so
  it can never collide a clock with itself); a ping/pong failure detector driving **sloppy quorums +
  hinted handoff** (an absent owner's slot goes to the next healthy node, which holds a hint and hands
  it back on recovery — the "always writeable" property); **read repair** on every GET; and background
  **anti-entropy** so partitioned replicas reconverge with no client reads. Two genuine safety
  invariants checked live and asserted under chaos: **Causality** (every stored set is a clean
  vector-clock antichain) and **Durability** (no acknowledged write is ever lost — proved at the clock
  level via a per-key acked-frontier ≤ the held join, robust across crashes since disk persists);
  **Convergence** is surfaced separately as an *eventual* gauge that dips during partitions and heals.
  One real bug found & fixed bringing it up on the test harness: the coordinator's complete-put/
  complete-get were firing unconditionally instead of only once the W/R threshold was met — so a strict
  W=3 write appeared to ack at 1 and reads didn't actually gather R replies; guarding them on the
  quorum size fixed both (and exposed read-repair, which then worked). The **lab UI** draws a ring
  coloured by per-key role (home replica / hint-holding substitute / siblings glow), a per-key
  **conflict view** listing every replica's versions with vector clocks (siblings highlighted), the
  latest PUT/GET across the cluster, live N/R/W/sloppy controls, crash/partition/heal, and three
  curated scenarios (**concurrent → siblings**, **sloppy + handoff**, **read repair**). Self-test suite
  grown **63 → 75/75** (12 Dynamo tests incl. a **1,200-step chaos run** asserting Causality &
  Durability throughout, post-chaos convergence, and a determinism check). Verified the full gate
  (scope + conformance + lint + build) and drove the built app in headless Chromium across all three
  scenarios: siblings fork and then converge (**HOLDING**), a sloppy write acks via a substitute and
  hinted handoff repairs the recovered owner, read repair fixes a stale replica, and the in-app
  self-tests report **75/75 passing** with zero runtime errors.
