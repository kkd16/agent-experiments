import { useEffect, useRef, useState } from "react";
import type { Stepper } from "../lib/useStepper";
import { currentPath, parseHashQuery } from "../lib/router";

interface ControlsProps {
  stepper: Stepper;
  caption?: string;
  /** enable keyboard control + shareable deep-links to the current frame */
  shareable?: boolean;
}

export function StepperControls({ stepper, caption, shareable = true }: ControlsProps) {
  const { i, total, playing, next, prev, reset, play, stop, goto } = stepper;
  const atEnd = i >= total - 1;
  const [copied, setCopied] = useState(false);
  const seeded = useRef(false);

  // Seed the initial frame from a shared link (?frame=N) once on mount.
  useEffect(() => {
    if (seeded.current || !shareable) return;
    seeded.current = true;
    const f = Number(parseHashQuery().frame);
    if (Number.isFinite(f) && f > 0) goto(f);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Keyboard shortcuts: space = play/pause, arrows = step, Home/End, r = reset.
  useEffect(() => {
    if (!shareable) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
      switch (e.key) {
        case " ":
          e.preventDefault();
          if (playing) stop();
          else play();
          break;
        case "ArrowLeft":
          e.preventDefault();
          prev();
          break;
        case "ArrowRight":
          e.preventDefault();
          next();
          break;
        case "Home":
          e.preventDefault();
          goto(0);
          break;
        case "End":
          e.preventDefault();
          goto(total - 1);
          break;
        case "r":
        case "R":
          reset();
          break;
        default:
          break;
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [playing, play, stop, prev, next, goto, reset, total, shareable]);

  const share = async () => {
    const url = `${location.origin}${location.pathname}${currentPath()}?frame=${i}`;
    try {
      await navigator.clipboard.writeText(url);
    } catch {
      try {
        location.hash = `${currentPath().slice(1)}?frame=${i}`;
      } catch {
        /* ignore */
      }
    }
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1400);
  };

  return (
    <div className="viz-controls">
      <div className="viz-buttons">
        <button className="btn sm" onClick={reset} disabled={i === 0} title="Restart (R)">
          ⟲
        </button>
        <button className="btn sm" onClick={prev} disabled={i === 0} title="Previous step (←)">
          ◀
        </button>
        {playing ? (
          <button className="btn sm primary" onClick={stop} title="Pause (Space)">
            ❚❚ Pause
          </button>
        ) : (
          <button className="btn sm primary" onClick={play} title="Play (Space)">
            ▶ Play
          </button>
        )}
        <button className="btn sm" onClick={next} disabled={atEnd} title="Next step (→)">
          ▶
        </button>
        <span className="viz-step-count">
          step {i + 1} / {total}
        </span>
        {shareable && (
          <button className="btn sm viz-share" onClick={share} title="Copy a link to this exact step">
            {copied ? "✓ Copied" : "🔗 Share step"}
          </button>
        )}
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
      {shareable && (
        <div className="viz-kbd-hint">
          <span className="kbd">Space</span> play ·{" "}
          <span className="kbd">←</span> <span className="kbd">→</span> step ·{" "}
          <span className="kbd">R</span> reset
        </div>
      )}
    </div>
  );
}
