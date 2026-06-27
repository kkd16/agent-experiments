import { useCallback, useEffect, useMemo, useState } from 'react';
import { Kernel } from '../sim/kernel';
import { createAbd } from '../protocols/abd/abd';
import { abdInvariants } from '../protocols/abd/invariants';
import {
  DEFAULT_ABD_CONFIG,
  tagStr,
  type AbdCmd,
  type AbdState,
  type CompletedOp,
} from '../protocols/abd/types';
import { useSimulation } from '../lib/useSimulation';
import { NetworkCanvas, type NodeVisual } from '../ui/NetworkCanvas';
import { ControlBar } from '../ui/ControlBar';
import { InvariantPanel } from '../ui/InvariantPanel';
import { Timeline } from '../ui/Timeline';
import { MetricsBar } from '../ui/MetricsBar';
import { fmtTime } from '../lib/format';
import type { NodeRuntime, NodeView } from '../sim/types';

const NAMES = ['A', 'B', 'C', 'D', 'E', 'F', 'G'];
const KEYS = ['x', 'y', 'z'];

const NET_PRESETS = [
  { name: 'LAN', min: 20, max: 60, drop: 0 },
  { name: 'WAN', min: 80, max: 200, drop: 0 },
  { name: 'Lossy', min: 20, max: 80, drop: 0.15 },
];

const WRITE_COLOR = '#7c9cff';
const READ_COLOR = '#73e08a';

const MSG_COLOR = (t: string): string => {
  if (t === 'Query') return '#b08bff';
  if (t === 'QueryAck') return '#d3b8ff';
  if (t === 'Write') return WRITE_COLOR;
  if (t === 'WriteAck') return READ_COLOR;
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
  { name: 'Classic (5·LAN)', hint: 'five replicas, low latency — clean two-round-trip reads and writes', cfg: { seed: 42, count: 5, net: 0 } },
  { name: 'WAN 5-node', hint: 'wide-area latency — watch the two phases stretch out', cfg: { seed: 7, count: 5, net: 1 } },
  { name: 'Lossy 5-node', hint: '15% drops — the retry timer re-drives stalled phases', cfg: { seed: 13, count: 5, net: 2 } },
  { name: 'Big ring (7)', hint: 'seven replicas — larger quorums, more concurrency', cfg: { seed: 5, count: 7, net: 0 } },
];

