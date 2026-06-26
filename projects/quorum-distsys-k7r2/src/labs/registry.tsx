import type { JSX } from 'react';
import { RaftLab } from './RaftLab';
import { CrdtLab } from './CrdtLab';

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
];
