type Props = {
  running: boolean;
  speed: number;
  onToggle: () => void;
  onStep: () => void;
  onReset: () => void;
  onExport: () => void;
  onSpeed: (v: number) => void;
};

// speed is exposed on a perceptual (log) slider: slider 0..100 -> 1..512 steps/frame
const SLIDER_MAX = 100;
const sliderToSpeed = (v: number) => Math.round(2 ** ((v / SLIDER_MAX) * 9)); // 1..512
const speedToSlider = (s: number) => Math.round((Math.log2(Math.max(1, s)) / 9) * SLIDER_MAX);

export default function Transport({ running, speed, onToggle, onStep, onReset, onExport, onSpeed }: Props) {
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
        <button className="btn" onClick={onExport} title="E">
          ⤓ PNG
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
