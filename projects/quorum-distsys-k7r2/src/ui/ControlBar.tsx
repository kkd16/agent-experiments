// The shared transport: play/pause, single-step (one event), reset, a speed
// dial, the seed, and the time-travel scrubber over the recorded history.
import type { ReactNode } from 'react';
import type { SimController } from '../lib/useSimulation';
import { fmtTime } from '../lib/format';

const SPEEDS = [0.25, 0.5, 1, 2, 4, 8];

interface Props<S, Cmd> {
  ctrl: SimController<S, Cmd>;
  seed: number;
  onSeed: (seed: number) => void;
  right?: ReactNode;
}

export function ControlBar<S, Cmd>({ ctrl, seed, onSeed, right }: Props<S, Cmd>) {
  const time = ctrl.snapshot?.time ?? 0;
  return (
    <div className="controlbar">
      <div className="controlbar-row">
        <button className="btn primary" onClick={ctrl.toggle}>
          {ctrl.playing ? '❚❚ Pause' : '▶ Play'}
        </button>
        <button className="btn" onClick={ctrl.stepEvent} title="Process one event">
          ⏭ Step
        </button>
        <button className="btn" onClick={ctrl.reset} title="Restart this scenario">
          ↺ Reset
        </button>

        <div className="ctl-group">
          <label>Speed</label>
          <select value={ctrl.speed} onChange={(e) => ctrl.setSpeed(Number(e.target.value))}>
            {SPEEDS.map((s) => (
              <option key={s} value={s}>
                {s}×
              </option>
            ))}
          </select>
        </div>

        <div className="ctl-group">
          <label>Seed</label>
          <input
            type="number"
            className="seed-input"
            value={seed}
            onChange={(e) => onSeed(Number(e.target.value) || 0)}
          />
          <button className="btn tiny" onClick={() => onSeed(Math.floor((seed * 1103515245 + 12345) % 2147483647))}>
            🎲
          </button>
        </div>

        <div className="ctl-spacer" />
        <div className="clock">t = {fmtTime(time)}</div>
        {right}
      </div>

      <div className="controlbar-row scrub-row">
        <span className="scrub-label">{ctrl.atHead ? 'live' : 'history'}</span>
        <input
          type="range"
          className="scrub"
          min={0}
          max={Math.max(0, ctrl.historyLength - 1)}
          value={ctrl.cursor}
          onChange={(e) => ctrl.scrub(Number(e.target.value))}
        />
        <span className="scrub-count">
          {ctrl.cursor + 1}/{ctrl.historyLength}
        </span>
      </div>
    </div>
  );
}
