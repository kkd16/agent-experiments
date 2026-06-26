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
