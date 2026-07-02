import { useCallback, useEffect, useMemo, useState } from 'react';
import { Kernel } from '../sim/kernel';
import { createBenOr } from '../protocols/benor/benor';
import { benorInvariants, benorGauge } from '../protocols/benor/invariants';
import { DEFAULT_BENOR_CONFIG, faultBudget, propLabel, type BenOrCommand, type BenOrState, type Bit } from '../protocols/benor/types';
import { useSimulation } from '../lib/useSimulation';
import { NetworkCanvas, type NodeVisual } from '../ui/NetworkCanvas';
import { ControlBar } from '../ui/ControlBar';
import { InvariantPanel } from '../ui/InvariantPanel';
import { Timeline } from '../ui/Timeline';
import { MetricsBar } from '../ui/MetricsBar';
import { nodeColor } from '../lib/format';
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
  { name: 'Flaky', min: 40, max: 160, drop: 0.3 },
];

// A colour per decided value; undecided replicas are neutral.
const VAL_COLOR: Record<number, string> = { 0: '#7c9cff', 1: '#73e08a' };
const UNDECIDED = '#9aa2b1';

function benMsgColor(type: string): string {
  if (type === 'BenReport') return '#7c9cff';
  if (type === 'BenPropose') return '#ffd479';
  return '#9aa2b1';
}
const MSG_GLYPH: Record<string, string> = { BenReport: '▸', BenPropose: '◇' };

interface ScenarioCfg {
  seed: number;
  count: number;
  net: number;
  inputs: Bit[];
}

const splitInputs = (n: number): Bit[] => Array.from({ length: n }, (_, i) => (i % 2) as Bit);

function readScenarioFromHash(count: number): Partial<ScenarioCfg> {
  try {
    const q = window.location.hash.split('?')[1];
    if (!q) return {};
    const p = new URLSearchParams(q);
    const out: Partial<ScenarioCfg> = {};
    if (p.has('seed')) out.seed = Number(p.get('seed')) || 0;
    if (p.has('n')) out.count = Number(p.get('n')) || 5;
    if (p.has('net')) out.net = Number(p.get('net')) || 0;
    if (p.has('in')) {
      const bits = (p.get('in') ?? '').split('').filter((c) => c === '0' || c === '1').map((c) => Number(c) as Bit);
      if (bits.length) out.inputs = bits;
    }
    void count;
    return out;
  } catch {
    return {};
  }
}

const PRESETS: { name: string; make: (n: number) => Bit[] }[] = [
  { name: 'Split ⇢', make: (n) => splitInputs(n) },
  { name: 'All 0', make: (n) => Array(n).fill(0) as Bit[] },
  { name: 'All 1', make: (n) => Array(n).fill(1) as Bit[] },
  { name: 'Lone 1', make: (n) => Array.from({ length: n }, (_, i) => (i === 0 ? 1 : 0) as Bit) },
];

