import { useCallback, useEffect, useMemo, useState } from 'react';
import { Kernel } from '../sim/kernel';
import { createVR } from '../protocols/vr/vr';
import { vrInvariants } from '../protocols/vr/invariants';
import { DEFAULT_VR_CONFIG, describeOp, primaryOf, type VrCommand, type VrState } from '../protocols/vr/types';
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

const statusColor: Record<string, string> = {
  normal: '#7c9cff',
  'view-change': '#ffd479',
  recovering: '#c58bff',
};
const primaryFill = '#73e08a';

function vrMsgColor(type: string): string {
  if (type === 'VrPrepare') return '#7c9cff';
  if (type === 'VrPrepareOk') return '#8be9c0';
  if (type === 'VrCommit') return '#5fd0c8';
  if (type === 'VrStartViewChange' || type === 'VrDoViewChange' || type === 'VrStartView') return '#ffd479';
  if (type === 'VrRecovery' || type === 'VrRecoveryResponse') return '#ff9d8b';
  if (type === 'VrGetState' || type === 'VrNewState') return '#b08bff';
  return '#9aa2b1';
}
const MSG_GLYPH: Record<string, string> = {
  VrPrepare: '▸',
  VrPrepareOk: '✓',
  VrCommit: '●',
  VrStartViewChange: '⟲',
  VrDoViewChange: '⇉',
  VrStartView: '★',
  VrGetState: '?',
  VrNewState: '↧',
  VrRecovery: '✚',
  VrRecoveryResponse: '✚',
};

const isVrPrimary = (s: VrState) => primaryOf(s.view, s.configuration) === s.configuration[s.replicaNumber];

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

export function VrLab() {
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
    history.replaceState(null, '', `#/vr?${q.toString()}`);
  }, [seed, count, net]);

  const makeKernel = useCallback(() => {
    const proto = createVR(DEFAULT_VR_CONFIG);
    proto.invariants = vrInvariants as (n: ReadonlyArray<NodeView<VrState>>) => ReturnType<typeof vrInvariants>;
    const preset = NET_PRESETS[net];
    return new Kernel<VrState, VrCommand>({
      seed,
      protocol: proto,
      nodeIds,
      network: { minLatency: preset.min, maxLatency: preset.max, dropRate: preset.drop },
    });
  }, [seed, nodeIds, net]);

  const ctrl = useSimulation(makeKernel);
  const snapshot = ctrl.snapshot;

  const primary = (snapshot?.nodes ?? [])
    .filter((n) => n.up && n.state.status === 'normal' && isVrPrimary(n.state))
    .sort((a, b) => b.state.view - a.state.view)[0];

  const visual = useCallback((node: NodeRuntime<VrState>, i: number): NodeVisual => {
    const s = node.state;
    const prim = s.status === 'normal' && isVrPrimary(s);
    return {
      fill: prim ? primaryFill : statusColor[s.status] ?? '#7c9cff',
      ring: nodeColor(i),
      label: node.id,
      sub: `v${s.view} ${prim ? 'P' : s.status === 'view-change' ? 'VC' : s.status === 'recovering' ? 'REC' : 'B'}`,
      badge: `${s.commitNumber}/${s.opNumber}`,
      glow: prim,
      down: !node.up,
    };
  }, []);

  const request = (key: string, value: string) => {
    const target = primary?.id ?? ctrl.nodeOrder[0];
    ctrl.command(target, { type: 'request', clientId: 'c1', requestNumber: req, op: { op: 'set', key, value } });
    setReq((r) => r + 1);
  };

  const quickRequest = () => request('x', String(req));

  const burst = () => {
    ctrl.act((k) => {
      const p = k.views().find((v) => v.up && v.state.status === 'normal' && isVrPrimary(v.state));
      const target = p?.id ?? ctrl.nodeOrder[0];
      for (let i = 0; i < 5; i++) {
        k.command(target, { type: 'request', clientId: 'c1', requestNumber: req + i, op: { op: 'set', key: `k${i}`, value: String(req + i) } });
      }
    });
    setReq((r) => r + 5);
  };

  const killPrimary = () => {
    if (primary) {
      ctrl.crash(primary.id);
      setSelected(primary.id);
    }
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
        <h2>Viewstamped Replication</h2>
        <p>
          The third canonical crash-fault consensus protocol beside Raft and Paxos — and the one that
          keeps <strong>no state on disk</strong>. A primary (replica <code>view mod N</code>) drives{' '}
          <strong>normal operation</strong> (Prepare / PrepareOk / Commit); when it goes quiet the backups
          run a <strong>view change</strong> (StartViewChange → DoViewChange → StartView) to rotate to the
          next primary, rebuilding the log from the most up-to-date replica in a quorum; and a crashed
          replica runs an explicit <strong>recovery</strong> to rebuild its state from its peers before it
          may participate again. Crash the primary, partition the cluster, restart nodes — and watch the
          four safety invariants stay green.
        </p>
      </div>

      <ControlBar
        ctrl={ctrl}
        seed={seed}
        onSeed={setSeed}
        right={
          <span className={`leader-pill ${primary ? 'has' : 'none'}`}>
            {primary ? `primary: ${primary.id} · view ${primary.state.view}` : 'no primary'}
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

          {snapshot && (
            <NetworkCanvas
              snapshot={snapshot}
              nodeOrder={ctrl.nodeOrder}
              visual={visual}
              messageColor={vrMsgColor}
              messageGlyph={(t) => MSG_GLYPH[t] ?? '•'}
              selected={selected}
              onSelect={setSelected}
              onToggleLink={(a, b) => ctrl.toggleLink(a, b)}
              height={420}
            />
          )}

          <div className="action-row">
            <button className="btn" onClick={quickRequest}>
              ＋ Request x={req}
            </button>
            <button className="btn" onClick={burst}>
              ⚡ Burst ×5
            </button>
            <button className="btn danger" onClick={killPrimary} disabled={!primary}>
              ✕ Kill primary
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
            <VrInspector node={sel} />
          ) : (
            <div className="inspector empty">
              <div className="panel-head">
                <span>Inspector</span>
              </div>
              <div className="muted pad">Click a node to inspect its VR state, log and replies.</div>
            </div>
          )}
        </div>
      </div>

      <Timeline log={snapshot?.log ?? []} />
    </div>
  );
}

