import { useCallback, useEffect, useMemo, useState } from 'react';
import { Kernel } from '../sim/kernel';
import { createPaxos } from '../protocols/paxos/paxos';
import { paxosInvariants } from '../protocols/paxos/invariants';
import {
  DEFAULT_PAXOS_CONFIG,
  ballotStr,
  valueStr,
  type PaxosCmd,
  type PaxosState,
  type PaxosValue,
} from '../protocols/paxos/types';
import { useSimulation } from '../lib/useSimulation';
import { NetworkCanvas, type NodeVisual } from '../ui/NetworkCanvas';
import { ControlBar } from '../ui/ControlBar';
import { InvariantPanel } from '../ui/InvariantPanel';
import { Timeline } from '../ui/Timeline';
import { MetricsBar } from '../ui/MetricsBar';
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
];

const ROLE_COLOR: Record<string, string> = {
  leader: '#73e08a',
  preparing: '#b08bff',
  idle: '#5b6472',
};

const MSG_COLOR = (t: string): string => {
  if (t === 'Prepare') return '#b08bff';
  if (t === 'Promise') return '#d3b8ff';
  if (t === 'Accept') return '#7c9cff';
  if (t === 'Accepted') return '#5bd6c8';
  if (t === 'Chosen') return '#73e08a';
  if (t === 'Heartbeat') return '#3f4b5e';
  if (t === 'Forward') return '#ffb454';
  return '#9aa2b1';
};

interface ScenarioCfg {
  seed: number;
  count: number;
  net: number;
  backoff: boolean;
}
const DEFAULT_SCENARIO: ScenarioCfg = { seed: 42, count: 5, net: 0, backoff: true };

function readHash(): Partial<ScenarioCfg> {
  try {
    const q = window.location.hash.split('?')[1];
    if (!q) return {};
    const p = new URLSearchParams(q);
    const out: Partial<ScenarioCfg> = {};
    if (p.has('seed')) out.seed = Number(p.get('seed')) || 0;
    if (p.has('n')) out.count = Number(p.get('n')) || 5;
    if (p.has('net')) out.net = Number(p.get('net')) || 0;
    if (p.has('bo')) out.backoff = p.get('bo') !== '0';
    return out;
  } catch {
    return {};
  }
}

const PRESETS: { name: string; hint: string; cfg: ScenarioCfg }[] = [
  { name: 'Classic (5·LAN)', hint: 'one leader, steady single-round-trip commits', cfg: { seed: 42, count: 5, net: 0, backoff: true } },
  { name: 'Dueling proposers', hint: 'force two proposers to compete — watch ballots leapfrog, then converge', cfg: { seed: 7, count: 5, net: 1, backoff: true } },
  { name: 'Livelock (no backoff)', hint: 'same timeout on every node — competing proposers can starve each other', cfg: { seed: 3, count: 5, net: 0, backoff: false } },
  { name: 'Lossy 7-node', hint: '15% drops on a bigger cluster — Paxos just retries', cfg: { seed: 13, count: 7, net: 2, backoff: true } },
];

