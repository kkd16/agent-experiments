import { useCallback, useEffect, useMemo, useState } from 'react';
import { Kernel } from '../sim/kernel';
import { createBrb } from '../protocols/brb/brb';
import { brbInvariants, brbGauge } from '../protocols/brb/invariants';
import { DEFAULT_BRB_CONFIG, faultBudget, echoQuorum, readyDeliver, type BrbCmd, type BrbState, type Value } from '../protocols/brb/types';
import { useSimulation } from '../lib/useSimulation';
import { NetworkCanvas, type NodeVisual } from '../ui/NetworkCanvas';
import { ControlBar } from '../ui/ControlBar';
import { InvariantPanel } from '../ui/InvariantPanel';
import { Timeline } from '../ui/Timeline';
import { MetricsBar } from '../ui/MetricsBar';
import type { NodeRuntime, NodeView } from '../sim/types';

const NAMES = 'ABCDEFGHIJ'.split('');

const VAL_HEX: Record<string, string> = { A: '#5b8cff', B: '#ff8fa3' };
const valHex = (v: Value | null) => (v == null ? '#9aa2b1' : VAL_HEX[v] ?? '#9aa2b1');

const MSG_COLOR = (t: string): string => (t === 'Send' ? '#ffd479' : t === 'Echo' ? '#8be9c0' : '#7c9cff');
const MSG_GLYPH = (t: string): string => (t === 'Send' ? 'S' : t === 'Echo' ? 'E' : 'R');

const NET_PRESETS = [
  { name: 'LAN', min: 12, max: 50, drop: 0 },
  { name: 'WAN', min: 60, max: 200, drop: 0 },
  { name: 'Jittery', min: 10, max: 240, drop: 0 },
];

interface ScenarioCfg { seed: number; n: number; byz: number; net: number }
const DEFAULT_SCENARIO: ScenarioCfg = { seed: 42, n: 7, byz: 0, net: 0 };

function readHash(): Partial<ScenarioCfg> {
  try {
    const q = window.location.hash.split('?')[1];
    if (!q) return {};
    const p = new URLSearchParams(q);
    const out: Partial<ScenarioCfg> = {};
    if (p.has('seed')) out.seed = Number(p.get('seed')) || 0;
    if (p.has('n')) out.n = Number(p.get('n')) || 7;
    if (p.has('byz')) out.byz = Number(p.get('byz')) || 0;
    if (p.has('net')) out.net = Number(p.get('net')) || 0;
    return out;
  } catch {
    return {};
  }
}

const PRESETS: { name: string; hint: string; cfg: ScenarioCfg }[] = [
  { name: 'Honest (7)', hint: 'honest sender, no traitors — every correct node delivers the value', cfg: { seed: 42, n: 7, byz: 0, net: 0 } },
  { name: 'Equivocating sender', hint: 'press “Equivocating sender” below — a traitor sender tells half A and half B; correct nodes still agree', cfg: { seed: 7, n: 7, byz: 0, net: 0 } },
  { name: 'f traitors (N=7)', hint: 'two Byzantine echoers (f=2) lie; the broadcast still completes correctly', cfg: { seed: 3, n: 7, byz: 2, net: 0 } },
  { name: 'Past the bound (N=4)', hint: 'two traitors with f=1 — beyond N≥3f+1; watch Agreement break', cfg: { seed: 2, n: 4, byz: 2, net: 0 } },
];