function VrInspector({ node }: { node: NodeRuntime<VrState> }) {
  const s = node.state;
  const prim = s.status === 'normal' && isVrPrimary(s);
  const label = prim ? 'primary' : s.status;
  return (
    <div className="inspector">
      <div className="panel-head">
        <span>
          Node {node.id} {node.up ? '' : '(down)'}
        </span>
        <span className="status-pill" style={{ background: prim ? primaryFill : statusColor[s.status], color: '#0b0c10' }}>
          {label}
        </span>
      </div>
      <div className="kv-grid">
        <span>view</span>
        <b>{s.view}</b>
        <span>status</span>
        <b>{s.status}</b>
        <span>op-number</span>
        <b>{s.opNumber}</b>
        <span>commit-number</span>
        <b>{s.commitNumber}</b>
        <span>primary?</span>
        <b>{prim ? 'yes' : primaryOf(s.view, s.configuration)}</b>
        <span>last-normal view</span>
        <b>{s.lastNormalView}</b>
      </div>

      <div className="sub-head">Log</div>
      <div className="log-strip">
        {s.log.length === 0 && <span className="muted">empty</span>}
        {s.log.map((e, i) => {
          const idx = i + 1;
          return (
            <div
              key={i}
              className={`log-entry ${idx <= s.commitNumber ? 'committed' : ''}`}
              title={`op ${idx}, created in view ${e.view}, client ${e.request.clientId}#${e.request.requestNumber}`}
            >
              <span className="le-idx">{idx}</span>
              <span className="le-term">v{e.view}</span>
              <span className="le-cmd">{describeOp(e.request.op)}</span>
            </div>
          );
        })}
      </div>

      {prim && (
        <>
          <div className="sub-head">PrepareOk (replica → highest op acked)</div>
          <div className="repl-grid">
            {s.configuration.map((id, idx) => (
              <div key={id} className="repl-row">
                <span>{id}</span>
                <span>{idx === s.replicaNumber ? 'self' : 'ack'}</span>
                <span>{s.prepareOk[String(idx)] ?? 0}</span>
              </div>
            ))}
          </div>
        </>
      )}

      {s.status === 'recovering' && (
        <div className="kv-grid">
          <span>recovery nonce</span>
          <b>{s.recoveryNonce}</b>
          <span>responses</span>
          <b>{Object.keys(s.recoveryResponses).length}</b>
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
