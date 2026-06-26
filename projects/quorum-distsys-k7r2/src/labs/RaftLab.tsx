import { useCallback, useEffect, useMemo, useState } from 'react';
import { Kernel } from '../sim/kernel';
import { createRaft } from '../protocols/raft/raft';
import { raftInvariants } from '../protocols/raft/invariants';
import {
  DEFAULT_RAFT_CONFIG,
  type ClusterConfig,
  type RaftCommand,
  type RaftState,
} from '../protocols/raft/types';
import { useSimulation } from '../lib/useSimulation';
import { NetworkCanvas, type NodeVisual } from '../ui/NetworkCanvas';
import { ControlBar } from '../ui/ControlBar';
import { InvariantPanel } from '../ui/InvariantPanel';
import { Timeline } from '../ui/Timeline';
import { MetricsBar } from '../ui/MetricsBar';
import { nodeColor } from '../lib/format';
import type { NodeRuntime, NodeView } from '../sim/types';

const NAMES = ['A', 'B', 'C', 'D', 'E', 'F', 'G'];

interface NetPreset {
  name: string;
  min: number;
  max: number;
  drop: number;
}
const NET_PRESETS: NetPreset[] = [
  { name: 'LAN', min: 20, max: 60, drop: 0 },
  { name: 'WAN', min: 80, max: 200, drop: 0 },
  { name: 'Lossy', min: 20, max: 80, drop: 0.15 },
  { name: 'Flaky', min: 40, max: 160, drop: 0.3 },
];

const SNAP_OPTIONS = [0, 8, 16];

const roleColor: Record<string, string> = {
  leader: '#73e08a',
  candidate: '#ffd479',
  follower: '#7c9cff',
};

/** The voter set a node believes in (latest config entry in its log, else bootstrap). */
function membersOf(s: RaftState): string[] {
  for (let i = s.log.length - 1; i >= 0; i--) {
    const c = s.log[i].cmd;
    if (c.op === 'config') return unionCfg({ old: c.old, next: c.next });
  }
  return unionCfg(s.snapshotIndex > 0 ? s.snapshotConfig : s.bootstrap);
}
const unionCfg = (c: ClusterConfig) => (c.next ? [...new Set([...c.old, ...c.next])] : c.old);

interface ScenarioCfg {
  seed: number;
  count: number;
  net: number;
  preVote: boolean;
  snap: number;
  small: boolean;
}

const DEFAULT_SCENARIO: ScenarioCfg = { seed: 42, count: 5, net: 0, preVote: false, snap: 0, small: false };

function readScenarioFromHash(): Partial<ScenarioCfg> {
  try {
    const q = window.location.hash.split('?')[1];
    if (!q) return {};
    const p = new URLSearchParams(q);
    const out: Partial<ScenarioCfg> = {};
    if (p.has('seed')) out.seed = Number(p.get('seed')) || 0;
    if (p.has('n')) out.count = Number(p.get('n')) || 5;
    if (p.has('net')) out.net = Number(p.get('net')) || 0;
    if (p.has('pv')) out.preVote = p.get('pv') === '1';
    if (p.has('snap')) out.snap = Number(p.get('snap')) || 0;
    if (p.has('small')) out.small = p.get('small') === '1';
    return out;
  } catch {
    return {};
  }
}

const PRESETS: { name: string; cfg: ScenarioCfg }[] = [
  { name: 'Classic (5·LAN)', cfg: { seed: 42, count: 5, net: 0, preVote: false, snap: 0, small: false } },
  { name: 'WAN + pre-vote', cfg: { seed: 7, count: 5, net: 1, preVote: true, snap: 0, small: false } },
  { name: 'Lossy 7-node', cfg: { seed: 13, count: 7, net: 2, preVote: true, snap: 0, small: false } },
  { name: 'Compaction', cfg: { seed: 11, count: 5, net: 0, preVote: false, snap: 8, small: false } },
  { name: 'Membership', cfg: { seed: 5, count: 5, net: 0, preVote: false, snap: 0, small: true } },
];

