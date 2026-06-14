import { useSRS } from "./srs";

/**
 * Backwards-compatible progress facade.
 *
 * Progress used to be a flat `Record<string, boolean>` of "learned" patterns.
 * It's now derived from the spaced-repetition store (see `srs.ts`) so the whole
 * app shares one source of truth: a pattern counts as "learned" once it has
 * graduated out of the new state. Existing call sites (`isDone`, `toggle`,
 * `count`, `reset`) keep working unchanged.
 */
export function useProgress() {
  const srs = useSRS();
  return {
    isDone: srs.isLearned,
    toggle: srs.toggleLearned,
    reset: srs.resetAll,
    count: srs.counts.learned,
  };
}