export function BrbLab() {
  const initial = useMemo(() => ({ ...DEFAULT_SCENARIO, ...readHash() }), []);
  const [seed, setSeed] = useState(initial.seed);
  const [n, setN] = useState(initial.n);
  const [byz, setByz] = useState(initial.byz);
  const [net, setNet] = useState(initial.net);
  const [selected, setSelected] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const nodeIds = useMemo(() => NAMES.slice(0, n), [n]);
  const f = faultBudget(n);

  useEffect(() => {
    const q = new URLSearchParams({ seed: String(seed), n: String(n), byz: String(byz), net: String(net) });
    history.replaceState(null, '', `#/brb?${q.toString()}`);
  }, [seed, n, byz, net]);

  // Traitors are the LAST `byz` nodes, so the sender (node 0) stays honest unless
  // you deliberately drive byz up to the whole cluster.
  const makeKernel = useCallback(() => {
    const proto = createBrb(DEFAULT_BRB_CONFIG);
    proto.invariants = brbInvariants as (v: ReadonlyArray<NodeView<BrbState>>) => ReturnType<typeof brbInvariants>;
    const p = NET_PRESETS[net];
    const kernel = new Kernel<BrbState, BrbCmd>({
      seed,
      protocol: proto,
      nodeIds,
      network: { minLatency: p.min, maxLatency: p.max, dropRate: p.drop },
    });
    nodeIds.slice(nodeIds.length - byz).forEach((id) => kernel.command(id, { type: 'byzantine', on: true }));
    return kernel;
  }, [seed, nodeIds, byz, net]);

  const ctrl = useSimulation(makeKernel);
  const snap = ctrl.snapshot;
  const nodes = useMemo(() => (snap?.nodes ?? []) as NodeRuntime<BrbState>[], [snap]);
  const views = useMemo<NodeView<BrbState>[]>(() => nodes.map((nd) => ({ id: nd.id, up: nd.up, state: nd.state })), [nodes]);
  const gauge = useMemo(() => brbGauge(views), [views]);
  const sender = nodeIds[0];

  const broadcast = (value: Value) => {
    ctrl.command(sender, { type: 'broadcast', value });
    if (!ctrl.playing) ctrl.play();
  };
  const equivocate = () => {
    ctrl.act((k) => {
      k.command(sender, { type: 'byzantine', on: true });
      k.command(sender, { type: 'broadcast', value: 'A' });
    });
    if (!ctrl.playing) ctrl.play();
  };

  const applyPreset = (c: ScenarioCfg) => { setSeed(c.seed); setN(c.n); setByz(c.byz); setNet(c.net); };
  const copyLink = () => {
    const url = `${location.origin}${location.pathname}${location.hash}`;
    void navigator.clipboard?.writeText(url).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1200); });
  };

  const visual = useCallback(
    (node: NodeRuntime<BrbState>): NodeVisual => {
      const s = node.state;
      const isSender = node.id === sender;
      if (s.byzantine) {
        return { fill: '#8a6d2b', ring: isSender ? '#ffffff' : '#ffd479', label: node.id, sub: isSender ? 'traitor sender' : 'traitor', glow: true, down: !node.up };
      }
      const phase = s.delivered != null ? 'deliver' : s.readySent != null ? 'ready' : s.echoSent != null ? 'echo' : 'idle';
      const fill = phase === 'deliver' ? valHex(s.delivered) : phase === 'ready' ? '#5566aa' : phase === 'echo' ? '#3f7d68' : '#2f3340';
      return {
        fill,
        ring: isSender ? '#ffd479' : s.delivered != null ? '#ffffff' : 'rgba(255,255,255,0.22)',
        label: node.id,
        sub: s.delivered != null ? `✓ ${s.delivered}` : s.readySent != null ? `rdy ${s.readySent}` : s.echoSent != null ? `echo ${s.echoSent}` : isSender ? 'sender' : '·',
        badge: s.delivered ?? undefined,
        glow: s.delivered != null,
        down: !node.up,
      };
    },
    [sender],
  );

  const sel = selected ? nodes.find((nd) => nd.id === selected) : undefined;

  return (
    <div className="lab">
      <div className="lab-intro">
        <h2>Bracha reliable broadcast · agreement despite an equivocating sender</h2>
        <p>
          Beneath PBFT and HotStuff sits a deeper primitive: <b>reliable broadcast</b> — one sender
          delivering one message so that, even if it's a <b>traitor that tells different nodes different
          things</b>, the correct nodes still agree: all deliver the same value, or none does. Bracha's
          1987 algorithm does it with <code>N ≥ 3f+1</code> and two amplification rounds:{' '}
          <span style={{ color: '#ffd479' }}>SEND</span> →{' '}
          <span style={{ color: '#8be9c0' }}>ECHO</span> (go ready on{' '}
          <code>&gt;(N+f)/2</code> echoes) →{' '}
          <span style={{ color: '#7c9cff' }}>READY</span> (amplify on <code>f+1</code>, deliver on{' '}
          <code>2f+1</code>). The echo quorum is the crux — two values can't both reach it, so correct
          nodes never split. Make the sender equivocate, add traitors up to <b>f</b>, and watch{' '}
          <b>Agreement</b> hold — then push past <b>f</b> and watch it break.
        </p>
      </div>

      <ControlBar
        ctrl={ctrl}
        seed={seed}
        onSeed={setSeed}
        right={
          <span className={`leader-pill ${gauge.withinBudget ? 'has' : ''}`} title="Byzantine budget N ≥ 3f+1">
            N={gauge.n} · f={gauge.f} · {gauge.byzantine} Byzantine {gauge.withinBudget ? '✓' : '⚠ past bound'}
          </span>
        }
      />

      <div className="lab-grid">
        <div className="lab-main">
          <div className="cluster-toolbar">
            <div className="ctl-group">
              <label>Nodes</label>
              {[4, 7, 10].map((c) => (
                <button key={c} className={`btn tiny ${n === c ? 'on' : ''}`} onClick={() => setN(c)}>{c}</button>
              ))}
              <span className="muted" style={{ fontSize: 11 }}>f=⌊(N-1)/3⌋={f}</span>
            </div>
            <div className="ctl-group">
              <label>Byzantine</label>
              <input type="range" min={0} max={n - 1} value={byz} onChange={(e) => setByz(Number(e.target.value))} style={{ width: 90 }} />
              <code style={{ color: byz <= f ? '#73e08a' : '#ff8fa3' }}>{byz}</code>
            </div>
            <div className="ctl-group">
              <label>Network</label>
              {NET_PRESETS.map((p, i) => (
                <button key={p.name} className={`btn tiny ${net === i ? 'on' : ''}`} onClick={() => setNet(i)}>{p.name}</button>
              ))}
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
            <button className="btn primary" onClick={() => broadcast('A')} title={`Honest sender ${sender} broadcasts A to everyone`}>
              📣 Broadcast A
            </button>
            <button className="btn" onClick={equivocate} title={`Make the sender Byzantine and equivocate — A to half, B to half`}>
              ⚡ Equivocating sender
            </button>
            <button className="btn" onClick={() => ctrl.partition(twoWaySplit(ctrl.nodeOrder))} title="Partition the cluster">
              ✂ Partition
            </button>
            <button className="btn good" onClick={ctrl.heal}>⧉ Heal</button>
            <button className="btn" onClick={ctrl.reset}>↺ New cluster</button>
          </div>

          <div className="action-row">
            {sel ? (
              <>
                <span className="op-target">{sel.id}{sel.id === sender ? ' (sender)' : ''}:</span>
                <button className="btn" onClick={() => ctrl.command(sel.id, { type: 'byzantine', on: !sel.state.byzantine })}>
                  {sel.state.byzantine ? '↺ make honest' : '☠ make Byzantine'}
                </button>
                <button className={`btn ${sel.up ? 'danger' : 'good'}`} onClick={() => (sel.up ? ctrl.crash(sel.id) : ctrl.restart(sel.id))}>
                  {sel.up ? `✕ Crash ${sel.id}` : `⏼ Restart ${sel.id}`}
                </button>
              </>
            ) : (
              <span className="muted">Press <b>Broadcast A</b> or <b>Equivocating sender</b>. The tally below shows each node's ECHO/READY/deliver; quorums: echo &gt; (N+f)/2 = {echoQuorum(n, f)}, deliver = 2f+1 = {readyDeliver(f)}.</span>
            )}
          </div>

          <BrbTally views={views} sender={sender} n={n} f={f} />

          {snap && <MetricsBar metrics={snap.metrics} />}
        </div>

        <div className="lab-side">
          <InvariantPanel invariants={ctrl.invariants} title="Byzantine agreement" />

          <div className="lab-aux">
            <div className="panel-head">
              <span>Broadcast</span>
              <span className={`status-pill ${gauge.totality ? 'ok' : gauge.withinBudget ? '' : 'bad'}`}>
                {gauge.totality ? `DELIVERED ${gauge.value}` : gauge.delivered > 0 ? 'partial' : 'pending'}
              </span>
            </div>
            <div className="lab-aux-body">
              <div className="replica-row"><span className="replica-id">delivered (correct)</span><code className="replica-val">{gauge.delivered}/{gauge.correctTotal}</code></div>
              <div className="replica-row"><span className="replica-id">value</span><code className="replica-val" style={{ color: valHex(gauge.value) }}>{gauge.value ?? '—'}</code></div>
              <div className="replica-row"><span className="replica-id">fault budget</span><code className="replica-val" style={{ color: gauge.withinBudget ? '#73e08a' : '#ff8fa3' }}>{gauge.byzantine} / f={gauge.f}{gauge.withinBudget ? '' : ' ⚠'}</code></div>
              <div className="replica-row"><span className="replica-id">echo quorum</span><code className="replica-val">{echoQuorum(n, f)}</code></div>
              <div className="replica-row"><span className="replica-id">deliver quorum</span><code className="replica-val">{readyDeliver(f)}</code></div>
            </div>
          </div>

          <div className="lab-aux">
            <div className="panel-head"><span>Per-node state</span></div>
            <div className="lab-aux-body">
              {nodes.map((nd) => (
                <div key={nd.id} className="replica-row">
                  <span className="replica-id">{nd.id}{nd.id === sender ? '✦' : ''}{nd.up ? '' : ' ✕'}</span>
                  <code className="replica-val" style={{ color: nd.state.byzantine ? '#ffd479' : valHex(nd.state.delivered) }}>
                    {nd.state.byzantine ? 'Byzantine' : nd.state.delivered != null ? `✓ ${nd.state.delivered}` : nd.state.readySent != null ? `ready ${nd.state.readySent}` : nd.state.echoSent != null ? `echo ${nd.state.echoSent}` : 'idle'}
                  </code>
                </div>
              ))}
            </div>
          </div>

          <div className="lab-aux">
            <div className="panel-head"><span>Why two rounds?</span></div>
            <div className="lab-aux-body" style={{ padding: '8px 12px', fontSize: 12, color: 'var(--tx-dim)' }}>
              One round (echo + deliver) isn't enough: a node could deliver while another sees too few
              echoes and hangs. The READY round fixes <b>totality</b> — once any correct node is ready,
              <code> f+1</code> readies make every correct node ready (amplification), and <code>2f+1</code>{' '}
              guarantees a majority of correct nodes back the value before anyone delivers. The result is
              all-or-nothing delivery, even when the sender lies to everyone differently.
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

// A compact tally of the quorums forming: per value, how many distinct ECHO and
// READY messages the cluster has produced, with the thresholds marked.
function BrbTally({ views, sender, n, f }: { views: NodeView<BrbState>[]; sender: string; n: number; f: number }) {
  // Aggregate distinct senders of each echo/ready value across all correct nodes'
  // tallies (a witness of how close each value is to its quorum, cluster-wide).
  const values: Value[] = ['A', 'B'];
  const echoMax: Record<string, number> = { A: 0, B: 0 };
  const readyMax: Record<string, number> = { A: 0, B: 0 };
  for (const v of views) {
    for (const val of values) {
      echoMax[val] = Math.max(echoMax[val], v.state.echoes[val]?.length ?? 0);
      readyMax[val] = Math.max(readyMax[val], v.state.readies[val]?.length ?? 0);
    }
  }
  const eq = echoQuorum(n, f);
  const dq = readyDeliver(f);
  const any = values.some((val) => echoMax[val] > 0 || readyMax[val] > 0);

  const Bar = ({ count, need, color }: { count: number; need: number; color: string }) => (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
      <div style={{ position: 'relative', flex: 1, height: 14, background: 'rgba(255,255,255,0.05)', borderRadius: 4, overflow: 'hidden' }}>
        <div style={{ width: `${Math.min(100, (count / Math.max(1, n)) * 100)}%`, height: '100%', background: color, opacity: count >= need ? 1 : 0.55 }} />
        <div style={{ position: 'absolute', left: `${(need / Math.max(1, n)) * 100}%`, top: 0, bottom: 0, width: 2, background: '#fff', opacity: 0.6 }} title={`threshold ${need}`} />
      </div>
      <code style={{ fontSize: 11, width: 54, color: count >= need ? color : 'var(--tx-dim)' }}>{count}/{need}</code>
    </div>
  );

  return (
    <div className="depgraph">
      <div className="panel-head">
        <span>Quorum tally · sender {sender}</span>
        <span className="muted">echo quorum {eq} · deliver quorum {dq} (of N={n}, f={f})</span>
      </div>
      <div className="depgraph-scroll" style={{ padding: '8px 12px' }}>
        {!any ? (
          <div className="muted">No messages yet — press <b>Broadcast A</b> or <b>Equivocating sender</b>.</div>
        ) : (
          <div style={{ display: 'grid', gridTemplateColumns: '24px 1fr 1fr', gap: '6px 14px', alignItems: 'center', fontFamily: 'ui-monospace, monospace', fontSize: 12 }}>
            <span />
            <span className="muted">ECHO (→ ready at {eq})</span>
            <span className="muted">READY (→ deliver at {dq})</span>
            {values.map((val) => (
              <Row key={val} val={val} echo={echoMax[val]} ready={readyMax[val]} eq={eq} dq={dq} Bar={Bar} />
            ))}
          </div>
        )}
      </div>
      <div className="depgraph-foot muted">
        The white tick is each quorum threshold. Because the echo quorum exceeds <code>(N+f)/2</code>,
        two different values can never both cross it — so correct nodes can never deliver different
        values, however the sender equivocates (as long as Byzantine ≤ f).
      </div>
    </div>
  );
}

function Row({ val, echo, ready, eq, dq, Bar }: { val: Value; echo: number; ready: number; eq: number; dq: number; Bar: (p: { count: number; need: number; color: string }) => React.ReactElement }) {
  const color = VAL_HEX[val];
  return (
    <>
      <span style={{ color, fontWeight: 700 }}>{val}</span>
      <Bar count={echo} need={eq} color={color} />
      <Bar count={ready} need={dq} color={color} />
    </>
  );
}