export function AbdLab() {
  const initial = useMemo(() => ({ ...DEFAULT_SCENARIO, ...readHash() }), []);
  const [seed, setSeed] = useState(initial.seed);
  const [count, setCount] = useState(initial.count);
  const [net, setNet] = useState(initial.net);
  const [key, setKey] = useState('x');
  const [selected, setSelected] = useState<string | null>(null);
  const [counter, setCounter] = useState(1);
  const [copied, setCopied] = useState(false);

  const nodeIds = useMemo(() => NAMES.slice(0, count), [count]);

  useEffect(() => {
    const q = new URLSearchParams({ seed: String(seed), n: String(count), net: String(net) });
    history.replaceState(null, '', `#/abd?${q.toString()}`);
  }, [seed, count, net]);

  const makeKernel = useCallback(() => {
    const proto = createAbd(DEFAULT_ABD_CONFIG);
    proto.invariants = abdInvariants as (n: ReadonlyArray<NodeView<AbdState>>) => ReturnType<typeof abdInvariants>;
    const p = NET_PRESETS[net];
    return new Kernel<AbdState, AbdCmd>({
      seed,
      protocol: proto,
      nodeIds,
      network: { minLatency: p.min, maxLatency: p.max, dropRate: p.drop },
    });
  }, [seed, nodeIds, net]);

  const ctrl = useSimulation(makeKernel);
  const snap = ctrl.snapshot;
  const nodes = useMemo(() => (snap?.nodes ?? []) as NodeRuntime<AbdState>[], [snap]);
  const now = snap?.time ?? 0;

  const upIds = nodeIds.filter((id) => nodes.find((n) => n.id === id)?.up);

  // Aggregate the completed-operation history across all coordinators, de-duped.
  const opHistory = useMemo(() => {
    const seen = new Set<string>();
    const all: CompletedOp[] = [];
    for (const n of nodes) {
      for (const op of n.state.history) {
        if (seen.has(op.id)) continue;
        seen.add(op.id);
        all.push(op);
      }
    }
    all.sort((a, b) => a.startedAt - b.startedAt || a.finishedAt - b.finishedAt);
    return all;
  }, [nodes]);

  const keyHistory = useMemo(() => opHistory.filter((o) => o.key === key), [opHistory, key]);

  const totals = useMemo(() => {
    let reads = 0, writes = 0, pending = 0;
    for (const n of nodes) {
      reads += n.state.reads;
      writes += n.state.writes;
      pending += Object.keys(n.state.pending).length;
    }
    return { reads, writes, pending };
  }, [nodes]);

  const write = (target: string, k: string, value: string) => {
    ctrl.command(target, { type: 'write', key: k, value });
    setCounter((c) => c + 1);
  };
  const read = (target: string, k: string) => {
    ctrl.command(target, { type: 'read', key: k });
    setCounter((c) => c + 1);
  };

  const writeOne = () => {
    const tgt = (selected && nodes.find((n) => n.id === selected)?.up ? selected : upIds[counter % Math.max(1, upIds.length)]) ?? nodeIds[0];
    write(tgt, key, `${key}${counter}`);
  };
  const readOne = () => {
    const tgt = (selected && nodes.find((n) => n.id === selected)?.up ? selected : upIds[(counter + 1) % Math.max(1, upIds.length)]) ?? nodeIds[0];
    read(tgt, key);
  };
  const concurrentWriters = () => {
    // Several replicas write the SAME key at once — concurrent writers, distinct
    // tags, one wins; linearizability still holds.
    upIds.slice(0, Math.min(3, upIds.length)).forEach((id) => write(id, key, `${id}${counter}`));
  };
  const crashWriterMidFlight = () => {
    const tgt = upIds[0];
    if (!tgt) return;
    write(tgt, key, `orphan${counter}`);
    ctrl.crash(tgt);
  };

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

  const visual = useCallback(
    (node: NodeRuntime<AbdState>): NodeVisual => {
      const s = node.state;
      const reg = s.store[key];
      const pending = Object.keys(s.pending).length;
      return {
        fill: pending > 0 ? '#b08bff' : '#3f7d68',
        ring: 'rgba(255,255,255,0.25)',
        label: node.id,
        sub: reg ? `${reg.value || '∅'} @${tagStr(reg.tag)}` : '∅ @⊥',
        badge: pending > 0 ? String(pending) : undefined,
        glow: pending > 0,
        down: !node.up,
      };
    },
    [key],
  );

  const sel = selected ? nodes.find((n) => n.id === selected) : undefined;

  return (
    <div className="lab">
      <div className="lab-intro">
        <h2>ABD · linearizable storage without consensus</h2>
        <p>
          Every other lab here reaches <b>consensus</b> — an agreed total order of commands. <b>ABD</b>{' '}
          (Attiya–Bar-Noy–Dolev, 1995) shows that if all you need is a <b>linearizable read/write
          register</b>, you don't need consensus at all: just <b>majority quorums</b> and two round trips,
          with <em>no leader and no log</em>. A write{' '}
          <span style={{ color: WRITE_COLOR }}>reads the latest tag from a majority, then writes under a
          strictly newer tag</span>; a read{' '}
          <span style={{ color: READ_COLOR }}>finds the newest (tag, value) in a majority, then writes it
          back</span> before returning — that write-back is the whole trick that stops a later read going
          backwards in time. The timeline below is the real operation history; the invariants on the right
          <b> prove it linearizable live</b> as you add concurrent writers, crash the writer, and partition
          the network.
        </p>
      </div>

      <ControlBar
        ctrl={ctrl}
        seed={seed}
        onSeed={setSeed}
        right={
          <span className="leader-pill has" title="ABD needs no leader — any replica coordinates any operation">
            no leader · {totals.writes}w / {totals.reads}r
          </span>
        }
      />

      <div className="lab-grid">
        <div className="lab-main">
          <div className="cluster-toolbar">
            <div className="ctl-group">
              <label>Replicas</label>
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
              <label>Register</label>
              {KEYS.map((kk) => (
                <button key={kk} className={`btn tiny ${key === kk ? 'on' : ''}`} onClick={() => setKey(kk)}>
                  {kk}
                </button>
              ))}
            </div>
            <div className="legend">
              <span><i style={{ background: WRITE_COLOR }} /> write</span>
              <span><i style={{ background: READ_COLOR }} /> read</span>
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
              height={330}
            />
          )}

          <div className="action-row">
            <button className="btn primary" onClick={writeOne} title={`Write a fresh value to register "${key}" via some replica`}>
              ✎ Write {key}
            </button>
            <button className="btn" onClick={readOne} title={`Read register "${key}" (query majority, then write-back)`}>
              👁 Read {key}
            </button>
            <button className="btn" onClick={concurrentWriters} title="Several replicas write the same register at once — concurrent writers, distinct tags">
              ⇉ Concurrent writers
            </button>
            <button className="btn" onClick={crashWriterMidFlight} title="Write, then immediately crash the coordinator — the value still survives via the quorum">
              ☠ Crash writer
            </button>
            <button className="btn" onClick={ctrl.reset}>
              ↺ New cluster
            </button>
          </div>

          <div className="action-row">
            {sel ? (
              <>
                <span className="op-target">{sel.id}:</span>
                <button className="btn" onClick={() => write(sel.id, key, `${key}${counter}`)}>write here</button>
                <button className="btn" onClick={() => read(sel.id, key)}>read here</button>
                <button className={`btn ${sel.up ? 'danger' : 'good'}`} onClick={() => (sel.up ? ctrl.crash(sel.id) : ctrl.restart(sel.id))}>
                  {sel.up ? `✕ Crash ${sel.id}` : `⏼ Restart ${sel.id}`}
                </button>
              </>
            ) : (
              <span className="muted">Click a replica to coordinate an op there or crash it, or a link's midpoint to cut it. The timeline below is the linearizable history of register <b>{key}</b>.</span>
            )}
          </div>

          <HistoryTimeline ops={keyHistory} now={now} regKey={key} />

          {snap && <MetricsBar metrics={snap.metrics} />}
        </div>

        <div className="lab-side">
          <InvariantPanel invariants={ctrl.invariants} title="Linearizability" />

          <div className="lab-aux">
            <div className="panel-head">
              <span>Operation tally</span>
              <span className="muted">{totals.pending} in flight</span>
            </div>
            <div className="lab-aux-body">
              <div className="replica-row"><span className="replica-id">writes committed</span><code className="replica-val" style={{ color: WRITE_COLOR }}>{totals.writes}</code></div>
              <div className="replica-row"><span className="replica-id">reads committed</span><code className="replica-val" style={{ color: READ_COLOR }}>{totals.reads}</code></div>
              <div className="replica-row"><span className="replica-id">history (key {key})</span><code className="replica-val">{keyHistory.length}</code></div>
            </div>
          </div>

          <div className="lab-aux">
            <div className="panel-head">
              <span>Register “{key}” per replica</span>
            </div>
            <div className="lab-aux-body">
              {nodes.map((n) => {
                const reg = n.state.store[key];
                return (
                  <div key={n.id} className="replica-row">
                    <span className="replica-id">{n.id}{n.up ? '' : ' ✕'}</span>
                    <code className="replica-val" style={{ color: reg ? '#e8eaf0' : '#5b6472' }}>
                      {reg ? `${reg.value || '∅'} @ ${tagStr(reg.tag)}` : '∅ @ ⊥'}
                    </code>
                  </div>
                );
              })}
            </div>
          </div>

          <div className="lab-aux">
            <div className="panel-head"><span>Why no consensus?</span></div>
            <div className="lab-aux-body" style={{ padding: '8px 12px', fontSize: 12, color: 'var(--tx-dim)' }}>
              A register has no <i>order of commands</i> to agree on — only a latest value. Two majorities
              always intersect, so a write's tag is provably newer than any finished write, and a read's
              write-back makes its result durable. That is enough for linearizability, and it needs no
              leader election and no log — the cheap, fault-tolerant way to share one cell of state.
            </div>
          </div>
        </div>
      </div>

      <Timeline log={snap?.log ?? []} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// The linearizability history: a Jepsen-style real-time chart of completed
