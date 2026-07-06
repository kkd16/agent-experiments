import type { Difficulty } from "../data/types";

/**
 * The Interview Room — data model.
 *
 * A "session" is a timed, adaptive mock interview: a small set of Code Dojo
 * problems, chosen to drill your *weakest* patterns, solved against the real
 * sandbox judge under a countdown. Everything a session needs to be replayed,
 * scored and analysed later lives in these types.
 */

/** How problems are chosen for a session. */
export type FocusMode = "adaptive" | "balanced" | string; // string = a specific patternId

/** Difficulty band the session draws from. */
export type Band = "mixed" | "warmup" | "standard" | "hard";

export interface SessionConfig {
  /** deterministic seed — the same seed + config reproduces the same problem set. */
  seed: number;
  /** total time budget, minutes. */
  durationMin: number;
  /** how many problems in the session. */
  problemCount: number;
  /** difficulty band. */
  band: Band;
  /** adaptive (weakness-weighted), balanced (spread across patterns), or a patternId to focus. */
  focus: FocusMode;
  /** whether staged hints are available (using one costs you on the scorecard). */
  hintsAllowed: boolean;
}

/** Per-problem state accumulated as the candidate works. */
export interface ProblemAttempt {
  id: string;
  /** latest editor draft. */
  code: string;
  /** first time this problem was viewed, ms epoch (for time-to-solve). */
  firstViewAt?: number;
  /** ms epoch of the first accepted (all-hidden-tests-pass) submission. */
  firstPassAt?: number;
  /** best full-judge time across accepted submits, ms. */
  bestMs?: number;
  /** best pass ratio (passed / total) seen across all submissions, 0..1. */
  bestRatio: number;
  /** count of "Submit" presses. */
  submits: number;
  /** count of "Run samples" presses. */
  runs: number;
  /** how many staged hints were revealed. */
  hintsUsed: number;
  /** whether the reference solution was peeked (heavy scorecard penalty). */
  peeked: boolean;
  solved: boolean;
}

/** A live, in-progress session (persisted so a refresh never loses the timer). */
export interface LiveSession {
  id: string;
  config: SessionConfig;
  problemIds: string[];
  startedAt: number;
  /** startedAt + durationMin*60_000, cached so the countdown survives reload. */
  endsAt: number;
  /** index of the problem currently open. */
  current: number;
  attempts: Record<string, ProblemAttempt>;
  /** set once the session ends (time-up or manual finish). */
  finishedAt?: number;
  /** why it ended. */
  endReason?: "time" | "manual" | "complete";
}

/** Difficulty weight used for scoring and expected-time budgets. */
export const DIFFICULTY_WEIGHT: Record<Difficulty, number> = {
  easy: 1,
  medium: 1.6,
  hard: 2.4,
};

/** Rough "a strong candidate solves this in N minutes" budget, by difficulty. */
export const EXPECTED_MINUTES: Record<Difficulty, number> = {
  easy: 6,
  medium: 12,
  hard: 20,
};

/** Current epoch-ms. Kept in this module so components read "now" through a
 *  non-render helper (matching how the SRS/Dojo stores source their clock). */
export const now = (): number => Date.now();

export function makeAttempt(id: string, starter: string): ProblemAttempt {
  return {
    id,
    code: starter,
    bestRatio: 0,
    submits: 0,
    runs: 0,
    hintsUsed: 0,
    peeked: false,
    solved: false,
  };
}
