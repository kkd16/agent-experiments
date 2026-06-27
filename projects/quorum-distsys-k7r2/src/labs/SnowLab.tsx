import { useCallback, useEffect, useMemo, useState } from 'react';
import { Kernel } from '../sim/kernel';
import { createSnow } from '../protocols/snow/snow';
import { snowInvariants, snowGauge } from '../protocols/snow/invariants';
import {
  DEFAULT_SNOW_CONFIG,
  COLOURS,
  colourStr,
  variantName,
  type Variant,
  type Colour,
  type SnowCmd,
  type SnowState,
} from '../protocols/snow/types';
import { useSimulation } from '../lib/useSimulation';
import { NetworkCanvas, type NodeVisual } from '../ui/NetworkCanvas';
import { ControlBar } from '../ui/ControlBar';
import { InvariantPanel } from '../ui/InvariantPanel';
import { Timeline } from '../ui/Timeline';
import { MetricsBar } from '../ui/MetricsBar';
import { fmtTime } from '../lib/format';
import type { NodeRuntime, NodeView } from '../sim/types';

const NAMES = 'ABCDEFGHIJKLMNOPQRST'.split('');

const COLOUR_HEX: Record<string, string> = { R: '#ff6b6b', B: '#5b8cff', G: '#46c98b' };
const NONE_HEX = '#5b6472';
const hex = (c: Colour | null): string => (c == null ? NONE_HEX : COLOUR_HEX[c] ?? '#9aa2b1');
const colourName = (c: Colour | null): string => (c == null ? 'none' : c === 'R' ? 'red' : c === 'B' ? 'blue' : 'green');

const NET_PRESETS = [
  { name: 'LAN', min: 12, max: 36, drop: 0 },
  { name: 'WAN', min: 60, max: 160, drop: 0 },
  { name: 'Lossy', min: 16, max: 60, drop: 0.15 },
];

const MSG_COLOR = (t: string): string => (t === 'Query' ? '#b08bff' : t === 'Resp' ? '#8be9c0' : '#9aa2b1');

interface ScenarioCfg {
  seed: number;
  n: number;
  variant: Variant;
  colours: number;
  k: number;
  alpha: number;
  beta: number;
  net: number;
  byz: number;
}

const DEFAULT_SCENARIO: ScenarioCfg = {
  seed: 42,
  n: 15,
  variant: 'snowball',
  colours: 2,
  k: DEFAULT_SNOW_CONFIG.k,
  alpha: DEFAULT_SNOW_CONFIG.alpha,
  beta: DEFAULT_SNOW_CONFIG.beta,
  net: 0,
  byz: 0,
};

function readHash(): Partial<ScenarioCfg> {
  try {
    const q = window.location.hash.split('?')[1];
    if (!q) return {};
    const p = new URLSearchParams(q);
    const out: Partial<ScenarioCfg> = {};
    if (p.has('seed')) out.seed = Number(p.get('seed')) || 0;
    if (p.has('n')) out.n = Number(p.get('n')) || 15;
    if (p.has('v')) out.variant = p.get('v') as Variant;
    if (p.has('c')) out.colours = Number(p.get('c')) || 2;
    if (p.has('k')) out.k = Number(p.get('k')) || 6;
    if (p.has('a')) out.alpha = Number(p.get('a')) || 4;
    if (p.has('b')) out.beta = Number(p.get('b')) || 5;
    if (p.has('net')) out.net = Number(p.get('net')) || 0;
    if (p.has('byz')) out.byz = Number(p.get('byz')) || 0;
    return out;
  } catch {
    return {};
  }
}

