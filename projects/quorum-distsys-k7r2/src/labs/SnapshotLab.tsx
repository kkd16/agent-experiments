import { useCallback, useEffect, useMemo, useState } from 'react';
import { Kernel } from '../sim/kernel';
import { createSnapshot } from '../protocols/snapshot/snapshot';
import { snapInvariants, snapGauge } from '../protocols/snapshot/invariants';
import { DEFAULT_SNAP_CONFIG, type SnapCmd, type SnapState } from '../protocols/snapshot/types';
import { useSimulation } from '../lib/useSimulation';
import { NetworkCanvas, type NodeVisual } from '../ui/NetworkCanvas';
import { ControlBar } from '../ui/ControlBar';
import { InvariantPanel } from '../ui/InvariantPanel';
import { Timeline } from '../ui/Timeline';
import { MetricsBar } from '../ui/MetricsBar';
import type { NodeRuntime, NodeView } from '../sim/types';

const NAMES = 'ABCDEFGH'.split('');

const APP_COLOR = '#5b8cff';
const MARKER_COLOR = '#ffd479';
const MSG_COLOR = (t: string): string => (t === 'Marker' ? MARKER_COLOR : APP_COLOR);
const MSG_GLYPH = (t: string): string => (t === 'Marker' ? 'M' : '');

const NET_PRESETS = [
  { name: 'LAN', min: 12, max: 50, drop: 0 },
  { name: 'WAN', min: 60, max: 200, drop: 0 },
  { name: 'Jittery', min: 10, max: 240, drop: 0 },
];

interface ScenarioCfg { seed: number; n: number; net: number }
const DEFAULT_SCENARIO: ScenarioCfg = { seed: 42, n: 5, net: 0 };

function readHash(): Partial<ScenarioCfg> {
  try {
    const q = window.location.hash.split('?')[1];
    if (!q) return {};
    const p = new URLSearchParams(q);
    const out: Partial<ScenarioCfg> = {};
    if (p.has('seed')) out.seed = Number(p.get('seed')) || 0;
    if (p.has('n')) out.n = Number(p.get('n')) || 5;
    if (p.has('net')) out.net = Number(p.get('net')) || 0;
    return out;
  } catch {
    return {};
  }
}

const PRESETS: { name: string; hint: string; cfg: ScenarioCfg }[] = [
  { name: 'Classic (5·LAN)', hint: 'five nodes trading on a low-latency network — take a snapshot mid-flight', cfg: { seed: 42, n: 5, net: 0 } },
  { name: 'Jittery channels', hint: 'wild reordering latency — the FIFO layer + markers still record a consistent cut', cfg: { seed: 7, n: 6, net: 2 } },
  { name: 'Big ring (7)', hint: 'seven nodes, more channels, more money in flight to capture', cfg: { seed: 13, n: 7, net: 0 } },
];

