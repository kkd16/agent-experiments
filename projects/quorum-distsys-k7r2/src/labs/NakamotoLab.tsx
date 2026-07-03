import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Kernel } from '../sim/kernel';
import { createNakamoto } from '../protocols/nakamoto/nakamoto';
import { nakInvariants, nakGauge } from '../protocols/nakamoto/invariants';
import {
  DEFAULT_NAK_CONFIG,
  ledgerOf,
  chainOf,
  heightOf,
  shortHash,
  type NakState,
  type NakCmd,
  type Tx,
} from '../protocols/nakamoto/types';
import { useSimulation } from '../lib/useSimulation';
import { NetworkCanvas, type NodeVisual } from '../ui/NetworkCanvas';
import { ControlBar } from '../ui/ControlBar';
import { InvariantPanel } from '../ui/InvariantPanel';
import { BlockTree } from '../ui/BlockTree';
import { Timeline } from '../ui/Timeline';
import { MetricsBar } from '../ui/MetricsBar';
import type { NodeRuntime, NodeView } from '../sim/types';

const NAMES = 'ABCDEFGHIJKLMNOPQRST'.split('');

const NET_PRESETS = [
  { name: 'LAN', min: 15, max: 45, drop: 0 },
  { name: 'WAN', min: 80, max: 240, drop: 0 },
  { name: 'Lossy', min: 30, max: 90, drop: 0.12 },
];

const MSG_COLOR = (t: string): string => (t === 'Block' ? '#5bd6c8' : t === 'GetBlock' ? '#ffd479' : '#9aa2b1');
const MSG_GLYPH = (t: string): string => (t === 'Block' ? '▪' : '?');

/** A stable hue for a tip hash, so nodes on different forks show different colours. */
function tipHue(tip: string): number {
  let h = 0;
  for (let i = 0; i < tip.length; i++) h = (h * 31 + tip.charCodeAt(i)) | 0;
  return ((h % 360) + 360) % 360;
}

interface ScenarioCfg {
  seed: number;
  n: number;
  net: number;
  k: number;
  blockMs: number;
}

const DEFAULT_SCENARIO: ScenarioCfg = { seed: 42, n: 7, net: 0, k: DEFAULT_NAK_CONFIG.k, blockMs: DEFAULT_NAK_CONFIG.baseBlockMs };

function readHash(): Partial<ScenarioCfg> {
  try {
    const q = window.location.hash.split('?')[1];
    if (!q) return {};
    const p = new URLSearchParams(q);
    const out: Partial<ScenarioCfg> = {};
    if (p.has('seed')) out.seed = Number(p.get('seed')) || 0;
    if (p.has('n')) out.n = Number(p.get('n')) || 7;
    if (p.has('net')) out.net = Number(p.get('net')) || 0;
    if (p.has('k')) out.k = Number(p.get('k')) || 4;
    if (p.has('ms')) out.blockMs = Number(p.get('ms')) || DEFAULT_NAK_CONFIG.baseBlockMs;
    return out;
  } catch {
    return {};
  }
}

const PRESETS: { name: string; hint: string; cfg: ScenarioCfg }[] = [
  { name: 'Steady chain', hint: 'seven equal miners on a fast LAN — blocks arrive, the odd fork appears and resolves within a block or two', cfg: { seed: 42, n: 7, net: 0, k: 4, blockMs: 2600 } },
  { name: 'Fork-prone WAN', hint: 'high latency means two miners often find a block before hearing the other — watch competing forks and orphans pile up, then the longest chain win', cfg: { seed: 3, n: 8, net: 1, k: 4, blockMs: 1600 } },
  { name: 'Lossy network', hint: 'drops force nodes to backfill missing ancestors via GetBlock — the chain still converges', cfg: { seed: 7, n: 7, net: 2, k: 4, blockMs: 2600 } },
  { name: 'Fast finality (k=2)', hint: 'confirm after only 2 blocks — quicker, but a shallow reorg can now revert a "final" block', cfg: { seed: 5, n: 7, net: 0, k: 2, blockMs: 2200 } },
];

