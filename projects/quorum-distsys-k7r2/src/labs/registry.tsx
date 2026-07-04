import type { JSX } from 'react';
import { RaftLab } from './RaftLab';
import { PaxosLab } from './PaxosLab';
import { VrLab } from './VrLab';
import { ZabLab } from './ZabLab';
import { BenOrLab } from './BenOrLab';
import { EPaxosLab } from './EPaxosLab';
import { AbdLab } from './AbdLab';
import { CraqLab } from './CraqLab';
import { PbftLab } from './PbftLab';
import { HotStuffLab } from './HotStuffLab';
import { ChordLab } from './ChordLab';
import { DynamoLab } from './DynamoLab';
import { CrdtLab } from './CrdtLab';
import { CoeditLab } from './CoeditLab';
import { GossipLab } from './GossipLab';
import { VClockLab } from './VClockLab';
import { CommitLab } from './CommitLab';
import { SnowLab } from './SnowLab';
import { NakamotoLab } from './NakamotoLab';
import { SnapshotLab } from './SnapshotLab';
import { MutexLab } from './MutexLab';
import { BrbLab } from './BrbLab';
import { LinzLab } from './LinzLab';
import { SelfTestLab } from './SelfTestLab';

export interface LabDef {
  id: string;
  title: string;
  blurb: string;
  icon: string;
  tag: string;
  Component: () => JSX.Element;
}

