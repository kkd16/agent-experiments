import { useCallback, useEffect, useMemo, useState } from 'react';
import { Kernel } from '../sim/kernel';
import { createCraq } from '../protocols/craq/craq';
import { craqInvariants, craqGauge } from '../protocols/craq/invariants';
import {
  DEFAULT_CRAQ_CONFIG,
  emptyKeyStore,
  maxVer,
  isDirty,
  committedValue,
  latestValue,
  headOf,
  tailOf,
  type CraqCmd,
  type CraqState,
  type CompletedOp,
  type ChainConfig,
  type KeyStore,
} from '../protocols/craq/types';
import { useSimulation } from '../lib/useSimulation';
import { NetworkCanvas, type NodeVisual } from '../ui/NetworkCanvas';
import { ControlBar } from '../ui/ControlBar';
import { InvariantPanel } from '../ui/InvariantPanel';
import { Timeline } from '../ui/Timeline';
import { MetricsBar } from '../ui/MetricsBar';
import { fmtTime } from '../lib/format';
import type { NodeRuntime, NodeView } from '../sim/types';

const REPLICAS = ['A', 'B', 'C', 'D', 'E'];
const KEYS = ['x', 'y', 'z'];

const NET_PRESETS = [
  { name: 'LAN', min: 20, max: 60, drop: 0 },
  { name: 'WAN', min: 80, max: 200, drop: 0 },
  { name: 'Lossy', min: 20, max: 80, drop: 0.15 },
];

const WRITE_COLOR = '#7c9cff';
const READ_COLOR = '#73e08a';
const DIRTY_COLOR = '#e0a34a';
const MASTER_COLOR = '#b08bff';

const MSG_COLOR = (t: string): string => {
  switch (t) {
    case 'Ping':
    case 'Pong':
      return '#5b6472';
    case 'Config':
    case 'Sync':
      return MASTER_COLOR;
    case 'ClientWrite':
    case 'Update':
      return WRITE_COLOR;
    case 'Ack':
      return READ_COLOR;
    case 'VersionQuery':
      return DIRTY_COLOR;
    case 'VersionReply':
      return '#5bd6c8';
    default:
      return '#9aa2b1';
  }
};

interface ScenarioCfg {
  seed: number;
  count: number;
  net: number;
}
const DEFAULT_SCENARIO: ScenarioCfg = { seed: 42, count: 4, net: 0 };

function readHash(): Partial<ScenarioCfg> {
  try {
    const q = window.location.hash.split('?')[1];
    if (!q) return {};
    const p = new URLSearchParams(q);
    const out: Partial<ScenarioCfg> = {};
    if (p.has('seed')) out.seed = Number(p.get('seed')) || 0;
    if (p.has('n')) out.count = Number(p.get('n')) || 4;
    if (p.has('net')) out.net = Number(p.get('net')) || 0;
    return out;
  } catch {
    return {};
  }
}

const PRESETS: { name: string; hint: string; cfg: ScenarioCfg }[] = [
  { name: 'Classic (4·LAN)', hint: 'master + four-node chain, low latency — clean local reads, tail-confirmed dirty reads', cfg: { seed: 42, count: 4, net: 0 } },
  { name: 'WAN chain', hint: 'wide-area latency — watch updates march down the chain and acks crawl back', cfg: { seed: 7, count: 4, net: 1 } },
  { name: 'Lossy chain', hint: '15% drops — the head re-drives stalled updates until the tail acks', cfg: { seed: 13, count: 4, net: 2 } },
  { name: 'Long chain (5)', hint: 'five replicas — more apportioned read capacity, longer propagation', cfg: { seed: 5, count: 5, net: 0 } },
];

