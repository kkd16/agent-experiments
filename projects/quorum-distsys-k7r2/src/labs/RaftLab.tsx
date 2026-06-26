import { useCallback, useMemo, useState } from 'react';
import { Kernel } from '../sim/kernel';
import { createRaft } from '../protocols/raft/raft';
import { raftInvariants } from '../protocols/raft/invariants';
import { DEFAULT_RAFT_CONFIG, type RaftCommand, type RaftState } from '../protocols/raft/types';
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

const roleColor: Record<string, string> = {
  leader: '#73e08a',
  candidate: '#ffd479',
  follower: '#7c9cff',
};

export function RaftLab() {
  const [seed, setSeed] = useState(42);
  const [count, setCount] = useState(5);
  const [net, setNet] = useState(0);
  const [preVote, setPreVote] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [propCounter, setPropCounter] = useState(1);

  const nodeIds = useMemo(() => NAMES.slice(0, count), [count]);

  const makeKernel = useCallback(() => {
    const proto = createRaft({ ...DEFAULT_RAFT_CONFIG, preVote });
    proto.invariants = raftInvariants as (n: ReadonlyArray<NodeView<RaftState>>) => ReturnType<typeof raftInvariants>;
    const preset = NET_PRESETS[net];
    return new Kernel<RaftState, RaftCommand>({
      seed,
      protocol: proto,
      nodeIds,
      network: { minLatency: preset.min, maxLatency: preset.max, dropRate: preset.drop },
    });
  }, [seed, nodeIds, net, preVote]);

  const ctrl = useSimulation(makeKernel);
  const snap = ctrl.snapshot;

  const nodesByRole = (role: string) =>
    (snap?.nodes ?? []).filter((n) => n.up && (n.state as RaftState).role === role);
  const leader = nodesByRole('leader').sort(
    (a, b) => (b.state as RaftState).currentTerm - (a.state as RaftState).currentTerm,
  )[0];

  const visual = useCallback(
    (node: NodeRuntime<RaftState>, i: number): NodeVisual => {
      const s = node.state;
      return {
        fill: roleColor[s.role] ?? '#7c9cff',
        ring: nodeColor(i),
        label: node.id,
        sub: `T${s.currentTerm} ${s.role[0].toUpperCase()}`,
        badge: String(s.log.length),
        glow: s.role === 'leader',
        down: !node.up,
      };
    },
    [],
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

  const partitionMinority = () => {
    const half = Math.floor(ctrl.nodeOrder.length / 2);
    const minority = ctrl.nodeOrder.slice(0, half);
    const majority = ctrl.nodeOrder.slice(half);
    ctrl.partition([minority, majority]);
  };

  const killLeader = () => {
    if (leader) {
      ctrl.crash(leader.id);
      setSelected(leader.id);
    }
  };

  const sel = selected ? snap?.nodes.find((n) => n.id === selected) : undefined;

  return (
    <div className="lab">
      <div className="lab-intro">
        <h2>Raft consensus</h2>
        <p>
          A real Raft cluster running on the deterministic kernel. Click a node to inspect it, click a
          link to cut/heal it, propose key/value commands, crash the leader, partition the cluster —
          and watch the safety invariants on the right stay green through all of it.
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
              <button
                className={`btn tiny ${preVote ? 'on' : ''}`}
                onClick={() => setPreVote((v) => !v)}
                title="Add a pre-vote round so a partitioned node can't inflate terms"
              >
                {preVote ? 'on' : 'off'}
              </button>
            </div>
          </div>

          {snap && (
            <NetworkCanvas
              snapshot={snap}
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
            <button className="btn danger" onClick={killLeader} disabled={!leader}>
              ✕ Kill leader
            </button>
            <button className="btn" onClick={partitionMinority}>
              ⌥ Partition
            </button>
            <button className="btn" onClick={ctrl.heal}>
              ⟲ Heal net
            </button>
            {sel && (
              <button
                className={`btn ${sel.up ? 'danger' : 'good'}`}
                onClick={() => (sel.up ? ctrl.crash(sel.id) : ctrl.restart(sel.id))}
              >
                {sel.up ? `✕ Crash ${sel.id}` : `⏼ Restart ${sel.id}`}
              </button>
            )}
          </div>

          {snap && <MetricsBar metrics={snap.metrics} />}
        </div>

        <div className="lab-side">
          <InvariantPanel invariants={ctrl.invariants} />
          {sel ? (
            <RaftInspector node={sel} />
          ) : (
            <div className="inspector empty">
              <div className="panel-head">
                <span>Inspector</span>
              </div>
              <div className="muted pad">Click a node to inspect its Raft state and log.</div>
            </div>
          )}
        </div>
      </div>

      <Timeline log={snap?.log ?? []} />
    </div>
  );
}

function RaftInspector({ node }: { node: NodeRuntime<RaftState> }) {
  const s = node.state;
  return (
    <div className="inspector">
      <div className="panel-head">
        <span>
          Node {node.id} {node.up ? '' : '(down)'}
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
        <span>log len</span>
        <b>{s.log.length}</b>
      </div>

      <div className="sub-head">Log</div>
      <div className="log-strip">
        {s.log.length === 0 && <span className="muted">empty</span>}
        {s.log.map((e, i) => (
          <div
            key={i}
            className={`log-entry ${i < s.commitIndex ? 'committed' : ''}`}
            title={`index ${i + 1}, term ${e.term}`}
          >
            <span className="le-idx">{i + 1}</span>
            <span className="le-term">t{e.term}</span>
            <span className="le-cmd">
              {e.cmd.op === 'set' ? `${e.cmd.key}=${e.cmd.value}` : e.cmd.op === 'del' ? `del ${e.cmd.key}` : 'noop'}
            </span>
          </div>
        ))}
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
