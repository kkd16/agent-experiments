import { useCallback, useMemo, useState } from 'react';
import { Kernel } from '../sim/kernel';
import { createCrdtProtocol, crdtSpec, type CrdtNodeState } from '../protocols/crdt/crdt';
import { CRDT_ORDER, type CrdtKind, type CrdtOp } from '../protocols/crdt/crdts';
import { useSimulation } from '../lib/useSimulation';
import { NetworkCanvas, type NodeVisual } from '../ui/NetworkCanvas';
import { ControlBar } from '../ui/ControlBar';
import { InvariantPanel } from '../ui/InvariantPanel';
import { Timeline } from '../ui/Timeline';
import { MetricsBar } from '../ui/MetricsBar';
import { nodeColor } from '../lib/format';
import type { NodeRuntime } from '../sim/types';

const NAMES = ['A', 'B', 'C', 'D', 'E'];

export function CrdtLab() {
  const [seed, setSeed] = useState(7);
  const [count, setCount] = useState(4);
  const [kind, setKind] = useState<CrdtKind>('gcounter');
  const [selected, setSelected] = useState<string>('A');
  const [arg, setArg] = useState('x');

  const nodeIds = useMemo(() => NAMES.slice(0, count), [count]);
  const spec = useMemo(() => crdtSpec(kind), [kind]);

  const makeKernel = useCallback(() => {
    return new Kernel<CrdtNodeState, CrdtOp>({
      seed,
      protocol: createCrdtProtocol(kind),
      nodeIds,
      network: { minLatency: 30, maxLatency: 90, dropRate: 0 },
    });
  }, [seed, nodeIds, kind]);

  const ctrl = useSimulation(makeKernel);
  const snap = ctrl.snapshot;

  const sel = snap?.nodes.find((n) => n.id === selected);
  const values = (snap?.nodes ?? []).map((n) => spec.value(n.state.data));
  const allEqual = values.length > 0 && values.every((v) => v === values[0]);

  const visual = useCallback(
    (node: NodeRuntime<CrdtNodeState>, i: number): NodeVisual => {
      const v = spec.value(node.state.data);
      const short = v.length > 9 ? v.slice(0, 8) + '…' : v;
      return {
        fill: nodeColor(i),
        ring: 'rgba(255,255,255,0.25)',
        label: node.id,
        sub: short,
        down: !node.up,
      };
    },
    [spec],
  );

  const runOp = (op: CrdtOp) => {
    if (!selected) return;
    ctrl.command(selected, op);
  };

  const splitPartition = () => {
    const half = Math.ceil(ctrl.nodeOrder.length / 2);
    ctrl.partition([ctrl.nodeOrder.slice(0, half), ctrl.nodeOrder.slice(half)]);
  };

  return (
    <div className="lab">
      <div className="lab-intro">
        <h2>CRDTs · convergent replicated data types</h2>
        <p>
          Every node holds a replica and runs anti-entropy. Edit any replica, partition the network so
          edits happen <em>concurrently</em> on both sides, then heal it — and watch every replica
          converge to exactly the same value. That is strong eventual consistency, with no consensus
          and no coordinator.
        </p>
      </div>

      <ControlBar
        ctrl={ctrl}
        seed={seed}
        onSeed={setSeed}
        right={
          <span className={`leader-pill ${allEqual ? 'has' : 'none'}`}>
            {allEqual ? 'converged' : 'diverged'}
          </span>
        }
      />

      <div className="lab-grid">
        <div className="lab-main">
          <div className="cluster-toolbar">
            <div className="ctl-group">
              <label>Type</label>
              {CRDT_ORDER.map((k) => (
                <button key={k} className={`btn tiny ${kind === k ? 'on' : ''}`} onClick={() => setKind(k)}>
                  {crdtSpec(k).title}
                </button>
              ))}
            </div>
            <div className="ctl-group">
              <label>Replicas</label>
              {[3, 4, 5].map((c) => (
                <button key={c} className={`btn tiny ${count === c ? 'on' : ''}`} onClick={() => setCount(c)}>
                  {c}
                </button>
              ))}
            </div>
          </div>

          <div className="crdt-blurb">{spec.blurb}</div>

          {snap && (
            <NetworkCanvas
              snapshot={snap}
              nodeOrder={ctrl.nodeOrder}
              visual={visual}
              selected={selected}
              onSelect={setSelected}
              onToggleLink={(a, b) => ctrl.toggleLink(a, b)}
              messageColor={() => '#8be9c0'}
              height={380}
            />
          )}

          <div className="action-row">
            <span className="op-target">apply to <b>{selected}</b>:</span>
            {spec.ops.map((op) => (
              <button key={op.id} className="btn" onClick={() => runOp({ id: op.id, arg: coerce(op.arg, arg) })}>
                {op.label}
              </button>
            ))}
            {spec.ops.some((o) => o.arg !== 'none') && (
              <input
                type="text"
                value={arg}
                onChange={(e) => setArg(e.target.value)}
                style={{ width: 70 }}
                placeholder="arg"
              />
            )}
          </div>
          <div className="action-row">
            <button className="btn" onClick={splitPartition}>
              ⌥ Partition
            </button>
            <button className="btn" onClick={ctrl.heal}>
              ⟲ Heal net
            </button>
            {sel && (
              <button
                className={`btn ${sel.up ? 'danger' : 'good'}`}
                onClick={() => (sel.up ? ctrl.crash(selected) : ctrl.restart(selected))}
              >
                {sel.up ? `✕ Crash ${selected}` : `⏼ Restart ${selected}`}
              </button>
            )}
          </div>

          {snap && <MetricsBar metrics={snap.metrics} />}
        </div>

        <div className="lab-side">
          <InvariantPanel invariants={ctrl.invariants} title="Convergence" />
          <div className="lab-aux">
            <div className="panel-head">
              <span>Replica values</span>
            </div>
            <div className="lab-aux-body">
              {(snap?.nodes ?? []).map((n) => (
                <div key={n.id} className="replica-row">
                  <span className="replica-id" style={{ color: nodeColor(ctrl.nodeOrder.indexOf(n.id)) }}>
                    {n.id}
                    {n.up ? '' : ' ✕'}
                  </span>
                  <code className="replica-val">{spec.value(n.state.data)}</code>
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

function coerce(kind: 'none' | 'elem' | 'value' | 'index', arg: string): string | number | undefined {
  if (kind === 'none') return undefined;
  if (kind === 'index') return Number(arg) || 0;
  return arg;
}