export function NakamotoLab() {
  const initial = useMemo(() => ({ ...DEFAULT_SCENARIO, ...readHash() }), []);
  const [seed, setSeed] = useState(initial.seed);
  const [n, setN] = useState(initial.n);
  const [net, setNet] = useState(initial.net);
  const [k, setK] = useState(initial.k);
  const [blockMs, setBlockMs] = useState(initial.blockMs);
  const [selected, setSelected] = useState<string | null>(null);
  const [attackerId, setAttackerId] = useState<string | null>(null);
  const [attackStaged, setAttackStaged] = useState(false);
  const [copied, setCopied] = useState(false);
  const txSeq = useRef(0);

  const nodeIds = useMemo(() => NAMES.slice(0, n), [n]);

  useEffect(() => {
    const q = new URLSearchParams({ seed: String(seed), n: String(n), net: String(net), k: String(k), ms: String(blockMs) });
    history.replaceState(null, '', `#/nakamoto?${q.toString()}`);
  }, [seed, n, net, k, blockMs]);

  const makeKernel = useCallback(() => {
    const proto = createNakamoto({ ...DEFAULT_NAK_CONFIG, k, baseBlockMs: blockMs });
    proto.invariants = nakInvariants as (v: ReadonlyArray<NodeView<NakState>>) => ReturnType<typeof nakInvariants>;
    const p = NET_PRESETS[net];
    const kernel = new Kernel<NakState, NakCmd>({
      seed,
      protocol: proto,
      nodeIds,
      network: { minLatency: p.min, maxLatency: p.max, dropRate: p.drop },
    });
    for (const id of nodeIds) kernel.command(id, { type: 'setMining', on: true });
    return kernel;
  }, [seed, nodeIds, net, k, blockMs]);

  const ctrl = useSimulation(makeKernel);
  const snap = ctrl.snapshot;
  const nodes = useMemo(() => (snap?.nodes ?? []) as NodeRuntime<NakState>[], [snap]);
  const views = useMemo<NodeView<NakState>[]>(() => nodes.map((nd) => ({ id: nd.id, up: nd.up, state: nd.state })), [nodes]);
  const gauge = useMemo(() => nakGauge(views), [views]);

  // Reset the interactive attack state whenever the scenario is rebuilt — done
  // during render (React's endorsed "adjust state on prop change" pattern via a
  // previous-value state cell) so we never call setState from an effect.
  const [prevMake, setPrevMake] = useState(() => makeKernel);
  if (prevMake !== makeKernel) {
    setPrevMake(() => makeKernel);
    if (attackerId !== null) setAttackerId(null);
    if (attackStaged) setAttackStaged(false);
  }

  const liveNodes = useMemo(() => nodes.filter((nd) => nd.up), [nodes]);
  const refNode = useMemo(() => {
    // The node whose view drives the ledger/tree panels: the selected node, or the
    // one on the plurality tip (so panels reflect what the network agrees on).
    if (selected) {
      const s = nodes.find((nd) => nd.id === selected);
      if (s) return s;
    }
    const counts = new Map<string, number>();
    for (const nd of liveNodes) counts.set(nd.state.tip, (counts.get(nd.state.tip) ?? 0) + 1);
    let best: NodeRuntime<NakState> | undefined = liveNodes[0];
    let bestC = -1;
    for (const nd of liveNodes) {
      const c = counts.get(nd.state.tip) ?? 0;
      if (c > bestC) {
        bestC = c;
        best = nd;
      }
    }
    return best ?? nodes[0];
  }, [nodes, liveNodes, selected]);

  const attackerNode = attackerId ? nodes.find((nd) => nd.id === attackerId) : undefined;

  const ledger = useMemo(() => (refNode ? ledgerOf(refNode.state.blocks, refNode.state.tip).ledger : null), [refNode]);

  // Where is the "pay merchant" tx confirmed on the reference chain?
  const payDepth = useMemo(() => {
    if (!refNode) return null;
    const chain = chainOf(refNode.state.blocks, refNode.state.tip);
    for (const b of chain) if (b.txs.some((t) => t.tag === 'pay')) return heightOf(refNode.state.blocks, refNode.state.tip) - b.height;
    return null;
  }, [refNode]);

  const nextTx = (from: string, to: string, amount: number, tag?: string): Tx => {
    const nonce = ledger?.[from]?.nonce ?? 0;
    return { id: `tx${txSeq.current++}`, from, to, amount, nonce, tag };
  };

  const injectAll = (tx: Tx) => {
    for (const nd of nodes) if (nd.up && nd.id !== attackerId) ctrl.command(nd.id, { type: 'submitTx', tx });
  };

  const payment = () => {
    const dir = txSeq.current % 2 === 0;
    injectAll(nextTx(dir ? 'alice' : 'bob', dir ? 'bob' : 'alice', 5));
  };

  const stageAttack = () => {
    const atk = nodeIds[nodeIds.length - 1];
    setAttackerId(atk);
    setAttackStaged(true);
    // The attacker gets a clear majority of the hash power (double the honest
    // aggregate), so its secret chain reliably out-races the public one.
    ctrl.command(atk, { type: 'setPower', power: 2 * Math.max(1, nodeIds.length - 1) });
    // …a public payment to the merchant (mined by the honest chain)…
    const nonce = ledger?.['mallory']?.nonce ?? 0;
    const pay: Tx = { id: `ds-pay${txSeq.current++}`, from: 'mallory', to: 'merchant', amount: 50, nonce, tag: 'pay' };
    injectAll(pay);
    // …and a secret conflicting tx (same nonce) that pays herself instead.
    const evil: Tx = { id: `ds-evil${txSeq.current++}`, from: 'mallory', to: 'mallory2', amount: 50, nonce, tag: 'double-spend' };
    ctrl.command(atk, { type: 'setAttackTx', tx: evil });
    ctrl.command(atk, { type: 'setAttacker', on: true });
  };

  const releaseAttack = () => {
    if (attackerId) ctrl.command(attackerId, { type: 'release' });
  };

  const applyPreset = (c: ScenarioCfg) => {
    setSeed(c.seed);
    setN(c.n);
    setNet(c.net);
    setK(c.k);
    setBlockMs(c.blockMs);
  };

  const copyLink = () => {
    const url = `${location.origin}${location.pathname}${location.hash}`;
    void navigator.clipboard?.writeText(url).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    });
  };

  const visual = useCallback(
    (node: NodeRuntime<NakState>): NodeVisual => {
      const s = node.state;
      const h = heightOf(s.blocks, s.tip);
      if (node.id === attackerId) {
        const secret = Object.keys(s.hidden).length;
        return {
          fill: '#c98b2b',
          ring: '#ffd479',
          label: node.id,
          sub: secret ? `#${h} +${secret}🔒` : `#${h}`,
          badge: '⚔',
          glow: true,
          down: !node.up,
        };
      }
      const hue = tipHue(s.tip);
      return {
        fill: s.reverted ? '#b0413f' : `hsl(${hue} 55% 52%)`,
        ring: 'rgba(255,255,255,0.25)',
        label: node.id,
        sub: `#${h}`,
        down: !node.up,
      };
    },
    [attackerId],
  );

  const sel = selected ? nodes.find((nd) => nd.id === selected) : undefined;
  const shipped = payDepth != null && payDepth >= k;

  return (
    <div className="lab">
      <div className="lab-intro">
        <h2>Nakamoto · proof-of-work longest-chain consensus</h2>
        <p>
          The consensus behind <b>Bitcoin</b> — and the odd one out in this whole simulator. There is{' '}
          <b>no quorum, no leader, no vote and no fixed membership</b>. Miners race to extend the chain;
          finding a block is a memoryless <b>Poisson process</b> whose rate is a node's share of the total
          hash power. Every node simply adopts the <b>longest chain it has seen</b>, so two blocks found at
          nearly the same time <b>fork</b> the chain — and the fork resolves the instant one branch out-races
          the other, orphaning the loser. Safety is <b>probabilistic</b>: a block is only ever <em>buried</em>,
          never truly finalised, and an attacker with a <b>majority of the hash power</b> can privately mine a
          longer chain and <b>revert a confirmed payment</b>. Stage that 51% double-spend below and watch the
          "no finalised reversal" invariant break.
        </p>
      </div>

      <ControlBar
        ctrl={ctrl}
        seed={seed}
        onSeed={setSeed}
        right={
          <span className={`leader-pill ${gauge.deepestFork === 0 ? 'has' : ''}`} title="height of the network's agreed chain / how deep the current fork is">
            height {gauge.height} · fork {gauge.deepestFork}
          </span>
        }
      />

      <div className="lab-grid">
        <div className="lab-main">
          <div className="cluster-toolbar">
            <div className="ctl-group">
              <label>Miners</label>
              {[5, 6, 7, 8, 10].map((c) => (
                <button key={c} className={`btn tiny ${n === c ? 'on' : ''}`} onClick={() => setN(c)}>{c}</button>
              ))}
            </div>
            <div className="ctl-group">
              <label>Network</label>
              {NET_PRESETS.map((p, i) => (
                <button key={p.name} className={`btn tiny ${net === i ? 'on' : ''}`} onClick={() => setNet(i)}>{p.name}</button>
              ))}
            </div>
            <div className="ctl-group">
              <label>Confirmations k</label>
              <input type="range" min={1} max={8} value={k} onChange={(e) => setK(Number(e.target.value))} style={{ width: 90 }} />
              <code>{k}</code>
            </div>
            <div className="ctl-group">
              <label>Block time</label>
              <input type="range" min={1200} max={5000} step={200} value={blockMs} onChange={(e) => setBlockMs(Number(e.target.value))} style={{ width: 90 }} />
              <code>{(blockMs / 1000).toFixed(1)}s</code>
            </div>
          </div>

          <div className="cluster-toolbar">
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
              height={320}
            />
          )}

          <div className="action-row">
            <button className="btn" onClick={payment} title="Broadcast a small alice↔bob payment into every miner's mempool">＄ Payment</button>
            {!attackStaged ? (
              <button className="btn danger" onClick={stageAttack} title="Give the last node a majority of the hash power, pay the merchant publicly, and secretly mine a conflicting chain">
                ⚔ Stage 51% double-spend
              </button>
            ) : (
              <button className="btn danger" onClick={releaseAttack} title="Reveal the attacker's secret chain — if it's longer, the honest network reorgs and the merchant payment is reverted">
                💥 Release secret chain
              </button>
            )}
            <button className="btn" onClick={() => ctrl.partition(twoWaySplit(ctrl.nodeOrder))} title="Split the network — each half mines its own fork">✂ Partition</button>
            <button className="btn good" onClick={ctrl.heal} title="Heal the network — the shorter fork is abandoned">⧉ Heal</button>
            <button className="btn" onClick={() => { setAttackerId(null); setAttackStaged(false); ctrl.reset(); }}>↺ New run</button>
          </div>

          <div className="action-row">
            {sel ? (
              <>
                <span className="op-target">{sel.id}:</span>
                <button className="btn" onClick={() => ctrl.command(sel.id, { type: 'mineNow' })} title="Force this node to find a block now">⛏ Mine now</button>
                <button className="btn" onClick={() => ctrl.command(sel.id, { type: 'setMining', on: !sel.state.mining })}>
                  {sel.state.mining ? '⏸ Stop mining' : '▶ Start mining'}
                </button>
                <button className={`btn ${sel.up ? 'danger' : 'good'}`} onClick={() => (sel.up ? ctrl.crash(sel.id) : ctrl.restart(sel.id))}>
                  {sel.up ? `✕ Crash ${sel.id}` : `⏼ Restart ${sel.id}`}
                </button>
                <span className="muted" style={{ fontSize: 12 }}>{sel.state.note}</span>
              </>
            ) : (
              <span className="muted">Click a node to mine/crash it, or a link's midpoint to cut it. Nodes are tinted by which chain-tip they hold — one colour means the whole network agrees.</span>
            )}
          </div>

          {refNode && (
            <BlockTree
              blocks={refNode.state.blocks}
              tip={refNode.state.tip}
              hidden={attackerNode?.state.hidden}
              k={k}
              spotlight="pay"
              title={`Block tree · ${selected ? `${refNode.id}'s view` : 'network view'}`}
            />
          )}

          {snap && <MetricsBar metrics={snap.metrics} />}
        </div>

        <div className="lab-side">
          <InvariantPanel invariants={ctrl.invariants} title="Consensus safety" />

          <div className="lab-aux">
            <div className="panel-head">
              <span>Convergence</span>
              <span className={`status-pill ${gauge.deepestFork === 0 ? 'ok' : ''}`}>{gauge.deepestFork === 0 ? 'CONVERGED' : `fork ${gauge.deepestFork}`}</span>
            </div>
            <div className="lab-aux-body">
              <div className="replica-row"><span className="replica-id">chain height</span><code className="replica-val">{gauge.height}</code></div>
              <div className="replica-row"><span className="replica-id">agreed prefix</span><code className="replica-val">#{gauge.commonPrefix}</code></div>
              <div className="replica-row"><span className="replica-id">on tip</span><code className="replica-val">{gauge.agree}/{gauge.live}</code></div>
              <div className="replica-row"><span className="replica-id">distinct tips</span><code className="replica-val">{gauge.distinctTips}</code></div>
              <div className="replica-row"><span className="replica-id">orphaned blocks</span><code className="replica-val">{gauge.orphanBlocks}</code></div>
              <div className="replica-row"><span className="replica-id">coins minted</span><code className="replica-val">{gauge.minted}</code></div>
            </div>
          </div>

          <div className="lab-aux">
            <div className="panel-head">
              <span>Ledger {selected ? `· ${refNode?.id}` : '· agreed chain'}</span>
              {attackStaged && (
                <span className={`status-pill ${gauge.reverted ? 'bad' : shipped ? 'ok' : ''}`}>
                  {gauge.reverted ? 'ROBBED' : shipped ? 'PAID ✓' : 'pending'}
                </span>
              )}
            </div>
            <div className="lab-aux-body">
              {ledger &&
                ['mallory', 'merchant', 'mallory2', 'alice', 'bob'].map((acc) => (
                  <div key={acc} className="replica-row">
                    <span className="replica-id">{acc === 'mallory2' ? 'mallory²' : acc}</span>
                    <code className="replica-val" style={{ color: acc === 'merchant' ? '#4bd07a' : acc === 'mallory2' ? '#ffb454' : undefined }}>
                      {ledger[acc]?.balance ?? 0}
                    </code>
                  </div>
                ))}
              {attackStaged && (
                <div style={{ padding: '6px 12px', fontSize: 12, color: 'var(--tx-dim)' }}>
                  {gauge.reverted
                    ? 'The secret chain won: the merchant’s 50 coins moved to mallory² and the confirmed payment vanished — a double-spend.'
                    : shipped
                      ? `The payment is ${payDepth} deep — the merchant treats it as final and ships. Now release the secret chain…`
                      : payDepth != null
                        ? `Payment is ${payDepth}/${k} confirmations deep — waiting for the merchant to accept it.`
                        : 'Press Play — the honest miners will confirm the merchant payment while the attacker mines in secret.'}
                </div>
              )}
            </div>
          </div>

          <div className="lab-aux">
            <div className="panel-head"><span>Miners</span></div>
            <div className="lab-aux-body">
              {nodes.map((nd) => (
                <div key={nd.id} className="replica-row">
                  <span className="replica-id">{nd.id}{nd.id === attackerId ? ' ⚔' : ''}{nd.up ? '' : ' ✕'}</span>
                  <code className="replica-val">
                    #{heightOf(nd.state.blocks, nd.state.tip)} · {shortHash(nd.state.tip)} · {nd.state.blocksMined}⛏
                  </code>
                </div>
              ))}
            </div>
          </div>

          <div className="lab-aux">
            <div className="panel-head"><span>Why no quorum?</span></div>
            <div className="lab-aux-body" style={{ padding: '8px 12px', fontSize: 12, color: 'var(--tx-dim)' }}>
              Quorum protocols need a known member set and a majority vote. Nakamoto needs <b>neither</b>:
              anyone can mine, and agreement emerges from the longest-chain rule plus the cost of proof of
              work. The price is that finality is <b>never absolute</b> — only exponentially likely with
              depth — and a majority of the hash power can rewrite recent history.
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