/** Pick the freshest config across the replicas (highest epoch wins). */
function freshestConfig(nodes: NodeRuntime<CraqState>[]): ChainConfig {
  let best: ChainConfig = { epoch: -1, chain: [], activeAt: 0 };
  for (const n of nodes) if (n.state.role === 'replica' && n.state.config.epoch > best.epoch) best = n.state.config;
  return best.epoch < 0 ? { epoch: 0, chain: [], activeAt: 0 } : best;
}

export function CraqLab() {
  const initial = useMemo(() => ({ ...DEFAULT_SCENARIO, ...readHash() }), []);
  const [seed, setSeed] = useState(initial.seed);
  const [count, setCount] = useState(initial.count);
  const [net, setNet] = useState(initial.net);
  const [key, setKey] = useState('x');
  const [selected, setSelected] = useState<string | null>(null);
  const [counter, setCounter] = useState(1);
  const [copied, setCopied] = useState(false);

  const replicaIds = useMemo(() => REPLICAS.slice(0, count), [count]);
  const nodeIds = useMemo(() => ['M', ...replicaIds], [replicaIds]);

  useEffect(() => {
    const q = new URLSearchParams({ seed: String(seed), n: String(count), net: String(net) });
    history.replaceState(null, '', `#/craq?${q.toString()}`);
  }, [seed, count, net]);

  const makeKernel = useCallback(() => {
    const proto = createCraq({ master: 'M', config: DEFAULT_CRAQ_CONFIG });
    proto.invariants = craqInvariants as (n: ReadonlyArray<NodeView<CraqState>>) => ReturnType<typeof craqInvariants>;
    const p = NET_PRESETS[net];
    return new Kernel<CraqState, CraqCmd>({
      seed,
      protocol: proto,
      nodeIds,
      network: { minLatency: p.min, maxLatency: p.max, dropRate: p.drop },
    });
  }, [seed, nodeIds, net]);

  const ctrl = useSimulation(makeKernel);
  const snap = ctrl.snapshot;
  const nodes = useMemo(() => (snap?.nodes ?? []) as NodeRuntime<CraqState>[], [snap]);
  const now = snap?.time ?? 0;

  const config = useMemo(() => freshestConfig(nodes), [nodes]);
  const head = headOf(config);
  const tail = tailOf(config);

  const views = useMemo<NodeView<CraqState>[]>(() => nodes.map((n) => ({ id: n.id, up: n.up, state: n.state })), [nodes]);
  const gauge = useMemo(() => craqGauge(views), [views]);

  // Aggregate completed-operation history across all coordinators, de-duped.
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
    let reads = 0, writes = 0, cleanR = 0, dirtyR = 0;
    for (const n of nodes) {
      reads += n.state.reads;
      writes += n.state.writes;
      cleanR += n.state.cleanReads;
      dirtyR += n.state.dirtyReads;
    }
    return { reads, writes, cleanR, dirtyR };
  }, [nodes]);

  const replicaNodes = useMemo(() => nodes.filter((n) => n.state.role === 'replica'), [nodes]);

  const write = (value: string) => {
    if (head) ctrl.command(head, { type: 'write', key, value });
    setCounter((c) => c + 1);
  };
  const read = (target: string) => {
    ctrl.command(target, { type: 'read', key });
    setCounter((c) => c + 1);
  };

  const writeOne = () => write(`${key}${counter}`);
  const readOne = () => {
    const live = replicaIds.filter((id) => nodes.find((n) => n.id === id)?.up);
    const tgt = (selected && selected !== 'M' && nodes.find((n) => n.id === selected)?.up ? selected : live[counter % Math.max(1, live.length)]) ?? replicaIds[0];
    read(tgt);
  };
  const readEverywhere = () => {
    // Every replica answers the same read at once — clean ones locally, dirty
    // ones via the tail. CRAQ's apportioned-query throughput, made visible.
    replicaIds.filter((id) => nodes.find((n) => n.id === id)?.up).forEach((id) => read(id));
  };
  const writeThenReadAll = () => {
    // Fire a write and immediately read every replica: most are still dirty, so
    // they must consult the tail — you watch the version queries fan out.
    writeOne();
    readEverywhere();
  };
  const crashTail = () => {
    if (tail) ctrl.crash(tail);
  };
  const crashHead = () => {
    if (head) ctrl.crash(head);
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

  const roleOf = useCallback(
    (id: string): string => {
      if (id === 'M') return 'master';
      if (!config.chain.includes(id)) return 'passive';
      if (config.chain.length === 1) return 'head+tail';
      if (id === head) return 'head';
      if (id === tail) return 'tail';
      return 'middle';
    },
    [config, head, tail],
  );

  const visual = useCallback(
    (node: NodeRuntime<CraqState>): NodeVisual => {
      const s = node.state;
      const r = roleOf(node.id);
      if (r === 'master') {
        return { fill: MASTER_COLOR, ring: 'rgba(255,255,255,0.3)', label: 'M', sub: `cfg #${s.config.epoch}`, glow: false, down: !node.up };
      }
      const ksv = s.store[key] ?? emptyKeyStore();
      const dirty = isDirty(ksv);
      const pend = Object.keys(s.pendingWrites).length + Object.keys(s.pendingReads).length;
      const fill = r === 'passive' ? '#39404d' : r === 'head' ? WRITE_COLOR : r === 'tail' ? READ_COLOR : '#3f7d68';
      return {
        fill,
        ring: dirty ? DIRTY_COLOR : 'rgba(255,255,255,0.22)',
        label: node.id,
        sub: `${committedValue(ksv) || '∅'} @v${ksv.committed}${dirty ? ` ·d${maxVer(ksv)}` : ''}`,
        badge: pend > 0 ? String(pend) : r === 'head' || r === 'tail' ? r[0].toUpperCase() : undefined,
        glow: dirty,
        down: !node.up,
        dim: r === 'passive',
      };
    },
    [key, roleOf],
  );

  const sel = selected ? nodes.find((n) => n.id === selected) : undefined;

  return (
    <div className="lab">
      <div className="lab-intro">
        <h2>CRAQ · chain replication with apportioned reads</h2>
        <p>
          The consensus and quorum labs make every replica equal. <b>Chain Replication</b>{' '}
          (van&nbsp;Renesse&nbsp;&amp;&nbsp;Schneider, 2004) instead lines the replicas up{' '}
          <span style={{ color: WRITE_COLOR }}>HEAD</span> → … → <span style={{ color: READ_COLOR }}>TAIL</span>.
          A write enters at the head and{' '}
          <span style={{ color: WRITE_COLOR }}>flows down the chain</span>; the tail commits it and an{' '}
          <span style={{ color: READ_COLOR }}>ack flows back up</span>. Because all updates serialize through one
          chain and reads come from the one tail, the store is <b>linearizable</b> — no quorums, no leader, just a
          small <span style={{ color: MASTER_COLOR }}>master</span> that owns the chain order.{' '}
          <b>CRAQ</b> (2009) then lets <em>every</em> replica answer reads: a{' '}
          <span style={{ color: READ_COLOR }}>clean</span> object is read locally, a{' '}
          <span style={{ color: DIRTY_COLOR }}>dirty</span> one asks the tail for its committed version — so reads
          scale with the chain yet never go stale. The invariants on the right <b>prove it linearizable live</b> as
          you crash the head, the tail, and the master.
        </p>
      </div>

      <ControlBar
        ctrl={ctrl}
        seed={seed}
        onSeed={setSeed}
        right={
          <span className="leader-pill has" title="The master owns the chain; the head ingests writes, the tail commits them">
            chain {config.chain.join('→') || '∅'} · cfg #{config.epoch}
          </span>
        }
      />

      <div className="lab-grid">
        <div className="lab-main">
          <div className="cluster-toolbar">
            <div className="ctl-group">
              <label>Replicas</label>
              {[3, 4, 5].map((c) => (
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
              <label>Object</label>
              {KEYS.map((kk) => (
                <button key={kk} className={`btn tiny ${key === kk ? 'on' : ''}`} onClick={() => setKey(kk)}>
                  {kk}
                </button>
              ))}
            </div>
            <div className="legend">
              <span><i style={{ background: READ_COLOR }} /> clean</span>
              <span><i style={{ background: DIRTY_COLOR }} /> dirty</span>
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

          <ChainStrip nodes={replicaNodes} config={config} regKey={key} />

          {snap && (
            <NetworkCanvas
              snapshot={snap}
              nodeOrder={ctrl.nodeOrder}
              visual={visual}
              selected={selected}
              onSelect={setSelected}
              onToggleLink={(a, b) => ctrl.toggleLink(a, b)}
              messageColor={MSG_COLOR}
              height={300}
            />
          )}

          <div className="action-row">
            <button className="btn primary" onClick={writeOne} title={`Write a fresh value to "${key}" at the head`}>
              ✎ Write {key} (head {head ?? '?'})
            </button>
            <button className="btn" onClick={readOne} title={`Read "${key}" from one replica (clean → local, dirty → tail)`}>
              👁 Read {key}
            </button>
            <button className="btn" onClick={readEverywhere} title="Every replica answers the same read — apportioned-query throughput">
              ⇉ Read everywhere
            </button>
            <button className="btn" onClick={writeThenReadAll} title="Write then immediately read all replicas — watch dirty reads consult the tail">
              ⚡ Write + read all
            </button>
            <button className="btn" onClick={ctrl.reset}>↺ New cluster</button>
          </div>

          <div className="action-row">
            <button className="btn danger" onClick={crashHead} title="Crash the head — the master promotes its successor, writes resume there">
              ☠ Crash head
            </button>
            <button className="btn danger" onClick={crashTail} title="Crash the tail — the master makes the predecessor the new tail; it commits its in-flight updates">
              ☠ Crash tail
            </button>
            <button className="btn danger" onClick={() => ctrl.crash('M')} title="Crash the master — leases lapse and the chain goes passive (the master is the SPOF, Paxos-replicated in practice)">
              ☠ Crash master
            </button>
            {sel ? (
              <>
                <span className="op-target">{sel.id} ({roleOf(sel.id)}):</span>
                {sel.id !== 'M' && <button className="btn" onClick={() => read(sel.id)}>read here</button>}
                <button className={`btn ${sel.up ? 'danger' : 'good'}`} onClick={() => (sel.up ? ctrl.crash(sel.id) : ctrl.restart(sel.id))}>
                  {sel.up ? `✕ Crash ${sel.id}` : `⏼ Restart ${sel.id}`}
                </button>
              </>
            ) : (
              <span className="muted">Click a node to read/crash it, or restart a crashed one. The strip above shows the version stack of <b>{key}</b> at each chain position.</span>
            )}
          </div>

          <HistoryTimeline ops={keyHistory} now={now} regKey={key} />

          {snap && <MetricsBar metrics={snap.metrics} />}
        </div>

        <div className="lab-side">
          <InvariantPanel invariants={ctrl.invariants} title="Linearizability" />

          <div className="lab-aux">
            <div className="panel-head">
              <span>CRAQ reads</span>
              <span className="muted">apportioned across {config.chain.length} replicas</span>
            </div>
            <div className="lab-aux-body">
              <div className="replica-row"><span className="replica-id">clean (served locally)</span><code className="replica-val" style={{ color: READ_COLOR }}>{totals.cleanR}</code></div>
              <div className="replica-row"><span className="replica-id">dirty (asked the tail)</span><code className="replica-val" style={{ color: DIRTY_COLOR }}>{totals.dirtyR}</code></div>
              <div className="replica-row"><span className="replica-id">writes committed</span><code className="replica-val" style={{ color: WRITE_COLOR }}>{totals.writes}</code></div>
              <div className="replica-row"><span className="replica-id">dirty objects at tail</span><code className="replica-val">{gauge.dirtyKeys}</code></div>
            </div>
          </div>

          <div className="lab-aux">
            <div className="panel-head"><span>Object “{key}” per replica</span></div>
            <div className="lab-aux-body">
              {replicaNodes.map((n) => {
                const ksv = n.state.store[key] ?? emptyKeyStore();
                const dirty = isDirty(ksv);
                const r = roleOf(n.id);
                return (
                  <div key={n.id} className="replica-row">
                    <span className="replica-id">{n.id}{n.up ? '' : ' ✕'} <span className="muted" style={{ fontSize: 10 }}>{r}</span></span>
                    <code className="replica-val" style={{ color: dirty ? DIRTY_COLOR : '#e8eaf0' }}>
                      {committedValue(ksv) || '∅'} @v{ksv.committed}{dirty ? ` → ${latestValue(ksv)}·v${maxVer(ksv)}?` : ''}
                    </code>
                  </div>
                );
              })}
            </div>
          </div>

          <div className="lab-aux">
            <div className="panel-head"><span>Why a chain?</span></div>
            <div className="lab-aux-body" style={{ padding: '8px 12px', fontSize: 12, color: 'var(--tx-dim)' }}>
              A quorum write touches ⌈n/2⌉+1 replicas; a chain write touches each replica exactly once and the head
              only talks to one neighbour, so throughput scales with chain length. The price is latency (an update
              must walk the whole chain) and a master to repair the chain on failure. CRAQ keeps the reads strongly
              consistent while spreading them across <em>every</em> replica — ideal for read-heavy stores.
            </div>
          </div>

          <div className="lab-aux">
            <div className="panel-head"><span>How safety survives faults</span></div>
            <div className="lab-aux-body" style={{ padding: '8px 12px', fontSize: 12, color: 'var(--tx-dim)' }}>
              Three leases keep reads linearizable as the cluster churns. A <b>config lease</b>: a replica that stops
              hearing the master goes passive (no stale answers from a partitioned node). A <b>chain-currency beat</b>:
              the head heartbeats its committed frontier down the chain — a node that falls behind, or stops hearing
              beats, stops serving and re-syncs. And <b>lease-based reconfiguration</b>: a new chain only commits new
              writes once the previous config's leases have provably expired. A new head also <em>pulls</em> the
              committed frontier from the chain before serving, and a recovered node re-syncs at the tail before it
              answers — so it never serves data it has not caught up to.
            </div>
          </div>

          <div className="lab-aux">
            <div className="panel-head"><span>The master is the price</span></div>
            <div className="lab-aux-body" style={{ padding: '8px 12px', fontSize: 12, color: 'var(--tx-dim)' }}>
              Chain replication is a <b>CP</b> system: it chooses consistency over availability. The master is a single
              point of control (in production it is itself replicated by Paxos/ZooKeeper) — crash it here and the chain
              goes passive rather than risk divergence. And like every replicated store, a write only survives while at
              least one reachable replica still holds it: a partition severe enough to isolate <em>every</em> copy of a
              committed write is the CAP wall no chain can climb.
            </div>
          </div>
        </div>
      </div>

      <Timeline log={snap?.log ?? []} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// The chain strip — the signature picture. Replicas are drawn left→right in
// chain order (HEAD … TAIL); each shows its version stack for the selected key,
// clean versions in green and dirty (propagating) ones in amber. Arrows hint at
// the update-down / ack-up flow.
// ---------------------------------------------------------------------------

function ChainStrip({ nodes, config, regKey }: { nodes: NodeRuntime<CraqState>[]; config: ChainConfig; regKey: string }) {
  const ordered = config.chain.map((id) => nodes.find((n) => n.id === id)).filter((n): n is NodeRuntime<CraqState> => !!n);
  const passive = nodes.filter((n) => !config.chain.includes(n.id));

  const cell = (n: NodeRuntime<CraqState>, role: string) => {
    const ksv: KeyStore = n.state.store[regKey] ?? emptyKeyStore();
    const versions = ksv.versions.slice(-5);
    return (
      <div key={n.id} className={`craq-node ${n.up ? '' : 'down'} role-${role}`}>
        <div className="craq-node-head">
          <span className="craq-node-id">{n.id}{n.up ? '' : ' ✕'}</span>
          <span className="craq-role">{role}</span>
        </div>
        <div className="craq-stack">
          {versions.length === 0 && <span className="craq-empty">∅</span>}
          {versions.map((v) => {
            const clean = v.ver <= ksv.committed;
            return (
              <span key={v.ver} className={`craq-ver ${clean ? 'clean' : 'dirty'}`} title={`v${v.ver} = ${v.value} (${clean ? 'clean/committed' : 'dirty/propagating'})`}>
                v{v.ver}:{v.value || '∅'}
              </span>
            );
          })}
        </div>
      </div>
    );
  };

  return (
    <div className="craq-strip-wrap">
      <div className="panel-head">
        <span>Chain · object “{regKey}”</span>
        <span className="muted">writes flow head→tail ▶ · acks flow tail→head ◀ · config #{config.epoch}</span>
      </div>
      <div className="craq-strip">
        {ordered.length === 0 && <div className="muted pad">No live chain — restart a replica or the master.</div>}
        {ordered.map((n, i) => {
          const role = ordered.length === 1 ? 'head+tail' : i === 0 ? 'head' : i === ordered.length - 1 ? 'tail' : 'middle';
          return (
            <div key={n.id} className="craq-link">
              {cell(n, role)}
              {i < ordered.length - 1 && <span className="craq-arrow">▶</span>}
            </div>
          );
        })}
      </div>
      {passive.length > 0 && (
        <div className="craq-passive">
          <span className="muted">passive (out of chain):</span>
          {passive.map((n) => cell(n, 'passive'))}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Linearizability history — a Jepsen-style real-time chart of completed ops on
// one object. Reads and writes are colour-coded; a clean read and a dirty read
// are distinguished, and each bar carries the committed version it observed.
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

  const lanes: number[] = [];
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
        <span>Linearizability history · object “{regKey}”</span>
        <span className="muted">each bar = one operation’s real-time span · committed version increases for non-overlapping ops</span>
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
              const color = op.kind === 'write' ? WRITE_COLOR : op.readPath === 'dirty' ? DIRTY_COLOR : READ_COLOR;
              const label = `${op.kind === 'write' ? '=' : '→'}${op.value || '∅'} ·v${op.ver}`;
              return (
                <g key={op.id}>
                  <line x1={x0} y1={y + 9} x2={x1} y2={y + 9} stroke={color} strokeWidth={2} opacity={0.5} />
                  <circle cx={x0} cy={y + 9} r={3} fill={color} />
                  <rect x={x1 - 2} y={y + 6} width={5} height={6} fill={color} />
                  <text x={x0 + 3} y={y + 5} className="abd-op-label" fill={color}>
                    {op.coord}:{op.kind === 'write' ? 'W' : op.readPath === 'dirty' ? 'R↧' : 'R'} {label}
                  </text>
                </g>
              );
            })}
            <line x1={x(now)} y1={0} x2={x(now)} y2={height} stroke="rgba(255,255,255,0.25)" strokeDasharray="3 3" />
          </svg>
        )}
      </div>
      <div className="depgraph-foot muted">
        A read’s bar carries the committed version it returned (<b>R</b> served locally, <b>R↧</b> confirmed by the
        tail). Because the tail commits every update in one order, the version never goes backwards for
        non-overlapping ops — that is linearizability. Time {fmtTime(t0)} → {fmtTime(t1)}.
      </div>
    </div>
  );
}
