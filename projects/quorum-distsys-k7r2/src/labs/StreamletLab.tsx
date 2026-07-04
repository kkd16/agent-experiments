import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Kernel } from '../sim/kernel';
import { createStreamlet } from '../protocols/streamlet/streamlet';
import { streamletInvariants } from '../protocols/streamlet/invariants';
import {
  DEFAULT_STREAMLET_CONFIG,
  faultBudget,
  leaderOf,
  opStr,
  type Command,
  type FaultMode,
  type StreamletCmd,
  type StreamletState,
} from '../protocols/streamlet/types';
import { useSimulation } from '../lib/useSimulation';
import { NetworkCanvas, type NodeVisual } from '../ui/NetworkCanvas';
import { ControlBar } from '../ui/ControlBar';
import { InvariantPanel } from '../ui/InvariantPanel';
import { Timeline } from '../ui/Timeline';
import { MetricsBar } from '../ui/MetricsBar';
import { StreamletChain } from '../ui/StreamletChain';
import type { NodeRuntime, NodeView } from '../sim/types';

const NAMES = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J'];

interface NetPreset {
  name: string;
  min: number;
  max: number;
  drop: number;
  epochLen: number;
}
// Epoch length must clear a proposal + vote round-trip so a block notarizes
// before the next epoch's leader proposes on top of it — so it scales with latency.
const NET_PRESETS: NetPreset[] = [
  { name: 'LAN', min: 20, max: 60, drop: 0, epochLen: 500 },
  { name: 'WAN', min: 80, max: 220, drop: 0, epochLen: 1100 },
  { name: 'Lossy', min: 20, max: 90, drop: 0.1, epochLen: 700 },
];

const FAULT_LABEL: Record<FaultMode, string> = {
  honest: 'honest',
  silent: 'silent',
  equivocate: 'equivocate',
  conflict: 'conflict',
};
const FAULT_COLOR: Record<FaultMode, string> = {
  honest: '#5b6472',
  silent: '#8a6d3b',
  equivocate: '#ff5d6c',
  conflict: '#ff8a3d',
};
const FAULT_HELP: Record<FaultMode, string> = {
  honest: 'follows the protocol exactly',
  silent: 'proposes & votes nothing — its epoch simply passes, no timeout needed',
  equivocate: 'a malicious leader that proposes conflicting blocks at one epoch and double-votes',
  conflict: 'a malicious backup that votes for a corrupted block hash — its votes never count',
};

const LEADER_COLOR = '#73e08a';
const BACKUP_COLOR = '#46506a';

const MSG_COLOR = (t: string): string => {
  if (t === 'Request') return '#e8eaf0';
  if (t === 'Propose') return '#b08bff';
  if (t === 'Vote') return '#7c9cff';
  if (t === 'Status' || t === 'Catchup') return '#3f4b5e';
  return '#9aa2b1';
};

interface ScenarioCfg {
  seed: number;
  count: number;
  net: number;
  faults: Record<string, FaultMode>;
}
const DEFAULT_SCENARIO: ScenarioCfg = { seed: 42, count: 4, net: 0, faults: {} };

function readHash(): Partial<ScenarioCfg> {
  try {
    const q = window.location.hash.split('?')[1];
    if (!q) return {};
    const p = new URLSearchParams(q);
    const out: Partial<ScenarioCfg> = {};
    if (p.has('seed')) out.seed = Number(p.get('seed')) || 0;
    if (p.has('n')) out.count = Number(p.get('n')) || 4;
    if (p.has('net')) out.net = Number(p.get('net')) || 0;
    if (p.has('f')) {
      const faults: Record<string, FaultMode> = {};
      for (const tok of (p.get('f') || '').split(',')) {
        const [id, mode] = tok.split(':');
        if (id && mode) faults[id] = mode as FaultMode;
      }
      out.faults = faults;
    }
    return out;
  } catch {
    return {};
  }
}

