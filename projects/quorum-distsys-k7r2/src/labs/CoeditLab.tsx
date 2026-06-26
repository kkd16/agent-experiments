import { useCallback, useMemo, useState } from 'react';
import { Kernel } from '../sim/kernel';
import {
  createCoedit,
  docText,
  visibleCells,
  type CoeditOp,
  type CoeditState,
  type RgaCell,
} from '../protocols/coedit/coedit';
import { useSimulation } from '../lib/useSimulation';
import { NetworkCanvas, type NodeVisual } from '../ui/NetworkCanvas';
import { ControlBar } from '../ui/ControlBar';
import { InvariantPanel } from '../ui/InvariantPanel';
import { Timeline } from '../ui/Timeline';
import { MetricsBar } from '../ui/MetricsBar';
import { nodeColor } from '../lib/format';
import type { NodeRuntime } from '../sim/types';

const NAMES = ['A', 'B', 'C', 'D'];
const authorOf = (cell: RgaCell) => cell.id.split(':')[1] ?? '?';

export function CoeditLab() {
  const [seed, setSeed] = useState(7);
  const [count, setCount] = useState(3);
  const [focusId, setFocusId] = useState('A');
  const [carets, setCarets] = useState<Record<string, number>>({});

  const nodeIds = useMemo(() => NAMES.slice(0, count), [count]);
  const colorOf = useCallback((id: string) => nodeColor(NAMES.indexOf(id)), []);

  const makeKernel = useCallback(
    () =>
      new Kernel<CoeditState, CoeditOp>({
        seed,
        protocol: createCoedit(),
        nodeIds,
        network: { minLatency: 40, maxLatency: 120, dropRate: 0 },
      }),
    [seed, nodeIds],
  );

  const ctrl = useSimulation(makeKernel);
  const snap = ctrl.snapshot;

  const texts = (snap?.nodes ?? []).map((n) => docText(n.state.doc));
  const converged = texts.length > 0 && texts.every((t) => t === texts[0]);

  const visual = useCallback(
    (node: NodeRuntime<CoeditState>, i: number): NodeVisual => {
      const len = visibleCells(node.state.doc).length;
      return {
        fill: nodeColor(i),
        ring: 'rgba(255,255,255,0.25)',
        label: node.id,
        sub: `${len} ch`,
        glow: node.id === focusId,
        down: !node.up,
      };
    },
    [focusId],
  );

  const caretOf = (id: string, len: number) => Math.max(0, Math.min(carets[id] ?? len, len));
  const setCaret = (id: string, n: number) => setCarets((c) => ({ ...c, [id]: n }));

  const onKey = (id: string, e: React.KeyboardEvent) => {
    if (e.metaKey || e.ctrlKey || e.altKey) return; // let browser shortcuts through
    e.stopPropagation(); // keep keystrokes out of the global play/scrub shortcuts
    const node = snap?.nodes.find((n) => n.id === id);
    if (!node) return;
    const len = visibleCells(node.state.doc).length;
    const caret = caretOf(id, len);
    if (e.key.length === 1) {
      e.preventDefault();
      ctrl.command(id, { t: 'ins', index: caret, ch: e.key });
      setCaret(id, caret + 1);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      ctrl.command(id, { t: 'ins', index: caret, ch: '\n' });
      setCaret(id, caret + 1);
    } else if (e.key === 'Backspace') {
      e.preventDefault();
      if (caret > 0) {
        ctrl.command(id, { t: 'del', index: caret - 1 });
        setCaret(id, caret - 1);
      }
    } else if (e.key === 'ArrowLeft') {
      e.preventDefault();
      setCaret(id, Math.max(0, caret - 1));
    } else if (e.key === 'ArrowRight') {
      e.preventDefault();
      setCaret(id, Math.min(len, caret + 1));
    } else if (e.key === 'Home') {
      e.preventDefault();
      setCaret(id, 0);
    } else if (e.key === 'End') {
      e.preventDefault();
      setCaret(id, len);
    }
  };

  // Append a whole string to a replica in one shot (used by the demos).
  const typeInto = (id: string, str: string) => {
    ctrl.act((k) => {
      const node = k.views().find((v) => v.id === id);
      if (!node) return;
      let base = visibleCells(node.state.doc).length;
      for (const ch of str) k.command(id, { t: 'ins', index: base++, ch });
    });
    setFocusId(id);
  };

  const concurrentDemo = () => {
    // Seed a shared sentence, let it replicate, then split the network and have two
    // replicas edit the SAME region concurrently before healing.
    ctrl.reset();
    const a = ctrl.nodeOrder[0];
    const b = ctrl.nodeOrder[1] ?? a;
    typeInto(a, 'the quick fox');
    ctrl.act((k) => k.advance(1500)); // replicate everywhere
    ctrl.partition([[a], ctrl.nodeOrder.slice(1)]);
    typeInto(a, ' [A:jumps]');
    typeInto(b, ' [B:runs]');
  };

  const splitPartition = () => {
    const half = Math.ceil(ctrl.nodeOrder.length / 2);
    ctrl.partition([ctrl.nodeOrder.slice(0, half), ctrl.nodeOrder.slice(half)]);
  };

  return (
    <div className="lab">
      <div className="lab-intro">
        <h2>Collaborative text · live on an RGA</h2>
        <p>
          A real multi-replica text editor with no server. Click a replica and type into it — each
          keystroke is an insert/delete on a <strong>Replicated Growable Array</strong> (the sequence
          CRDT behind Yjs / Automerge) that syncs to the others. Partition the network, type into both
          sides <em>concurrently</em>, then heal — every replica converges to the exact same document,
          character for character. Each character is tinted by the replica that typed it.
        </p>
      </div>

      <ControlBar
        ctrl={ctrl}
        seed={seed}
        onSeed={setSeed}
        right={<span className={`leader-pill ${converged ? 'has' : 'none'}`}>{converged ? 'converged' : 'diverging…'}</span>}
      />

      <div className="lab-grid">
        <div className="lab-main">
          <div className="cluster-toolbar">
            <div className="ctl-group">
              <label>Replicas</label>
              {[2, 3, 4].map((c) => (
                <button key={c} className={`btn tiny ${count === c ? 'on' : ''}`} onClick={() => setCount(c)}>
                  {c}
                </button>
              ))}
            </div>
            <div className="ctl-group">
              <label>Demo</label>
              <button className="btn tiny" onClick={concurrentDemo} title="Seed text, split the net, edit both sides">
                ⑂ concurrent edit
              </button>
            </div>
          </div>

          <div className="editor-grid">
            {(snap?.nodes ?? []).map((n) => {
              const cells = visibleCells(n.state.doc);
              const caret = caretOf(n.id, cells.length);
              return (
                <div
                  key={n.id}
                  className={`editor-pane ${n.id === focusId ? 'focused' : ''} ${n.up ? '' : 'down'}`}
                  style={{ borderColor: colorOf(n.id) }}
                  tabIndex={0}
                  onFocus={() => setFocusId(n.id)}
                  onKeyDown={(e) => onKey(n.id, e)}
                  onClick={() => setFocusId(n.id)}
                >
                  <div className="editor-head">
                    <span className="editor-id" style={{ color: colorOf(n.id) }}>
                      replica {n.id}
                    </span>
                    <span className="editor-meta">
                      {n.up ? `${cells.length} ch` : 'down'}
                      {ctrl.atHead && n.id === focusId ? ' · typing' : ''}
                    </span>
                  </div>
                  <div className="editor-text">
                    {cells.length === 0 && caret === 0 && <span className="editor-caret" />}
                    {cells.map((c, i) => (
                      <span key={c.id}>
                        {i === caret && n.id === focusId && <span className="editor-caret" />}
                        <span
                          className={c.ch === '\n' ? 'editor-nl' : ''}
                          style={{ color: colorOf(authorOf(c)) }}
                        >
                          {c.ch === '\n' ? '\n' : c.ch}
                        </span>
                      </span>
                    ))}
                    {caret >= cells.length && cells.length > 0 && n.id === focusId && <span className="editor-caret" />}
                  </div>
                </div>
              );
            })}
          </div>

          <div className="action-row">
            <button className="btn" onClick={() => typeInto(focusId, 'hello ')}>
              ⌨ Type “hello” into {focusId}
            </button>
            <button className="btn" onClick={splitPartition}>
              ⌥ Partition
            </button>
            <button className="btn" onClick={ctrl.heal}>
              ⟲ Heal net
            </button>
            {(() => {
              const sel = snap?.nodes.find((n) => n.id === focusId);
              return sel ? (
                <button
                  className={`btn ${sel.up ? 'danger' : 'good'}`}
                  onClick={() => (sel.up ? ctrl.crash(focusId) : ctrl.restart(focusId))}
                >
                  {sel.up ? `✕ Crash ${focusId}` : `⏼ Restart ${focusId}`}
                </button>
              ) : null;
            })()}
          </div>

          {snap && (
            <NetworkCanvas
              snapshot={snap}
              nodeOrder={ctrl.nodeOrder}
              visual={visual}
              selected={focusId}
              onSelect={setFocusId}
              onToggleLink={(a, b) => ctrl.toggleLink(a, b)}
              messageColor={() => '#8be9c0'}
              height={260}
            />
          )}

          {snap && <MetricsBar metrics={snap.metrics} />}
        </div>

        <div className="lab-side">
          <InvariantPanel invariants={ctrl.invariants} title="Convergence" />
          <div className="lab-aux">
            <div className="panel-head">
              <span>Documents</span>
            </div>
            <div className="lab-aux-body">
              {(snap?.nodes ?? []).map((n) => (
                <div key={n.id} className="replica-row">
                  <span className="replica-id" style={{ color: colorOf(n.id) }}>
                    {n.id}
                    {n.up ? '' : ' ✕'}
                  </span>
                  <code className="replica-val">{JSON.stringify(docText(n.state.doc))}</code>
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
