import { useCallback, useEffect, useMemo, useState } from 'react';
import { Kernel } from '../sim/kernel';
import { createMutex } from '../protocols/mutex/mutex';
import { mutexInvariants, mutexGauge } from '../protocols/mutex/invariants';
import { DEFAULT_MUTEX_CONFIG, type MutexCmd, type MutexState } from '../protocols/mutex/types';
import { useSimulation } from '../lib/useSimulation';
import { NetworkCanvas, type NodeVisual } from '../ui/NetworkCanvas';
import { ControlBar } from '../ui/ControlBar';
import { InvariantPanel } from '../ui/InvariantPanel';
import { Timeline } from '../ui/Timeline';
import { MetricsBar } from '../ui/MetricsBar';
import type { NodeRuntime, NodeView } from '../sim/types';

const NAMES = 'ABCDEFGH'.split('');

const REQ_COLOR = '#ffd479';
const REPLY_COLOR = '#8be9c0';
const REL_COLOR = '#ff8fa3';
const MSG_COLOR = (t: string): string => (t === 'Request' ? REQ_COLOR : t === 'Reply' ? REPLY_COLOR : REL_COLOR);
const MSG_GLYPH = (t: string): string => (t === 'Request' ? 'R' : t === 'Reply' ? '✓' : '↺');

const PHASE_FILL: Record<string, string> = { idle: '#3f7d68', wanting: '#caa23a', held: '#5fd08a' };

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
  { name: 'Classic (5·LAN)', hint: 'five processes contend for one critical section on a fast network', cfg: { seed: 42, n: 5, net: 0 } },
  { name: 'Jittery channels', hint: 'heavy reordering latency — FIFO + (ts,id) order still serialise access', cfg: { seed: 7, n: 5, net: 2 } },
  { name: 'Crowd of 7', hint: 'seven processes, more contention, longer queues', cfg: { seed: 13, n: 7, net: 0 } },
];

