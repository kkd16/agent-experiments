import { useCallback, useEffect, useMemo, useState } from 'react';
import { Kernel } from '../sim/kernel';
import { createKademlia } from '../protocols/kademlia/kademlia';
import { kademliaInvariants } from '../protocols/kademlia/invariants';
import { DEFAULT_KADEMLIA_CONFIG, type KademliaCmd, type KademliaState } from '../protocols/kademlia/types';
import { hashId, kClosest, xorDist } from '../protocols/kademlia/xor';
import { allContacts } from '../protocols/kademlia/routing';
import { useSimulation } from '../lib/useSimulation';
import { KademliaTree, type TrieNodeView } from '../ui/KademliaTree';
import { ControlBar } from '../ui/ControlBar';
import { InvariantPanel } from '../ui/InvariantPanel';
import { Timeline } from '../ui/Timeline';
import { MetricsBar } from '../ui/MetricsBar';
import type { NodeView } from '../sim/types';

const NAMES = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H'];
const M = DEFAULT_KADEMLIA_CONFIG.m;
const SIZE = 1 << M;
const KEY_NAMES = ['file:hello', 'user:7', 'img:99', 'doc:5', 'blob:Z', 'sess:3'];

interface ScenarioCfg {
  seed: number;
  count: number;
  k: number;
}
const DEFAULT_SCENARIO: ScenarioCfg = { seed: 42, count: 8, k: 4 };

function readHash(): Partial<ScenarioCfg> {
  try {
    const q = window.location.hash.split('?')[1];
    if (!q) return {};
    const p = new URLSearchParams(q);
    const out: Partial<ScenarioCfg> = {};
    if (p.has('seed')) out.seed = Number(p.get('seed')) || 0;
    if (p.has('n')) out.count = Number(p.get('n')) || 8;
    if (p.has('k')) out.k = Number(p.get('k')) || 4;
    return out;
  } catch {
    return {};
  }
}

