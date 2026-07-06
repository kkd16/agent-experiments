import { challengeById } from "../dojo/challenges";
import type { Difficulty } from "../data/types";
import { DIFFICULTY_WEIGHT, EXPECTED_MINUTES } from "./types";
import type { LiveSession, ProblemAttempt } from "./types";

/**
 * The Interview Room scorer.
 *
 * Turns a finished (or in-progress) session into a *readiness* report: a
 * per-problem 0–100 score that rewards correctness first, then speed relative
 * to a difficulty-appropriate budget, and docks you for leaning on hints or
 * peeking the answer. The session score is a difficulty-weighted blend (a hard
 * problem counts more than an easy one), turned into a letter grade with plain-
 * language, personalised feedback and a list of patterns worth drilling next.
 */

export interface ProblemScore {
  id: string;
  title: string;
  patternId: string;
  patternName: string;
  difficulty: Difficulty;
  solved: boolean;
  /** 0..100 */
  score: number;
  /** minutes from first view to first accepted submit, if solved. */
  solveMin: number | null;
  /** minutes budgeted for a strong candidate. */
  budgetMin: number;
  hintsUsed: number;
  peeked: boolean;
  bestRatio: number;
  submits: number;
  /** one-line qualitative note. */
  note: string;
}

export interface Report {
  sessionId: string;
  overall: number; // 0..100
  grade: string; // A / B / C / D / —
  gradeLabel: string;
  solved: number;
  total: number;
  totalHints: number;
  peeks: number;
  /** minutes actually spent (finish − start), capped at the budget. */
  elapsedMin: number;
  budgetMin: number;
  avgSolveMin: number | null;
  fastest: ProblemScore | null;
  problems: ProblemScore[];
  feedback: string[];
  /** patternIds worth drilling, most-important first. */
  drill: { patternId: string; patternName: string; reason: string }[];
}

function clamp(x: number, lo = 0, hi = 100): number {
  return Math.max(lo, Math.min(hi, x));
}

function solveMinutes(a: ProblemAttempt, session: LiveSession): number | null {
  if (!a.solved || a.firstPassAt === undefined) return null;
  const from = a.firstViewAt ?? session.startedAt;
  const ms = a.firstPassAt - from;
  return ms > 0 ? ms / 60000 : 0.1;
}

function scoreProblem(a: ProblemAttempt, session: LiveSession): ProblemScore {
  const ch = challengeById(a.id);
  const difficulty: Difficulty = ch?.difficulty ?? "medium";
  const budgetMin = EXPECTED_MINUTES[difficulty];
  const patternId = ch?.patternId ?? "";
  const solveMin = solveMinutes(a, session);

  let score: number;
  let note: string;

  if (a.solved) {
    let s = 62;
    // Speed: full credit at ≤40% of budget, zero extra past 150% of budget.
    if (solveMin !== null) {
      const fast = budgetMin * 0.4;
      const slow = budgetMin * 1.5;
      const speed = clamp((slow - solveMin) / (slow - fast), 0, 1);
      s += speed * 28;
    } else {
      s += 14;
    }
    s -= a.hintsUsed * 7;
    if (a.peeked) s = Math.min(s, 46) - 12;
    score = clamp(s, a.peeked ? 20 : 34, 100);
    if (a.peeked) note = "Solved, but after revealing the reference — revisit this one unaided.";
    else if (a.hintsUsed === 0 && solveMin !== null && solveMin <= budgetMin * 0.6)
      note = "Clean solve, comfortably inside the time budget. 💪";
    else if (a.hintsUsed === 0) note = "Solved unaided.";
    else note = `Solved with ${a.hintsUsed} hint${a.hintsUsed === 1 ? "" : "s"}.`;
  } else {
    // Partial credit for how close the best submission got.
    let s = a.bestRatio * 40;
    if (a.peeked) s = Math.max(s, 8);
    s -= a.hintsUsed * 2;
    score = clamp(s, 0, 45);
    if (a.submits === 0 && a.runs === 0) note = "Not attempted.";
    else if (a.bestRatio >= 0.75) note = `So close — ${Math.round(a.bestRatio * 100)}% of tests passed.`;
    else if (a.bestRatio > 0) note = `Partial — best run passed ${Math.round(a.bestRatio * 100)}% of tests.`;
    else note = "Attempted but no tests passing yet.";
  }

  return {
    id: a.id,
    title: ch?.title ?? a.id,
    patternId,
    patternName: patternId,
    difficulty,
    solved: a.solved,
    score: Math.round(score),
    solveMin: solveMin === null ? null : Math.round(solveMin * 10) / 10,
    budgetMin,
    hintsUsed: a.hintsUsed,
    peeked: a.peeked,
    bestRatio: a.bestRatio,
    submits: a.submits,
    note,
  };
}

const GRADES: { min: number; grade: string; label: string }[] = [
  { min: 90, grade: "A", label: "Interview-ready" },
  { min: 78, grade: "B", label: "Strong — a few rough edges" },
  { min: 64, grade: "C", label: "Getting there" },
  { min: 48, grade: "D", label: "Keep drilling" },
  { min: 0, grade: "—", label: "Early days — this is how you build the muscle" },
];

function gradeFor(overall: number): { grade: string; label: string } {
  const g = GRADES.find((x) => overall >= x.min)!;
  return { grade: g.grade, label: g.label };
}

/**
 * Score a session. `patternNameOf` maps a patternId to its display name (kept
 * as an argument so this module doesn't depend on the pattern catalogue).
 */