export function PaxosLab() {
  const initial = useMemo(() => ({ ...DEFAULT_SCENARIO, ...readHash() }), []);
  const [seed, setSeed] = useState(initial.seed);
  const [count, setCount] = useState(initial.count);
  const [net, setNet] = useState(initial.net);
  const [backoff, setBackoff] = useState(initial.backoff);
  const [selected, setSelected] = useState<string | null>(null);
  const [counter, setCounter] = useState(1);
  const [copied, setCopied] = useState(false);

  const nodeIds = useMemo(() => NAMES.slice(0, count), [count]);

  useEffect(() => {
    const q = new URLSearchParams({ seed: String(seed), n: String(count), net: String(net), bo: backoff ? '1' : '0' });
    history.replaceState(null, '', `#/paxos?${q.toString()}`);
  }, [seed, count, net, backoff]);

  const makeKernel = useCallback(() => {
    const proto = createPaxos({ ...DEFAULT_PAXOS_CONFIG, randomizedBackoff: backoff ? 1 : 0 });
    proto.invariants = paxosInvariants as (n: ReadonlyArray<NodeView<PaxosState>>) => ReturnType<typeof paxosInvariants>;
    const p = NET_PRESETS[net];
    return new Kernel<PaxosState, PaxosCmd>({
      seed,
      protocol: proto,
      nodeIds,
      network: { minLatency: p.min, maxLatency: p.max, dropRate: p.drop },
    });
  }, [seed, nodeIds, net, backoff]);

  const ctrl = useSimulation(makeKernel);
  const snap = ctrl.snapshot;
  const nodes = useMemo(() => (snap?.nodes ?? []) as NodeRuntime<PaxosState>[], [snap]);

  const leader = nodes.find((n) => n.up && n.state.role === 'leader');
  const anyState = nodes[0]?.state;

  // A unified, gap-aware view of the chosen log across the cluster.
  const chosenLog = useMemo(() => {
    const merged: Record<number, PaxosValue> = {};
    let max = 0;
    for (const n of nodes) {
      for (const k of Object.keys(n.state.chosen)) {
        const i = Number(k);
        merged[i] = n.state.chosen[i];
        if (i > max) max = i;
      }
    }
    const rows: { slot: number; value: PaxosValue | null }[] = [];
    for (let i = 1; i <= max; i++) rows.push({ slot: i, value: merged[i] ?? null });
    return rows;
  }, [nodes]);

  const propose = (target: string, value: PaxosValue) => {
    ctrl.command(target, { type: 'propose', value });
    setCounter((c) => c + 1);
  };

  const proposeRandom = () => {
    const tgt = leader?.id ?? selected ?? nodeIds[0];
    const key = ['x', 'y', 'z'][counter % 3];
    propose(tgt, { op: 'set', key, value: String(counter), cid: 'u' + counter });
  };

  const visual = useCallback(
    (node: NodeRuntime<PaxosState>): NodeVisual => {
      const s = node.state;
      return {
        fill: ROLE_COLOR[s.role] ?? '#5b6472',
        ring: s.role === 'leader' ? '#fff' : 'rgba(255,255,255,0.2)',
        label: node.id,
        sub: s.role === 'leader' ? `leader ${ballotStr(s.myBallot)}` : s.role === 'preparing' ? `prep ${ballotStr(s.myBallot)}` : `n_p ${ballotStr(s.minProposal)}`,
        badge: s.applied > 0 ? `⊙${s.applied}` : undefined,
        glow: s.role !== 'idle',
        down: !node.up,
      };
    },
    [],
  );

  const sel = selected ? nodes.find((n) => n.id === selected) : undefined;

  const applyPreset = (cfg: ScenarioCfg) => {
    setSeed(cfg.seed);
    setCount(cfg.count);
    setNet(cfg.net);
    setBackoff(cfg.backoff);
  };

  const dueling = () => {
    // Make two ends of the ring compete for slot 1 at once.
    const a = nodeIds[0];
    const z = nodeIds[nodeIds.length - 1];
    ctrl.command(a, { type: 'propose', value: { op: 'set', key: 'w', value: a, cid: 'd' + a } });
    ctrl.command(z, { type: 'prepare' });
    ctrl.command(z, { type: 'propose', value: { op: 'set', key: 'w', value: z, cid: 'd' + z } });
  };

  const copyLink = () => {
    const url = `${location.origin}${location.pathname}${location.hash}`;
    void navigator.clipboard?.writeText(url).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    });
  };

  return (
    <div className="lab">
      <div className="lab-intro">
        <h2>Multi-Paxos · consensus from the Synod up</h2>
        <p>
          Raft is leader-first; <b>Paxos</b> is built from the bottom on one idea — a totally-ordered,
          globally-unique <b>ballot</b> — and two round-trips: <span style={{ color: ROLE_COLOR.preparing }}>Phase 1
          (Prepare/Promise)</span> to become the proposer, then <span style={{ color: MSG_COLOR('Accept') }}>Phase 2
          (Accept/Accepted)</span> to drive a value into a slot. A majority of Accepts <b>chooses</b> it. The
          subtle, beautiful part: a new leader must <em>re-propose the value already accepted at the highest
          ballot</em>, so a value once chosen can never be replaced — which is exactly what the live
          <b> Quorum-backing</b> invariant witnesses. One Phase 1 makes a node the stable leader for all future
          slots (Multi-Paxos), so steady-state commits cost a single round-trip.
        </p>
      </div>

      <ControlBar
        ctrl={ctrl}
        seed={seed}
        onSeed={setSeed}
        right={
          <span className={`leader-pill ${leader ? 'has' : 'none'}`}>
            {leader ? `leader ${leader.id} · ${ballotStr(leader.state.myBallot)}` : 'no leader'}
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
            <div className="ctl-group">
              <label>Backoff</label>
              <button className={`btn tiny ${backoff ? 'on' : ''}`} onClick={() => setBackoff(true)} title="Randomized election timeouts dissolve the dueling-proposer livelock">
                random
              </button>
              <button className={`btn tiny ${!backoff ? 'on' : ''}`} onClick={() => setBackoff(false)} title="Identical timeouts everywhere — watch competing proposers livelock">
                none
              </button>
            </div>
            <div className="legend">
              <span><i style={{ background: ROLE_COLOR.leader }} /> leader</span>
              <span><i style={{ background: ROLE_COLOR.preparing }} /> preparing (Phase 1)</span>
              <span><i style={{ background: ROLE_COLOR.idle }} /> acceptor</span>
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
              ▶ Propose a value
            </button>
            <button className="btn" onClick={dueling} title="Force two proposers to compete for the same slot">
              ⚔ Dueling proposers
            </button>
            {leader ? (
              <button
                className="btn"
                onClick={() => ctrl.command(leader.id, { type: 'heartbeat-disable', on: !leader.state.hbOff })}
                title="Silence the leader's heartbeats (without crashing it) to trigger a re-election"
              >
                {leader.state.hbOff ? '🔊 Resume leader' : '🔇 Silence leader'}
              </button>
            ) : null}
            <button className="btn" onClick={ctrl.reset}>
              ↺ New cluster
            </button>
          </div>

          <div className="action-row">
            {sel ? (
              <>
                <span className="op-target">{sel.id}:</span>
                <button className="btn" onClick={() => ctrl.command(sel.id, { type: 'prepare' })} title="Force this node to start Phase 1 with a higher ballot">
                  ⤴ Force Phase 1
                </button>
                <button className="btn" onClick={() => propose(sel.id, { op: 'set', key: 'x', value: String(counter), cid: 's' + counter })}>
                  propose here
                </button>
                <button className={`btn ${sel.up ? 'danger' : 'good'}`} onClick={() => (sel.up ? ctrl.crash(sel.id) : ctrl.restart(sel.id))}>
                  {sel.up ? `✕ Crash ${sel.id}` : `⏼ Restart ${sel.id}`}
                </button>
              </>
            ) : (
              <span className="muted">Click a node to inspect it, force a Phase 1, or crash it. Click a link's midpoint to cut/heal it.</span>
            )}
          </div>

          {snap && <MetricsBar metrics={snap.metrics} />}
        </div>

        <div className="lab-side">
          <InvariantPanel invariants={ctrl.invariants} title="Paxos safety" />

          <div className="lab-aux">
            <div className="panel-head">
              <span>Chosen log</span>
              {anyState && <span className="muted">applied ≤ {Math.max(0, ...nodes.map((n) => n.state.applied))}</span>}
            </div>
            <div className="lab-aux-body">
              {chosenLog.length === 0 && <div className="muted pad">No slot chosen yet — propose a value.</div>}
              {chosenLog.map((r) => (
                <div key={r.slot} className="replica-row">
                  <span className="replica-id">slot {r.slot}</span>
                  <code className="replica-val" style={{ color: r.value ? MSG_COLOR('Chosen') : '#5b6472' }}>
                    {r.value ? valueStr(r.value) : '… not yet chosen'}
                  </code>
                </div>
              ))}
            </div>
          </div>

          {sel && (
            <div className="lab-aux">
              <div className="panel-head">
                <span>Acceptor · {sel.id}{sel.up ? '' : ' ✕'}</span>
                <span className="muted">{sel.state.role}</span>
              </div>
              <div className="lab-aux-body">
                <div className="replica-row">
                  <span className="replica-id">minProposal n_p</span>
                  <code className="replica-val">{ballotStr(sel.state.minProposal)}</code>
                </div>
                <div className="replica-row">
                  <span className="replica-id">my ballot</span>
                  <code className="replica-val">{ballotStr(sel.state.myBallot)}</code>
                </div>
                {Object.keys(sel.state.slots)
                  .map(Number)
                  .sort((a, b) => a - b)
                  .map((i) => {
                    const sl = sel.state.slots[i];
                    return (
                      <div key={i} className="replica-row">
                        <span className="replica-id">slot {i}</span>
                        <code className="replica-val">
                          {valueStr(sl.acceptedValue)} @ {ballotStr(sl.acceptedBallot)}
                        </code>
                      </div>
                    );
                  })}
                <div className="replica-row">
                  <span className="replica-id">note</span>
                  <code className="replica-val" style={{ color: '#9aa2b1' }}>{sel.state.note}</code>
                </div>
              </div>
            </div>
          )}

          <div className="lab-aux">
            <div className="panel-head">
              <span>Replicated KV (leader)</span>
            </div>
            <div className="lab-aux-body">
              {leader && Object.keys(leader.state.kv).length === 0 && <div className="muted pad">empty</div>}
              {!leader && <div className="muted pad">no leader</div>}
              {leader &&
                Object.keys(leader.state.kv)
                  .sort()
                  .map((k) => (
                    <div key={k} className="replica-row">
                      <span className="replica-id">{k}</span>
                      <code className="replica-val">{leader.state.kv[k]}</code>
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
