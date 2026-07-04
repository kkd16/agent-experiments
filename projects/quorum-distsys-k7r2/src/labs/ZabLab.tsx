import { useCallback, useEffect, useMemo, useState } from 'react';
import { Kernel } from '../sim/kernel';
import { createZab } from '../protocols/zab/zab';
import { zabInvariants } from '../protocols/zab/invariants';
import {
  DEFAULT_ZAB_CONFIG,
  describeOp,
  fmtZxid,
  lastZxidOf,
  type ZabCommand,
  type ZabPhase,
  type ZabState,
} from '../protocols/zab/types';
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

// The four Zab phases, colour-coded consistently across the canvas, the ladder
// and the inspector.
const PHASE_COLOR: Record<ZabPhase, string> = {
  election: '#c58bff',
  discovery: '#ffd479',
  synchronization: '#ff9d8b',
  broadcast: '#7c9cff',
};
const PHASE_ABBR: Record<ZabPhase, string> = {
  election: 'ELECT',
  discovery: 'DISCOVER',
  synchronization: 'SYNC',
  broadcast: 'BROADCAST',
};
const leaderFill = '#73e08a';

function zabMsgColor(type: string): string {
  if (type === 'ZabVote') return '#c58bff';
  if (type === 'ZabFollowerInfo' || type === 'ZabNewEpoch' || type === 'ZabAckEpoch') return '#ffd479';
  if (type === 'ZabNewLeader' || type === 'ZabAckNewLeader' || type === 'ZabUpToDate') return '#ff9d8b';
  if (type === 'ZabPropose') return '#7c9cff';
  if (type === 'ZabAck') return '#8be9c0';
  if (type === 'ZabCommit') return '#5fd0c8';
  return '#9aa2b1'; // Ping / PingAck
}
const MSG_GLYPH: Record<string, string> = {
  ZabVote: '⚑',
  ZabFollowerInfo: '⇢',
  ZabNewEpoch: 'ε',
  ZabAckEpoch: '✓',
  ZabNewLeader: '★',
  ZabAckNewLeader: '⇉',
  ZabUpToDate: '↥',
  ZabPropose: '▸',
  ZabAck: '✓',
  ZabCommit: '●',
  ZabPing: '·',
  ZabPingAck: '·',
};

const isZabLeader = (s: ZabState) => s.role === 'leading' && s.phase === 'broadcast';

interface ScenarioCfg {
  seed: number;
  count: number;
  net: number;
}
const DEFAULT_SCENARIO: ScenarioCfg = { seed: 42, count: 5, net: 0 };

function readScenarioFromHash(): Partial<ScenarioCfg> {
  try {
    const q = window.location.hash.split('?')[1];
    if (!q) return {};
    const p = new URLSearchParams(q);
    const out: Partial<ScenarioCfg> = {};
    if (p.has('seed')) out.seed = Number(p.get('seed')) || 0;
    if (p.has('n')) out.count = Number(p.get('n')) || 5;
    if (p.has('net')) out.net = Number(p.get('net')) || 0;
    return out;
  } catch {
    return {};
  }
}

const PRESETS: { name: string; cfg: ScenarioCfg }[] = [
  { name: 'Classic (5·LAN)', cfg: { seed: 42, count: 5, net: 0 } },
  { name: 'WAN 5-node', cfg: { seed: 7, count: 5, net: 1 } },
  { name: 'Lossy 7-node', cfg: { seed: 13, count: 7, net: 2 } },
  { name: 'Small (3-node)', cfg: { seed: 3, count: 3, net: 0 } },
];

