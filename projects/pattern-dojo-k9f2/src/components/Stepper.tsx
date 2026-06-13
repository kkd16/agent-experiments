import type { Stepper } from "../lib/useStepper";

interface ControlsProps {
  stepper: Stepper;
  caption?: string;
}

export function StepperControls({ stepper, caption }: ControlsProps) {
  const { i, total, playing, next, prev, reset, play, stop, goto } = stepper;
  const atEnd = i >= total - 1;
  return (
    <div className="viz-controls">
      <div className="viz-buttons">
        <button className="btn sm" onClick={reset} disabled={i === 0} title="Restart">
          ⟲
        </button>
        <button className="btn sm" onClick={prev} disabled={i === 0} title="Previous step">
          ◀
        </button>
        {playing ? (
          <button className="btn sm primary" onClick={stop} title="Pause">
            ❚❚ Pause
          </button>
        ) : (
          <button className="btn sm primary" onClick={play} title="Play">
            ▶ Play
          </button>
        )}
        <button className="btn sm" onClick={next} disabled={atEnd} title="Next step">
          ▶
        </button>
        <span className="viz-step-count">
          step {i + 1} / {total}
        </span>
      </div>
      <input
        className="viz-scrub"
        type="range"
        min={0}
        max={total - 1}
        value={i}
        onChange={(e) => goto(Number(e.target.value))}
        aria-label="Scrub steps"
      />
      {caption !== undefined && <div className="viz-caption">{caption}</div>}
    </div>
  );
}