export const LABS: LabDef[] = [
  {
    id: 'raft',
    title: 'Raft consensus',
    blurb:
      'A real Raft cluster: randomized leader elections, AppendEntries log replication and a replicated key/value store — with the four safety invariants checked live while you crash leaders and partition the network.',
    icon: '⚖',
    tag: 'consensus',
    Component: RaftLab,
  },
  {
    id: 'paxos',
    title: 'Multi-Paxos',
    blurb:
      'Consensus the other canonical way — built from the Synod up on ballots and two round-trips (Prepare/Promise, Accept/Accepted). Watch dueling proposers leapfrog ballots, a leader recover prior values, and the "at most one value chosen" theorem hold live as you crash leaders and partition the cluster.',
    icon: '▦',
    tag: 'consensus',
    Component: PaxosLab,
  },
  {
    id: 'vr',
    title: 'Viewstamped Replication',
    blurb:
      'The third canonical crash-fault consensus protocol beside Raft and Paxos — and the one that keeps NO state on disk. A primary (replica view mod N) drives normal operation (Prepare / PrepareOk / Commit); when it goes quiet the backups run a view change (StartViewChange → DoViewChange → StartView) to rotate to the next primary, rebuilding the log from the most up-to-date replica in a quorum; and a crashed replica runs an explicit recovery protocol to rebuild its state from its peers before it may participate again. State transfer fills gaps for a lagging backup, and the client table gives at-most-once execution. Crash the primary, partition the cluster and restart nodes while four safety invariants — Agreement, Execution Safety, Primary Uniqueness and Log Well-Formed — stay green.',
    icon: '⟲',
    tag: 'consensus',
    Component: VrLab,
  },
  {
    id: 'zab',
    title: 'Zab (ZooKeeper)',
    blurb:
      "The consensus engine inside ZooKeeper — the fourth canonical crash-fault protocol beside Raft, Paxos and VR, built for the primary-backup pattern. An elected primary stamps every write with a zxid = (epoch, counter) and atomically broadcasts it, so replicas deliver in the exact order the primary issued — Zab's primary-order guarantee. All four phases run live: Fast Leader Election picks the peer with the most up-to-date log; Discovery settles a new epoch; Synchronization forces the newest history onto a quorum so everyone starts identical; and Broadcast is normal two-phase operation (Propose → Ack → Commit). Unlike VR it keeps a DURABLE log, so a restarted node recovers by log reconciliation, not replay. Kill the leader, partition the cluster and restart nodes while five safety invariants — Agreement, Primary Order, Leader Uniqueness, Execution Safety and Log Well-Formed — stay green.",
    icon: '🐘',
    tag: 'consensus',
    Component: ZabLab,
  },
  {
    id: 'benor',
    title: 'Ben-Or (randomized)',
    blurb:
      "Consensus that defeats the FLP impossibility — by flipping coins. FLP (1985) proves no deterministic protocol can guarantee agreement in an asynchronous system with even one crash; Ben-Or (1983) sidesteps it with randomization. No leader, no stable storage, no synchrony assumption: each round runs Report → Propose, a strict majority forms a proposal, f+1 matching proposals decide, and an inconclusive round is broken by a coin toss. Safety (Agreement + Validity) is deterministic and unconditional — only termination is probabilistic (with probability 1, in a handful of rounds here). Set the input bits, crash up to f of N=2f+1, partition the network, and watch it still agree.",
    icon: '⚄',
    tag: 'randomized consensus',
    Component: BenOrLab,
  },
  {
    id: 'epaxos',
    title: 'EPaxos (leaderless)',
    blurb:
      'Egalitarian Paxos: consensus with no leader at all. Every replica commits its own commands directly, ordering only the ones that interfere by recording a live dependency graph — which every replica then linearises identically by finding strongly-connected components. Watch commands commit in one round-trip on the fast path, fall back to an explicit Accept under conflict, and a crashed command-leader’s instance get finished by anyone via explicit Prepare — with execution staying consistent on every replica.',
    icon: '⇄',
    tag: 'leaderless consensus',
    Component: EPaxosLab,
  },
  {
    id: 'pbft',
    title: 'PBFT (Byzantine)',
    blurb:
      'Practical Byzantine Fault Tolerance: state-machine replication that survives up to f traitor replicas out of N=3f+1 — silent, equivocating or actively lying. Run the three-phase agreement (pre-prepare / prepare / commit), corrupt the primary so it sends conflicting orders, and watch the Agreement invariant hold by quorum intersection — then push past f and watch it break.',
    icon: '⚔',
    tag: 'byzantine consensus',
    Component: PbftLab,
  },
  {
    id: 'hotstuff',
    title: 'HotStuff (modern BFT)',
    blurb:
      'The Byzantine-fault-tolerant engine behind Diem and a generation of BFT blockchains. Same N=3f+1 fault model as PBFT, but with rotating leaders, linear communication (votes funnel into one quorum certificate, no all-to-all chatter) and a pipelined 3-chain commit rule — watch blocks march from proposed → certified → locked → committed. Corrupt the leader and watch Agreement hold as the pacemaker rotates it out.',
    icon: '⬡',
    tag: 'byzantine consensus',
    Component: HotStuffLab,
  },
  {
    id: 'abd',
    title: 'ABD (registers, no consensus)',
    blurb:
      'Linearizable storage without consensus. The ABD algorithm (Attiya–Bar-Noy–Dolev, 1995) emulates an atomic read/write register over a crash-prone network using only majority quorums and two round trips — no leader, no log, no agreed order of commands. A write reads the latest tag from a majority then writes under a strictly newer one; a read finds the newest value in a majority then writes it back so it can never be un-read. A live Jepsen-style history chart and three invariants prove every run linearizable as you add concurrent writers, crash the writer mid-operation, and partition the cluster.',
    icon: '▤',
    tag: 'linearizable · no consensus',
    Component: AbdLab,
  },
  {
    id: 'craq',
    title: 'CRAQ (chain replication)',
    blurb:
      'Strong consistency by chain, not quorum. Chain Replication (van Renesse & Schneider, 2004) lines the replicas up HEAD → … → TAIL: a write enters at the head and flows down, the tail commits it and an ack flows back up, and every read is answered by the tail — linearizable with no quorums and no leader, just a small master that owns the chain order. CRAQ (2009) keeps that consistency while letting every replica answer reads — clean objects locally, dirty ones by asking the tail for its committed version — so reads scale with the chain. Crash the head, the tail and the master and watch the chain knit itself back together while three invariants prove every run linearizable, cross-checked by the general Wing & Gong checker.',
    icon: '⛓',
    tag: 'linearizable · chain',
    Component: CraqLab,
  },
  {
    id: 'dynamo',
    title: 'Dynamo (tunable quorums)',
    blurb:
      'The AP counterpoint to the consensus labs: a leaderless, always-writeable key/value store with tunable (N,R,W) quorums. No agreed order — a write returns after W of N acks, a read reconciles R replies with vector clocks. Crash an owner and a sloppy quorum writes to a stand-in holding a hint; partition the cluster, write on both sides, heal, and watch the conflict surface as siblings. Slide (N,R,W) between strong and eventual consistency.',
    icon: '⬢',
    tag: 'replication · AP',
    Component: DynamoLab,
  },
  {
    id: 'crdt',
    title: 'CRDTs',
    blurb:
      'Convergent replicated data types — G/PN-Counter, LWW-Register, OR-Set and an RGA sequence. Edit replicas concurrently across a partition, heal it, and watch them converge with no coordinator.',
    icon: '⌬',
    tag: 'replication',
    Component: CrdtLab,
  },
  {
    id: 'coedit',
    title: 'Collaborative text',
    blurb:
      'A live, server-less collaborative editor on a Replicated Growable Array (RGA) — the sequence CRDT behind Yjs and Automerge. Type into any replica, partition the network, edit both sides at once, heal, and watch every replica converge to the same document character-for-character.',
    icon: '✎',
    tag: 'crdt · editor',
    Component: CoeditLab,
  },
  {
    id: 'gossip',
    title: 'Gossip / SWIM',
    blurb:
      'SWIM-style failure detection: ping, indirect ping-req, suspicion, incarnation-number refutation, and epidemic dissemination of membership — watch the knowledge of a crash infect the cluster.',
    icon: '☣',
    tag: 'membership',
    Component: GossipLab,
  },
  {
    id: 'vclock',
    title: 'Vector clocks',
    blurb:
      'Causality made visible: a space-time diagram of internal events and messages, with vector clocks on every event. Click two events to see happened-before vs. concurrent.',
    icon: '⟁',
    tag: 'causality',
    Component: VClockLab,
  },
  {
    id: 'commit',
    title: '2PC / 3PC commit',
    blurb:
      'Atomic commit, two ways. 2PC blocks if the coordinator stalls after the yes votes; 3PC adds a pre-commit phase and a cooperative termination protocol so participants finish on their own. Toggle between them and crash the coordinator to see the difference.',
    icon: '⇋',
    tag: 'atomic commit',
    Component: CommitLab,
  },
  {
    id: 'snow',
    title: 'Snow / Avalanche',
    blurb:
      'Consensus without quorums. The Snow family (Avalanche, 2018) agrees by repeated random subsampling: each node asks a small random sample of k peers their colour, adopts one that clears an α>k/2 threshold, and finalises after β wins in a row — no leader, no quorum, no global view, yet a near-even split tips to network-wide agreement. Watch Slush → Snowflake → Snowball, see the metastable tip on a live opinion chart, and watch agreement hold through partitions and a Byzantine minority. Safety here is probabilistic — the price of O(k) messages at any scale.',
    icon: '❄',
    tag: 'metastable · probabilistic',
    Component: SnowLab,
  },
  {
    id: 'nakamoto',
    title: 'Nakamoto (proof of work)',
    blurb:
      'The consensus behind Bitcoin — and the odd one out here: no quorum, no leader, no vote, no fixed membership. Miners race to extend the chain (finding a block is a memoryless Poisson process weighted by hash power), and every node just adopts the longest chain it has seen. Two blocks found at once fork the chain; the fork resolves when one branch out-races the other, orphaning the loser. Safety is probabilistic — a block is only ever buried deeper, never truly final — so stage a 51% double-spend: pay a merchant, let the payment confirm, then reveal a longer secret chain that pays the money to yourself instead, and watch the "no finalised reversal" invariant break.',
    icon: '⛏',
    tag: 'proof-of-work · probabilistic',
    Component: NakamotoLab,
  },
  {
    id: 'brb',
    title: 'Bracha broadcast',
    blurb:
      "Reliable broadcast under Byzantine faults — the primitive beneath PBFT/HotStuff. One sender delivers one message so that even an equivocating traitor sender can't split the correct nodes: all deliver the same value or none does. Bracha's SEND→ECHO→READY amplification (N≥3f+1, echo quorum >(N+f)/2, deliver at 2f+1) makes two values unable to both reach quorum. Equivocate the sender, add traitors up to f and watch Agreement hold — then push past f and watch it break.",
    icon: '⊠',
    tag: 'byzantine · reliable broadcast',
    Component: BrbLab,
  },
  {
    id: 'mutex',
    title: 'Lamport mutex',
    blurb:
      "Distributed mutual exclusion with no lock server — Lamport's 1978 logical-clock algorithm. Processes contend for one critical section using only REQUEST/REPLY/RELEASE messages, ordered globally by (timestamp, id) over FIFO channels. A process enters only when its request is the queue minimum and it has heard from everyone later — so two can never enter at once. Watch the request queues converge to one order and mutual exclusion hold live under contention and reordering.",
    icon: '▥',
    tag: 'logical clocks · mutual exclusion',
    Component: MutexLab,
  },
  {
    id: 'snapshot',
    title: 'Chandy–Lamport',
    blurb:
      'Photograph a running distributed computation without stopping it. Nodes trade a conserved token economy; the Chandy–Lamport marker algorithm records a globally consistent snapshot — every balance and every in-flight message — over FIFO channels. The recorded total always equals the conserved total, capturing money that a naive snapshot would miss. Watch markers flood the network and the recorded cut prove consistent, live.',
    icon: '◳',
    tag: 'global state · snapshots',
    Component: SnapshotLab,
  },
  {
    id: 'chord',
    title: 'Chord DHT',
    blurb:
      'A scalable peer-to-peer distributed hash table on a consistent-hashing ring. Watch finger tables route a key lookup to its owner in O(log N) hops, and a coordinator-free stabilization protocol heal the ring as you crash and restart nodes.',
    icon: '◌',
    tag: 'p2p · routing',
    Component: ChordLab,
  },
  {
    id: 'linz',
    title: 'Linearizability',
    blurb:
      "The gold-standard correctness condition, made into a tool. A from-scratch Wing & Gong checker decides whether a concurrent history could have come from a real atomic object — for any spec (register, CAS, counter, set, FIFO queue, stack, lock). Deciding it is NP-complete, so it prunes to real-time-respecting orders and memoizes dead ends, and splits by object via Herlihy & Wing's locality theorem. Feed it the textbook counterexamples, randomly generated schedules, or a real ABD run pulled live off the kernel: it certifies a pass with a concrete witness order, or convicts a fail by naming the operation that went back in time.",
    icon: '⊑',
    tag: 'correctness · verification',
    Component: LinzLab,
  },
  {
    id: 'selftest',
    title: 'Self-tests',
    blurb:
      'A built-in test suite that proves the kernel is deterministic and the protocols satisfy their invariants under randomized chaos — run it live.',
    icon: '✓',
    tag: 'verification',
    Component: SelfTestLab,
  },
];