// operations on one register. Each bar spans an operation's [start, finish];
// reads and writes are colour-coded and labelled with their value and tag. Tag
// order increases left-to-right for non-overlapping ops — that is the property
// the "Real-time atomicity" invariant checks.
// ---------------------------------------------------------------------------

function HistoryTimeline({ ops, now, regKey }: { ops: CompletedOp[]; now: number; regKey: string }) {
  const recent = ops.slice(-40);
  const empty = recent.length === 0;

  const t0 = empty ? 0 : recent[0].startedAt;
  const t1 = Math.max(now, empty ? 1 : recent[recent.length - 1].finishedAt);
  const span = Math.max(1, t1 - t0);

  const padL = 8;
  const padR = 8;
  const width = 760;
  const rowH = 26;
  const innerW = width - padL - padR;
  const x = (t: number) => padL + ((t - t0) / span) * innerW;

  // Pack operations into lanes so overlapping ops don't collide.
  const lanes: number[] = []; // lane → last finish x
  const placed = recent.map((op) => {
    const sx = x(op.startedAt);
    let lane = 0;
    while (lane < lanes.length && lanes[lane] > sx - 2) lane++;
    lanes[lane] = x(op.finishedAt);
    return { op, lane };
  });
  const height = Math.max(rowH, lanes.length * rowH) + 12;

  return (
    <div className="depgraph">
      <div className="panel-head">
        <span>Linearizability history · register “{regKey}”</span>
        <span className="muted">each bar = one operation’s real-time span · tag increases for non-overlapping ops</span>
      </div>
      <div className="depgraph-scroll">
        {empty ? (
          <div className="muted pad">No operations yet — press <b>Write</b> or <b>Read</b> above.</div>
        ) : (
          <svg width={width} height={height} className="depgraph-svg">
            {placed.map(({ op, lane }) => {
              const x0 = x(op.startedAt);
              const x1 = Math.max(x0 + 30, x(op.finishedAt));
              const y = 6 + lane * rowH;
              const color = op.kind === 'write' ? WRITE_COLOR : READ_COLOR;
              const label = `${op.kind === 'write' ? '=' : '→'}${op.value || '∅'} ·${tagStr(op.tag)}`;
              return (
                <g key={op.id}>
                  <line x1={x0} y1={y + 9} x2={x1} y2={y + 9} stroke={color} strokeWidth={2} opacity={0.5} />
                  <circle cx={x0} cy={y + 9} r={3} fill={color} />
                  <rect x={x1 - 2} y={y + 6} width={5} height={6} fill={color} />
                  <text x={x0 + 3} y={y + 5} className="abd-op-label" fill={color}>
                    {op.coord}:{op.kind === 'write' ? 'W' : 'R'} {label}
                  </text>
                </g>
              );
            })}
            <line x1={x(now)} y1={0} x2={x(now)} y2={height} stroke="rgba(255,255,255,0.25)" strokeDasharray="3 3" />
          </svg>
        )}
      </div>
      <div className="depgraph-foot muted">
        A read’s bar carries the same tag it wrote back. Because any two majorities intersect, a read can
        never return a tag older than a write that finished before it began — the line never goes backwards.
        Time {fmtTime(t0)} → {fmtTime(t1)}.
      </div>
    </div>
  );
}
