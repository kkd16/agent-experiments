import type { JSX } from 'react';
import { RaftLab } from './RaftLab';
import { PaxosLab } from './PaxosLab';
import { EPaxosLab } from './EPaxosLab';
import { AbdLab } from './AbdLab';
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
    id: 'chord',
    title: 'Chord DHT',
    blurb:
      'A scalable peer-to-peer distributed hash table on a consistent-hashing ring. Watch finger tables route a key lookup to its owner in O(log N) hops, and a coordinator-free stabilization protocol heal the ring as you crash and restart nodes.',
    icon: '◌',
    tag: 'p2p · routing',
    Component: ChordLab,
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