export function RaftLab() {
  const initial = useMemo(() => ({ ...DEFAULT_SCENARIO, ...readScenarioFromHash() }), []);
  const [seed, setSeed] = useState(initial.seed);
  const [count, setCount] = useState(initial.count);
  const [net, setNet] = useState(initial.net);
  const [preVote, setPreVote] = useState(initial.preVote);
  const [snap, setSnap] = useState(initial.snap);
  const [small, setSmall] = useState(initial.small);
  const [selected, setSelected] = useState<string | null>(null);
  const [propCounter, setPropCounter] = useState(1);
  const [readCounter, setReadCounter] = useState(1);
  const [copied, setCopied] = useState(false);

  const nodeIds = useMemo(() => NAMES.slice(0, count), [count]);
  const initialMembers = useMemo(() => (small ? nodeIds.slice(0, 3) : nodeIds), [small, nodeIds]);

  // Keep the URL in sync so the exact scenario is shareable / reloadable.
  useEffect(() => {
    const q = new URLSearchParams({
      seed: String(seed),
      n: String(count),
      net: String(net),
      pv: preVote ? '1' : '0',
      snap: String(snap),
      small: small ? '1' : '0',
    });
    history.replaceState(null, '', `#/raft?${q.toString()}`);
  }, [seed, count, net, preVote, snap, small]);

  const makeKernel = useCallback(() => {
    const proto = createRaft({ ...DEFAULT_RAFT_CONFIG, preVote, snapshotThreshold: snap, initialMembers });
    proto.invariants = raftInvariants as (n: ReadonlyArray<NodeView<RaftState>>) => ReturnType<typeof raftInvariants>;
    const preset = NET_PRESETS[net];
    return new Kernel<RaftState, RaftCommand>({
      seed,
      protocol: proto,
      nodeIds,
      network: { minLatency: preset.min, maxLatency: preset.max, dropRate: preset.drop },
    });
  }, [seed, nodeIds, net, preVote, snap, initialMembers]);

  const ctrl = useSimulation(makeKernel);
  const snapshot = ctrl.snapshot;

  const nodesByRole = (role: string) =>
    (snapshot?.nodes ?? []).filter((n) => n.up && (n.state as RaftState).role === role);
  const leader = nodesByRole('leader').sort(
    (a, b) => (b.state as RaftState).currentTerm - (a.state as RaftState).currentTerm,
  )[0];

  // The active voter set (from the leader if there is one, else the most-advanced node).
  const refNode =
    leader ??
    (snapshot?.nodes ?? [])
      .filter((n) => n.up)
      .sort((a, b) => (b.state as RaftState).commitIndex - (a.state as RaftState).commitIndex)[0];
  const voters = refNode ? membersOf(refNode.state as RaftState) : ctrl.nodeOrder;
  const votersKey = voters.join(',');
  const voterSet = useMemo(() => new Set(votersKey ? votersKey.split(',') : []), [votersKey]);
  const reconfiguring = refNode ? membersConfigJoint(refNode.state as RaftState) : false;

  const visual = useCallback(
    (node: NodeRuntime<RaftState>, i: number): NodeVisual => {
      const s = node.state;
      const lastIdx = s.snapshotIndex + s.log.length;
      const hasSnap = s.snapshotIndex > 0;
      return {
        fill: roleColor[s.role] ?? '#7c9cff',
        ring: nodeColor(i),
        label: node.id,
        sub: `T${s.currentTerm} ${s.role[0].toUpperCase()}${hasSnap ? ' ⌗' : ''}`,
        badge: String(lastIdx),
        glow: s.role === 'leader',
        down: !node.up,
        dim: !voterSet.has(node.id),
      };
    },
    [voterSet],
  );

  const propose = (key: string, value: string) => {
    const target = leader?.id ?? ctrl.nodeOrder[0];
    ctrl.command(target, { op: 'set', key, value });
  };

  const quickPropose = () => {
    propose('x', String(propCounter));
    setPropCounter((c) => c + 1);
  };

  const burst = () => {
    ctrl.act((k) => {
      const lead = k.views().find((v) => v.up && v.state.role === 'leader');
      const target = lead?.id ?? ctrl.nodeOrder[0];
      for (let i = 0; i < 5; i++) k.command(target, { op: 'set', key: `k${i}`, value: String(propCounter + i) });
    });
    setPropCounter((c) => c + 5);
  };

  const linearizableRead = () => {
    if (!leader) return;
    ctrl.command(leader.id, { op: 'read', key: 'x', rid: readCounter });
    setReadCounter((c) => c + 1);
  };

  const addServer = () => {
    if (!leader) return;
    const cur = membersOf(leader.state as RaftState);
    const candidate = ctrl.nodeOrder.find((id) => !cur.includes(id));
    if (!candidate) return;
    ctrl.command(leader.id, { op: 'config', old: [], next: [...cur, candidate] });
    setSelected(candidate);
  };

  const removeServer = () => {
    if (!leader) return;
    const cur = membersOf(leader.state as RaftState);
    const victim = cur.find((id) => id !== leader.id);
    if (!victim || cur.length <= 1) return;
    ctrl.command(leader.id, { op: 'config', old: [], next: cur.filter((id) => id !== victim) });
  };

  const canAdd = !!leader && ctrl.nodeOrder.some((id) => !voters.includes(id));
  const canRemove = !!leader && voters.length > 1;

  const partitionMinority = () => {
    const half = Math.floor(ctrl.nodeOrder.length / 2);
    ctrl.partition([ctrl.nodeOrder.slice(0, half), ctrl.nodeOrder.slice(half)]);
  };

  const killLeader = () => {
    if (leader) {
      ctrl.crash(leader.id);
      setSelected(leader.id);
    }
  };

  const applyPreset = (cfg: ScenarioCfg) => {
    setSeed(cfg.seed);
    setCount(cfg.count);
    setNet(cfg.net);
    setPreVote(cfg.preVote);
    setSnap(cfg.snap);
    setSmall(cfg.small);
  };

  const copyLink = async () => {
    const url = `${location.origin}${location.pathname}${location.hash}`;
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 1400);
    } catch {
      setCopied(false);
    }
  };

  const sel = selected ? snapshot?.nodes.find((n) => n.id === selected) : undefined;
  const lastRead = leader ? (leader.state as RaftState).lastRead : null;

  return (
    <div className="lab">
      <div className="lab-intro">
        <h2>Raft consensus</h2>
        <p>
          A real Raft cluster on the deterministic kernel. Click a node to inspect it, click a link to
          cut/heal it, propose commands, crash the leader, partition the cluster — and watch the safety
          invariants stay green. Turn on <strong>compaction</strong> to see snapshots + InstallSnapshot,
          grow/shrink the cluster with live <strong>membership changes</strong>, or run a{' '}
          <strong>linearizable read</strong>.
        </p>
      </div>

      <ControlBar
        ctrl={ctrl}
        seed={seed}
        onSeed={setSeed}
        right={
          <span className={`leader-pill ${leader ? 'has' : 'none'}`}>
            {leader ? `leader: ${leader.id} · term ${(leader.state as RaftState).currentTerm}` : 'no leader'}
          </span>
        }
      />

      <div className="lab-grid">
        <div className="lab-main">
          <div className="cluster-toolbar">
            <div className="ctl-group">
              <label>Cluster</label>
              {[3, 5, 7].map((c) => (
                <button key={c} className={`btn tiny ${count === c ? 'on' : ''}`} onClick={() => setCount(c)}>
                  {c}
                </button>
              ))}
            </div>
            <div className="ctl-group">
              <label>Network</label>
              {NET_PRESETS.map((p, i) => (
                <button key={p.name} className={`btn tiny ${net === i ? 'on' : ''}`} onClick={() => setNet(i)}>
                  {p.name}
                </button>
              ))}
            </div>
            <div className="ctl-group">
              <label>Pre-vote</label>
              <button className={`btn tiny ${preVote ? 'on' : ''}`} onClick={() => setPreVote((v) => !v)}>
                {preVote ? 'on' : 'off'}
              </button>
            </div>
            <div className="ctl-group">
              <label>Compaction</label>
              {SNAP_OPTIONS.map((s) => (
                <button
                  key={s}
                  className={`btn tiny ${snap === s ? 'on' : ''}`}
                  onClick={() => setSnap(s)}
                  title={s === 0 ? 'no log compaction' : `snapshot once ${s} applied entries accumulate`}
                >
                  {s === 0 ? 'off' : `≥${s}`}
                </button>
              ))}
            </div>
            <div className="ctl-group">
              <label>Members</label>
              <button
                className={`btn tiny ${small ? 'on' : ''}`}
                onClick={() => setSmall((v) => !v)}
                title="Start with only A,B,C active so you can add servers live"
              >
                {small ? 'start A,B,C' : 'all active'}
              </button>
            </div>
          </div>

          <div className="cluster-toolbar">
            <div className="ctl-group">
              <label>Scenarios</label>
              {PRESETS.map((p) => (
                <button key={p.name} className="btn tiny" onClick={() => applyPreset(p.cfg)}>
                  {p.name}
                </button>
              ))}
            </div>
            <div className="ctl-group">
              <button className="btn tiny" onClick={copyLink} title="Copy a shareable link to this exact scenario">
                {copied ? '✓ copied' : '🔗 copy link'}
              </button>
            </div>
          </div>

          {snapshot && (
            <NetworkCanvas
              snapshot={snapshot}
              nodeOrder={ctrl.nodeOrder}
              visual={visual}
              selected={selected}
              onSelect={setSelected}
              onToggleLink={(a, b) => ctrl.toggleLink(a, b)}
              height={420}
            />
          )}

          <div className="action-row">
            <button className="btn" onClick={quickPropose}>
              ＋ Propose x={propCounter}
            </button>
            <button className="btn" onClick={burst}>
              ⚡ Burst ×5
            </button>
            <button className="btn" onClick={linearizableRead} disabled={!leader} title="ReadIndex: confirm leadership, then read x">
              👁 Read x
            </button>
            <button className="btn danger" onClick={killLeader} disabled={!leader}>
              ✕ Kill leader
            </button>
            <button className="btn" onClick={partitionMinority}>
              ⌥ Partition
            </button>
            <button className="btn" onClick={ctrl.heal}>
              ⟲ Heal net
            </button>
          </div>

          <div className="action-row">
            <span className="op-target">membership:</span>
            <button className="btn" onClick={addServer} disabled={!canAdd}>
              ＋ Add server
            </button>
            <button className="btn" onClick={removeServer} disabled={!canRemove}>
              − Remove server
            </button>
            <span className="cfg-pill">
              config {reconfiguring ? '(joint Cold,new) ' : ''}
              {`{${voters.join('')}}`}
            </span>
            {lastRead && (
              <span className="read-pill" title={`linearized at commit index ${lastRead.readIndex}`}>
                read#{lastRead.rid}: {lastRead.key}={lastRead.value ?? '∅'}
              </span>
            )}
            {sel && (
              <button
                className={`btn ${sel.up ? 'danger' : 'good'}`}
                onClick={() => (sel.up ? ctrl.crash(sel.id) : ctrl.restart(sel.id))}
              >
                {sel.up ? `✕ Crash ${sel.id}` : `⏼ Restart ${sel.id}`}
              </button>
            )}
          </div>

          {snapshot && <MetricsBar metrics={snapshot.metrics} />}
        </div>

        <div className="lab-side">
          <InvariantPanel invariants={ctrl.invariants} />
          {sel ? (
            <RaftInspector node={sel} isVoter={voterSet.has(sel.id)} />
          ) : (
            <div className="inspector empty">
              <div className="panel-head">
                <span>Inspector</span>
              </div>
              <div className="muted pad">Click a node to inspect its Raft state, log and snapshot.</div>
            </div>
          )}
        </div>
      </div>

      <Timeline log={snapshot?.log ?? []} />
    </div>
  );
}

