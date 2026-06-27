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
  raft/  paxos/  epaxos/  pbft/  hotstuff/  chord/  dynamo/  crdt/  coedit/  gossip/  vclock/  commit/
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

### EPaxos lab (leaderless consensus) — NEW
The headline complement to Raft and Paxos: consensus with **no leader at all**. Where Raft and
Multi-Paxos funnel every command through one elected leader and a single totally-ordered log,
**EPaxos** (Moraru, Andersen & Kaminsky, SOSP 2013) lets *any* replica commit its own commands
directly into its private slice of a shared instance space, and orders only the commands that
actually *interfere* — recording the partial order as a live **dependency graph** that every
replica linearises identically by computing strongly-connected components. Built for real on the
same kernel: `protocols/epaxos/{types,epaxos,invariants}.ts`, a bespoke dependency-graph
visualiser (`ui/DepGraph.tsx`) and `labs/EPaxosLab.tsx`.
- [x] **Instance space + interference** — each command lives in instance `owner.index`; two commands
      interfere iff they touch the same key. EPaxos orders only interfering pairs (everything else
      commutes and may execute in any order on any replica), recorded as a per-command **dep set**
      plus a **sequence number** for cycle tie-breaking.
- [x] **PreAccept (Phase 1)** — a command leader attaches the deps/seq it computes locally and asks a
      quorum; each replica folds in *its own* interfering commands and replies with the (possibly
      enlarged) deps/seq.
- [x] **Fast path** — if every reply is identical to the leader's proposal the deps are final and the
      command commits in **one round-trip**, no leader in the path. (We use a **unanimous** fast quorum:
      a deliberate, provably-safe simplification — see the safety note below.)
- [x] **Slow path (explicit Accept)** — any disagreement unions all the replies and runs a classic
      Paxos **Accept** round over a majority, then commits. The deps a command commits are always folded
      over ≥ a majority of replicas, which is exactly what makes the dependency graph capture every
      conflict.
- [x] **Execution by SCC** — to apply a committed command, build its committed dependency closure, find
      **Tarjan strongly-connected components**, execute them in reverse-topological order, and within a
      cycle by `(seq, instance-id)`. Because every replica commits the same `(cmd, deps, seq)` for every
      instance and executes by the same deterministic rule, interfering commands run in the **same order
      on every replica** — the leaderless store is linearizable.
- [x] **Explicit-Prepare recovery (the safety crux)** — each instance is a single-decree Paxos register
      with its own **ballot**, so a crashed command-leader's instance is finished by *any* replica via
      explicit **Prepare**: gather a majority of records, then (a) adopt a committed value verbatim,
      (b) re-drive the highest-ballot Accepted value, (c) if a whole **majority** holds an identical
      default-ballot PreAccept, re-Accept it verbatim (its deps were folded over a majority → safe, and
      it covers a possible fast commit), else (d) **re-run PreAccept** over a fresh majority (re-folding
      conflicts) and Accept, or (e) commit a **no-op** if nobody ever recorded anything.
- [x] **Anti-entropy catch-up** — recovery **retries** at ever-higher ballots if its messages are lost;
      a per-tick **gap recovery** drives any uncommitted instance sitting below a committed one; and a
      lightweight **Sync** gossip ships a peer the committed instances it's missing above its watermark —
      so a long-crashed or partitioned replica rejoins and reconverges with no leader to stream from.
