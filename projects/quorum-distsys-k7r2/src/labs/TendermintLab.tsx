import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Kernel } from '../sim/kernel';
import { createTendermint } from '../protocols/tendermint/tendermint';
import { tendermintInvariants } from '../protocols/tendermint/invariants';
import {
  DEFAULT_TENDERMINT_CONFIG,
  faultBudget,
  proposerOf,
  opStr,
  type Command,
  type FaultMode,
  type TendermintCmd,
  type TendermintState,
} from '../protocols/tendermint/types';
import { useSimulation } from '../lib/useSimulation';
import { NetworkCanvas, type NodeVisual } from '../ui/NetworkCanvas';
import { ControlBar } from '../ui/ControlBar';
import { InvariantPanel } from '../ui/InvariantPanel';
import { Timeline } from '../ui/Timeline';
import { MetricsBar } from '../ui/MetricsBar';
import { TendermintLadder } from '../ui/TendermintLadder';
import type { NodeRuntime, NodeView } from '../sim/types';

const NAMES = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J'];

interface NetPreset {
  name: string;
  min: number;
  max: number;
  drop: number;
  /** Base-timeout multiplier — timeouts must comfortably clear a vote round-trip. */
  scale: number;
}
const NET_PRESETS: NetPreset[] = [
  { name: 'LAN', min: 20, max: 60, drop: 0, scale: 1 },
  { name: 'WAN', min: 80, max: 220, drop: 0, scale: 2 },
  { name: 'Lossy', min: 20, max: 90, drop: 0.12, scale: 1.4 },
];

const FAULT_LABEL: Record<FaultMode, string> = {
  honest: 'honest',
  silent: 'silent',
  equivocate: 'equivocate',
  conflict: 'conflict',
};
const FAULT_COLOR: Record<FaultMode, string> = {
  honest: '#5b6472',
  silent: '#8a6d3b',
  equivocate: '#ff5d6c',
  conflict: '#ff8a3d',
};
const FAULT_HELP: Record<FaultMode, string> = {
  honest: 'follows the protocol exactly',
  silent: 'proposes & votes nothing — its round times out and the ladder climbs to the next proposer',
  equivocate: 'a malicious proposer that proposes two conflicting values in one round and double-prevotes both',
  conflict: 'a malicious validator that votes for a corrupted value id — its votes never count',
};

const PROPOSER_COLOR = '#73e08a';
const VALIDATOR_COLOR = '#46506a';

const MSG_COLOR = (t: string): string => {
  if (t === 'Request') return '#e8eaf0';
  if (t === 'Proposal') return '#b08bff';
  if (t === 'Prevote') return '#7c9cff';
  if (t === 'Precommit') return '#5bd6c8';
  if (t === 'Status' || t === 'Sync') return '#3f4b5e';
  return '#9aa2b1';
};

interface ScenarioCfg {
  seed: number;
  count: number;
  net: number;
  faults: Record<string, FaultMode>;
}
const DEFAULT_SCENARIO: ScenarioCfg = { seed: 42, count: 4, net: 0, faults: {} };

function readHash(): Partial<ScenarioCfg> {
  try {
    const query = window.location.hash.split('?')[1];
    if (!query) return {};
    const p = new URLSearchParams(query);
    const out: Partial<ScenarioCfg> = {};
    if (p.has('seed')) out.seed = Number(p.get('seed')) || 0;
    if (p.has('n')) out.count = Number(p.get('n')) || 4;
    if (p.has('net')) out.net = Number(p.get('net')) || 0;
    if (p.has('f')) {
      const faults: Record<string, FaultMode> = {};
      for (const tok of (p.get('f') || '').split(',')) {
        const [id, mode] = tok.split(':');
        if (id && mode) faults[id] = mode as FaultMode;
      }
      out.faults = faults;
    }
    return out;
  } catch {
    return {};
  }
}

const PRESETS: { name: string; hint: string; cfg: ScenarioCfg }[] = [
  { name: 'Healthy (4 · f=1)', hint: 'all honest — watch a value gather a Polka, lock, then commit; one block per height', cfg: { seed: 42, count: 4, net: 0, faults: {} } },
  { name: 'Silent proposer', hint: "a proposer goes dark → its round times out to a nil-prevote and the ladder climbs to the next proposer", cfg: { seed: 3, count: 4, net: 0, faults: { B: 'silent' } } },
  { name: 'Equivocating proposer', hint: 'a malicious proposer proposes conflicting values & double-prevotes — quorum intersection stops both from forming a Polka', cfg: { seed: 7, count: 4, net: 0, faults: { B: 'equivocate' } } },
  { name: 'Lying validator', hint: 'a validator votes for a bogus value id — the id matches no real block, so its votes are ignored', cfg: { seed: 11, count: 4, net: 0, faults: { D: 'conflict' } } },
  { name: '7 nodes · 2 faulty', hint: 'N=7 tolerates f=2 Byzantine faults at once', cfg: { seed: 13, count: 7, net: 0, faults: { B: 'silent', G: 'conflict' } } },
  { name: 'Beyond f (unsafe!)', hint: 'two faulty in a 4-node cluster EXCEEDS f=1 — agreement may now break', cfg: { seed: 5, count: 4, net: 0, faults: { A: 'equivocate', C: 'equivocate' } } },
];

