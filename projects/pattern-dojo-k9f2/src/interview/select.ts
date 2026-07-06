import type { Challenge } from "../dojo/types";
import type { Difficulty } from "../data/types";
import type { Mastery } from "../lib/srs";
import { challenges } from "../dojo/challenges";
import type { Band, FocusMode, SessionConfig } from "./types";

/**
 * Deterministic, weakness-weighted problem selection for the Interview Room.
 *
 * Given a seed and a config, this picks a reproducible set of Code Dojo
 * problems. In *adaptive* mode it leans on the spaced-repetition mastery of
 * each pattern and your Dojo solve history so a session drills what you're
 * worst at — while still spreading across distinct patterns like a real
 * interview loop. Pure and seedable, so the same session can be replayed.
 */

/** A small, fast, well-distributed seeded PRNG (mulberry32). */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A stable 32-bit hash of a string — used to derive a shareable numeric seed. */
export function hashSeed(s: string): number {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

export interface SelectionContext {
  masteryOf: (patternId: string) => Mastery;
  isSolved: (challengeId: string) => boolean;
}

/** Which difficulties a band admits, and a per-difficulty preference multiplier. */
const BAND_PREF: Record<Band, Partial<Record<Difficulty, number>>> = {
  mixed: { easy: 1, medium: 1, hard: 1 },
  warmup: { easy: 1.6, medium: 0.7 },
  standard: { easy: 0.5, medium: 1.4, hard: 0.9 },
  hard: { medium: 0.7, hard: 1.8 },
};

/** How much weight to give a pattern by how shaky it is. Higher = more likely. */
const MASTERY_WEIGHT: Record<Mastery, number> = {
  new: 4.2,
  learning: 3.2,
  young: 2.0,
  mastered: 0.9,
};

function baseWeight(ch: Challenge, cfg: SessionConfig, ctx: SelectionContext): number {
  const pref = BAND_PREF[cfg.band][ch.difficulty];
  if (pref === undefined) return 0; // difficulty excluded by the band

  let w = pref;
  if (cfg.focus === "adaptive") {
    w *= MASTERY_WEIGHT[ctx.masteryOf(ch.patternId)];
    // Unsolved problems are worth more practice than ones you've already cracked.
    w *= ctx.isSolved(ch.id) ? 0.7 : 1.6;
  } else if (cfg.focus === "balanced") {
    // Spread evenly; only a light nudge toward things you haven't solved.
    w *= ctx.isSolved(ch.id) ? 0.85 : 1.15;
  }
  return w;
}

/** Filter to the challenge pool a config is allowed to draw from. */
function pool(cfg: SessionConfig): Challenge[] {
  const isPattern = cfg.focus !== "adaptive" && cfg.focus !== "balanced";
  return challenges.filter((ch) => {
    if (isPattern && ch.patternId !== (cfg.focus as string)) return false;
    return BAND_PREF[cfg.band][ch.difficulty] !== undefined;
  });
}

/**
 * Pick `problemCount` challenge ids for a session. Weighted-random without
 * replacement, with a strong diversity penalty so we rarely pick two problems
 * from the same pattern (unless a single pattern is the focus).
 */
export function selectProblems(cfg: SessionConfig, ctx: SelectionContext): string[] {
  const isPattern = cfg.focus !== "adaptive" && cfg.focus !== "balanced";
  const candidates = pool(cfg);
  const rand = rng(cfg.seed || 1);

  const remaining = candidates.map((ch) => ({ ch, w: Math.max(0.001, baseWeight(ch, cfg, ctx)) }));
  const usedPatterns = new Set<string>();
  const chosen: string[] = [];
  const want = Math.min(cfg.problemCount, remaining.length);

  while (chosen.length < want && remaining.length > 0) {
    // Effective weights: penalise a pattern we've already drawn (unless focused).
    const weights = remaining.map((r) =>
      !isPattern && usedPatterns.has(r.ch.patternId) ? r.w * 0.08 : r.w,
    );
    const total = weights.reduce((s, x) => s + x, 0);
    let t = rand() * total;
    let idx = 0;
    for (; idx < weights.length; idx++) {
      t -= weights[idx];
      if (t <= 0) break;
    }
    if (idx >= remaining.length) idx = remaining.length - 1;
    const [pick] = remaining.splice(idx, 1);
    chosen.push(pick.ch.id);
    usedPatterns.add(pick.ch.patternId);
  }

  // Present in a sensible order: easiest first, so the session ramps up.
  const rank: Record<Difficulty, number> = { easy: 0, medium: 1, hard: 2 };
  chosen.sort((a, b) => {
    const ca = challenges.find((c) => c.id === a)!;
    const cb = challenges.find((c) => c.id === b)!;
    return rank[ca.difficulty] - rank[cb.difficulty];
  });
  return chosen;
}

/** How many distinct patterns a focus/band can actually supply, for UI guards. */
export function poolSize(focus: FocusMode, band: Band): number {
  return pool({ seed: 1, durationMin: 1, problemCount: 99, band, focus, hintsAllowed: true }).length;
}
