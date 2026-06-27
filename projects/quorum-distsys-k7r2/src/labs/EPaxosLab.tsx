import { useCallback, useEffect, useMemo, useState } from 'react';
import { Kernel } from '../sim/kernel';
import { createEPaxos } from '../protocols/epaxos/epaxos';
import { epaxosInvariants, convergenceGauge } from '../protocols/epaxos/invariants';
import {
  DEFAULT_EPAXOS_CONFIG,
  cmdStr,
  fastQuorum,
  slowQuorum,
  faultBudget,
  type Command,
  type EPaxosCmd,
  type EPaxosState,
} from '../protocols/epaxos/types';
import { useSimulation } from '../lib/useSimulation';
import { NetworkCanvas, type NodeVisual } from '../ui/NetworkCanvas';
import { DepGraph } from '../ui/DepGraph';
import { ControlBar } from '../ui/ControlBar';
import { InvariantPanel } from '../ui/InvariantPanel';
import { Timeline } from '../ui/Timeline';
import { MetricsBar } from '../ui/MetricsBar';
import type { InvariantResult, NodeRuntime, NodeView } from '../sim/types';

const NAMES = ['A', 'B', 'C', 'D', 'E', 'F', 'G'];
const KEYS = ['x', 'y', 'z', 'w'];

interface NetPreset {
  name: string;
  min: number;
  max: number;
  drop: number;
}
const NET_PRESETS: NetPreset[] = [
  { name: 'LAN', min: 20, max: 60, drop: 0 },
  { name: 'WAN', min: 80, max: 200, drop: 0 },
  { name: 'Lossy', min: 20, max: 80, drop: 0.12 },
];

const MSG_COLOR = (t: string): string => {
  if (t === 'PreAccept') return '#b08bff';
  if (t === 'PreAcceptOk') return '#d3b8ff';
  if (t === 'Accept') return '#7c9cff';
  if (t === 'AcceptOk') return '#5bd6c8';
  if (t === 'Commit') return '#73e08a';
  if (t === 'Prepare') return '#ffb454';
  if (t === 'PrepareOk') return '#ffd089';
  return '#9aa2b1';
};

interface ScenarioCfg {
  seed: number;
  count: number;
  net: number;
}
const DEFAULT_SCENARIO: ScenarioCfg = { seed: 42, count: 5, net: 0 };