export function MutexLab() {
  const initial = useMemo(() => ({ ...DEFAULT_SCENARIO, ...readHash() }), []);
  const [seed, setSeed] = useState(initial.seed);
  const [n, setN] = useState(initial.n);
  const [net, setNet] = useState(initial.net);
  const [selected, setSelected] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const nodeIds = useMemo(() => NAMES.slice(0, n), [n]);

  useEffect(() => {
    const q = new URLSearchParams({ seed: String(seed), n: String(n), net: String(net) });
    history.replaceState(null, '', `#/mutex?${q.toString()}`);
  }, [seed, n, net]);

  const makeKernel = useCallback(() => {
    const proto = createMutex(DEFAULT_MUTEX_CONFIG);
    proto.invariants = mutexInvariants as (v: ReadonlyArray<NodeView<MutexState>>) => ReturnType<typeof mutexInvariants>;
    const p = NET_PRESETS[net];
    return new Kernel<MutexState, MutexCmd>({
      seed,
      protocol: proto,
      nodeIds,
      network: { minLatency: p.min, maxLatency: p.max, dropRate: p.drop },
    });
  }, [seed, nodeIds, net]);

  const ctrl = useSimulation(makeKernel);
  const snap = ctrl.snapshot;
  const nodes = useMemo(() => (snap?.nodes ?? []) as NodeRuntime<MutexState>[], [snap]);
  const views = useMemo<NodeView<MutexState>[]>(() => nodes.map((nd) => ({ id: nd.id, up: nd.up, state: nd.state })), [nodes]);
  const gauge = useMemo(() => mutexGauge(views), [views]);

  const request = (id?: string) => {
    const tgt = id ?? selected ?? nodeIds[0];
    ctrl.command(tgt, { type: 'request' });
    if (!ctrl.playing) ctrl.play();
  };
  const requestAll = () => {
    nodes.filter((nd) => nd.up && nd.state.phase === 'idle').forEach((nd) => ctrl.command(nd.id, { type: 'request' }));
    if (!ctrl.playing) ctrl.play();
  };

  const applyPreset = (c: ScenarioCfg) => { setSeed(c.seed); setN(c.n); setNet(c.net); };
  const copyLink = () => {
    const url = `${location.origin}${location.pathname}${location.hash}`;
    void navigator.clipboard?.writeText(url).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1200); });
  };

  const visual = useCallback(
    (node: NodeRuntime<MutexState>): NodeVisual => {
      const s = node.state;
      return {
        fill: PHASE_FILL[s.phase],
        ring: s.inCS ? '#ffffff' : 'rgba(255,255,255,0.22)',
        label: node.id,
        sub: s.inCS ? '★ CS' : s.phase === 'wanting' ? `want ${s.myReqTs}` : `clk ${s.clock}`,
        badge: s.queue.length > 0 ? String(s.queue.length) : undefined,
        glow: s.inCS,
        down: !node.up,
      };
    },
    [],
  );

  const sel = selected ? nodes.find((nd) => nd.id === selected) : undefined;

  return (
    <div className="lab">
      <div className="lab-intro">
        <h2>Lamport mutual exclusion · one critical section, no lock server</h2>
        <p>
          Several processes contend for a single <b>critical section</b> with no central lock manager —
          only messages and <b>logical clocks</b>. This is Lamport's 1978 worked example: a process that
          wants in stamps a <span style={{ color: REQ_COLOR }}>REQUEST</span> with its clock and
          broadcasts it; others <span style={{ color: REPLY_COLOR }}>REPLY</span>; a process enters only
          when its request is the <code>(timestamp, id)</code>-minimum of its queue <em>and</em> it has
          heard from everyone with a later timestamp — then <span style={{ color: REL_COLOR }}>RELEASE</span>s
          on the way out. The total order guarantees <b>mutual exclusion</b>, proven live on the right —
          and, like Chandy–Lamport, it needs <b>FIFO channels</b>, layered here over the reordering
          network. Watch the request queues converge to one global order.
        </p>
      </div>

      <ControlBar
        ctrl={ctrl}
        seed={seed}
        onSeed={setSeed}
        right={
          <span className={`leader-pill ${gauge.inCS ? 'has' : ''}`} title="Current critical-section holder">
            {gauge.inCS ? `★ ${gauge.inCS} in CS` : 'CS free'} · {gauge.wanting} waiting
          </span>
        }
      />

      <div className="lab-grid">
        <div className="lab-main">
          <div className="cluster-toolbar">
            <div className="ctl-group">
              <label>Processes</label>
              {[3, 4, 5, 6, 7].map((c) => (
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
              <span><i style={{ background: REQ_COLOR }} /> request</span>
              <span><i style={{ background: REPLY_COLOR }} /> reply</span>
              <span><i style={{ background: REL_COLOR }} /> release</span>
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
            <button className="btn primary" onClick={() => request()} title="Make a process want the critical section">
              ✋ Request{selected ? ` (${selected})` : ''}
            </button>
            <button className="btn" onClick={requestAll} title="Every idle process requests at once — maximum contention">
              ⇶ Everyone requests
            </button>
            <button className="btn" onClick={() => ctrl.partition(twoWaySplit(ctrl.nodeOrder))} title="Cut the cluster — the holder can finish but no new entries cross the cut">
              ✂ Partition
            </button>
            <button className="btn good" onClick={ctrl.heal}>⧉ Heal</button>
            <button className="btn" onClick={ctrl.reset}>↺ New cluster</button>
          </div>

          <div className="action-row">
            {sel ? (
              <>
                <span className="op-target">{sel.id}:</span>
                <button className="btn" onClick={() => request(sel.id)}>request</button>
                {sel.state.inCS && <button className="btn" onClick={() => ctrl.command(sel.id, { type: 'release' })}>release</button>}
                <button className={`btn ${sel.up ? 'danger' : 'good'}`} onClick={() => (sel.up ? ctrl.crash(sel.id) : ctrl.restart(sel.id))}>
                  {sel.up ? `✕ Crash ${sel.id}` : `⏼ Restart ${sel.id}`}
                </button>
              </>
            ) : (
              <span className="muted">Click a process to make it request the CS or crash it. The queues below show the global <b>(ts, id)</b> order every process agrees on.</span>
            )}
          </div>

          <RequestQueues views={views} holder={gauge.inCS} />

          {snap && <MetricsBar metrics={snap.metrics} />}
        </div>

        <div className="lab-side">
          <InvariantPanel invariants={ctrl.invariants} title="Mutual exclusion" />

          <div className="lab-aux">
            <div className="panel-head">
              <span>Critical section</span>
              <span className={`status-pill ${gauge.inCS ? 'ok' : ''}`}>{gauge.inCS ? `HELD · ${gauge.inCS}` : 'FREE'}</span>
            </div>
            <div className="lab-aux-body">
              <div className="replica-row"><span className="replica-id">waiting</span><code className="replica-val" style={{ color: REQ_COLOR }}>{gauge.wanting}</code></div>
              <div className="replica-row"><span className="replica-id">idle</span><code className="replica-val">{gauge.idle}</code></div>
              <div className="replica-row"><span className="replica-id">total entries</span><code className="replica-val">{gauge.totalEntries}</code></div>
              <div className="replica-row"><span className="replica-id">max wait</span><code className="replica-val">{gauge.maxWait}ms</code></div>
            </div>
          </div>

          <div className="lab-aux">
            <div className="panel-head"><span>Per-process state</span></div>
            <div className="lab-aux-body">
              {nodes.map((nd) => (
                <div key={nd.id} className="replica-row">
                  <span className="replica-id">{nd.id}{nd.up ? '' : ' ✕'}</span>
                  <code className="replica-val" style={{ color: PHASE_FILL[nd.state.phase] }}>
                    {nd.state.inCS ? '★ CS' : nd.state.phase} · clk {nd.state.clock} · {nd.state.entries}×
                  </code>
                </div>
              ))}
            </div>
          </div>

          <div className="lab-aux">
            <div className="panel-head"><span>Why does it work?</span></div>
            <div className="lab-aux-body" style={{ padding: '8px 12px', fontSize: 12, color: 'var(--tx-dim)' }}>
              Every request is globally ordered by <b>(timestamp, id)</b>. The "wait for a later message
              from everyone" rule means a process can't enter until it has provably seen every request
              that could precede it. Over FIFO channels that's airtight — two processes can never both
              believe they're first, so the critical section is never double-occupied. No leader, no lock
              server; just clocks and the happens-before relation.
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

// Each process's request queue, drawn as (ts.id) chips ordered by (ts,id). The
// head chip is the next process that may enter; a held CS highlights it. Watch
// the queues across processes agree on the same global order.
function RequestQueues({ views, holder }: { views: NodeView<MutexState>[]; holder: string | null }) {
  const any = views.some((v) => v.state.queue.length > 0);
  return (
    <div className="depgraph">
      <div className="panel-head">
        <span>Request queues · global (ts, id) order</span>
        <span className="muted">{holder ? `${holder} holds the critical section` : 'critical section free'}</span>
      </div>
      <div className="depgraph-scroll" style={{ padding: '6px 12px' }}>
        {!any ? (
          <div className="muted">No outstanding requests. Press <b>Request</b> or <b>Everyone requests</b>.</div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            {views.map((v) => (
              <div key={v.id} style={{ display: 'flex', alignItems: 'center', gap: 6, fontFamily: 'ui-monospace, monospace', fontSize: 12 }}>
                <span style={{ width: 18, color: v.state.inCS ? '#5fd08a' : 'var(--tx-dim)' }}>{v.id}{v.state.inCS ? '★' : ''}</span>
                <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
                  {v.state.queue.length === 0 ? (
                    <span style={{ color: 'var(--tx-dim)' }}>∅</span>
                  ) : (
                    v.state.queue.map((e, i) => {
                      const isOwn = e.id === v.id;
                      const isHead = i === 0;
                      return (
                        <span
                          key={e.id}
                          title={isHead ? 'queue head — next to enter' : undefined}
                          style={{
                            padding: '1px 6px',
                            borderRadius: 4,
                            background: isHead ? 'rgba(95,208,138,0.18)' : 'rgba(255,255,255,0.05)',
                            border: `1px solid ${isHead ? 'rgba(95,208,138,0.5)' : 'rgba(255,255,255,0.1)'}`,
                            color: isOwn ? '#ffd479' : '#cfd6e6',
                            fontWeight: isOwn ? 700 : 400,
                          }}
                        >
                          {e.ts}.{e.id}
                        </span>
                      );
                    })
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
      <div className="depgraph-foot muted">
        Each chip is a pending request <code>ts.id</code>; the <span style={{ color: '#5fd08a' }}>green head</span> is
        next to enter. Wherever two processes both list a request, they agree on its position — that
        shared total order is what makes mutual exclusion safe.
      </div>
    </div>
  );
}