const PRESETS: { name: string; hint: string; cfg: ScenarioCfg }[] = [
  { name: 'Healthy (4 · f=1)', hint: 'all honest — watch blocks notarize and a consecutive-epoch triple finalize the middle', cfg: { seed: 42, count: 4, net: 0, faults: {} } },
  { name: 'Silent leader', hint: 'a leader goes dark → its epoch produces nothing and the next epoch just carries on (no view-change!)', cfg: { seed: 3, count: 4, net: 0, faults: { B: 'silent' } } },
  { name: 'Equivocating leader', hint: 'a malicious leader proposes conflicting blocks & double-votes — neither can gather 2f+1, so no fork finalizes', cfg: { seed: 7, count: 4, net: 0, faults: { B: 'equivocate' } } },
  { name: 'Lying backup', hint: 'a backup votes for a bogus block hash — the hash never matches a real block, so its votes are ignored', cfg: { seed: 11, count: 4, net: 0, faults: { D: 'conflict' } } },
  { name: '7 nodes · 2 faulty', hint: 'N=7 tolerates f=2 Byzantine faults at once', cfg: { seed: 13, count: 7, net: 0, faults: { B: 'silent', G: 'conflict' } } },
  { name: 'Beyond f (unsafe!)', hint: 'two faulty in a 4-node cluster EXCEEDS f=1 — safety may now break', cfg: { seed: 5, count: 4, net: 0, faults: { A: 'equivocate', C: 'equivocate' } } },
];