export function SnapshotLab() {
  const initial = useMemo(() => ({ ...DEFAULT_SCENARIO, ...readHash() }), []);
  const [seed, setSeed] = useState(initial.seed);
  const [n, setN] = useState(initial.n);
  const [net, setNet] = useState(initial.net);
  const [selected, setSelected] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const nodeIds = useMemo(() => NAMES.slice(0, n), [n]);

  useEffect(() => {
    const q = new URLSearchParams({ seed: String(seed), n: String(n), net: String(net) });
    history.replaceState(null, '', `#/snapshot?${q.toString()}`);
  }, [seed, n, net]);

  const makeKernel = useCallback(() => {
    const proto = createSnapshot(DEFAULT_SNAP_CONFIG);
    proto.invariants = snapInvariants as (v: ReadonlyArray<NodeView<SnapState>>) => ReturnType<typeof snapInvariants>;
    const p = NET_PRESETS[net];
    return new Kernel<SnapState, SnapCmd>({
      seed,
      protocol: proto,
      nodeIds,
      network: { minLatency: p.min, maxLatency: p.max, dropRate: p.drop },
    });
  }, [seed, nodeIds, net]);

  const ctrl = useSimulation(makeKernel);
  const snap = ctrl.snapshot;
  const nodes = useMemo(() => (snap?.nodes ?? []) as NodeRuntime<SnapState>[], [snap]);
  const views = useMemo<NodeView<SnapState>[]>(() => nodes.map((nd) => ({ id: nd.id, up: nd.up, state: nd.state })), [nodes]);
  const gauge = useMemo(() => snapGauge(views), [views]);

  const startSnapshot = (id?: string) => {
    const init = id ?? selected ?? nodeIds[0];
    ctrl.command(init, { type: 'snapshot' });
    if (!ctrl.playing) ctrl.play();
  };

  const applyPreset = (c: ScenarioCfg) => { setSeed(c.seed); setN(c.n); setNet(c.net); };
  const copyLink = () => {
    const url = `${location.origin}${location.pathname}${location.hash}`;
    void navigator.clipboard?.writeText(url).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1200); });
  };

  const visual = useCallback(
    (node: NodeRuntime<SnapState>): NodeVisual => {
      const s = node.state;
      return {
        fill: s.done ? '#7c9cff' : s.recordedOwn ? '#b08bff' : '#3f7d68',
        ring: s.done ? '#ffffff' : 'rgba(255,255,255,0.22)',
        label: node.id,
        sub: s.recordedOwn ? `rec ${s.recordedState}` : String(s.balance),
        badge: s.done ? '✓' : s.recordedOwn ? '●' : undefined,
        glow: s.recordedOwn,
        down: !node.up,
      };
    },
    [],
  );

  const sel = selected ? nodes.find((nd) => nd.id === selected) : undefined;

  return (
    <div className="lab">
      <div className="lab-intro">
        <h2>Chandy–Lamport · consistent global snapshots</h2>
        <p>
          Every node holds a balance and continuously <span style={{ color: APP_COLOR }}>transfers
          random amounts</span> to its peers — a <b>conserved</b> token economy whose total never
          changes, though at any instant some of it is <b>in flight</b> in the channels. How do you
          photograph the <em>whole</em> system — every balance <b>and</b> every in-flight message — as
          a state it really passed through, without a global clock and without stopping the trading?
          <b> Chandy–Lamport (1985)</b> does it with <span style={{ color: MARKER_COLOR }}>markers</span>:
          an initiator records its balance and floods markers; each node records on its first marker and
          records a channel's contents until that channel's marker arrives. The lab <b>proves it</b>:
          the recorded total always equals the conserved total — a naive "ask everyone their balance"
          snapshot would miss the money in flight.
        </p>
      </div>

      <ControlBar
        ctrl={ctrl}
        seed={seed}
        onSeed={setSeed}
        right={
          <span className={`leader-pill ${gauge.complete ? 'has' : ''}`} title="Snapshot recording progress">
            {gauge.activeId === 0 ? 'no snapshot' : gauge.complete ? `snapshot #${gauge.activeId} ✓` : `recording ${gauge.done}/${gauge.total}`}
          </span>
        }
      />

      <div className="lab-grid">
        <div className="lab-main">
          <div className="cluster-toolbar">
            <div className="ctl-group">
              <label>Nodes</label>
              {[4, 5, 6, 7].map((c) => (
                <button key={c} className={`btn tiny ${n === c ? 'on' : ''}`} onClick={() => setN(c)}>{c}</button>
              ))}
            </div>
            <div className="ctl-group">
              <label>Network</label>
              {NET_PRESETS.map((p, i) => (
                <button key={p.name} className={`btn tiny ${net === i ? 'on' : ''}`} onClick={() => setNet(i)}>{p.name}</button>
              ))}
            </div>
            <div className="legend">
              <span><i style={{ background: APP_COLOR }} /> transfer</span>
              <span><i style={{ background: MARKER_COLOR }} /> marker</span>
            </div>
            <div className="ctl-group">
              <label>Scenario</label>
              {PRESETS.map((p) => (
                <button key={p.name} className="btn tiny" title={p.hint} onClick={() => applyPreset(p.cfg)}>{p.name}</button>
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
              messageGlyph={MSG_GLYPH}
              height={340}
            />
          )}

          <div className="action-row">
            <button className="btn primary" onClick={() => startSnapshot()} title="Record a consistent global snapshot from this initiator (plays the run)">
              ◆ Take snapshot{selected ? ` (from ${selected})` : ''}
            </button>
            <button className="btn" onClick={() => ctrl.command(selected ?? nodeIds[0], { type: 'transfer' })} title="Fire one extra transfer">
              ⇢ Force transfer
            </button>
            <button className="btn" onClick={() => ctrl.partition(twoWaySplit(ctrl.nodeOrder))} title="Cut the cluster — markers can't cross, so the snapshot stalls (CL assumes no failures)">
              ✂ Partition
            </button>
            <button className="btn good" onClick={ctrl.heal}>⧉ Heal</button>
            <button className="btn" onClick={ctrl.reset}>↺ New cluster</button>
          </div>

          <div className="action-row">
            {sel ? (
              <>
                <span className="op-target">{sel.id}:</span>
                <button className="btn" onClick={() => startSnapshot(sel.id)}>snapshot from here</button>
                <button className="btn" onClick={() => ctrl.command(sel.id, { type: 'transfer' })}>transfer</button>
                <button className={`btn ${sel.up ? 'danger' : 'good'}`} onClick={() => (sel.up ? ctrl.crash(sel.id) : ctrl.restart(sel.id))}>
                  {sel.up ? `✕ Crash ${sel.id}` : `⏼ Restart ${sel.id}`}
                </button>
              </>
            ) : (
              <span className="muted">Press <b>Take snapshot</b> and watch markers (gold) flood the network. The ledger below shows the recorded cut: node balances + the money caught in the channels.</span>
            )}
          </div>

          <SnapshotLedger views={views} gauge={gauge} />

          {snap && <MetricsBar metrics={snap.metrics} />}
        </div>

        <div className="lab-side">
          <InvariantPanel invariants={ctrl.invariants} title="Snapshot correctness" />

          <div className="lab-aux">
            <div className="panel-head">
              <span>Live economy</span>
              <span className="muted">conserved = {gauge.conserved}</span>
            </div>
            <div className="lab-aux-body">
              <div className="replica-row"><span className="replica-id">in balances</span><code className="replica-val" style={{ color: '#73e08a' }}>{gauge.trueTotal}</code></div>
              <div className="replica-row"><span className="replica-id">in flight (channels)</span><code className="replica-val" style={{ color: APP_COLOR }}>{gauge.inFlight}</code></div>
              <div className="replica-row"><span className="replica-id">total</span><code className="replica-val">{gauge.trueTotal + gauge.inFlight} = {gauge.conserved}</code></div>
              <div style={{ padding: '6px 12px' }}>
                <div style={{ display: 'flex', height: 16, borderRadius: 4, overflow: 'hidden', border: '1px solid rgba(255,255,255,0.1)' }}>
                  <div title={`balances ${gauge.trueTotal}`} style={{ width: `${(gauge.trueTotal / Math.max(1, gauge.conserved)) * 100}%`, background: '#3f7d68' }} />
                  <div title={`in flight ${gauge.inFlight}`} style={{ width: `${(gauge.inFlight / Math.max(1, gauge.conserved)) * 100}%`, background: APP_COLOR }} />
                </div>
              </div>
            </div>
          </div>

          <div className="lab-aux">
            <div className="panel-head"><span>Balances per node</span></div>
            <div className="lab-aux-body">
              {nodes.map((nd) => (
                <div key={nd.id} className="replica-row">
                  <span className="replica-id">{nd.id}{nd.up ? '' : ' ✕'}{nd.state.recordedOwn ? ' ◆' : ''}</span>
                  <code className="replica-val">{nd.state.balance}{nd.state.recordedOwn ? ` · rec ${nd.state.recordedState}` : ''}</code>
                </div>
              ))}
            </div>
          </div>

          <div className="lab-aux">
            <div className="panel-head"><span>Why record channels?</span></div>
            <div className="lab-aux-body" style={{ padding: '8px 12px', fontSize: 12, color: 'var(--tx-dim)' }}>
              If you only summed everyone's balance you'd undercount — the money already <i>sent</i> but
              not yet <i>received</i> is invisible at both ends. Chandy–Lamport captures it by recording
              each channel from the moment a node snapshots itself until that channel's marker arrives.
              Because channels are <b>FIFO</b> and the marker rides the same stream, everything before
              the cut is in the recorded state and everything after is not — a globally consistent photo.
            </div>
          </div>
        </div>
      </div>

      <Timeline log={snap?.log ?? []} />
    </div>
  );
}

