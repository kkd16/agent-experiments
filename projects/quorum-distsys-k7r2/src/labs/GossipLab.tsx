import { useCallback, useMemo, useState } from 'react';
// (useMemo also memoizes the node list below so callback deps stay stable)
import { Kernel } from '../sim/kernel';
import { createSwim, type MemberStatus, type SwimState } from '../protocols/gossip/swim';
import { useSimulation } from '../lib/useSimulation';
import { NetworkCanvas, type NodeVisual } from '../ui/NetworkCanvas';
import { ControlBar } from '../ui/ControlBar';
import { InvariantPanel } from '../ui/InvariantPanel';
import { Timeline } from '../ui/Timeline';
import { MetricsBar } from '../ui/MetricsBar';
import type { NodeRuntime } from '../sim/types';

const NAMES = ['A', 'B', 'C', 'D', 'E', 'F', 'G'];
const STATUS_COLOR: Record<MemberStatus, string> = {
  alive: '#7c9cff',
  suspect: '#ffd479',
  dead: '#ff5d6c',
};

export function GossipLab() {
  const [seed, setSeed] = useState(11);
  const [count, setCount] = useState(6);
  const [selected, setSelected] = useState<string | null>(null);

  const nodeIds = useMemo(() => NAMES.slice(0, count), [count]);

  const makeKernel = useCallback(() => {
    return new Kernel<SwimState, { type: 'rumor' }>({
      seed,
      protocol: createSwim(),
      nodeIds,
      network: { minLatency: 20, maxLatency: 60, dropRate: 0 },
    });
  }, [seed, nodeIds]);

  const ctrl = useSimulation(makeKernel);
  const snap = ctrl.snapshot;
  const nodes = useMemo(() => snap?.nodes ?? [], [snap]);

  // Majority belief about each node's status, across the live observers.
  const beliefOf = useCallback(
    (id: string): MemberStatus => {
      const tally: Record<string, number> = {};
      for (const n of nodes) {
        if (!n.up) continue;
        const st = n.id === id ? 'alive' : n.state.members[id]?.status ?? 'alive';
        tally[st] = (tally[st] ?? 0) + 1;
      }
      const entries = Object.entries(tally).sort((a, b) => b[1] - a[1]);
      return (entries[0]?.[0] as MemberStatus) ?? 'alive';
    },
    [nodes],
  );

  const visual = useCallback(
    (node: NodeRuntime<SwimState>): NodeVisual => {
      const belief = beliefOf(node.id);
      return {
        fill: STATUS_COLOR[belief],
        ring: 'rgba(255,255,255,0.2)',
        label: node.id,
        sub: `i${node.state.inc}`,
        down: !node.up,
        glow: belief === 'suspect',
      };
    },
    [beliefOf],
  );

  const maxRumor = Math.max(0, ...nodes.map((n) => n.state.rumor));
  const knownBy = nodes.filter((n) => n.up && n.state.rumor === maxRumor && maxRumor > 0).length;
  const upCount = nodes.filter((n) => n.up).length;

  const sel = selected ? nodes.find((n) => n.id === selected) : undefined;

  return (
    <div className="lab">
      <div className="lab-intro">
        <h2>Gossip &amp; SWIM failure detection</h2>
        <p>
          Nodes ping random peers and, when one goes quiet, ask others to probe it indirectly before
          declaring it <b>suspect</b> then <b>dead</b> — all disseminated epidemically by piggybacking
          on normal traffic, with incarnation numbers so a node can refute a false rumor of its death.
          Crash a node and watch the knowledge of its death infect the cluster.
        </p>
      </div>

      <ControlBar
        ctrl={ctrl}
        seed={seed}
        onSeed={setSeed}
        right={
          <span className="leader-pill has">
            rumor known by {knownBy}/{upCount}
          </span>
        }
      />

      <div className="lab-grid">
        <div className="lab-main">
          <div className="cluster-toolbar">
            <div className="ctl-group">
              <label>Nodes</label>
              {[4, 5, 6, 7].map((c) => (
                <button key={c} className={`btn tiny ${count === c ? 'on' : ''}`} onClick={() => setCount(c)}>
                  {c}
                </button>
              ))}
            </div>
            <div className="legend">
              <span><i style={{ background: STATUS_COLOR.alive }} /> alive</span>
              <span><i style={{ background: STATUS_COLOR.suspect }} /> suspect</span>
              <span><i style={{ background: STATUS_COLOR.dead }} /> dead</span>
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
              messageColor={(t) => (t === 'ping' ? '#ffd479' : t === 'ack' ? '#73e08a' : '#b08bff')}
              messageGlyph={(t) => (t === 'ping' ? 'p' : t === 'ack' ? 'a' : 'r')}
              height={400}
            />
          )}

          <div className="action-row">
            <button className="btn" onClick={() => ctrl.command(ctrl.nodeOrder[0], { type: 'rumor' })}>
              📣 Spread rumor
            </button>
            <button
              className="btn"
              onClick={() => {
                const half = Math.ceil(ctrl.nodeOrder.length / 2);
                ctrl.partition([ctrl.nodeOrder.slice(0, half), ctrl.nodeOrder.slice(half)]);
              }}
            >
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

          {snap && <MetricsBar metrics={snap.metrics} />}
        </div>

        <div className="lab-side">
          <InvariantPanel invariants={ctrl.invariants} title="Failure detector" />
          <div className="lab-aux">
            <div className="panel-head">
              <span>Membership matrix</span>
              <span className="muted" style={{ fontWeight: 400, fontSize: '0.7rem' }}>row sees column</span>
            </div>
            <div className="lab-aux-body" style={{ overflowX: 'auto' }}>
              <table className="member-matrix">
                <thead>
                  <tr>
                    <th></th>
                    {nodes.map((c) => (
                      <th key={c.id}>{c.id}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {nodes.map((r) => (
                    <tr key={r.id}>
                      <th className={r.up ? '' : 'down'}>{r.id}</th>
                      {nodes.map((c) => {
                        const st: MemberStatus = r.id === c.id ? 'alive' : r.state.members[c.id]?.status ?? 'alive';
                        return (
                          <td key={c.id} title={`${r.id} sees ${c.id}: ${st}`}>
                            <span
                              className="mm-cell"
                              style={{ background: r.up ? STATUS_COLOR[st] : '#2a2d36' }}
                            />
                          </td>
                        );
                      })}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      </div>

      <Timeline log={snap?.log ?? []} />
    </div>
  );
}