export function ZabLab() {
  const initial = useMemo(() => ({ ...DEFAULT_SCENARIO, ...readScenarioFromHash() }), []);
  const [seed, setSeed] = useState(initial.seed);
  const [count, setCount] = useState(initial.count);
  const [net, setNet] = useState(initial.net);
  const [selected, setSelected] = useState<string | null>(null);
  const [req, setReq] = useState(1);
  const [copied, setCopied] = useState(false);

  const nodeIds = useMemo(() => NAMES.slice(0, count), [count]);

  useEffect(() => {
    const q = new URLSearchParams({ seed: String(seed), n: String(count), net: String(net) });
    history.replaceState(null, '', `#/zab?${q.toString()}`);
  }, [seed, count, net]);

  const makeKernel = useCallback(() => {
    const proto = createZab(DEFAULT_ZAB_CONFIG);
    proto.invariants = zabInvariants as (n: ReadonlyArray<NodeView<ZabState>>) => ReturnType<typeof zabInvariants>;
    const preset = NET_PRESETS[net];
    return new Kernel<ZabState, ZabCommand>({
      seed,
      protocol: proto,
      nodeIds,
      network: { minLatency: preset.min, maxLatency: preset.max, dropRate: preset.drop },
    });
  }, [seed, nodeIds, net]);

  const ctrl = useSimulation(makeKernel);
  const snapshot = ctrl.snapshot;

  const leader = (snapshot?.nodes ?? [])
    .filter((n) => n.up && isZabLeader(n.state))
    .sort((a, b) => b.state.currentEpoch - a.state.currentEpoch)[0];

  const visual = useCallback((node: NodeRuntime<ZabState>, i: number): NodeVisual => {
    const s = node.state;
    const lead = isZabLeader(s);
    const roleTag = s.role === 'leading' ? 'L' : s.role === 'following' ? 'F' : '?';
    return {
      fill: lead ? leaderFill : PHASE_COLOR[s.phase],
      ring: nodeColor(i),
      label: node.id,
      sub: `e${s.currentEpoch} ${s.phase === 'broadcast' ? roleTag : PHASE_ABBR[s.phase].slice(0, 3)}`,
      badge: `${s.lastCommitted}/${s.history.length}`,
      glow: lead,
      down: !node.up,
    };
  }, []);

  const request = (key: string, value: string) => {
    const target = leader?.id ?? ctrl.nodeOrder[0];
    ctrl.command(target, { type: 'request', clientId: 'c1', requestNumber: req, op: { op: 'set', key, value } });
    setReq((r) => r + 1);
  };

  const quickRequest = () => request('x', String(req));

  const burst = () => {
    ctrl.act((k) => {
      const l = k.views().find((v) => v.up && isZabLeader(v.state));
      const target = l?.id ?? ctrl.nodeOrder[0];
      for (let i = 0; i < 5; i++) {
        k.command(target, { type: 'request', clientId: 'c1', requestNumber: req + i, op: { op: 'set', key: `k${i}`, value: String(req + i) } });
      }
    });
    setReq((r) => r + 5);
  };

  const killLeader = () => {
    if (leader) {
      ctrl.crash(leader.id);
      setSelected(leader.id);
    }
  };

  const forceElection = () => {
    if (selected) ctrl.command(selected, { type: 'elect' });
  };

  const partitionMinority = () => {
    const half = Math.floor(ctrl.nodeOrder.length / 2);
    ctrl.partition([ctrl.nodeOrder.slice(0, half), ctrl.nodeOrder.slice(half)]);
  };

  const applyPreset = (cfg: ScenarioCfg) => {
    setSeed(cfg.seed);
    setCount(cfg.count);
    setNet(cfg.net);
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

  return (
    <div className="lab">
      <div className="lab-intro">
        <h2>ZooKeeper Atomic Broadcast (Zab)</h2>
        <p>
          The consensus engine inside <strong>ZooKeeper</strong> — the fourth canonical crash-fault
          protocol beside Raft, Paxos and VR, and the one built for the <strong>primary-backup</strong>
          pattern. An elected primary turns each write into a transaction stamped with a{' '}
          <strong>
            <code>zxid</code> = (epoch, counter)
          </strong>{' '}
          and atomically broadcasts it, so every replica delivers in the same order — Zab's{' '}
          <strong>primary order</strong> guarantee. It runs four phases: <em>Fast Leader Election</em>{' '}
          picks the peer with the most up-to-date log; <em>Discovery</em> settles a new epoch;{' '}
          <em>Synchronization</em> forces the newest history onto a quorum so everyone starts identical;
          and <em>Broadcast</em> is normal two-phase operation (Propose → Ack → Commit). Unlike VR it keeps
          a <strong>durable log</strong>, so a restarted node recovers by reconciliation, not replay. Kill
          the leader, partition the cluster, restart nodes — and watch five safety invariants stay green.
        </p>
      </div>

      <ControlBar
        ctrl={ctrl}
        seed={seed}
        onSeed={setSeed}
        right={
          <span className={`leader-pill ${leader ? 'has' : 'none'}`}>
            {leader ? `leader: ${leader.id} · epoch ${leader.state.currentEpoch}` : 'no leader (electing)'}
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

          {snapshot && <PhaseLadder nodes={snapshot.nodes} />}

          {snapshot && (
            <NetworkCanvas
              snapshot={snapshot}
              nodeOrder={ctrl.nodeOrder}
              visual={visual}
              messageColor={zabMsgColor}
              messageGlyph={(t) => MSG_GLYPH[t] ?? '•'}
              selected={selected}
              onSelect={setSelected}
              onToggleLink={(a, b) => ctrl.toggleLink(a, b)}
              height={420}
            />
          )}

          <div className="action-row">
            <button className="btn" onClick={quickRequest}>
              ＋ Write x={req}
            </button>
            <button className="btn" onClick={burst}>
              ⚡ Burst ×5
            </button>
            <button className="btn danger" onClick={killLeader} disabled={!leader}>
              ✕ Kill leader
            </button>
            <button className="btn" onClick={forceElection} disabled={!sel}>
              ⚑ Force election{sel ? ` (${sel.id})` : ''}
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

          {snapshot && <MetricsBar metrics={snapshot.metrics} />}
        </div>

        <div className="lab-side">
          <InvariantPanel invariants={ctrl.invariants} />
          {sel ? (
            <ZabInspector node={sel} />
          ) : (
            <div className="inspector empty">
              <div className="panel-head">
                <span>Inspector</span>
              </div>
              <div className="muted pad">Click a node to inspect its Zab state, epoch, log and zxids.</div>
            </div>
          )}
        </div>
      </div>

      <Timeline log={snapshot?.log ?? []} />
    </div>
  );
}

// A compact ladder showing how many servers sit in each of the four phases right
// now — the clearest read on where the ensemble is in the protocol.
function PhaseLadder({ nodes }: { nodes: NodeRuntime<ZabState>[] }) {
  const phases: ZabPhase[] = ['election', 'discovery', 'synchronization', 'broadcast'];
  const counts = new Map<ZabPhase, string[]>();
  for (const p of phases) counts.set(p, []);
  for (const n of nodes) if (n.up) counts.get(n.state.phase)!.push(n.id);
  return (
    <div className="zab-ladder">
      {phases.map((p, i) => (
        <div key={p} className="zab-phase-step" style={{ borderColor: PHASE_COLOR[p] }}>
          <span className="zab-phase-num" style={{ background: PHASE_COLOR[p] }}>
            {i}
          </span>
          <div className="zab-phase-body">
            <div className="zab-phase-name">{PHASE_ABBR[p]}</div>
            <div className="zab-phase-nodes">{counts.get(p)!.length ? counts.get(p)!.join(' ') : '—'}</div>
          </div>
        </div>
      ))}
    </div>
  );
}

function ZabInspector({ node }: { node: NodeRuntime<ZabState> }) {
  const s = node.state;
  const lead = isZabLeader(s);
  const label = lead ? 'leader' : `${s.role} · ${s.phase}`;
  const chipColor = lead ? leaderFill : PHASE_COLOR[s.phase];
  return (
    <div className="inspector">
      <div className="panel-head">
        <span>
          Node {node.id} {node.up ? '' : '(down)'}
        </span>
        <span className="status-pill" style={{ background: chipColor, color: '#0b0c10' }}>
          {label}
        </span>
      </div>
      <div className="kv-grid">
        <span>role · phase</span>
        <b>
          {s.role} · {s.phase}
        </b>
        <span>accepted / current epoch</span>
        <b>
          {s.acceptedEpoch} / {s.currentEpoch}
        </b>
        <span>last zxid</span>
        <b>{fmtZxid(lastZxidOf(s.history))}</b>
        <span>committed / log</span>
        <b>
          {s.lastCommitted} / {s.history.length}
        </b>
        <span>leader</span>
        <b>{s.leader !== null ? s.configuration[s.leader] : '∅'}</b>
        {s.role === 'looking' && (
          <>
            <span>election round</span>
            <b>{s.logicalClock}</b>
            <span>voting for</span>
            <b>
              {s.configuration[s.vote.leader]} (e{s.vote.epoch}, {fmtZxid(s.vote.zxid)})
            </b>
          </>
        )}
      </div>

      <div className="sub-head">History (zxid → op)</div>
      <div className="log-strip">
        {s.history.length === 0 && <span className="muted">empty</span>}
        {s.history.map((e, i) => {
          const idx = i + 1;
          return (
            <div
              key={i}
              className={`log-entry ${idx <= s.lastCommitted ? 'committed' : ''}`}
              title={`zxid ${fmtZxid(e.zxid)}, client ${e.request.clientId}#${e.request.requestNumber}`}
            >
              <span className="le-idx">{idx}</span>
              <span className="le-term">{fmtZxid(e.zxid)}</span>
              <span className="le-cmd">{describeOp(e.request.op)}</span>
            </div>
          );
        })}
      </div>

      {lead && (
        <>
          <div className="sub-head">Live followers (ACK-LD / heartbeat)</div>
          <div className="repl-grid">
            {s.configuration.map((id, idx) => (
              <div key={id} className="repl-row">
                <span>{id}</span>
                <span>{idx === s.serverId ? 'self' : s.followerAlive[String(idx)] !== undefined ? 'alive' : '—'}</span>
                <span>{s.ackLeader.includes(String(idx)) ? '✓' : ''}</span>
              </div>
            ))}
          </div>
        </>
      )}

      {s.phase === 'discovery' && s.role === 'leading' && (
        <div className="kv-grid">
          <span>new epoch</span>
          <b>{s.newEpoch || '(computing)'}</b>
          <span>FOLLOWERINFO</span>
          <b>{Object.keys(s.followerInfo).length}</b>
          <span>ACKEPOCH</span>
          <b>{Object.keys(s.ackEpoch).length}</b>
        </div>
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

      {s.lastReply && (
        <div className="kv-grid">
          <span>last reply</span>
          <b>
            #{s.lastReply.requestNumber} → {s.lastReply.result ?? '∅'}
          </b>
        </div>
      )}
    </div>
  );
}
