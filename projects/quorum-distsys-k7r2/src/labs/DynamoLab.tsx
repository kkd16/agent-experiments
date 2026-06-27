import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Kernel } from '../sim/kernel';
import { createDynamo } from '../protocols/dynamo/dynamo';
import { convergenceGauge } from '../protocols/dynamo/invariants';
import {
  DEFAULT_DYNAMO_CONFIG,
  consistencyLabel,
  overlaps,
  clockStr,
  reconcile,
  type DynamoCmd,
  type DynamoConfig,
  type DynamoState,
  type VClock,
  type VersionSet,
} from '../protocols/dynamo/types';
import { buildRing, preferenceList } from '../protocols/dynamo/ring';
import { useSimulation } from '../lib/useSimulation';
import { NetworkCanvas, type NodeVisual } from '../ui/NetworkCanvas';
import { ControlBar } from '../ui/ControlBar';
import { InvariantPanel } from '../ui/InvariantPanel';
import { Timeline } from '../ui/Timeline';
import { MetricsBar } from '../ui/MetricsBar';
import { nodeColor } from '../lib/format';
import type { Kernel as K } from '../sim/kernel';
import type { NodeRuntime } from '../sim/types';

const NAMES = ['A', 'B', 'C', 'D', 'E', 'F', 'G'];

const MSG_COLORS: Record<string, string> = {
  Put: '#7c9cff',
  PutAck: '#8be9c0',
  Get: '#ffd479',
  GetResp: '#73e08a',
  ReadRepair: '#ff9f6b',
  HintDeliver: '#c08bff',
  HintAck: '#8be9c0',
  AntiEntropy: '#5ad2c4',
  Ping: '#54607a',
  Pong: '#54607a',
  Forward: '#9aa2b1',
};

interface DynScenario {
  seed: number;
  count: number;
  n: number;
  r: number;
  w: number;
  sloppy: boolean;
  key: string;
}
const DEFAULT_SCENARIO: DynScenario = { seed: 7, count: 5, n: 3, r: 2, w: 2, sloppy: true, key: 'cart' };

function readHash(): Partial<DynScenario> {
  try {
    const q = window.location.hash.split('?')[1];
    if (!q) return {};
    const p = new URLSearchParams(q);
    const out: Partial<DynScenario> = {};
    if (p.has('seed')) out.seed = Number(p.get('seed')) || 0;
    if (p.has('nodes')) out.count = Number(p.get('nodes')) || 5;
    if (p.has('n')) out.n = Number(p.get('n')) || 3;
    if (p.has('r')) out.r = Number(p.get('r')) || 2;
    if (p.has('w')) out.w = Number(p.get('w')) || 2;
    if (p.has('sloppy')) out.sloppy = p.get('sloppy') !== '0';
    if (p.has('key')) out.key = p.get('key') || 'cart';
    return out;
  } catch {
    return {};
  }
}