export function KademliaLab() {
  const initial = useMemo(() => ({ ...DEFAULT_SCENARIO, ...readHash() }), []);
  const [seed, setSeed] = useState(initial.seed);
  const [count, setCount] = useState(initial.count);
  const [k, setK] = useState(initial.k);
  const [selected, setSelected] = useState<string | null>(null);
  const [lastOrigin, setLastOrigin] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const nodeIds = useMemo(() => NAMES.slice(0, count), [count]);

  useEffect(() => {
    const q = new URLSearchParams({ seed: String(seed), n: String(count), k: String(k) });
    history.replaceState(null, '', `#/kademlia?${q.toString()}`);
  }, [seed, count, k]);

  const makeKernel = useCallback(() => {
    const proto = createKademlia({ ...DEFAULT_KADEMLIA_CONFIG, k });
    proto.invariants = kademliaInvariants as (n: ReadonlyArray<NodeView<KademliaState>>) => ReturnType<typeof kademliaInvariants>;
    return new Kernel<KademliaState, KademliaCmd>({
      seed,
      protocol: proto,
      nodeIds,
      network: { minLatency: 20, maxLatency: 60, dropRate: 0 },
    });
  }, [seed, nodeIds, k]);

  const ctrl = useSimulation(makeKernel);
  const snap = ctrl.snapshot;

  const trieNodes: TrieNodeView[] = useMemo(() => {
    const ns = snap?.nodes ?? [];
    return ns.map((n) => {
      const s = n.state as KademliaState;
      return { name: n.id, id: s.id, up: n.up, joined: s.joined };
    });
  }, [snap]);

  const liveIds = trieNodes.filter((n) => n.up && n.joined).map((n) => n.id);
  const idToName = useMemo(() => {
    const map = new Map<number, string>();
    for (const n of trieNodes) map.set(n.id, n.name);
    return map;
  }, [trieNodes]);

  const sampleKeys = useMemo(() => KEY_NAMES.map((key) => ({ name: key, id: hashId(key, M) })), []);

  const selState = selected ? (snap?.nodes.find((n) => n.id === selected)?.state as KademliaState | undefined) : undefined;
  const contacts = useMemo(() => new Set(selState ? allContacts(selState.rt) : []), [selState]);

  const originState = lastOrigin ? (snap?.nodes.find((n) => n.id === lastOrigin)?.state as KademliaState | undefined) : undefined;
  const lastResult = originState?.lastResult ?? null;

  const probed = useMemo(() => new Set(lastResult?.path ?? []), [lastResult]);
  const resultSet = useMemo(() => new Set(lastResult?.closest ?? []), [lastResult]);

  const pickOrigin = () => {
    const fallback = liveIds.length ? (idToName.get(liveIds[0]) ?? nodeIds[0]) : nodeIds[0];
    return selected ?? fallback;
  };

  const doLookup = (target: number) => {
    const origin = pickOrigin();
    setLastOrigin(origin);
    ctrl.command(origin, { type: 'lookup', target: ((target % SIZE) + SIZE) % SIZE });
  };
  const doGet = (key: number) => {
    const origin = pickOrigin();
    setLastOrigin(origin);
    ctrl.command(origin, { type: 'get', key });
  };
  const doPut = (key: number, value: string) => {
    const origin = pickOrigin();
    setLastOrigin(origin);
    ctrl.command(origin, { type: 'put', key, value });
  };

  const copyLink = () => {
    const url = `${location.origin}${location.pathname}${location.hash}`;
    void navigator.clipboard?.writeText(url).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    });
  };

  const sel = selected ? trieNodes.find((n) => n.name === selected) : undefined;

  // The selected node's k-buckets, sorted MSB→LSB (far → near).
  const bucketRows = useMemo(() => {
    if (!selState) return [];
    const rows: { bit: number; ids: number[] }[] = [];
    for (let b = M - 1; b >= 0; b--) {
      const ids = selState.rt.buckets[b] ?? [];
      if (ids.length) rows.push({ bit: b, ids: [...ids] });
    }
    return rows;
  }, [selState]);

  const storedRows = useMemo(() => {
    if (!selState) return [];
    return Object.entries(selState.store).map(([key, val]) => ({ key: Number(key), val }));
  }, [selState]);

  const targetForTree = lastResult ? lastResult.target : null;

  return (
    <div className="lab">
      <div className="lab-intro">
        <h2>Kademlia · a distributed hash table on the XOR metric</h2>
        <p>
          The DHT behind BitTorrent's Mainline, IPFS, Ethereum's discv5 and Storj. Node ids and keys share
          one <code>m</code>-bit space and closeness is measured by <b>XOR</b> — a metric so well-behaved
          that each node organises its routing table into one <b>k-bucket per bit</b>, holding up to{' '}
          <code>k</code> live contacts in the corresponding subtree of the id trie (drawn below as the
          shaded regions hanging off the selected node's path). Where Chord's lookup is <em>recursive</em>,
          Kademlia's is <b>iterative and parallel</b>: the initiator itself keeps <code>α</code> probes in
          flight to the closest contacts it knows, folds every reply back into a shortlist, and walks{' '}
          <em>down the tree toward the target</em> until the frontier closes on the true{' '}
          <code>k</code> nearest nodes. Shrink <code>k</code> to force real multi-hop lookups; crash nodes
          and watch bucket-refresh heal the tables.
        </p>
      </div>

      <ControlBar
        ctrl={ctrl}
        seed={seed}
        onSeed={setSeed}
        right={<span className={`leader-pill ${liveIds.length ? 'has' : 'none'}`}>{liveIds.length} in DHT · m={M} · k={k} · α={DEFAULT_KADEMLIA_CONFIG.alpha}</span>}
      />

      <div className="lab-grid">
        <div className="lab-main">
          <div className="cluster-toolbar">
            <div className="ctl-group">
              <label>Nodes</label>
              {[4, 6, 8].map((c) => (
                <button key={c} className={`btn tiny ${count === c ? 'on' : ''}`} onClick={() => setCount(c)}>
                  {c}
                </button>
              ))}
            </div>
            <div className="ctl-group">
              <label>k-bucket size</label>
              {[2, 3, 4, 6].map((kk) => (
                <button key={kk} className={`btn tiny ${k === kk ? 'on' : ''}`} onClick={() => setK(kk)} title={kk <= 3 ? 'small k ⇒ partial tables ⇒ real multi-hop lookups' : undefined}>
                  {kk}
                </button>
              ))}
            </div>
            <button className="btn tiny" onClick={copyLink} title="Copy a shareable link to this exact network">
              {copied ? '✓ copied' : '⎘ link'}
            </button>
          </div>

          {snap && (
            <KademliaTree
              m={M}
              nodes={trieNodes}
              selected={selected}
              onSelect={setSelected}
              contacts={contacts}
              target={targetForTree}
              probed={probed}
              result={resultSet}
            />
          )}

          <div className="action-row">
            <div className="ctl-group">
              <label>Look up key</label>
              {sampleKeys.map((key) => (
                <button key={key.name} className="btn tiny" title={`id = ${key.id}`} onClick={() => doLookup(key.id)}>
                  {key.name}
                </button>
              ))}
            </div>
          </div>
          <div className="action-row">
            <button className="btn primary" onClick={() => doPut(sampleKeys[(seed + (snap?.step ?? 0)) % sampleKeys.length].id, `v${(snap?.step ?? 0) % 100}`)}>
              ▶ PUT a key
            </button>
            <button className="btn" onClick={() => doGet(sampleKeys[(seed + (snap?.step ?? 0)) % sampleKeys.length].id)}>
              ⇩ GET a key
            </button>
            {sel && (
              <button className={`btn ${sel.up ? 'danger' : 'good'}`} onClick={() => (sel.up ? ctrl.crash(sel.name) : ctrl.restart(sel.name))}>
                {sel.up ? `✕ Crash ${sel.name}` : `⏼ Restart ${sel.name}`}
              </button>
            )}
            <button className="btn" onClick={ctrl.reset}>
              ↺ New network
            </button>
          </div>
          <div className="action-row">
            {!sel && <span className="muted">Click a node to read its routing table as the trie's shaded buckets — or crash it and watch the tables heal.</span>}
            {sel && <span className="op-target">{sel.name} (id {sel.id}) selected — its k-buckets are the shaded subtrees; ⭘ marks its contacts.</span>}
          </div>

          {snap && <MetricsBar metrics={snap.metrics} />}
        </div>

        <div className="lab-side">
          <InvariantPanel invariants={ctrl.invariants} title="Routing health (eventual)" />

          {lastResult && (
            <div className="lab-aux">
              <div className="panel-head">
                <span>
                  Last {lastResult.kind === 'value' ? 'GET' : lastResult.kind === 'store' ? 'PUT' : 'lookup'}
                  {lastOrigin ? ` from ${lastOrigin}` : ''}
                </span>
                <span className="muted">{lastResult.rounds} probes</span>
              </div>
              <div className="lab-aux-body">
                <div className="replica-row">
                  <span className="replica-id">{lastResult.kind === 'node' ? 'target' : 'key'}</span>
                  <code className="replica-val">{lastResult.target}</code>
                </div>
                {lastResult.kind === 'value' && (
                  <div className="replica-row">
                    <span className="replica-id">value</span>
                    <code className="replica-val" style={{ color: lastResult.found ? '#73e08a' : '#ff6b8b' }}>
                      {lastResult.found ? `"${lastResult.value}"` : 'not found'}
                    </code>
                  </div>
                )}
                <div className="replica-row">
                  <span className="replica-id">k-closest</span>
                  <code className="replica-val" style={{ color: '#73e08a' }}>
                    {lastResult.closest.map((id) => `${idToName.get(id) ?? '?'}·${id}`).join(', ')}
                  </code>
                </div>
                <div className="replica-row">
                  <span className="replica-id">probe path</span>
                  <code className="replica-val">{lastResult.path.map((id) => idToName.get(id) ?? id).join(' → ') || '(local)'}</code>
                </div>
                <div className="replica-row">
                  <span className="replica-id">true k-closest</span>
                  <code className="replica-val muted">{kClosest(lastResult.target, liveIds, k).map((id) => `${idToName.get(id) ?? '?'}·${id}`).join(', ')}</code>
                </div>
              </div>
            </div>
          )}

          {sel && selState && (
            <div className="lab-aux">
              <div className="panel-head">
                <span>Node {sel.name}{sel.up ? '' : ' ✕'} · id {sel.id}</span>
                <span className="muted">{contacts.size} contacts</span>
              </div>
              <div className="lab-aux-body">
                <div className="finger-head">k-buckets (bit · far → near)</div>
                {bucketRows.length === 0 && <span className="muted">no contacts yet</span>}
                {bucketRows.map((r) => {
                  const hue = (r.bit * 40 + 200) % 360;
                  return (
                    <div key={r.bit} className="replica-row">
                      <span className="replica-id" style={{ color: `hsl(${hue} 70% 70%)` }}>bucket {r.bit}</span>
                      <code className="replica-val">
                        {r.ids
                          .map((id) => `${idToName.get(id) ?? '?'}·${id} (⊕${xorDist(sel.id, id)})`)
                          .join(', ')}
                      </code>
                    </div>
                  );
                })}
                {storedRows.length > 0 && (
                  <>
                    <div className="finger-head">stored key/value pairs</div>
                    {storedRows.map((r) => (
                      <div key={r.key} className="replica-row">
                        <span className="replica-id">key {r.key}</span>
                        <code className="replica-val">"{r.val}"</code>
                      </div>
                    ))}
                  </>
                )}
              </div>
            </div>
          )}

          <div className="lab-aux">
            <div className="panel-head">
              <span>Key placement</span>
            </div>
            <div className="lab-aux-body">
              {sampleKeys.map((key) => {
                const owners = kClosest(key.id, liveIds, Math.min(k, liveIds.length || 1));
                return (
                  <div key={key.name} className="replica-row">
                    <span className="replica-id">{key.name}<span className="muted"> · {key.id}</span></span>
                    <code className="replica-val">{owners.map((id) => idToName.get(id) ?? '?').join(', ') || '—'}</code>
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      </div>

      <Timeline log={snap?.log ?? []} />
    </div>
  );
}
