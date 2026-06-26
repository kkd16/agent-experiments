import { useCallback, useMemo, useState } from 'react';
import { Kernel } from '../sim/kernel';
import { createVClock, fmtVec, relate, type VcCmd, type VcEvent, type VcState } from '../protocols/vclock/vclock';
import { useSimulation } from '../lib/useSimulation';
import { ControlBar } from '../ui/ControlBar';
import { InvariantPanel } from '../ui/InvariantPanel';
import { Timeline } from '../ui/Timeline';
import { SpaceTimeDiagram } from '../ui/SpaceTimeDiagram';

const NAMES = ['A', 'B', 'C', 'D'];
const REL_TEXT: Record<string, string> = {
  before: 'happened-before →',
  after: '← happened-after',
  concurrent: '∥ concurrent',
  same: 'same event',
};

export function VClockLab() {
  const [seed, setSeed] = useState(3);
  const [count, setCount] = useState(3);
  const [actor, setActor] = useState('A');
  const [pair, setPair] = useState<string[]>([]);

  const nodeIds = useMemo(() => NAMES.slice(0, count), [count]);

  const makeKernel = useCallback(() => {
    return new Kernel<VcState, VcCmd>({
      seed,
      protocol: createVClock(),
      nodeIds,
      network: { minLatency: 60, maxLatency: 160, dropRate: 0 },
    });
  }, [seed, nodeIds]);

  const ctrl = useSimulation(makeKernel);
  const snap = ctrl.snapshot;

  const events = useMemo<VcEvent[]>(() => {
    const all = (snap?.nodes ?? []).flatMap((n) => n.state.events);
    all.sort((a, b) => a.t - b.t || a.id.localeCompare(b.id));
    return all.slice(-90);
  }, [snap]);

  const byId = useMemo(() => new Map(events.map((e) => [e.id, e])), [events]);

  const onSelect = (id: string) => {
    setPair((prev) => (prev.includes(id) ? prev.filter((p) => p !== id) : [...prev, id].slice(-2)));
  };

  const [e1, e2] = pair.map((id) => byId.get(id));
  const rel = e1 && e2 ? relate(e1.vc, e2.vc) : null;

  return (
    <div className="lab">
      <div className="lab-intro">
        <h2>Vector clocks &amp; causality</h2>
        <p>
          Press Play and watch nodes do internal work and exchange messages, each stamping events with
          its vector clock. Click any two events in the space-time diagram to ask the fundamental
          question of distributed systems: did one <em>happen-before</em> the other, or are they truly{' '}
          <em>concurrent</em>?
        </p>
      </div>

      <ControlBar ctrl={ctrl} seed={seed} onSeed={setSeed} />

      <div className="lab-grid">
        <div className="lab-main">
          <div className="cluster-toolbar">
            <div className="ctl-group">
              <label>Nodes</label>
              {[2, 3, 4].map((c) => (
                <button key={c} className={`btn tiny ${count === c ? 'on' : ''}`} onClick={() => setCount(c)}>
                  {c}
                </button>
              ))}
            </div>
            <div className="ctl-group">
              <label>Actor</label>
              <select value={actor} onChange={(e) => setActor(e.target.value)}>
                {ctrl.nodeOrder.map((id) => (
                  <option key={id} value={id}>
                    {id}
                  </option>
                ))}
              </select>
              <button className="btn tiny" onClick={() => ctrl.command(actor, { type: 'internal' })}>
                internal
              </button>
              {ctrl.nodeOrder
                .filter((id) => id !== actor)
                .map((id) => (
                  <button key={id} className="btn tiny" onClick={() => ctrl.command(actor, { type: 'send', to: id })}>
                    →{id}
                  </button>
                ))}
            </div>
          </div>

          <SpaceTimeDiagram events={events} nodeOrder={ctrl.nodeOrder} selected={pair} onSelect={onSelect} />

          <div className="relation-panel">
            {!e1 && <span className="muted">Click two events to compare them.</span>}
            {e1 && !e2 && (
              <span>
                selected <b>{e1.id}</b> {fmtVec(e1.vc, ctrl.nodeOrder)} — pick another
              </span>
            )}
            {e1 && e2 && rel && (
              <div className="relation-result">
                <span className="ev-tag">
                  {e1.id} {fmtVec(e1.vc, ctrl.nodeOrder)}
                </span>
                <span className={`rel-badge ${rel}`}>{REL_TEXT[rel]}</span>
                <span className="ev-tag">
                  {e2.id} {fmtVec(e2.vc, ctrl.nodeOrder)}
                </span>
              </div>
            )}
          </div>
        </div>

        <div className="lab-side">
          <InvariantPanel invariants={ctrl.invariants} title="Causality" />
          <div className="lab-aux">
            <div className="panel-head">
              <span>Current clocks</span>
            </div>
            <div className="lab-aux-body">
              {(snap?.nodes ?? []).map((n) => (
                <div key={n.id} className="replica-row">
                  <span className="replica-id">{n.id}</span>
                  <code className="replica-val">{fmtVec(n.state.vc, ctrl.nodeOrder)}</code>
                </div>
              ))}
              <div className="legend" style={{ marginTop: '0.6rem' }}>
                <span><i style={{ background: '#9aa2b1' }} /> internal</span>
                <span><i style={{ background: '#7c9cff' }} /> send</span>
                <span><i style={{ background: '#8be9c0' }} /> recv</span>
              </div>
            </div>
          </div>
        </div>
      </div>

      <Timeline log={snap?.log ?? []} />
    </div>
  );
}