export function scoreSession(
  session: LiveSession,
  patternNameOf: (id: string) => string,
): Report {
  const problems = session.problemIds
    .map((id) => session.attempts[id])
    .filter((a): a is ProblemAttempt => !!a)
    .map((a) => {
      const ps = scoreProblem(a, session);
      ps.patternName = patternNameOf(ps.patternId) || ps.patternId;
      return ps;
    });

  const total = problems.length;
  const solved = problems.filter((p) => p.solved).length;
  const totalHints = problems.reduce((s, p) => s + p.hintsUsed, 0);
  const peeks = problems.filter((p) => p.peeked).length;

  // Difficulty-weighted mean.
  const wSum = problems.reduce((s, p) => s + DIFFICULTY_WEIGHT[p.difficulty], 0) || 1;
  const overall = Math.round(
    problems.reduce((s, p) => s + p.score * DIFFICULTY_WEIGHT[p.difficulty], 0) / wSum,
  );

  const solvedTimes = problems.filter((p) => p.solveMin !== null).map((p) => p.solveMin as number);
  const avgSolveMin = solvedTimes.length
    ? Math.round((solvedTimes.reduce((s, x) => s + x, 0) / solvedTimes.length) * 10) / 10
    : null;
  const fastest = problems
    .filter((p) => p.solved && p.solveMin !== null)
    .sort((a, b) => (a.solveMin as number) - (b.solveMin as number))[0] ?? null;

  const budgetMin = session.config.durationMin;
  const endTs = session.finishedAt ?? Date.now();
  const elapsedMin = Math.min(budgetMin, Math.max(0, Math.round(((endTs - session.startedAt) / 60000) * 10) / 10));

  const { grade, label } = gradeFor(overall);

  return {
    sessionId: session.id,
    overall,
    grade,
    gradeLabel: label,
    solved,
    total,
    totalHints,
    peeks,
    elapsedMin,
    budgetMin,
    avgSolveMin,
    fastest,
    problems,
    feedback: buildFeedback({ overall, solved, total, totalHints, peeks, problems, avgSolveMin }),
    drill: buildDrill(problems),
  };
}

function buildFeedback(x: {
  overall: number;
  solved: number;
  total: number;
  totalHints: number;
  peeks: number;
  problems: ProblemScore[];
  avgSolveMin: number | null;
}): string[] {
  const out: string[] = [];
  const { solved, total } = x;

  if (solved === total && total > 0) {
    out.push(`You solved all ${total} problems${x.totalHints === 0 && x.peeks === 0 ? " unaided — that's the real thing." : "."}`);
  } else if (solved === 0) {
    out.push(`No full solves this round. That's information, not failure — the report below shows exactly where each attempt stalled.`);
  } else {
    out.push(`You solved ${solved} of ${total}. Momentum beats perfection — bank the wins and target the misses.`);
  }

  const cleanFast = x.problems.filter((p) => p.solved && p.hintsUsed === 0 && p.solveMin !== null && p.solveMin <= p.budgetMin * 0.6);
  if (cleanFast.length) {
    out.push(`Fast, hint-free solves on ${cleanFast.map((p) => p.patternName).join(", ")} — those patterns are locked in.`);
  }

  if (x.peeks > 0) {
    out.push(`You revealed the reference on ${x.peeks} problem${x.peeks === 1 ? "" : "s"}. Re-run those from scratch tomorrow; recall is where the learning sticks.`);
  } else if (x.totalHints >= 3) {
    out.push(`${x.totalHints} hints across the session. Try to sit with the problem 60s longer before the next nudge — that struggle is what interviews test.`);
  }

  const slow = x.problems.filter((p) => p.solved && p.solveMin !== null && (p.solveMin as number) > p.budgetMin * 1.2);
  if (slow.length) {
    out.push(`Correct but over budget on ${slow.map((p) => p.patternName).join(", ")} — you know the pattern, now build the speed with repeated reps.`);
  }

  if (x.overall >= 90) out.push("At this level, keep sessions rare and hard to stay sharp — and mix in patterns you haven't seen in a while.");
  else if (x.overall >= 64) out.push("Run one of these every couple of days; the adaptive selector will keep steering you toward the weak spots.");
  else out.push("Do the recommended drills below, then come back for a fresh session — you'll feel the difference within a week.");

  return out;
}

function buildDrill(problems: ProblemScore[]): Report["drill"] {
  const scored = problems
    .map((p) => {
      let priority = 100 - p.score;
      if (!p.solved) priority += 30;
      if (p.peeked) priority += 20;
      priority += p.hintsUsed * 6;
      let reason: string;
      if (!p.solved) reason = "unsolved this session";
      else if (p.peeked) reason = "solved only after peeking";
      else if (p.hintsUsed > 0) reason = `needed ${p.hintsUsed} hint${p.hintsUsed === 1 ? "" : "s"}`;
      else reason = "solved slowly — build speed";
      return { patternId: p.patternId, patternName: p.patternName, priority, reason, weak: !p.solved || p.peeked || p.hintsUsed > 0 || p.score < 78 };
    })
    .filter((d) => d.weak && d.patternId)
    .sort((a, b) => b.priority - a.priority);

  // De-dupe by pattern, keep the highest-priority reason.
  const seen = new Set<string>();
  const out: Report["drill"] = [];
  for (const d of scored) {
    if (seen.has(d.patternId)) continue;
    seen.add(d.patternId);
    out.push({ patternId: d.patternId, patternName: d.patternName, reason: d.reason });
  }
  return out.slice(0, 4);
}