export function StreamletLab() {
  const initial = useMemo(() => ({ ...DEFAULT_SCENARIO, ...readHash() }), []);
  const [seed, setSeed] = useState(initial.seed);
  const [count, setCount] = useState(initial.count);
  const [net, setNet] = useState(initial.net);
  const [faults, setFaults] = useState<Record<string, FaultMode>>(initial.faults);
  const faultsRef = useRef(faults);
  useEffect(() => {
    faultsRef.current = faults;
  }, [faults]);
  const [selected, setSelected] = useState<string | null>(null);
  const [counter, setCounter] = useState(1);
  const [copied, setCopied] = useState(false);

  const nodeIds = useMemo(() => NAMES.slice(0, count), [count]);
  const f = faultBudget(count);

  useEffect(() => {
    const fstr = Object.entries(faults)
      .filter(([, m]) => m !== 'honest')
      .map(([id, m]) => `${id}:${m}`)
      .join(',');
    const q = new URLSearchParams({ seed: String(seed), n: String(count), net: String(net) });
    if (fstr) q.set('f', fstr);
    history.replaceState(null, '', `#/streamlet?${q.toString()}`);
  }, [seed, count, net, faults]);

  const makeKernel = useCallback(() => {
    const p = NET_PRESETS[net];
    const proto = createStreamlet({ ...DEFAULT_STREAMLET_CONFIG, epochLen: p.epochLen });
    proto.invariants = streamletInvariants as (n: ReadonlyArray<NodeView<StreamletState>>) => ReturnType<typeof streamletInvariants>;
    const k = new Kernel<StreamletState, StreamletCmd>({
      seed,
      protocol: proto,
      nodeIds,
      network: { minLatency: p.min, maxLatency: p.max, dropRate: p.drop },
    });
    for (const id of nodeIds) {
      const m = faultsRef.current[id];
      if (m && m !== 'honest') k.command(id, { type: 'set-fault', mode: m });
    }
    return k;
  }, [seed, nodeIds, net]);

  const ctrl = useSimulation(makeKernel);
  const snap = ctrl.snapshot;
  const nodes = useMemo(() => (snap?.nodes ?? []) as NodeRuntime<StreamletState>[], [snap]);

  // The whole cluster shares the clock, so the current epoch is any node's epoch.
  const clusterEpoch = useMemo(() => nodes.reduce((m, n) => Math.max(m, n.state.epoch), 1), [nodes]);
  const leaderId = leaderOf(nodeIds, clusterEpoch);

  const lead = useMemo(
    () =>
      nodes
        .filter((n) => n.state.fault === 'honest')
        .reduce<NodeRuntime<StreamletState> | null>((a, b) => (a && a.state.finalHeight >= b.state.finalHeight ? a : b), null),
    [nodes],
  );
  const maxFinal = lead?.state.finalHeight ?? 0;
  const faultyCount = nodes.filter((n) => n.state.fault !== 'honest').length;

  const committedReal = useMemo(() => (lead ? lead.state.committed.filter((e) => e.cmd.op.op !== 'noop') : []), [lead]);
  const leaderKv = lead?.state.kv ?? {};

  const propose = (cmd: Command) => {
    ctrl.act((k) => {
      for (const id of k.nodeOrder) if (k.isUp(id)) k.command(id, { type: 'request', command: cmd });
    });
    setCounter((c) => c + 1);
  };
  const proposeRandom = () => {
    const key = ['x', 'y', 'z'][counter % 3];
    propose({ cid: 'u' + counter, op: { op: 'set', key, value: String(counter) } });
  };

  const setFault = (id: string, mode: FaultMode) => {
    setFaults((prev) => {
      const nf = { ...prev };
      if (mode === 'honest') delete nf[id];
      else nf[id] = mode;
      faultsRef.current = nf;
      return nf;
    });
    ctrl.command(id, { type: 'set-fault', mode });
  };

  const applyPreset = (cfg: ScenarioCfg) => {
    faultsRef.current = cfg.faults;
    setFaults(cfg.faults);
    setSeed(cfg.seed);
    setCount(cfg.count);
    setNet(cfg.net);
    setSelected(null);
  };

  const copyLink = () => {
    const url = `${location.origin}${location.pathname}${location.hash}`;
    void navigator.clipboard?.writeText(url).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    });
  };

  const visual = useCallback(
    (node: NodeRuntime<StreamletState>): NodeVisual => {
      const s = node.state;
      const isLeader = node.id === leaderId;
      const byz = s.fault !== 'honest';
      return {
        fill: byz ? FAULT_COLOR[s.fault] : isLeader ? LEADER_COLOR : BACKUP_COLOR,
        ring: isLeader ? '#fff' : byz ? '#ff5d6c' : 'rgba(255,255,255,0.18)',
        label: node.id,
        sub: byz ? `⚠ ${s.fault}` : isLeader ? `leader e${s.epoch}` : `e${s.epoch}`,
        badge: s.finalHeight > 0 ? `#${s.finalHeight}` : undefined,
        glow: isLeader || byz,
        down: !node.up,
      };
    },
    [leaderId],
  );

  const sel = selected ? nodes.find((n) => n.id === selected) : undefined;
  const notarizedTipH = sel
    ? Object.keys(sel.state.notarized).reduce((m, h) => {
        const b = sel.state.blocks[h];
        return b ? Math.max(m, b.height) : m;
      }, 0)
    : 0;

  return (
    <div className="lab">
      <div className="lab-intro">
        <h2>Streamlet · textbook BFT, stripped to the bone</h2>
        <p>
          <b>Streamlet</b> (Chan &amp; Shi, 2020) is the simplest Byzantine-fault-tolerant consensus protocol ever
          published — the same guarantees as <b>HotStuff</b> (up to <b>f</b> traitors out of <b>N = 3f+1</b>) with
          almost none of the machinery. <b>No pacemaker, no view-change, no locks, no certificates.</b> Time ticks in
          synchronized <b>epochs</b>, each with a rotating leader. Just three rules: the leader{' '}
          <span style={{ color: MSG_COLOR('Propose') }}>proposes</span> a block extending the longest{' '}
          <b>notarized</b> chain; everyone <span style={{ color: MSG_COLOR('Vote') }}>votes</span> for it if it extends
          a longest notarized chain in their view; a block is <b>notarized</b> at <b>2f+1</b> votes — and the instant a
          notarized chain holds <b>three adjacent blocks with consecutive epochs</b> (e, e+1, e+2), the{' '}
          <span style={{ color: LEADER_COLOR }}>middle one is final</span>, forever. A bad leader? Its epoch just
          produces nothing and the clock rolls on. Corrupt the leader and watch <b>Consistency</b> hold with zero
          view-change code. Safety even holds under <i>full asynchrony</i> — synchrony only buys liveness.
        </p>
      </div>

      <ControlBar
        ctrl={ctrl}
        seed={seed}
        onSeed={setSeed}
        right={
          <span className={`leader-pill ${faultyCount > f ? 'none' : 'has'}`}>
            N={count} · f={f} · {faultyCount} Byzantine{faultyCount > f ? ' (UNSAFE)' : ''}
          </span>
        }
      />

      <div className="lab-grid">
        <div className="lab-main">
          <div className="cluster-toolbar">
            <div className="ctl-group">
              <label>Replicas</label>
              {[4, 7, 10].map((c) => (
                <button key={c} className={`btn tiny ${count === c ? 'on' : ''}`} onClick={() => setCount(c)} title={`N=${c} tolerates f=${faultBudget(c)}`}>
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
            <div className="legend">
              <span><i style={{ background: LEADER_COLOR }} /> leader</span>
              <span><i style={{ background: BACKUP_COLOR }} /> backup</span>
              <span><i style={{ background: FAULT_COLOR.equivocate }} /> Byzantine</span>
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
              height={360}
            />
          )}

          <StreamletChain state={lead?.state ?? null} n={count} />

          <div className="action-row">
            <button className="btn primary" onClick={proposeRandom}>
              ▶ Client request
            </button>
            <button
              className="btn"
              onClick={() => setFault(leaderId, faults[leaderId] === 'equivocate' ? 'honest' : 'equivocate')}
              title="Flip the current epoch's leader into an equivocating Byzantine node — live"
            >
              {faults[leaderId] === 'equivocate' ? `🙂 Heal ${leaderId}` : `😈 Corrupt leader ${leaderId}`}
            </button>
            <button className="btn" onClick={ctrl.reset}>
              ↺ New cluster
            </button>
          </div>

          <div className="action-row">
            {sel ? (
              <>
                <span className="op-target">{sel.id}:</span>
                {(['honest', 'silent', 'equivocate', 'conflict'] as FaultMode[]).map((m) => (
                  <button
                    key={m}
                    className={`btn tiny ${(faults[sel.id] ?? 'honest') === m ? 'on' : ''}`}
                    style={(faults[sel.id] ?? 'honest') === m && m !== 'honest' ? { color: FAULT_COLOR[m] } : undefined}
                    title={FAULT_HELP[m]}
                    onClick={() => setFault(sel.id, m)}
                  >
                    {FAULT_LABEL[m]}
                  </button>
                ))}
                <button className={`btn ${sel.up ? 'danger' : 'good'}`} onClick={() => (sel.up ? ctrl.crash(sel.id) : ctrl.restart(sel.id))}>
                  {sel.up ? `✕ Crash` : `⏼ Restart`}
                </button>
              </>
            ) : (
              <span className="muted">Click a node to set its fault mode or crash it. Click a link's midpoint to cut/heal it.</span>
            )}
          </div>

          {snap && <MetricsBar metrics={snap.metrics} />}
        </div>

        <div className="lab-side">
          <InvariantPanel invariants={ctrl.invariants} title="Streamlet safety (honest replicas)" />

          <div className="lab-aux">
            <div className="panel-head">
              <span>Finalized log</span>
              <span className="muted">≤ #{maxFinal}</span>
            </div>
            <div className="lab-aux-body">
              {committedReal.length === 0 && <div className="muted pad">Nothing finalized yet — send a client request.</div>}
              {committedReal.slice(-12).map((r) => (
                <div key={r.height} className="replica-row">
                  <span className="replica-id">#{r.height}</span>
                  <code className="replica-val" style={{ color: LEADER_COLOR }}>
                    {opStr(r.cmd)}
                  </code>
                  <span className="muted" style={{ fontSize: '0.72em' }}>
                    e{r.epoch}
                    {r.via === 'catchup' ? ' · sync' : ''}
                  </span>
                </div>
              ))}
            </div>
          </div>

          {sel && (
            <div className="lab-aux">
              <div className="panel-head">
                <span>Replica · {sel.id}{sel.up ? '' : ' ✕'}</span>
                <span className="muted" style={{ color: sel.state.fault === 'honest' ? undefined : FAULT_COLOR[sel.state.fault] }}>
                  {sel.state.fault === 'honest' ? 'honest' : `⚠ ${sel.state.fault}`}
                </span>
              </div>
              <div className="lab-aux-body">
                <div className="replica-row">
                  <span className="replica-id">epoch</span>
                  <code className="replica-val">e{sel.state.epoch}{sel.id === leaderId ? ' (leader)' : ''}</code>
                </div>
                <div className="replica-row">
                  <span className="replica-id">finalized</span>
                  <code className="replica-val">≤ #{sel.state.finalHeight}</code>
                </div>
                <div className="replica-row">
                  <span className="replica-id">notarized tip</span>
                  <code className="replica-val">#{notarizedTipH}</code>
                </div>
                <div className="replica-row">
                  <span className="replica-id">note</span>
                  <code className="replica-val" style={{ color: '#9aa2b1' }}>{sel.state.note}</code>
                </div>
              </div>
            </div>
          )}

          <div className="lab-aux">
            <div className="panel-head">
              <span>Replicated KV (most-advanced honest)</span>
            </div>
            <div className="lab-aux-body">
              {Object.keys(leaderKv).length === 0 && <div className="muted pad">empty</div>}
              {Object.keys(leaderKv)
                .sort()
                .map((k) => (
                  <div key={k} className="replica-row">
                    <span className="replica-id">{k}</span>
                    <code className="replica-val">{leaderKv[k]}</code>
                  </div>
                ))}
            </div>
          </div>
        </div>
      </div>

      <Timeline log={snap?.log ?? []} />
    </div>
  );
}
