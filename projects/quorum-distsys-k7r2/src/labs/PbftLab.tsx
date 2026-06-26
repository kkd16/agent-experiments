import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Kernel } from '../sim/kernel';
import { createPbft } from '../protocols/pbft/pbft';
import { pbftInvariants } from '../protocols/pbft/invariants';
import {
  DEFAULT_PBFT_CONFIG,
  faultBudget,
  opStr,
  type FaultMode,
  type PbftCmd,
  type PbftState,
  type ClientRequest,
} from '../protocols/pbft/types';
import { useSimulation } from '../lib/useSimulation';
import { NetworkCanvas, type NodeVisual } from '../ui/NetworkCanvas';
import { ControlBar } from '../ui/ControlBar';
import { InvariantPanel } from '../ui/InvariantPanel';
import { Timeline } from '../ui/Timeline';
import { MetricsBar } from '../ui/MetricsBar';
import type { NodeRuntime, NodeView } from '../sim/types';

const NAMES = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J'];

interface NetPreset {
  name: string;
  min: number;
  max: number;
  drop: number;
}
const NET_PRESETS: NetPreset[] = [
  { name: 'LAN', min: 20, max: 60, drop: 0 },
  { name: 'WAN', min: 80, max: 220, drop: 0 },
  { name: 'Lossy', min: 20, max: 90, drop: 0.1 },
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
  silent: 'sends nothing — a primary forces a view change, a backup withholds its votes',
  equivocate: 'a malicious primary that sends conflicting requests for the same sequence number',
  conflict: 'a malicious backup that votes for a corrupted digest — its votes never count',
};

const PRIMARY_COLOR = '#73e08a';
const BACKUP_COLOR = '#46506a';

const MSG_COLOR = (t: string): string => {
  if (t === 'Request') return '#e8eaf0';
  if (t === 'PrePrepare') return '#b08bff';
  if (t === 'Prepare') return '#7c9cff';
  if (t === 'Commit') return '#5bd6c8';
  if (t === 'ViewChange') return '#ffb454';
  if (t === 'NewView') return '#ffd479';
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
  { name: 'Healthy (4 · f=1)', hint: 'all honest — watch the three-phase commit in one round', cfg: { seed: 42, count: 4, net: 0, faults: {} } },
  { name: 'Silent primary', hint: 'the primary goes dark → backups time out → view change → recover', cfg: { seed: 3, count: 4, net: 0, faults: { A: 'silent' } } },
  { name: 'Equivocating primary', hint: 'a malicious primary sends conflicting orders — agreement still holds', cfg: { seed: 7, count: 4, net: 0, faults: { A: 'equivocate' } } },
  { name: 'Lying backup', hint: 'a backup votes for a bogus digest — its votes are simply ignored', cfg: { seed: 11, count: 4, net: 0, faults: { D: 'conflict' } } },
  { name: '7 nodes · 2 faulty', hint: 'N=7 tolerates f=2 Byzantine faults at once', cfg: { seed: 13, count: 7, net: 0, faults: { A: 'silent', G: 'conflict' } } },
  { name: 'Beyond f (unsafe!)', hint: 'two faulty in a 4-node cluster EXCEEDS f=1 — safety may now break', cfg: { seed: 5, count: 4, net: 0, faults: { A: 'equivocate', D: 'conflict' } } },
];

