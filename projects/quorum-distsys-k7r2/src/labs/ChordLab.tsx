import { useCallback, useEffect, useMemo, useState } from 'react';
import { Kernel } from '../sim/kernel';
import { createChord } from '../protocols/chord/chord';
import { chordInvariants } from '../protocols/chord/invariants';
import { DEFAULT_CHORD_CONFIG, type ChordCmd, type ChordState } from '../protocols/chord/types';
import { hashId, ownerOf } from '../protocols/chord/ring';
import { useSimulation } from '../lib/useSimulation';
import { ChordRing, type RingNode } from '../ui/ChordRing';
import { ControlBar } from '../ui/ControlBar';
import { InvariantPanel } from '../ui/InvariantPanel';
import { Timeline } from '../ui/Timeline';
import { MetricsBar } from '../ui/MetricsBar';
import type { NodeView } from '../sim/types';

const NAMES = ['A', 'B', 'C', 'D', 'E', 'F', 'G'];
const M = DEFAULT_CHORD_CONFIG.m;
const SIZE = 1 << M;

const KEY_NAMES = ['cart:42', 'user:7', 'file:A', 'img:99', 'doc:5', 'db:k7', 'sess:3', 'blob:Z'];

interface ScenarioCfg {
  seed: number;
  count: number;
}
const DEFAULT_SCENARIO: ScenarioCfg = { seed: 42, count: 7 };

function readHash(): Partial<ScenarioCfg> {
  try {
    const q = window.location.hash.split('?')[1];
    if (!q) return {};
    const p = new URLSearchParams(q);
    const out: Partial<ScenarioCfg> = {};
    if (p.has('seed')) out.seed = Number(p.get('seed')) || 0;
    if (p.has('n')) out.count = Number(p.get('n')) || 7;
    return out;
  } catch {
    return {};
  }
}