function membersConfigJoint(s: RaftState): boolean {
  for (let i = s.log.length - 1; i >= 0; i--) {
    const c = s.log[i].cmd;
    if (c.op === 'config') return c.next !== null;
  }
  return (s.snapshotIndex > 0 ? s.snapshotConfig : s.bootstrap).next !== null;
}

function RaftInspector({ node, isVoter }: { node: NodeRuntime<RaftState>; isVoter: boolean }) {
  const s = node.state;
  const lastIdx = s.snapshotIndex + s.log.length;
  return (
    <div className="inspector">
      <div className="panel-head">
        <span>
          Node {node.id} {node.up ? '' : '(down)'} {isVoter ? '' : '· non-voter'}
        </span>
        <span className="status-pill" style={{ background: roleColor[s.role], color: '#0b0c10' }}>
          {s.role}
        </span>
      </div>
      <div className="kv-grid">
        <span>term</span>
        <b>{s.currentTerm}</b>
        <span>votedFor</span>
        <b>{s.votedFor ?? '—'}</b>
        <span>commitIndex</span>
        <b>{s.commitIndex}</b>
        <span>lastApplied</span>
        <b>{s.lastApplied}</b>
        <span>leader</span>
        <b>{s.leaderId ?? '—'}</b>
        <span>last index</span>
        <b>{lastIdx}</b>
      </div>

      {s.snapshotIndex > 0 && (
        <>
          <div className="sub-head">Snapshot ⌗</div>
          <div className="kv-grid">
            <span>≤ index</span>
            <b>{s.snapshotIndex}</b>
            <span>term</span>
            <b>{s.snapshotTerm}</b>
            <span>kv keys</span>
            <b>{Object.keys(s.snapshotKv).length}</b>
            <span>live log</span>
            <b>{s.log.length}</b>
          </div>
        </>
      )}

      <div className="sub-head">Log {s.snapshotIndex > 0 ? `(from #${s.snapshotIndex + 1})` : ''}</div>
      <div className="log-strip">
        {s.log.length === 0 && <span className="muted">empty</span>}
        {s.log.map((e, i) => {
          const idx = s.snapshotIndex + i + 1;
          const label =
            e.cmd.op === 'set'
              ? `${e.cmd.key}=${e.cmd.value}`
              : e.cmd.op === 'del'
                ? `del ${e.cmd.key}`
                : e.cmd.op === 'config'
                  ? e.cmd.next
                    ? 'Cold,new'
                    : 'Cnew'
                  : 'noop';
          return (
            <div key={i} className={`log-entry ${idx <= s.commitIndex ? 'committed' : ''}`} title={`index ${idx}, term ${e.term}`}>
              <span className="le-idx">{idx}</span>
              <span className="le-term">t{e.term}</span>
              <span className="le-cmd">{label}</span>
            </div>
          );
        })}
      </div>

      {s.role === 'leader' && (
        <>
          <div className="sub-head">Replication</div>
          <div className="repl-grid">
            {Object.keys(s.nextIndex).map((p) => (
              <div key={p} className="repl-row">
                <span>{p}</span>
                <span>next {s.nextIndex[p]}</span>
                <span>match {s.matchIndex[p]}</span>
              </div>
            ))}
          </div>
        </>
      )}

      <div className="sub-head">State machine (kv)</div>
      <div className="kv-store">
        {Object.keys(s.kv).length === 0 && <span className="muted">empty</span>}
        {Object.entries(s.kv).map(([k, v]) => (
          <span className="kv-pill" key={k}>
            {k}={v}
          </span>
        ))}
      </div>
    </div>
  );
}
