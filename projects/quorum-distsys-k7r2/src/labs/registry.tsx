import type { JSX } from 'react';
import { RaftLab } from './RaftLab';
import { CrdtLab } from './CrdtLab';
import { CoeditLab } from './CoeditLab';
import { GossipLab } from './GossipLab';
import { VClockLab } from './VClockLab';
import { CommitLab } from './CommitLab';
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
    title: '2PC commit',
    blurb:
      'Two-phase commit and its blocking problem: stall the coordinator after the yes votes and watch prepared participants block forever, while the safety invariants stay green.',
    icon: '⇋',
    tag: 'atomic commit',
    Component: CommitLab,
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