export function ChordLab() {
  const initial = useMemo(() => ({ ...DEFAULT_SCENARIO, ...readHash() }), []);
  const [seed, setSeed] = useState(initial.seed);
  const [count, setCount] = useState(initial.count);
  const [selected, setSelected] = useState<string | null>(null);
  const [lastOrigin, setLastOrigin] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const nodeIds = useMemo(() => NAMES.slice(0, count), [count]);

  useEffect(() => {
    const q = new URLSearchParams({ seed: String(seed), n: String(count) });
    history.replaceState(null, '', `#/chord?${q.toString()}`);
  }, [seed, count]);

  const makeKernel = useCallback(() => {
    const proto = createChord(DEFAULT_CHORD_CONFIG);
    proto.invariants = chordInvariants as (n: ReadonlyArray<NodeView<ChordState>>) => ReturnType<typeof chordInvariants>;
    return new Kernel<ChordState, ChordCmd>({
      seed,
      protocol: proto,
      nodeIds,
      network: { minLatency: 20, maxLatency: 60, dropRate: 0 },
    });
  }, [seed, nodeIds]);

  const ctrl = useSimulation(makeKernel);
  const snap = ctrl.snapshot;

  const ringNodes: RingNode[] = useMemo(() => {
    const ns = snap?.nodes ?? [];
    return ns.map((n) => {
      const s = n.state as ChordState;
      return {
        name: n.id,
        id: s.id,
        up: n.up,
        joined: s.joined,
        successor: s.successorList[0] ?? s.id,
        predecessor: s.predecessor,
        finger: s.finger,
      };
    });
  }, [snap]);

  const liveIds = ringNodes.filter((n) => n.up && n.joined).map((n) => n.id);
  const idToName = useMemo(() => {
    const m = new Map<number, string>();
    for (const n of ringNodes) m.set(n.id, n.name);
    return m;
  }, [ringNodes]);

  const sampleKeys = useMemo(() => KEY_NAMES.map((k) => ({ name: k, id: hashId(k, M) })), []);

  const originState = lastOrigin ? (snap?.nodes.find((n) => n.id === lastOrigin)?.state as ChordState | undefined) : undefined;
  const lastLookup = originState?.lastLookup ?? null;

  const lookup = (origin: string, key: number) => {
    setLastOrigin(origin);
    ctrl.command(origin, { type: 'lookup', key: ((key % SIZE) + SIZE) % SIZE });
  };

  const lookupKeyName = (name: string) => {
    const fallback = liveIds.length ? (idToName.get(liveIds[0]) ?? nodeIds[0]) : nodeIds[0];
    const origin = selected ?? fallback;
    lookup(origin, hashId(name, M));
  };

  const copyLink = () => {
    const url = `${location.origin}${location.pathname}${location.hash}`;
    void navigator.clipboard?.writeText(url).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    });
  };

  const sel = selected ? ringNodes.find((n) => n.name === selected) : undefined;
  const selState = selected ? (snap?.nodes.find((n) => n.id === selected)?.state as ChordState | undefined) : undefined;

  // Distinct finger entries (index → target) for the inspector.
  const fingerRows = useMemo(() => {
    if (!sel) return [];
    const rows: { i: number; start: number; target: number }[] = [];
    for (let i = 0; i < M; i++) rows.push({ i, start: (sel.id + (1 << i)) % SIZE, target: sel.finger[i] });
    return rows;
  }, [sel]);

  return (
    <div className="lab">
      <div className="lab-intro">
        <h2>Chord · a distributed hash table on a consistent-hashing ring</h2>
        <p>
          Nodes and keys share one circular identifier space; a key lives on its <b>successor</b> — the
          first node clockwise. Each node keeps a <b>finger table</b> of <code>m</code> shortcuts (to the
          successor of <code>id+2<sup>i</sup></code>), so a lookup halves the remaining distance every hop
          and reaches the owner in <b>O(log N)</b> jumps. No coordinator: a periodic <b>stabilization</b>
          protocol (stabilize · notify · fix-fingers · check-predecessor) keeps the pointers correct and
          <em> heals the ring</em> as nodes join and crash. Pick a key to watch a lookup hop around the ring;
          crash a node and watch the ring re-converge.
        </p>
      </div>

      <ControlBar
        ctrl={ctrl}
        seed={seed}
        onSeed={setSeed}
        right={<span className={`leader-pill ${liveIds.length ? 'has' : 'none'}`}>{liveIds.length} on ring · m={M} ({SIZE} ids)</span>}
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
              <label>Look up key</label>
              {sampleKeys.map((k) => (
                <button key={k.name} className="btn tiny" title={`hash = ${k.id}`} onClick={() => lookupKeyName(k.name)}>
                  {k.name}
                </button>
              ))}
            </div>
            <button className="btn tiny" onClick={copyLink} title="Copy a shareable link to this exact ring">
              {copied ? '✓ copied' : '⎘ link'}
            </button>
          </div>

          {snap && (
            <ChordRing
              m={M}
              nodes={ringNodes}
              selected={selected}
              onSelect={setSelected}
              keys={sampleKeys.map((k) => k.id)}
              lookupPath={lastLookup?.path ?? null}
              lookupKey={lastLookup?.key ?? null}
              height={440}
            />
          )}

          <div className="action-row">
            <button className="btn primary" onClick={() => lookupKeyName(KEY_NAMES[(seed + (snap?.step ?? 0)) % KEY_NAMES.length])}>
              ▶ Look up a key
            </button>
            {sel && (
              <button className={`btn ${sel.up ? 'danger' : 'good'}`} onClick={() => (sel.up ? ctrl.crash(sel.name) : ctrl.restart(sel.name))}>
                {sel.up ? `✕ Crash ${sel.name}` : `⏼ Restart ${sel.name}`}
              </button>
            )}
            <button className="btn" onClick={ctrl.reset}>
              ↺ New ring
            </button>
          </div>
          <div className="action-row">
            {!sel && <span className="muted">Click a node to inspect its fingers, successor and predecessor — or crash it and watch the ring heal.</span>}
            {sel && <span className="op-target">{sel.name} (id {sel.id}) selected — its finger chords are drawn across the ring.</span>}
          </div>

          {snap && <MetricsBar metrics={snap.metrics} />}
        </div>

        <div className="lab-side">
          <InvariantPanel invariants={ctrl.invariants} title="Ring health (eventual)" />

          <div className="lab-aux">
            <div className="panel-head">
              <span>Key ownership</span>
            </div>
            <div className="lab-aux-body">
              {sampleKeys.map((k) => {
                const owner = ownerOf(k.id, liveIds);
                const hue = owner === null ? 0 : (owner * 67) % 360;
                return (
                  <div key={k.name} className="replica-row">
                    <span className="replica-id">{k.name}<span className="muted"> · {k.id}</span></span>
                    <code className="replica-val" style={{ color: owner === null ? '#5b6472' : `hsl(${hue} 70% 65%)` }}>
                      {owner === null ? '—' : `${idToName.get(owner) ?? '?'} (${owner})`}
                    </code>
                  </div>
                );
              })}
            </div>
          </div>

          {lastLookup && (
            <div className="lab-aux">
              <div className="panel-head">
                <span>Last lookup{lastOrigin ? ` from ${lastOrigin}` : ''}</span>
                <span className="muted">{lastLookup.hops} hops</span>
              </div>
              <div className="lab-aux-body">
                <div className="replica-row">
                  <span className="replica-id">key</span>
                  <code className="replica-val">{lastLookup.key}</code>
                </div>
                <div className="replica-row">
                  <span className="replica-id">owner</span>
                  <code className="replica-val" style={{ color: '#73e08a' }}>{idToName.get(lastLookup.owner) ?? '?'} ({lastLookup.owner})</code>
                </div>
                <div className="replica-row">
                  <span className="replica-id">path</span>
                  <code className="replica-val">{lastLookup.path.map((id) => idToName.get(id) ?? id).join(' → ')}</code>
                </div>
              </div>
            </div>
          )}

          {sel && selState && (
            <div className="lab-aux">
              <div className="panel-head">
                <span>Node {sel.name}{sel.up ? '' : ' ✕'} · id {sel.id}</span>
              </div>
              <div className="lab-aux-body">
                <div className="replica-row">
                  <span className="replica-id">successor</span>
                  <code className="replica-val">{idToName.get(sel.successor) ?? sel.successor} ({sel.successor})</code>
                </div>
                <div className="replica-row">
                  <span className="replica-id">predecessor</span>
                  <code className="replica-val">{sel.predecessor === null ? '—' : `${idToName.get(sel.predecessor) ?? '?'} (${sel.predecessor})`}</code>
                </div>
                <div className="replica-row">
                  <span className="replica-id">succ list</span>
                  <code className="replica-val">{selState.successorList.map((id) => idToName.get(id) ?? id).join(', ')}</code>
                </div>
                <div className="finger-head">finger table (start → owner)</div>
                {fingerRows.map((r) => (
                  <div key={r.i} className="replica-row">
                    <span className="replica-id">+2<sup>{r.i}</sup> = {r.start}</span>
                    <code className="replica-val">{idToName.get(r.target) ?? r.target} ({r.target})</code>
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