const PRESETS: { name: string; hint: string; cfg: ScenarioCfg }[] = [
  { name: 'Knife-edge 50/50', hint: 'an even split of 20 nodes — watch random sampling break the symmetry and tip the whole network one way', cfg: { seed: 1, n: 20, variant: 'snowball', colours: 2, k: 8, alpha: 5, beta: 6, net: 0, byz: 0 } },
  { name: 'Snowflake vs Snowball', hint: 'the same race with only a counter (Snowflake) — switch the variant to feel the difference confidence makes', cfg: { seed: 7, n: 15, variant: 'snowflake', colours: 2, k: 6, alpha: 4, beta: 5, net: 0, byz: 0 } },
  { name: 'Slush (no finality)', hint: 'the memoryless base protocol — it tips, but never *finalises* (no irreversible decision)', cfg: { seed: 3, n: 15, variant: 'slush', colours: 2, k: 6, alpha: 4, beta: 5, net: 0, byz: 0 } },
  { name: 'Byzantine minority', hint: '4 of 16 nodes lie every round — honest nodes still converge to one colour and agreement holds', cfg: { seed: 2, n: 16, variant: 'snowball', colours: 2, k: 6, alpha: 4, beta: 5, net: 0, byz: 4 } },
  { name: 'Three colours', hint: 'a three-way race — α>k/2 still admits at most one winner per round, so one colour wins', cfg: { seed: 5, n: 18, variant: 'snowball', colours: 3, k: 7, alpha: 4, beta: 5, net: 0, byz: 0 } },
];

