import { useState } from 'react';

type Props = {
  running: boolean;
  speed: number;
  recording: boolean;
  canRecord: boolean;
  onToggle: () => void;
  onStep: () => void;
  onReset: () => void;
  onExport: () => void;
  onExportJson: () => void;
  onRecord: () => void;
  onShare: () => Promise<boolean>;
  onSpeed: (v: number) => void;
};

// speed is exposed on a perceptual (log) slider: slider 0..100 -> 1..512 steps/frame
const SLIDER_MAX = 100;
const sliderToSpeed = (v: number) => Math.round(2 ** ((v / SLIDER_MAX) * 9)); // 1..512
const speedToSlider = (s: number) => Math.round((Math.log2(Math.max(1, s)) / 9) * SLIDER_MAX);

export default function Transport({ running, speed, recording, canRecord, onToggle, onStep, onReset, onExport, onExportJson, onRecord, onShare, onSpeed }: Props) {
  const [copied, setCopied] = useState(false);
  const share = async () => {
    const ok = await onShare();
    if (ok) {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1400);
    }
  };
  return (
    <section className="panel transport">
      <div className="transport-row">
        <button className="btn btn-primary" onClick={onToggle} title="Space">
          {running ? '❚❚ Pause' : '▶ Play'}
        </button>
        <button className="btn" onClick={onStep} disabled={running} title="S">
          ⤳ Step
        </button>
        <button className="btn" onClick={onReset} title="R">
          ↺ Reset
        </button>
        <button className="btn" onClick={onExport} title="Download a PNG (E)">
          ⤓ PNG
        </button>
        <button className="btn" onClick={onExportJson} title="Download the run as JSON (tiles, rules, tiling)">
          {'{ }'} JSON
        </button>
        {canRecord && (
          <button className={`btn ${recording ? 'recording' : ''}`} onClick={onRecord} title="Record the collapse as WebM">
            {recording ? '■ Stop' : '⏺ Rec'}
          </button>
        )}
        <button className="btn" onClick={share} title="Copy a shareable link">
          {copied ? '✓ Copied' : '🔗 Link'}
        </button>
      </div>
      <label className="field">
        <span className="field-label">
          speed <em>{speed} steps / frame</em>
        </span>
        <input
          type="range"
          min={0}
          max={SLIDER_MAX}
          value={speedToSlider(speed)}
          onChange={(e) => onSpeed(sliderToSpeed(Number(e.target.value)))}
        />
      </label>
    </section>
  );
}
