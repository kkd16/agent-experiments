import { useMemo, useState } from "react";
import { quiz } from "../data/quiz";
import { patterns, patternById } from "../data/patterns";
import { href } from "../lib/router";

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

export default function Quiz() {
  const questions = useMemo(() => shuffle(quiz).slice(0, 10), []);
  const [idx, setIdx] = useState(0);
  const [picked, setPicked] = useState<string | null>(null);
  const [score, setScore] = useState(0);
  const [answered, setAnswered] = useState(0);
  const [finished, setFinished] = useState(false);

  const q = questions[idx];
  // reshuffle the four choices whenever we move to a new question (idx changes)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const options = useMemo(() => choicesFor(q.answer), [idx]);

  const pick = (id: string) => {
    if (picked) return;
    setPicked(id);
    setAnswered((a) => a + 1);
    if (id === q.answer) setScore((s) => s + 1);
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
          <div className="row" style={{ justifyContent: "center" }}>
            <button className="btn primary" onClick={restart}>Try again</button>
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