export function PbftLab() {
  const initial = useMemo(() => ({ ...DEFAULT_SCENARIO, ...readHash() }), []);
  const [seed, setSeed] = useState(initial.seed);
  const [count, setCount] = useState(initial.count);
  const [net, setNet] = useState(initial.net);
  const [faults, setFaults] = useState<Record<string, FaultMode>>(initial.faults);
  // A mirror of `faults` that the kernel factory can read without being a
  // dependency (so a live fault toggle doesn't rebuild the running cluster).
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
    history.replaceState(null, '', `#/pbft?${q.toString()}`);
  }, [seed, count, net, faults]);

  // The faults are applied at construction (so a reset / seed change preserves
  // them) but are NOT a dependency — toggling one mid-run is done live via a
  // command, so the run keeps going and you watch safety hold in real time.
  const makeKernel = useCallback(() => {
    const proto = createPbft(DEFAULT_PBFT_CONFIG);
    proto.invariants = pbftInvariants as (n: ReadonlyArray<NodeView<PbftState>>) => ReturnType<typeof pbftInvariants>;
    const p = NET_PRESETS[net];
    const k = new Kernel<PbftState, PbftCmd>({
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
  const nodes = useMemo(() => (snap?.nodes ?? []) as NodeRuntime<PbftState>[], [snap]);

  // The cluster's working view = the furthest-progressed honest replica's view.
  const clusterView = useMemo(() => {
    let v = 0;
    let bestExec = -1;
    for (const n of nodes) {
      if (n.state.fault !== 'honest') continue;
      if (n.state.lastExec > bestExec || (n.state.lastExec === bestExec && n.state.view > v)) {
        bestExec = n.state.lastExec;
        v = n.state.view;
      }
    }
    return v;
  }, [nodes]);
  const primaryId = nodeIds[clusterView % nodeIds.length];

  const maxExec = useMemo(() => Math.max(0, ...nodes.filter((n) => n.state.fault === 'honest').map((n) => n.state.lastExec)), [nodes]);
  const faultyCount = nodes.filter((n) => n.state.fault !== 'honest').length;

  // A merged view of the executed log across honest replicas.
  const execLog = useMemo(() => {
    const lead = nodes
      .filter((n) => n.state.fault === 'honest')
      .reduce<NodeRuntime<PbftState> | null>((a, b) => (a && a.state.lastExec >= b.state.lastExec ? a : b), null);
    return lead ? lead.state.execLog : [];
  }, [nodes]);
  const leaderKv = useMemo(() => {
    const lead = nodes
      .filter((n) => n.state.fault === 'honest')
      .reduce<NodeRuntime<PbftState> | null>((a, b) => (a && a.state.lastExec >= b.state.lastExec ? a : b), null);
    return lead ? lead.state.kv : {};
  }, [nodes]);

  const propose = (req: ClientRequest) => {
    // The client multicasts to every replica (so backups can detect a dead primary).
    ctrl.act((k) => {
      for (const id of k.nodeOrder) if (k.isUp(id)) k.command(id, { type: 'request', request: req });
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
    ctrl.command(id, { type: 'set-fault', mode }); // live, no rebuild
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
    (node: NodeRuntime<PbftState>): NodeVisual => {
      const s = node.state;
      const isPrimary = node.id === primaryId;
      const byz = s.fault !== 'honest';
      return {
        fill: byz ? FAULT_COLOR[s.fault] : isPrimary ? PRIMARY_COLOR : BACKUP_COLOR,
        ring: isPrimary ? '#fff' : byz ? '#ff5d6c' : 'rgba(255,255,255,0.18)',
        label: node.id,
        sub: s.inViewChange ? `vc→v${s.targetView}` : byz ? `⚠ ${s.fault}` : isPrimary ? `primary v${s.view}` : `v${s.view}`,
        badge: s.lastExec > 0 ? `#${s.lastExec}` : undefined,
        glow: isPrimary || byz,
        down: !node.up,
      };
    },
    [primaryId],
  );

  const sel = selected ? nodes.find((n) => n.id === selected) : undefined;
  const selSlots = sel
    ? Object.keys(sel.state.log)
        .map(Number)
        .sort((a, b) => a - b)
        .slice(-8)
    : [];

  return (
    <div className="lab">
      <div className="lab-intro">
        <h2>PBFT · consensus that survives traitors</h2>
        <p>
          Every other lab assumes a broken node simply <em>stops</em>. <b>PBFT</b> (Castro &amp; Liskov, 1999)
          assumes the worst: up to <b>f</b> replicas can be <b>Byzantine</b> — silent, two-faced, or actively
          lying — and a cluster of <b>N = 3f + 1</b> still agrees on one total order. The magic is{' '}
          <em>quorum intersection</em>: any two <b>2f+1</b> quorums share an honest replica that refuses to
          vouch for two conflicting things. Three phases turn that into a protocol —{' '}
          <span style={{ color: MSG_COLOR('PrePrepare') }}>pre-prepare</span> (the primary orders a request),{' '}
          <span style={{ color: MSG_COLOR('Prepare') }}>prepare</span> (agree on the order), and{' '}
          <span style={{ color: MSG_COLOR('Commit') }}>commit</span> (make it irrevocable). Make the primary
          equivocate and watch the <b>Agreement</b> invariant stay green — then push past f and watch it break.
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
              <span><i style={{ background: PRIMARY_COLOR }} /> primary</span>
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
              height={400}
            />
          )}

          <div className="action-row">
            <button className="btn primary" onClick={proposeRandom}>
              ▶ Client request
            </button>
            <button
              className="btn"
              onClick={() => setFault(primaryId, faults[primaryId] === 'equivocate' ? 'honest' : 'equivocate')}
              title="Flip the current primary into an equivocating Byzantine node — live"
            >
              {faults[primaryId] === 'equivocate' ? `🙂 Heal ${primaryId}` : `😈 Corrupt primary ${primaryId}`}
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
          <InvariantPanel invariants={ctrl.invariants} title="PBFT safety (honest replicas)" />

          <div className="lab-aux">
            <div className="panel-head">
              <span>Executed log</span>
              <span className="muted">≤ #{maxExec}</span>
            </div>
            <div className="lab-aux-body">
              {execLog.length === 0 && <div className="muted pad">Nothing executed yet — send a client request.</div>}
              {execLog.slice(-12).map((r) => (
                <div key={r.seq} className="replica-row">
                  <span className="replica-id">#{r.seq}</span>
                  <code className="replica-val" style={{ color: r.digest === 'noop' ? '#5b6472' : MSG_COLOR('Commit') }}>
                    {r.summary}
                  </code>
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
                  <span className="replica-id">view</span>
                  <code className="replica-val">v{sel.state.view}{sel.state.inViewChange ? ` → vc v${sel.state.targetView}` : ''}{sel.id === primaryId ? ' (primary)' : ''}</code>
                </div>
                <div className="replica-row">
                  <span className="replica-id">executed</span>
                  <code className="replica-val">≤ #{sel.state.lastExec}</code>
                </div>
                <div className="replica-row">
                  <span className="replica-id">note</span>
                  <code className="replica-val" style={{ color: '#9aa2b1' }}>{sel.state.note}</code>
                </div>
                {selSlots.map((seq) => {
                  const sl = sel.state.log[seq];
                  const phase = sl.committed ? 'committed' : sl.prepared ? 'prepared' : sl.preprepared ? 'pre-prepared' : 'open';
                  const col = sl.committed ? MSG_COLOR('Commit') : sl.prepared ? MSG_COLOR('Prepare') : MSG_COLOR('PrePrepare');
                  return (
                    <div key={seq} className="replica-row">
                      <span className="replica-id">#{seq}</span>
                      <code className="replica-val" style={{ color: col }}>
                        {opStr(sl.request)} · {phase}
                      </code>
                    </div>
                  );
                })}
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