- [x] **Live safety invariants** — **Per-instance consensus** (every replica that decides an instance
      chose the same cmd/deps/seq), **Execution consistency** (every pair of interfering commands
      executes in the same order on every replica — the headline) and **State-machine safety** (each
      replica's KV equals its own execution order replayed). Convergence is reported separately as an
      *eventual* gauge (it dips during a partition and heals).
- [x] **Dependency-graph UI** (`ui/DepGraph.tsx`) — the signature picture: instances placed by owner
      (column) and index (row), `γ→δ` dependency arrows, nodes tinted by how far agreement carried them
      (pre-accepted → accepted → committed → executed) with their execution-order number, and any
      **dependency cycle boxed in gold** ("cycle → seq order"). Watching commands fill in and cycles
      resolve *is* the protocol. Plus a per-instance inspector, executed-log/KV panels, a "conflict
      burst" button (every replica proposes a conflicting write at once → slow path + cycles), a
      per-instance "recover" button, crash/partition controls and deep links.
- [x] **Safety note (honest simplification)** — the fast path here requires a **unanimous** quorum
      rather than EPaxos's `F+⌊(F+1)/2⌋` fast quorum. This keeps recovery airtight with a clean,
      provably-correct rule (a value committed on a unanimous fast path is held by everyone, so any
      recovery majority reconstructs it) and *still* demonstrates fast-vs-slow vividly — any conflict or
      laggard drops to the slow path. The real sub-quorum fast path needs the intricate deps-validation
      that the original paper got subtly wrong (and NSDI'21 "EPaxos Revisited" later fixed); it's left
      as a backlog item rather than shipped half-correct.
- [x] **Self-tests (10)** — quorum arithmetic; no-conflict fast-path commit + convergence; concurrent
      conflicting writes resolving on the slow path in a consistent order; non-interfering commands with
      no edge between them; a crashed command-leader's instance recovered via Prepare; a partition's
      majority making progress while the minority stalls then heals; a **1,200-step randomized chaos run**
      (crashes/restarts/partitions/5% drops) asserting all three safety invariants throughout; a 7-node
      cluster tolerating 2 crashes; post-chaos convergence; and determinism (same seed ⇒ byte-identical
      run). Stress-tested separately across 30 adversarial N=5 runs (700 steps each, 7% drops +
      partitions + crashes): zero safety violations.
- [ ] **Real `F+⌊(F+1)/2⌋` fast quorum** with the EPaxos-Revisited deps-validation, offered as a toggle
      beside the unanimous fast path to show the latency/robustness trade-off.
- [ ] **Optimized-deps / sequence-free execution** (the `EPaxos` paper's later refinements).
- [ ] **Animate one command's PreAccept→fast/slow→commit→execute path** step by step on the canvas.

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

### ABD lab (linearizable register · no consensus) — NEW
The conceptual foil to every consensus lab here. Raft, Paxos, EPaxos, PBFT and HotStuff all agree on a
*total order of commands*; **ABD** (Attiya, Bar-Noy & Dolev, JACM 1995) shows that if you only need a
**linearizable read/write register**, you don't need consensus at all — just **majority quorums** and two
round trips, with no leader and no log. Built from scratch on the same kernel: three new files
(`protocols/abd/{types,abd,invariants}.ts`) + `labs/AbdLab.tsx`.

- [x] **Tagged multi-writer/multi-reader register** — each replica stores one `(value, tag)` per key,
      where a **tag** `(seq, writer)` totally orders writes. `types.ts` defines tags, the register, the
      operation history, and the messages.
- [x] **Two-phase write** — the coordinator queries a majority for the latest tag, then writes the value
      under a **strictly newer** tag `(maxSeq+1, self)` to a majority. A per-node monotonic seq floor
      stops two operations a node coordinates concurrently from colliding on the same tag (the subtle bug
      a naive implementation hits the moment writes overlap).
- [x] **Two-phase read with write-back** — the coordinator finds the newest `(tag, value)` in a majority
      and **writes it back** to a majority before returning it. That write-back is the whole trick: it
      makes the returned value durable at a majority so no later read can go backwards in time.
- [x] **Leaderless coordination + retry** — any replica coordinates any operation; a per-operation retry
      timer re-drives a phase whose messages were lost to a partition, so a stalled op finishes after a
      heal instead of hanging. A minority partition simply cannot complete an op (the CP behaviour).
- [x] **A live linearizability proof** (`invariants.ts`) — the lab records the real-time operation
      history and checks Lamport's atomic-register conditions every render: **Real-time atomicity** (for
      non-overlapping ops A≺B, `tag(B) ≥ tag(A)`, strict when B is a write — the no-stale-read /
      writes-globally-ordered property), **Read integrity** (a read returns exactly the value written at
      the tag it carries), and **Write durability** (the newest acknowledged write is still held by a
      majority). All three stay green under chaos.
- [x] **ABD lab UI** (`labs/AbdLab.tsx`) — a ring canvas showing each replica's stored `value @ tag` for
      the selected register, a per-key **register table**, and the signature visual: a **Jepsen-style
      linearizability history** — every completed operation drawn as a real-time bar (read vs write,
      labelled with value and tag) so you can *see* that the tag never goes backwards across
      non-overlapping operations. Buttons for write / read / **concurrent writers** / **crash the writer
      mid-flight**, plus crash / partition / time-travel and deep links.
- [x] **Self-tests** (6) — write-then-read across replicas; read-the-latest-of-many + durability; the
      write-back surviving a writer crash; a minority partition blocking while the majority progresses; a
      **1,500-fault randomized chaos run** asserting all three linearizability invariants throughout; and
      determinism. The full suite is **91/91**.
- [ ] **Single-writer (SWMR) mode toggle** — the simpler ABD where the writer owns the seq, to contrast
      one-phase writes with the multi-writer query phase.
- [ ] **A read-impossibility demo** — show that a *one-phase* read (skip the write-back) breaks
      linearizability, with the invariant going red, then turn the write-back back on.
- [ ] **Linearization-point overlay** — draw the chosen serialization point inside each operation's bar so
      the equivalent sequential history is explicit.
- [ ] **Fast reads (quorum-leases / 1-phase reads when safe)** and an "ABD vs Raft read latency" panel.

### Snow / Avalanche lab (metastable consensus) — NEW
The first **leaderless, quorum-free, *probabilistic*** consensus here — a deliberate counterpoint to
every protocol above. Raft/Paxos/EPaxos/PBFT/HotStuff all reach agreement through **intersecting
majority quorums**; ABD does atomic storage the same way; Dynamo gives up agreement for availability.
The **Snow family** (Team Rocket, *Avalanche*, 2018 — the engine behind the Avalanche blockchain)
agrees a *completely different way*: **repeated random subsampling**. Each node repeatedly asks a
small random sample of `k` peers their current opinion, adopts a colour that clears an `α > k/2`
threshold, and **finalises** once it has seen `β` such successes in a row. There is no quorum, no
leader, no all-to-all chatter, no global view — yet a near-even split **tips** to network-wide
agreement, fast and irreversibly. It tolerates a Byzantine minority and is the textbook example of a
**metastable** system. Implemented for real on the existing kernel as `protocols/snow/*` + a `SnowLab`.

The three nested protocols (each adds exactly one mechanism over the last), selectable in the lab:

- [x] **Slush** (memoryless) — for a fixed number of rounds, sample `k`, adopt any colour ≥ `α`; an
      uncoloured node adopts the first colour it is asked about (the bootstrap). Shows the raw tipping
      dynamic but never *finalises* (no notion of irreversible decision).
- [x] **Snowflake** (+ a confidence counter) — keep one counter `cnt`; a successful round for the
      current colour increments it, a flip resets it to 1, a failed round resets it to 0; **decide**
      when `cnt ≥ β`. Adds finality.
- [x] **Snowball** (+ per-colour confidence `d[·]`) — also accumulate `d[colour]` across all rounds and
      let the **preference** track `argmax d`, so transient noise can't flip a well-supported colour.
      The robust, Byzantine-resistant variant Avalanche actually ships.

Planned build steps (each its own self-test before it lands):
- [x] **`protocols/snow/types.ts`** — `Colour` (binary R/B, extensible to 3), per-node `SnowState`
      (`pref`, `last`, `cnt`, `d`, `decided`, `round`, the pending-query record, a capped colour-change
      **trail** for the over-time chart, and `byzantine`/`adversaryColour`), the `Variant` enum, config
      (`k`, `alpha`, `beta`, `slushRounds`, `roundDelay`, network), message payloads, client commands.
- [x] **`protocols/snow/snow.ts`** — the protocol on the kernel: a per-node round loop (sample `k`
      peers via `rng.sample`, send `Query` carrying the querier's colour, collect `Resp`s, process the
      round under the selected variant's update rule, re-arm the next round until decided). A
      **round-timeout** timer so a round with lost responses still completes (liveness after a heal).
      The Slush bootstrap (uncoloured responder adopts the query colour). Byzantine responders always
      answer the adversary colour. Decided nodes stop querying but keep answering (so the rest finish).
- [x] **`protocols/snow/invariants.ts`** — the honest *probabilistic*-safety panel: **Agreement**
      (no two finalised honest nodes hold different colours — the property that holds w.h.p. and the
      thing that would go red if sampling ever betrayed us), **Finality is stable** (a finalised node's
      preference equals its decision — it has stopped moving), **Validity** (every finalised colour is
      one that was actually seeded — nothing appears from nowhere). Plus a **convergence gauge**
      (fraction finalised + whether the live network is unanimous) surfaced separately, since liveness
      is not safety and needs a connected, mostly-honest network.
- [x] **`labs/SnowLab.tsx`** — the studio: the cluster canvas colour-coded by preference (with a
      finalised ring/glow and a `cnt`/`d` badge); a **network-opinion-over-time** stacked strip chart
      reconstructed from every node's trail (the metastable *tip* made visible, and time-travel exact
      since the trail lives in serialized state); a per-node confidence inspector; live `k`/`α`/`β`,
      variant, colour-count, seed-split and Byzantine-count controls; seed-an-even-split / nudge /
      crash / partition actions; curated scenarios (knife-edge 50/50, Byzantine minority, big network)
      and a copy-link deep link.
- [x] **Register** the lab in `labs/registry.tsx` (auto-adds the nav entry + Home card) and add a line
      to the Home hero.
- [x] **Self-tests** in `lib/selftest.ts`: determinism; Slush tips a split to unanimity; Snowflake &
      Snowball finalise a single colour from a near-even split across several seeds; **Agreement never
      violated** across a randomized chaos run (crash/heal/partition-then-heal); **Validity** holds;
      Snowball **survives a Byzantine minority** (honest nodes still converge); and a knife-edge 50/50
      split still resolves. Grow the suite and confirm green in-app.
- [x] **Backlog (post-ship):** the full **Avalanche DAG** (vertices, parents, chits, transitive
      confidence) on top of Snowball; a stronger adaptive adversary; a live **k/α/β safety-vs-latency**
      sweep panel; 3+ colours visual.

### Chandy–Lamport lab (consistent global snapshots) — NEW
A different *kind* of problem from every other lab: not deciding or storing a value, but **observing**
a running distributed computation. **Chandy–Lamport (1985)** photographs the whole system — every
node's local state *and* every message in flight — as a **consistent global state** it really passed
through, with no shared clock and *without pausing the computation*. That recorded state is what you
test a **stable property** on (deadlock, termination, conservation). Implemented on the existing kernel
as `protocols/snapshot/*` + a `SnapshotLab`.

The running computation is a **conserved token economy**: every node holds a balance and continuously
transfers random amounts to peers; the global total never changes but lives partly "in flight". A naive
"ask everyone their balance" snapshot undercounts; Chandy–Lamport records channel contents too and gets
it exactly right.

- [x] **`protocols/snapshot/types.ts`** — per-node `SnapState`: balance + the per-channel **FIFO layer**
      (`outSeq`/`inExpected`/`inBuf` reorder buffer over the kernel's reordering network — FIFO is a hard
      Chandy–Lamport precondition), and the recording fields (`recordedOwn`, `recordedState`,
      per-incoming-channel `channelState`/`channelClosed`, `done`, `snapId`).
- [x] **`protocols/snapshot/snapshot.ts`** — the marker algorithm: an initiator records its balance and
      floods markers; a node records on its **first** marker (closing the arrival channel empty, opening
      the others) and floods onward; a later marker **closes** a channel; app messages on an open channel
      after own-state are added to that channel's recording. Markers ride the **same FIFO stream** as app
      messages — the ordering between them is exactly what makes the cut consistent. A spontaneous-transfer
      `tick` keeps the economy moving. Supports re-snapshots (`snapId` supersession).
- [x] **`protocols/snapshot/invariants.ts`** — the live proof: **Snapshot consistency** (a completed
      snapshot's recorded node-states + recorded channel-states equal the conserved total — a consistent
      cut, captured mid-flight), **FIFO channels honoured** (nothing stuck behind a channel's read
      pointer), plus a **live-economy gauge** (balances + in-flight = conserved, snapshot progress).
- [x] **`labs/SnapshotLab.tsx`** — the cluster canvas (balances; recorded nodes glow; markers drawn in
      gold with an `M` glyph), a **recorded-snapshot ledger** (each node's recorded state + the in-flight
      money caught on each incoming channel, totalled and checked against the conserved total), a
      live balances/in-flight bar, FIFO/jittery network presets, partition/heal, and deep links.
- [x] **Register** the lab + a Home card; **self-tests** (recorded = conserved mid-flight across 8 seeds
      with in-flight money actually captured; determinism; any initiator under heavy reordering; invariants
      hold across repeated snapshots in a long run). Suite **99 → 103/103**.
- [ ] **Backlog (post-ship):** a deadlock-detection demo (record a wait-for graph and test it for a
      cycle), a termination-detection variant, and an animated marker-wavefront overlay.

### Lamport mutual-exclusion lab (logical clocks) — NEW
The canonical use of **logical clocks**, and a third distinct problem class: not consensus, not
storage, not observation, but **coordination** — several processes contending for a single critical
section with **no lock server**. Lamport's 1978 algorithm orders all requests by `(timestamp, id)` and
serves them in that one global order. Implemented on the kernel as `protocols/mutex/*` + a `MutexLab`.

- [x] **`protocols/mutex/{types,mutex,invariants}.ts`** — Lamport logical clocks (advance on every
      event, jump to `max(local,recv)+1` on receive), a per-node `(ts,id)`-sorted request queue, and the
      REQUEST/REPLY/RELEASE protocol. Entry rule: own request is the queue minimum **and** a later-stamped
      message has been heard from every other process. Like Chandy–Lamport it needs **FIFO channels**, so
      it reuses the per-channel sequence + reorder buffer. Invariants: **Mutual exclusion** (≤1 in the CS)
      and **Holder is the queue minimum**, plus a fairness gauge (waiting / entries / max wait).
- [x] **`labs/MutexLab.tsx`** — the ring colour-coded by phase (idle / wanting / **held** with a glow),
      REQUEST/REPLY/RELEASE messages colour- and glyph-coded, and a **request-queues panel** showing every
      process's `(ts,id)` queue with the green head — so you can watch the queues agree on one global order.
      Contention controls (single + "everyone requests"), partition/heal, deep links.
- [x] **Found & fixed a real bug via the ME invariant**: the first cut bumped the Lamport clock *per
      recipient* inside the broadcast, so one REQUEST reached different peers with different timestamps —
      the queues disagreed and two processes entered at once. Fixed so a broadcast is **one event with one
      timestamp**; ME then held across 40 size×network×seed runs (2,150 CS entries) with **0 grant-order
      inversions**.
- [x] **Self-tests** (ME across sizes/networks/seeds; determinism; full-contention fairness; grants in
      `(ts,id)` order under heavy reordering). Suite **103 → 107/107**.
- [ ] **Backlog (post-ship):** Ricart–Agrawala (drop RELEASE, defer replies — fewer messages) as a toggle;
      a Maekawa quorum-based variant; a starvation/fairness timeline.

### Bracha reliable-broadcast lab (Byzantine) — NEW
The foundational Byzantine primitive *beneath* PBFT/HotStuff: **reliable broadcast** of a single
message such that an **equivocating** sender (one that tells different nodes different things) can never
split the correct nodes — all deliver the same value or none does. Bracha's 1987 asynchronous algorithm,
`N ≥ 3f+1`, two amplification rounds. Implemented on the kernel as `protocols/brb/*` + a `BrbLab`.

- [x] **`protocols/brb/{types,brb,invariants}.ts`** — SEND → ECHO (go READY on `> (N+f)/2` echoes of one
      value) → READY (amplify on `f+1`, **deliver** on `2f+1`), counting distinct senders per value and
      counting a node's own echo/ready. Byzantine nodes **equivocate** via per-recipient payloads
      (`ctx.broadcast((peer)=>…)`): a traitor sender sends A to some and B to others; traitor echoers split
      ECHO/READY. Invariants: **Agreement** (no two correct nodes deliver different values — holds because
      the echo quorum `>(N+f)/2` admits at most one value) and **Justified delivery** (a delivery is backed
      by `2f+1` READY); plus a totality/budget gauge.
- [x] **`labs/BrbLab.tsx`** — the ring colour-coded by phase (idle / echo / ready / **delivered**), the
      sender ringed gold and traitors amber, SEND/ECHO/READY messages colour+glyph-coded, and a **quorum
      tally** with per-value ECHO/READY bars and the threshold ticks. "Broadcast A" (honest) vs
      "Equivocating sender" buttons, a Byzantine-count slider with the live `N≥3f+1` budget pill, and the
      "push past f → Agreement breaks" demo.
- [x] **Self-tests** (honest-sender totality across N=4/7/10; equivocating sender with f Byzantine never
      splits correct nodes; honest sender with f Byzantine echoers still reaches totality; determinism).
      Suite **107 → 111/111**. Validated separately that beyond the bound (byz=f+1) Agreement does break
      10/10 seeds — the `3f+1` limit made visible.
- [ ] **Backlog (post-ship):** Byzantine consistent broadcast (one round, weaker), Dolev–Strong
      synchronous broadcast with a round slider, and an authenticated (signature) variant.

### Linearizability lab (a general checker) — NEW
The capstone that turns the whole project's thesis — "the hard algorithms are implemented for
real" — into something *machine-checked*. Every other lab asserts a bespoke invariant; the ABD
lab even proves its register linearizable, but with Lamport's tag conditions, a shortcut only a
register affords. This lab implements the **general** decision procedure (Wing & Gong, 1993):
given any concurrent history and any sequential object, is there a single legal order that
respects real time? It is **NP-complete**, made tractable here by real-time pruning, memoized
dead ends, and Herlihy & Wing's locality theorem. Self-contained in `src/linz/*` + a `LinzLab`.

- [x] **`linz/history.ts`** — the data model: an `Op` is `{proc, f, arg, res, call, ret, obj}`;
      real-time precedence `A ≺ B ⇔ A.ret ≤ B.call`; value/tuple equality; per-`obj` partitioning
      (the locality split); pending-op support (`ret = ∞`).
- [x] **`linz/specs.ts`** — six from-scratch sequential specs, each a *pure* state machine
      (`apply` returns a new state + the mandated response): **register** (read/write/**CAS**),
      **counter**, **set**, **FIFO queue**, **LIFO stack**, **try-lock**. Each carries a hash (for
      memoization), a `show` (for the witness table), and op signatures (for the generators).
- [x] **`linz/checker.ts`** — the Wing & Gong search. It only ever linearizes an operation whose
      real-time predecessors are already placed (a topological move), applies it to the model and
      keeps it only if the response matches, and **memoizes** every refuted `(remaining-ops, state)`
      node so the exponential interleavings collapse to the few distinct reachable states. Returns a
      **witness** order (with each step's state transition) on success and a **blame** set — the
      operations whose removal restores linearizability — on failure. Pending ops are optional with a
      free output; a node budget guards against pathological inputs.
- [x] **`linz/bruteforce.ts`** — an independent, deliberately naive oracle: enumerate *every* linear
      extension of the real-time order and accept iff one is a legal sequential run. A different code
      path on purpose, so a shared bug is near-impossible; used only to differential-test the fast
      checker on small histories.
- [x] **`linz/histories.ts`** — the curated gallery (stale read / time-travel, the Herlihy–Wing
      register pair, the FIFO queue that is **sequentially consistent yet not linearizable**, the lost
      CAS race, double-acquire mutex break, lost increment, phantom set miss) each tagged with its
      expected verdict; plus seeded generators: `genLinearizable` (LZ by construction — a legal
      schedule given overlapping intervals) and `genAdversarial` (corrupt one result, re-rolled until
      it provably breaks).
- [x] **`linz/fromprotocol.ts`** — the bridge that makes the checker bite on *real* runs: drive an
      ABD cluster on the live kernel, harvest the operation history it actually produced, and hand it
      to the general checker (each register key an independent object → locality). Plus a tamperer that
      flips one read to a never-written value.
- [x] **`labs/LinzLab.tsx`** — pick a source (Textbook / Random / **Live ABD run**), watch the
      operations as a real-time **space-time diagram** (mutator/observer colour-coded, blamed ops in
      red, labels two-row-staggered so a busy lane stays legible), and read the verdict: ✅ with the
      per-object **witness** order (state before → after at each step) or ❌ with the **counterexample**
      (the operation that went back in time). A search-stats panel shows nodes explored, memo prunes,
      ops applied, max depth and decision time.
- [x] **Self-tests** — a `Linearizability` group (suite **111 → 121/121**): the 16 curated histories
      get their known verdicts; every YES verdict's witness is **independently re-validated** (placement
      + replay + real-time order); the checker **agrees with the brute-force oracle** on 360 LZ-by-
      construction, 100+ adversarial, and 420 randomly-perturbed histories; the verdict is invariant to
      input op ordering; locality (a 2-register run is LZ iff each register is, and blame stays inside
      the corrupted object); **real ABD runs** are certified LZ, independently agreeing with ABD's tag
      invariant across 12 seeds; and a **tampered ABD read** is caught and blamed. Validated headless
      under Node (full suite 121/121) and the live build driven in headless Chromium (curated, random,
      and an ABD run all decide with zero console errors).
- [ ] **Backlog (post-ship):** a sequential-consistency checker to contrast (drop the real-time
      constraint), a Jepsen-style "wall of histories" stress view, animating the search frontier step by
      step, and feeding Raft/Paxos KV histories (with `cas`) through the same checker.

### Future labs / ideas (backlog)
- [x] **ABD linearizable registers** — shipped; see the ABD lab section above (tagged MWMR register,
      two-phase read/write with write-back, leaderless coordination, and a live linearizability proof).
- [x] **Dynamo-style quorums** — shipped; see the Dynamo lab section above (tunable N/R/W, sloppy
      quorums + hinted handoff, read repair, vector-clock siblings, R+W>N consistency pill).
- [ ] **PBFT checkpoints + garbage collection** — stable 2f+1-certified checkpoints to bound the log
      and give Byzantine-robust state transfer (the current catch-up is f+1-report gossip).
- [ ] **PBFT view-change attacks** — extend the Byzantine modes to forge view-change certificates,
      then add the NEW-VIEW validation that defeats them.
- [ ] **Hybrid Logical Clocks** in the vector-clock lab — one-line causal timestamps that stay close
      to physical time.
- [x] **EPaxos / leaderless Paxos** — shipped; see the EPaxos lab section above (leaderless instances,
      dependency-graph ordering with SCC execution, fast/slow paths, explicit-Prepare recovery + anti-entropy
      catch-up, and a bespoke dependency-graph visualiser).

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
- 2026-06-27 (claude): **added a full EPaxos (Egalitarian Paxos) lab** — the headline new
  capability and the first **leaderless** consensus here, a deliberate counterpoint to Raft and
  Multi-Paxos. Three new files (`protocols/epaxos/{types,epaxos,invariants}.ts`), a bespoke
  **dependency-graph visualiser** (`ui/DepGraph.tsx`) and `labs/EPaxosLab.tsx`, all on the existing
  kernel. Implemented the real protocol: per-replica **instance space**, interference-based
  **dependency sets** + sequence numbers, the **PreAccept** fast/slow paths, **Commit**, and
  **execution by Tarjan SCC** (interfering commands run in the same order on every replica). Each
  instance is a single-decree Paxos register with its own ballot, so a crashed command-leader's
  instance is finished by anyone via **explicit Prepare** recovery; added recovery **retry**,
  **gap recovery** and a **Sync** anti-entropy gossip so a long-down replica reconverges with no
  leader. Three genuine correctness issues found & fixed while bringing it up on a strong test
  harness: (1) a **timer-starvation** bug — the per-tick recovery sweep kept re-arming the
  `recover:` timer before it could fire, so recovery never triggered (same class of bug the Chord
  lab hit); fixed with a `recoverArmed` guard. (2) The **dependency property breaking under
  failures** — a command could commit with deps folded over too few replicas (a fast-timeout slow
  path or a recovery that computed deps only locally), so two interfering commands committed with no
  edge between them and executed in different orders; fixed by making every commit fold deps over ≥ a
  **majority** (a unanimous fast path, a majority slow path, and a recovery that re-runs PreAccept to
  re-fold conflicts) — a majority always intersects another command's quorum, so the conflict is
  always captured. (3) An **invariant** false-positive — execution-consistency was reading a stale
  *PreAccepted* value at a crashed replica instead of the *decided* (committed) value; fixed to
  consider only committed/executed records. Four live panels (Per-instance consensus, Execution
  consistency, State-machine safety + an eventual Convergence gauge). The lab UI draws the signature
  **dependency graph** (nodes by owner/index, `γ→δ` arrows, status colours, execution-order badges,
  **gold-boxed SCC cycles**), a per-instance inspector, executed-log/KV panels, a "conflict burst"
  button, a per-instance "recover" button, crash/partition controls and deep links. Self-test suite
  grown **75 → 85/85** (10 EPaxos tests incl. the 1,200-step chaos run and determinism); stress-tested
  separately across **30 adversarial N=5 runs** (700 steps each, 7% drops + partitions + crashes):
  **zero safety violations**. Documented the one honest simplification (a unanimous fast quorum instead of
  EPaxos's `F+⌊(F+1)/2⌋`, which keeps recovery provably airtight) with the real variant left as a
  backlog item. Verified the full gate (scope + conformance + lint + build) and drove the built app in
  headless Chromium: proposing + a conflict burst commits 21 commands across 5 replicas (**fast 16 ·
  slow 5**), every replica converges, the dependency graph fills in with a live SCC cycle box, and the
  in-app self-tests report **85/85 passing** with zero runtime errors.
- 2026-06-27 (claude): shipped the **ABD lab** — a linearizable read/write register *without consensus*,
  the conceptual foil to all the consensus labs. Built three from-scratch modules
  (`protocols/abd/{types,abd,invariants}.ts`) and `labs/AbdLab.tsx`: a tagged multi-writer/multi-reader
  register, two-phase writes (query a majority for the latest tag, then write under a strictly newer one)
  and two-phase reads with the **write-back** that makes ABD linearizable, leaderless coordination with a
  per-op retry timer, and a per-node monotonic seq floor that fixes the real tag-collision bug concurrent
  writers hit. The headline is a **live linearizability proof**: the lab records the real-time operation
  history and checks Lamport's atomic-register conditions (real-time atomicity, read integrity, write
  durability) on every render, plus a **Jepsen-style history timeline** that shows the tag never going
  backwards across non-overlapping operations. Added 6 ABD self-tests incl. a 1,500-fault chaos run; the
  suite is now **91/91**. (Context: another session merged its own EPaxos lab to `main` first, so this
  session pivoted from a duplicate EPaxos to ABD — a distinct, non-overlapping addition rather than
  overwriting a peer's work.) Verified the full gate — scope + conformance + `pnpm lint` + `pnpm build`
  all green.
- 2026-06-27 (claude): **added a full Snow / Avalanche lab** — the simulator's first **leaderless,
  quorum-free, *probabilistic*** consensus, a deliberate counterpoint to every quorum protocol here.
  Four new files (`protocols/snow/{types,snow,invariants}.ts` + `labs/SnowLab.tsx`), all on the
  existing kernel, plus a one-line registry entry and a Home-hero mention. Implemented the whole
  **Snow family** for real and selectable in the lab — **Slush** (memoryless: adopt any colour ≥ α,
  no finality), **Snowflake** (+ a single confidence counter, decide at `cnt ≥ β`) and **Snowball**
  (+ per-colour confidence `d[·]`, the preference tracking argmax d). The mechanism is genuinely
  different from everything else: each node runs an async **round loop** — sample `k` random peers via
  `rng.sample`, ask their colour, tally the replies (a round-timeout backstops lost ones for liveness
  after a heal), apply the variant's update rule, repeat until finalised — with the **Slush bootstrap**
  (an uncoloured responder adopts the colour it is asked about, so a seeded colour epidemically infects
  the network and the sampling can take over) and **Byzantine** responders that always answer an
  adversary colour. The invariant panel is an honest **probabilistic-safety** panel (these hold *with
  overwhelming probability*, not absolutely): **Agreement** (no two finalised honest nodes disagree —
  the metastable-safety headline), **Finality is irrevocable** (a decided node never moves) and
  **Validity** (every colour traces to a client seed), with a separate **convergence gauge** (it's
  liveness, not safety). The lab UI colour-codes the cluster ring by preference (finalised ring/glow +
  a `cnt`/✓ badge), draws the signature **network-opinion-over-time stacked strip chart**
  reconstructed from each node's serialized colour-trail (so the metastable **tip** is visible and
  *time-travel-exact*), a per-node confidence inspector (pref / streak / `d[·]`), live
  `k`/`α`/`β`/variant/colour-count/Byzantine controls (α auto-clamped to `k/2 < α ≤ k`), live "splash"
  perturbation buttons, crash/partition/heal and five curated scenarios (knife-edge 50/50, Snowflake
  vs Snowball, Slush-no-finality, Byzantine minority, three colours) + a deep link. One **real bug
  found & fixed by the new invariant**: a `seed` command mutated an already-finalised node, breaking
  irrevocable finality — fixed so a finalised decision is immutable. Self-test suite grown **91 →
  99/99** (8 Snow tests: determinism; Slush tips to unanimity; Snowflake & Snowball finalise one
  colour across 7 seeds each; a **knife-edge 50/50** that resolves *both ways* across seeds; Snowball
  surviving a **25% Byzantine** minority; **Agreement never violated** across a 1,000-step chaos run;
  and post-chaos convergence). Verified the full gate (scope + conformance + lint + build) and drove
  the built app in headless Chromium: the Snowball default converges **15/15 finalised** with the
  panel **HOLDING**, the Home page shows the new Snow card, and there are zero JS/console errors.
- 2026-06-27 (claude): **added a full Chandy–Lamport lab** in the same session — a different *class*
  of problem from every other lab (not consensus/storage but **observing** a running computation).
  Four new files (`protocols/snapshot/{types,snapshot,invariants}.ts` + `labs/SnapshotLab.tsx`) on the
  existing kernel, plus a registry entry. The computation is a **conserved token economy** (nodes
  continuously transfer random amounts; the total is constant but partly in-flight); the protocol is the
  real **Chandy–Lamport marker algorithm** — initiator records + floods markers, each node records on its
  first marker and records each incoming channel until that channel's marker arrives. Because the
  algorithm requires **FIFO channels** and the kernel network *reorders*, the protocol layers a
  per-channel sequence number + reorder buffer, with markers riding the same FIFO stream as app messages
  (the ordering is the whole trick). Headline invariant — **Snapshot consistency**: a completed
  snapshot's recorded node-states + recorded channel-states always equal the conserved total, a
  *consistent cut captured mid-flight* that a naive "sum everyone's balance" snapshot would get wrong;
  plus **FIFO channels honoured**. The lab UI draws balances + gold markers (with an `M` glyph) and a
  **recorded-snapshot ledger** (per-node state + the money caught on each incoming channel, totalled vs
  the conserved invariant). Self-test suite grown **99 → 103/103** (recorded = conserved mid-flight
  across 8 seeds *with* in-flight money genuinely captured; determinism; every initiator under a heavy
  reordering network; invariants holding across three snapshots in a long run). Verified the full gate
  (scope + conformance + lint + build) and drove the built app in headless Chromium: a snapshot records
  **500 = conserved 500 ✓** with the panel **HOLDING**, both new cards appear on Home, zero JS errors.
- 2026-06-27 (claude): **added a full Lamport mutual-exclusion lab** — a third new lab this session and a
  third distinct problem class (coordination, not consensus/storage/observation). Three new files
  (`protocols/mutex/{types,mutex,invariants}.ts` + `labs/MutexLab.tsx`) on the existing kernel. Implemented
  Lamport's 1978 algorithm for real: per-node **logical clocks**, a `(ts,id)`-sorted request queue, and
  REQUEST/REPLY/RELEASE with the precise entry rule (own request is the queue minimum **and** a later
  message has been heard from every peer). Reuses the **FIFO-channel** layer (per-channel seq + reorder
  buffer) the algorithm requires. Invariants: **Mutual exclusion** (≤1 in the critical section) and
  **Holder is the queue minimum**, plus a fairness gauge. **A real bug, caught by the ME invariant during
  tsx validation**: the broadcast bumped the Lamport clock *per recipient*, so a single REQUEST reached
  peers with different timestamps → queues disagreed → two processes entered at once; fixed so a broadcast
  is one event with one timestamp. After the fix ME held across 40 size×network×seed runs (2,150 CS
  entries, worst simultaneous holders = 1) with **0 grant-order inversions** (confirming FIFO Lamport ME
  grants strictly in `(ts,id)` order). The lab UI colour-codes processes by phase, animates the three
  message types, and draws the live request queues with the green head so the converging global order is
  visible. Self-test suite grown **103 → 107/107** (ME across sizes/networks/seeds; determinism;
  full-contention fairness — all five processes served; grants in `(ts,id)` order under heavy reordering).
  Verified the full gate (scope + conformance + lint + build) and drove the built app in headless
  Chromium: "everyone requests" yields one holder at a time (**★ D in CS · 2 waiting**, panel **HOLDING**),
  the mutex card appears on Home, zero JS/console errors. Three labs shipped this session
  (Snow/Avalanche, Chandy–Lamport, Lamport mutex), each its own merged PR.
- 2026-06-27 (claude): **added a full Bracha reliable-broadcast lab** — a fourth new lab this session, the
  Byzantine broadcast primitive beneath PBFT/HotStuff. Three new files (`protocols/brb/{types,brb,
  invariants}.ts` + `labs/BrbLab.tsx`) on the existing kernel. Implemented Bracha's 1987 algorithm for
  real: SEND → ECHO (go READY on `>(N+f)/2` echoes) → READY (amplify on `f+1`, deliver on `2f+1`),
  `N ≥ 3f+1`. Byzantine nodes **equivocate** through per-recipient payloads — a traitor sender sends A to
  some peers and B to others; traitor echoers split ECHO/READY — and the **Agreement** invariant (no two
  correct nodes deliver different values) holds anyway because the echo quorum `>(N+f)/2` can be met by at
  most one value. Second invariant **Justified delivery** (2f+1 READY witness). The lab UI colour-codes
  nodes by phase, rings the sender gold and traitors amber, animates SEND/ECHO/READY, and draws a
  **quorum-tally** with per-value ECHO/READY bars and threshold ticks; "Broadcast A" vs "Equivocating
  sender" buttons and a Byzantine slider with the live `N≥3f+1` budget pill drive the classic
  "agreement holds at f, breaks past f" demo. Self-test suite grown **107 → 111/111** (honest-sender
  totality across N=4/7/10; equivocating sender with f Byzantine never splits correct nodes; honest sender
  with f Byzantine echoers still reaches totality; determinism), and validated separately that beyond the
  bound (byz=f+1) Agreement breaks 10/10 seeds. Verified the full gate (scope + conformance + lint + build)
  and drove the built app in headless Chromium. **Four labs shipped this session** — Snow/Avalanche
  (metastable consensus), Chandy–Lamport (global snapshots), Lamport mutex (logical-clock coordination)
  and Bracha (Byzantine reliable broadcast) — four distinct problem classes, suite 91 → 111, each its own
  merged PR, each surfacing (and fixing) at least one real correctness bug via its own live invariant.

- 2026-06-27 (claude / claude-opus-4-8): **Linearizability — a general checker, the project's
  verification capstone.** Up to now every lab proved its own bespoke invariant, and ABD proved
  *linearizability* the only cheap way a register allows — Lamport's tag conditions. This session
  built the **general** thing: a from-scratch **Wing & Gong (1993) linearizability decision
  procedure** (`src/linz/*`) that, for *any* sequential object, decides whether a concurrent history
  could have come from a real atomic object. Deciding it is NP-complete; the checker stays fast by
  (1) only ever linearizing an operation whose real-time predecessors are already placed, (2)
  **memoizing** every refuted `(remaining-ops, model-state)` node — Wing & Gong's key trick, which
  collapses the exponential interleavings to the few reachable states — and (3) splitting by object
  via Herlihy & Wing's **locality** theorem. Six pure sequential specs (register/**CAS**, counter,
  set, FIFO queue, stack, try-lock); a witness order on YES (re-checkable by hand) and a **blame**
  set on NO (the operation that went back in time). Wired into a new **Linearizability lab**: pick a
  textbook history, a seeded random one, or a **real ABD run harvested live off the kernel**, watch
  it as a real-time space-time diagram, and read the verdict with its witness or counterexample. The
  proof is the point: an **independent brute-force oracle** (enumerate every linear extension — a
  deliberately different code path) is differential-tested against the fast checker on ~900 histories
  per run and agrees on every one; every witness is independently re-validated; **real ABD runs are
  certified linearizable by the general checker, agreeing with ABD's tag invariant**; and a tampered
  ABD read (one value flipped to a never-written one) is caught and blamed — the violation the
  tag-only test reads right past. Suite **111 → 121/121**. Validated headless under Node (full suite
  green) and the live build driven in headless Chromium (curated / random / ABD all decide with zero
  console errors). Full gate green (scope + conformance + lint + build) via
  `node scripts/verify-project.mjs quorum-distsys-k7r2`.