function readHash(): Partial<ScenarioCfg> {
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

const PRESETS: { name: string; hint: string; cfg: ScenarioCfg }[] = [
  { name: 'Classic (5·LAN)', hint: 'no conflicts — every command commits on the unanimous fast path', cfg: { seed: 42, count: 5, net: 0 } },
  { name: 'WAN 5-node', hint: 'higher latency, still leaderless — any replica commits its own commands', cfg: { seed: 7, count: 5, net: 1 } },
  { name: 'Lossy 7-node', hint: '12% drops on a bigger cluster — watch the slow path + recovery kick in', cfg: { seed: 13, count: 7, net: 2 } },
];

export function EPaxosLab() {
  const initial = useMemo(() => ({ ...DEFAULT_SCENARIO, ...readHash() }), []);
  const [seed, setSeed] = useState(initial.seed);
  const [count, setCount] = useState(initial.count);
  const [net, setNet] = useState(initial.net);
  const [selected, setSelected] = useState<string | null>(null);
  const [viewFrom, setViewFrom] = useState<string | null>(null);
  const [selInst, setSelInst] = useState<string | null>(null);
  const [counter, setCounter] = useState(1);
  const [copied, setCopied] = useState(false);

  const nodeIds = useMemo(() => NAMES.slice(0, count), [count]);

  useEffect(() => {
    const q = new URLSearchParams({ seed: String(seed), n: String(count), net: String(net) });
    history.replaceState(null, '', `#/epaxos?${q.toString()}`);
  }, [seed, count, net]);

  const makeKernel = useCallback(() => {
    const proto = createEPaxos(DEFAULT_EPAXOS_CONFIG);
    proto.invariants = ((ns: ReadonlyArray<NodeView<EPaxosState>>): InvariantResult[] => [
      ...epaxosInvariants(ns),
      convergenceGauge(ns),
    ]) as typeof proto.invariants;
    const p = NET_PRESETS[net];
    return new Kernel<EPaxosState, EPaxosCmd>({
      seed,
      protocol: proto,
      nodeIds,
      network: { minLatency: p.min, maxLatency: p.max, dropRate: p.drop },
    });
  }, [seed, nodeIds, net]);

  const ctrl = useSimulation(makeKernel);
  const snap = ctrl.snapshot;
  const nodes = useMemo(() => (snap?.nodes ?? []) as NodeRuntime<EPaxosState>[], [snap]);

  const fastTotal = nodes.reduce((a, n) => a + n.state.fastCommits, 0);
  const slowTotal = nodes.reduce((a, n) => a + n.state.slowCommits, 0);

  const viewNode = useMemo(() => {
    const id = viewFrom ?? selected ?? nodeIds.find((n) => nodes.find((x) => x.id === n)?.up) ?? nodeIds[0];
    return nodes.find((n) => n.id === id) ?? nodes[0];
  }, [viewFrom, selected, nodeIds, nodes]);

  const propose = (target: string, cmd: Command) => {
    ctrl.command(target, { type: 'propose', target, cmd });
    setCounter((c) => c + 1);
  };

  const proposeRandom = () => {
    const up = nodes.filter((n) => n.up).map((n) => n.id);
    const tgt = (selected && up.includes(selected) ? selected : up[counter % Math.max(1, up.length)]) ?? nodeIds[0];
    const key = KEYS[counter % KEYS.length];
    propose(tgt, { op: 'set', key, value: String(counter), cid: 'u' + counter });
  };

  const conflictBurst = () => {
    // Propose conflicting writes to the SAME key from every live replica at once:
    // each replica becomes a command leader, their dep sets diverge, the fast path
    // is denied and they resolve on the slow path — often forming a cycle.
    const up = nodes.filter((n) => n.up).map((n) => n.id);
    const key = KEYS[counter % KEYS.length];
    up.forEach((id, i) => propose(id, { op: 'set', key, value: `${id}${counter + i}`, cid: `b${id}${counter}` }));
  };

  const visual = useCallback(
    (node: NodeRuntime<EPaxosState>): NodeVisual => {
      const s = node.state;
      const leading = Object.keys(s.lead).length;
      const recovering = Object.keys(s.recover).length;
      const owned = Object.keys(s.inst).filter((k) => s.inst[k].owner === node.id).length;
      return {
        fill: recovering > 0 ? '#ffb454' : leading > 0 ? '#b08bff' : '#5b8def',
        ring: node.id === viewNode?.id ? '#fff' : 'rgba(255,255,255,0.2)',
        label: node.id,
        sub: `${owned} own · ${s.executedOrder.length} ex`,
        badge: leading > 0 ? `▶${leading}` : recovering > 0 ? `⟳${recovering}` : undefined,
        glow: leading > 0 || recovering > 0,
        down: !node.up,
      };
    },
    [viewNode],
  );

  const sel = selected ? nodes.find((n) => n.id === selected) : undefined;
  const fq = fastQuorum(count);
  const sq = slowQuorum(count);

  const applyPreset = (cfg: ScenarioCfg) => {
    setSeed(cfg.seed);
    setCount(cfg.count);
    setNet(cfg.net);
  };

  const copyLink = () => {
    const url = `${location.origin}${location.pathname}${location.hash}`;
    void navigator.clipboard?.writeText(url).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    });
  };

  const selInstRec = selInst && viewNode ? viewNode.state.inst[selInst] : undefined;

  return (
    <div className="lab">
      <div className="lab-intro">
        <h2>EPaxos · leaderless consensus by dependency graph</h2>
        <p>
          Raft and Paxos route every command through one leader. <b>EPaxos</b> (Egalitarian Paxos) throws the
          leader out: <em>any</em> replica commits a command directly into its own slice of a shared instance
          space. It never imposes a total order — it records, per command, the set of interfering commands it
          has seen as a <b>dependency graph</b>, and every replica later linearises that graph identically by
          computing its <b>strongly-connected components</b>. With no conflicts a command commits in one
          round-trip to a <span style={{ color: MSG_COLOR('PreAccept') }}>fast quorum</span> (here, unanimous);
          a conflict falls back to an explicit{' '}
          <span style={{ color: MSG_COLOR('Accept') }}>Accept</span> round, and a crashed command-leader's
          instance is finished by anyone via <span style={{ color: MSG_COLOR('Prepare') }}>Prepare</span>. The
          live invariants prove every replica decides each instance identically and runs interfering commands
          in the same order.
        </p>
      </div>

      <ControlBar
        ctrl={ctrl}
        seed={seed}
        onSeed={setSeed}
        right={
          <span className="leader-pill has" title="EPaxos has no leader — every replica is equal">
            fast {fastTotal} · slow {slowTotal}
          </span>
        }
      />

      <div className="lab-grid">
        <div className="lab-main">
          <div className="cluster-toolbar">
            <div className="ctl-group">
              <label>Nodes</label>
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
            <div className="ctl-group" title="N = 2F+1. Fast path needs the whole cluster to agree; slow path & recovery need a simple majority.">
              <label>Quorums</label>
              <span className="muted" style={{ fontSize: 11 }}>
                F={faultBudget(count)} · fast {count} · maj {sq} <span style={{ opacity: 0.6 }}>(EPaxos FQ {fq})</span>
              </span>
            </div>
          </div>

          <div className="cluster-toolbar">
            <div className="ctl-group">
              <label>Scenario</label>
              {PRESETS.map((p) => (
                <button key={p.name} className="btn tiny" title={p.hint} onClick={() => applyPreset(p.cfg)}>
                  {p.name}
                </button>
              ))}
            </div>
            <div className="ctl-group">
              <label>Graph view</label>
              {nodeIds.map((id) => (
                <button key={id} className={`btn tiny ${viewNode?.id === id ? 'on' : ''}`} onClick={() => setViewFrom(id)}>
                  {id}
                </button>
              ))}
            </div>
            <button className="btn tiny" onClick={copyLink} title="Copy a shareable link to this exact scenario">
              {copied ? '✓ copied' : '⎘ link'}
            </button>
          </div>

          {snap && (
            <NetworkCanvas
              snapshot={snap}
              nodeOrder={ctrl.nodeOrder}
              visual={visual}
              selected={selected}
              onSelect={setSelected}
              onToggleLink={(a, b) => ctrl.toggleLink(a, b)}
              messageColor={MSG_COLOR}
              height={320}
            />
          )}

          <div className="action-row">
            <button className="btn primary" onClick={proposeRandom}>
              ▶ Propose a command
            </button>
            <button className="btn" onClick={conflictBurst} title="Every live replica proposes a conflicting write to one key at once — forces the slow path and dependency cycles">
              ⚔ Conflict burst
            </button>
            <button className="btn" onClick={ctrl.reset}>
              ↺ New cluster
            </button>
          </div>

          <div className="action-row">
            {sel ? (
              <>
                <span className="op-target">{sel.id}:</span>
                <button className="btn" onClick={() => propose(sel.id, { op: 'set', key: KEYS[counter % KEYS.length], value: String(counter), cid: 's' + counter })}>
                  propose here
                </button>
                <button className={`btn ${sel.up ? 'danger' : 'good'}`} onClick={() => (sel.up ? ctrl.crash(sel.id) : ctrl.restart(sel.id))}>
                  {sel.up ? `✕ Crash ${sel.id}` : `⏼ Restart ${sel.id}`}
                </button>
                {selInst && (
                  <button className="btn" onClick={() => ctrl.command(sel.id, { type: 'recover', key: selInst })} title="Force this replica to recover the selected instance via explicit Prepare">
                    ⟳ Recover {selInst}
                  </button>
                )}
              </>
            ) : (
              <span className="muted">Click a node to inspect/crash it, or a link's midpoint to cut/heal it. Click an instance in the graph to inspect it.</span>
            )}
          </div>

          {snap && <MetricsBar metrics={snap.metrics} />}

          <div className="lab-aux" style={{ marginTop: 10 }}>
            <div className="panel-head">
              <span>Dependency graph · from {viewNode?.id ?? '—'}</span>
              <span className="muted">
                <i style={{ display: 'inline-block', width: 8, height: 8, borderRadius: 8, background: '#6b7488', marginRight: 3 }} /> pre-accepted{' '}
                <i style={{ display: 'inline-block', width: 8, height: 8, borderRadius: 8, background: '#b08bff', margin: '0 3px 0 6px' }} /> accepted{' '}
                <i style={{ display: 'inline-block', width: 8, height: 8, borderRadius: 8, background: '#7c9cff', margin: '0 3px 0 6px' }} /> committed{' '}
                <i style={{ display: 'inline-block', width: 8, height: 8, borderRadius: 8, background: '#73e08a', margin: '0 3px 0 6px' }} /> executed
              </span>
            </div>
            {viewNode && (
              <DepGraph
                inst={viewNode.state.inst}
                owners={ctrl.nodeOrder}
                executedOrder={viewNode.state.executedOrder}
                selected={selInst}
                onSelect={setSelInst}
                height={300}
              />
            )}
          </div>
        </div>

        <div className="lab-side">
          <InvariantPanel invariants={ctrl.invariants} title="EPaxos safety" />

          {selInstRec && selInst && (
            <div className="lab-aux">
              <div className="panel-head">
                <span>Instance · {selInst}</span>
                <span className="muted">{selInstRec.status}</span>
              </div>
              <div className="lab-aux-body">
                <div className="replica-row">
                  <span className="replica-id">command</span>
                  <code className="replica-val">{cmdStr(selInstRec.cmd)}</code>
                </div>
                <div className="replica-row">
                  <span className="replica-id">seq</span>
                  <code className="replica-val">{selInstRec.seq}</code>
                </div>
                <div className="replica-row">
                  <span className="replica-id">deps</span>
                  <code className="replica-val" style={{ color: '#9aa2b1' }}>{selInstRec.deps.length ? selInstRec.deps.join(' ') : '—'}</code>
                </div>
                <div className="replica-row">
                  <span className="replica-id">ballot</span>
                  <code className="replica-val">{selInstRec.acceptedBallot.b}.{selInstRec.acceptedBallot.node}</code>
                </div>
              </div>
            </div>
          )}

          {viewNode && (
            <div className="lab-aux">
              <div className="panel-head">
                <span>Executed log · {viewNode.id}{viewNode.up ? '' : ' ✕'}</span>
                <span className="muted">{viewNode.state.executedOrder.length} applied</span>
              </div>
              <div className="lab-aux-body">
                {viewNode.state.executedOrder.length === 0 && <div className="muted pad">Nothing executed yet — propose a command.</div>}
                {viewNode.state.executedOrder.slice(-14).map((k, i) => {
                  const it = viewNode.state.inst[k];
                  const n = viewNode.state.executedOrder.length - Math.min(14, viewNode.state.executedOrder.length) + i + 1;
                  return (
                    <div key={k} className="replica-row" onClick={() => setSelInst(k)} style={{ cursor: 'pointer' }}>
                      <span className="replica-id">{n}. {k}</span>
                      <code className="replica-val" style={{ color: MSG_COLOR('Commit') }}>{cmdStr(it?.cmd ?? null)}</code>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {viewNode && (
            <div className="lab-aux">
              <div className="panel-head">
                <span>Replicated KV · {viewNode.id}</span>
              </div>
              <div className="lab-aux-body">
                {Object.keys(viewNode.state.kv).length === 0 && <div className="muted pad">empty</div>}
                {Object.keys(viewNode.state.kv)
                  .sort()
                  .map((k) => (
                    <div key={k} className="replica-row">
                      <span className="replica-id">{k}</span>
                      <code className="replica-val">{viewNode.state.kv[k]}</code>
                    </div>
                  ))}
              </div>
            </div>
          )}
        </div>
      </div>

      <Timeline log={snap?.log ?? []} />
    </div>
  );
}
