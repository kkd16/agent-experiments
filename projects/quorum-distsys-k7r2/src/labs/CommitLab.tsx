import { useCallback, useMemo, useState } from 'react';
import { Kernel } from '../sim/kernel';
import { createTwoPC, type TwoPCCmd, type TwoPCState } from '../protocols/commit/twopc';
import { useSimulation } from '../lib/useSimulation';
import { NetworkCanvas, type NodeVisual } from '../ui/NetworkCanvas';
import { ControlBar } from '../ui/ControlBar';
import { InvariantPanel } from '../ui/InvariantPanel';
import { Timeline } from '../ui/Timeline';
import { MetricsBar } from '../ui/MetricsBar';
import type { NodeRuntime } from '../sim/types';

const NAMES = ['C', 'P1', 'P2', 'P3', 'P4'];

const COORD_COLOR: Record<string, string> = {
  idle: '#5b6472',
  collecting: '#7c9cff',
  committed: '#73e08a',
  aborted: '#ff5d6c',
  stalled: '#ffd479',
};
const PART_COLOR: Record<string, string> = {
  idle: '#5b6472',
  prepared: '#ffd479',
  committed: '#73e08a',
  aborted: '#ff5d6c',
  uncertain: '#b08bff',
};

export function CommitLab() {
  const [seed, setSeed] = useState(1);
  const [count, setCount] = useState(4);
  const [selected, setSelected] = useState<string | null>(null);

  const nodeIds = useMemo(() => NAMES.slice(0, count), [count]);
  const coord = nodeIds[0];

  const makeKernel = useCallback(() => {
    return new Kernel<TwoPCState, TwoPCCmd>({
      seed,
      protocol: createTwoPC(),
      nodeIds,
      network: { minLatency: 40, maxLatency: 110, dropRate: 0 },
    });
  }, [seed, nodeIds]);

  const ctrl = useSimulation(makeKernel);
  const snap = ctrl.snapshot;
  const nodes = snap?.nodes ?? [];

  const blocked = nodes.some((n) => n.state.role === 'participant' && n.state.pstate === 'uncertain');
  const coordPhase = nodes.find((n) => n.id === coord)?.state.phase ?? 'idle';

  const visual = useCallback(
    (node: NodeRuntime<TwoPCState>): NodeVisual => {
      const s = node.state;
      if (s.role === 'coordinator') {
        return {
          fill: COORD_COLOR[s.phase],
          ring: '#fff',
          label: node.id,
          sub: s.phase,
          glow: s.phase === 'collecting' || s.phase === 'stalled',
          down: !node.up,
        };
      }
      return {
        fill: PART_COLOR[s.pstate],
        ring: s.willVote === 'no' ? '#ff5d6c' : 'rgba(255,255,255,0.2)',
        label: node.id,
        sub: s.pstate === 'idle' ? `vote ${s.willVote}` : s.pstate,
        glow: s.pstate === 'uncertain',
        down: !node.up,
      };
    },
    [],
  );

  const sel = selected ? nodes.find((n) => n.id === selected) : undefined;
  const selIsParticipant = sel && sel.state.role === 'participant';

  return (
    <div className="lab">
      <div className="lab-intro">
        <h2>Two-phase commit &amp; the blocking problem</h2>
        <p>
          The coordinator (<b>{coord}</b>) asks each participant to prepare, then commits only if all
          vote yes. It is <em>safe</em> — everyone agrees — but not <em>live</em>: hit <b>Begin + stall</b>
          to make the coordinator freeze right after collecting the yes votes, and watch the prepared
          participants block forever, unable to decide on their own. The safety invariants stay green
          the whole time; that is the point.
        </p>
      </div>

      <ControlBar
        ctrl={ctrl}
        seed={seed}
        onSeed={setSeed}
        right={
          <span className={`leader-pill ${blocked ? 'none' : 'has'}`}>
            {blocked ? 'BLOCKED' : `coordinator: ${coordPhase}`}
          </span>
        }
      />

      <div className="lab-grid">
        <div className="lab-main">
          <div className="cluster-toolbar">
            <div className="ctl-group">
              <label>Participants</label>
              {[3, 4, 5].map((c) => (
                <button key={c} className={`btn tiny ${count === c ? 'on' : ''}`} onClick={() => setCount(c)}>
                  {c - 1}
                </button>
              ))}
            </div>
            <div className="legend">
              <span><i style={{ background: PART_COLOR.prepared }} /> prepared</span>
              <span><i style={{ background: PART_COLOR.committed }} /> committed</span>
              <span><i style={{ background: PART_COLOR.aborted }} /> aborted</span>
              <span><i style={{ background: PART_COLOR.uncertain }} /> blocked</span>
            </div>
          </div>

          {snap && (
            <NetworkCanvas
              snapshot={snap}
              nodeOrder={ctrl.nodeOrder}
              visual={visual}
              selected={selected}
              onSelect={setSelected}
              onToggleLink={(a, b) => ctrl.toggleLink(a, b)}
              messageColor={(t) =>
                t === 'PREPARE' ? '#7c9cff' : t === 'VOTE' ? '#ffd479' : t === 'COMMIT' ? '#73e08a' : '#ff7a7a'
              }
              height={400}
            />
          )}

          <div className="action-row">
            <button className="btn primary" onClick={() => ctrl.command(coord, { type: 'begin' })}>
              ▶ Begin transaction
            </button>
            <button className="btn" onClick={() => ctrl.command(coord, { type: 'begin', stall: true })}>
              ⏸ Begin + stall
            </button>
            <button className="btn danger" onClick={() => ctrl.crash(coord)}>
              ✕ Crash coordinator
            </button>
            <button className="btn" onClick={ctrl.reset}>
              ↺ New cluster
            </button>
          </div>
          <div className="action-row">
            {selIsParticipant && sel && (
              <>
                <span className="op-target">
                  {sel.id} will vote <b>{sel.state.willVote}</b>:
                </span>
                <button className="btn" onClick={() => ctrl.command(sel.id, { type: 'setvote', vote: 'yes' })}>
                  vote yes
                </button>
                <button className="btn danger" onClick={() => ctrl.command(sel.id, { type: 'setvote', vote: 'no' })}>
                  vote no
                </button>
              </>
            )}
            {sel && (
              <button
                className={`btn ${sel.up ? 'danger' : 'good'}`}
                onClick={() => (sel.up ? ctrl.crash(sel.id) : ctrl.restart(sel.id))}
              >
                {sel.up ? `✕ Crash ${sel.id}` : `⏼ Restart ${sel.id}`}
              </button>
            )}
            {!sel && <span className="muted">Click a participant to change its vote or crash it.</span>}
          </div>

          {snap && <MetricsBar metrics={snap.metrics} />}
        </div>

        <div className="lab-side">
          <InvariantPanel invariants={ctrl.invariants} title="Atomic commit safety" />
          <div className="lab-aux">
            <div className="panel-head">
              <span>Participants</span>
            </div>
            <div className="lab-aux-body">
              {nodes
                .filter((n) => n.state.role === 'participant')
                .map((n) => (
                  <div key={n.id} className="replica-row">
                    <span className="replica-id">
                      {n.id}
                      {n.up ? '' : ' ✕'}
                    </span>
                    <code className="replica-val" style={{ color: PART_COLOR[n.state.pstate] }}>
                      {n.state.pstate} · vote {n.state.willVote}
                    </code>
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
