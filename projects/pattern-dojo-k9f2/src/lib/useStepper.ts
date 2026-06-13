import { useCallback, useEffect, useRef, useState } from "react";

export interface Stepper {
  i: number;
  total: number;
  playing: boolean;
  next: () => void;
  prev: () => void;
  reset: () => void;
  goto: (v: number) => void;
  play: () => void;
  stop: () => void;
}

/**
 * Drives a frame-based visualizer: current index, play/pause loop, and
 * step/scrub controls. The total number of frames is fixed per mount; callers
 * that change the underlying data should `reset()`.
 */
export function useStepper(total: number, opts?: { speed?: number }): Stepper {
  const [i, setI] = useState(0);
  const [playing, setPlaying] = useState(false);
  const speed = opts?.speed ?? 850;
  const timer = useRef<number | null>(null);
  const clampedTotal = Math.max(1, total);

  const stop = useCallback(() => {
    if (timer.current) {
      window.clearInterval(timer.current);
      timer.current = null;
    }
    setPlaying(false);
  }, []);

  const next = useCallback(() => setI((v) => Math.min(clampedTotal - 1, v + 1)), [clampedTotal]);
  const prev = useCallback(() => setI((v) => Math.max(0, v - 1)), []);
  const reset = useCallback(() => setI(0), []);
  const goto = useCallback(
    (v: number) => setI(Math.max(0, Math.min(clampedTotal - 1, v))),
    [clampedTotal],
  );

  const play = useCallback(() => {
    setI((v) => (v >= clampedTotal - 1 ? 0 : v));
    setPlaying(true);
  }, [clampedTotal]);

  useEffect(() => {
    if (!playing) return;
    timer.current = window.setInterval(() => {
      setI((v) => {
        if (v >= clampedTotal - 1) {
          if (timer.current) window.clearInterval(timer.current);
          timer.current = null;
          setPlaying(false);
          return v;
        }
        return v + 1;
      });
    }, speed);
    return () => {
      if (timer.current) window.clearInterval(timer.current);
    };
  }, [playing, clampedTotal, speed]);

  return { i: Math.min(i, clampedTotal - 1), total: clampedTotal, playing, next, prev, reset, goto, play, stop };
}
