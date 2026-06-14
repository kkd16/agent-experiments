import { useMemo, useState } from "react";
import { quiz } from "../data/quiz";
import type { QuizQuestion } from "../data/quiz";
import { patterns, patternById } from "../data/patterns";
import { href } from "../lib/router";
import { useStreak } from "../lib/streak";
import { useSRS } from "../lib/srs";
import type { Mastery } from "../lib/srs";

function shuffle<T>(arr: T[]): T[] {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// build 4 answer choices: the correct one + 3 distractors
function choicesFor(answer: string): string[] {
  const others = shuffle(patterns.map((p) => p.id).filter((id) => id !== answer)).slice(0, 3);
  return shuffle([answer, ...others]);
}

/** Weight a question by how much its pattern still needs practice. */
const MASTERY_WEIGHT: Record<Mastery, number> = { new: 4, learning: 3, young: 2, mastered: 1 };

/** Adaptively pick `n` questions, biased toward patterns you haven't mastered. */
function adaptivePick(masteryOf: (id: string) => Mastery, n: number): QuizQuestion[] {
  const pool = quiz.map((q) => ({ q, w: MASTERY_WEIGHT[masteryOf(q.answer)] }));
  const chosen: QuizQuestion[] = [];
  while (chosen.length < n && pool.length) {
    const total = pool.reduce((s, x) => s + x.w, 0);
    let r = Math.random() * total;
    let idx = 0;
    for (let i = 0; i < pool.length; i++) {
      r -= pool[i].w;
      if (r <= 0) {
        idx = i;
        break;
      }
    }
    chosen.push(pool[idx].q);
    pool.splice(idx, 1);
  }
  return chosen;
}

export default function Quiz() {
  const { recordToday } = useStreak();
  const srs = useSRS();
  // Freeze the adaptive selection at mount so grading mid-quiz doesn't reshuffle.
  const questions = useMemo(() => adaptivePick(srs.masteryOf, 10), []); // eslint-disable-line react-hooks/exhaustive-deps
  const [idx, setIdx] = useState(0);
  const [picked, setPicked] = useState<string | null>(null);
  const [score, setScore] = useState(0);
  const [answered, setAnswered] = useState(0);
  const [missed, setMissed] = useState<string[]>([]);
  const [finished, setFinished] = useState(false);

  const q = questions[idx];
  // reshuffle the four choices whenever we move to a new question (idx changes)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const options = useMemo(() => choicesFor(q.answer), [idx]);

  const pick = (id: string) => {
    if (picked) return;
    setPicked(id);
    setAnswered((a) => a + 1);
    if (id === q.answer) {
      setScore((s) => s + 1);
    } else {
      setMissed((m) => (m.includes(q.answer) ? m : [...m, q.answer]));
      // If you've already "learned" this pattern but misidentified it, it has
      // faded — schedule it for review so spaced repetition resurfaces it.
      if (srs.isLearned(q.answer)) srs.grade(q.answer, 0);
    }
    recordToday();
  };

  const advance = () => {
    if (idx + 1 >= questions.length) {
      setFinished(true);
      return;
    }
    setIdx((i) => i + 1);
    setPicked(null);
  };

  const restart = () => {
    // fresh question set + shuffled choices
    window.location.reload();
  };

  if (finished) {
    const pct = Math.round((score / questions.length) * 100);
    return (
      <div className="container narrow">
        <div className="card center quiz-result">
          <div className="quiz-score">{pct}%</div>
          <h2>You named {score} of {questions.length} patterns</h2>
          <p className="muted">
            {pct >= 80
              ? "Sharp pattern radar — this is exactly the instinct interviewers look for."
              : pct >= 50
                ? "Solid start. Revisit the patterns you missed and run the trainer again."
                : "Pattern recognition is a muscle — review the roadmap and come back."}
          </p>
          {missed.length > 0 && (
            <div className="quiz-missed">
              <span className="faint">Brush up on:</span>
              <div className="row" style={{ justifyContent: "center", marginTop: 8 }}>
                {missed.map((id) => {
                  const mp = patternById(id);
                  if (!mp) return null;
                  return (
                    <a key={id} className="related-chip" href={href(`/pattern/${id}`)}>
                      <span>{mp.icon}</span> {mp.name}
                    </a>
                  );
                })}
              </div>
            </div>
          )}
          <div className="row" style={{ justifyContent: "center", marginTop: 14 }}>
            <button className="btn primary" onClick={restart}>Try again</button>
            {srs.counts.due > 0 && <a className="btn" href={href("/review")}>Review {srs.counts.due} due →</a>}
            <a className="btn" href={href("/roadmap")}>Review the roadmap</a>
          </div>
        </div>
      </div>
    );
  }

  const correctPattern = patternById(q.answer);

  return (
    <div className="container narrow">
      <div className="spread" style={{ marginBottom: 8 }}>
        <span className="eyebrow">Pattern recognition trainer</span>
        <span className="muted mono" style={{ fontSize: "0.85rem" }}>
          {idx + 1} / {questions.length} · score {score}
        </span>
      </div>
      <h1 style={{ marginTop: 0 }}>Which pattern fits?</h1>
      <p className="muted" style={{ marginTop: "-6px", fontSize: "0.86rem" }}>
        Questions are weighted toward the patterns you haven't mastered yet.
      </p>

      <div className="quiz-progress">
        <div className="quiz-progress-bar" style={{ width: `${(answered / questions.length) * 100}%` }} />
      </div>

      <div className="card quiz-card">
        <p className="quiz-prompt">{q.prompt}</p>
        <div className="quiz-options">
          {options.map((opt) => {
            const op = patternById(opt)!;
            const isAnswer = opt === q.answer;
            const isPicked = opt === picked;
            const cls = [
              "quiz-option",
              picked && isAnswer ? "correct" : "",
              picked && isPicked && !isAnswer ? "wrong" : "",
              picked && !isPicked && !isAnswer ? "faded" : "",
            ]
              .filter(Boolean)
              .join(" ");
            return (
              <button key={opt} className={cls} onClick={() => pick(opt)} disabled={!!picked}>
                <span className="quiz-opt-icon">{op.icon}</span>
                <span>{op.name}</span>
                {picked && isAnswer && <span className="quiz-mark">✓</span>}
                {picked && isPicked && !isAnswer && <span className="quiz-mark">✗</span>}
              </button>
            );
          })}
        </div>

        {picked && (
          <div className={`quiz-explain ${picked === q.answer ? "good" : "bad"}`}>
            <strong>
              {picked === q.answer ? "Correct — " : "Not quite. "}
              {correctPattern?.name}.
            </strong>{" "}
            {q.why}
            <div style={{ marginTop: 10 }}>
              <a className="btn sm" href={href(`/pattern/${q.answer}`)}>Open this pattern →</a>
            </div>
          </div>
        )}
      </div>

      <div className="detail-nav">
        <span />
        <button className="btn primary" onClick={advance} disabled={!picked}>
          {idx + 1 >= questions.length ? "See results" : "Next question"} →
        </button>
      </div>
    </div>
  );
}