export function SnowLab() {
  const initial = useMemo(() => ({ ...DEFAULT_SCENARIO, ...readHash() }), []);
  const [seed, setSeed] = useState(initial.seed);
  const [n, setN] = useState(initial.n);
  const [variant, setVariant] = useState<Variant>(initial.variant);
  const [colours, setColours] = useState(initial.colours);
  const [k, setK] = useState(initial.k);
  const [alpha, setAlpha] = useState(initial.alpha);
  const [beta, setBeta] = useState(initial.beta);
  const [net, setNet] = useState(initial.net);
  const [byz, setByz] = useState(initial.byz);
  const [selected, setSelected] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const nodeIds = useMemo(() => NAMES.slice(0, n), [n]);

  // Keep α legal without an effect: k/2 < α ≤ k. We clamp the *derived* value
  // used everywhere, so the raw slider state can stay where the user left it.
  const lo = Math.floor(k / 2) + 1;
  const effAlpha = Math.min(k, Math.max(lo, alpha));

  useEffect(() => {
    const q = new URLSearchParams({
      seed: String(seed), n: String(n), v: variant, c: String(colours),
      k: String(k), a: String(effAlpha), b: String(beta), net: String(net), byz: String(byz),
    });
    history.replaceState(null, '', `#/snow?${q.toString()}`);
  }, [seed, n, variant, colours, k, effAlpha, beta, net, byz]);

  const palette = useMemo(() => COLOURS.slice(0, colours), [colours]);

  // The factory bakes the initial split + Byzantine assignment into history[0],
  // so the demo is alive the instant it loads and every rebuild is reproducible.
  const makeKernel = useCallback(() => {
    const proto = createSnow({ ...DEFAULT_SNOW_CONFIG, variant, colours, k, alpha: effAlpha, beta });
    proto.invariants = snowInvariants as (v: ReadonlyArray<NodeView<SnowState>>) => ReturnType<typeof snowInvariants>;
    const p = NET_PRESETS[net];
    const kernel = new Kernel<SnowState, SnowCmd>({
      seed,
      protocol: proto,
      nodeIds,
      network: { minLatency: p.min, maxLatency: p.max, dropRate: p.drop },
    });
    const byzSet = nodeIds.slice(0, Math.min(byz, nodeIds.length - 1));
    for (const id of byzSet) kernel.command(id, { type: 'byzantine', on: true, adversary: palette[0] });
    const honest = nodeIds.filter((id) => !byzSet.includes(id));
    honest.forEach((id, i) => kernel.command(id, { type: 'seed', colour: palette[i % palette.length] }));
    return kernel;
  }, [seed, nodeIds, variant, colours, k, effAlpha, beta, net, byz, palette]);

  const ctrl = useSimulation(makeKernel);
  const snap = ctrl.snapshot;
  const nodes = useMemo(() => (snap?.nodes ?? []) as NodeRuntime<SnowState>[], [snap]);
  const now = snap?.time ?? 0;
  const views = useMemo<NodeView<SnowState>[]>(() => nodes.map((nd) => ({ id: nd.id, up: nd.up, state: nd.state })), [nodes]);
  const gauge = useMemo(() => snowGauge(views), [views]);

  const splash = (colour: Colour) => {
    const live = nodes.filter((nd) => nd.up && !nd.state.byzantine).map((nd) => nd.id);
    // Re-seed a couple of nodes toward a colour to perturb the race in real time.
    for (let i = 0; i < Math.min(2, live.length); i++) {
      const id = live[(seed + i + Math.floor(now)) % live.length];
      ctrl.command(id, { type: 'seed', colour });
    }
  };

  const applyPreset = (c: ScenarioCfg) => {
    setSeed(c.seed); setN(c.n); setVariant(c.variant); setColours(c.colours);
    setK(c.k); setAlpha(c.alpha); setBeta(c.beta); setNet(c.net); setByz(c.byz);
  };

  const copyLink = () => {
    const url = `${location.origin}${location.pathname}${location.hash}`;
    void navigator.clipboard?.writeText(url).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    });
  };

  const visual = useCallback(
    (node: NodeRuntime<SnowState>): NodeVisual => {
      const s = node.state;
      if (s.byzantine) {
        return { fill: '#8a6d2b', ring: '#ffd479', label: node.id, sub: `lies ${colourStr(s.adversary)}`, glow: true, down: !node.up };
      }
      const finalised = s.decided != null;
      return {
        fill: hex(s.pref),
        ring: finalised ? '#ffffff' : 'rgba(255,255,255,0.22)',
        label: node.id,
        sub: variant === 'slush'
          ? colourStr(s.pref)
          : finalised ? '✓ ' + colourStr(s.decided) : `${colourStr(s.pref)} ${s.cnt}/${beta}`,
        badge: finalised ? '✓' : s.cnt > 0 ? String(s.cnt) : undefined,
        glow: finalised,
        down: !node.up,
      };
    },
    [variant, beta],
  );

  const sel = selected ? nodes.find((nd) => nd.id === selected) : undefined;

  return (
    <div className="lab">
      <div className="lab-intro">
        <h2>Snow* · metastable consensus by random subsampling</h2>
        <p>
          Every other lab here agrees through <b>intersecting majority quorums</b>. The{' '}
          <b>Snow family</b> (Team Rocket, <i>Avalanche</i> 2018 — the engine behind the Avalanche
          blockchain) agrees a completely different way: <b>repeated random sampling</b>. Each round a
          node asks a small random sample of <code>k</code> peers their colour, adopts one that clears an{' '}
          <code>α&gt;k/2</code> threshold, and <b>finalises</b> after <code>β</code> such wins in a row.
          No quorum, no leader, no global view — yet a near-even split <b>tips</b> to network-wide
          agreement, fast and irreversibly. Safety here is <b>probabilistic</b>: the invariants on the
          right hold <em>with overwhelming probability</em>, and the chart below shows the metastable
          <b> tip</b> happen. Crash nodes, partition the network, add Byzantine liars — and watch
          agreement hold anyway.
        </p>
      </div>

      <ControlBar
        ctrl={ctrl}
        seed={seed}
        onSeed={setSeed}
        right={
          <span className={`leader-pill ${gauge.unanimous ? 'has' : ''}`} title="Snow* needs no leader — agreement emerges from sampling">
            {variantName(variant)} · {gauge.finalised}/{gauge.liveHonest} final
          </span>
        }
      />

      <div className="lab-grid">
        <div className="lab-main">
          <div className="cluster-toolbar">
            <div className="ctl-group">
              <label>Nodes</label>
              {[9, 12, 15, 18, 20].map((c) => (
                <button key={c} className={`btn tiny ${n === c ? 'on' : ''}`} onClick={() => setN(c)}>{c}</button>
              ))}
            </div>
            <div className="ctl-group">
              <label>Variant</label>
              {(['slush', 'snowflake', 'snowball'] as Variant[]).map((v) => (
                <button key={v} className={`btn tiny ${variant === v ? 'on' : ''}`} onClick={() => setVariant(v)} title={v}>
                  {variantName(v)}
                </button>
              ))}
            </div>
            <div className="ctl-group">
              <label>Colours</label>
              {[2, 3].map((c) => (
                <button key={c} className={`btn tiny ${colours === c ? 'on' : ''}`} onClick={() => setColours(c)}>{c}</button>
              ))}
            </div>
            <div className="ctl-group">
              <label>Network</label>
              {NET_PRESETS.map((p, i) => (
                <button key={p.name} className={`btn tiny ${net === i ? 'on' : ''}`} onClick={() => setNet(i)}>{p.name}</button>
              ))}
            </div>
          </div>

          <div className="cluster-toolbar">
            <div className="ctl-group">
              <label>k (sample)</label>
              <input type="range" min={3} max={Math.max(3, n - 1)} value={k} onChange={(e) => setK(Number(e.target.value))} style={{ width: 90 }} />
              <code>{k}</code>
            </div>
            <div className="ctl-group">
              <label>α (quorum)</label>
              <input type="range" min={lo} max={k} value={effAlpha} onChange={(e) => setAlpha(Number(e.target.value))} style={{ width: 80 }} />
              <code>{effAlpha}</code>
            </div>
            <div className="ctl-group">
              <label>β (finality)</label>
              <input type="range" min={1} max={12} value={beta} onChange={(e) => setBeta(Number(e.target.value))} style={{ width: 80 }} />
              <code>{beta}</code>
            </div>
            <div className="ctl-group">
              <label>Byzantine</label>
              <input type="range" min={0} max={Math.floor((n - 1) / 2)} value={byz} onChange={(e) => setByz(Number(e.target.value))} style={{ width: 70 }} />
              <code>{byz}</code>
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
              height={340}
            />
          )}

          <div className="action-row">
            {palette.map((c) => (
              <button key={c} className="btn" onClick={() => splash(c)} title={`Re-seed two nodes toward ${colourName(c)} — perturb the race live`}>
                <i style={{ display: 'inline-block', width: 9, height: 9, borderRadius: 2, background: hex(c), marginRight: 6 }} />
                splash {colourName(c)}
              </button>
            ))}
            <button className="btn" onClick={() => ctrl.partition(twoWaySplit(ctrl.nodeOrder))} title="Cut the cluster in half — neither side can sample the other">
              ✂ Partition
            </button>
            <button className="btn good" onClick={ctrl.heal} title="Heal the network">⧉ Heal</button>
            <button className="btn" onClick={ctrl.reset}>↺ New cluster</button>
          </div>

          <div className="action-row">
            {sel ? (
              <>
                <span className="op-target">{sel.id}:</span>
                {palette.map((c) => (
                  <button key={c} className="btn" onClick={() => ctrl.command(sel.id, { type: 'seed', colour: c })}>seed {colourName(c)}</button>
                ))}
                <button className="btn" onClick={() => ctrl.command(sel.id, { type: 'byzantine', on: !sel.state.byzantine, adversary: palette[0] })}>
                  {sel.state.byzantine ? '↺ make honest' : '☠ make Byzantine'}
                </button>
                <button className={`btn ${sel.up ? 'danger' : 'good'}`} onClick={() => (sel.up ? ctrl.crash(sel.id) : ctrl.restart(sel.id))}>
                  {sel.up ? `✕ Crash ${sel.id}` : `⏼ Restart ${sel.id}`}
                </button>
              </>
            ) : (
              <span className="muted">Click a node to seed a colour, turn it Byzantine, or crash it — or a link's midpoint to cut it. The chart below is the network's opinion over time.</span>
            )}
          </div>

          <OpinionTrail views={views} now={now} palette={palette} />

          {snap && <MetricsBar metrics={snap.metrics} />}
        </div>

        <div className="lab-side">
          <InvariantPanel invariants={ctrl.invariants} title="Metastable safety" />

          <div className="lab-aux">
            <div className="panel-head">
              <span>Convergence</span>
              <span className={`status-pill ${gauge.unanimous ? 'ok' : ''}`}>{gauge.unanimous ? 'UNANIMOUS' : 'in flux'}</span>
            </div>
            <div className="lab-aux-body">
              <div className="replica-row"><span className="replica-id">finalised</span><code className="replica-val">{gauge.finalised}/{gauge.liveHonest}</code></div>
              <div className="replica-row"><span className="replica-id">plurality</span><code className="replica-val" style={{ color: hex(gauge.plurality) }}>{colourName(gauge.plurality)} · {gauge.pluralityCount}/{gauge.liveHonest}</code></div>
              <div style={{ padding: '6px 12px' }}>
                <ColourBar views={views} palette={palette} />
              </div>
            </div>
          </div>

          <div className="lab-aux">
            <div className="panel-head"><span>{sel && !sel.state.byzantine ? `Node ${sel.id}` : 'Confidence per node'}</span></div>
            <div className="lab-aux-body">
              {sel && !sel.state.byzantine ? (
                <NodeDetail s={sel.state} palette={palette} variant={variant} beta={beta} />
              ) : (
                nodes.filter((nd) => !nd.state.byzantine).map((nd) => (
                  <div key={nd.id} className="replica-row">
                    <span className="replica-id">{nd.id}{nd.up ? '' : ' ✕'}</span>
                    <code className="replica-val" style={{ color: hex(nd.state.pref) }}>
                      {nd.state.decided != null ? `✓ ${colourStr(nd.state.decided)}` : variant === 'slush' ? colourStr(nd.state.pref) : `${colourStr(nd.state.pref)} · ${nd.state.cnt}/${beta}`}
                    </code>
                  </div>
                ))
              )}
            </div>
          </div>

          <div className="lab-aux">
            <div className="panel-head"><span>Why no quorum?</span></div>
            <div className="lab-aux-body" style={{ padding: '8px 12px', fontSize: 12, color: 'var(--tx-dim)' }}>
              A quorum protocol needs every node to talk to ⌊n/2⌋+1 others — O(n) per decision. Snow*
              asks only <b>k</b> peers no matter how big the network is, so it scales to thousands of
              nodes. The price is that safety is <b>statistical</b>, not absolute: a wrong split-decision
              is merely <em>astronomically unlikely</em> for sane α and β, not impossible. That trade —
              O(k) messages and probabilistic finality — is what makes Avalanche-style consensus fast at
              scale.
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