export function BenOrLab() {
  const hash = useMemo(() => readScenarioFromHash(5), []);
  const [seed, setSeed] = useState(hash.seed ?? 42);
  const [count, setCount] = useState(hash.count ?? 5);
  const [net, setNet] = useState(hash.net ?? 0);
  const [inputs, setInputs] = useState<Bit[]>(hash.inputs && hash.inputs.length === (hash.count ?? 5) ? hash.inputs : splitInputs(hash.count ?? 5));
  const [selected, setSelected] = useState<string | null>(null);

  const nodeIds = useMemo(() => NAMES.slice(0, count), [count]);

  // The effective inputs, always sized to the current cluster (pad with the split
  // default when growing, truncate when shrinking) — derived, never an effect.
  const sizedInputs = useMemo<Bit[]>(() => {
    if (inputs.length === count) return inputs;
    if (inputs.length > count) return inputs.slice(0, count);
    return [...inputs, ...splitInputs(count).slice(inputs.length)];
  }, [inputs, count]);
  const inputsKey = sizedInputs.join('');

  useEffect(() => {
    const q = new URLSearchParams({ seed: String(seed), n: String(count), net: String(net), in: inputsKey });
    history.replaceState(null, '', `#/benor?${q.toString()}`);
  }, [seed, count, net, inputsKey]);
  const makeKernel = useCallback(() => {
    const proto = createBenOr(DEFAULT_BENOR_CONFIG, inputsKey.split('').map((c) => Number(c) as Bit));
    proto.invariants = benorInvariants as (n: ReadonlyArray<NodeView<BenOrState>>) => ReturnType<typeof benorInvariants>;
    const preset = NET_PRESETS[net];
    return new Kernel<BenOrState, BenOrCommand>({
      seed,
      protocol: proto,
      nodeIds,
      network: { minLatency: preset.min, maxLatency: preset.max, dropRate: preset.drop },
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [seed, nodeIds, net, inputsKey]);

  const ctrl = useSimulation(makeKernel);
  const snapshot = ctrl.snapshot;
  const gauge = useMemo(
    () => (snapshot ? benorGauge(snapshot.nodes.map((n) => ({ id: n.id, up: n.up, state: n.state }))) : null),
    [snapshot],
  );

  const visual = useCallback((node: NodeRuntime<BenOrState>, i: number): NodeVisual => {
    const s = node.state;
    const dec = s.decided;
    return {
      fill: dec !== null ? VAL_COLOR[dec] : UNDECIDED,
      ring: nodeColor(i),
      label: node.id,
      sub: `r${s.round} x=${s.estimate}`,
      badge: dec !== null ? String(dec) : '?',
      glow: dec !== null,
      down: !node.up,
    };
  }, []);

  const toggleInput = (i: number) => setInputs(sizedInputs.map((b, j) => (j === i ? ((b ^ 1) as Bit) : b)));

  const partitionMinority = () => {
    const half = Math.floor(ctrl.nodeOrder.length / 2);
    ctrl.partition([ctrl.nodeOrder.slice(0, half), ctrl.nodeOrder.slice(half)]);
  };

  const sel = selected ? snapshot?.nodes.find((n) => n.id === selected) : undefined;
  const f = faultBudget(count);

  return (
    <div className="lab">
      <div className="lab-intro">
        <h2>Ben-Or randomized consensus</h2>
        <p>
          The <strong>FLP impossibility</strong> proves no <em>deterministic</em> protocol can guarantee
          consensus in an asynchronous system where even one node may crash. Ben-Or's 1983 answer: let the
          nodes <strong>flip coins</strong>. With no leader, no stable storage and no synchrony assumption,
          each round runs Report → Propose; a strict majority forms a proposal, <code>f+1</code> matching
          proposals decide, and if a round is inconclusive every undecided node tosses a coin. Safety
          (Agreement &amp; Validity) is <strong>deterministic and unconditional</strong>; only termination is
          probabilistic — but it happens with probability 1, here in just a few rounds. Set the input bits,
          crash up to <strong>f = {f}</strong> of N = {count}, and watch it still agree.
        </p>
      </div>

      <ControlBar
        ctrl={ctrl}
        seed={seed}
        onSeed={setSeed}
        right={
          <span className={`leader-pill ${gauge && gauge.value !== null ? 'has' : 'none'}`}>
            {gauge && gauge.value !== null
              ? `decided ${gauge.value} · ${gauge.decided}/${gauge.total} · round ${gauge.maxRound}`
              : gauge
                ? `undecided · round ${gauge.maxRound}`
                : ''}
          </span>
        }
      />

      <div className="lab-grid">
        <div className="lab-main">
          <div className="cluster-toolbar">
            <div className="ctl-group">
              <label>Cluster</label>
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
          </div>

          <div className="cluster-toolbar">
            <div className="ctl-group">
              <label>Inputs</label>
              {sizedInputs.map((b, i) => (
                <button
                  key={i}
                  className={`btn tiny ${b === 1 ? 'on' : ''}`}
                  onClick={() => toggleInput(i)}
                  title={`toggle ${NAMES[i]}'s input bit`}
                >
                  {NAMES[i]}:{b}
                </button>
              ))}
            </div>
            <div className="ctl-group">
              <label>Presets</label>
              {PRESETS.map((p) => (
                <button key={p.name} className="btn tiny" onClick={() => setInputs(p.make(count))}>
                  {p.name}
                </button>
              ))}
            </div>
          </div>

          {snapshot && (
            <NetworkCanvas
              snapshot={snapshot}
              nodeOrder={ctrl.nodeOrder}
              visual={visual}
              messageColor={benMsgColor}
              messageGlyph={(t) => MSG_GLYPH[t] ?? '•'}
              selected={selected}
              onSelect={setSelected}
              onToggleLink={(a, b) => ctrl.toggleLink(a, b)}
              height={420}
            />
          )}

          {gauge && (
            <div className="action-row" style={{ alignItems: 'center' }}>
              <span className="cfg-pill">
                agreement: {gauge.value !== null ? `value ${gauge.value}` : 'pending'} · {gauge.decided}/{gauge.total}{' '}
                decided
              </span>
              <span className="op-target">round {gauge.maxRound}</span>
            </div>
          )}

          <div className="action-row">
            <button className="btn" onClick={partitionMinority}>
              ⌥ Partition
            </button>
            <button className="btn" onClick={ctrl.heal}>
              ⟲ Heal net
            </button>
            {sel && (
              <button
                className={`btn ${sel.up ? 'danger' : 'good'}`}
                onClick={() => (sel.up ? ctrl.crash(sel.id) : ctrl.restart(sel.id))}
              >
                {sel.up ? `✕ Crash ${sel.id}` : `⏼ Restart ${sel.id}`}
              </button>
            )}
          </div>

          {snapshot && <MetricsBar metrics={snapshot.metrics} />}
        </div>

        <div className="lab-side">
          <InvariantPanel invariants={ctrl.invariants} />
          {sel ? (
            <BenInspector node={sel} />
          ) : (
            <div className="inspector empty">
              <div className="panel-head">
                <span>Inspector</span>
              </div>
              <div className="muted pad">Click a node to inspect its round, estimate and decision.</div>
            </div>
          )}
        </div>
      </div>

      <Timeline log={snapshot?.log ?? []} />
    </div>
  );
}

function BenInspector({ node }: { node: NodeRuntime<BenOrState> }) {
  const s = node.state;
  return (
    <div className="inspector">
      <div className="panel-head">
        <span>
          Node {node.id} {node.up ? '' : '(down)'}
        </span>
        <span
          className="status-pill"
          style={{ background: s.decided !== null ? VAL_COLOR[s.decided] : UNDECIDED, color: '#0b0c10' }}
        >
          {s.decided !== null ? `decided ${s.decided}` : 'undecided'}
        </span>
      </div>
      <div className="kv-grid">
        <span>input</span>
        <b>{s.input}</b>
        <span>round</span>
        <b>{s.round}</b>
        <span>estimate (x)</span>
        <b>{s.estimate}</b>
        <span>decided</span>
        <b>{s.decided ?? '—'}</b>
        <span>decided round</span>
        <b>{s.decidedRound ?? '—'}</b>
        <span>last proposal</span>
        <b>{propLabel(s.lastProposal)}</b>
        <span>last coin</span>
        <b>{s.lastCoin ?? '—'}</b>
      </div>
      <div className="muted pad" style={{ fontSize: '0.8em' }}>
        Waits for N−f messages per phase. A strict majority of a phase-1 sample forms a proposal; f+1
        matching phase-2 proposals decide; an all-⊥ round tosses a coin.
      </div>
    </div>
  );
}