export function TendermintLab() {
  const initial = useMemo(() => ({ ...DEFAULT_SCENARIO, ...readHash() }), []);
  const [seed, setSeed] = useState(initial.seed);
  const [count, setCount] = useState(initial.count);
  const [net, setNet] = useState(initial.net);
  const [faults, setFaults] = useState<Record<string, FaultMode>>(initial.faults);
  const faultsRef = useRef(faults);
  useEffect(() => {
    faultsRef.current = faults;
  }, [faults]);
  const [selected, setSelected] = useState<string | null>(null);
  const [counter, setCounter] = useState(1);
  const [copied, setCopied] = useState(false);

  const nodeIds = useMemo(() => NAMES.slice(0, count), [count]);
  const f = faultBudget(count);

  useEffect(() => {
    const fstr = Object.entries(faults)
      .filter(([, m]) => m !== 'honest')
      .map(([id, m]) => `${id}:${m}`)
      .join(',');
    const query = new URLSearchParams({ seed: String(seed), n: String(count), net: String(net) });
    if (fstr) query.set('f', fstr);
    history.replaceState(null, '', `#/tendermint?${query.toString()}`);
  }, [seed, count, net, faults]);

  const makeKernel = useCallback(() => {
    const p = NET_PRESETS[net];
    const proto = createTendermint({
      ...DEFAULT_TENDERMINT_CONFIG,
      timeoutPropose: Math.round(DEFAULT_TENDERMINT_CONFIG.timeoutPropose * p.scale),
      timeoutPrevote: Math.round(DEFAULT_TENDERMINT_CONFIG.timeoutPrevote * p.scale),
      timeoutPrecommit: Math.round(DEFAULT_TENDERMINT_CONFIG.timeoutPrecommit * p.scale),
      timeoutDelta: Math.round(DEFAULT_TENDERMINT_CONFIG.timeoutDelta * p.scale),
    });
    proto.invariants = tendermintInvariants as (n: ReadonlyArray<NodeView<TendermintState>>) => ReturnType<typeof tendermintInvariants>;
    const k = new Kernel<TendermintState, TendermintCmd>({
      seed,
      protocol: proto,
      nodeIds,
      network: { minLatency: p.min, maxLatency: p.max, dropRate: p.drop },
    });
    for (const id of nodeIds) {
      const m = faultsRef.current[id];
      if (m && m !== 'honest') k.command(id, { type: 'set-fault', mode: m });
    }
    return k;
  }, [seed, nodeIds, net]);

  const ctrl = useSimulation(makeKernel);
  const snap = ctrl.snapshot;
  const nodes = useMemo(() => (snap?.nodes ?? []) as NodeRuntime<TendermintState>[], [snap]);

  // The "lead" honest validator — the one that has decided the most heights.
  const lead = useMemo(
    () =>
      nodes
        .filter((node) => node.state.fault === 'honest')
        .reduce<NodeRuntime<TendermintState> | null>((a, b) => (a && a.state.decidedHeight >= b.state.decidedHeight ? a : b), null),
    [nodes],
  );
  const clusterHeight = lead?.state.height ?? 1;
  const clusterRound = lead?.state.round ?? 0;
  const proposerId = proposerOf(nodeIds, clusterHeight, clusterRound);

  const maxDecided = lead?.state.decidedHeight ?? 0;
  const faultyCount = nodes.filter((node) => node.state.fault !== 'honest').length;

  const committedReal = useMemo(() => (lead ? lead.state.committed.filter((e) => e.cmd.op.op !== 'noop') : []), [lead]);
  const leaderKv = lead?.state.kv ?? {};

  const propose = (cmd: Command) => {
    ctrl.act((k) => {
      for (const id of k.nodeOrder) if (k.isUp(id)) k.command(id, { type: 'request', command: cmd });
    });
    setCounter((c) => c + 1);
  };
  const proposeRandom = () => {
    const key = ['x', 'y', 'z'][counter % 3];
    propose({ cid: 'u' + counter, op: { op: 'set', key, value: String(counter) } });
  };

  const setFault = (id: string, mode: FaultMode) => {
    setFaults((prev) => {
      const nf = { ...prev };
      if (mode === 'honest') delete nf[id];
      else nf[id] = mode;
      faultsRef.current = nf;
      return nf;
    });
    ctrl.command(id, { type: 'set-fault', mode });
  };

  const applyPreset = (cfg: ScenarioCfg) => {
    faultsRef.current = cfg.faults;
    setFaults(cfg.faults);
    setSeed(cfg.seed);
    setCount(cfg.count);
    setNet(cfg.net);
    setSelected(null);
  };

  const copyLink = () => {
    const url = `${location.origin}${location.pathname}${location.hash}`;
    void navigator.clipboard?.writeText(url).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    });
  };

  const visual = useCallback(
    (node: NodeRuntime<TendermintState>): NodeVisual => {
      const s = node.state;
      const isProposer = node.id === proposerId;
      const byz = s.fault !== 'honest';
      const stepShort = s.step === 'propose' ? 'prop' : s.step === 'prevote' ? 'pv' : 'pc';
      return {
        fill: byz ? FAULT_COLOR[s.fault] : isProposer ? PROPOSER_COLOR : VALIDATOR_COLOR,
        ring: isProposer ? '#fff' : byz ? '#ff5d6c' : 'rgba(255,255,255,0.18)',
        label: node.id,
        sub: byz ? `⚠ ${s.fault}` : isProposer ? `proposer H${s.height}` : `H${s.height}·r${s.round}·${stepShort}`,
        badge: s.decidedHeight > 0 ? `#${s.decidedHeight}` : undefined,
        glow: isProposer || byz || s.lockedValue !== null,
        down: !node.up,
      };
    },
    [proposerId],
  );

  const sel = selected ? nodes.find((node) => node.id === selected) : undefined;
  const ladderState = sel?.state ?? lead?.state ?? null;

  return (
    <div className="lab">
      <div className="lab-intro">
        <h2>Tendermint · BFT consensus with a lock</h2>
        <p>
          <b>Tendermint</b> (Buchman, Kwon &amp; Milošević, 2018) is the gossip-based Byzantine-fault-tolerant engine
          behind Cosmos and a generation of proof-of-stake chains — the same <b>N = 3f+1</b> fault model as PBFT and
          HotStuff, but organised as a ladder of <b>rounds</b>, each three steps. The round&rsquo;s proposer{' '}
          <span style={{ color: MSG_COLOR('Proposal') }}>proposes</span> a value; everyone{' '}
          <span style={{ color: MSG_COLOR('Prevote') }}>prevotes</span> it (or nil); <b>2f+1</b> prevotes for one value
          is a <b>Polka</b>, on which a validator <b style={{ color: '#f5c451' }}>locks</b> the value and{' '}
          <span style={{ color: MSG_COLOR('Precommit') }}>precommits</span> it; <b>2f+1</b> precommits{' '}
          <span style={{ color: PROPOSER_COLOR }}>decide</span> the block — one per height, final forever. The famous
          part is the <b>lock</b>: a locked validator won&rsquo;t prevote a different value in a later round unless it
          sees an even-later Polka — and <i>that</i> is what stops two rounds of one height from deciding differently.
          Corrupt the proposer and watch <b>Agreement</b> hold; safety even survives full asynchrony — growing per-round
          timeouts only buy liveness.
        </p>
      </div>

      <ControlBar
        ctrl={ctrl}
        seed={seed}
        onSeed={setSeed}
        right={
          <span className={`leader-pill ${faultyCount > f ? 'none' : 'has'}`}>
            N={count} · f={f} · {faultyCount} Byzantine{faultyCount > f ? ' (UNSAFE)' : ''}
          </span>
        }
      />

      <div className="lab-grid">
        <div className="lab-main">
          <div className="cluster-toolbar">
            <div className="ctl-group">
              <label>Validators</label>
              {[4, 7, 10].map((c) => (
                <button key={c} className={`btn tiny ${count === c ? 'on' : ''}`} onClick={() => setCount(c)} title={`N=${c} tolerates f=${faultBudget(c)}`}>
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
            <div className="legend">
              <span><i style={{ background: PROPOSER_COLOR }} /> proposer</span>
              <span><i style={{ background: VALIDATOR_COLOR }} /> validator</span>
              <span><i style={{ background: FAULT_COLOR.equivocate }} /> Byzantine</span>
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
              height={360}
            />
          )}

          <TendermintLadder state={ladderState} all={nodeIds} />

          <div className="action-row">
            <button className="btn primary" onClick={proposeRandom}>
              ▶ Client request
            </button>
            <button
              className="btn"
              onClick={() => setFault(proposerId, faults[proposerId] === 'equivocate' ? 'honest' : 'equivocate')}
              title="Flip the current round's proposer into an equivocating Byzantine node — live"
            >
              {faults[proposerId] === 'equivocate' ? `🙂 Heal ${proposerId}` : `😈 Corrupt proposer ${proposerId}`}
            </button>
            <button className="btn" onClick={ctrl.reset}>
              ↺ New cluster
            </button>
          </div>

          <div className="action-row">
            {sel ? (
              <>
                <span className="op-target">{sel.id}:</span>
                {(['honest', 'silent', 'equivocate', 'conflict'] as FaultMode[]).map((m) => (
                  <button
                    key={m}
                    className={`btn tiny ${(faults[sel.id] ?? 'honest') === m ? 'on' : ''}`}
                    style={(faults[sel.id] ?? 'honest') === m && m !== 'honest' ? { color: FAULT_COLOR[m] } : undefined}
                    title={FAULT_HELP[m]}
                    onClick={() => setFault(sel.id, m)}
                  >
                    {FAULT_LABEL[m]}
                  </button>
                ))}
                <button className={`btn ${sel.up ? 'danger' : 'good'}`} onClick={() => (sel.up ? ctrl.crash(sel.id) : ctrl.restart(sel.id))}>
                  {sel.up ? `✕ Crash` : `⏼ Restart`}
                </button>
              </>
            ) : (
              <span className="muted">Click a node to set its fault mode or crash it (and see its round ladder). Click a link's midpoint to cut/heal it.</span>
            )}
          </div>

          {snap && <MetricsBar metrics={snap.metrics} />}
        </div>

        <div className="lab-side">
          <InvariantPanel invariants={ctrl.invariants} title="Tendermint safety (honest validators)" />

          <div className="lab-aux">
            <div className="panel-head">
              <span>Decided log</span>
              <span className="muted">≤ #{maxDecided}</span>
            </div>
            <div className="lab-aux-body">
              {committedReal.length === 0 && <div className="muted pad">Nothing decided yet — send a client request.</div>}
              {committedReal.slice(-12).map((r) => (
                <div key={r.height} className="replica-row">
                  <span className="replica-id">#{r.height}</span>
                  <code className="replica-val" style={{ color: PROPOSER_COLOR }}>
                    {opStr(r.cmd)}
                  </code>
                  <span className="muted" style={{ fontSize: '0.72em' }}>
                    r{r.round}
                    {r.via === 'sync' ? ' · sync' : ''}
                  </span>
                </div>
              ))}
            </div>
          </div>

          {sel && (
            <div className="lab-aux">
              <div className="panel-head">
                <span>Validator · {sel.id}{sel.up ? '' : ' ✕'}</span>
                <span className="muted" style={{ color: sel.state.fault === 'honest' ? undefined : FAULT_COLOR[sel.state.fault] }}>
                  {sel.state.fault === 'honest' ? 'honest' : `⚠ ${sel.state.fault}`}
                </span>
              </div>
              <div className="lab-aux-body">
                <div className="replica-row">
                  <span className="replica-id">at</span>
                  <code className="replica-val">
                    H{sel.state.height} · r{sel.state.round} · {sel.state.step}
                    {sel.id === proposerId ? ' (proposer)' : ''}
                  </code>
                </div>
                <div className="replica-row">
                  <span className="replica-id">decided</span>
                  <code className="replica-val">≤ #{sel.state.decidedHeight}</code>
                </div>
                <div className="replica-row">
                  <span className="replica-id">locked</span>
                  <code className="replica-val" style={{ color: sel.state.lockedValue ? '#f5c451' : undefined }}>
                    {sel.state.lockedValue ? `${opStr(sel.state.lockedValue.cmd)} @r${sel.state.lockedRound}` : 'none'}
                  </code>
                </div>
                <div className="replica-row">
                  <span className="replica-id">valid</span>
                  <code className="replica-val" style={{ color: sel.state.validValue ? '#7c9cff' : undefined }}>
                    {sel.state.validValue ? `${opStr(sel.state.validValue.cmd)} @r${sel.state.validRound}` : 'none'}
                  </code>
                </div>
                <div className="replica-row">
                  <span className="replica-id">note</span>
                  <code className="replica-val" style={{ color: '#9aa2b1' }}>{sel.state.note}</code>
                </div>
              </div>
            </div>
          )}

          <div className="lab-aux">
            <div className="panel-head">
              <span>Replicated KV (most-advanced honest)</span>
            </div>
            <div className="lab-aux-body">
              {Object.keys(leaderKv).length === 0 && <div className="muted pad">empty</div>}
              {Object.keys(leaderKv)
                .sort()
                .map((k) => (
                  <div key={k} className="replica-row">
                    <span className="replica-id">{k}</span>
                    <code className="replica-val">{leaderKv[k]}</code>
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