function twoWaySplit(order: string[]): string[][] {
  const half = Math.ceil(order.length / 2);
  return [order.slice(0, half), order.slice(half)];
}

// The recorded global state laid out as a ledger: each node's recorded balance,
// the in-flight money captured on each incoming channel, and the grand total
// compared to the conserved invariant.
function SnapshotLedger({ views, gauge }: { views: NodeView<SnapState>[]; gauge: ReturnType<typeof snapGauge> }) {
  const order = views.map((v) => v.id);
  const empty = gauge.activeId === 0;
  return (
    <div className="depgraph">
      <div className="panel-head">
        <span>Recorded snapshot {gauge.activeId > 0 ? `#${gauge.activeId}` : ''}</span>
        <span className="muted">
          {empty ? 'press “Take snapshot”' : gauge.complete ? `recorded ${gauge.recordedTotal} = conserved ${gauge.conserved} ✓` : `recording… ${gauge.done}/${gauge.total} nodes`}
        </span>
      </div>
      <div className="depgraph-scroll" style={{ padding: '8px 12px' }}>
        {empty ? (
          <div className="muted">No snapshot recorded yet. Markers will appear in <span style={{ color: MARKER_COLOR }}>gold</span>; the recorded cut shows here.</div>
        ) : (
          <table className="snap-ledger" style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12, fontFamily: 'ui-monospace, monospace' }}>
            <thead>
              <tr style={{ color: 'var(--tx-dim)', textAlign: 'left' }}>
                <th style={{ padding: '3px 6px' }}>node</th>
                <th style={{ padding: '3px 6px' }}>state</th>
                <th style={{ padding: '3px 6px' }}>in-flight on incoming channels</th>
                <th style={{ padding: '3px 6px', textAlign: 'right' }}>subtotal</th>
              </tr>
            </thead>
            <tbody>
              {views.map((v) => {
                const s = v.state;
                const chans = order.filter((o) => o !== v.id && (s.channelState[o] ?? 0) > 0);
                const chanSum = order.reduce((a, o) => a + (o !== v.id ? s.channelState[o] ?? 0 : 0), 0);
                const sub = (s.recordedState ?? 0) + chanSum;
                return (
                  <tr key={v.id} style={{ borderTop: '1px solid rgba(255,255,255,0.06)' }}>
                    <td style={{ padding: '3px 6px' }}>{v.id}{s.done ? ' ✓' : s.recordedOwn ? ' ●' : ' …'}</td>
                    <td style={{ padding: '3px 6px', color: '#9ab0ff' }}>{s.recordedState ?? '—'}</td>
                    <td style={{ padding: '3px 6px', color: APP_COLOR }}>
                      {chans.length ? chans.map((o) => `${o}→${v.id}:${s.channelState[o]}`).join('  ') : <span style={{ color: 'var(--tx-dim)' }}>∅</span>}
                    </td>
                    <td style={{ padding: '3px 6px', textAlign: 'right' }}>{sub}</td>
                  </tr>
                );
              })}
            </tbody>
            <tfoot>
              <tr style={{ borderTop: '2px solid rgba(255,255,255,0.16)', fontWeight: 700 }}>
                <td style={{ padding: '4px 6px' }} colSpan={3}>recorded global total</td>
                <td style={{ padding: '4px 6px', textAlign: 'right', color: gauge.complete && gauge.recordedTotal === gauge.conserved ? '#73e08a' : '#e8eaf0' }}>
                  {gauge.complete ? `${gauge.recordedTotal} / ${gauge.conserved}` : `… / ${gauge.conserved}`}
                </td>
              </tr>
            </tfoot>
          </table>
        )}
      </div>
      <div className="depgraph-foot muted">
        The recorded total equals the conserved total even though it was captured mid-flight — that is
        a <b>consistent cut</b>. The in-flight column is exactly the money a naive snapshot would lose.
      </div>
    </div>
  );
}