export function DynamoLab() {
  const initial = useMemo(() => ({ ...DEFAULT_SCENARIO, ...readHash() }), []);
  const [seed, setSeed] = useState(initial.seed);
  const [count, setCount] = useState(initial.count);
  const [n, setN] = useState(initial.n);
  const [r, setR] = useState(initial.r);
  const [w, setW] = useState(initial.w);
  const [sloppy, setSloppy] = useState(initial.sloppy);
  const [selected, setSelected] = useState('A');
  const [keyInput, setKeyInput] = useState(initial.key);
  const [valueInput, setValueInput] = useState('book');
  const [blind, setBlind] = useState(false);
  const [copied, setCopied] = useState(false);
  const reqId = useRef(1);

  const nodeIds = useMemo(() => NAMES.slice(0, count), [count]);
  // Keep the quorum knobs within bounds when the replication factor changes.
  const cfgN = Math.min(n, count);
  const cfgR = Math.min(r, cfgN);
  const cfgW = Math.min(w, cfgN);

  const config: DynamoConfig = useMemo(
    () => ({ ...DEFAULT_DYNAMO_CONFIG, n: cfgN, r: cfgR, w: cfgW, sloppy }),
    [cfgN, cfgR, cfgW, sloppy],
  );

  const makeKernel = useCallback(() => {
    return new Kernel<DynamoState, DynamoCmd>({
      seed,
      protocol: createDynamo(config),
      nodeIds,
      network: { minLatency: 25, maxLatency: 70, dropRate: 0 },
    });
  }, [seed, nodeIds, config]);

  const ctrl = useSimulation(makeKernel);
  const snap = ctrl.snapshot;
  const key = keyInput.trim() || 'cart';

  // Round-trip the whole configuration through the URL hash so a scenario is shareable.
  useEffect(() => {
    const q = new URLSearchParams({
      seed: String(seed),
      nodes: String(count),
      n: String(cfgN),
      r: String(cfgR),
      w: String(cfgW),
      sloppy: sloppy ? '1' : '0',
      key,
    });
    history.replaceState(null, '', `#/dynamo?${q.toString()}`);
  }, [seed, count, cfgN, cfgR, cfgW, sloppy, key]);

  const copyLink = () => {
    const url = `${location.origin}${location.pathname}${location.hash}`;
    void navigator.clipboard?.writeText(url).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    });
  };

  // --- preference / placement info for the selected key --------------------
  const placement = useMemo(() => {
    const ring = buildRing(nodeIds);
    const home = preferenceList(key, ring, cfgN);
    const homeSet = new Set(home);
    // Which nodes currently hold a hint for one of this key's home owners?
    const substitutes = new Set<string>();
    for (const node of snap?.nodes ?? []) {
      for (const target in node.state.hints) {
        if (homeSet.has(target) && node.state.hints[target][key]) substitutes.add(node.id);
      }
    }
    return { home, homeSet, substitutes };
  }, [nodeIds, key, cfgN, snap]);

  const sel = snap?.nodes.find((nd) => nd.id === selected);

  // The newest PUT/GET anywhere — a request to a non-owner is forwarded, so the
  // result lands on the coordinator, not necessarily the node you clicked.
  const latest = useMemo(() => {
    let lw: { by: string; at: number; key: string; value: string; clock: VClock; acks: number; sloppy: boolean } | null = null;
    let lr: { by: string; at: number; key: string; versions: VersionSet; conflict: boolean; replies: number } | null = null;
    for (const nd of snap?.nodes ?? []) {
      const w = nd.state.lastWrite;
      if (w && (!lw || w.at > lw.at)) lw = { by: nd.id, at: w.at, key: w.key, value: w.value, clock: w.clock, acks: w.acks, sloppy: w.sloppy };
      const rr = nd.state.lastRead;
      if (rr && (!lr || rr.at > lr.at)) lr = { by: nd.id, at: rr.at, key: rr.key, versions: rr.versions, conflict: rr.conflict, replies: rr.replies };
    }
    return { lw, lr };
  }, [snap]);

  const conv = useMemo(() => {
    const views = (snap?.nodes ?? []).map((nd) => ({ id: nd.id, up: nd.up, state: nd.state }));
    return views.length ? convergenceGauge(views) : null;
  }, [snap]);

  const visual = useCallback(
    (node: NodeRuntime<DynamoState>, i: number): NodeVisual => {
      const vs = reconcile(node.state.store[key] ?? []);
      const isHome = placement.homeSet.has(node.id);
      const isSub = placement.substitutes.has(node.id);
      const fill = isHome ? nodeColor(i) : isSub ? '#c08bff' : '#3a4053';
      const sub = vs.length > 1 ? `⊕${vs.length}` : vs.length === 1 ? vs[0].value.slice(0, 6) : '·';
      return {
        fill,
        ring: isHome ? 'rgba(255,255,255,0.3)' : isSub ? '#c08bff' : 'rgba(255,255,255,0.12)',
        label: node.id,
        sub,
        badge: isSub ? 'H' : vs.length > 1 ? '◆' : undefined,
        glow: vs.length > 1,
        dim: !isHome && !isSub,
        down: !node.up,
      };
    },
    [key, placement],
  );

  // --- client actions ------------------------------------------------------
  const doPut = () => {
    ctrl.command(selected, { type: 'put', key, value: valueInput || '∅', blind, reqId: reqId.current++ });
  };
  const doGet = () => {
    ctrl.command(selected, { type: 'get', key, reqId: reqId.current++ });
  };
  const splitPartition = () => {
    const half = Math.ceil(ctrl.nodeOrder.length / 2);
    ctrl.partition([ctrl.nodeOrder.slice(0, half), ctrl.nodeOrder.slice(half)]);
  };

  // --- curated scenarios (run on a fresh kernel for the current config) -----
  const settle = (k: K<DynamoState, DynamoCmd>, ticks: number, dt = 20) => {
    for (let i = 0; i < ticks; i++) k.advance(dt);
  };
  const runScenario = (macro: (k: K<DynamoState, DynamoCmd>) => void) => {
    ctrl.reset();
    ctrl.act(macro);
  };

  const scenarioSiblings = () =>
    runScenario((k) => {
      const ring = buildRing(nodeIds);
      const home = preferenceList(key, ring, cfgN);
      if (home.length < 2) return;
      const [a, b] = home;
      settle(k, 25); // let the failure detector warm up
      k.partition([[a], nodeIds.filter((id) => id !== a)]); // isolate one home replica
      k.command(a, { type: 'put', key, value: 'red', blind: true, reqId: reqId.current++ });
      k.command(b, { type: 'put', key, value: 'blue', blind: true, reqId: reqId.current++ });
      settle(k, 25);
      k.healNetwork();
      settle(k, 140); // anti-entropy spreads both concurrent versions to every replica
    });

  const scenarioSloppy = () =>
    runScenario((k) => {
      const ring = buildRing(nodeIds);
      const home = preferenceList(key, ring, cfgN);
      if (home.length < 2) return;
      const [coord, victim] = home;
      settle(k, 25);
      k.crash(victim);
      settle(k, 30); // detector marks the victim dead → sloppy substitution kicks in
      k.command(coord, { type: 'put', key, value: 'sloppy-write', blind: false, reqId: reqId.current++ });
      settle(k, 25); // write still acks via a substitute holding a hint
      k.restart(victim);
      settle(k, 40); // hinted handoff delivers the data to the recovered owner
    });

  const scenarioReadRepair = () =>
    runScenario((k) => {
      const ring = buildRing(nodeIds);
      const home = preferenceList(key, ring, cfgN);
      if (home.length < 3) return;
      const coord = home[0];
      const victim = home[2];
      settle(k, 25);
      k.partition([[victim], nodeIds.filter((id) => id !== victim)]); // isolate one replica
      k.command(coord, { type: 'put', key, value: 'fresh', blind: false, reqId: reqId.current++ });
      settle(k, 25); // the victim misses the write
      k.healNetwork();
      settle(k, 4); // heal, but before anti-entropy drains…
      k.command(coord, { type: 'get', key, reqId: reqId.current++ }); // …a read repairs the stale replica
      settle(k, 25);
    });

  const strong = overlaps(config);

  return (
    <div className="lab">
      <div className="lab-intro">
        <h2>Dynamo · tunable-quorum replication</h2>
        <p>
          The other side of the CAP coin. Dynamo keeps the store <em>always writeable</em>: there is
          no leader and no agreed order — a write goes to <b>N</b> replicas and returns after just{' '}
          <b>W</b> acks, a read gathers <b>R</b> replies and reconciles them with <b>vector clocks</b>.
          Crash an owner and a <b>sloppy quorum</b> writes to a stand-in that holds a <b>hint</b>;
          partition the cluster, write on both sides, heal, and watch the conflict surface as{' '}
          <b>siblings</b>. Tune <code>(N,R,W)</code> to slide between strong and eventual consistency.
        </p>
      </div>

      <ControlBar
        ctrl={ctrl}
        seed={seed}
        onSeed={setSeed}
        right={
          <>
            <button className="btn tiny" onClick={copyLink} title="Copy a shareable link to this exact configuration">
              {copied ? '✓ copied' : '🔗 link'}
            </button>
            <span className={`leader-pill ${strong ? 'has' : 'none'}`} title="R + W > N guarantees read/write quorum overlap">
              {consistencyLabel(config)}
            </span>
          </>
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
              <label>N</label>
              {[1, 2, 3, 4, 5].filter((x) => x <= count).map((x) => (
                <button key={x} className={`btn tiny ${cfgN === x ? 'on' : ''}`} onClick={() => setN(x)}>
                  {x}
                </button>
              ))}
            </div>
            <div className="ctl-group">
              <label>R</label>
              {[1, 2, 3, 4, 5].filter((x) => x <= cfgN).map((x) => (
                <button key={x} className={`btn tiny ${cfgR === x ? 'on' : ''}`} onClick={() => setR(x)}>
                  {x}
                </button>
              ))}
            </div>
            <div className="ctl-group">
              <label>W</label>
              {[1, 2, 3, 4, 5].filter((x) => x <= cfgN).map((x) => (
                <button key={x} className={`btn tiny ${cfgW === x ? 'on' : ''}`} onClick={() => setW(x)}>
                  {x}
                </button>
              ))}
            </div>
            <div className="ctl-group">
              <label>Sloppy</label>
              <button className={`btn tiny ${sloppy ? 'on' : ''}`} onClick={() => setSloppy((v) => !v)}>
                {sloppy ? 'on' : 'off'}
              </button>
            </div>
          </div>

          <div className="dynamo-legend">
            <span><i className="sw home" /> home replica of <code>{key}</code></span>
            <span><i className="sw sub" /> hint holder (sloppy)</span>
            <span><i className="sw sib" /> ◆ siblings (conflict)</span>
            <span className="muted">coordinator = selected node</span>
          </div>

          {snap && (
            <NetworkCanvas
              snapshot={snap}
              nodeOrder={ctrl.nodeOrder}
              visual={visual}
              selected={selected}
              onSelect={setSelected}
              onToggleLink={(a, b) => ctrl.toggleLink(a, b)}
              messageColor={(t) => MSG_COLORS[t] ?? '#9aa2b1'}
              height={380}
            />
          )}

          <div className="action-row">
            <span className="op-target">
              key <input type="text" value={keyInput} onChange={(e) => setKeyInput(e.target.value)} style={{ width: 70 }} />
              = <input type="text" value={valueInput} onChange={(e) => setValueInput(e.target.value)} style={{ width: 80 }} />
            </span>
            <span className="op-target">via <b>{selected}</b>:</span>
            <button className="btn primary" onClick={doPut}>↑ PUT</button>
            <button className="btn" onClick={doGet}>↓ GET</button>
            <label className="dynamo-check" title="A blind write ignores the causal context, so it can fork a sibling">
              <input type="checkbox" checked={blind} onChange={(e) => setBlind(e.target.checked)} /> blind
            </label>
          </div>

          <div className="action-row">
            <button className="btn" onClick={splitPartition}>⌥ Partition</button>
            <button className="btn" onClick={ctrl.heal}>⟲ Heal net</button>
            {sel && (
              <button
                className={`btn ${sel.up ? 'danger' : 'good'}`}
                onClick={() => (sel.up ? ctrl.crash(selected) : ctrl.restart(selected))}
              >
                {sel.up ? `✕ Crash ${selected}` : `⏼ Restart ${selected}`}
              </button>
            )}
          </div>

          <div className="action-row">
            <span className="op-target muted">scenarios:</span>
            <button className="btn tiny" onClick={scenarioSiblings}>concurrent → siblings</button>
            <button className="btn tiny" onClick={scenarioSloppy}>sloppy + handoff</button>
            <button className="btn tiny" onClick={scenarioReadRepair}>read repair</button>
          </div>

          {snap && <MetricsBar metrics={snap.metrics} />}
        </div>

        <div className="lab-side">
          <InvariantPanel invariants={ctrl.invariants} title="Safety invariants" />
          {conv && <InvariantPanel invariants={[conv]} title="Convergence" />}

          <div className="lab-aux">
            <div className="panel-head">
              <span>Conflict view · <code>{key}</code></span>
              <span className="muted" style={{ fontWeight: 400, fontSize: '0.72rem' }}>
                owners {placement.home.join(',') || '—'}
              </span>
            </div>
            <div className="lab-aux-body">
              {(snap?.nodes ?? [])
                .filter((nd) => placement.homeSet.has(nd.id) || placement.substitutes.has(nd.id))
                .map((nd) => {
                  const hinted = placement.substitutes.has(nd.id);
                  return (
                    <div key={nd.id} className="dynamo-replica">
                      <span className="replica-id" style={{ color: nodeColor(ctrl.nodeOrder.indexOf(nd.id)) }}>
                        {nd.id}
                        {nd.up ? '' : ' ✕'}
                        {hinted ? ' ⟂' : ''}
                      </span>
                      <span className="dynamo-versions">
                        {versionsView(nd.state.store[key] ?? [], hinted)}
                      </span>
                    </div>
                  );
                })}
            </div>
          </div>

          <div className="lab-aux">
            <div className="panel-head"><span>Last operations</span></div>
            <div className="lab-aux-body dynamo-ops">
              {latest.lw ? (
                <div className="dynamo-op">
                  <b>PUT</b> {latest.lw.key}={latest.lw.value}{' '}
                  <code>[{clockStr(latest.lw.clock)}]</code>{' '}
                  <span className="muted">@{latest.lw.by} · {latest.lw.acks} acks{latest.lw.sloppy ? ' · sloppy' : ''}</span>
                </div>
              ) : <div className="muted">no writes yet</div>}
              {latest.lr ? (
                <div className="dynamo-op">
                  <b>GET</b> {latest.lr.key} →{' '}
                  {latest.lr.conflict
                    ? <span className="dynamo-conflict">{latest.lr.versions.length} siblings: {latest.lr.versions.map((v) => v.value).join(' ⊕ ')}</span>
                    : <span>{latest.lr.versions[0]?.value ?? '—'}</span>}{' '}
                  <span className="muted">@{latest.lr.by} · {latest.lr.replies} replies</span>
                </div>
              ) : <div className="muted">no reads yet</div>}
              <div className="dynamo-op muted">
                hints outstanding: {hintsOutstanding(snap?.nodes ?? [])}
              </div>
            </div>
          </div>
        </div>
      </div>

      <Timeline log={snap?.log ?? []} />
    </div>
  );
}

function versionsView(vs: VersionSet, hinted: boolean) {
  const set = reconcile(vs);
  if (set.length === 0) return <span className="muted">{hinted ? 'hint only' : '—'}</span>;
  return (
    <>
      {set.map((v, i) => (
        <span key={i} className={`dynamo-chip ${set.length > 1 ? 'sib' : ''}`} style={{ borderColor: nodeColor(v.by.charCodeAt(0) - 65) }}>
          {v.value} <em>{clockStr(v.clock)}</em>
        </span>
      ))}
    </>
  );
}

function hintsOutstanding(nodes: { state: DynamoState }[]): number {
  let total = 0;
  for (const nd of nodes) for (const t in nd.state.hints) total += Object.keys(nd.state.hints[t]).length;
  return total;
}