function NodeDetail({ s, palette, variant, beta }: { s: SnowState; palette: Colour[]; variant: Variant; beta: number }) {
  return (
    <>
      <div className="replica-row"><span className="replica-id">preference</span><code className="replica-val" style={{ color: hex(s.pref) }}>{colourName(s.pref)}</code></div>
      {s.decided != null && <div className="replica-row"><span className="replica-id">decided</span><code className="replica-val" style={{ color: hex(s.decided) }}>✓ {colourName(s.decided)}</code></div>}
      {variant !== 'slush' && <div className="replica-row"><span className="replica-id">streak (cnt)</span><code className="replica-val">{s.cnt}/{beta}</code></div>}
      {variant === 'snowball' && palette.map((c) => (
        <div key={c} className="replica-row"><span className="replica-id">confidence d[{c}]</span><code className="replica-val" style={{ color: hex(c) }}>{s.d[c] ?? 0}</code></div>
      ))}
      <div className="replica-row"><span className="replica-id">rounds run</span><code className="replica-val">{s.roundsDone}</code></div>
      {variant === 'slush' && <div className="replica-row"><span className="replica-id">rounds left</span><code className="replica-val">{Math.max(0, s.slushLeft)}</code></div>}
    </>
  );
}

// A horizontal bar of the current colour split across live honest nodes.
function ColourBar({ views, palette }: { views: NodeView<SnowState>[]; palette: Colour[] }) {
  const live = views.filter((v) => v.up && !v.state.byzantine);
  const counts: Record<string, number> = { none: 0 };
  for (const c of palette) counts[c] = 0;
  for (const v of live) counts[v.state.pref == null ? 'none' : v.state.pref]++;
  const total = Math.max(1, live.length);
  const segs = [...palette, 'none'].filter((c) => counts[c] > 0);
  return (
    <div style={{ display: 'flex', height: 16, borderRadius: 4, overflow: 'hidden', border: '1px solid rgba(255,255,255,0.1)' }}>
      {segs.map((c) => (
        <div key={c} title={`${colourName(c === 'none' ? null : c)}: ${counts[c]}`} style={{ width: `${(counts[c] / total) * 100}%`, background: c === 'none' ? NONE_HEX : hex(c) }} />
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// The network-opinion-over-time chart — the metastable *tip* made visible.
//
// Each honest node keeps a capped trail of (time, colour) preference changes in
// its serialized state, so this stacked step-area can be reconstructed exactly at
// any point on the scrubber. We replay every node's trail in time order, counting
// how many nodes hold each colour at each event, and stack the counts.
// ---------------------------------------------------------------------------

function OpinionTrail({ views, now, palette }: { views: NodeView<SnowState>[]; now: number; palette: Colour[] }) {
  const honest = useMemo(() => views.filter((v) => !v.state.byzantine), [views]);
  const N = honest.length;

  const series = useMemo(() => {
    type Ev = { t: number; node: string; colour: Colour | null };
    const evs: Ev[] = [];
    for (const v of honest) for (const p of v.state.trail) evs.push({ t: p.t, node: v.id, colour: p.colour });
    evs.sort((a, b) => a.t - b.t);
    const cur = new Map<string, Colour | null>();
    for (const v of honest) cur.set(v.id, null);
    const keys = [...palette, 'none'];
    const snapAt = (t: number) => {
      const c: Record<string, number> = {};
      for (const key of keys) c[key] = 0;
      for (const col of cur.values()) c[col == null ? 'none' : col]++;
      return { t, c };
    };
    const pts: { t: number; c: Record<string, number> }[] = [snapAt(0)];
    let i = 0;
    while (i < evs.length) {
      const t = evs[i].t;
      while (i < evs.length && evs[i].t === t) {
        cur.set(evs[i].node, evs[i].colour);
        i++;
      }
      pts.push(snapAt(t));
    }
    pts.push(snapAt(Math.max(now, pts[pts.length - 1].t)));
    return pts;
  }, [honest, now, palette]);

  const width = 760;
  const height = 150;
  const padL = 4, padR = 4, padT = 6, padB = 4;
  const innerW = width - padL - padR;
  const innerH = height - padT - padB;
  const t0 = 0;
  const t1 = Math.max(1, series[series.length - 1].t);
  const x = (t: number) => padL + ((t - t0) / (t1 - t0)) * innerW;
  const y = (v: number) => padT + innerH - (v / Math.max(1, N)) * innerH;

  // Build stacked step-area paths, one per colour (none on top).
  const order = [...palette, 'none'];
  const bands = order.map((key, idx) => {
    const below = order.slice(0, idx);
    const top: string[] = [];
    const bottom: string[] = [];
    for (const pt of series) {
      const base = below.reduce((acc, kk) => acc + pt.c[kk], 0);
      const hi = base + pt.c[key];
      top.push(`${x(pt.t)},${y(hi)}`);
      bottom.push(`${x(pt.t)},${y(base)}`);
    }
    // step interpolation: duplicate points so areas are piecewise-constant
    const stepTop: string[] = [];
    for (let i = 0; i < series.length; i++) {
      if (i > 0) stepTop.push(`${x(series[i].t)},${prevY(series, i - 1, below, key, y)}`);
      stepTop.push(top[i]);
    }
    const stepBot: string[] = [];
    for (let i = series.length - 1; i >= 0; i--) {
      stepBot.push(bottom[i]);
      if (i > 0) stepBot.push(`${x(series[i].t)},${prevYBase(series, i - 1, below, y)}`);
    }
    return { key, d: `M${stepTop.join(' L')} L${stepBot.join(' L')} Z` };
  });

  const empty = series.length <= 2 && series[series.length - 1].c['none'] === N;

  return (
    <div className="depgraph">
      <div className="panel-head">
        <span>Network opinion over time</span>
        <span className="muted">stacked count of honest nodes per colour · the metastable tip</span>
      </div>
      <div className="depgraph-scroll">
        <svg width={width} height={height} className="depgraph-svg" preserveAspectRatio="none">
          {bands.map((b) => (
            <path key={b.key} d={b.d} fill={b.key === 'none' ? NONE_HEX : hex(b.key)} opacity={b.key === 'none' ? 0.28 : 0.85} />
          ))}
          <line x1={x(now)} y1={0} x2={x(now)} y2={height} stroke="rgba(255,255,255,0.3)" strokeDasharray="3 3" />
        </svg>
      </div>
      <div className="depgraph-foot muted">
        {empty ? 'Press Play — colours spread by sampling and the stack tips to one band.' : (
          <>Each band is the number of honest nodes preferring a colour. When sampling tips the balance, one band swallows the rest — agreement. Time {fmtTime(t0)} → {fmtTime(t1)}.</>
        )}
      </div>
    </div>
  );
}

// Helpers for the step interpolation of the stacked area (previous sample's y).
function prevY(series: { t: number; c: Record<string, number> }[], i: number, below: string[], key: string, y: (v: number) => number): number {
  const base = below.reduce((acc, kk) => acc + series[i].c[kk], 0);
  return y(base + series[i].c[key]);
}
function prevYBase(series: { t: number; c: Record<string, number> }[], i: number, below: string[], y: (v: number) => number): number {
  const base = below.reduce((acc, kk) => acc + series[i].c[kk], 0);
  return y(base);
}
